"""B2 round 9 (clustering/analysis) and B3 round 11 #1 (all_fp union bounds)."""
import inspect
import sys
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))


# B2r9 #1: an accessibility peak always loads the MSP layer its feature prefers,
# so a read's feature doesn't depend on whether another peak needed layers.
def test_accessibility_peaks_always_load_the_msp_layer():
    import services.clustering_endpoint as ce
    import services.clustering_inputs as ci
    from services.clustering_features import extract_features_from_compact

    assert ci.cluster_modes_need_layers(["accessibility"]) is True
    assert ci.cluster_modes_requested_layers(["accessibility"]) == ["msp"]
    assert ci.cluster_modes_requested_layers(["accessibility", "nuc"]) is None
    assert ci.cluster_modes_need_layers(["m6a"]) is False
    assert ci.cluster_modes_requested_layers(["off"]) is None
    # Every clustering, projection and reassignment query asks for them.
    source = inspect.getsource(ce)
    assert source.count("requested_layers=cluster_modes_requested_layers(peak_modes)") == 4
    assert "requested_layers=requested_layers" in inspect.getsource(ci.collect_assigned_feature_rows)

    # With the MSP layer loaded, the accessibility feature is the same with or
    # without a nucleosome peak next to it.
    read = {"id": "r", "intervals": [[0, 100, -100], [100, 250, 150]],
            "layers": {"msp": {"intervals": [[0, 20, 20]]}, "nuc": {"intervals": [[100, 250, 150]]}}}
    alone, _, _, _ = extract_features_from_compact([read], [[0, 100]], 0, step=10, peak_modes=["accessibility"])
    paired, _, _, _ = extract_features_from_compact([read], [[0, 100], [100, 250]], 0, step=10,
                                                    peak_modes=["accessibility", "nuc"])
    assert alone[0][:10].tolist() == paired[0][:10].tolist()


# B2r9 #2: the client's analysis-rule helpers keep the rule's quality gates.
def test_client_analysis_rule_payload_keeps_quality_gates():
    from browser_client import BrowserClient as FiberBrowserClient

    term = {"source": "label_rule", "rule": {
        "sizeMin": 10, "sizeMax": 60, "conditions": [],
        "qualityGates": [{"qualityName": "tq", "minValue": 200, "maxValue": None}],
    }}
    payload = FiberBrowserClient._analysis_rule_payload_from_term(term)
    assert payload["quality_gates"] == [{"quality_name": "tq", "min_value": 200.0, "max_value": None}]
    snake = FiberBrowserClient._analysis_rule_payload_from_term(
        {"source": "layer", "size_min": 10, "quality_gates": [{"quality_name": "nq", "min_value": 5, "max_value": 250}]})
    assert snake["quality_gates"] == [{"quality_name": "nq", "min_value": 5.0, "max_value": 250.0}]
    assert FiberBrowserClient._analysis_rule_payload_from_term({"source": "layer"})["quality_gates"] == []


# B2r9 #3: a transcript on another chromosome never supplies coordinates here.
def test_gene_analyses_only_use_transcripts_on_the_query_chromosome():
    from services.filtering_endpoint import _resolve_transcription_genes
    from services.gene_ids import resolve_selected_transcripts
    from services.pol2_endpoint import _resolve_pol2_genes

    tx = pd.DataFrame([
        {"chrom": "chr1", "start": 100, "end": 200, "strand": "+", "transcript_id": "t1", "gene_name": "G1"},
        {"chrom": "2", "start": 500, "end": 900, "strand": "-", "transcript_id": "t2", "gene_name": "G2"},
    ])
    state = SimpleNamespace(gtf_data={"transcripts": tx})
    assert resolve_selected_transcripts(state, ["t1", "t2"], "chr2") == [
        {"id": "t2", "start": 500, "end": 900, "strand": "-", "name": "G2"},  # alias-aware: '2' is chr2
    ]
    assert _resolve_pol2_genes(state, ["t1"], "chr2") == []
    assert _resolve_transcription_genes(state, ["t1"], "chr2") == []
    assert [g["id"] for g in _resolve_transcription_genes(state, ["t1"], "chr1")] == ["t1"]
    # A wrapped copy keeps its shift.
    assert _resolve_pol2_genes(state, ["t1:wrap1000"], "chr1") == [
        {"id": "t1:wrap1000", "start": 1100, "end": 1200, "strand": "+"}]


