"""Does each loaded dataset fit the loaded reference?

A BAM aligned to hg38 under a dm6 reference (or hg19 under hg38) shows no
reads, or reads at the wrong place, without saying why. This compares every
dataset's contigs (``@SQ`` names/lengths/M5, a BigBed's chromosome list) with
the loaded reference (FASTA index, plasmid maps, or a registry genome's
known chromosome lengths) and names both assemblies when it can
(services/assembly_fingerprint.py).

Not counted: unplaced/alt/decoy contigs (they differ between analysis sets of
one assembly) and a dataset's contigs linked to plasmid maps
(services/plasmid_reconcile). ``chr1`` and ``1`` (``chrM``/``MT``, roman
numerals) are the same contig: the app matches those names everywhere
(utils/chrom.get_chrom_variants). Names it can't match, like RefSeq
accessions (``NC_000001.11``) against ``chr1``, are reported as "same
assembly, other chromosome names".

Report only: nothing here loads or downloads. The suggestion names a registry
genome; loading it is ``POST /api/load_genome``, whose public-mode rules apply.
"""
from __future__ import annotations

import os
from typing import Any, Optional

from services.assembly_fingerprint import (
    ASSEMBLIES,
    REGISTRY_IDS,
    Contig,
    Fingerprint,
    assembly_name,
    canonical_contigs,
    fingerprint,
    header_contigs,
    is_mito,
    is_unplaced,
    short_name,
)
from utils.chrom import get_chrom_variants

STATUS_SEVERITY = {
    "match": "ok",
    "no_reference": "info",
    "unknown": "info",
    "sequence_differs": "warning",
    "missing_contigs": "warning",  # "error" when none of its contigs are in the reference
    "other_names": "error",
    "different_assembly": "error",
}
_ALIGNMENT_EXTS = (".bam", ".cram", ".sam")
_LISTED = 50  # entries kept in each details list (the n_* counts say how many there were)
_BIGBED_EXTS = (".bb", ".bigbed")
_SHOWN = 4  # contig names quoted in a message


# ---------------------------------------------------------------------------
# The two sides
# ---------------------------------------------------------------------------

def _data_part(path: str) -> str:
    """The data file of htslib's ``data##idx##index`` pairing (a remote BAM opened
    with its index): what names the file type and the file; the whole string opens it."""
    from services.signed_urls import split_index
    return split_index(path)[0]


def _read_file_contigs(path: str) -> tuple[list[Contig], list[str]]:
    lower = _data_part(path).lower().split("?", 1)[0]
    if lower.endswith(_BIGBED_EXTS):
        from services.remote_sources.opening import open_bigwig
        handle = open_bigwig(path)
        if handle is None:
            raise OSError(f"Could not open {os.path.basename(_data_part(path))}")
        try:
            return [Contig(str(n), int(l)) for n, l in (handle.chroms() or {}).items()], []
        finally:
            handle.close()
    if lower.endswith(_ALIGNMENT_EXTS):
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(path, "rb", check_sq=False) as bam:
            return header_contigs(bam.header.to_dict())
    raise ValueError(f"No contig list in {os.path.basename(_data_part(path))}")


def dataset_header(dataset) -> dict:
    """The dataset's contigs and header labels (``AS``/``UR``), read once per file set.

    ``{"contigs": [Contig], "labels": [str], "error": str | None}``.
    """
    paths = tuple(str(p) for p in (getattr(dataset, "paths", None) or [getattr(dataset, "path", "")]) if p)
    cached = getattr(dataset, "_assembly_header", None)
    if cached and cached[0] == paths:
        return cached[1]
    contigs: dict[str, Contig] = {}
    labels: list[str] = []
    error = None
    for path in paths:
        try:
            found, found_labels = _read_file_contigs(path)
        except Exception as exc:  # unreadable, remote without access, a directory...
            error = str(exc) or type(exc).__name__
            continue
        for contig in found:
            contigs.setdefault(contig.name, contig)
        labels.extend(label for label in found_labels if label not in labels)
        # Files named after the assembly (sample.hg38.bam) say it too.
        labels.append(os.path.basename(_data_part(path).split("?", 1)[0]))
    result = {"contigs": list(contigs.values()), "labels": labels,
              "error": None if contigs else (error or "No contigs found")}
    try:
        dataset._assembly_header = (paths, result)
    except Exception:
        pass
    return result


