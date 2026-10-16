from types import SimpleNamespace

import pandas as pd

from models.domain import WorkingSet
from models.requests import (
    BrowserActionsRequest,
    GotoGeneRequest,
    GotoRequest,
    JupyterBrowserSettingsRequest,
    JupyterBrowserSettingsSnapshotRequest,
    JupyterFilterRequest,
    MotifSearchRequest,
    PushReadsRequest,
    ReadOrderRequest,
    SequenceRequest,
    SequenceRegion,
    SyncPeaksRequest,
)
from services.jupyter_endpoint import (
    clear_all_jupyter_state,
    clear_read_filter,
    clear_read_order,
    get_analysis_state_payload,
    get_browser_order_payload,
    get_browser_settings_payload,
    get_clusters_payload,
    get_current_region_payload,
    get_custom_reads_payload,
    get_peaks_payload,
    get_reads_payload,
    get_read_filter_payload,
    get_read_order_payload,
    get_session_manifest_payload,
    get_sequences_for_request,
    get_selection_payload,
    goto_gene_for_request,
    goto_region_for_request,
    push_reads_for_request,
    queue_browser_actions_for_request,
    queue_browser_settings_update,
    request_refresh,
    set_read_filter_for_request,
    set_read_order_for_request,
    set_selection,
    search_motifs_for_request,
    sync_browser_settings_for_request,
    sync_browser_order_for_request,
    sync_peaks_for_request,
)


class FakeJupyterState:
    def __init__(self):
        self.version = 0
        self.target_region = None
        self.custom_reads = {}
        self.read_order = {}
        self.browser_read_order = {}
        self.read_filter = {}
        self.selected_reads = []
        self.selected_read_ids_by_dataset = {}
        self.browser_settings = {}
        self.custom_motifs = {}
        self.peaks = []
        self.pending_settings_update = None
        self.pending_browser_actions = []
        self.refresh_requested = False

    def clear_all(self):
        self.custom_reads.clear()
        self.read_order.clear()
        self.browser_read_order.clear()
        self.read_filter.clear()
        self.selected_reads.clear()
        self.selected_read_ids_by_dataset.clear()
        self.browser_settings.clear()
        self.custom_motifs.clear()
        self.peaks.clear()
        self.pending_settings_update = None
        self.pending_browser_actions.clear()
        self.refresh_requested = False
        self.version += 1


class FakeBrowserState:
    dataset_order = ["ds1"]
    chroms = [SimpleNamespace(name="chr2L")]

    def __init__(self):
        self.datasets = {
            "ds1": SimpleNamespace(
                cluster_assignments={"r1": 0, "r2": 0, "r3": 1},
                cluster_element_info=None,
                cluster_peak_regions=None,
            )
        }
        self.gtf_data = {
            "transcripts": pd.DataFrame([
                {"gene_name": "eve", "chrom": "chr2R", "start": 1000, "end": 2000}
            ])
        }

    def translate_chrom(self, chrom):
        return chrom

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning, *args, **kwargs):
        return WorkingSet(
            [{"id": "r1", "intervals": [[0, 10, 5], [10, 20, -1]]}],
            total_overlapping=3,
            total_spanning=2,
            chrom=chrom,
            start=start,
            end=end,
        )


def test_jupyter_region_and_goto_updates_browser_and_command_state():
    state = FakeBrowserState()
    jupyter = FakeJupyterState()

    assert get_current_region_payload(state) == {"chrom": "chr2L", "start": 0, "end": 10000}
    result = goto_region_for_request(state, jupyter, GotoRequest(chrom="chr3R", start=10, end=20))

    assert result == {"success": True, "region": {"chrom": "chr3R", "start": 10, "end": 20}}
    assert state._current_chrom == "chr3R"
    assert jupyter.version == 1


def test_jupyter_goto_gene_uses_padding_and_gene_name():
    state = FakeBrowserState()
    jupyter = FakeJupyterState()

    result = goto_gene_for_request(state, jupyter, GotoGeneRequest(gene="EVE", padding=100))

    assert result["success"] is True
    assert result["region"] == {"chrom": "chr2R", "start": 900, "end": 2100, "gene": "eve"}
    assert jupyter.version == 1


def test_jupyter_browser_actions_are_queued_for_frontend_execution():
    jupyter = FakeJupyterState()

    result = queue_browser_actions_for_request(
        FakeBrowserState(),
        jupyter,
        BrowserActionsRequest(
            label="Notebook",
            actions=[{"type": "cluster_selected_peaks"}, {"not": "a known action"}],
        ),
    )

    assert result == {"success": True, "queued": 2, "label": "Notebook"}
    assert jupyter.pending_browser_actions[0]["label"] == "Notebook"
    assert jupyter.pending_browser_actions[0]["action"] == {"type": "cluster_selected_peaks"}
    assert jupyter.version == 1


