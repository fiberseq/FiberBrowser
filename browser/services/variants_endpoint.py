"""SNPs and SNP combinations in a view: the Variants panel's endpoints.

``snps_payload`` scans the dataset's BAM over the view (services/snp_scan.py)
and calls SNPs; ``alleles_payload`` groups the view's reads by their alleles
at chosen SNPs (or by HP tag). Both read the BAM records directly (bases and
CIGAR, not the display cache) and share one cache entry per (dataset, view,
read filters, file identity): the pileup, and the per-read allele matrix for
the scan's candidates, so changing the MAF/depth thresholds or the SNPs of a
combination re-uses the reads already read.
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Iterator, Optional

import numpy as np

from services import snp_scan

MAX_SPAN = 300_000
from services.byte_cache import shared_cache
_CACHE = shared_cache('profiles')
_LOCK = threading.Lock()


class VariantsRequestError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class VariantsCancelled(RuntimeError):
    """The client went away mid-scan: nothing is cached."""


def _dataset(state, dataset_id: str):
    from services.query_params import resolve_dataset_id
    from services.lift.capability import require
    dataset_id = resolve_dataset_id(state, dataset_id)
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    require(dataset, "variants")
    if dataset is None:
        raise VariantsRequestError(f"Dataset '{dataset_id}' not found", 404)
    if getattr(dataset, "data_type", None) != "bam":
        raise VariantsRequestError("SNP discovery needs a BAM dataset (its bases)")
    return dataset


def _scoped_state(state, body):
    from copy import copy
    from services.panel_genomes import for_datasets
    # Resolve and classify before panel scoping, cache lookup or BAM-only validation.
    dataset = _dataset(state, body.get("dataset_id"))
    scoped = copy(for_datasets(state, [dataset.id]))
    ids = body.get("read_ids")
    if ids is not None and (not isinstance(ids, list) or not all(isinstance(x, str) for x in ids)):
        raise VariantsRequestError("read_ids must be a list of read names")
    scoped._variant_read_ids = frozenset(ids) if ids is not None else None
    return scoped


def _records(state, dataset, chrom: str, start: int, end: int) -> Iterator:
    from services.bam_handles import get_bam_handle
    from services.signal_evidence import record_keeps_signal, signal_header
    from services.plasmid_reconcile import contig_links
    from utils.chrom import resolve_reference_name

    for path in dataset.paths:
        bam = get_bam_handle(path)
        if bam is None:
            continue
        actual = resolve_reference_name(chrom, bam.references, getattr(state, "chrom_map", None) or {},
                                        links=contig_links(state, path=path))
        if actual is None:
            continue
        ids = getattr(state, "_variant_read_ids", None)
        provenance = signal_header(bam.header)
        from services.graph_lift import lift_hidden_predicate
        hidden = lift_hidden_predicate(bam.header)  # an unrepaired lift's ex-supplementaries, as the read track
        yield from (read for read in bam.fetch(actual, max(0, int(start)), int(end))
                    if (ids is None or read.query_name in ids) and record_keeps_signal(read, provenance)
                    and (hidden is None or not hidden(read)))


def _reference(state, chrom: str, start: int, end: int) -> Optional[np.ndarray]:
    fasta = getattr(state, "fasta", None)
    if fasta is None:
        return None
    try:
        refs = list(fasta.references)
    except Exception:
        return None
    alt = chrom[3:] if chrom.startswith("chr") else "chr" + chrom
    name = chrom if chrom in refs else alt if alt in refs else None
    if name is None:
        try:
            from utils.chrom import resolve_reference_name
            name = resolve_reference_name(chrom, refs, getattr(state, "chrom_map", None) or {})
        except Exception:
            name = None
    if name is None:
        return None
    try:
        seq = fasta.fetch(name, int(start), int(end))
    except Exception:
        return None
    if len(seq) != end - start:
        return None
    return snp_scan.encode(seq)


def _stamps(paths) -> Optional[tuple]:
    from services.sv_endpoint import _path_stamps
    return _path_stamps(paths)


def _chemistry(dataset) -> Optional[str]:
    from services.chemistry_metadata import dataset_consensus_chemistry
    chem = dataset_consensus_chemistry(dataset)
    if not chem:
        meta = getattr(dataset, "chemistry_metadata", None) or {}
        chem = meta.get("chemistry")
    return chem


def _int(value, default: int, lo: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _float(value, default: float, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    if v != v:
        v = default
    return max(lo, min(hi, v))


def scan_params(body: dict) -> dict:
    mode = str(body.get("mode") or "auto").lower()
    if mode not in ("auto", "daf", "basecall"):
        raise VariantsRequestError("mode must be auto, daf or basecall")
    return {
        "min_maf": _float(body.get("min_maf"), 0.1, 0.0, 0.5),
        "min_depth": _int(body.get("min_depth"), 20, 1, 1_000_000),
        "both_strands": bool(body.get("both_strands", True)),
        "min_bq": _int(body.get("min_bq"), 20, 0, 93),
        "min_mapq": _int(body.get("min_mapq"), 0, 0, 255),
        "max_indel": _int(body.get("max_indel"), 30, 1, 1000),
        "mode": mode,
        "include_duplicates": bool(body.get("include_duplicates", False)),
    }


def _region(body: dict) -> tuple[str, int, int]:
    chrom = str(body.get("chrom") or "")
    if not chrom:
        raise VariantsRequestError("missing chrom")
    try:
        start, end = int(body.get("start")), int(body.get("end"))
    except (TypeError, ValueError):
        raise VariantsRequestError("start and end must be integers") from None
    start = max(0, start)
    if end <= start:
        raise VariantsRequestError("end must be after start")
    if end - start > MAX_SPAN:
        raise VariantsRequestError(f"Zoom in to {MAX_SPAN // 1000} kb or less to find SNPs "
                                   f"(the view is {(end - start) / 1000:.0f} kb)", 413)
    return chrom, start, end


def _entry(state, dataset_id: str, chrom: str, start: int, end: int, params: dict,
           cancelled: Optional[Callable[[], bool]]) -> dict:
    """The cached pileup of a view (read once per view and read filters)."""
    dataset = _dataset(state, dataset_id)
    stamps = _stamps(dataset.paths)
    fasta_name = getattr(getattr(state, "fasta", None), "filename", None)
    if isinstance(fasta_name, bytes):
        fasta_name = fasta_name.decode("utf-8", "replace")
    # The reference's identity: its path and, for a local file, its size and mtime (a reload of new content).
    fasta_id = (str(fasta_name), _stamps([fasta_name]) if fasta_name else None)
    from services.signal_evidence import signal_filter_key
    key = (dataset_id, chrom, start, end, params["min_bq"], params["min_mapq"], params["max_indel"],
           params["include_duplicates"], stamps, str(fasta_id), getattr(state, "_variant_read_ids", None), signal_filter_key(state))
    with _LOCK:
        hit = _CACHE.get(key) if stamps is not None else None
        if hit is not None:
            _CACHE.move_to_end(key)
            hit["hits"] = hit.get("hits", 0) + 1
            return hit
    t0 = time.perf_counter()
    ref = _reference(state, chrom, start, end)
    pile = snp_scan.pileup(_records(state, dataset, chrom, start, end), chrom, start, end, ref=ref,
                           min_bq=params["min_bq"], min_mapq=params["min_mapq"], max_indel=params["max_indel"],
                           include_duplicates=params["include_duplicates"], cancelled=cancelled)
    if pile.cancelled:
        raise VariantsCancelled()
    entry = {"key": key, "pile": pile, "dataset": dataset, "chemistry": _chemistry(dataset),
             "elapsed": time.perf_counter() - t0, "hits": 0, "matrix": None, "matrix_ids": None, "lock": threading.Lock()}
    if stamps is not None:
        with _LOCK:
            _CACHE[key] = entry
            _CACHE.move_to_end(key)
    return entry


def _called(entry: dict, params: dict) -> dict:
    pile = entry["pile"]
    mode = params["mode"]
    if mode == "auto":
        mode = snp_scan.detect_mode(pile, entry["chemistry"])
    return snp_scan.call_snps(pile, min_maf=params["min_maf"], min_depth=params["min_depth"],
                              both_strands=params["both_strands"], mode=mode)


def scan_key(dataset_id: str, chrom: str, start: int, end: int, params: dict, identity=None) -> str:
    """The scan's identity for the client: view, settings and (a digest of) the files' and reference's identity."""
    import hashlib
    digest = hashlib.sha1(repr(identity).encode()).hexdigest()[:10]
    return "|".join(str(x) for x in (dataset_id, chrom, start, end, params["min_maf"], params["min_depth"],
                                     params["both_strands"], params["min_bq"], params["min_mapq"],
                                     params["max_indel"], params["mode"], params["include_duplicates"], digest))


