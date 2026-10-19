"""Alt-allele panels: an insertion's carriers on a contig that holds the insert.

A panel that shows only an insertion's carriers can live on the alternate
allele itself, a synthetic contig (``services/alt_allele_align.py``)::

    reference [ref - FL, ref)  +  insert consensus  +  reference [ref, ref + FR)

Every carrier is re-expressed on it as an ordinary aligned record (its
sequence and tags untouched; CIGAR, position, MD and NM new), written to a
BAM next to the contig's FASTA, and that BAM is registered as a dataset with
the FASTA as its own reference (``services/panel_genomes``). The read track,
Cluster / Sort / Filter, Find classes, the analysis panels, metaprofiles and exports
then run on it as on any dataset, with the insert's bases as real positions.

Which reads are carriers is the insertion lens's rule (``insertion_lens.
classify_site``, i.e. ``sv_endpoint.classify_records``): CIGAR insertions
(the whole insert), soft clips at the breakpoint (the part of the insert they
hold) and hard clips (their flank only). The consensus is the lens's: a
majority vote of the CIGAR carriers' inserts, or FiberHMM's DAF-aware
consensus for a DAF dataset.

Built files live in a cache directory keyed by the definition (the source
files and their stamps, the insertion, the options), so reopening one, or
restoring a session, reuses them; a session stores the definition and
rebuilds what is missing.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from typing import Any, Optional
from services.reconstruction_budget import budgeted_request, request_provenance

from services.alt_allele_align import (
    KIND_CIGAR,
    KIND_CLIP_END,
    KIND_CLIP_START,
    KIND_HARD,
    KIND_REFERENCE,
    AltLayout,
    alt_contig_name,
    md_nm,
    realign,
)

SCHEMA = "fiberbrowser.alt_allele/3"
ALT_DIR_ENV = "FIBERBROWSER_ALT_ALLELE_DIR"
DEFAULT_FLANK = 20_000
MAX_FLANK = 100_000
DEFAULT_MAX_CARRIERS = 5_000
MAX_CARRIERS = 20_000
DEFAULT_MAX_REFERENCE = 2_000
_DROP_TAGS = ("MD", "NM", "SA", "MC", "MQ", "XA", "OA", "ms", "AS", "XS", "tp", "cm", "s1", "s2", "de", "rl")
_KEEP_FLAGS = 0x10 | 0x200 | 0x400  # reverse, QC fail, duplicate
_BUILD_LOCKS: dict[str, threading.Lock] = {}
_BUILD_LOCKS_GUARD = threading.Lock()


class AltAlleleError(ValueError):
    """The alt allele can't be built (no insertion there, no carrier holding the whole insert...)."""


def alt_allele_dir() -> str:
    """Where built alt alleles are kept: a folder of the upload store by default, so a lab
    server can read it (its readable roots include the uploads) and the Library leaves
    them out; the upload retention only deletes the store's top-level files."""
    configured = os.environ.get(ALT_DIR_ENV)
    if configured:
        path = configured
    else:
        from services.upload_store import upload_dir
        path = os.path.join(upload_dir(), "alt_allele")
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(path, exist_ok=True)
    return path


def is_alt_allele_path(path: Any) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(str(path)), alt_allele_dir()]) == alt_allele_dir()
    except (ValueError, TypeError):
        return False


# ---------------------------------------------------------------------------
# The definition


def normalize_definition(raw: dict) -> dict:
    """The part of a request that decides what is built (and what a session stores)."""
    flank = max(500, min(int(raw.get("flank") or DEFAULT_FLANK), MAX_FLANK))
    out = {
        "chrom": str(raw["chrom"]),
        "ref": int(raw["ref"]) if raw.get("ref") is not None else None,
        "length": int(raw["length"]) if raw.get("length") is not None else None,
        "pos": int(raw["pos"]) if raw.get("pos") is not None else None,
        "flank": flank,
        "include_reference": bool(raw.get("include_reference")),
        "max_carriers": max(1, min(int(raw.get("max_carriers") or DEFAULT_MAX_CARRIERS), MAX_CARRIERS)),
        "include_duplicates": bool(raw.get("include_duplicates")),
    }
    if out["ref"] is None or out["length"] is None:
        if out["pos"] is None:
            raise AltAlleleError("Say which insertion: its breakpoint and length, or a position near it")
    return out


