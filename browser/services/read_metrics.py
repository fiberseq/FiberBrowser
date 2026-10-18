"""Read-level sampling and metaprofile helpers.

These functions operate on compact read dictionaries and do not depend on
FastAPI state, file handles, or the server module.
"""
from __future__ import annotations

import heapq
import hashlib
from bisect import bisect_left, bisect_right
from typing import Optional

import numpy as np


DEFAULT_SAMPLE_SEED = "fiberbrowser-analysis"


def normalize_sample_seed(seed: Optional[str]) -> str:
    """Return the canonical user-visible sampling seed."""
    return (seed or DEFAULT_SAMPLE_SEED).strip() or DEFAULT_SAMPLE_SEED


def fill_small_gaps_in_read(read: dict, min_gap_size: int) -> dict:
    """Merge small internal gaps between footprint intervals."""
    intervals = read.get("intervals", [])
    if len(intervals) < 3:
        return read

    merged = []
    i = 0
    while i < len(intervals):
        curr = intervals[i]
        curr_start, curr_end, curr_size = curr

        if curr_size > 0:
            merged_start = curr_start
            merged_end = curr_end
            total_size = curr_size

            j = i + 1
            while j < len(intervals):
                next_start, next_end, next_size = intervals[j]
                # Only contiguous intervals join: a hole (a deletion the
                # loader split the calls at, services/sv_events.py) is a barrier.
                if next_start != merged_end:
                    break
                if next_size < 0:
                    gap_size = abs(next_size)
                    if j + 1 < len(intervals) and intervals[j + 1][2] > 0 and intervals[j + 1][0] == next_end:
                        if gap_size < min_gap_size:
                            merged_end = next_end
                            j += 1
                            continue
                        break
                    break

                merged_end = next_end
                total_size += next_size
                j += 1

            merged.append([merged_start, merged_end, total_size])
            i = j
        else:
            merged.append(curr)
            i += 1

    return {**read, "intervals": merged}