def snps_payload(state, body: dict, cancelled: Optional[Callable[[], bool]] = None) -> dict:
    state = _scoped_state(state, body)
    dataset_id = _dataset(state, body.get("dataset_id")).id
    chrom, start, end = _region(body)
    params = scan_params(body)
    t0 = time.perf_counter()
    entry = _entry(state, dataset_id, chrom, start, end, params, cancelled)
    called = _called(entry, params)
    pile = entry["pile"]
    hp = {k: v for k, v in pile.hp.items() if k != "untagged"}
    return {
        "scan_key": scan_key(dataset_id, chrom, start, end, params, entry["key"]),
        "dataset_id": dataset_id, "region": {"chrom": chrom, "start": start, "end": end},
        "params": params, "mode": called["mode"], "chemistry": entry["chemistry"],
        "reference": "fasta" if pile.ref is not None else "none",
        "n_reads": pile.n_reads, "median_depth": called["median_depth"], "fixed": called["fixed"],
        "snps": called["snps"],
        "directions": {"CT": pile.directions.get(snp_scan.DIR_CT, 0), "GA": pile.directions.get(snp_scan.DIR_GA, 0),
                       "none": pile.directions.get(snp_scan.DIR_NONE, 0)},
        "hp": {"tagged": sum(hp.values()), "values": hp, "untagged": pile.hp.get("untagged", 0)},
        "daf_policy": snp_scan.DAF_POLICY,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
        "cached": entry["hits"] > 0,
    }


