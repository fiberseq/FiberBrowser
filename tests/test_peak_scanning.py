import numpy as np
import pytest

from services.peak_scanning import (
    build_peak_thresholds,
    compute_scan_signal,
    detect_threshold_layers,
    downsample_signal_for_response,
    format_peak_scan_results,
    scan_signal_needs_layers,
    smooth_scan_signal,
)


def _naive_range_counts(ranges, width):
    counts = np.zeros(width, dtype=np.int32)
    for start, end in ranges:
        s = max(0, start)
        e = min(width, end)
        if s < e:
            counts[s:e] += 1
    return counts


def _naive_scan_signal(reads, source, width):
    total_ranges = []
    numerator_ranges = []
    mod_positions = []

    for read in reads:
        intervals = read.get("intervals") or []
        if source == "fire":
            if intervals:
                total_ranges.append((intervals[0][0], intervals[-1][1]))
            layer = (read.get("layers") or {}).get("msp") or (read.get("layers") or {}).get("fire")
            source_ranges = layer.get("intervals", []) if layer else read.get("fire", [])
            numerator_ranges.extend((iv[0], iv[1]) for iv in source_ranges)
        elif source == "tf_density":
            for s, e, size in intervals:
                total_ranges.append((s, e))
                if 20 <= size < 65:
                    numerator_ranges.append((s, e))
        elif source == "m6a":
            if intervals:
                total_ranges.append((intervals[0][0], intervals[-1][1]))
            mod_positions.extend(p for p in (read.get("methyl_m6a") or read.get("methyl") or []) if 0 <= p < width)
        elif source == "msp":
            if intervals:
                total_ranges.append((intervals[0][0], intervals[-1][1]))
            layer = (read.get("layers") or {}).get("msp")
            source_ranges = layer.get("intervals", []) if layer else read.get("fire", [])
            numerator_ranges.extend((iv[0], iv[1]) for iv in source_ranges)
        else:
            for s, e, size in intervals:
                total_ranges.append((s, e))
                if size < 90:
                    numerator_ranges.append((s, e))

    total = _naive_range_counts(total_ranges, width)
    if source == "m6a":
        numerator = np.zeros(width, dtype=np.int32)
        for pos in mod_positions:
            numerator[pos] += 1
    else:
        numerator = _naive_range_counts(numerator_ranges, width)
    with np.errstate(divide="ignore", invalid="ignore"):
        signal = np.where(total > 0, numerator / total, 0).astype(np.float32)
    return signal, total


def test_compute_scan_signal_accessibility_counts_primary_intervals():
    reads = [
        {"id": "r1", "intervals": [[0, 10, 50], [10, 20, 120]]},
        {"id": "r2", "intervals": [[5, 15, 40]]},
    ]

    signal, total_counts = compute_scan_signal(reads, "accessibility", 25)

    assert total_counts[2] == 1
    assert total_counts[12] == 2
    assert total_counts[17] == 1
    assert signal[2] == 1.0
    assert signal[12] == 0.5
    assert signal[17] == 0.0


@pytest.mark.parametrize("source", ["accessibility", "tf_density", "fire", "msp", "m6a"])
def test_compute_scan_signal_matches_naive_range_accounting(source):
    reads = [
        {
            "id": "r1",
            "intervals": [[-5, 5, 40], [5, 20, 120], [20, 40, 55]],
            "layers": {"msp": {"intervals": [[3, 9, 6], [25, 34, 9]]}},
            "fire": [[10, 12, 245]],
            "methyl_m6a": [4, 4, 28, 55],
        },
        {
            "id": "r2",
            "intervals": [[0, 15, 20], [15, 30, 95], [35, 60, 45]],
            "fire": [[1, 7, 220], [30, 45, 220]],
            "methyl": [2, 29],
        },
    ]

    signal, total = compute_scan_signal(reads, source, 50)
    expected_signal, expected_total = _naive_scan_signal(reads, source, 50)

    np.testing.assert_array_equal(total, expected_total)
    np.testing.assert_allclose(signal, expected_signal)


def test_compute_scan_signal_layer_and_legacy_msp_fallback():
    reads = [
        {
            "id": "r1",
            "intervals": [[0, 20, 120]],
            "layers": {"msp": {"intervals": [[4, 8, 4]]}},
        },
        {
            "id": "r2",
            "intervals": [[0, 20, 120]],
            "fire": [[10, 12, 0.9]],
        },
    ]

    signal, total_counts = compute_scan_signal(reads, "msp", 25)

    assert total_counts[5] == 2
    assert signal[5] == 0.5
    assert signal[11] == 0.5
    assert signal[2] == 0.0


def test_compute_scan_signal_fire_prefers_filtered_layer_payload():
    reads = [
        {
            "id": "r1",
            "intervals": [[0, 20, 120]],
            "layers": {"msp": {"intervals": [[4, 8, 4]]}},
            "fire": [[10, 12, 245]],
        },
    ]

    signal, total_counts = compute_scan_signal(reads, "fire", 25)

    assert scan_signal_needs_layers("fire") is True
    assert total_counts[5] == 1
    assert signal[5] == 1.0
    assert signal[11] == 0.0


