"""Peak scanning signal accumulation and threshold helpers."""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

import numpy as np

from services.read_marks import m6a_positions


MODIFICATION_SIGNAL_SOURCES = {"m6a", "m5c", "deam"}
LAYER_SIGNAL_SOURCES = {"fire", "msp", "tf_layer", "nuc_layer"}
_LAYER_SOURCE_LAYERS = {"fire": "msp", "msp": "msp", "tf_layer": "tf", "nuc_layer": "nuc"}
# Read-derived sources the scan computes itself; 'track:N' scans a loaded track
# and 'layer:<name>' any MA/BigBed interval layer (e.g. ctcf, ddda_mcg, tf_cr).
READ_SIGNAL_SOURCES = {"accessibility", "tf_density"} | MODIFICATION_SIGNAL_SOURCES | LAYER_SIGNAL_SOURCES
LAYER_SOURCE_PREFIX = "layer:"
_LAYER_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")


def scan_signal_layer_name(signal_source: str) -> str | None:
    """The interval layer a scan source reads ('layer:<name>' or a built-in layer source), else None."""
    if not isinstance(signal_source, str):
        return None
    if signal_source in _LAYER_SOURCE_LAYERS:
        return _LAYER_SOURCE_LAYERS[signal_source]
    if signal_source.startswith(LAYER_SOURCE_PREFIX):
        name = signal_source[len(LAYER_SOURCE_PREFIX):]
        if not _LAYER_NAME_RE.fullmatch(name):
            raise ValueError(f"Invalid layer signal source {signal_source!r}; use 'layer:<name>'")
        return name
    return None


def is_read_signal_source(signal_source: str) -> bool:
    """A source the peak scanner computes from reads (built-in, or any 'layer:<name>')."""
    return signal_source in READ_SIGNAL_SOURCES or (
        isinstance(signal_source, str) and signal_source.startswith(LAYER_SOURCE_PREFIX)
    )


def track_signal_index(signal_source: str) -> int | None:
    """The track index of a 'track:N' source, else None."""
    if not isinstance(signal_source, str) or not signal_source.startswith("track:"):
        return None
    try:
        return int(signal_source.split(":", 1)[1])
    except ValueError:
        raise ValueError(f"Invalid track signal source {signal_source!r}; use 'track:<index>'") from None


def scan_signal_needs_methylation(signal_source: str) -> bool:
    return signal_source in MODIFICATION_SIGNAL_SOURCES


def scan_signal_needs_layers(signal_source: str) -> bool:
    return signal_source in LAYER_SIGNAL_SOURCES or (
        isinstance(signal_source, str) and signal_source.startswith(LAYER_SOURCE_PREFIX)
    )