def _matrix(state, entry: dict, candidates: list[dict], params: dict,
            cancelled: Optional[Callable[[], bool]]) -> snp_scan.AlleleMatrix:
    """Per-read alleles for ``candidates`` (the cached matrix when it has them all)."""
    ids = [c["id"] for c in candidates]
    with entry["lock"]:
        have = entry.get("matrix_ids")
        if have is not None and set(ids) <= set(have):
            return entry["matrix"]
        # Keep the columns already read (a later request may want them again).
        if have is not None:
            known = set(ids)
            candidates = list(candidates) + [c for c in entry["matrix_cands"] if c["id"] not in known]
            ids = [c["id"] for c in candidates]
    pile = entry["pile"]
    if pile.reads is not None:
        # The reads' differences from the reference, kept by the scan: no second pass over the BAM.
        matrix = snp_scan.alleles_from_pileup(pile, candidates)
    else:
        matrix = snp_scan.read_alleles(_records(state, entry["dataset"], pile.chrom, pile.start, pile.end),
                                       pile.chrom, pile.start, pile.end, candidates,
                                       min_bq=params["min_bq"], min_mapq=params["min_mapq"],
                                       include_duplicates=params["include_duplicates"], cancelled=cancelled)
        if matrix.cancelled:
            raise VariantsCancelled()
    with entry["lock"]:
        entry["matrix"], entry["matrix_ids"], entry["matrix_cands"] = matrix, ids, list(candidates)
    with _LOCK:
        if _CACHE.get(entry['key']) is entry:
            _CACHE[entry['key']] = entry  # Re-account the additional matrix allocation.
    return matrix


