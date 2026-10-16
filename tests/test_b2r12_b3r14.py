"""B2 round 12 (occupancy, all_fp, /api/cluster filter_mode) and B3 round 14
(curation keeps an unaffected primary, JASPAR matrices sharing a name)."""
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


# 1. Scoped occupancy counts footprint bases inside the windows.
def test_scoped_occupancy_counts_covered_bases():
    from services.filtering_endpoint import _compute_sort_metric

    read = {"id": "r", "intervals": [[1000, 1150, 150], [1150, 1300, -150]]}

    def occ(windows):
        return _compute_sort_metric(read, start=0, end=2000, sort_by="occupancy", rule=None,
                                    gene_regions=[], peak_regions=[], layer=None, scope_windows=windows)

    assert occ([(1000, 1050)]) == 1.0      # fully covered, midpoint elsewhere (was 0)
    assert occ([(1070, 1080)]) == 1.0      # was 15
    assert occ([(1100, 1200)]) == 0.5
    assert occ([(1200, 1300)]) == 0.0
    assert occ([(1000, 1050), (1020, 1060)]) == 1.0  # overlapping windows counted once
    assert abs(occ(None) - 150 / 2000) < 1e-12


# 2. all_fp loads every layer (it is the union of footprint layers, not a layer).
def test_all_fp_requests_every_layer(monkeypatch):
    from services import filtering_endpoint
    from services.filtering_endpoint import _requested_layers

    assert _requested_layers("all_fp") is None
    assert _requested_layers(None) is None
    assert _requested_layers("tf") == ["tf"]

    seen = {}

    class Stop(Exception):
        pass

    def fake_from_request(state, **kwargs):
        seen.update(kwargs)
        raise Stop

    monkeypatch.setattr(filtering_endpoint.AnalysisReadQuery, "from_request", staticmethod(fake_from_request))
    from models.requests import AnalysisFilterRequest
    req = AnalysisFilterRequest(metric="count", operator="gte", threshold=1, layer="all_fp")
    try:
        filtering_endpoint.filter_reads_by_analysis_rule_for_request(None, req, chrom="chr1", start=0, end=100)
    except Stop:
        pass
    assert seen["requested_layers"] is None and seen["include_layers"]


# 3. /api/cluster honours filter_mode.
def test_legacy_cluster_honours_filter_mode():
    from models.requests import ClusterRequest
    from services import clustering_endpoint
    from services.peak_scanning import remember_peak_regions
    from test_clustering_endpoint import FakeClusterState

    def run(mode):
        state = FakeClusterState()
        remember_peak_regions(state, [[0, 30]], "chr2R", 0, 30)
        seen = {}

        def fake_cluster(reads, peaks, start, k, method, random_state):
            seen["ids"] = [r["id"] for r in reads]
            return {r["id"]: 0 for r in reads}, {0: len(reads)}, [], None

        out = clustering_endpoint.run_cluster_endpoint(
            state=state, req=ClusterRequest(peak_indices=[0], filter_mode=mode), chrom="chr2R", start=0, end=30,
            spanning=False, dataset_id=None, min_footprints=0, sample_seed=None, cluster_compact_reads_impl=fake_cluster)
        return seen.get("ids"), out["filtered_read_ids"]

    # read-a is a subnucleosomal (open) footprint across the peak; read-b is nucleosome-covered.
    assert run("open") == (["read-a"], ["read-a"])
    assert run("closed") == (["read-b"], ["read-b"])
    assert run("either") == (["read-a", "read-b"], ["read-a", "read-b"])


# 4. Ignoring an alternative keeps an unaffected primary.
def test_ignoring_an_alternative_keeps_the_primary(monkeypatch):
    from services import consensus_workflow as workflow
    from services.consensus_curation import update_curation

    workflow._runtime()
    families = ["Z", "A", "B"]
    snapshot = dict(datasets={'d': dict(
        units=[dict(unit_id='u', read_name='read', reference_start=0, reference_end=100, native_intervals=[[10, 30]])],
        sr=dict(status='disabled', records=[]),
        cr=dict(status='complete', catalog=[dict(family=f, consensus_start=10, consensus_end=30) for f in families],
                records=[dict(unit_id='u', strand='pooled', proposals=[dict(
                    source_call_id='call', source_interval=[10, 30], interval=[10, 30], family='Z',
                    compatible_alternatives=['A', 'B'], classification_status='compatible_catalog_label',
                    cr_mode=workflow.STAGED_MODE)])]),
        rescue=dict(status='disabled'), split=dict(status='disabled'), comparability=dict(status='disabled'))},
        cross=dict(status='disabled', edges=[]))
    result = dict(schema='fiberhmm.consensus.v1', cr_mode=workflow.STAGED_MODE,
                  manifest=dict(region=dict(chrom='chr1', start=0, end=100)), final_stage='resolved',
                  stage_results={'resolved': snapshot}, stages=[], **snapshot)
    job = dict(job_id='j', status='complete', result=result, filters=workflow.schema()['display_defaults'])
    job['index'], job['layers'] = workflow._index(result)
    state = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock(),
                            consensus_workflow_active='j')
    monkeypatch.setattr(workflow, '_register', lambda *args: None)

    assert workflow.state_read_ids(state, 'j', 'd', 'Z')['read_ids'] == ['read']
    update_curation(state, 'j', dict(expected_revision=0, operation='ignore', dataset_id='d', family_ids=['B']))
    assert workflow.state_read_ids(state, 'j', 'd', 'Z')['read_ids'] == ['read']
    assert workflow.state_read_ids(state, 'j', 'd', 'A')['read_ids'] == []
    # Ignoring the primary itself still promotes the next label in automatic order.
    update_curation(state, 'j', dict(expected_revision=1, operation='ignore', dataset_id='d', family_ids=['Z']))
    assert workflow.state_read_ids(state, 'j', 'd', 'A')['read_ids'] == ['read']


# 5. JASPAR matrices sharing a TF name are all kept.
def test_jaspar_keeps_matrices_sharing_a_name(tmp_path):
    from services.motifs import parse_jaspar_file

    path = tmp_path / "m.jaspar"
    path.write_text(
        ">MA0001.1 TF\nA [ 1 0 ]\nC [ 0 1 ]\nG [ 0 0 ]\nT [ 0 0 ]\n"
        ">MA0001.2 TF\nA [ 0 1 ]\nC [ 1 0 ]\nG [ 0 0 ]\nT [ 0 0 ]\n"
        ">MA0002.1 OTHER\nA [ 1 ]\nC [ 0 ]\nG [ 0 ]\nT [ 0 ]\n"
    )
    motifs = parse_jaspar_file(str(path))
    assert list(motifs) == ["TF", "TF (MA0001.2)", "OTHER"]
    assert motifs["TF"]["counts"]["A"] == [1.0, 0.0]
    assert motifs["TF (MA0001.2)"]["counts"]["A"] == [0.0, 1.0]
