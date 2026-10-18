"""Assembly validation of a live-lift dataset, per source BAM (DESIGN_LIVE_LIFT.md §4).

Each BAM's header is read on its own (``genome_check.dataset_header`` merges
contigs across files and would hide a disagreement).

| check | result |
|---|---|
| source contigs of a selected haplotype present | none present -> refuse that haplotype; some absent -> info |
| ``size_inferred=false`` | LN must equal the manifest size |
| ``size_inferred=true`` | LN equal: ok; greater: info (end-clipped path); smaller: refuse |
| BAMs of one dataset disagree on LN | refuse |
| target names/sizes vs the main genome | size mismatch, or no target present -> refuse; some absent -> info |
| source already lifted (``graph_lift``) | warn |
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional


@dataclass
class LiftValidation:
    errors: list = field(default_factory=list)      # refuse the dataset
    warnings: list = field(default_factory=list)
    info: list = field(default_factory=list)
    haplotypes: list = field(default_factory=list)  # the selected haplotypes that passed
    anchors: dict = field(default_factory=lambda: {"status": "not checked", "message": "Anchor sequences not checked: both FASTAs are required."})

    @property
    def ok(self) -> bool:
        return not self.errors and bool(self.haplotypes)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings, "info": self.info,
                "haplotypes": self.haplotypes, "anchors": self.anchors}


def _bam_contigs(path, bam_handle_getter=None) -> dict:
    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter
    bam = bam_handle_getter(path)
    if bam is None:
        raise ValueError(f"cannot open {path}")
    return dict(zip(bam.references, bam.lengths)), bam.header


def validate_live_lift(handle, bam_paths: Iterable[str], haplotypes: Iterable[str], *,
                       target_sizes: Optional[dict] = None, bam_handle_getter=None,
                       target_fasta=None, source_fasta: Optional[str] = None) -> LiftValidation:
    """Check source BAMs against a sidecar and the main genome. ``target_sizes``:
    the main genome's contig sizes (None skips the target check)."""
    out = LiftValidation()
    manifest = handle.manifest
    sources = {s["name"]: s for s in manifest["sources"]}
    hap_sources: dict = {}
    for chain in manifest["chains"]:
        hap_sources.setdefault(chain["haplotype"], set()).add(manifest["sources"][chain["source"]]["name"])
    per_bam = {}
    for path in bam_paths:
        try:
            contigs, header = _bam_contigs(path, bam_handle_getter)
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            out.errors.append(f"{path}: {exc}")
            continue
        per_bam[path] = contigs
        try:
            from services.graph_lift import lift_hidden_predicate
            if lift_hidden_predicate(header) is not None:
                out.warnings.append(f"{path} was itself lifted from another assembly (graph lift); lifting it again "
                                    "composes two mappings.")
        except Exception:  # noqa: BLE001 - a warning only
            pass
    # Same contig, different lengths across the dataset's BAMs.
    lengths: dict = {}
    for path, contigs in per_bam.items():
        for name, ln in contigs.items():
            if name in sources:
                lengths.setdefault(name, {})[path] = ln
    for name, by_path in lengths.items():
        if len(set(by_path.values())) > 1:
            out.errors.append(f"The BAMs disagree on the length of {name}: "
                              + ", ".join(f"{p}: {ln:,}" for p, ln in sorted(by_path.items())))
    for hap in haplotypes:
        problems = []
        label = handle.haplotype_labels.get(hap, hap)
        names = sorted(hap_sources.get(hap, ()))
        for path, contigs in per_bam.items():
            present = [name for name in names if name in contigs]
            absent = sorted(set(names) - set(present))
            if not present:
                problems.append(f"{path}: the BAM has none of its {len(names)} source contigs "
                                f"(e.g. {names[0] if names else hap})")
            elif absent:
                out.info.append(f"{path}: haplotype {label}: {len(absent)} source contigs absent "
                                f"({', '.join(absent[:4])}).")
            for name in present:
                src = sources[name]
                size, ln = int(src.get("size") or 0), int(contigs[name])
                if not src.get("size_inferred") and ln != size:
                    problems.append(f"{name} is {ln:,} bp in {path} but {size:,} bp in the map")
                elif src.get("size_inferred") and ln < size:
                    problems.append(f"{name} is shorter in {path} ({ln:,} bp) than the map's path ({size:,} bp)")
                elif src.get("size_inferred") and ln > size:
                    out.info.append(f"{name}: {ln:,} bp in {path}, {size:,} bp in the map "
                                    "(the map's path is clipped at the end; positions past it have no correspondence).")
        if problems:
            out.errors.append(f"Haplotype {label} ({hap}): " + "; ".join(problems[:6])
                              + (f" (and {len(problems) - 6} more)" if len(problems) > 6 else ""))
        else:
            out.haplotypes.append(hap)
    if target_sizes is not None:
        mismatched, missing = [], []
        for target in manifest["targets"]:
            size = target.get("size")
            have = target_sizes.get(target["name"])
            if have is None:
                missing.append(target["name"])
            elif size is not None and int(have) != int(size):
                mismatched.append(f"{target['name']} ({int(have):,} bp here, {int(size):,} bp in the map)")
        if mismatched:
            out.errors.append("The map's target genome is not the main genome: " + ", ".join(mismatched[:6])
                              + (f" (and {len(mismatched) - 6} more)" if len(mismatched) > 6 else ""))
        if missing and len(missing) == len(manifest["targets"]):
            out.errors.append("None of the map's target contigs is in the main genome.")
        elif missing:
            out.info.append(f"{len(missing)} of the map's target contigs are not in the main genome "
                            f"({', '.join(missing[:5])}{'…' if len(missing) > 5 else ''}).")
    if not out.haplotypes and not out.errors:
        out.errors.append("No haplotype selected.")
    if target_fasta is not None and source_fasta:
        _check_anchors(handle, out, target_fasta, source_fasta)
    return out


