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


PLAIN_CHAIN_MIN_IDENTITY = 0.90


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
        # Open read-only: never build an index beside a user's reference.
        if not os.path.isfile(source_fasta + ".fai"):
            raise ValueError("source FASTA needs a .fai index (run samtools faidx first)")
        from services.lift.dataset import open_source_fasta
        with open_source_fasta(source_fasta) as source:
            # Only contigs both FASTAs hold (a reference or source FASTA of some chromosomes is fine), and only
            # anchors whose bases both know: an N-masked or partial assembly cannot fail on bases it lacks.
            target_names, source_names = set(target_fasta.references), set(source.references)
            candidates = [c for c in candidates
                          if handle.manifest["targets"][handle.map.chains[c[0]]["target"]]["name"] in target_names
                          and handle.manifest["sources"][handle.map.chains[c[0]]["source"]]["name"] in source_names]
            if not candidates:
                out.anchors = {"status": "not checked", "message": "Anchor sequences not checked: no anchor blocks >= 200 bp on contigs both FASTAs hold."}
                return
            # Up to 16 samples spread evenly over each haplotype's anchors (every haplotype is checked); an anchor
            # with unknown bases is replaced by the next one in its own bucket, never by one elsewhere.
            by_hap = {}
            for c in candidates:
                by_hap.setdefault(handle.map.chains[c[0]]["haplotype"], []).append(c)
            groups = list(by_hap.values())
            shares = [0] * len(groups)
            budget = 16
            while budget and any(shares[h] < len(g) for h, g in enumerate(groups)):   # round robin, spare to the rest
                for h, g in enumerate(groups):
                    if budget and shares[h] < len(g):
                        shares[h] += 1
                        budget -= 1
            buckets = []
            for group, k in zip(groups, shares):
                buckets += [group[i * len(group) // k:(i + 1) * len(group) // k] for i in range(k)]
            # Each bucket has its own retry budget, so N-masked anchors of one haplotype cannot use up another's.
            per_bucket = max(1, 4000 // max(1, len(buckets)))
            n, checked_haps = 0, set()
            plain = bool(getattr(handle, "plain_chain", False))
            for bucket in buckets:
                for ci, t, q, length in bucket[:per_bucket]:
                    length = min(length, 2000)
                    chain = handle.map.chains[ci]
                    target_name = handle.manifest["targets"][chain["target"]]["name"]
                    src = handle.manifest["sources"][chain["source"]]
                    q0, q1 = (q, q + length) if chain["strand"] == "+" else (src["size"] - q - length, src["size"] - q)
                    a = target_fasta.fetch(target_name, t, t + length).upper()
                    b = source.fetch(src["name"], q0, q1).upper()
                    if chain["strand"] == "-":
                        b = revcomp(b)
                    if "N" in a or "N" in b:
                        continue
                    n += 1
                    checked_haps.add(handle.map.chains[ci]["haplotype"])
                    # A plain UCSC chain cannot mark substitutions inside its aligned blocks (a sidecar's exact
                    # anchors exclude them), so its anchors are compared by identity rather than exact equality.
                    same = a == b if not plain else (len(a) == len(b) == length and
                                                     sum(x == y for x, y in zip(a, b)) >= PLAIN_CHAIN_MIN_IDENTITY * length)
                    if len(a) != length or len(b) != length or not same:
                        message = (f"Anchor sequence mismatch: {target_name}:{t}-{t + length} and "
                                   f"{src['name']}:{q0}-{q1} ({chain['strand']}) in {source_fasta}.")
                        out.errors.append(message)
                        out.anchors = {"status": "mismatch", "message": message}
                        return
                    break   # one checked anchor per bucket
        if not n:
            out.anchors = {"status": "not checked", "message": "Anchor sequences not checked: every sampled anchor has unknown (N) bases."}
            return
        unchecked = sorted(set(by_hap) - checked_haps)
        if unchecked:
            # Say which haplotypes the spot check could not reach (unknown bases or few anchors).
            out.warnings.append("Anchor sequences not checked for haplotype(s) " + ", ".join(unchecked)
                                + ": no sampled anchor with known bases in the source FASTA.")
        if plain:
            out.info.append(f"Plain chain: anchors compared at >= {PLAIN_CHAIN_MIN_IDENTITY:.0%} identity (chains do not mark substitutions).")
        out.anchors = {"status": "consistent", "checked": n, "unchecked_haplotypes": unchecked,
                       "message": f"Anchor sequences consistent ({n} blocks >= 200 bp checked); this is a spot check, not proof of assembly identity."}
    except (OSError, ValueError, KeyError) as exc:
        message = f"Cannot check anchor sequences in {source_fasta}: {exc}"
        out.errors.append(message)
        out.anchors = {"status": "error", "message": message}
