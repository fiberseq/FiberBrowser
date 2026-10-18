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

    @property
    def ok(self) -> bool:
        return not self.errors and bool(self.haplotypes)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings, "info": self.info,
                "haplotypes": self.haplotypes}


def _bam_contigs(path, bam_handle_getter=None) -> dict:
    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter
    bam = bam_handle_getter(path)
    if bam is None:
        raise ValueError(f"cannot open {path}")
    return dict(zip(bam.references, bam.lengths)), bam.header


def validate_live_lift(handle, bam_paths: Iterable[str], haplotypes: Iterable[str], *,
                       target_sizes: Optional[dict] = None, bam_handle_getter=None) -> LiftValidation:
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
        problems, absent, present = [], [], 0
        for name in sorted(hap_sources.get(hap, ())):
            src = sources[name]
            size = int(src.get("size") or 0)
            for path, contigs in per_bam.items():
                if name not in contigs:
                    absent.append(name)
                    continue
                present += 1
                ln = int(contigs[name])
                if not src.get("size_inferred"):
                    if ln != size:
                        problems.append(f"{name} is {ln:,} bp in {path} but {size:,} bp in the map")
                elif ln > size:
                    out.info.append(f"{name}: {ln:,} bp in {path}, {size:,} bp in the map (the map's path is "
                                    "clipped at the end; positions past it have no correspondence).")
                elif ln < size:
                    problems.append(f"{name} is shorter in {path} ({ln:,} bp) than the map's path ({size:,} bp)")
        label = handle.haplotype_labels.get(hap, hap)
        if per_bam and not present:
            problems.append(f"the BAM has none of its {len(hap_sources.get(hap, ()))} source contigs "
                            f"(e.g. {sorted(hap_sources.get(hap, ()))[0]})")
        elif absent:
            out.info.append(f"Haplotype {label}: {len(set(absent))} of its source contigs are not in the BAM "
                            f"({', '.join(sorted(set(absent))[:4])}{'…' if len(set(absent)) > 4 else ''}).")
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
    return out
