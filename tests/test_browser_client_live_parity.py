"""Live API parity tests for the Python/Jupyter BrowserClient.

These tests run BrowserClient methods against an in-process FastAPI app with
real local fixtures. They are intentionally closer to notebook usage than the
pure request-mapping unit tests, while avoiding subprocess/browser startup.
"""

from __future__ import annotations

from typing import Any

import pytest

from browser_client import BrowserClient


pytestmark = pytest.mark.integration


class _TestClientBrowserClient(BrowserClient):
    """BrowserClient adapter backed by Starlette TestClient."""

    def __init__(self, test_client):
        self.url = "http://testserver"
        self._test_client = test_client
        self.calls = []

    def _assert_response(self, response):
        assert response.status_code < 400, response.text
        return response

    def _get(self, endpoint: str, params: dict = None) -> dict:
        self.calls.append(("GET", endpoint, params or {}))
        response = self._test_client.get(endpoint, params=params or {})
        return self._assert_response(response).json()

    def _post(self, endpoint: str, data: Any = None, params: dict = None) -> dict:
        self.calls.append(("POST", endpoint, data, params or {}))
        response = self._test_client.post(
            endpoint,
            json=data if data is not None else {},
            params=params or {},
        )
        return self._assert_response(response).json()

    def _delete(self, endpoint: str, params: dict = None) -> dict:
        self.calls.append(("DELETE", endpoint, params or {}))
        response = self._test_client.delete(endpoint, params=params or {})
        return self._assert_response(response).json()

    def _get_bytes(self, endpoint: str, params: dict = None, timeout: int = 60) -> bytes:
        self.calls.append(("GET_BYTES", endpoint, params or {}, timeout))
        response = self._test_client.get(endpoint, params=params or {})
        return self._assert_response(response).content

    def _post_bytes(self, endpoint: str, data: dict = None, params: dict = None, timeout: int = 60) -> bytes:
        self.calls.append(("POST_BYTES", endpoint, data or {}, params or {}, timeout))
        response = self._test_client.post(endpoint, json=data or {}, params=params or {})
        return self._assert_response(response).content


@pytest.fixture
def live_browser_client_for_dataset():
    """Install a one-dataset BrowserState and return a BrowserClient adapter."""
    import server as srv
    from models.domain import DAFCState, JupyterState
    from plugins import init_context
    from starlette.testclient import TestClient
    from state import runtime_state
    from state.runtime_state import (
        set_browser_state,
        set_dafc_state,
        set_jupyter_state,
        set_session_manager,
    )

    old_state = srv.state
    old_dafc_state = srv.dafc_state
    old_jupyter_state = srv.jupyter_state
    old_session_manager = srv.session_manager
    # Store raw runtime singletons, not getter results. The getters fall back
    # to server globals when unset, and restoring that fallback would pin later
    # tests to a stale BrowserState instead of preserving server.state behavior.
    old_runtime_state = runtime_state._state
    old_runtime_dafc_state = runtime_state._dafc_state
    old_runtime_jupyter_state = runtime_state._jupyter_state
    old_runtime_session_manager = runtime_state._session_manager

    def make(path: str) -> _TestClientBrowserClient:
        state = srv.BrowserState(path, None, None, None)
        jupyter_state = JupyterState()
        dafc_state = DAFCState()

        srv.state = state
        srv.jupyter_state = jupyter_state
        srv.dafc_state = dafc_state
        srv.session_manager = None
        set_browser_state(state)
        set_jupyter_state(jupyter_state)
        set_dafc_state(dafc_state)
        set_session_manager(None)
        init_context(state)

        from services.local_auth import auth_headers
        return _TestClientBrowserClient(TestClient(srv.app, headers=auth_headers()))

    try:
        yield make
    finally:
        srv.state = old_state
        srv.dafc_state = old_dafc_state
        srv.jupyter_state = old_jupyter_state
        srv.session_manager = old_session_manager
        set_browser_state(old_runtime_state)
        set_dafc_state(old_runtime_dafc_state)
        set_jupyter_state(old_runtime_jupyter_state)
        set_session_manager(old_runtime_session_manager)


def _layer_interval_count(read: dict, layer: str) -> int:
    """Count intervals from either direct legacy fields or canonical layer maps."""
    if layer in read and isinstance(read[layer], list):
        return len(read[layer])
    layers = read.get("layers") or {}
    payload = layers.get(layer)
    if isinstance(payload, dict):
        return len(payload.get("intervals") or [])
    if isinstance(payload, list):
        return len(payload)
    return 0


def _has_layer_intervals(reads: list[dict], layer: str) -> bool:
    return any(_layer_interval_count(read, layer) > 0 for read in reads)


def _assert_dataset_layers_match_reads_route(client, dataset: dict, region: dict) -> None:
    """The dataset's layer flags agree with what the reads route reports for real reads.

    A FiberHMM-recalled DAF BAM carries nuc/tf/msp (MA) and deamination (DA)
    layers but no FIRE: FIRE elements come from fibertools on Fiber-seq (m6A)
    data, so ``fire`` is expected to be off here. Checking both routes keeps
    the parity meaningful for either kind of BAM instead of hard-coding one.
    """
    flags = dataset["available_layers"]
    compact = client._get("/api/reads/compact", params=dict(
        chrom=region["chrom"], start=region["cluster_start"], end=region["cluster_end"],
        dataset_id=dataset["id"], spanning=False, include_layers=True))
    reported = set(compact["available_layers"])
    assert compact["reads"]
    for layer in ("tf", "nuc", "msp", "deam"):
        assert flags[layer] is True, layer
        assert layer in reported, layer
    assert flags["fire"] is ("fire" in reported)