def _columns(entry: dict, matrix: snp_scan.AlleleMatrix, candidates: list[dict]) -> list[dict]:
    """The candidate behind each matrix column: this request's call where there is one (its flags), else the one the
    column was read for."""
    by_id = {c["id"]: c for c in candidates}
    read_for = {c["id"]: c for c in entry.get("matrix_cands") or []}
    return [by_id.get(sid) or read_for.get(sid) or {"id": sid, "kind": k, "alleles": ["?", "?"], "pos": p, "depth": 0,
                                                    "passes": False}
            for sid, k, p in zip(matrix.ids, matrix.kinds, matrix.positions)]


def alleles_payload(state, body: dict, cancelled: Optional[Callable[[], bool]] = None) -> dict:
    """Group the view's reads by allele (one SNP), by allele combination (several), or by HP tag."""
    if body.get("source") == "lift_hap":
        from services.query_params import resolve_dataset_id
        from services.lift.capability import is_lifted
        did = resolve_dataset_id(state, body.get("dataset_id"))
        ds = state.get_dataset(did)
        if not is_lifted(ds):
            raise VariantsRequestError("Haplotype grouping requires a live-lift dataset")
        chrom, start, end = _region(body)
        labels = list(ds.live_lift.labels().values())
        return dict(dataset_id=did, region=dict(chrom=chrom, start=start, end=end), source="lift_hap",
                    mode="lift_hap", assignments={}, n_reads=0, covering=0, threshold=0, distinct=len(labels),
                    groups=[dict(id=i, key=label, label=label, alleles=[label], count=0, kind="combo") for i, label in enumerate(labels)],
                    phase=None, tags=None, snps=[], scan_key=ds.live_lift.key())
    state = _scoped_state(state, body)
    dataset_id = _dataset(state, body.get("dataset_id")).id
    chrom, start, end = _region(body)
    params = scan_params(body)
    svs = body.get("svs")
    if svs and not (isinstance(body.get("snps"), list) and body.get("snps")):
        # SVs only: no SNP scan of the view (a deep capture's pileup takes long), just the SV calls.
        return _genotype_payload(state, body, None, None, None, None, {}, [], svs, dataset_id, chrom, start, end,
                                 params, cancelled)
    entry = _entry(state, dataset_id, chrom, start, end, params, cancelled)
    called = _called(entry, params)
    candidates = called["snps"]
    source = str(body.get("source") or "snps")
    matrix = _matrix(state, entry, candidates, params, cancelled)
    # The matrix may carry more columns (an earlier, looser scan): index by id.
    col_of = {sid: j for j, sid in enumerate(matrix.ids)}
    by_id = {c["id"]: c for c in candidates}
    mcands = _columns(entry, matrix, candidates)
    if source == "hp":
        result = snp_scan.hp_groups(matrix)
        result["tags"] = None
        return _finish(result, dataset_id, chrom, start, end, params, called, entry)
    wanted = body.get("snps")
    tags_info = None
    if svs:
        return _genotype_payload(state, body, entry, called, matrix, mcands, col_of, candidates, svs,
                                 dataset_id, chrom, start, end, params, cancelled)
    if wanted == "informative" or wanted is None:
        cols = snp_scan.informative_columns(
            [mcands[col_of[c["id"]]] for c in candidates if c["id"] in col_of], called["median_depth"],
            min_depth_fraction=_float(body.get("min_depth_fraction"), 0.5, 0.0, 1.0),
            include_indels=bool(body.get("include_indels", False)))
        base = [col_of[c["id"]] for c in candidates if c["id"] in col_of]
        cols = [base[k] for k in cols]
        if bool(body.get("collapse_linked", True)) and len(cols) > 1:
            tags, members = snp_scan.ld_tags(matrix, mcands, cols,
                                             r2_min=_float(body.get("r2_min"), 0.8, 0.1, 1.0))
            # Blocks of linked SNPs carry the haplotypes; a lone SNP (private, or noise) would only split them
            # further. Lone SNPs count when fewer than two blocks have several.
            multi = [t for t in tags if len(members[t]) >= 2]
            if len(multi) >= 2 and not body.get("all_tags"):
                tags = multi
            tags_info = [{"tag": mcands[t]["id"], "members": [mcands[m]["id"] for m in members[t]]} for t in tags]
            cols = tags
    else:
        if not isinstance(wanted, list) or not wanted:
            raise VariantsRequestError("snps must be a list of SNP ids or 'informative'")
        missing = [s for s in wanted if s not in col_of]
        if missing:
            # SNPs this scan's thresholds did not call (another dataset's, a session's, a looser scan's): read the
            # alleles there anyway.
            extra = [_parse_snp_id(s, start, end) for s in missing]
            matrix = _matrix(state, entry, candidates + extra, params, cancelled)
            col_of = {sid: j for j, sid in enumerate(matrix.ids)}
            mcands = _columns(entry, matrix, candidates)
        cols = sorted((col_of[s] for s in wanted), key=lambda j: (mcands[j]["pos"], mcands[j]["kind"]))
    max_snps = _int(body.get("max_snps"), 64, 1, 512)
    if len(cols) > max_snps:
        raise VariantsRequestError(f"{len(cols)} SNPs: choose {max_snps} or fewer for a combination", 413)
    if not cols:
        result = {"groups": [], "assignments": {}, "n_reads": len(matrix.names), "covering": 0, "snps": [],
                  "phase": None, "partial_assigned": 0, "threshold": 0, "distinct": 0}
    elif len(cols) == 1 and not body.get("as_combination"):
        result = snp_scan.single_snp_groups(matrix, mcands, cols[0])
    else:
        result = snp_scan.combinations(
            matrix, mcands, cols, partial=bool(body.get("partial", False)),
            min_fraction=_float(body.get("min_fraction"), 0.02, 0.0, 0.5),
            min_reads=_int(body.get("min_reads"), 3, 1, 1_000_000),
            auto_phase=bool(body.get("auto_phase", True)))
    result["tags"] = tags_info
    return _finish(result, dataset_id, chrom, start, end, params, called, entry)