def test_jupyter_browser_actions_attach_gene_tss_context():
    jupyter = FakeJupyterState()

    result = queue_browser_actions_for_request(
        FakeBrowserState(),
        jupyter,
        BrowserActionsRequest(
            label="Notebook",
            actions=[{"type": "cluster_peak_at_gene_tss", "gene": "eve"}],
        ),
    )

    action = jupyter.pending_browser_actions[0]["action"]
    assert result["queued"] == 1
    assert action["gene_name"] == "eve"
    assert action["chrom"] == "chr2R"
    assert action["tss"] == 1000
    assert action["gene"]["start"] == 1000


def test_jupyter_clusters_and_reads_payloads():
    state = FakeBrowserState()

    clusters = get_clusters_payload(state, "ds1")
    reads = get_reads_payload(state, dataset_id="ds1", chrom="chr2L", start=100, end=200)

    assert clusters["cluster_counts"] == {0: 2, 1: 1}
    assert reads["count"] == 1
    assert reads["reads"][0]["chrom"] == "chr2L"
    assert reads["reads"][0]["n_footprints"] == 1
    assert reads["reads"][0]["footprint_bases"] == 10
    assert reads["total_spanning"] == 2


def test_push_reads_allocates_custom_dataset_and_versions_state():
    jupyter = FakeJupyterState()

    result = push_reads_for_request(
        jupyter,
        PushReadsRequest(label="Subset", reads=[{"id": "r1", "intervals": []}]),
    )

    assert result == {"success": True, "dataset_id": "jupyter_0", "count": 1, "label": "Subset"}
    assert jupyter.custom_reads["jupyter_0"][0]["id"] == "r1"
    assert jupyter.version == 1


def test_read_order_commands_mutate_command_order_without_browser_order_version_bump():
    state = FakeBrowserState()
    jupyter = FakeJupyterState()

    result = set_read_order_for_request(
        state,
        jupyter,
        ReadOrderRequest(dataset_id="ds1", read_ids=["r2", "r1"]),
    )
    browser_result = sync_browser_order_for_request(
        state,
        jupyter,
        ReadOrderRequest(dataset_id="ds1", read_ids=["r1", "r2"]),
    )

    assert result == {"success": True, "dataset_id": "ds1", "count": 2}
    assert get_read_order_payload(state, jupyter, "ds1")["read_ids"] == ["r2", "r1"]
    assert browser_result == {"success": True, "dataset_id": "ds1", "count": 2}
    assert get_browser_order_payload(state, jupyter, "ds1")["read_ids"] == ["r1", "r2"]
    assert jupyter.version == 1

    clear_read_order(state, jupyter, "ds1")
    assert get_read_order_payload(state, jupyter, "ds1")["read_ids"] == []
    assert jupyter.version == 2


def test_read_filter_commands_report_active_state_and_clear_by_dataset():
    state = FakeBrowserState()
    jupyter = FakeJupyterState()

    result = set_read_filter_for_request(
        state,
        jupyter,
        JupyterFilterRequest(dataset_id="ds1", read_ids=["r1"]),
    )

    assert result == {"success": True, "dataset_id": "ds1", "count": 1}
    assert get_read_filter_payload(state, jupyter, "ds1") == {
        "read_ids": ["r1"],
        "dataset_id": "ds1",
        "active": True,
    }

    clear_read_filter(state, jupyter, "ds1")
    assert get_read_filter_payload(state, jupyter, "ds1")["active"] is False
    assert jupyter.version == 2


def test_selection_prefers_command_state_over_synced_browser_state():
    state = FakeBrowserState()
    jupyter = FakeJupyterState()
    jupyter.browser_settings["selected_read_ids"] = {"ds1": ["synced"]}

    assert get_selection_payload(state, jupyter, "ds1")["read_ids"] == ["synced"]

    result = set_selection(state, jupyter, ["commanded"], "ds1")

    assert result == {"success": True, "dataset_id": "ds1", "count": 1}
    assert get_selection_payload(state, jupyter, "ds1") == {
        "read_ids": ["commanded"],
        "dataset_id": "ds1",
        "read_ids_by_dataset": {"ds1": ["commanded"]},
    }
    assert get_selection_payload(state, jupyter)["read_ids"] == ["commanded"]
    assert jupyter.version == 1


def test_refresh_custom_reads_and_clear_all_helpers():
    jupyter = FakeJupyterState()
    jupyter.custom_reads["ds1"] = [{"id": "r1"}]

    assert get_custom_reads_payload(jupyter, "ds1") == {"reads": [{"id": "r1"}], "count": 1}
    assert request_refresh(jupyter) == {"success": True}
    assert jupyter.refresh_requested is True

    assert clear_all_jupyter_state(jupyter) == {"success": True}
    assert jupyter.custom_reads == {}
    assert jupyter.refresh_requested is False
    assert jupyter.version == 2


def test_peak_payloads_filter_selected_and_sync_chrom():
    jupyter = FakeJupyterState()

    result = sync_peaks_for_request(
        jupyter,
        SyncPeaksRequest(
            chrom="chr2L",
            peaks=[
                {"start": 10, "end": 20, "isSelected": True},
                {"start": 30, "end": 40, "isSelected": False},
            ],
        ),
    )

    assert result == {"success": True, "count": 2}
    assert get_peaks_payload(jupyter)["count"] == 2
    selected = get_peaks_payload(jupyter, selected_only=True)
    assert selected["count"] == 1
    assert selected["chrom"] == "chr2L"
    assert selected["peaks"][0]["chrom"] == "chr2L"
    assert jupyter.version == 1