def compute_scan_signal(
    reads: Sequence[dict[str, Any]],
    signal_source: str,
    region_width: int,
    subnucleosomal_threshold: int = 90,
    coordinate_offset: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute the per-base signal and denominator counts for peak scanning."""
    numerator, total_counts = compute_scan_counts(
        reads,
        signal_source,
        region_width,
        subnucleosomal_threshold=subnucleosomal_threshold,
        coordinate_offset=coordinate_offset,
    )
    return scan_signal_from_counts(numerator, total_counts), total_counts


def compute_scan_counts(
    reads: Sequence[dict[str, Any]],
    signal_source: str,
    region_width: int,
    subnucleosomal_threshold: int = 90,
    coordinate_offset: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute numerator and denominator counts for peak scanning."""
    total_starts: list[int] = []
    total_ends: list[int] = []
    numerator_starts: list[int] = []
    numerator_ends: list[int] = []
    mod_positions: list[int] = []
    layer_name = scan_signal_layer_name(signal_source)
    from services.background_work import checkpoint

    for n_read, read in enumerate(reads):
        if not n_read & 1023:
            checkpoint()  # a scan whose clients left stops here
        intervals = read.get("intervals") or []

        if signal_source == "fire":
            _append_read_span(intervals, total_starts, total_ends, coordinate_offset)
            for fs, fe in _fire_intervals_for_signal(read):
                _append_range(numerator_starts, numerator_ends, fs, fe, coordinate_offset)
            continue

        if signal_source == "tf_density":
            for interval_start, interval_end, size in intervals:
                _append_range(total_starts, total_ends, interval_start, interval_end, coordinate_offset)
                if 20 <= size < 65:
                    _append_range(numerator_starts, numerator_ends, interval_start, interval_end, coordinate_offset)
            continue

        if signal_source in MODIFICATION_SIGNAL_SOURCES:
            _append_read_span(intervals, total_starts, total_ends, coordinate_offset)
            for position in _marks_for_signal(read, signal_source):
                shifted = int(position) - coordinate_offset
                if 0 <= shifted < region_width:
                    mod_positions.append(shifted)
            continue

        if layer_name is not None:
            _append_read_span(intervals, total_starts, total_ends, coordinate_offset)
            layer_data = (read.get("layers") or {}).get(layer_name)
            if layer_data:
                for layer_interval in layer_data.get("intervals", []):
                    _append_range(
                        numerator_starts,
                        numerator_ends,
                        layer_interval[0],
                        layer_interval[1],
                        coordinate_offset,
                    )
            elif signal_source in ("msp", "fire"):
                # BAM reads without layers carry FIRE/MSP calls at top level.
                for fire_interval in read.get("fire", []):
                    _append_range(numerator_starts, numerator_ends, fire_interval[0], fire_interval[1], coordinate_offset)
            continue

        for interval_start, interval_end, size in intervals:
            _append_range(total_starts, total_ends, interval_start, interval_end, coordinate_offset)
            if size < subnucleosomal_threshold:
                _append_range(numerator_starts, numerator_ends, interval_start, interval_end, coordinate_offset)

    total_counts = _range_counts(total_starts, total_ends, region_width)
    if signal_source in MODIFICATION_SIGNAL_SOURCES:
        numerator = _point_counts(mod_positions, region_width)
    else:
        numerator = _range_counts(numerator_starts, numerator_ends, region_width)

    return numerator, total_counts


def scan_signal_from_counts(numerator: np.ndarray, total_counts: np.ndarray) -> np.ndarray:
    """Normalize scan numerator counts by total coverage counts."""
    with np.errstate(divide="ignore", invalid="ignore"):
        signal = np.where(total_counts > 0, numerator / total_counts, 0).astype(np.float32)
    return signal


def _fire_intervals_for_signal(read: dict[str, Any]):
    """Yield FIRE intervals, preferring quality-filtered layer payloads."""
    layers = read.get("layers") or {}
    layer_data = layers.get("msp") or layers.get("fire")
    if layer_data:
        for interval in layer_data.get("intervals", []):
            yield interval[0], interval[1]
        return
    for interval in read.get("fire", []):
        yield interval[0], interval[1]


def smooth_scan_signal(signal: np.ndarray, smooth_width: int) -> np.ndarray:
    # np.convolve(..., mode="same") returns max(len(signal), len(kernel)).
    # Clamp the kernel for short viewports so smoothing never changes the
    # signal length (and therefore always matches the coverage/mask arrays).
    if len(signal) == 0:
        return signal.astype(np.float32, copy=True)
    smooth_width = min(max(1, int(smooth_width)), len(signal))
    kernel = np.ones(smooth_width, dtype=np.float32) / smooth_width
    return np.convolve(signal, kernel, mode="same")


def build_peak_thresholds(
    threshold_strong: float,
    threshold_medium: float,
    threshold_weak: float,
    threshold_rare: float,
    min_reads: int,
    n_reads: int,
) -> list[tuple[int, float, str]]:
    rare_threshold = threshold_rare if n_reads <= 0 else max(threshold_rare, min_reads / n_reads)
    return [
        (0, threshold_strong, f"Strong (>{int(threshold_strong * 100)}%)"),
        (1, threshold_medium, f"Medium (>{int(threshold_medium * 100)}%)"),
        (2, threshold_weak, f"Weak (>{int(threshold_weak * 100)}%)"),
        (3, rare_threshold, f"Rare (>{int(threshold_rare * 100)}%)"),
    ]


# Default widest call that is still a peak (bp). Accessible elements (promoter
# and enhancer nucleosome-depleted regions, FIRE peaks) are a few hundred bp to
# about a kilobase. A stretch kilobases wide that stays above a tier threshold is
# that view's background accessibility (e.g. the ~35-45% linker accessibility of
# nucleosome arrays in DAF-seq and Fiber-seq), not a peak: with an absolute
# threshold below that background, a whole 10 kb view reads as one "Medium" peak.
# Such calls are left out of the peaks and reported as broad. 0 = no limit.
DEFAULT_MAX_PEAK_WIDTH = 2000


def detect_threshold_layers(
    combined_signal: np.ndarray,
    total_counts: np.ndarray,
    thresholds: Sequence[tuple[int, float, str]],
    min_width: int,
    min_reads: int,
    smooth_width: int,
    max_width: int | None = None,
    broad_out: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Detect progressively masked threshold layers from a smoothed signal.

    A region wider than ``max_width`` (when > 0) is not a peak but the view's
    background above that tier's threshold: it is left out of the peaks
    (appended to ``broad_out`` if given) but still masked, so a lower tier does
    not call the same plateau in pieces. ``layer_info`` counts them as ``n_broad``.
    """
    region_width = len(total_counts)
    all_peaks: list[dict[str, Any]] = []
    masked = np.zeros(region_width, dtype=bool)
    layer_info: list[dict[str, Any]] = []
    max_width = int(max_width or 0)

    for layer, threshold, label in thresholds:
        layer_peaks = []
        n_broad = 0
        starts, ends = _find_threshold_regions(combined_signal, threshold, masked)

        for reg_start, reg_end in zip(starts, ends):
            width = reg_end - reg_start
            if width < min_width:
                continue

            if max_width > 0 and width > max_width:
                n_broad += 1
                if broad_out is not None:
                    broad_out.append({
                        "start": int(reg_start),
                        "end": int(reg_end),
                        "layer": layer,
                        "score": float(combined_signal[reg_start:reg_end].max()),
                        "threshold": threshold,
                    })
                masked[max(0, reg_start - smooth_width // 4):min(region_width, reg_end + smooth_width // 4)] = True
                continue

            peak_score = float(combined_signal[reg_start:reg_end].max())

            if layer == 3:
                peak_counts = total_counts[reg_start:reg_end]
                reads_at_peak = int(peak_counts.mean()) if peak_counts.size > 0 else 0
                if reads_at_peak < min_reads:
                    continue

            layer_peaks.append(
                {
                    "start": int(reg_start),
                    "end": int(reg_end),
                    "layer": layer,
                    "score": peak_score,
                    "threshold": threshold,
                }
            )

            mask_start = max(0, reg_start - smooth_width // 4)
            mask_end = min(region_width, reg_end + smooth_width // 4)
            masked[mask_start:mask_end] = True

        all_peaks.extend(layer_peaks)
        layer_info.append(
            {
                "layer": layer,
                "threshold": threshold,
                "label": label,
                "n_peaks": len(layer_peaks),
                "n_broad": n_broad,
            }
        )

    return all_peaks, layer_info


def format_peak_scan_results(peaks: Sequence[dict[str, Any]], region_start: int) -> list[dict[str, Any]]:
    return [
        {
            "start": int(region_start + peak["start"]),
            "end": int(region_start + peak["end"]),
            "index": index,
            "score": peak["score"],
            "layer": peak["layer"],
            "width": peak["end"] - peak["start"],
            "threshold": peak["threshold"],
        }
        for index, peak in enumerate(peaks)
    ]


def downsample_signal_for_response(signal: np.ndarray, signal_bins: int) -> list[float]:
    if len(signal) == 0:
        return []

    n_bins = min(signal_bins, len(signal))
    if n_bins >= len(signal):
        return signal.tolist()

    bin_size = len(signal) / n_bins
    downsampled = []
    for i in range(n_bins):
        s_idx = int(i * bin_size)
        e_idx = int((i + 1) * bin_size)
        downsampled.append(float(signal[s_idx:e_idx].max()))
    return downsampled


def save_peak_scan_diagnostic_plot(
    combined_signal: np.ndarray,
    peaks: Sequence[dict[str, Any]],
    thresholds: Sequence[tuple[int, float, str]],
    chrom: str,
    start: int,
    end: int,
    n_reads: int,
) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        region_width = end - start
        fig, axes = plt.subplots(2, 1, figsize=(14, 6), sharex=True)
        x = np.arange(region_width)

        ax = axes[0]
        ax.fill_between(x, 0, combined_signal, alpha=0.5, color="blue")
        ax.plot(x, combined_signal, color="blue", linewidth=0.5)
        for _layer, threshold, _label in thresholds:
            ax.axhline(y=threshold, color="red", linestyle="--", alpha=0.7, linewidth=1)
        ax.set_ylabel("Accessibility")
        ax.set_ylim(0, min(1, combined_signal.max() * 1.2))
        ax.set_title(f"Accessibility Signal ({n_reads} reads)")

        ax = axes[1]
        layer_colors = ["#ef4444", "#f97316", "#eab308", "#22c55e"]
        for peak in peaks:
            color = layer_colors[peak["layer"]]
            ax.axvspan(peak["start"], peak["end"], alpha=0.5, color=color)
            ax.plot(
                [peak["start"], peak["end"]],
                [peak["layer"], peak["layer"]],
                color=color,
                linewidth=3,
                solid_capstyle="butt",
            )

        ax.set_ylabel("Layer")
        ax.set_ylim(-0.5, 3.5)
        ax.set_yticks([0, 1, 2, 3])
        ax.set_yticklabels(["L0 Strong", "L1 Medium", "L2 Weak", "L3 Rare"])
        ax.invert_yaxis()
        ax.set_xlabel(f"Position in {chrom}:{start}-{end}")

        fig.suptitle(f"Peak Scan: {len(peaks)} peaks")
        plt.tight_layout()
        plot_path = f"/tmp/peak_scan_{chrom}_{start}_{end}.png"
        plt.savefig(plot_path, dpi=150)
        plt.close()
        print(f"Diagnostic plot saved to: {plot_path}")
    except Exception as exc:
        print(f"Failed to save plot: {exc}")


def _marks_for_signal(read: dict[str, Any], signal_source: str) -> list[int]:
    if signal_source == "m6a":
        return m6a_positions(read)
    if signal_source == "m5c":
        return read.get("methyl_m5c") or []
    return [event[0] for event in (read.get("deam") or [])]


def _range_counts(starts: Sequence[int], ends: Sequence[int], region_width: int) -> np.ndarray:
    """Return per-base coverage counts for many ranges using a vectorized diff."""
    width = max(0, int(region_width))
    if width <= 0:
        return np.zeros(0, dtype=np.int32)
    if not starts:
        return np.zeros(width, dtype=np.int32)

    start_array = np.clip(np.asarray(starts, dtype=np.int64), 0, width)
    end_array = np.clip(np.asarray(ends, dtype=np.int64), 0, width)
    valid = end_array > start_array
    if not np.any(valid):
        return np.zeros(width, dtype=np.int32)

    delta = (
        np.bincount(start_array[valid], minlength=width + 1)
        - np.bincount(end_array[valid], minlength=width + 1)
    )
    return np.cumsum(delta[:-1], dtype=np.int64).astype(np.int32, copy=False)


def _point_counts(positions: Sequence[int], region_width: int) -> np.ndarray:
    counts = np.zeros(region_width, dtype=np.int32)
    if positions:
        np.add.at(counts, np.asarray(positions, dtype=np.int64), 1)
    return counts


def _append_range(starts: list[int], ends: list[int], start: int, end: int, coordinate_offset: int) -> None:
    starts.append(int(start) - coordinate_offset)
    ends.append(int(end) - coordinate_offset)


def _append_read_span(
    intervals: Sequence[Sequence[int]],
    starts: list[int],
    ends: list[int],
    coordinate_offset: int,
) -> None:
    if not intervals:
        return
    _append_range(starts, ends, intervals[0][0], intervals[-1][1], coordinate_offset)


def _find_threshold_regions(
    signal: np.ndarray,
    threshold: float,
    masked_regions: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Find contiguous regions above threshold while respecting a mask."""
    working = signal.copy()
    working[masked_regions] = 0
    above = working >= threshold

    padded = np.concatenate([[False], above, [False]])
    transitions = np.diff(padded.astype(np.int8))
    starts = np.where(transitions == 1)[0]
    ends = np.where(transitions == -1)[0]
    return starts, ends


def _peak_view(state, chrom: str, start: int, end: int) -> tuple:
    translate = getattr(state, "translate_chrom", None)
    return (translate(chrom) if callable(translate) else chrom, int(start), int(end))


def remember_peak_regions(state, regions, chrom: str, start: int, end: int) -> None:
    """Keep the last scanned peaks (offsets from `start`) with the region they came from.

    Scans and filters run in worker threads: the (view, peaks) pair is also
    published as one object, so a reader never pairs one scan's view with
    another's peaks.
    """
    view = _peak_view(state, chrom, start, end)
    state.peak_regions_snapshot = (view, regions)
    state.peak_regions = regions
    state.peak_regions_view = view


def stored_peak_regions_for(state, chrom: str, start: int, end: int) -> list:
    """The last scanned peaks, if they were scanned for this region (they're offsets
    from its start, so elsewhere they would point at the wrong places)."""
    snapshot = getattr(state, "peak_regions_snapshot", None)
    regions = getattr(state, "peak_regions", None)
    if snapshot is not None and snapshot[1] is regions:
        view = snapshot[0]  # the pair as one scan published it
    else:  # set elsewhere (a reset), or mid-update: the attributes as they are
        view = getattr(state, "peak_regions_view", None)
    if view is not None and view != _peak_view(state, chrom, start, end):
        return []
    return regions or []