MAX_GENOTYPE_SVS = 4


def _parse_svs(svs) -> list[dict]:
    if not isinstance(svs, list) or not svs:
        raise VariantsRequestError("svs must be a list of {t, ref, len}")
    if len(svs) > MAX_GENOTYPE_SVS:
        raise VariantsRequestError(f"{len(svs)} SVs: combine {MAX_GENOTYPE_SVS} or fewer", 413)
    out = []
    for sv in svs:
        if not isinstance(sv, dict) or sv.get("t") not in ("D", "I"):
            raise VariantsRequestError("each SV needs t (D or I), ref and len")
        try:
            ref, length = int(sv.get("ref")), int(sv.get("len"))
        except (TypeError, ValueError):
            raise VariantsRequestError("each SV needs integer ref and len") from None
        if length <= 0:
            raise VariantsRequestError("an SV's len must be positive")
        name = str(sv.get("name") or "").strip() or f"{'INS' if sv['t'] == 'I' else 'DEL'} {length:,} bp"
        out.append({"t": sv["t"], "ref": ref, "len": length, "name": name[:40], "id": f"{sv['t']}:{ref}:{length}"})
    return out


def _genotype_payload(state, body, entry, called, matrix, mcands, col_of, candidates, svs, dataset_id, chrom, start,
                      end, params, cancelled) -> dict:
    """Reads grouped by their genotype at 1-4 SVs (carrier / reference / not informative, as the single-SV split
    classifies them, clipped carriers included), with the selected SNPs' alleles if any: ``roo+ · hobo− · jockey+``."""
    from services.sv_endpoint import SvRequestError, sv_split_payload

    parsed = _parse_svs(svs)
    if str(body.get("source") or "snps") == "hp":
        raise VariantsRequestError("HP tags can't be combined with SVs")
    wanted = body.get("snps")
    wanted = wanted if isinstance(wanted, list) else []
    if entry is None:
        _dataset(state, dataset_id)
        cols, snp_letters, row_of, matrix_names = [], [], {}, []
    else:
        missing = [s for s in wanted if s not in col_of]
        if missing:
            extra = [_parse_snp_id(s, start, end) for s in missing]
            matrix = _matrix(state, entry, candidates + extra, params, cancelled)
            col_of = {sid: j for j, sid in enumerate(matrix.ids)}
            mcands = _columns(entry, matrix, candidates)
        cols = sorted((col_of[s] for s in wanted), key=lambda j: (mcands[j]["pos"], mcands[j]["kind"]))
        snp_letters = snp_scan.allele_letters(matrix, mcands, cols) if cols else [[] for _ in matrix.names]
        row_of = {name: r for r, name in enumerate(matrix.names)}
        matrix_names = list(matrix.names)
    calls, evidence_calls = [], []
    for sv in parsed:
        if cancelled is not None and cancelled():
            raise VariantsCancelled()
        try:
            res = sv_split_payload(state, dataset_id=dataset_id, chrom=chrom, start=start, end=end, t=sv["t"],
                                   ref=sv["ref"], length=sv["len"], include_duplicates=params["include_duplicates"],
                                   include_putative=bool(body.get("include_putative", True)),
                                   include_ambiguous=bool(body.get("include_ambiguous", False)),
                                  include_conflicting=bool(body.get("include_conflicting", False)), conflict_options=body.get("conflict_options"))
        except SvRequestError as exc:
            raise VariantsRequestError(str(exc)) from None
        calls.append(res["assignments"])
        evidence_calls.append(res.get("evidence_levels", {}))
    names = list(dict.fromkeys([*matrix_names, *(n for c in calls for n in c)]))
    letters = []
    for name in names:
        r = row_of.get(name)
        row = list(snp_letters[r]) if r is not None else [None] * len(cols)
        for c in calls:
            a = c.get(name, 2)
            row.append("+" if a == 0 else "-" if a == 1 else None)
        letters.append(row)
    columns = [{"id": mcands[j]["id"], "name": f"{int(mcands[j]['pos']) + 1:,}", "kind": "snv"} for j in cols]
    columns += [{"id": sv["id"], "name": sv["name"], "kind": "sv"} for sv in parsed]
    result = snp_scan.genotype_groups(names, letters, columns, partial=bool(body.get("partial", False)),
                                      min_fraction=_float(body.get("min_fraction"), 0.02, 0.0, 0.5),
                                      min_reads=_int(body.get("min_reads"), 3, 1, 1_000_000))
    rank = {'confirmed': 0, 'putative': 1, 'conflicting': 2, 'ambiguous': 3}
    evidence_levels = {}
    for name in names:
        levels = [tiers.get(name) for assignments, tiers in zip(calls, evidence_calls)
                  if assignments.get(name) == 0 and tiers.get(name) in rank]
        if levels:
            evidence_levels[name] = max(levels, key=rank.get)
    result['sv_evidence_levels'] = evidence_levels
    result['include_putative'] = bool(body.get('include_putative', True))
    result['include_conflicting'] = bool(body.get('include_conflicting', False))
    result['include_ambiguous'] = bool(body.get('include_ambiguous', False))
    for group in result['groups']:
        levels = [level for name, level in evidence_levels.items() if result['assignments'].get(name) == group['id']]
        counts = {level: levels.count(level) for level in rank}
        group['evidence_counts'] = counts
        if group['kind'] == 'combo' and (counts['putative'] or counts['conflicting'] or counts['ambiguous']):
            group['label'] += f" ({counts['confirmed']} confirmed, {counts['putative']} putative, {counts['conflicting']} conflicting, {counts['ambiguous']} ambiguous carriers)"
    result["tags"] = None
    if entry is None:
        result.update({"dataset_id": dataset_id, "region": {"chrom": chrom, "start": start, "end": end},
                       "scan_key": scan_key(dataset_id, chrom, start, end, params), "mode": "sv"})
        return result
    return _finish(result, dataset_id, chrom, start, end, params, called, entry)


