"""Materialize user-defined footprint classes into fiberlayers bundles."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from services.layer_aliases import normalize_annotation_layer


FIBERLAYERS_AUTOSQL = """table fiberbrowser_fiberlayers
"FiberBrowser derived per-read layer classes"
    (
    string chrom;        "Chromosome"
    uint chromStart;     "Start position"
    uint chromEnd;       "End position"
    string name;         "Read ID"
    uint score;          "Mean class confidence (0-1000)"
    char[1] strand;      "Strand"
    uint thickStart;     "Start position (same as chromStart)"
    uint thickEnd;       "End position (same as chromEnd)"
    string itemRgb;      "Class color"
    int blockCount;      "Number of intervals in this class/read row"
    int[blockCount] blockSizes;   "Interval sizes"
    int[blockCount] chromStarts;  "Interval starts relative to chromStart"
    string class_id;     "Stable derived layer class ID"
    string source_layer; "Native/source layer used to define the class"
    string rule_id;      "Cart/rule ID that produced this row"
    string blockQuality; "Comma-separated 0-255 confidence values, or ."
    )
"""


@dataclass(frozen=True)
class SourceInterval:
    start: int
    end: int
    size: int
    quality: Optional[int] = None
    family_id: int = 0
    family_confidence: int = 0
    family_confidence_kind: Optional[str] = None


@dataclass(frozen=True)
class DerivedClass:
    class_id: str
    label: str
    source_layer: str
    color: str
    rule_id: str
    rules: dict[str, Any]
    group_index: int


@dataclass
class MaterializedRow:
    chrom: str
    read_id: str
    class_id: str
    source_layer: str
    rule_id: str
    color: str
    intervals: list[SourceInterval] = field(default_factory=list)

    @property
    def start(self) -> int:
        return min(iv.start for iv in self.intervals)

    @property
    def end(self) -> int:
        return max(iv.end for iv in self.intervals)

    @property
    def block_sizes(self) -> list[int]:
        return [max(0, iv.end - iv.start) for iv in self.intervals]

    @property
    def block_starts(self) -> list[int]:
        row_start = self.start
        return [iv.start - row_start for iv in self.intervals]

    @property
    def qualities(self) -> list[int]:
        return [iv.quality for iv in self.intervals if iv.quality is not None]

    @property
    def score(self) -> int:
        qualities = self.qualities
        if not qualities:
            return 0
        return max(0, min(1000, round(sum(qualities) / len(qualities) * 1000 / 255)))

    def to_bed_fields(self) -> list[str]:
        row_start = self.start
        row_end = self.end
        block_qualities = (
            ",".join(str(max(0, min(255, int(iv.quality)))) for iv in self.intervals)
            if all(iv.quality is not None for iv in self.intervals)
            else "."
        )
        return [
            self.chrom,
            str(row_start),
            str(row_end),
            _bed_field(self.read_id),
            str(self.score),
            ".",
            str(row_start),
            str(row_end),
            _rgb_string(self.color),
            str(len(self.intervals)),
            _comma_list(self.block_sizes),
            _comma_list(self.block_starts),
            _bed_field(self.class_id),
            _bed_field(self.source_layer),
            _bed_field(self.rule_id),
            block_qualities,
        ]


@dataclass
class BundleResult:
    dataset_id: str
    dataset_label: str
    manifest_path: str
    bed_path: str
    autosql_path: str
    chrom_sizes_path: str
    bigbed_path: Optional[str]
    n_rows: int
    n_intervals: int
    classes: list[dict[str, Any]]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "dataset_label": self.dataset_label,
            "manifest_path": self.manifest_path,
            "bed_path": self.bed_path,
            "autosql_path": self.autosql_path,
            "chrom_sizes_path": self.chrom_sizes_path,
            "bigbed_path": self.bigbed_path,
            "n_rows": self.n_rows,
            "n_intervals": self.n_intervals,
            "classes": self.classes,
            "warnings": self.warnings,
        }


def materialize_derived_layer_bundles(
    *,
    state,
    query,
    groups: list[dict[str, Any]],
    output_dir: str,
    bundle_name: Optional[str] = None,
    browser_commit: Optional[str] = None,
    genome: Optional[str] = None,
) -> list[BundleResult]:
    """Write one `.fiberlayers` bundle per dataset in the query."""
    from services.lab.paths import confine
    confine(output_dir, write=True)  # a lab server: only in a writable data root
    os.makedirs(output_dir, exist_ok=True)
    active_groups = _active_groups(groups)
    if not active_groups:
        raise ValueError("No enabled cart entries to export")

    class_defs = _class_definitions(active_groups)
    requested_layers = _requested_layers(class_defs)
    include_layer_payload = any(cls.source_layer not in {"footprint", "primary"} for cls in class_defs)
    output_base = _slug(bundle_name or f"fiberlayers_{query.chrom}_{query.start}_{query.end}")
    multi_dataset = len(query.dataset_ids) > 1

    results: list[BundleResult] = []
    for dataset_id in query.dataset_ids:
        dataset = state.get_dataset(dataset_id)
        if dataset is None:
            continue

        ws = query.build_working_set(
            state,
            dataset_id,
            include_methylation=False,
            include_layers=include_layer_payload,
            requested_layers=requested_layers,
        )
        reads = query.cap_reads(ws.reads, namespace="fiberlayers", label=f"{dataset_id}:{query.chrom}")

        rows, stats = _materialized_rows_for_reads(
            chrom=query.chrom,
            region_start=query.start,
            reads=reads,
            classes=class_defs,
        )
        if not rows:
            results.append(_empty_result(
                dataset=dataset,
                dataset_id=dataset_id,
                output_dir=output_dir,
                output_base=output_base,
                multi_dataset=multi_dataset,
                classes=class_defs,
                warning="No intervals matched the enabled cart entries",
            ))
            continue

        base = output_base
        if multi_dataset:
            base = f"{output_base}.{_slug(dataset.label or dataset_id)}"
        base = _dedupe_base(output_dir, base)

        bed_path = os.path.join(output_dir, f"{base}.fiberlayers.bed")
        autosql_path = os.path.join(output_dir, f"{base}.fiberlayers.as")
        chrom_sizes_path = os.path.join(output_dir, f"{base}.chrom.sizes")
        bigbed_path = os.path.join(output_dir, f"{base}.fiberlayers.bb")
        manifest_path = os.path.join(output_dir, f"{base}.fiberlayers.json")

        _write_bed(rows, bed_path)
        _write_autosql(autosql_path)
        _write_chrom_sizes(state, query.chrom, max(row.end for row in rows), chrom_sizes_path)
        converted, conversion_warning = _convert_to_bigbed(bed_path, chrom_sizes_path, autosql_path, bigbed_path)

        manifest = _manifest_for_bundle(
            dataset=dataset,
            classes=class_defs,
            stats=stats,
            query=query,
            genome=genome,
            files={
                "bigbed": os.path.basename(bigbed_path) if converted else None,
                "bed": os.path.basename(bed_path),
                "autosql": os.path.basename(autosql_path),
                "chrom_sizes": os.path.basename(chrom_sizes_path),
            },
            browser_commit=browser_commit,
        )
        _write_json(manifest, manifest_path)

        result_warnings = []
        if conversion_warning:
            result_warnings.append(conversion_warning)
        results.append(BundleResult(
            dataset_id=dataset_id,
            dataset_label=dataset.label,
            manifest_path=manifest_path,
            bed_path=bed_path,
            autosql_path=autosql_path,
            chrom_sizes_path=chrom_sizes_path,
            bigbed_path=bigbed_path if converted else None,
            n_rows=len(rows),
            n_intervals=sum(len(row.intervals) for row in rows),
            classes=[_class_manifest_entry(c) for c in class_defs],
            warnings=result_warnings,
        ))

    return results


def _active_groups(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(group) for group in groups if group.get("enabled", True)]


def _class_definitions(groups: list[dict[str, Any]]) -> list[DerivedClass]:
    used_ids: set[str] = set()
    classes: list[DerivedClass] = []
    for idx, group in enumerate(groups):
        label = str(group.get("name") or f"Cart entry {idx + 1}").strip() or f"Cart entry {idx + 1}"
        raw_id = group.get("derivedLayerId") or group.get("derived_layer_id")
        if raw_id:
            class_id = _stable_identifier(str(raw_id), fallback=f"cart_{idx + 1}")
        else:
            digest = hashlib.sha1(str(group.get("id") or label).encode("utf-8")).hexdigest()[:8]
            class_id = _stable_identifier(f"{label}_{digest}", fallback=f"cart_{idx + 1}")
        base_id = class_id
        suffix = 2
        while class_id in used_ids:
            class_id = f"{base_id}_{suffix}"
            suffix += 1
        used_ids.add(class_id)

        source_layer = _source_layer(group)
        classes.append(DerivedClass(
            class_id=class_id,
            label=label,
            source_layer=source_layer,
            color=str(group.get("color") or "#2f9e44"),
            rule_id=str(group.get("id") or class_id),
            rules=_rules_from_group(group, source_layer),
            group_index=idx,
        ))
    return classes


def _requested_layers(classes: Iterable[DerivedClass]) -> Optional[tuple[str, ...]]:
    layers: set[str] = set()
    for cls in classes:
        if cls.source_layer in {"footprint", "primary"}:
            continue
        if cls.source_layer == "all_fp":
            return None
        layers.add(cls.source_layer)
        if cls.source_layer == "fire":
            layers.add("msp")
        elif cls.source_layer == "msp":
            layers.add("fire")
    return tuple(sorted(layers))


def _source_layer(group: dict[str, Any]) -> str:
    layer = normalize_annotation_layer(group.get("layer"))
    if layer is None or layer == "":
        return "footprint"
    if layer == "all_fp":
        return "all_fp"
    return layer


def _rules_from_group(group: dict[str, Any], source_layer: str) -> dict[str, Any]:
    keys = [
        "sizeMin",
        "sizeMax",
        "referenceAbsStart",
        "referenceAbsEnd",
        "minFpCoverage",
        "minTargetCoverage",
        "overlapMode",
        "overlapFraction",
        "conditions",
        "familyId",
        "minFamilyConfidence",
    ]
    rules = {key: group.get(key) for key in keys if key in group}
    rules["source_layer"] = source_layer
    return rules


def _materialized_rows_for_reads(
    *,
    chrom: str,
    region_start: int,
    reads: list[dict[str, Any]],
    classes: list[DerivedClass],
) -> tuple[list[MaterializedRow], dict[str, dict[str, int]]]:
    rows: list[MaterializedRow] = []
    stats = {
        cls.class_id: {"reads": 0, "intervals": 0}
        for cls in classes
    }

    for read in reads:
        read_id = str(read.get("id", ""))
        if not read_id:
            continue
        for cls in classes:
            intervals = [
                iv for iv in _source_intervals(read, cls.source_layer, region_start)
                if _interval_matches_rules(iv, cls.rules)
            ]
            if not intervals:
                continue
            if cls.rules.get("familyId") is not None:
                # Ordinary family rows expose assignment confidence (`fq`).
                # Named fhlt rows retain their selected-configuration quality
                # (`q0`): their `fq` is equal-prior identity, a different
                # calibration that must not be silently relabeled.
                intervals = [
                    replace(iv, quality=iv.family_confidence)
                    if iv.family_confidence_kind == "assignment" else iv
                    for iv in intervals
                ]
            intervals.sort(key=lambda iv: (iv.start, iv.end))
            rows.append(MaterializedRow(
                chrom=chrom,
                read_id=read_id,
                class_id=cls.class_id,
                source_layer=cls.source_layer,
                rule_id=cls.rule_id,
                color=cls.color,
                intervals=intervals,
            ))
            stats[cls.class_id]["reads"] += 1
            stats[cls.class_id]["intervals"] += len(intervals)

    rows.sort(key=lambda row: (row.chrom, row.start, row.end, row.read_id, row.class_id))
    return rows, stats


def _source_intervals(read: dict[str, Any], source_layer: str, region_start: int) -> list[SourceInterval]:
    if source_layer in {"footprint", "primary"}:
        return _primary_intervals(read, region_start)
    if source_layer == "nuc":
        layer = (read.get("layers") or {}).get("nuc")
        if layer:
            return _layer_intervals(layer, region_start)
        return _primary_intervals(read, region_start)
    if source_layer == "all_fp":
        out: list[SourceInterval] = []
        for layer_name, layer in (read.get("layers") or {}).items():
            if layer_name in {"msp", "fire", "m6a", "m5c", "deam"}:
                continue
            # A mixed-layer export is bounded to the displayed request. This
            # makes baseline and consensus copies comparable even when an SR
            # layer retains an unclipped source interval at a viewport edge.
            out.extend(_layer_intervals(layer, region_start, use_source_bounds=False))
        # BED12 blocks may not overlap. Exact baseline/consensus copies prefer
        # the family-bearing representation; any residual cross-layer overlap
        # is exported as its occupied union.
        return _coalesce_overlapping_intervals(_dedupe_intervals(out))

    layers = read.get("layers") or {}
    layer = layers.get(source_layer)
    if not layer and source_layer == "fire":
        layer = layers.get("msp")
    elif not layer and source_layer == "msp":
        layer = layers.get("fire")
    if layer:
        return _layer_intervals(layer, region_start)

    if source_layer == "fire" and read.get("fire"):
        out = []
        for iv in read.get("fire") or []:
            if len(iv) < 2:
                continue
            start = region_start + int(iv[0])
            end = region_start + int(iv[1])
            quality = _normalize_quality(iv[2]) if len(iv) >= 3 else None
            out.append(SourceInterval(start, end, max(0, end - start), quality))
        return out

    return []


def _primary_intervals(read: dict[str, Any], region_start: int) -> list[SourceInterval]:
    qualities = read.get("qualities") or []
    out: list[SourceInterval] = []
    positive_idx = 0
    for iv in read.get("intervals") or []:
        if len(iv) < 3:
            continue
        size = int(iv[2])
        if size <= 0:
            continue
        quality = _normalize_quality(qualities[positive_idx]) if positive_idx < len(qualities) else None
        positive_idx += 1
        start = region_start + int(iv[0])
        end = region_start + int(iv[1])
        if end > start:
            out.append(SourceInterval(start, end, size, quality))
    return out


def _layer_intervals(
    layer: dict[str, Any],
    region_start: int,
    *,
    use_source_bounds: bool = True,
) -> list[SourceInterval]:
    intervals = (
        (layer.get("source_intervals") or layer.get("intervals") or [])
        if use_source_bounds
        else (layer.get("intervals") or layer.get("source_intervals") or [])
    )
    quality_values = _preferred_quality_values(layer)
    family_ids = _named_quality_values(layer, "fi")
    family_confidences = _named_quality_values(layer, "fq")
    annotation_names = layer.get("annotation_names") or []
    out: list[SourceInterval] = []
    for idx, iv in enumerate(intervals):
        if len(iv) < 3:
            continue
        size = int(iv[2])
        if size <= 0:
            continue
        start = region_start + int(iv[0])
        end = region_start + int(iv[1])
        if end <= start:
            continue
        quality = _normalize_quality(quality_values[idx]) if idx < len(quality_values) else None
        family_id = _normalize_quality(family_ids[idx]) if idx < len(family_ids) else None
        family_confidence = (
            _normalize_quality(family_confidences[idx])
            if idx < len(family_confidences) else None
        )
        annotation_name = str(annotation_names[idx]) if idx < len(annotation_names) else ""
        family_confidence_kind = None
        if family_id:
            family_confidence_kind = (
                "latent-support" if annotation_name.lower().startswith("fhlt_") else "assignment"
            )
        out.append(SourceInterval(
            start,
            end,
            size,
            quality,
            family_id or 0,
            family_confidence or 0,
            family_confidence_kind,
        ))
    return out


def _named_quality_values(layer: dict[str, Any], quality_name: str) -> list[Any]:
    qualities = layer.get("qualities") or []
    qnames = layer.get("quality_names") or []
    if quality_name not in qnames:
        return []
    idx = qnames.index(quality_name)
    return (qualities[idx] or []) if idx < len(qualities) else []


def _preferred_quality_values(layer: dict[str, Any]) -> list[Any]:
    qualities = layer.get("qualities") or []
    qnames = layer.get("quality_names") or []
    if not qualities:
        return []
    for preferred in ("confidence", "tq", "aq", "nq", "mq", "ml"):
        if preferred in qnames:
            idx = qnames.index(preferred)
            if idx < len(qualities):
                return qualities[idx] or []
    return qualities[0] or []


def _dedupe_intervals(intervals: list[SourceInterval]) -> list[SourceInterval]:
    by_geometry: dict[tuple[int, int], SourceInterval] = {}
    for iv in intervals:
        key = (iv.start, iv.end)
        current = by_geometry.get(key)
        if current is None:
            by_geometry[key] = iv
            continue
        current_priority = (
            current.family_id > 0,
            current.family_confidence_kind is not None,
            current.family_confidence,
            current.quality if current.quality is not None else -1,
        )
        candidate_priority = (
            iv.family_id > 0,
            iv.family_confidence_kind is not None,
            iv.family_confidence,
            iv.quality if iv.quality is not None else -1,
        )
        if candidate_priority > current_priority:
            by_geometry[key] = iv
    return list(by_geometry.values())


def _coalesce_overlapping_intervals(intervals: list[SourceInterval]) -> list[SourceInterval]:
    """Return a BED12-safe occupied union of possibly overlapping layers."""
    ordered = sorted(intervals, key=lambda iv: (iv.start, iv.end, iv.size))
    if not ordered:
        return []
    out = [ordered[0]]
    for iv in ordered[1:]:
        current = out[-1]
        if iv.start >= current.end:
            out.append(iv)
            continue
        end = max(current.end, iv.end)
        quality_values = [value for value in (current.quality, iv.quality) if value is not None]
        same_family = (
            current.family_id > 0
            and current.family_id == iv.family_id
            and current.family_confidence_kind == iv.family_confidence_kind
        )
        out[-1] = SourceInterval(
            start=current.start,
            end=end,
            size=end - current.start,
            quality=max(quality_values) if quality_values else None,
            family_id=current.family_id if same_family else 0,
            family_confidence=(
                max(current.family_confidence, iv.family_confidence) if same_family else 0
            ),
            family_confidence_kind=current.family_confidence_kind if same_family else None,
        )
    return out


def _interval_matches_rules(iv: SourceInterval, rules: dict[str, Any]) -> bool:
    size_min = int(rules.get("sizeMin") or 0)
    raw_size_max = rules.get("sizeMax")
    size_max = int(raw_size_max) if raw_size_max is not None else None
    if size_min > 0 and iv.size < size_min:
        return False
    if size_max is not None and iv.size > size_max:
        return False

    raw_family_id = rules.get("familyId")
    if raw_family_id is not None:
        if iv.family_id != int(raw_family_id):
            return False
    min_family_confidence = max(
        0.0,
        min(1.0, float(rules.get("minFamilyConfidence") or 0.0)),
    )
    if min_family_confidence > 0:
        if iv.family_confidence_kind != "assignment":
            return False
        if iv.family_confidence / 255.0 < min_family_confidence:
            return False

    ref_start = rules.get("referenceAbsStart")
    ref_end = rules.get("referenceAbsEnd")
    if ref_start is None or ref_end is None:
        return True

    ref_start = int(ref_start)
    ref_end = int(ref_end)
    if ref_end <= ref_start:
        return True

    overlap_start = max(iv.start, ref_start)
    overlap_end = min(iv.end, ref_end)
    if overlap_end <= overlap_start:
        return False

    min_fp_cov = float(rules.get("minFpCoverage") or 0.0)
    min_tgt_cov = float(rules.get("minTargetCoverage") or 0.0)
    if min_fp_cov == 0.0 and min_tgt_cov == 0.0:
        legacy_mode = rules.get("overlapMode")
        legacy_fraction = float(rules.get("overlapFraction") or 0.0)
        if legacy_mode == "contains_target":
            min_tgt_cov = 1.0
        elif legacy_mode == "contained_by_target":
            min_fp_cov = 1.0
        elif legacy_mode == "fraction" and legacy_fraction > 0:
            min_fp_cov = legacy_fraction
            min_tgt_cov = legacy_fraction
        elif legacy_fraction > 0:
            min_fp_cov = legacy_fraction
            min_tgt_cov = legacy_fraction

    overlap_len = overlap_end - overlap_start
    if min_fp_cov > 0 and overlap_len < min_fp_cov * max(1, iv.size):
        return False
    if min_tgt_cov > 0 and overlap_len < min_tgt_cov * max(1, ref_end - ref_start):
        return False
    return True


def _manifest_for_bundle(
    *,
    dataset,
    classes: list[DerivedClass],
    stats: dict[str, dict[str, int]],
    query,
    genome: Optional[str],
    files: dict[str, Optional[str]],
    browser_commit: Optional[str],
) -> dict[str, Any]:
    return {
        "schema": "fiberlayers.v1",
        "files": files,
        "source_dataset": {
            "id": dataset.id,
            "label": dataset.label,
            "path": dataset.path,
            "paths": list(getattr(dataset, "paths", []) or []),
            "fingerprint": _dataset_fingerprint(dataset.path),
            "genome": genome,
        },
        "classes": {
            cls.class_id: _class_manifest_entry(cls)
            for cls in classes
        },
        "scope": {
            "regions": [f"{query.chrom}:{query.start}-{query.end}"],
            "genomewide": False,
            "spanning": bool(query.spanning),
        },
        "provenance": {
            "browser_commit": browser_commit,
            "sampling_seed": query.sample_seed,
            "analysis_cap": query.max_reads,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "exporter": "FiberBrowser",
        },
        "statistics": {
            "classes": stats,
        },
    }


def _class_manifest_entry(cls: DerivedClass) -> dict[str, Any]:
    return {
        "id": cls.class_id,
        "label": cls.label,
        "source_layer": cls.source_layer,
        "kind": "footprint_class",
        "color": cls.color,
        "rules": cls.rules,
        "version": 1,
    }


def _write_bed(rows: list[MaterializedRow], path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write("\t".join(row.to_bed_fields()))
            handle.write("\n")


def _write_autosql(path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(FIBERLAYERS_AUTOSQL)


def _write_chrom_sizes(state, chrom: str, min_size: int, path: str) -> None:
    sizes = {
        c.name: int(c.size)
        for c in getattr(state, "chroms", []) or []
        if getattr(c, "name", None)
    }
    sizes[chrom] = max(int(sizes.get(chrom, 0)), int(min_size))
    with open(path, "w", encoding="utf-8") as handle:
        for name, size in sorted(sizes.items()):
            handle.write(f"{name}\t{size}\n")


def _write_json(payload: dict[str, Any], path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def _convert_to_bigbed(bed_path: str, chrom_sizes_path: str, autosql_path: str, bigbed_path: str) -> tuple[bool, Optional[str]]:
    bed_to_bigbed = shutil.which("bedToBigBed")
    if not bed_to_bigbed:
        return False, "bedToBigBed not found; wrote BED/JSON only"

    cmd = [
        bed_to_bigbed,
        "-type=bed12+4",
        f"-as={autosql_path}",
        bed_path,
        chrom_sizes_path,
        bigbed_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except Exception as exc:
        return False, f"bedToBigBed failed to run: {exc}"
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "unknown error").strip()
        return False, f"bedToBigBed failed: {err}"
    return True, None


def _empty_result(
    *,
    dataset,
    dataset_id: str,
    output_dir: str,
    output_base: str,
    multi_dataset: bool,
    classes: list[DerivedClass],
    warning: str,
) -> BundleResult:
    base = output_base
    if multi_dataset:
        base = f"{output_base}.{_slug(dataset.label or dataset_id)}"
    return BundleResult(
        dataset_id=dataset_id,
        dataset_label=dataset.label,
        manifest_path=os.path.join(output_dir, f"{base}.fiberlayers.json"),
        bed_path=os.path.join(output_dir, f"{base}.fiberlayers.bed"),
        autosql_path=os.path.join(output_dir, f"{base}.fiberlayers.as"),
        chrom_sizes_path=os.path.join(output_dir, f"{base}.chrom.sizes"),
        bigbed_path=None,
        n_rows=0,
        n_intervals=0,
        classes=[_class_manifest_entry(c) for c in classes],
        warnings=[warning],
    )


def _dedupe_base(output_dir: str, base: str) -> str:
    candidate = base
    suffix = 2
    while any(os.path.exists(os.path.join(output_dir, f"{candidate}{ext}")) for ext in (
        ".fiberlayers.json",
        ".fiberlayers.bb",
        ".fiberlayers.bed",
    )):
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def _dataset_fingerprint(path: str) -> Optional[str]:
    if not path or "://" in str(path):
        return None
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return f"stat:{stat.st_size}:{stat.st_mtime_ns}"


def _stable_identifier(value: str, fallback: str) -> str:
    slug = _slug(value, lower=True)
    if not slug:
        slug = fallback
    if not re.match(r"^[A-Za-z_]", slug):
        slug = f"layer_{slug}"
    return slug


def _slug(value: str, *, lower: bool = False) -> str:
    text = str(value or "").strip()
    if lower:
        text = text.lower()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_.-")
    return text or "fiberlayers"


def _bed_field(value: Any) -> str:
    return str(value).replace("\t", "_").replace("\n", "_").replace("\r", "_") or "."


def _comma_list(values: Iterable[int]) -> str:
    return ",".join(str(int(v)) for v in values) + ","


def _rgb_string(color: str) -> str:
    text = str(color or "").strip()
    if text.startswith("#") and len(text) == 7:
        try:
            r = int(text[1:3], 16)
            g = int(text[3:5], 16)
            b = int(text[5:7], 16)
            return f"{r},{g},{b}"
        except ValueError:
            pass
    if re.match(r"^\d+,\d+,\d+$", text):
        return text
    return "47,158,68"


def _normalize_quality(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if isinstance(value, float) and 0 <= numeric <= 1:
        numeric *= 255
    return max(0, min(255, int(round(numeric))))