def compact_reads_to_dataframe(compact_reads, region_start, region_end):
    """Convert compact interval reads to a coarse per-position DataFrame."""
    import pandas as pd

    if not compact_reads:
        return pd.DataFrame()

    step = 10
    positions = list(range(region_start, region_end, step))

    rows = []
    read_ids = []
    for read in compact_reads:
        read_id = read["id"]
        read_ids.append(read_id)

        row = np.full(len(positions), 2, dtype=np.float32)
        for interval_start, interval_end, size in read["intervals"]:
            if size <= 0:
                continue

            abs_start = region_start + interval_start
            abs_end = region_start + interval_end
            start_idx = max(0, (abs_start - region_start) // step)
            end_idx = min(len(positions), (abs_end - region_start) // step + 1)
            row[start_idx:end_idx] = size

        rows.append(row)

    df = pd.DataFrame(rows, columns=positions)
    df["read_id"] = read_ids
    return df


def read_covers_regions(read: dict, regions: list) -> bool:
    """Return True when a compact read fully covers every target region."""
    intervals = read.get("intervals") or []
    if not regions:
        return True
    if not intervals:
        return False

    targets = [(int(left), int(right)) for left, right in regions if right > left]
    if not targets:
        return True

    spans = sorted(
        (int(iv[0]), int(iv[1]))
        for iv in intervals
        if len(iv) >= 2 and iv[1] > iv[0]
    )
    if not spans:
        return False

    for target_start, target_end in targets:
        cursor = target_start
        for span_start, span_end in spans:
            if span_end <= cursor:
                continue
            if span_start > cursor:
                return False
            cursor = max(cursor, span_end)
            if cursor >= target_end:
                break
        if cursor < target_end:
            return False

    return True


def filter_reads_covering_regions(reads: list, regions: list) -> list:
    """Filter compact reads to those fully covering every target region."""
    if not regions:
        return reads
    return [read for read in reads if read_covers_regions(read, regions)]


def sample_stable_by_id(reads: list, n: int, seed: str = DEFAULT_SAMPLE_SEED) -> list:
    """Deterministically sample reads by hashing read IDs.

    This is intended for analysis downsampling. Unlike coverage-priority display
    sampling, it avoids systematically favoring longer/high-coverage reads and
    gives stable cluster-ratio estimates for repeated requests.
    """
    if len(reads) <= n:
        return reads
    if n <= 0:
        return []

    def stable_key(item):
        idx, read = item
        read_id = str(read.get("analysis_id") or read.get("id", idx))
        digest = hashlib.blake2b(f"{seed}:{read_id}".encode(), digest_size=8).digest()
        return digest, read_id, idx

    ranked = sorted(enumerate(reads), key=stable_key)
    return [read for _, read in ranked[:n]]


def stable_seed_int(seed: str, *parts: object, bits: int = 31) -> int:
    """Convert a user seed + context into a process-stable integer seed."""
    normalized = normalize_sample_seed(seed)
    payload = ":".join([normalized, *(str(part) for part in parts)])
    digest = hashlib.blake2b(payload.encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") % (2 ** bits)


def random_state_from_seed(seed: Optional[str], *parts: object, default: int = 42) -> int:
    """Derive a sklearn-compatible random_state from the shared sample seed.

    The canonical default seed preserves the historical random_state=42 so the
    branch remains behavior-compatible until a user explicitly changes the seed.
    """
    normalized = normalize_sample_seed(seed)
    if normalized == DEFAULT_SAMPLE_SEED:
        return int(default)
    return stable_seed_int(normalized, *parts)


def sample_by_coverage(reads: list, n: int, region_start: int, region_end: int) -> list:
    """Sample reads prioritizing maximum coverage of the region."""
    if len(reads) <= n:
        return reads

    region_width = region_end - region_start
    if region_width <= 0:
        return reads[:n]

    def read_coverage(read):
        intervals = read.get("intervals")
        if not intervals:
            return 0
        read_start = intervals[0][0] + region_start
        read_end = intervals[-1][1] + region_start
        overlap_start = max(read_start, region_start)
        overlap_end = min(read_end, region_end)
        if overlap_end <= overlap_start:
            return 0
        return (overlap_end - overlap_start) / region_width

    return heapq.nlargest(n, reads, key=read_coverage)


def compute_metaprofile_from_compact_reads(
    reads: list,
    region_width: int,
    min_size: int,
    max_size: int,
    layer: Optional[str] = None,
) -> np.ndarray:
    """Compute coverage-normalized footprint density from compact reads."""
    profile = np.zeros(region_width)
    coverage = np.zeros(region_width)

    all_starts = []
    all_ends = []
    all_sizes = []
    cov_starts = []
    cov_ends = []

    for read in reads:
        primary_intervals = read.get("intervals")
        if not primary_intervals:
            continue

        read_start = primary_intervals[0][0]
        read_end = primary_intervals[-1][1]
        s_cov = max(0, read_start)
        e_cov = min(region_width, read_end)
        if e_cov > s_cov:
            cov_starts.append(s_cov)
            cov_ends.append(e_cov)

        profile_intervals = get_layer_intervals(read, layer) if layer else primary_intervals

        for interval in profile_intervals:
            if len(interval) < 2:
                continue
            all_starts.append(interval[0])
            all_ends.append(interval[1])
            all_sizes.append(interval[2] if len(interval) >= 3 else interval[1] - interval[0])

    if cov_starts:
        cov_s = np.array(cov_starts, dtype=np.intp)
        cov_e = np.array(cov_ends, dtype=np.intp)
        cov_diff = np.zeros(region_width + 1)
        np.add.at(cov_diff, cov_s, 1)
        np.add.at(cov_diff, cov_e, -1)
        coverage = np.cumsum(cov_diff[:region_width])

    if all_starts:
        starts = np.array(all_starts, dtype=np.intp)
        ends = np.array(all_ends, dtype=np.intp)
        sizes = np.array(all_sizes, dtype=np.intp)

        mask = (sizes > 0) & (sizes >= min_size) & (sizes <= max_size)
        fp_starts = np.clip(starts[mask], 0, region_width)
        fp_ends = np.clip(ends[mask], 0, region_width)
        valid = fp_ends > fp_starts

        if np.any(valid):
            fp_s = fp_starts[valid]
            fp_e = fp_ends[valid]
            fp_diff = np.zeros(region_width + 1)
            np.add.at(fp_diff, fp_s, 1)
            np.add.at(fp_diff, fp_e, -1)
            profile = np.cumsum(fp_diff[:region_width])

    coverage[coverage == 0] = 1
    return profile / coverage


def midpoint_in_regions(abs_midpoint: int, regions: list) -> bool:
    """Return True when an absolute coordinate falls within any region."""
    for r_start, r_end in regions:
        if r_start <= abs_midpoint < r_end:
            return True
    return False


def _get_interval_index(container: dict):
    """Return cached interval starts/ends compatible with working-set projection."""
    intervals = container.get("intervals") or []
    cached = container.get("_fiberbrowser_interval_index")
    cache_key = (id(intervals), len(intervals))
    if cached and cached[0] == cache_key:
        return intervals, cached[1], cached[2]

    starts = []
    ends = []
    positive_prefix = [0]
    positive_count = 0
    for interval in intervals:
        if len(interval) >= 2:
            starts.append(interval[0])
            ends.append(interval[1])
        else:
            starts.append(0)
            ends.append(0)
        if len(interval) > 2 and interval[2] > 0:
            positive_count += 1
        positive_prefix.append(positive_count)

    container["_fiberbrowser_interval_index"] = (
        cache_key,
        tuple(starts),
        tuple(ends),
        tuple(positive_prefix),
    )
    return intervals, container["_fiberbrowser_interval_index"][1], container["_fiberbrowser_interval_index"][2]


def _visible_intervals_from_container(container: dict, view_start: int, view_end: int):
    """Yield sorted intervals whose span overlaps the requested view."""
    intervals, starts, ends = _get_interval_index(container)
    if not intervals:
        return ()
    lo = bisect_right(ends, view_start)
    hi = bisect_left(starts, view_end, lo)
    return (intervals[idx] for idx in range(lo, hi))


def _layer_payload(read: dict, layer: str):
    layers = read.get("layers") or {}
    layer_data = layers.get(layer)
    if layer_data is None and layer == "fire":
        layer_data = layers.get("msp")
    elif layer_data is None and layer == "msp":
        layer_data = layers.get("fire")
    return layer_data


def nuc_layer_duplicates_primary(read: dict) -> bool:
    """Return whether read.layers.nuc is exactly the positive primary stream."""
    cached = read.get("_fiberbrowser_nuc_duplicates_primary")
    if cached is not None:
        return bool(cached)
    layer = (read.get("layers") or {}).get("nuc") or {}
    layer_intervals = layer.get("intervals") or []
    primary_intervals = [
        interval
        for interval in (read.get("intervals") or [])
        if len(interval) >= 3 and interval[2] > 0
    ]
    if len(layer_intervals) != len(primary_intervals):
        read["_fiberbrowser_nuc_duplicates_primary"] = False
        return False
    for layer_iv, primary_iv in zip(layer_intervals, primary_intervals):
        if len(layer_iv) < 3 or tuple(layer_iv[:3]) != tuple(primary_iv[:3]):
            read["_fiberbrowser_nuc_duplicates_primary"] = False
            return False
    read["_fiberbrowser_nuc_duplicates_primary"] = True
    return True


def get_layer_intervals(read: dict, layer: Optional[str]):
    """Return primary intervals or intervals from a named compact-read layer."""
    if layer is None:
        return read.get("intervals", [])
    layers = read.get("layers") or {}
    if layer == "all_fp":
        out = []
        seen = set()
        non_fp_layers = {"msp", "fire", "m6a", "mod", "m5c", "deam"}
        for layer_name, layer_data in layers.items():
            if layer_name in non_fp_layers:
                continue
            for interval in (layer_data or {}).get("intervals") or []:
                if len(interval) < 3:
                    continue
                key = (interval[0], interval[1], interval[2])
                if key in seen:
                    continue
                seen.add(key)
                out.append(interval)
        return out
    layer_data = _layer_payload(read, layer)
    if layer_data is None:
        # Older BAM compact payloads can expose raw FIRE intervals at the
        # top level; prefer layer.msp when present because it stores size and
        # aq quality in the normalized layer payload.
        if layer in {"fire", "msp"} and read.get("fire"):
            return read.get("fire", [])
        return []
    return layer_data.get("intervals", [])


def _normalized_profile_layer(layer: str) -> str:
    if layer == "msp":
        return "fire"
    if layer == "mod":
        return "m6a"
    return layer


def _interval_bin_diff(start_bins: np.ndarray, end_bins: np.ndarray, resolution: int) -> np.ndarray:
    """Build a coverage diff vector from start/end bin arrays."""
    starts = np.bincount(start_bins, minlength=resolution + 1)
    ends = np.bincount(end_bins + 1, minlength=resolution + 1)
    return (starts - ends).astype(np.float32, copy=False)


def _profile_values_for_json(values: np.ndarray) -> list[float]:
    return np.round(values.astype(np.float64, copy=False), 6).tolist()


def compute_compact_metaprofile_payload(
    reads: list,
    region_width: int,
    layers: Optional[list[str]] = None,
    *,
    max_bins: int = 500,
    include_legacy_profiles: bool = True,
    coordinate_offset: int = 0,
) -> dict:
    """Return compact browser metaprofiles without returning the profile read pool.

    The browser's default metaprofile tracks are layer-backed (nuc, TF, FIRE,
    custom MA layers). Sending those profiles directly avoids shipping hundreds
    of extra full read payloads just so the frontend can recompute arrays.
    """
    requested_layers = []
    seen = set()
    for layer in layers or []:
        normalized = _normalized_profile_layer(str(layer))
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        requested_layers.append(normalized)

    resolution = max(1, min(int(max_bins or 500), int(region_width or 1)))
    bin_size = region_width / resolution if region_width > 0 else 1.0
    coverage_diff = np.zeros(resolution + 1, dtype=np.float32)
    profile_defs: dict[str, tuple[Optional[str], int, int]] = {}
    if include_legacy_profiles:
        profile_defs["__nucleosome__"] = (None, 90, 100000)
        profile_defs["__subnuc__"] = (None, 10, 89)

    available_layers = set()
    for read in reads:
        layer_payload = read.get("layers") or {}
        if isinstance(layer_payload, dict):
            available_layers.update(layer_payload.keys())
        if read.get("fire"):
            available_layers.add("fire")
    if "msp" in available_layers:
        available_layers.add("fire")

    for layer in requested_layers:
        source_layer: Optional[str] = layer
        min_size = 1
        max_size = 100000

        if layer == "nuc":
            if "nuc" not in available_layers:
                source_layer = "footprint" if "footprint" in available_layers else None
                if source_layer is None:
                    min_size = 90
        elif layer == "footprint":
            if "footprint" not in available_layers:
                source_layer = "nuc" if "nuc" in available_layers else None
        elif layer == "tf":
            if "tf" not in available_layers:
                source_layer = None
                max_size = 89
        elif layer == "fire":
            source_layer = "fire"
        elif layer not in available_layers:
            continue

        profile_defs[layer] = (source_layer, min_size, max_size)

    cov_starts = []
    cov_ends = []
    profile_points = {
        name: ([], [], [])
        for name in profile_defs
    }
    for read in reads:
        primary_intervals = read.get("intervals") or []
        if not primary_intervals:
            continue

        _intervals, primary_starts, primary_ends = _get_interval_index(read)
        read_start = int(primary_starts[0]) - coordinate_offset if primary_starts else 0
        read_end = int(primary_ends[-1]) - coordinate_offset if primary_ends else 0
        cov_starts.append(read_start)
        cov_ends.append(read_end)

        view_start = coordinate_offset
        view_end = coordinate_offset + region_width
        for name, (source_layer, _min_size, _max_size) in profile_defs.items():
            if source_layer is None:
                profile_intervals = _visible_intervals_from_container(read, view_start, view_end)
            else:
                layer_payload = _layer_payload(read, source_layer)
                if layer_payload is not None:
                    profile_intervals = _visible_intervals_from_container(layer_payload, view_start, view_end)
                else:
                    profile_intervals = get_layer_intervals(read, source_layer)
            starts_out, ends_out, sizes_out = profile_points[name]
            for interval in profile_intervals:
                if len(interval) < 2:
                    continue
                size = int(interval[2]) if len(interval) >= 3 else int(interval[1]) - int(interval[0])
                starts_out.append(int(interval[0]) - coordinate_offset)
                ends_out.append(int(interval[1]) - coordinate_offset)
                sizes_out.append(size)

    if cov_starts:
        starts = np.clip(np.array(cov_starts, dtype=np.float64), 0, region_width)
        ends = np.clip(np.array(cov_ends, dtype=np.float64), 0, region_width)
        valid = ends > starts
        if np.any(valid):
            start_bins = np.clip((starts[valid] / bin_size).astype(np.intp), 0, resolution - 1)
            end_coords = np.maximum(starts[valid], ends[valid] - 1)
            end_bins = np.clip((end_coords / bin_size).astype(np.intp), 0, resolution - 1)
            coverage_diff = _interval_bin_diff(start_bins, end_bins, resolution)

    profile_diffs = {}
    for name, (_source_layer, min_size, max_size) in profile_defs.items():
        all_starts, all_ends, all_sizes = profile_points[name]
        diff = np.zeros(resolution + 1, dtype=np.float32)
        if all_starts:
            starts = np.clip(np.array(all_starts, dtype=np.float64), 0, region_width)
            ends = np.clip(np.array(all_ends, dtype=np.float64), 0, region_width)
            sizes = np.array(all_sizes, dtype=np.intp)
            valid = (
                (ends > starts)
                & (sizes > 0)
                & (sizes >= min_size)
                & (sizes <= max_size)
            )
            if np.any(valid):
                start_bins = np.clip((starts[valid] / bin_size).astype(np.intp), 0, resolution - 1)
                end_bins = np.clip((ends[valid] / bin_size).astype(np.intp), 0, resolution - 1)
                diff = _interval_bin_diff(start_bins, end_bins, resolution)
        profile_diffs[name] = diff

    coverage = np.cumsum(coverage_diff[:resolution])
    coverage[coverage == 0] = 1
    profiles = {
        name: _profile_values_for_json(np.cumsum(diff[:resolution]) / coverage)
        for name, diff in profile_diffs.items()
    }

    layer_profiles = {
        name: values
        for name, values in profiles.items()
        if not name.startswith("__")
    }
    if "footprint" in layer_profiles and "nuc" not in layer_profiles:
        layer_profiles["nuc"] = layer_profiles["footprint"]

    return {
        "nucleosome_profile": profiles.get("__nucleosome__", layer_profiles.get("nuc", [])),
        "subnuc_profile": profiles.get("__subnuc__", []),
        "layers": layer_profiles,
    }


def compute_rule_metric(
    read: dict,
    region_start: int,
    rule: dict,
    gene_regions: list,
    peak_regions: list,
    layer: Optional[str] = None,
    gene_regions_by_key: Optional[dict] = None,
    scope_windows: Optional[list] = None,
) -> int:
    """Count intervals matching a colormap rule for a single compact read."""
    size_min = rule.get("size_min", 0)
    size_max = rule.get("size_max", None)
    conditions = rule.get("conditions", [])

    def regions_for_gene_condition(cond: dict) -> list:
        if not gene_regions_by_key:
            return gene_regions
        gene_id = cond.get("geneId") or cond.get("gene_id")
        gene_name = cond.get("geneName") or cond.get("gene_name")
        id_regions = gene_regions_by_key.get(f"id:{gene_id}", []) if gene_id else []
        name_regions = gene_regions_by_key.get(f"name:{str(gene_name).lower()}", []) if gene_name else []
        if gene_id:
            return id_regions or name_regions
        if gene_name:
            return name_regions
        return gene_regions

    gates = rule.get("quality_gates") or rule.get("qualityGates") or []
    count = 0
    for int_start, int_end, size, qualities in _rule_interval_entries(read, layer, bool(gates)):
        if size <= 0:
            continue

        if size < size_min:
            continue
        if size_max is not None and size > size_max:
            continue
        # The labeling rule's quality gates, as the browser applies them (a
        # missing quality dimension fails the gate).
        if gates and not _quality_gates_pass(rule, qualities):
            continue

        abs_midpoint = region_start + (int_start + int_end) // 2
        if scope_windows and not midpoint_in_regions(abs_midpoint, scope_windows):
            continue

        pass_all = True
        for cond in conditions:
            target = cond.get("target", "")
            negate = cond.get("negate", False)
            if target == "gene":
                in_region = midpoint_in_regions(abs_midpoint, regions_for_gene_condition(cond))
                if negate:
                    in_region = not in_region
                if not in_region:
                    pass_all = False
                    break
            elif target == "peak":
                in_region = midpoint_in_regions(abs_midpoint, peak_regions or [])
                if negate:
                    in_region = not in_region
                if not in_region:
                    pass_all = False
                    break

        if pass_all:
            count += 1

    return count


def _rule_interval_entries(read: dict, layer: Optional[str], with_qualities: bool):
    """(start, end, size, qualities) for each interval a rule metric counts;
    the qualities only when a rule has gates to check."""
    if not with_qualities:
        for interval in get_layer_intervals(read, layer):
            yield interval[0], interval[1], interval[2], {}
        return
    from services.clustering_features import _interval_quality_map, _iter_layer_interval_entries
    if layer == "all_fp":
        seen = set()
        non_fp_layers = {"msp", "fire", "m6a", "mod", "m5c", "deam"}
        for layer_name, layer_data in (read.get("layers") or {}).items():
            if layer_name in non_fp_layers:
                continue
            for idx, interval in enumerate((layer_data or {}).get("intervals") or []):
                if len(interval) < 3:
                    continue
                key = (interval[0], interval[1], interval[2])
                if key in seen:
                    continue
                seen.add(key)
                yield interval[0], interval[1], interval[2], _interval_quality_map(layer_data, idx)
        return
    for int_start, int_end, size, _layer_name, qualities in _iter_layer_interval_entries(read, layer):
        yield int_start, int_end, size, qualities


def _quality_gates_pass(rule: dict, qualities: dict) -> bool:
    from services.clustering_features import _quality_gates_pass as gates_pass
    return gates_pass(rule, qualities)


def compute_fp_metrics(
    read: dict,
    region_start: int,
    scope_windows: Optional[list] = None,
    layer: Optional[str] = None,
) -> tuple[int, int, int]:
    """Compute footprint count, footprint bases, and total bases for a read."""
    fp_count = 0
    fp_size_sum = 0
    total_size_sum = 0

    for interval in get_layer_intervals(read, layer):
        int_start, int_end, size = interval[0], interval[1], interval[2]
        abs_size = abs(size)

        if scope_windows:
            abs_midpoint = region_start + (int_start + int_end) // 2
            if not midpoint_in_regions(abs_midpoint, scope_windows):
                continue

        total_size_sum += abs_size
        if size > 0:
            fp_count += 1
            fp_size_sum += size

    return fp_count, fp_size_sum, total_size_sum