def _parse_snp_id(sid: str, start: int, end: int) -> dict:
    """A SNP id ("<pos0>:<kind>:<a1>/<a2>") as a candidate."""
    try:
        pos_s, kind, pair = str(sid).split(":", 2)
        pos = int(pos_s)
        a1, a2 = pair.split("/", 1)
    except ValueError:
        raise VariantsRequestError(f"not a SNP id: {sid!r}") from None
    if kind not in ("snv", "ins", "del") or not (start <= pos < end):
        raise VariantsRequestError(f"SNP {sid!r} is not in this view", 409)
    if kind == "snv" and not (a1 in "ACGT" and a2 in "ACGT" and len(a1) == len(a2) == 1):
        raise VariantsRequestError(f"not a SNP id: {sid!r}")
    length = 0
    if kind != "snv":
        label = a1 if a1 != "ref" else a2
        try:
            length = abs(int(label))
        except ValueError:
            raise VariantsRequestError(f"not a SNP id: {sid!r}") from None
    return {"id": sid, "pos": pos, "kind": kind, "alleles": [a1, a2], "ref": None, "depth": 0, "length": length,
            "passes": True, "alt": a2}


def _finish(result: dict, dataset_id, chrom, start, end, params, called, entry) -> dict:
    result.update({
        "dataset_id": dataset_id, "region": {"chrom": chrom, "start": start, "end": end},
        "scan_key": scan_key(dataset_id, chrom, start, end, params, entry["key"]), "mode": called["mode"],
    })
    return result


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------------------
# SVs in view, and how an SV's carriers line up with the SNP alleles

