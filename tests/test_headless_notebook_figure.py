"""Slow end-to-end: with no browser tab, settings pushed from Python reach headless figures."""
from __future__ import annotations

from pathlib import Path

import pytest

from browser_client import BrowserClient
from port_list import free_test_port

BAM = Path(__file__).resolve().parent / "fixtures" / "fibertools_frame" / "fiberhmm3.0.0_call.bam"


@pytest.mark.slow
def test_notebook_settings_reach_a_tabless_figure():
    with BrowserClient.headless(bam=str(BAM), port=free_test_port(), timeout=60, quiet=True) as client:
        region = "chrT:0-8000"
        before = client.figure(region, source="defaults", format="svg").decode().lower()
        client.set_layer_colors(nuc="#ff00ff", tf="#00ffaa")
        client.set_read_filters(all_reads=True, show_qc_fail=True)
        after = client.figure(region, source="defaults", format="svg").decode().lower()
        for color in ("#ff00ff", "#00ffaa"):
            assert color not in before and color in after
        # Plots are drawn by the browser: a figure request naming them is refused with the reason.
        r = client._http_session().post(f"{client.url}/api/render", json={
            "chrom": "chrT", "start": 0, "end": 8000, "tracks": ["axis", "plots"], "engine": "headless"}, timeout=60)
        assert r.status_code == 400 and "drawn by the browser" in r.json()["error"]
        with pytest.raises(RuntimeError, match="drawn by the browser"):
            client.render(chrom="chrT", start=0, end=8000, tracks=["axis", "plots"], engine="headless")