def test_consecutive_settings_calls_before_a_poll_both_apply():
    jupyter = FakeJupyterState()
    queue_browser_settings_update(jupyter, JupyterBrowserSettingsRequest(analysis_sample_seed="s1", cluster_k=4))
    queue_browser_settings_update(jupyter, JupyterBrowserSettingsRequest(cluster_k=6))
    assert jupyter.pending_settings_update == {"analysis_sample_seed": "s1", "cluster_k": 6}


def test_browser_settings_queue_and_sync_normalize_layer_aliases():
    jupyter = FakeJupyterState()

    queued = queue_browser_settings_update(
        jupyter,
        JupyterBrowserSettingsRequest(
            enabled_mod_types={"msp": True},
            click_target_layer="msp",
            cluster_feature_rules=[{"id": "cluster-a"}],
            analysis_sort_rules=[{"id": "sort-a"}],
            analysis_filter_rules=[{"id": "filter-a"}],
            selected_genes=[{"id": "tx1", "name": "GeneA"}],
            transcription_state_filters={"pause": True},
            primer_saved_primers=[{"name": "PrimerA"}],
            primer_mode="standard",
            primer_cart_track_display="design",
            peak_modes={"7": "accessibility"},
        ),
    )

    assert queued == {"success": True, "updated": [
        "analysis_filter_rules",
        "analysis_sort_rules",
        "click_target_layer",
        "cluster_feature_rules",
        "enabled_mod_types",
        "peak_modes",
        "primer_cart_track_display",
        "primer_mode",
        "primer_saved_primers",
        "selected_genes",
        "transcription_state_filters",
    ]}
    assert jupyter.pending_settings_update == {
        "enabled_mod_types": {"fire": True},
        "click_target_layer": "fire",
        "cluster_feature_rules": [{"id": "cluster-a"}],
        "analysis_sort_rules": [{"id": "sort-a"}],
        "analysis_filter_rules": [{"id": "filter-a"}],
        "selected_genes": [{"id": "tx1", "name": "GeneA"}],
        "transcription_state_filters": {"pause": True},
        "primer_saved_primers": [{"name": "PrimerA"}],
        "primer_mode": "standard",
        "primer_cart_track_display": "design",
        "peak_modes": {"7": "accessibility"},
    }

    synced = sync_browser_settings_for_request(
        jupyter,
        JupyterBrowserSettingsSnapshotRequest(
            session_manifest={"name": "saved"},
            active_quality_filters=[{"layer": "msp"}],
            read_display_mode="fit",
            cluster_feature_rules=[{"id": "cluster-synced"}],
            analysis_sort_rules=[{"id": "sort-synced"}],
            analysis_filter_rules=[{"id": "filter-synced"}],
            selected_genes=[{"id": "tx2", "name": "GeneB"}],
            transcription_state_filters={"elongating": 1},
            primer_saved_primers=[{"name": "PrimerB"}],
            primer_mode="4c",
            primer_cart_track_display="all",
        ),
    )

    assert synced["success"] is True
    assert get_browser_settings_payload(jupyter)["settings"]["active_quality_filters"] == [{"layer": "fire"}]
    analysis_state = get_analysis_state_payload(jupyter)
    assert analysis_state["analysis_rules"]["cluster_feature_rules"] == [{"id": "cluster-synced"}]
    assert analysis_state["analysis_rules"]["analysis_sort_rules"] == [{"id": "sort-synced"}]
    assert analysis_state["analysis_rules"]["analysis_filter_rules"] == [{"id": "filter-synced"}]
    assert analysis_state["selected_genes"] == [{"id": "tx2", "name": "GeneB"}]
    assert analysis_state["transcription_state_filters"] == {"elongating": 1}
    assert analysis_state["primers"] == {
        "saved_primers": [{"name": "PrimerB"}],
        "mode": "4c",
        "cart_track_display": "all",
    }
    assert get_session_manifest_payload(jupyter) == {"manifest": {"name": "saved"}}
    assert analysis_state["manifest"] == {"name": "saved"}


def test_sequence_endpoint_reports_missing_fasta_before_loading():
    state = FakeBrowserState()
    state.primer_fasta = None

    result = get_sequences_for_request(
        state,
        SequenceRequest(regions=[SequenceRegion(chrom="chr2L", start=0, end=4)]),
    )

    assert result == {
        "success": False,
        "error": "FASTA file not configured. Use set_fasta() or configure via primer panel.",
        "sequences": [],
    }


def test_motif_search_endpoint_requires_regions_or_synced_peaks():
    state = FakeBrowserState()
    state.primer_fasta = None
    jupyter = FakeJupyterState()

    result = search_motifs_for_request(state, jupyter, MotifSearchRequest())

    assert result == {
        "success": False,
        "error": "No regions provided and no peaks synced from browser",
        "hits": [],
    }
