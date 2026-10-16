"""Slow smoke test for the public BrowserClient.headless workflow."""

import pytest

from browser_client import BrowserClient
from port_list import free_test_port


@pytest.mark.slow
def test_headless_standalone_jupyter_control_smoke():
    pd = pytest.importorskip("pandas")

    with BrowserClient.headless(port=free_test_port(), timeout=20, quiet=True) as client:
        status = client.get_status()
        assert status.get("datasets") in (0, [])

        assert client.goto("chr1", 100, 300)["success"] is True
        state = client.get_jupyter_state()
        assert state["goto"] == {"chrom": "chr1", "start": 100, "end": 300}

        client.set_reproducibility(seed="headless-seed", display_cap=100, spanning=True)
        state = client.get_jupyter_state()
        assert state["settings_update"]["analysis_sample_seed"] == "headless-seed"
        assert state["settings_update"]["display_sample_count"] == 100
        assert state["settings_update"]["spanning_only"] is True

        reads = pd.DataFrame([{
            "id": "notebook_read_1",
            "intervals": [[0, 100, 100], [100, 200, -100]],
        }])
        result = client.push_reads(reads_df=reads, label="Headless notebook reads")
        assert result["success"] is True
        assert result["count"] == 1
        state = client.get_jupyter_state()
        assert state["pushed_reads"][0]["id"] == "notebook_read_1"