def test_browser_client_drives_rich_daf_gui_parity_workflow(
    live_browser_client_for_dataset,
    rich_daf_bam_path,
    rich_daf_region,
):
    client = live_browser_client_for_dataset(rich_daf_bam_path)
    dataset = client.get_datasets()[0]
    dataset_id = dataset["id"]
    _assert_dataset_layers_match_reads_route(client, dataset, rich_daf_region)

    chrom = rich_daf_region["chrom"]
    start = rich_daf_region["cluster_start"]
    end = rich_daf_region["cluster_end"]
    seed = "api-parity-rich-daf"

    assert client.goto(chrom, start, end)["success"] is True
    client.set_reproducibility(
        seed=seed,
        analysis_cap=500,
        display_cap=200,
        display_mode="sample",
        profile_read_cap=750,
        spanning=False,
    )
    state = client.get_jupyter_state()
    assert state["goto"] == {"chrom": chrom, "start": start, "end": end}
    assert state["settings_update"]["analysis_sample_seed"] == seed
    assert state["settings_update"]["analysis_sample_count"] == 500
    assert state["settings_update"]["display_sample_count"] == 200
    assert state["settings_update"]["background_read_cap"] == 750
    assert state["settings_update"]["spanning_only"] is False

    reads = client.get_compact_reads(
        chrom=chrom,
        start=rich_daf_region["start"],
        end=rich_daf_region["end"],
        dataset_id=dataset_id,
        spanning=False,
        include_methylation=False,
        layer_names=["tf", "nuc", "msp"],
        max_reads=200,
        sample_seed=seed,
    )
    assert reads
    assert _has_layer_intervals(reads, "tf")
    assert _has_layer_intervals(reads, "nuc")
    assert _has_layer_intervals(reads, "msp") or _has_layer_intervals(reads, "fire")

    selected_ids = [read["id"] for read in reads[:5]]
    client.set_read_order(list(reversed(selected_ids)), dataset_id=dataset_id)
    client.set_read_filter(selected_ids[:3], dataset_id=dataset_id)
    client.set_jupyter_selection(selected_ids[:2], dataset_id=dataset_id)
    state = client.get_jupyter_state()
    assert state["read_order"][dataset_id] == list(reversed(selected_ids))
    assert state["read_filter"][dataset_id] == selected_ids[:3]
    assert state["selected_read_ids"][dataset_id] == selected_ids[:2]

    pd = pytest.importorskip("pandas")
    pushed = pd.DataFrame([{"id": "notebook_read_1", "intervals": reads[0]["intervals"]}])
    push_result = client.push_reads(reads_df=pushed, label="Notebook subset")
    assert push_result["success"] is True
    assert push_result["count"] == 1
    assert client.get_jupyter_state()["pushed_reads"][0]["id"] == "notebook_read_1"

    scan = client.scan_peaks(
        chrom=chrom,
        start=start,
        end=end,
        dataset_ids=[dataset_id],
        signal_source="tf_layer",
        spanning=False,
        sample_seed=seed,
        min_reads=3,
    )
    assert scan["peaks"], "Expected TF-layer peaks in rich DAF test window"
    peak = scan["peaks"][0]
    peak_regions = [{"start": peak["start"], "end": peak["end"], "mode": "tf_layer"}]

    cluster_a = client.cluster_all(
        chrom=chrom,
        start=start,
        end=end,
        peak_regions=peak_regions,
        k=3,
        method="kmeans",
        dataset_ids=[dataset_id],
        spanning=False,
        sample_seed=seed,
        max_reads=200,
    )
    cluster_b = client.cluster_all(
        chrom=chrom,
        start=start,
        end=end,
        peak_regions=peak_regions,
        k=3,
        method="kmeans",
        dataset_ids=[dataset_id],
        spanning=False,
        sample_seed=seed,
        max_reads=200,
    )
    result_a = cluster_a["results"][dataset_id]
    result_b = cluster_b["results"][dataset_id]
    assert result_a["analysis_read_count"] <= 200
    assert result_a["assignments"]
    assert result_a["cluster_counts"] == result_b["cluster_counts"]
    assert result_a["assignments"] == result_b["assignments"]


def test_browser_client_standard_bigbed_requests_inferred_layers(
    live_browser_client_for_dataset,
    standard_fiber_bigbed_path,
    rich_daf_region,
):
    client = live_browser_client_for_dataset(standard_fiber_bigbed_path)
    dataset = client.get_datasets()[0]
    dataset_id = dataset["id"]
    layers = dataset["available_layers"]
    assert layers["footprint"] is True
    assert layers["tf"] is True
    assert layers["nuc"] is True
    assert layers["msp"] is True

    reads = client.get_compact_reads(
        chrom=rich_daf_region["chrom"],
        start=rich_daf_region["start"],
        end=rich_daf_region["end"],
        dataset_id=dataset_id,
        spanning=False,
        include_methylation=False,
        layer_names=["nuc", "tf", "msp"],
        max_reads=200,
        sample_seed="api-parity-bigbed",
    )
    assert reads
    assert _has_layer_intervals(reads, "nuc")
    assert _has_layer_intervals(reads, "tf")
    assert _has_layer_intervals(reads, "msp")

    meta = client.get_meta(
        chrom=rich_daf_region["chrom"],
        start=rich_daf_region["cluster_start"],
        end=rich_daf_region["cluster_end"],
        dataset_id=dataset_id,
    )
    assert sum(meta["nucleosome_profile"]) > 0
    assert sum(meta["subnuc_profile"]) > 0