def _sv_compact(state, dataset_id, chrom, start, end, floor, include_duplicates, cancelled=None):
    from services import sv_endpoint
    from services.sv_evidence import select_cohort
    # The provider checks the server cancel scope during collection and spool
    # replay as well as on warm hits. Explicit callers keep their old callback.
    if cancelled is not None and cancelled():
        raise VariantsCancelled()
    from services.sv_evidence import ScanCancelled
    try:
        compact = sv_endpoint.scan_view(state, dataset_id, chrom, start, end, floor, cancelled=cancelled)
    except ScanCancelled:
        raise VariantsCancelled() from None
    if cancelled is not None and cancelled():
        raise VariantsCancelled()
    return select_cohort(compact, include_duplicates=include_duplicates)


def svs_payload(state, body: dict, cancelled: Optional[Callable[[], bool]] = None) -> dict:
    """SV clusters (deletions and insertions of at least ``min_len``) in the view, as the SV band clusters them."""
    from services.sv_events import normalize_min_sv_len, sv_summary_for_reads, sv_extraction_floor

    state = _scoped_state(state, body)
    dataset_id = _dataset(state, body.get("dataset_id")).id
    chrom, start, end = _region(body)
    min_len = normalize_min_sv_len(body.get("min_len"))
    include_duplicates = bool(body.get("include_duplicates", False))
    compact = _sv_compact(state, dataset_id, chrom, start, end, sv_extraction_floor(min_len),
                          include_duplicates, cancelled)
    summary = sv_summary_for_reads(compact, start, end, min_len, chrom=chrom, conflict_options=body.get("conflict_options")) or {"clusters": []}
    clusters = [c for c in summary["clusters"] if c["len"] >= min_len]
    clusters.sort(key=lambda c: (c["ref"], c["t"]))
    return {"dataset_id": dataset_id, "region": {"chrom": chrom, "start": start, "end": end}, "min_len": min_len,
            "n_reads": len({r["id"] for r in compact}), "clusters": clusters}