def _stamps(paths: list[str]) -> list:
    out = []
    for path in paths:
        try:
            st = os.stat(path)
            out.append([path, st.st_mtime_ns, st.st_size])
        except OSError:
            out.append([path, None, None])
    return out


def _cache_key(paths: list[str], definition: dict, daf: bool, reference_id: str, fasta_path: Optional[str] = None,
               contig_links=None) -> str:
    """The built files' identity: the source files (stamps), the definition, the chemistry,
    the reference the flanks come from (its key and its FASTA file's stamp: a FASTA replaced
    at the same path is another reference) and the plasmid links that choose the contig."""
    reference = [reference_id, *(_stamps([fasta_path])[0] if fasta_path and "://" not in str(fasta_path) else [fasta_path])]
    blob = json.dumps({"schema": SCHEMA, "budget_version": "reconstruction:v1", "alignment_policy": "native-banded-wavefront:v1", "files": _stamps(paths), "def": definition, "daf": daf,
                       "reference": reference, "links": repr(sorted((contig_links or {}).items()))}, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:20]


# ---------------------------------------------------------------------------
# Building


def _plan_kind(plan: dict) -> str:
    if plan["kind"] == "cigar":
        return KIND_CIGAR
    if plan["kind"] == "clip":
        return KIND_CLIP_START if plan["partial"] == "start" else KIND_CLIP_END
    return KIND_HARD


def _evenly(items: list, limit: int) -> list:
    if len(items) <= limit:
        return list(items)
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _alt_header(bam, layout: AltLayout, extra_headers: list) -> dict:
    """The source header with the alt contig as its only reference and a FiberBrowser @PG."""
    data = bam.header.to_dict()
    out: dict[str, Any] = {}
    hd = dict(data.get("HD") or {"VN": "1.6"})
    hd["SO"] = "coordinate"
    out["HD"] = hd
    out["SQ"] = [{"SN": layout.name, "LN": layout.length}]
    groups: dict[str, dict] = {}
    for header in [data, *extra_headers]:
        for rg in header.get("RG") or []:
            groups.setdefault(rg.get("ID"), rg)
    if groups:
        out["RG"] = list(groups.values())
    pgs = list(data.get("PG") or [])
    ids = {pg.get("ID") for pg in pgs}
    pg_id, n = "fiberbrowser-alt-allele", 1
    while pg_id in ids:
        n += 1
        pg_id = f"fiberbrowser-alt-allele.{n}"
    entry = {"ID": pg_id, "PN": "FiberBrowser",
             "DS": f"carriers of the {layout.insert_len} bp insertion at {layout.chrom}:{layout.ref} re-aligned "
                   f"onto its alternate allele {layout.name}"}
    if pgs:
        entry["PP"] = pgs[-1].get("ID")
    try:
        from version import __version__ as fb_version
        entry["VN"] = str(fb_version)
    except Exception:
        pass
    out["PG"] = pgs + [entry]
    if data.get("CO"):
        out["CO"] = list(data["CO"])
    return out


def _reference_bases(fasta, chrom: str, start: int, end: int, chrom_map=None) -> str:
    if fasta is None or end <= start:
        return "N" * max(0, end - start)
    from utils.chrom import resolve_reference_name
    name = resolve_reference_name(chrom, getattr(fasta, "references", None) or (), chrom_map or {})
    if name is None:
        return "N" * (end - start)
    seq = fasta.fetch(name, int(start), int(end)) or ""
    return seq.upper().ljust(end - start, "N")


def _reference_length(fasta, bam, chrom: str, chrom_map=None) -> Optional[int]:
    from utils.chrom import resolve_reference_name
    if fasta is not None:
        name = resolve_reference_name(chrom, getattr(fasta, "references", None) or (), chrom_map or {})
        if name is not None:
            return int(fasta.get_reference_length(name))
    name = resolve_reference_name(chrom, bam.references, chrom_map or {})
    return int(bam.get_reference_length(name)) if name is not None else None


