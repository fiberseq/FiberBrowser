"""BrowserClient headless mode workflow tests.

Uses BrowserClient.headless() to start a real server process with real data.
Tests exercise the full client API for navigation, analysis, and rendering.

Marked @pytest.mark.integration + @pytest.mark.slow — skip with:
  python -m pytest -m "not slow"
"""

import os
import tempfile

import pytest

from conftest import (
    FP_BIGBED,
    GTF_PATH,
    FASTA_PATH,
    data_file_available,
    require_data_file,
    DROSOPHILA_CHROM,
    DROSOPHILA_START,
    DROSOPHILA_END,
)

pytestmark = [pytest.mark.integration, pytest.mark.slow]


@pytest.fixture(scope="module")
def headless_client():
    """Start a headless FiberBrowser server for the test module.

    Session-scoped to avoid starting/stopping the server for each test.
    """
    require_data_file(FP_BIGBED, "Footprint BigBed")

    # Import here since browser_client is at project root
    import sys
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    from browser_client import BrowserClient

    kwargs = {"bam": str(FP_BIGBED), "quiet": True, "timeout": 60}
    if data_file_available(GTF_PATH):
        kwargs["gtf"] = str(GTF_PATH)
    if data_file_available(FASTA_PATH):
        kwargs["fasta"] = str(FASTA_PATH)

    client = BrowserClient.headless(**kwargs)
    yield client
    client.close()


class TestHeadlessLifecycle:
    """End-to-end tests using BrowserClient in headless mode."""

    def test_startup_and_status(self, headless_client):
        """Headless server should start and report loaded datasets."""
        status = headless_client.get_status()
        assert status is not None
        # Should have at least 1 dataset
        datasets = headless_client.get_datasets()
        assert len(datasets) >= 1

    def test_navigate_and_get_reads(self, headless_client):
        """goto() + get_reads() returns a DataFrame with reads."""
        headless_client.goto(DROSOPHILA_CHROM, DROSOPHILA_START, DROSOPHILA_END)

        reads = headless_client.get_reads(as_dataframe=True)
        assert reads is not None
        assert len(reads) > 0
        assert "id" in reads.columns or "read_id" in reads.columns

    def test_add_remove_dataset(self, headless_client):
        """add_dataset() → verify 2 datasets → remove_dataset() → back to 1."""
        initial = headless_client.get_datasets()
        initial_count = len(initial)

        # Add second dataset (same BigBed file)
        result = headless_client.add_dataset(path=str(FP_BIGBED), label="test_dup")
        assert result.get("success")
        new_id = result["dataset"]["id"]

        assert len(headless_client.get_datasets()) == initial_count + 1

        # Remove
        headless_client.remove_dataset(new_id)
        assert len(headless_client.get_datasets()) == initial_count

    def test_scan_cluster_workflow(self, headless_client):
        """scan_peaks() → cluster_all() → get_clusters() verifies assignments."""
        headless_client.goto(DROSOPHILA_CHROM, DROSOPHILA_START, DROSOPHILA_END)

        # Scan peaks
        peaks = headless_client.scan_peaks()
        assert peaks is not None
        peak_list = peaks.get("peaks", [])
        if len(peak_list) == 0:
            pytest.skip("No peaks found in region")

        # Cluster using first few peaks
        peak_regions = [
            {"start": p["start"], "end": p["end"], "mode": "accessibility"}
            for p in peak_list[:5]
        ]

        cluster_result = headless_client.cluster_all(
            peak_regions=peak_regions,
            k=3,
            method="combinatorial",
        )
        assert cluster_result is not None

        # Get cluster assignments
        clusters = headless_client.get_clusters()
        assert clusters is not None
        assert clusters.get("n_reads", 0) > 0
        assert clusters.get("n_clusters", 0) > 0

    def test_session_roundtrip(self, headless_client):
        """save_session() → load_session() → verify region preserved."""
        headless_client.goto(DROSOPHILA_CHROM, DROSOPHILA_START, DROSOPHILA_END)

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            tmp_path = f.name

        try:
            headless_client.save_session(tmp_path)
            assert os.path.exists(tmp_path)
            assert os.path.getsize(tmp_path) > 100  # Non-trivial content

            # Load it back
            result = headless_client.load_session(tmp_path)
            assert result is not None
            assert result.get("success")

            # Verify region is in the response
            viewport = result.get("viewport", {})
            assert viewport.get("start") == DROSOPHILA_START
            assert viewport.get("end") == DROSOPHILA_END
        finally:
            os.unlink(tmp_path)

    def test_render_image(self, headless_client):
        """render() returns a PIL Image with nonzero dimensions."""
        headless_client.goto(DROSOPHILA_CHROM, DROSOPHILA_START, DROSOPHILA_END)

        img = headless_client.render()
        assert img is not None
        assert img.width > 0
        assert img.height > 0

    def test_context_manager_cleanup(self):
        """Server process should be terminated after 'with' block exits."""
        require_data_file(FP_BIGBED, "Footprint BigBed")

        import sys
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if project_root not in sys.path:
            sys.path.insert(0, project_root)

        from browser_client import BrowserClient

        with BrowserClient.headless(bam=str(FP_BIGBED), quiet=True, timeout=60) as client:
            proc = client._headless_proc
            assert proc is not None
            assert proc.poll() is None  # Still running

        # After exit, process should be terminated
        # Give it a moment to clean up
        import time
        time.sleep(1)
        assert proc.poll() is not None, "Headless server process was not terminated"