def _check_anchors(handle, out, target_fasta, source_fasta):
    """Spot check up to 16 distributed anchor blocks (at least 200 bp).
    Chain blocks merge exact anchors with inferred fills. Subtract every
    inferred run before sampling exact spans for assembly identity checks.
    A tiny synthetic map can have fewer than 16; report the actual count.
    Neither a pass nor a skipped check claims proof of assembly identity.
    """
    import pysam
    import os
    from services.lift.compose import revcomp

    candidates = []
    try:
        for ci, chain in enumerate(handle.map.chains):
            if chain["haplotype"] not in out.haplotypes:
                continue
            blocks = handle.map.chain_data(ci)["blocks"]
            inferred = handle.map.inferred_runs(ci, chain["t_start"], chain["t_end"])
            j = 0
            for t, q, n, *_rest in blocks:
                pos = t
                while j < len(inferred) and inferred[j][0] + inferred[j][1] <= t:
                    j += 1
                k = j
                while k < len(inferred) and inferred[k][0] < t + n:
                    a, length, _kind = inferred[k]
                    if a - pos >= 200:
                        candidates.append((ci, pos, q + pos - t, a - pos))
                    pos = max(pos, a + length)
                    k += 1
                if t + n - pos >= 200:
                    candidates.append((ci, pos, q + pos - t, t + n - pos))
        if not candidates:
            out.anchors = {"status": "not checked", "message": "Anchor sequences not checked: no anchor blocks >= 200 bp."}
            return
        n = min(16, len(candidates))
        chosen = [candidates[i * (len(candidates) - 1) // max(1, n - 1)] for i in range(n)]
        # Open read-only: never build an index beside a user's reference.
        if not os.path.isfile(source_fasta + ".fai"):
            raise ValueError("source FASTA needs a .fai index (run samtools faidx first)")
        with pysam.FastaFile(source_fasta) as source:
            for ci, t, q, length in chosen:
                chain = handle.map.chains[ci]
                target_name = handle.manifest["targets"][chain["target"]]["name"]
                src = handle.manifest["sources"][chain["source"]]
                q0, q1 = (q, q + length) if chain["strand"] == "+" else (src["size"] - q - length, src["size"] - q)
                a = target_fasta.fetch(target_name, t, t + length).upper()
                b = source.fetch(src["name"], q0, q1).upper()
                if chain["strand"] == "-":
                    b = revcomp(b)
                if len(a) != length or len(b) != length or a != b:
                    message = (f"Anchor sequence mismatch: {target_name}:{t}-{t + length} and "
                               f"{src['name']}:{q0}-{q1} ({chain['strand']}) in {source_fasta}.")
                    out.errors.append(message)
                    out.anchors = {"status": "mismatch", "message": message}
                    return
        out.anchors = {"status": "consistent", "checked": n,
                       "message": f"Anchor sequences consistent ({n} blocks >= 200 bp checked); this is a spot check, not proof of assembly identity."}
    except (OSError, ValueError, KeyError) as exc:
        message = f"Cannot check anchor sequences in {source_fasta}: {exc}"
        out.errors.append(message)
        out.anchors = {"status": "error", "message": message}