@budgeted_request
def build_alt_allele(bam_paths: list[str], definition: dict, out_dir: str, *, fasta=None, daf: bool = False,
                     chrom_map=None, contig_links=None, bam_handle_getter=None, label: str = "",
                     source_genome: Optional[str] = None) -> dict:
    """Write ``alt.fa`` (+ .fai), ``carriers.bam`` (+ .bai) and ``meta.json`` into ``out_dir``;
    return the meta."""
    import pysam

    from services.insertion_consensus import build_consensus, daf_aware_consensus
    from services.insertion_lens import classify_site

    started = time.perf_counter()
    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter
    d = definition
    site = classify_site(bam_paths, d["chrom"], pos=d["pos"] if d["pos"] is not None else d["ref"],
                         ref=d["ref"], length=d["length"], include_duplicates=d["include_duplicates"],
                         bam_handle_getter=bam_handle_getter, chrom_map=chrom_map, contig_links=contig_links, reference=fasta)
    if not site["success"]:
        raise AltAlleleError(site.get("error") or "No insertion there")
    ref, length = site["ref"], site["length"]
    carriers = sorted((item for item in site["carriers"] if item[0].get('evidence_level') == 'confirmed'),
                      key=lambda item: (item[1].query_name, item[2], item[1].reference_start))
    if not carriers:
        raise AltAlleleError(f"No carrier of the insertion at {d['chrom']}:{ref:,}")
    full = [(plan, read) for plan, read, _p, _b in carriers if plan["kind"] == "cigar" and plan["len"] > 0]
    if not full:
        raise AltAlleleError("No carrier holds the whole insert in its alignment (they are all clipped), "
                             "so there is no insert sequence to build the alternate allele from")

    # The consensus: FiberHMM's DAF-aware one for DAF data, else a majority vote.
    method, fallback, daf_info = "majority", None, None
    canonical_changed = any(plan.get('canonical_alt_seq', read.query_sequence[plan['q']:plan['q'] + plan['len']])
                            != read.query_sequence[plan['q']:plan['q'] + plan['len']] for plan, read in full)
    pure_rotations = all(plan['ref_end'] == plan['ref'] and
                         len(plan.get('canonical_alt_seq', read.query_sequence[plan['q']:plan['q'] + plan['len']])) == plan['len']
                         for plan, read in full)
    if daf and (not canonical_changed or pure_rotations):
        daf_info, fallback = daf_aware_consensus([(read, plan["q"], plan["len"], plan.get("canonical_alt_seq")) for plan, read in full])
        if daf_info is not None:
            method = "daf"
    if daf_info is not None:
        consensus = daf_info["seq"]
    else:
        consensus = build_consensus([plan.get('canonical_alt_seq', read.query_sequence[plan['q']:plan['q'] + plan['len']])
                                     for plan, read in full])
        if daf and canonical_changed:
            fallback = 'Canonical allele normalization changes the source query span; using canonical sequence majority'
    consensus = consensus.upper()

    first_bam = bam_handle_getter(bam_paths[0])
    chrom_len = _reference_length(fasta, first_bam, d["chrom"], chrom_map) or (ref + d["flank"])
    spans = sorted(plan.get('canonical_ref_len', plan['ref_end'] - plan['ref']) for plan, _read in full)
    replaced_len = spans[len(spans) // 2]
    layout = AltLayout(chrom=d["chrom"], ref=ref, insert_len=len(consensus), replaced_len=replaced_len,
                       flank_left=min(d["flank"], ref), flank_right=max(0, min(d["flank"], chrom_len - ref - replaced_len)))
    alt_seq = (_reference_bases(fasta, d["chrom"], layout.ref_start, ref, chrom_map) + consensus
               + _reference_bases(fasta, d["chrom"], ref + replaced_len, ref + replaced_len + layout.flank_right, chrom_map))

    sampled = _evenly(carriers, d["max_carriers"])
    jobs = [(_plan_kind(plan), plan, read) for plan, read, _p, _b in sampled]
    reference_reads = sorted(site["reference"], key=lambda item: (item[0].query_name, item[1]))
    if d["include_reference"]:
        jobs += [(KIND_REFERENCE, {"kind": KIND_REFERENCE}, read)
                 for read, _p, _b in _evenly(reference_reads, DEFAULT_MAX_REFERENCE)]

    from services.alt_allele_align import realign_batch
    plans = [(read.cigartuples, read.reference_start, {**plan, 'kind': kind}, read.query_sequence or '')
             for kind, plan, read in jobs]
    alignments = realign_batch(plans, layout, alt_seq)
    results = [(kind, read, res) if res is not None else None
               for (kind, _plan, read), res in zip(jobs, alignments)]

    os.makedirs(out_dir, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".build-", dir=out_dir)
    try:
        fasta_path = os.path.join(tmp, "alt.fa")
        with open(fasta_path, "w") as fh:
            fh.write(f">{layout.name} {label or ''} carriers alt allele; insert [{layout.insert_start + 1}-"
                     f"{layout.insert_end}] ({method} consensus)\n")
            for i in range(0, len(alt_seq), 80):
                fh.write(alt_seq[i:i + 80] + "\n")
        pysam.faidx(fasta_path)
        extra = []
        for path in bam_paths[1:]:
            handle = bam_handle_getter(path)
            if handle is not None:
                extra.append(handle.header.to_dict())
        header = _alt_header(first_bam, layout, extra)
        unsorted = os.path.join(tmp, "unsorted.bam")
        counts = {KIND_CIGAR: 0, KIND_CLIP_START: 0, KIND_CLIP_END: 0, KIND_HARD: 0, KIND_REFERENCE: 0}
        written = 0
        poorly = 0
        plans_len = {id(read): int(plan.get("len") or 0) for _k, plan, read in jobs}
        with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
            for item in results:
                if item is None:
                    continue
                kind, read, res = item
                # The fetched record itself, moved onto the contig (its sequence, qualities and
                # tags, with their exact types, stay as they are).
                md, nm = md_nm(res.reference_start, res.cigar, read.query_sequence or "", alt_seq)
                rec = read
                for tag in _DROP_TAGS:
                    if rec.has_tag(tag):
                        rec.set_tag(tag, None)
                rec.flag = int(read.flag) & _KEEP_FLAGS
                rec.reference_id = 0
                rec.reference_start = int(res.reference_start)
                rec.cigartuples = res.cigar
                rec.next_reference_id = -1
                rec.next_reference_start = -1
                rec.template_length = 0
                rec.set_tag("MD", md, value_type="Z")
                rec.set_tag("NM", int(nm), value_type="i")
                rec.set_tag("XK", kind, value_type="Z")
                # Bases of the read aligned inside the insert (XI) and the insert bases it holds (XL).
                rec.set_tag("XI", int(res.insert_bases), value_type="i")
                held = int(plans_len.get(id(read), 0))
                if kind != KIND_REFERENCE:
                    rec.set_tag("XL", held, value_type="i")
                    if held > 0 and res.insert_bases < 0.8 * min(held, layout.insert_len):
                        poorly += 1
                out.write(rec)
                counts[kind] += 1
                written += 1
        if written == 0:
            raise AltAlleleError("No carrier could be placed on the alternate allele")
        bam_path = os.path.join(tmp, "carriers.bam")
        pysam.sort("-@", str(max(1, min(4, (os.cpu_count() or 2) - 1))), "-o", bam_path, unsorted)
        os.remove(unsorted)
        pysam.index(bam_path)
        meta = {
            "schema": SCHEMA,
            "definition": d,
            "source": {"paths": list(bam_paths), "label": label, "genome": source_genome},
            "layout": layout.to_dict(),
            "sv": {"t": "I", "ref": ref, "len": length},
            "consensus": {"method": method, "length": len(consensus),
                          "alignment_algorithms": request_provenance(),
                          **({"fallback": fallback} if daf and fallback else {}),
                          **({k: daf_info[k] for k in ("confident_fraction", "carriers_ct", "carriers_ga")}
                             if daf_info else {})},
            "carriers": {"total": len(carriers), "written": sum(v for k, v in counts.items() if k != KIND_REFERENCE),
                         "sampled": len(sampled) < len(carriers),
                         "cigar": counts[KIND_CIGAR], "clip_start": counts[KIND_CLIP_START],
                         "clip_end": counts[KIND_CLIP_END], "hard": counts[KIND_HARD],
                         # Carriers with less than 80% of their insert bases aligned inside the insert
                         # (another element at the site, a chimeric read).
                         "poorly_aligned": poorly},
            "reference_reads": {"total": len(reference_reads), "written": counts[KIND_REFERENCE]},
            "excluded": site["excluded"],
            "seconds": round(time.perf_counter() - started, 2),
        }
        with open(os.path.join(tmp, "meta.json"), "w") as fh:
            json.dump(meta, fh, indent=1)
        # Into place: the files first, meta.json last (its presence means complete).
        for name in ("alt.fa", "alt.fa.fai", "carriers.bam", "carriers.bam.bai"):
            os.replace(os.path.join(tmp, name), os.path.join(out_dir, name))
        os.replace(os.path.join(tmp, "meta.json"), os.path.join(out_dir, "meta.json"))
        return meta
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _fasta_name(fasta) -> Optional[str]:
    name = getattr(fasta, "filename", None)
    if isinstance(name, bytes):
        name = name.decode(errors="replace")
    return str(name) if name else None


def _read_meta(out_dir: str) -> Optional[dict]:
    path = os.path.join(out_dir, "meta.json")
    try:
        with open(path) as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return None
    if meta.get("schema") != SCHEMA:
        return None
    for name in ("alt.fa", "alt.fa.fai", "carriers.bam", "carriers.bam.bai"):
        if not os.path.isfile(os.path.join(out_dir, name)):
            return None
    return meta


def _lock_for(key: str) -> threading.Lock:
    with _BUILD_LOCKS_GUARD:
        return _BUILD_LOCKS.setdefault(key, threading.Lock())


def ensure_built(bam_paths: list[str], definition: dict, *, fasta=None, daf: bool = False, chrom_map=None,
                 contig_links=None, reference_id: str = "", label: str = "",
                 source_genome: Optional[str] = None, fasta_path: Optional[str] = None) -> tuple[str, dict, bool]:
    """(directory, meta, built now) of the alt allele for ``definition``, building it if needed."""
    key = _cache_key(bam_paths, definition, daf, reference_id, _fasta_name(fasta) or fasta_path,
                     contig_links)
    out_dir = os.path.join(alt_allele_dir(), key)
    with _lock_for(key):
        meta = _read_meta(out_dir)
        if meta is not None:
            # A reused build takes its source's genome as it is now (set, changed or cleared): its metadata
            # is what describe_fasta_context reads when the insert is attached again.
            if (meta.get("source") or {}).get("genome") != source_genome:
                try:
                    _store_meta_genome(out_dir, source_genome)
                except OSError:
                    pass
                meta.setdefault("source", {})["genome"] = source_genome
            return out_dir, meta, False
        meta = build_alt_allele(bam_paths, definition, out_dir, fasta=fasta, daf=daf, chrom_map=chrom_map,
                                contig_links=contig_links, label=label, source_genome=source_genome)
        return out_dir, meta, True


# ---------------------------------------------------------------------------
# The workspace: a dataset on its own reference


def _source_reference_id(state, dataset_id: str) -> str:
    from services.panel_genomes import dataset_genome
    key = dataset_genome(state, dataset_id)
    if key:
        return f"panel:{key}"
    return str(getattr(state, "current_genome", None) or getattr(state, "fasta_path", None) or "")


def alt_label(source_label: str, layout: dict, carriers: dict) -> str:
    """``Carriers of +9,184 bp at chr2L:9,467,038 (3,267) · numb``: the panel title says first
    that it shows the carriers (and never " + ", which labels use to join datasets)."""
    n = carriers.get("written") or 0
    total = carriers.get("total") or n
    count = f"{n:,}" if n == total else f"{n:,} of {total:,}"
    return (f"Carriers of +{layout['insert_len']:,} bp at {layout['chrom']}:{layout['ref']:,} ({count}) "
            f"· {source_label}")


def open_alt_allele(state, source_dataset_id: Optional[str], raw: dict, *, dataset_id_hint: Optional[str] = None,
                    label_hint: Optional[str] = None, source_paths: Optional[list] = None) -> dict:
    """Build (or reuse) the alt allele of an insertion of ``source_dataset_id``, register it as a
    dataset on its own reference (the alt contig's FASTA) and say where its panel opens."""
    from services import panel_genomes
    from services.insertion_lens import _dataset_bam_paths, _is_daf_dataset
    from services.plasmid_reconcile import contig_links
    from services.query_params import resolve_dataset_id

    if not source_dataset_id and source_paths:
        source_dataset_id = find_source_dataset(state, source_paths)
    if not source_dataset_id:
        raise AltAlleleError("The dataset the insertion's carriers come from is not open")
    source_dataset_id = resolve_dataset_id(state, source_dataset_id)
    dataset_id, paths, error = _dataset_bam_paths(state, source_dataset_id)
    if error:
        raise AltAlleleError(error)
    if any("://" in str(p) for p in paths):
        raise AltAlleleError("The alternate allele is built from local BAM files (this dataset is remote)")
    source = state.get_dataset(dataset_id)
    raw = dict(raw)
    raw["chrom"] = state.translate_chrom(str(raw["chrom"]))
    definition = normalize_definition(raw)
    view = panel_genomes.for_datasets(state, [dataset_id])
    source_label = str(getattr(source, "label", None) or dataset_id)
    out_dir, meta, built = ensure_built(
        paths, definition, fasta=getattr(view, "fasta", None), daf=_is_daf_dataset(source),
        chrom_map=getattr(view, "chrom_map", None), contig_links=contig_links(state, path=paths[0]),
        reference_id=_source_reference_id(state, dataset_id), label=source_label,
        source_genome=_genome_of(view), fasta_path=getattr(view, "fasta_path", None),
    )
    layout = meta["layout"]
    label = alt_label(source_label, layout, meta["carriers"])
    if definition["include_reference"]:
        label += f", with {meta['reference_reads']['written']:,} reference reads"
    label = label_hint or label
    # Once per built BAM in this workspace: under its state lock (services/genome_loading hierarchy, level 1;
    # a session import restoring an insertion already holds it). The build above ran outside every lock;
    # registering opens the small carriers BAM and alt.fa under it.
    from services.genome_loading import state_lock
    with state_lock(state):
        return _register(state, dataset_id, source, out_dir, meta, built, definition, paths, label, view,
                         dataset_id_hint)


def _register(state, dataset_id, source, out_dir, meta, built, definition, paths, label, view, dataset_id_hint):
    """The alt dataset on its own reference (once per built BAM, whatever opens it at once)."""
    from services import panel_genomes
    bam_path = os.path.join(out_dir, "carriers.bam")
    fasta_path = os.path.join(out_dir, "alt.fa")
    layout = meta["layout"]
    existing = next((did for did, ds in state.datasets.items()
                     if os.path.abspath(str(getattr(ds, "path", ""))) == os.path.abspath(bam_path)), None)
    if existing is not None:
        alt_dataset = state.datasets[existing]
    else:
        from services.dataset_registration import dataset_id_from_source
        wanted = dataset_id_hint or f"{dataset_id}_alt_{layout['ref']}_{layout['insert_len']}{'_mixed' if definition['include_reference'] else ''}"
        alt_dataset = state.add_dataset(dataset_id_from_source(wanted, wanted), bam_path, label=label)
        _inherit_chemistry(source, alt_dataset)
    spec = {"source_dataset_id": dataset_id, "source_paths": list(paths), "definition": definition}
    _mark(alt_dataset, {**spec, "layout": layout, "meta": _public_meta(meta)})
    key_hint = "fasta:alt_" + os.path.basename(out_dir)
    attached = panel_genomes.attach(state, [alt_dataset.id], fasta_path=fasta_path, span=0, key=key_hint)
    genome = attached.get("genome") or {}
    _describe_context(state, genome.get("key"), view, layout)
    if genome.get("key"):
        genome = panel_genomes._context_info(genome["key"], panel_genomes.contexts(state)[genome["key"]])
    locus = default_locus(layout)
    with panel_genomes._LOCK:
        if genome.get("key"):
            panel_genomes.start_loci(state)[alt_dataset.id] = {"key": genome["key"], "locus": dict(locus)}
    return {
        "success": True,
        "dataset": alt_dataset.to_dict(),
        "genome": genome,
        "genome_key": genome.get("key"),
        "locus": locus,
        "layout": layout,
        "alt_allele": {**spec, "layout": layout, "meta": _public_meta(meta)},
        "built": built,
    }


def find_source_dataset(state, paths: list) -> Optional[str]:
    """The open dataset reading exactly these files."""
    wanted = sorted(os.path.abspath(str(p)) for p in paths or [] if p)
    for did in getattr(state, "dataset_order", None) or list(getattr(state, "datasets", {}) or {}):
        ds = state.datasets.get(did)
        have = sorted(os.path.abspath(str(p)) for p in (getattr(ds, "paths", None) or []) if p)
        if have and have == wanted:
            return did
    return None


def adopt(state, dataset) -> None:
    """A dataset opened from a built alt allele's BAM (a crash restore, a reopened session,
    an undo) is an alt-allele dataset again: its definition is read back from meta.json."""
    path = getattr(dataset, "path", None)
    if not path or getattr(dataset, "alt_allele", None) or not str(path).endswith("carriers.bam"):
        return
    if not is_alt_allele_path(path):
        return
    meta = _read_meta(os.path.dirname(os.path.abspath(str(path))))
    if meta is None:
        return
    source_paths = list((meta.get("source") or {}).get("paths") or [])
    _mark(dataset, {"source_dataset_id": find_source_dataset(state, source_paths), "source_paths": source_paths,
                    "definition": meta["definition"], "layout": meta["layout"], "meta": _public_meta(meta)})


def _mark(dataset, info: dict) -> None:
    """An alt-allele dataset: its definition on the dataset, and listed with it (GET /api/datasets, plugin pack fields)."""
    dataset.alt_allele = info
    dataset.pack_fields = {**(getattr(dataset, "pack_fields", None) or {}), "alt_allele": info}


def session_entry(dataset) -> Optional[dict]:
    """What a session stores to rebuild an alt-allele dataset (not its built files)."""
    info = getattr(dataset, "alt_allele", None)
    if not info:
        return None
    return {"source_dataset_id": info.get("source_dataset_id"), "source_paths": info.get("source_paths") or [],
            "definition": info.get("definition"), "layout": info.get("layout")}


def restore_from_session(state, dataset_data: dict) -> dict:
    """Rebuild (or reuse) a session's alt-allele dataset under its saved id and label."""
    entry = dataset_data.get("alt_allele") or {}
    definition = entry.get("definition")
    if not isinstance(definition, dict):
        raise AltAlleleError("no alt-allele definition recorded")
    source_id = entry.get("source_dataset_id")
    source = state.get_dataset(source_id) if source_id else None
    wanted_paths = entry.get("source_paths") or []
    if source is None or (wanted_paths and find_source_dataset(state, wanted_paths) not in (None, source_id)):
        source_id = find_source_dataset(state, wanted_paths) or source_id
    return open_alt_allele(state, source_id, definition, dataset_id_hint=dataset_data.get("id"),
                           label_hint=dataset_data.get("label"), source_paths=wanted_paths)


def reattach(state) -> list[str]:
    """Alt-allele datasets without their own reference (a session whose saved FASTA path was
    rebuilt elsewhere) get their contig FASTA back."""
    from services import panel_genomes
    done = []
    for did, ds in list((getattr(state, "datasets", None) or {}).items()):
        if not getattr(ds, "alt_allele", None):
            continue
        fasta_path = os.path.join(os.path.dirname(os.path.abspath(str(ds.path))), "alt.fa")
        if not os.path.isfile(fasta_path):
            continue
        key_now = panel_genomes.dataset_genome(state, did)
        ctx = panel_genomes.contexts(state).get(key_now) if key_now else None
        # On its own contig already (not another build's, e.g. a session's saved FASTA).
        if ctx is not None and os.path.abspath(str(getattr(ctx, "fasta_path", "") or "")) == fasta_path:
            continue
        try:
            attached = panel_genomes.attach(state, [did], fasta_path=fasta_path, span=0,
                                            key="fasta:alt_" + os.path.basename(os.path.dirname(fasta_path)))
            key = (attached.get("genome") or {}).get("key")
            source_id = ds.alt_allele.get("source_dataset_id")
            layout = ds.alt_allele.get("layout") or {}
            _describe_context(state, key, panel_genomes.for_datasets(state, [source_id]) if source_id else state, layout)
            if key and layout:
                with panel_genomes._LOCK:
                    panel_genomes.start_loci(state)[did] = {"key": key, "locus": default_locus(layout)}
            done.append(did)
        except Exception:
            continue
    return done


def alt_reference_label(layout: dict) -> str:
    return f"Alt allele {layout['chrom']}:{layout['ref']:,} +{layout['insert_len']:,} bp"


def describe_fasta_context(ctx, fasta_path: str) -> None:
    """A FASTA reference that is a built alt allele's contig (``alt.fa`` beside its meta.json):
    named for the insertion, with the source genome's species, however it was attached
    (an open, a session restore, a crash recovery)."""
    if os.path.basename(str(fasta_path)) != "alt.fa" or not is_alt_allele_path(fasta_path):
        return
    meta = _read_meta(os.path.dirname(os.path.abspath(str(fasta_path))))
    spec = getattr(ctx, "_panel_genome_spec", None)
    if meta is None or not isinstance(spec, dict):
        return
    spec["label"] = alt_reference_label(meta["layout"])
    spec["alt_allele"] = True
    spec["built_by"] = "alt_allele"
    _set_species(spec, (meta.get("source") or {}).get("genome"))


def _describe_context(state, key: Optional[str], source_view, layout: dict) -> None:
    """The contig's reference is named for the insertion, and motif scans on it use the
    source genome's JASPAR species."""
    from services import panel_genomes
    ctx = panel_genomes.contexts(state).get(key) if key else None
    spec = getattr(ctx, "_panel_genome_spec", None) if ctx is not None else None
    if not isinstance(spec, dict):
        return
    spec["label"] = alt_reference_label(layout)
    spec["alt_allele"] = True
    spec["built_by"] = "alt_allele"
    _set_species(spec, _genome_of(source_view))


def _set_species(spec: dict, genome: Optional[str]) -> None:
    """The inherited genome, or none: a stale one (the source's declaration cleared) is removed."""
    if genome:
        spec["species_genome"] = genome
    else:
        spec.pop("species_genome", None)


def _store_meta_genome(out_dir: str, genome: Optional[str]) -> None:
    """The source genome kept with the built files (used when the source is not open) follows the source."""
    meta = _read_meta(out_dir)
    if meta is None or (meta.get("source") or {}).get("genome") == genome:
        return
    meta.setdefault("source", {})["genome"] = genome
    path = os.path.join(out_dir, "meta.json")
    fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=".meta-", suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(meta, fh)
    os.replace(tmp, path)


def refresh_inherited_genomes(state) -> list[str]:
    """After a genome declaration changes: every open expanded insert takes its source's genome as it is
    now (set, changed or removed), in its reference and in its built metadata. Returns the datasets updated."""
    from services import panel_genomes
    done = []
    for did, ds in list((getattr(state, "datasets", None) or {}).items()):
        info = getattr(ds, "alt_allele", None)
        source_id = (info or {}).get("source_dataset_id")
        if not info or not source_id or source_id not in (getattr(state, "datasets", None) or {}):
            continue
        key = panel_genomes.dataset_genome(state, did)
        ctx = panel_genomes.contexts(state).get(key) if key else None
        spec = getattr(ctx, "_panel_genome_spec", None) if ctx is not None else None
        if not isinstance(spec, dict):
            continue
        genome = _genome_of(panel_genomes.for_datasets(state, [source_id]))
        if spec.get("species_genome") != genome:
            _set_species(spec, genome)
            done.append(did)
        try:
            _store_meta_genome(os.path.dirname(os.path.abspath(str(ds.path))), genome)
        except OSError:
            pass
    return done


def _genome_of(view) -> Optional[str]:
    """The genome the source's reference belongs to (its registry genome, a FASTA's assembly, a
    declared one): the alt allele takes that identity (motif species, TE library), not its coordinates."""
    from services.motifs import reference_genome
    return reference_genome(view) if view is not None else None


def _public_meta(meta: dict) -> dict:
    return {k: meta[k] for k in ("sv", "consensus", "carriers", "reference_reads", "excluded", "seconds") if k in meta}


def default_locus(layout: dict) -> dict:
    """The insert with a fifth of its length (at least 1 kb) of flank on each side."""
    pad = max(1000, layout["insert_len"] // 5)
    start = max(0, layout["insert_start"] - pad)
    end = min(layout["length"], layout["insert_end"] + pad)
    return {"chrom": layout["name"], "start": int(start), "end": int(end)}


def _inherit_chemistry(source, alt) -> None:
    """A chemistry the user set on the source dataset holds for its carriers too."""
    if source is None:
        return
    meta = getattr(source, "chemistry_metadata", None) or {}
    if meta.get("source") in ("user", "manual") and getattr(source, "consensus_chemistry", None):
        alt.consensus_chemistry = source.consensus_chemistry
        alt.chemistry_metadata = dict(meta)


def alt_allele_info(state, dataset_id: str) -> Optional[dict]:
    dataset = state.get_dataset(dataset_id) if dataset_id else None
    return getattr(dataset, "alt_allele", None) if dataset is not None else None


__all__ = [
    "AltAlleleError", "alt_allele_dir", "alt_contig_name", "build_alt_allele", "default_locus", "ensure_built",
    "is_alt_allele_path", "normalize_definition", "open_alt_allele",
]