_DICT_CACHE: dict[str, dict[str, str]] = {}


def _fasta_md5s(fasta_path: Optional[str]) -> dict[str, str]:
    """M5 checksums from a sequence dictionary beside the FASTA (``ref.dict`` /
    ``ref.fa.dict``, as Picard/samtools write it), when there is one."""
    if not fasta_path or "://" in str(fasta_path):
        return {}
    if fasta_path in _DICT_CACHE:
        return _DICT_CACHE[fasta_path]
    stem = fasta_path
    for ext in (".gz", ".fa", ".fasta", ".fna"):
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
    out: dict[str, str] = {}
    for candidate in (fasta_path + ".dict", stem + ".dict"):
        if not os.path.isfile(candidate):
            continue
        try:
            with open(candidate, encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if not line.startswith("@SQ"):
                        continue
                    fields = dict(part.split(":", 1) for part in line.rstrip("\n").split("\t")[1:] if ":" in part)
                    if fields.get("SN") and fields.get("M5"):
                        out[fields["SN"]] = fields["M5"].lower()
        except OSError:
            continue
        break
    _DICT_CACHE[fasta_path] = out
    return out


def loaded_reference(state) -> dict:
    """The reference the view uses: FASTA contigs (and plasmid maps), else the
    registry genome's known chromosome lengths, else nothing."""
    fasta = getattr(state, "fasta", None)
    plasmids = dict(getattr(state, "plasmid_sequences", None) or {})
    current = getattr(state, "current_genome", None)
    contigs: list[Contig] = []
    md5s: dict[str, str] = {}
    label = None
    kind = "none"
    partial = False
    fasta_path = getattr(state, "fasta_path", None)
    if fasta is not None:
        try:
            names = list(fasta.references)
            lengths = list(getattr(fasta, "lengths", None) or [fasta.get_reference_length(n) for n in names])
            contigs = [Contig(str(n), int(l)) for n, l in zip(names, lengths)]
            kind = "fasta"
            md5s.update(_fasta_md5s(fasta_path))
        except Exception:
            contigs = []
    if plasmids:
        from services.plasmid_reconcile import sequence_md5
        for name, sequence in plasmids.items():
            if not any(c.name == name for c in contigs):
                contigs.append(Contig(str(name), len(sequence)))
            md5s[str(name)] = sequence_md5(sequence)
        if kind == "none":
            kind = "plasmids"
    fp = fingerprint([c for c in contigs if c.name not in plasmids],
                     labels=[os.path.basename(str(fasta_path))] if fasta_path else [])
    assembly = fp.assembly if fp.kind == "genome" else None
    if kind == "none" and current in ASSEMBLIES:
        # A registry genome whose FASTA did not load (annotation only): its
        # fingerprinted chromosome lengths still say what it is.
        contigs = [Contig(n, l) for n, l in canonical_contigs(current).items()]
        kind, partial, assembly = "registry", True, current
    if current in REGISTRY_IDS and assembly == current:
        label = current
    elif assembly:
        label = short_name(assembly)
    elif kind == "fasta" and fasta_path:
        label = os.path.basename(str(fasta_path).split("?", 1)[0])
    elif kind == "plasmids":
        label = "the plasmid maps"
    return {
        "kind": kind,
        "label": label,
        "assembly": assembly,
        "genome_id": current if current in REGISTRY_IDS else None,
        "fingerprint": fp,
        "contigs": contigs,
        "md5": md5s,
        "partial": partial,
        "plasmids": set(plasmids),
    }


# ---------------------------------------------------------------------------
# Comparing them
# ---------------------------------------------------------------------------

def _names(items, key="contig") -> str:
    names = [str(item[key]) if isinstance(item, dict) else str(item) for item in items]
    shown = ", ".join(names[:_SHOWN])
    return shown + (f" and {len(names) - _SHOWN} more" if len(names) > _SHOWN else "")


def _genome_cached(genome_id: str) -> bool:
    try:
        from services.genome_registry import GENOME_REGISTRY
        from state.browser_state import cached_fasta_path
        info = GENOME_REGISTRY[genome_id]
        urls = list(info.get("fasta_urls") or ([info["fasta_url"]] if info.get("fasta_url") else []))
        if not urls:
            return False
        local = cached_fasta_path(os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes"), urls)
        return os.path.exists(local) and os.path.exists(local + ".fai")
    except Exception:
        return False


def _suggestion(fp, *, reference_assembly: Optional[str], can_load: bool) -> Optional[dict]:
    """The registry genome to load for this dataset, when its assembly is plain
    and the app can match its chromosome names (UCSC or Ensembl style)."""
    if fp.assembly not in REGISTRY_IDS or fp.assembly == reference_assembly:
        return None
    if fp.confidence not in ("high", "medium") or fp.naming in ("ncbi", "other"):
        return None
    from services.genome_registry import GENOME_REGISTRY
    info = GENOME_REGISTRY.get(fp.assembly)
    if not info:
        return None
    return {"genome_id": fp.assembly, "name": info["name"], "confidence": fp.confidence,
            "cached": _genome_cached(fp.assembly), "can_load": bool(can_load)}


def _can_load_genomes() -> bool:
    from services.runtime import get_public_mode
    return not get_public_mode()


def check_dataset(state, dataset_id: str, *, reference: Optional[dict] = None,
                  can_load: Optional[bool] = None) -> dict:
    """How one dataset fits the loaded reference: a status, a message and the evidence."""
    from services.plasmid_reconcile import contig_links

    dataset = (getattr(state, "datasets", {}) or {}).get(dataset_id)
    if dataset is None:
        raise KeyError(dataset_id)
    reference = reference if reference is not None else loaded_reference(state)
    can_load = _can_load_genomes() if can_load is None else can_load
    label = str(getattr(dataset, "label", None) or dataset_id)
    header = dataset_header(dataset)
    contigs: list[Contig] = header["contigs"]
    fp = fingerprint(contigs, labels=header["labels"])
    out: dict[str, Any] = {
        "dataset_id": dataset_id,
        "label": label,
        "data_type": getattr(dataset, "data_type", None),
        "assembly": fp.to_dict(),
        "reference": {"label": reference["label"], "assembly": reference["assembly"],
                      "kind": reference["kind"]},
        "status": "match",
        "severity": "ok",
        "message": None,
        "details": {"missing": [], "length_differs": [], "renamed": [], "sequence_differs": [],
                    "ignored": [], "notes": []},
        "suggestion": None,
        "known_not_in_registry": bool(fp.assembly and fp.assembly not in REGISTRY_IDS and fp.kind == "genome"),
    }
    details = out["details"]
    fp_short = short_name(fp.assembly) if fp.kind == "genome" else None

    def finish(status: str, message: Optional[str], severity: Optional[str] = None) -> dict:
        for key in ("missing", "length_differs", "renamed", "sequence_differs", "ignored"):
            if len(details[key]) > _LISTED:  # a fragmented assembly: thousands of contigs
                details[f"n_{key}"] = len(details[key])
                details[key] = details[key][:_LISTED]
        out["status"] = status
        out["severity"] = severity or STATUS_SEVERITY[status]
        out["message"] = message
        if status != "match":
            out["suggestion"] = _suggestion(fp, reference_assembly=reference["assembly"], can_load=can_load)
        return out

    if header["error"] and not contigs:
        return finish("unknown", None)
    if reference["kind"] == "none":
        return finish("no_reference", (f"{label} was aligned to {fp_short}; no reference genome is loaded."
                                       if fp_short else None))

    links = contig_links(state, dataset_id=dataset_id)
    ref_contigs = reference["contigs"]
    ref_lengths = {c.name: c.length for c in ref_contigs}
    ref_set = set(ref_lengths)
    considered: list[Contig] = []
    for contig in contigs:
        if contig.name in links:
            details["ignored"].append({"contig": contig.name, "reason": f"linked to plasmid map {links[contig.name]}"})
        elif is_unplaced(contig.name):
            continue  # unplaced/alt/decoy: not listed (there can be thousands)
        else:
            considered.append(contig)
    if not considered:
        return finish("match", None)

    ok, mito_notes = [], []
    unresolved: list[Contig] = []
    used = set()
    for contig in considered:
        # The app's name aliases (chr1 / 1, chrM / MT, roman numerals), as utils.chrom.resolve_reference_name.
        ref_name = next((v for v in get_chrom_variants(contig.name) if v in ref_set), None)
        if ref_name is None:
            unresolved.append(contig)
            continue
        used.add(ref_name)
        ref_length = ref_lengths[ref_name]
        if ref_length != contig.length:
            item = {"contig": contig.name, "reference_contig": ref_name,
                    "file_length": contig.length, "reference_length": ref_length}
            if is_mito(contig.name) or is_mito(ref_name):
                mito_notes.append(item)
            else:
                details["length_differs"].append(item)
            continue
        ref_md5 = reference["md5"].get(ref_name)
        if contig.md5 and ref_md5 and contig.md5 != ref_md5:
            details["sequence_differs"].append({"contig": contig.name, "reference_contig": ref_name})
            continue
        ok.append(contig)
    by_length: dict[int, list[str]] = {}
    for name, length in ref_lengths.items():
        if name not in used:
            by_length.setdefault(length, []).append(name)
    for contig in unresolved:
        same = [n for n in by_length.get(contig.length, []) if n not in used]
        if len(same) == 1 and not is_mito(contig.name):
            used.add(same[0])
            details["renamed"].append({"contig": contig.name, "reference_contig": same[0], "length": contig.length})
        elif not reference["partial"]:
            details["missing"].append({"contig": contig.name, "length": contig.length})
    for item in mito_notes:
        details["notes"].append(
            f"{item['contig']} is {item['file_length']:,} bp in {label} but {item['reference_length']:,} bp "
            f"in the reference (a different mitochondrial sequence).")

    ref_label = reference["label"] or "the loaded reference"
    ref_assembly = reference["assembly"]
    differs = details["length_differs"]
    other_assembly = bool(fp_short and ref_assembly and fp.assembly != ref_assembly
                          and fp.confidence in ("high", "medium"))
    if reference["partial"] and other_assembly and not ok:
        # Only a registry genome's few known chromosomes to compare with, and
        # none of them in the file: the assemblies still say it.
        return finish("different_assembly",
                      f"{label} was aligned to {fp_short}, but {short_name(ref_assembly)} is loaded — "
                      f"reads won't line up with the reference.")
    if not differs and not details["renamed"] and not details["missing"]:
        if details["sequence_differs"]:
            return finish("sequence_differs",
                          f"{_names(details['sequence_differs'])} in {label} has the same length but a different "
                          f"sequence (M5 checksum) from {ref_label}'s.")
        return finish("match", None)

    if other_assembly:
        details["notes"] = []  # another assembly altogether: its chrM differs too, as a matter of course
        return finish("different_assembly",
                      f"{label} was aligned to {fp_short}, but {short_name(ref_assembly)} is loaded — "
                      f"reads won't line up with the reference.")
    if differs:
        details["notes"] = []
        first = differs[0]
        lead = (f"{label} was aligned to {fp_short}, and it doesn't match {ref_label}"
                if fp_short else f"{label} was aligned to a different assembly than {ref_label}")
        return finish("different_assembly",
                      f"{lead}: {first['contig']} is {first['file_length']:,} bp in the file but "
                      f"{first['reference_length']:,} bp in the reference — reads won't line up.")
    if details["renamed"] and not ok and len(details["renamed"]) >= len(details["missing"]):
        pair = details["renamed"][0]
        what = f"the same assembly ({fp_short})" if fp_short else "the same assembly"
        return finish("other_names",
                      f"{label} and {ref_label} are {what}, but name chromosomes differently "
                      f"({pair['contig']} in the file, {pair['reference_contig']} in the reference), so its reads "
                      f"can't be placed. Load a reference that uses the file's names.")
    missing = details["missing"] + [{"contig": r["contig"], "length": r["length"]} for r in details["renamed"]]
    none_in = not ok
    if fp_short and none_in and ref_assembly is None and fp.kind == "genome":
        msg = (f"{label} was aligned to {fp_short}, which isn't the loaded reference ({ref_label}): "
               f"none of its chromosomes ({_names(missing)}) are in it.")
    elif none_in:
        msg = (f"None of {label}'s contigs ({_names(missing)}) are in {ref_label}, so it shows no reads. "
               f"Load the reference it was aligned to.")
    else:
        msg = (f"{_names(missing)} {'is' if len(missing) == 1 else 'are'} in {label} but not in {ref_label}; "
               f"reads there won't show.")
    return finish("missing_contigs", msg, "error" if none_in else "warning")


def dataset_summary(check: dict) -> dict:
    """What the dataset list carries: the assembly and whether it fits."""
    assembly = check.get("assembly") or {}
    return {"assembly": assembly.get("assembly"), "confidence": assembly.get("confidence"),
            "kind": assembly.get("kind"), "status": check.get("status"), "severity": check.get("severity"),
            "message": check.get("message"),
            "suggested_genome": (check.get("suggestion") or {}).get("genome_id")}


def _cache_key(state, can_load: bool) -> tuple:
    """What the checks depend on: the reference, the plasmid maps and their
    links, the datasets' files (and who asks: a public visitor can't load)."""
    datasets = getattr(state, "datasets", {}) or {}
    files = tuple(
        (dataset_id, getattr(datasets[dataset_id], "label", None),
         tuple(str(p) for p in (getattr(datasets[dataset_id], "paths", None) or [getattr(datasets[dataset_id], "path", "")])))
        for dataset_id in (getattr(state, "dataset_order", None) or []) if dataset_id in datasets)
    plasmids = getattr(state, "plasmid_sequences", None) or {}
    links = tuple(sorted(
        (str(chrom), tuple((link.get("dataset_id"), link.get("contig"), tuple(link.get("paths") or ()))
                           for link in (meta or {}).get("links") or []))
        for chrom, meta in (getattr(state, "plasmid_metadata", None) or {}).items()))
    from services.panel_genomes import assignments, contexts
    ctxs = contexts(state)
    own = tuple(sorted((str(d), str(k), id(ctxs.get(k)), id(getattr(ctxs.get(k), "fasta", None)))
                       for d, k in assignments(state).items()))
    return (id(getattr(state, "fasta", None)), getattr(state, "fasta_path", None), getattr(state, "current_genome", None),
            tuple(sorted((str(n), len(s)) for n, s in plasmids.items())), files, links, can_load, own)


def _all_checks(state) -> tuple[dict, list[dict]]:
    """The loaded reference and every dataset's check, cached on the state
    until the reference, the datasets or the plasmid links change (the dataset
    list and /api/status ask on every refresh)."""
    can_load = _can_load_genomes()
    key = _cache_key(state, can_load)
    cached = getattr(state, "_genome_check_cache", None)
    if cached and cached[0] == key:
        return cached[1], cached[2]
    reference = loaded_reference(state)
    # A dataset given its own reference (services/panel_genomes.py) is checked against that one.
    from services.panel_genomes import contexts, dataset_genome
    own_references: dict[str, dict] = {}
    checks = []
    for dataset_id in list(getattr(state, "dataset_order", None) or []):
        if dataset_id not in (getattr(state, "datasets", {}) or {}):
            continue
        try:
            own = dataset_genome(state, dataset_id)
            if own is not None:
                if own not in own_references:
                    own_references[own] = loaded_reference(contexts(state)[own])
                check = check_dataset(state, dataset_id, reference=own_references[own], can_load=can_load)
                check["own_genome"] = own
                checks.append(check)
                continue
            checks.append(check_dataset(state, dataset_id, reference=reference, can_load=can_load))
        except Exception as exc:  # never fail the caller over this
            checks.append({"dataset_id": dataset_id, "status": "unknown", "severity": "info",
                           "message": None, "error": str(exc)})
    try:
        state._genome_check_cache = (key, reference, checks)
    except Exception:
        pass
    return reference, checks


def dataset_genome_summaries(state) -> dict[str, dict]:
    """``{dataset id: dataset_summary}`` for the dataset list (never raises)."""
    try:
        _reference, checks = _all_checks(state)
    except Exception:
        return {}
    return {check["dataset_id"]: dataset_summary(check) for check in checks}


def blocking_mismatch(state) -> Optional[dict]:
    """The datasets that can't be shown on the loaded reference (severity
    "error"), or None: ``{"dataset_ids": [...], "message": str}``."""
    summaries = dataset_genome_summaries(state)
    bad = [dataset_id for dataset_id, summary in summaries.items() if summary.get("severity") == "error"]
    if not bad:
        return None
    return {"dataset_ids": bad, "message": summaries[bad[0]].get("message")}


def main_genome_dataset_ids(state) -> list[str]:
    """The datasets the main view shows on the loaded reference, in load order:
    not one with its own panel genome (services/panel_genomes.py), and not one
    that can't be shown on it (severity "error", e.g. a dm6 BAM under hg38)."""
    from services.panel_genomes import dataset_genome

    summaries = dataset_genome_summaries(state)
    datasets = getattr(state, "datasets", {}) or {}
    return [dataset_id for dataset_id in (getattr(state, "dataset_order", None) or [])
            if dataset_id in datasets and dataset_genome(state, dataset_id) is None
            and (summaries.get(dataset_id) or {}).get("severity") != "error"]


def genome_check(state) -> dict:
    """Every dataset against the loaded reference, and the registry genome to suggest."""
    reference, checks = _all_checks(state)
    can_load = _can_load_genomes()
    # One registry genome every dataset of a known assembly points to.
    wanted = {c["assembly"]["assembly"] for c in checks
              if (c.get("assembly") or {}).get("kind") == "genome" and (c["assembly"].get("confidence") in ("high", "medium"))}
    suggestion = None
    if len(wanted) == 1:
        (only,) = wanted
        fp = next(fingerprint_of(c) for c in checks if (c.get("assembly") or {}).get("assembly") == only)
        suggestion = _suggestion(fp, reference_assembly=reference["assembly"], can_load=can_load)
        if suggestion is not None:
            suggestion["datasets"] = [c["label"] for c in checks if (c.get("assembly") or {}).get("assembly") == only]
    gtf = getattr(state, "gtf_data", None)
    transcripts = gtf.get("transcripts") if isinstance(gtf, dict) else None
    return {
        "reference": {"kind": reference["kind"], "label": reference["label"], "assembly": reference["assembly"],
                      "name": assembly_name(reference["assembly"]), "genome_id": reference["genome_id"],
                      "n_contigs": len(reference["contigs"]), "partial": reference["partial"]},
        "datasets": checks,
        "problems": [c for c in checks if c.get("severity") in ("warning", "error")],
        "suggestion": suggestion,
        "can_load_genomes": can_load,
        "has_gtf": transcripts is not None and len(transcripts) > 0,
    }


def fingerprint_of(check: dict) -> Fingerprint:
    """The Fingerprint behind a check's ``assembly`` dict (for ``_suggestion``)."""
    a = check.get("assembly") or {}
    return Fingerprint(assembly=a.get("assembly"), confidence=a.get("confidence") or "none",
                       kind=a.get("kind") or "unknown", naming=a.get("naming"))
