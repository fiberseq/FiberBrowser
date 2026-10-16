from services.signal_peaks import detect_signal_peaks


def test_detect_signal_peaks_returns_empty_for_short_or_zero_signal():
    assert detect_signal_peaks([1.0, 2.0], start=100, end=200) == []
    assert detect_signal_peaks([0.0] * 20, start=100, end=300) == []


def test_detect_signal_peaks_returns_empty_for_an_empty_or_inverted_region():
    signal = [0.0, 1.0, 1.0, 1.0, 0.0] * 4
    assert detect_signal_peaks(signal, start=100, end=100) == []
    assert detect_signal_peaks(signal, start=200, end=100) == []


def test_detect_signal_peaks_maps_signal_peak_to_genomic_interval():
    signal = [0.0] * 100
    for idx in range(42, 58):
        signal[idx] = 1.0

    peaks = detect_signal_peaks(
        signal,
        start=1_000,
        end=2_000,
        min_distance_bp=50,
        min_width_bp=80,
        threshold_percentile=30,
    )

    assert len(peaks) == 1
    assert 1_400 <= peaks[0]["start"] <= 1_450
    assert 1_550 <= peaks[0]["end"] <= 1_600
    assert peaks[0]["score"] > 0.9
    assert peaks[0]["threshold"] > 0


def test_detect_signal_peaks_accepts_explicit_threshold_value():
    signal = [0.0] * 100
    for idx in range(42, 58):
        signal[idx] = 1.0

    peaks = detect_signal_peaks(
        signal,
        start=1_000,
        end=2_000,
        min_distance_bp=50,
        min_width_bp=80,
        threshold_value=0.8,
    )

    assert len(peaks) == 1
    assert peaks[0]["threshold"] == 0.8
