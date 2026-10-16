"""Notebook client calls that hit the wrong route or missed a required parameter (B6 review)."""
from browser_client import BrowserClient


class _Recorder(BrowserClient):
    def __init__(self):
        self.calls = []

    def _post(self, endpoint, data=None, params=None, **_kwargs):
        self.calls.append((endpoint, data, params))
        return {"success": True}

    def get_region(self):
        return {"chrom": "chr2L", "start": 100, "end": 200}


def test_detect_peaks_uses_the_peak_scan_route():
    client = _Recorder()
    client.detect_peaks(signal_source="fire")
    endpoint, body, _params = client.calls[0]
    assert endpoint.startswith("/api/scan_peaks?chrom=chr2L&start=100&end=200")
    assert body["signal_source"] == "fire"


def test_precompute_microc_expected_sends_the_chromosome():
    client = _Recorder()
    client.precompute_microc_expected()
    assert client.calls[-1] == ("/api/microc/precompute_expected", None, {"chrom": "chr2L"})
    client.precompute_microc_expected("chr3R", resolution=5000)
    assert client.calls[-1][2] == {"chrom": "chr3R", "resolution": 5000}
