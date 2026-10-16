from types import SimpleNamespace
from time import perf_counter

from services.orthogonal_tracks import get_track_data
from services.tracks_endpoint import get_tracks_batch_payload
from state.browser_state import BrowserState


class FakeBatchState:
    def __init__(self, track_count: int):
        self.orthogonal_tracks = [
            {
                "path": f"/tracks/{idx}.bw",
                "label": f"Track {idx}",
                "format": "bigWig",
                "render_mode": "signal",
            }
            for idx in range(track_count)
        ]

    def get_track_data(self, track_idx, chrom, start, end, bins):
        return [float(track_idx)] * bins

    def get_track_annotations(self, track_idx, chrom, start, end, filter_names=None):
        return {"label": f"Track {track_idx}", "intervals": [], "track_type": "bed"}


class FakeBigWigHandle:
    def __init__(self):
        self.chrom_calls = 0

    def chroms(self):
        self.chrom_calls += 1
        return {"chr2L": 100_000}

    def isBigBed(self):
        return False

    def stats(self, chrom, start, end, nBins, type):
        return [1.0] * nBins


def test_tracks_batch_payload_benchmark_many_signal_tracks():
    state = FakeBatchState(track_count=120)
    body = SimpleNamespace(
        track_indices=list(range(120)),
        chrom="chr2L",
        start=10_000,
        end=20_000,
        bins=700,
        annotation_filters={},
    )

    started = perf_counter()
    payload = None
    for _ in range(8):
        payload = get_tracks_batch_payload(state, body)
    elapsed_ms = (perf_counter() - started) * 1000

    assert payload is not None
    assert len(payload["tracks"]) == 120
    assert payload["tracks"][0]["values"] == [0.0] * 700
    assert payload["tracks"][-1]["values"] == [119.0] * 700
    # Broad guardrail for accidental expensive work in the batch payload loop.
    assert elapsed_ms < 1000


def test_bigwig_signal_fetch_checks_chrom_dictionary_once(monkeypatch):
    handle = FakeBigWigHandle()

    def fake_handle(_path):
        return handle

    monkeypatch.setattr("services.bigbed_handles.get_bigwig_handle", fake_handle)

    values = get_track_data(
        {"path": "/tracks/signal.bw", "label": "Signal", "format": "bigWig"},
        "chr2L",
        100,
        500,
        bins=20,
    )

    assert values == [1.0] * 20
    assert handle.chrom_calls == 1


def test_cached_track_resample_preserves_window_mean_behavior():
    values = [0.0, 10.0, None, 30.0]

    assert BrowserState._resample_track_values(values, 0, 40, 0, 40, 2) == [5.0, 15.0]
    assert BrowserState._resample_track_values(values, 0, 40, 10, 30, 2) == [10.0, 0.0]


def test_cached_track_resample_benchmark_dense_signal():
    values = [float(i % 23) for i in range(120_000)]

    started = perf_counter()
    result = None
    for _ in range(16):
        result = BrowserState._resample_track_values(values, 0, 120_000, 10_000, 110_000, 4000)
    elapsed_ms = (perf_counter() - started) * 1000

    assert result is not None
    assert len(result) == 4000
    assert elapsed_ms < 1000