def test_compute_scan_signal_modification_density_uses_read_span_denominator():
    reads = [
        {"id": "r1", "intervals": [[0, 20, 120]], "methyl_m6a": [5]},
        {"id": "r2", "intervals": [[0, 20, 120]], "methyl_m6a": [5, 15]},
    ]

    signal, total_counts = compute_scan_signal(reads, "m6a", 25)

    assert total_counts[5] == 2
    assert signal[5] == 1.0
    assert signal[15] == 0.5


def test_compute_scan_signal_clips_ranges_and_preserves_duplicate_marks():
    reads = [
        {"id": "r1", "intervals": [[-5, 5, 40], [20, 35, 40]], "methyl_m6a": [5, 5, 40]},
        {"id": "r2", "intervals": [[0, 30, 120]], "methyl_m6a": [5]},
    ]

    signal, total_counts = compute_scan_signal(reads, "accessibility", 30)
    assert total_counts[0] == 2
    assert total_counts[24] == 2
    assert signal[0] == 0.5
    assert signal[24] == 0.5

    mod_signal, mod_total = compute_scan_signal(reads, "m6a", 30)
    assert mod_total[5] == 2
    assert mod_signal[5] == 1.5


def test_compute_scan_signal_supports_coordinate_offset_for_broad_cache_reads():
    broad_reads = [
        {
            "id": "r1",
            "intervals": [[100, 110, 40], [110, 130, 120]],
            "layers": {"msp": {"intervals": [[104, 108, 4]]}},
            "methyl_m6a": [105, 105, 125],
        },
        {"id": "r2", "intervals": [[105, 125, 40]], "methyl": [115]},
    ]
    local_reads = [
        {
            "id": "r1",
            "intervals": [[0, 10, 40], [10, 30, 120]],
            "layers": {"msp": {"intervals": [[4, 8, 4]]}},
            "methyl_m6a": [5, 5, 25],
        },
        {"id": "r2", "intervals": [[5, 25, 40]], "methyl": [15]},
    ]

    for source in ["accessibility", "msp", "m6a"]:
        broad_signal, broad_total = compute_scan_signal(
            broad_reads,
            source,
            30,
            coordinate_offset=100,
        )
        local_signal, local_total = compute_scan_signal(local_reads, source, 30)
        np.testing.assert_array_equal(broad_total, local_total)
        np.testing.assert_allclose(broad_signal, local_signal)


def test_detect_threshold_layers_progressively_masks_stronger_peaks():
    combined_signal = np.zeros(50, dtype=np.float32)
    combined_signal[10:20] = 0.6
    combined_signal[30:40] = 0.2
    total_counts = np.ones(50, dtype=np.int32) * 10
    thresholds = [(0, 0.5, "strong"), (1, 0.1, "weak")]

    peaks, layer_info = detect_threshold_layers(
        combined_signal,
        total_counts,
        thresholds,
        min_width=5,
        min_reads=2,
        smooth_width=4,
    )

    assert [(p["start"], p["end"], p["layer"]) for p in peaks] == [(10, 20, 0), (30, 40, 1)]
    assert [info["n_peaks"] for info in layer_info] == [1, 1]


def test_smooth_scan_signal_preserves_short_viewport_length():
    signal = np.ones(73, dtype=np.float32)

    smoothed = smooth_scan_signal(signal, smooth_width=100)

    assert smoothed.shape == signal.shape
    assert np.isfinite(smoothed).all()


def test_smooth_scan_signal_handles_empty_viewport():
    signal = np.zeros(0, dtype=np.float32)

    smoothed = smooth_scan_signal(signal, smooth_width=100)

    assert smoothed.shape == signal.shape


def test_peak_thresholds_formatting_and_signal_downsampling():
    thresholds = build_peak_thresholds(0.5, 0.3, 0.15, 0.08, min_reads=5, n_reads=10)
    assert thresholds[-1][1] == 0.5

    signal = np.arange(10, dtype=np.float32)
    assert downsample_signal_for_response(signal, 5) == [1.0, 3.0, 5.0, 7.0, 9.0]

    formatted = format_peak_scan_results(
        [{"start": 2, "end": 5, "score": 0.7, "layer": 0, "threshold": 0.5}],
        region_start=100,
    )
    assert formatted == [
        {"start": 102, "end": 105, "index": 0, "score": 0.7, "layer": 0, "width": 3, "threshold": 0.5}
    ]


def test_scan_any_interval_layer_by_name():
    from services.peak_scanning import is_read_signal_source, scan_signal_layer_name

    reads = [
        {"id": "r1", "intervals": [[0, 20, 120]], "layers": {"ctcf": {"intervals": [[4, 8, 4]]}}},
        {"id": "r2", "intervals": [[0, 20, 120]], "layers": {"tf": {"intervals": [[4, 8, 4]]}},
         "fire": [[4, 8, 0.9]]},
    ]
    signal, total_counts = compute_scan_signal(reads, "layer:ctcf", 25)
    assert total_counts[5] == 2 and signal[5] == 0.5 and signal[10] == 0.0
    assert scan_signal_needs_layers("layer:ctcf")
    assert is_read_signal_source("layer:ddda_mcg") and not is_read_signal_source("ctcf")
    assert scan_signal_layer_name("tf_layer") == "tf" and scan_signal_layer_name("accessibility") is None
    with pytest.raises(ValueError):
        scan_signal_layer_name("layer:bad name")