# B2r9 #4: a branch override doesn't take the latest clustering's patterns.
def test_similarity_sort_ignores_stored_patterns_for_another_branch():
    from services.read_sorting import sort_similarity_for_dataset

    # Stored clustering: clusters 0 and 2 have the closest patterns.
    dataset = SimpleNamespace(
        cluster_assignments={"a": 0, "b": 1, "c": 2},
        cluster_element_info={"cluster_patterns": {0: [1, 1, 1, 1], 1: [0, 0, 0, 0], 2: [1, 1, 1, 0]}},
        cluster_peak_regions=None,
    )
    state = SimpleNamespace(get_dataset=lambda ds: dataset, translate_chrom=lambda c: c)
    stored = sort_similarity_for_dataset(state, "ds", None, None, None, False)["cluster_order"]
    same = sort_similarity_for_dataset(state, "ds", None, None, None, False,
                                       cluster_assignments_override={"a": 0, "b": 1, "c": 2})["cluster_order"]
    assert same == stored  # the stored clustering itself still uses its patterns
    # Another branch reusing the IDs for other reads: sized by its own members
    # (no stored features apply), never ordered by the stored patterns.
    branch = {"a": 1, "b": 1, "c": 1, "d": 0, "e": 2, "f": 2}
    order = sort_similarity_for_dataset(state, "ds", None, None, None, False,
                                        cluster_assignments_override=branch)["cluster_order"]
    assert order == [1, 2, 0]


# B3r11 #1: the all_fp union reads calls at their source bounds, like one layer does.
def test_all_fp_union_uses_source_intervals():
    from services.footprint_analysis import FootprintLayerResolver

    read = {"id": "r", "layers": {
        "tf_sr": {"intervals": [[0, 3, 3]], "source_intervals": [[-2, 3, 5]], "fi": [4], "fq": [9], "fk": [1]},
        "nuc": {"intervals": [[50, 200, 150]]},
    }}
    single = list(FootprintLayerResolver("tf_sr").intervals(read))
    union = list(FootprintLayerResolver("all_fp").intervals(read))
    assert single == [[-2, 3, 5]]
    assert [-2, 3, 5] in union and [0, 3, 3] not in union
    meta = FootprintLayerResolver("all_fp").family_metadata(read)
    assert len(meta) == len(union)


def test_gene_names_resolve_to_their_longest_transcript_on_the_chromosome():
    import pandas as pd
    from types import SimpleNamespace
    from services.gene_ids import resolve_selected_transcripts
    state = SimpleNamespace(gtf_data={"transcripts": pd.DataFrame([
        {"transcript_id": "eve-RA", "gene_name": "eve", "chrom": "2R", "start": 100, "end": 300, "strand": "+"},
        {"transcript_id": "eve-RB", "gene_name": "eve", "chrom": "2R", "start": 90, "end": 400, "strand": "+"},
        {"transcript_id": "sna-RA", "gene_name": "sna", "chrom": "2L", "start": 10, "end": 20, "strand": "-"},
    ])})
    # Transcript IDs keep resolving exactly.
    assert [g["start"] for g in resolve_selected_transcripts(state, ["eve-RA"], "2R")] == [100]
    # A gene name (any case) resolves to its longest transcript, on the asked chromosome only.
    genes = resolve_selected_transcripts(state, ["EVE"], "chr2R")
    assert [(g["start"], g["end"]) for g in genes] == [(90, 400)]
    assert resolve_selected_transcripts(state, ["eve"], "2L") == []
