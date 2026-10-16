"""B2 round 7 (clustering/analysis) and F3r5 #1 (quality gates in sort/filter)."""
import sys
from array import array
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pysam

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


# 1. Several selected genes are separate bodies: an intergenic footprint counts for nothing.
def test_pol2_multiple_genes_are_separate_bodies():
    from models.requests import Pol2COMRequest
    from services.pol2_endpoint import _pol2_row_for_read

    req = Pol2COMRequest(fp_size_min=35, fp_size_max=65, n_bins=10)
    genes = [(100, 200, "+"), (800, 900, "-")]
    intergenic = {"id": "r", "intervals": [[0, 400, -400], [400, 450, 50], [450, 1000, -550]]}
    assert _pol2_row_for_read(intergenic, req, region_start=0, region_end=1000, n_bins=10, genes=genes) is None
    # A footprint in the minus-strand gene is placed along that gene, from its own TSS.
    in_second = {"id": "s", "intervals": [[0, 810, -810], [810, 850, 40], [850, 1000, -150]]}
    com, _id, binary, _acc = _pol2_row_for_read(in_second, req, region_start=0, region_end=1000, n_bins=10, genes=genes)
    assert abs(com - (1 - 0.3)) < 1e-9
    assert binary == [0, 0, 0, 0, 0, 1, 1, 1, 1, 0]
    # A single gene behaves as before.
    one = _pol2_row_for_read(in_second, req, region_start=0, region_end=1000, n_bins=10,
                             gene_from=800, gene_to=900, gene_strand="+")
    assert abs(one[0] - 0.3) < 1e-9


# 2. Non-spanning metaprofiles: reads not covering a base aren't in its denominator.
def test_meta_line_plot_ignores_reads_not_covering_a_base():
    from services.accessibility_tracks import compute_accessibility_track, meta_line_plot

    cols = list(range(100, 104))
    df = pd.DataFrame([[150, 150, 150, 150], [0, 0, -300, -300]], columns=cols)
    occ = meta_line_plot(df, 100, 104, 90, 100000)
    assert list(occ) == [1.0, 1.0, 0.5, 0.5]
    acc, _peaks, _ = compute_accessibility_track(pd.DataFrame([[150, 0], [0, 0]], columns=[100, 101]), 100, 102, window=1)
    assert list(acc) == [0.0, 0.0]


# 3. /api/cluster replaces the dataset's clustering metadata.
def test_legacy_cluster_replaces_combinatorial_metadata():
    from models.requests import ClusterRequest
    from services import clustering_endpoint
    from services.peak_scanning import remember_peak_regions
    from test_clustering_endpoint import FakeClusterState

    state = FakeClusterState()
    remember_peak_regions(state, [[0, 30]], "chr2R", 0, 30)
    for ds in state.datasets.values():
        ds.cluster_element_info = {"cluster_patterns": {0: [1, 0]}, "method": "combinatorial"}
        ds.cluster_peak_regions = [{"start": 900, "end": 950, "mode": "accessibility"}]

    def fake_cluster(reads, peaks, start, k, method, random_state):
        return {r["id"]: 0 for r in reads}, {0: len(reads)}, [], None

    out = clustering_endpoint.run_cluster_endpoint(
        state=state, req=ClusterRequest(peak_indices=[0]), chrom="chr2R", start=0, end=30,
        spanning=False, dataset_id=None, min_footprints=0, sample_seed=None, cluster_compact_reads_impl=fake_cluster)
    assert out["assignments"]
    ds = next(d for d in state.datasets.values() if d.cluster_assignments)
    assert ds.cluster_element_info is None
    assert ds.cluster_peak_regions == [{"start": 0, "end": 30, "mode": "accessibility"}]


# 4. A CSI-only index is enough for the dense loader.
def test_dense_loader_accepts_csi_index(tmp_path):
    from services.dense_bam_loader import load_reads_from_bam

    bam = tmp_path / "csi.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 2000}]}
    with pysam.AlignmentFile(str(bam), "wb", header=header) as out:
        seg = pysam.AlignedSegment(out.header)
        seg.query_name = "r"
        seg.reference_id = 0
        seg.reference_start = 0
        seg.query_sequence = "A" * 200
        seg.cigartuples = [(0, 200)]
        seg.mapping_quality = 60
        seg.query_qualities = pysam.qualitystring_to_array("I" * 200)
        seg.set_tag("ns", array("I", [50]))
        seg.set_tag("nl", array("I", [100]))
        out.write(seg)
    pysam.index("-c", str(bam))
    assert (tmp_path / "csi.bam.csi").exists() and not (tmp_path / "csi.bam.bai").exists()
    df = load_reads_from_bam(str(bam), "chr1", 0, 200, spanning_only=False)
    assert len(df) == 1


# 5. A count filter with no rule counts every footprint in scope.
def test_count_filter_without_rule_counts_footprints(monkeypatch):
    from models.requests import AnalysisFilterRequest
    from services import filtering_endpoint

    reads = [{"id": "one", "intervals": [[0, 10, -10], [10, 60, 50]]}, {"id": "none", "intervals": [[0, 60, -60]]}]
    query = SimpleNamespace(dataset_ids=["ds"], sample_seed="s", chrom="chr1",
                            build_working_set=lambda _s, _d: SimpleNamespace(reads=reads))
    monkeypatch.setattr(filtering_endpoint.AnalysisReadQuery, "from_request", classmethod(lambda cls, *a, **k: query))
    state = SimpleNamespace(gtf_data=None)
    for rule in (None, {}):
        req = AnalysisFilterRequest(metric="count", threshold=1, rule=rule)
        out = filtering_endpoint.filter_reads_by_analysis_rule_for_request(state, req, chrom="chr1", start=0, end=60)
        assert out["results"]["ds"]["read_ids"] == ["one"]


# F3r5 #1. Sort/filter rule counts apply the labeling rule's quality gates.
def test_rule_metric_applies_quality_gates():
    from services.read_metrics import compute_rule_metric

    read = {"id": "r", "intervals": [[0, 100, -100]],
            "layers": {"tf": {"intervals": [[10, 30, 20], [50, 70, 20]], "quality_names": ["tq"],
                              "qualities": [[10, 250]]}}}
    rule = {"size_min": 10, "size_max": 60, "conditions": []}
    assert compute_rule_metric(read, 0, rule, [], [], layer="tf") == 2
    gated = {**rule, "quality_gates": [{"quality_name": "tq", "min_value": 200}]}
    assert compute_rule_metric(read, 0, gated, [], [], layer="tf") == 1
    camel = {**rule, "qualityGates": [{"qualityName": "tq", "minValue": 200}]}
    assert compute_rule_metric(read, 0, camel, [], [], layer="tf") == 1
    # A missing quality dimension fails the gate, as in the browser.
    missing = {**rule, "quality_gates": [{"quality_name": "aq", "min_value": 1}]}
    assert compute_rule_metric(read, 0, missing, [], [], layer="tf") == 0
    # All footprint layers, and primary footprints with their nq.
    assert compute_rule_metric(read, 0, gated, [], [], layer="all_fp") == 1
    primary = {"id": "p", "intervals": [[0, 5, -5], [5, 25, 20]], "qualities": [220]}
    nq = {**rule, "quality_gates": [{"quality_name": "nq", "min_value": 200}]}
    assert compute_rule_metric(primary, 0, nq, [], []) == 1