def sv_linkage_payload(state, body: dict, cancelled: Optional[Callable[[], bool]] = None) -> dict:
    """An SV's carriers vs its reference reads at each informative SNP: the minor allele's fraction in each, and
    how many SNPs separate them (>= 0.9 in one, <= 0.1 in the other)."""
    from services.sv_endpoint import classify_compact, allele_floor

    state = _scoped_state(state, body)
    dataset_id = _dataset(state, body.get("dataset_id")).id
    chrom, start, end = _region(body)
    params = scan_params(body)
    t = str(body.get("t") or "")
    if t not in ("D", "I"):
        raise VariantsRequestError("t must be D or I")
    try:
        ref, length = int(body.get("ref")), int(body.get("len"))
    except (TypeError, ValueError):
        raise VariantsRequestError("ref and len must be integers") from None
    entry = _entry(state, dataset_id, chrom, start, end, params, cancelled)
    called = _called(entry, params)
    candidates = called["snps"]
    matrix = _matrix(state, entry, candidates, params, cancelled)
    col_of = {sid: j for j, sid in enumerate(matrix.ids)}
    mcands = _columns(entry, matrix, candidates)
    compact = _sv_compact(state, dataset_id, chrom, start, end, allele_floor(length), params["include_duplicates"], cancelled)
    classified = classify_compact(((c, c) for c in compact), t=t, ref=ref, length=length,
                                  include_duplicates=params["include_duplicates"],
                                  include_putative=bool(body.get("include_putative", True)),
                                  include_ambiguous=bool(body.get("include_ambiguous", False)),
                                  include_conflicting=bool(body.get("include_conflicting", False)), conflict_options=body.get("conflict_options"))
    allele = {name: v["allele"] for name, v in classified.items()}
    counts = {"carriers": sum(1 for a in allele.values() if a == 0),
              "reference": sum(1 for a in allele.values() if a == 1),
              "not_informative": sum(1 for a in allele.values() if a == 2)}
    cols = [col_of[c["id"]] for c in candidates if c["id"] in col_of and c["kind"] == "snv" and c.get("passes", True)]
    letters = snp_scan.allele_letters(matrix, mcands, cols)
    group = np.array([allele.get(name, 2) for name in matrix.names], dtype=np.int8)
    rows = []
    min_reads = _int(body.get("min_reads"), 10, 1, 1_000_000)
    for k, j in enumerate(cols):
        minor = mcands[j]["alleles"][1]
        tab = {0: [0, 0], 1: [0, 0]}
        for r, g in enumerate(group.tolist()):
            if g not in (0, 1):
                continue
            a = letters[r][k]
            if a is None or a == "x":
                continue
            tab[g][0] += 1
            tab[g][1] += a == minor
        if min(tab[0][0], tab[1][0]) < min_reads:
            continue
        f0, f1 = tab[0][1] / tab[0][0], tab[1][1] / tab[1][0]
        rows.append({"id": mcands[j]["id"], "pos": mcands[j]["pos"], "alleles": mcands[j]["alleles"],
                     "carriers": {"n": tab[0][0], "minor": tab[0][1], "fraction": round(f0, 4)},
                     "reference": {"n": tab[1][0], "minor": tab[1][1], "fraction": round(f1, 4)},
                     "diff": round(abs(f0 - f1), 4),
                     "linked": (f0 >= 0.9 and f1 <= 0.1) or (f0 <= 0.1 and f1 >= 0.9)})
    rows.sort(key=lambda r: (-r["diff"], r["pos"]))
    return {"dataset_id": dataset_id, "region": {"chrom": chrom, "start": start, "end": end},
            "sv": {"t": t, "ref": ref, "len": length}, "counts": counts,
            "carrier_evidence_counts": {level: sum(v['allele'] == 0 and (v['evidence'] or {}).get('level') == level
                                                    for v in classified.values())
                                        for level in ('confirmed', 'putative', 'conflicting', 'ambiguous')},
            "tested": len(rows),
            "linked": sum(1 for r in rows if r["linked"]), "snps": rows[:200],
            "scan_key": scan_key(dataset_id, chrom, start, end, params, entry["key"])}
