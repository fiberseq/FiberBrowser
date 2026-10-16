"""Backend multi-step API workflow tests.

Uses Starlette TestClient (in-process, no subprocess) with real Drosophila
BigBed + GTF + FASTA data loaded into BrowserState.

All tests are marked @pytest.mark.integration and skip gracefully
if the DAF-seq time-course dataset is not available.
"""

import json
import tempfile

import pytest

from conftest import (
    DROSOPHILA_CHROM,
    DROSOPHILA_START,
    DROSOPHILA_END,
    DROSOPHILA_REGION_WIDTH,
)

pytestmark = pytest.mark.integration

# Region B — shifted 2kb for navigation tests (stays within data range ~6854k-6872k)
REGION_B_START = DROSOPHILA_START + 2000
REGION_B_END = DROSOPHILA_END + 2000


def _first_dataset_id(client):
    datasets = client.get("/api/datasets").json()["datasets"]
    assert datasets
    return datasets[0]["id"]


# ============================================================================
# Data Loading Workflows
# ============================================================================


class TestDataLoadingWorkflow:
    """Load data through the API, verify reads come back correctly."""

    def test_load_bigbed_and_get_reads(self, loaded_client):
        """GET /api/reads/compact returns reads with interval structure."""
        dataset_id = _first_dataset_id(loaded_client)
        resp = loaded_client.get("/api/reads/compact", params={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
            "dataset_id": dataset_id,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] > 0
        assert data["width"] == DROSOPHILA_REGION_WIDTH

        # Spot-check a read
        read = data["reads"][0]
        assert "id" in read
        assert "intervals" in read
        assert len(read["intervals"]) > 0
        # Intervals are [start, end, size] tuples
        iv = read["intervals"][0]
        assert len(iv) >= 3
        assert iv[1] > iv[0]  # end > start

    def test_chroms_endpoint(self, loaded_client):
        """GET /api/chroms returns chromosome list."""
        resp = loaded_client.get("/api/chroms")
        assert resp.status_code == 200
        chroms = resp.json()["chroms"]
        assert len(chroms) > 0
        # Each chrom should have name and size
        assert "name" in chroms[0]
        assert "size" in chroms[0]
        assert chroms[0]["size"] > 0

    def test_add_remove_dataset(self, loaded_client):
        """Add a second BigBed via API, verify 2 datasets, remove it, verify 1."""
        from conftest import FP_BIGBED

        # Check starting count
        resp = loaded_client.get("/api/datasets")
        initial_count = len(resp.json()["datasets"])

        # Add second dataset (same file, different ID)
        resp = loaded_client.post("/api/datasets/add", json={
            "path": str(FP_BIGBED),
            "label": "test_duplicate",
        })
        assert resp.status_code == 200
        result = resp.json()
        assert result["success"]
        new_ds_id = result["dataset"]["id"]

        # Verify count increased
        resp = loaded_client.get("/api/datasets")
        assert len(resp.json()["datasets"]) == initial_count + 1

        # Remove it
        resp = loaded_client.delete(f"/api/datasets/{new_ds_id}")
        assert resp.status_code == 200
        assert resp.json()["success"]

        # Verify count restored
        resp = loaded_client.get("/api/datasets")
        assert len(resp.json()["datasets"]) == initial_count

    def test_load_gtf_and_get_genes(self, loaded_client):
        """GET /api/genes returns gene annotations in the region."""
        resp = loaded_client.get("/api/genes", params={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
        })
        assert resp.status_code == 200
        genes = resp.json()["genes"]
        # The hsp70 locus should have genes
        assert len(genes) > 0
        gene = genes[0]
        assert "name" in gene
        assert "chrom" in gene
        assert "start" in gene
        assert "end" in gene
        assert "strand" in gene


# ============================================================================
# Navigation Workflows
# ============================================================================


class TestNavigationWorkflow:
    """Navigate via Jupyter API, verify region tracking and data changes."""

    def test_goto_and_get_region(self, loaded_client):
        """POST /api/jupyter/goto then GET /api/jupyter/region verifies coords."""
        resp = loaded_client.post("/api/jupyter/goto", json={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
        })
        assert resp.status_code == 200
        assert resp.json()["success"]

        resp = loaded_client.get("/api/jupyter/region")
        assert resp.status_code == 200
        region = resp.json()
        assert region["start"] == DROSOPHILA_START
        assert region["end"] == DROSOPHILA_END

    def test_reads_change_with_navigation(self, loaded_client):
        """Reads at region A differ from reads at region B."""
        dataset_id = _first_dataset_id(loaded_client)
        # Fetch reads at region A
        resp_a = loaded_client.get("/api/reads/compact", params={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
            "dataset_id": dataset_id,
        })
        reads_a = {r["id"] for r in resp_a.json()["reads"]}

        # Navigate to region B (shifted 10kb)
        loaded_client.post("/api/jupyter/goto", json={
            "chrom": DROSOPHILA_CHROM,
            "start": REGION_B_START,
            "end": REGION_B_END,
        })

        # Fetch reads at region B
        resp_b = loaded_client.get("/api/reads/compact", params={
            "chrom": DROSOPHILA_CHROM,
            "start": REGION_B_START,
            "end": REGION_B_END,
            "dataset_id": dataset_id,
        })
        reads_b = {r["id"] for r in resp_b.json()["reads"]}

        # The two read sets should not be identical
        # (10kb shift means mostly different reads, though some may overlap)
        assert reads_a != reads_b

    def test_meta_profiles_for_region(self, loaded_client):
        """Meta profiles should have non-empty nucleosome and subnucleosomal data."""
        dataset_id = _first_dataset_id(loaded_client)
        resp = loaded_client.get("/api/meta", params={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
            "dataset_id": dataset_id,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["nucleosome_profile"]) > 0
        assert len(data["subnuc_profile"]) > 0
        # At least some signal should exist
        assert sum(data["nucleosome_profile"]) > 0 or sum(data["subnuc_profile"]) > 0


# ============================================================================
# Analysis Workflows
# ============================================================================


class TestAnalysisWorkflow:
    """Multi-step analysis: scan peaks -> cluster -> sort -> export."""

    def test_scan_peaks_then_cluster(self, loaded_client):
        """Scan peaks, then cluster with combinatorial method."""
        dataset_id = _first_dataset_id(loaded_client)
        # Navigate first
        loaded_client.post("/api/jupyter/goto", json={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
        })

        # Scan peaks
        resp = loaded_client.post(
            "/api/scan_peaks",
            params={
                "chrom": DROSOPHILA_CHROM,
                "start": DROSOPHILA_START,
                "end": DROSOPHILA_END,
                "dataset_id": dataset_id,
            },
            json={},
        )
        assert resp.status_code == 200
        peaks_data = resp.json()
        assert len(peaks_data["peaks"]) > 0, "No peaks found in active region"

        # Use the first few peaks for clustering
        peak_regions = [
            {"start": p["start"], "end": p["end"], "mode": "accessibility"}
            for p in peaks_data["peaks"][:5]
        ]

        # Cluster reads
        resp = loaded_client.post(
            "/api/cluster_all",
            params={
                "chrom": DROSOPHILA_CHROM,
                "start": DROSOPHILA_START,
                "end": DROSOPHILA_END,
            },
            json={
                "peak_regions": peak_regions,
                "k": 3,
                "method": "combinatorial",
                "dataset_ids": [dataset_id],
            },
        )
        assert resp.status_code == 200
        cluster_data = resp.json()
        assert "results" in cluster_data

        # Verify the loaded dataset got assignments
        dataset_result = cluster_data["results"][dataset_id]
        assert len(dataset_result["assignments"]) > 0
        assert sum(dataset_result["cluster_counts"].values()) > 0

    def test_sort_reads_after_cluster(self, loaded_client):
        """Cluster then sort — verify sorted order is returned."""
        dataset_id = _first_dataset_id(loaded_client)
        # Navigate + scan + cluster
        loaded_client.post("/api/jupyter/goto", json={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
        })

        resp = loaded_client.post(
            "/api/scan_peaks",
            params={
                "chrom": DROSOPHILA_CHROM,
                "start": DROSOPHILA_START,
                "end": DROSOPHILA_END,
                "dataset_id": dataset_id,
            },
            json={},
        )
        peaks = resp.json()["peaks"][:3]
        if len(peaks) == 0:
            pytest.skip("No peaks found")

        peak_regions = [
            {"start": p["start"], "end": p["end"], "mode": "accessibility"}
            for p in peaks
        ]

        loaded_client.post(
            "/api/cluster_all",
            params={
                "chrom": DROSOPHILA_CHROM,
                "start": DROSOPHILA_START,
                "end": DROSOPHILA_END,
            },
            json={
                "peak_regions": peak_regions,
                "k": 3,
                "method": "combinatorial",
                "dataset_ids": [dataset_id],
            },
        )

        # Sort reads
        resp = loaded_client.post(
            "/api/sort_reads",
            params={
                "chrom": DROSOPHILA_CHROM,
                "start": DROSOPHILA_START,
                "end": DROSOPHILA_END,
                "dataset_id": dataset_id,
            },
            json={"sort_by": "fp_count"},
        )
        assert resp.status_code == 200
        sort_data = resp.json()
        # Response has {results: {dataset_id: {read_sort_order, cluster_order}}}
        assert "results" in sort_data
        dataset_sort = sort_data["results"][dataset_id]
        assert len(dataset_sort["read_sort_order"]) > 0

    def test_session_export_import_roundtrip(self, loaded_client):
        """Export session, import it back, verify region and datasets match."""
        # Navigate to a known location
        loaded_client.post("/api/jupyter/goto", json={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
        })

        # Export session
        frontend_state = {
            "analysisSampleSeed": "paper-seed",
            "analysisSampleCount": 5000,
            "downsampleCount": 1000,
            "peaksLocked": True,
            "selectedPeaks": [1],
            "peakRules": [{"id": "rule-a", "source": "accessibility", "enabled": True}],
            "peaksByRule": {"rule-a": [{"chrom": DROSOPHILA_CHROM, "start": DROSOPHILA_START, "end": DROSOPHILA_START + 50}]},
            "captureRegions": [{"id": "cap1", "chrom": DROSOPHILA_CHROM, "start": DROSOPHILA_START, "end": DROSOPHILA_START + 100}],
            "activeColormap": {"name": "Paper", "rules": [], "qualityFilters": [{"layer": "fire", "qualityName": "aq", "minValue": 230, "enabled": True}]},
            "catalog": [{"id": "cat1", "source": "local", "kind": "bigbed", "label": "TF", "path": "/tmp/tf.bb", "loaded": False, "unavailable": True}],
            "compositeTracks": [{"id": "comp1", "label": "TF", "kind": "annotation", "sources": [], "scaleMode": "auto", "logScale": False, "visible": True, "groupAutoscaleSelected": False, "showAxes": True}],
            "savedTracks": [{"id": "saved1", "name": "TF saved", "savedAt": "2026-04-30T00:00:00Z", "composite": {"label": "TF", "kind": "annotation", "sources": [], "scaleMode": "auto", "logScale": False, "visible": True, "groupAutoscaleSelected": False, "showAxes": True}}],
            "sessionManifest": {"sessionName": "workflow", "reproducibility": {"seed": "paper-seed"}, "warnings": []},
        }
        resp = loaded_client.post("/api/session/export", json={
            "chrom": DROSOPHILA_CHROM,
            "start": DROSOPHILA_START,
            "end": DROSOPHILA_END,
            "frontend_state": frontend_state,
        })
        assert resp.status_code == 200
        session_data = resp.json()
        assert session_data["version"] == "2.0"
        assert session_data["viewport"]["chrom"] == DROSOPHILA_CHROM
        assert len(session_data["datasets"]) >= 1
        assert session_data["frontend"]["analysisSampleSeed"] == "paper-seed"
        assert session_data["frontend"]["sessionManifest"]["reproducibility"]["seed"] == "paper-seed"
        assert session_data["frontend"]["captureRegions"][0]["id"] == "cap1"
        assert session_data["frontend"]["catalog"][0]["id"] == "cat1"

        # Import session back
        resp = loaded_client.post("/api/session/import", json={
            "session": session_data,
        })
        assert resp.status_code == 200
        import_result = resp.json()
        assert import_result["success"]
        assert import_result["results"]["datasets_loaded"] >= 1
        assert import_result["frontend"]["analysisSampleSeed"] == "paper-seed"
        assert import_result["frontend"]["peaksLocked"] is True
        assert import_result["frontend"]["captureRegions"][0]["id"] == "cap1"
        assert import_result["frontend"]["compositeTracks"][0]["id"] == "comp1"

        # Verify viewport was passed through
        assert import_result["viewport"]["chrom"] == DROSOPHILA_CHROM
        assert import_result["viewport"]["start"] == DROSOPHILA_START
