"""Real HTTP BrowserClient parity workflow for live/headless browser control."""

from __future__ import annotations

import pytest

from browser_client import BrowserClient


pytestmark = [pytest.mark.integration, pytest.mark.slow]


def _layer_interval_count(read: dict, layer: str) -> int:
    """Count intervals from direct fields or canonical nested layer payloads."""
    direct = read.get(layer)
    if isinstance(direct, list):
        return len(direct)
    layer_payload = (read.get("layers") or {}).get(layer)
    if isinstance(layer_payload, dict):
        return len(layer_payload.get("intervals") or [])
    if isinstance(layer_payload, list):
        return len(layer_payload)
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


def test_headless_browser_client_roundtrip_with_rich_daf(
    rich_daf_bam_path,
    rich_daf_region,
):
    """Launch a real server and verify notebook controls reach the live browser."""
    pd = pytest.importorskip("pandas")

    chrom = rich_daf_region["chrom"]
    cluster_start = rich_daf_region["cluster_start"]
    cluster_end = rich_daf_region["cluster_end"]
    seed = "headless-rich-daf-parity"

    with BrowserClient.headless(bam=rich_daf_bam_path, timeout=60, quiet=True) as client:
        datasets = client.get_datasets()
        assert len(datasets) == 1
        dataset_id = datasets[0]["id"]
        _assert_dataset_layers_match_reads_route(client, datasets[0], rich_daf_region)

        assert client.goto(chrom, cluster_start, cluster_end)["success"] is True
        client.set_reproducibility(
            seed=seed,
            analysis_cap=300,
            display_cap=150,
            display_mode="sample",
            all_reads_display_cap=1000,
            profile_read_cap=500,
            spanning=False,
        )
        state = client.get_jupyter_state()
        assert state["goto"] == {"chrom": chrom, "start": cluster_start, "end": cluster_end}
        settings = state["settings_update"]
        assert settings["analysis_sample_seed"] == seed
        assert settings["analysis_sample_count"] == 300
        assert settings["display_sample_count"] == 150
        assert settings["read_display_mode"] == "sample"
        assert settings["all_reads_display_cap"] == 1000
        assert settings["background_read_cap"] == 500
        assert settings["spanning_only"] is False

        client.set_visible_layers(tf=True, nuc=True, fire=True, deam=False)
        settings = client.get_jupyter_state()["settings_update"]
        assert settings["enabled_mod_types"] == {"tf": True, "nuc": True, "fire": True, "deam": False}

        client.set_metaprofile_layers(tf=True, nuc=True, fire=True)
        settings = client.get_jupyter_state()["settings_update"]
        assert settings["enabled_meta_profiles"] == {"tf": True, "nuc": True, "fire": True}

        client.set_layer_cache(tf=True, nuc=True, fire=True, deam=False)
        settings = client.get_jupyter_state()["settings_update"]
        assert settings["cached_layer_types"] == {"tf": True, "nuc": True, "fire": True, "deam": False}

        reads = client.get_compact_reads(
            chrom=chrom,
            start=rich_daf_region["start"],
            end=rich_daf_region["end"],
            dataset_id=dataset_id,
            spanning=False,
            include_methylation=False,
            layer_names=["tf", "nuc", "fire"],
            max_reads=150,
            sample_seed=seed,
        )
        assert reads
        assert _has_layer_intervals(reads, "tf")
        assert _has_layer_intervals(reads, "nuc")
        assert _has_layer_intervals(reads, "fire") or _has_layer_intervals(reads, "msp")

        selected_ids = [read["id"] for read in reads[:4]]
        assert client.set_read_order(selected_ids, dataset_id=dataset_id)["success"] is True
        assert client.set_read_filter(selected_ids[:3], dataset_id=dataset_id)["success"] is True
        assert client.set_jupyter_selection(selected_ids[:2], dataset_id=dataset_id)["success"] is True
        state = client.get_jupyter_state()
        assert state["read_order"][dataset_id] == selected_ids
        assert state["read_filter"][dataset_id] == selected_ids[:3]
        assert state["selected_read_ids"][dataset_id] == selected_ids[:2]

        pushed_reads = pd.DataFrame([
            {"id": "notebook_read_1", "intervals": reads[0]["intervals"]},
            {"id": "notebook_read_2", "intervals": reads[1]["intervals"]},
        ])
        push = client.push_reads(reads_df=pushed_reads, label="Headless notebook subset")
        assert push["success"] is True
        assert push["count"] == 2
        state = client.get_jupyter_state()
        assert [read["id"] for read in state["pushed_reads"]] == ["notebook_read_1", "notebook_read_2"]

        scan = client.scan_peaks(
            chrom=chrom,
            start=cluster_start,
            end=cluster_end,
            dataset_ids=[dataset_id],
            signal_source="tf_layer",
            spanning=False,
            min_reads=3,
            sample_seed=seed,
        )
        assert scan["peaks"], "Expected TF-layer peaks in rich DAF headless fixture"
        peak = scan["peaks"][0]
        peak_regions = [{"start": peak["start"], "end": peak["end"], "mode": "tf_layer"}]

        cluster_a = client.cluster_all(
            chrom=chrom,
            start=cluster_start,
            end=cluster_end,
            peak_regions=peak_regions,
            k=3,
            method="kmeans",
            dataset_ids=[dataset_id],
            spanning=False,
            max_reads=150,
            sample_seed=seed,
        )
        cluster_b = client.cluster_all(
            chrom=chrom,
            start=cluster_start,
            end=cluster_end,
            peak_regions=peak_regions,
            k=3,
            method="kmeans",
            dataset_ids=[dataset_id],
            spanning=False,
            max_reads=150,
            sample_seed=seed,
        )
        result_a = cluster_a["results"][dataset_id]
        result_b = cluster_b["results"][dataset_id]
        assert result_a["analysis_read_count"] <= 150
        assert result_a["assignments"]
        assert result_a["assignments"] == result_b["assignments"]
        assert result_a["cluster_counts"] == result_b["cluster_counts"]

        live_clusters = client.get_clusters(dataset_id)
        assert live_clusters["dataset_id"] == dataset_id
        assert live_clusters["n_reads"] == len(result_b["assignments"])
        assert live_clusters["cluster_counts"] == result_b["cluster_counts"]
