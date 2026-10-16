"""B2 round 6: clustering/analysis review fixes."""
import io
from array import array
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pysam

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


# 1. A quality gate that removes every TF call leaves an explicitly empty layer.
def test_filtered_empty_tf_layer_does_not_fall_back_to_primary():
    from services.clustering_features import _weighted_intervals_for_mode
    from services.read_quality_filters import apply_quality_filters
    from services.transcription_state import resolve_tf_source

    read = {
        "id": "r",
        "intervals": [[0, 10, -10], [10, 55, 45]],
        "qualities": [10],
        "layers": {"tf": {"intervals": [[10, 55, 45]], "qualities": [[10]], "quality_names": ["nq"]}},
    }
    filtered = apply_quality_filters(read, [{"layer": "tf", "quality_name": "nq", "min_value": 200}])
    assert filtered["layers"]["tf"]["intervals"] == []
    assert resolve_tf_source(filtered) == []
    assert _weighted_intervals_for_mode(filtered, "tf", filtered["intervals"], 90) == []
    # Unfiltered, the layer still drives both.
    assert resolve_tf_source(read) == [[10, 55, 45]]
    # A read with no layer at all still falls back to its primary intervals.
    assert resolve_tf_source({"intervals": [[10, 55, 45]]}) == [[10, 55, 45]]


# 2. MSP-only BAM reads: as/al are the gaps, not footprints.
def test_msp_only_bam_read_marks_msps_accessible(tmp_path):
    from services.dense_bam_loader import load_reads_from_bam

    bam = tmp_path / "msp.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 2000}]}
    with pysam.AlignmentFile(str(bam), "wb", header=header) as out:
        seg = pysam.AlignedSegment(out.header)
        seg.query_name = "m"
        seg.reference_id = 0
        seg.reference_start = 0
        seg.query_sequence = "A" * 500
        seg.cigartuples = [(0, 500)]
        seg.mapping_quality = 60
        seg.query_qualities = pysam.qualitystring_to_array("I" * 500)
        seg.set_tag("as", array("I", [100]))
        seg.set_tag("al", array("I", [200]))
        out.write(seg)
    pysam.index(str(bam))
    df = load_reads_from_bam(str(bam), "chr1", 0, 500, spanning_only=False)
    row = df.drop(columns=["read_id"]).iloc[0].to_numpy()
    assert (row[100:300] < 0).all()      # the MSP is accessible
    assert (row[:100] > 0).all() and (row[300:500] > 0).all()  # flanks protected


# 3. An explicitly empty assignment override is the branch shown, not "use stored".
def test_explicit_empty_assignment_override_is_honoured(monkeypatch):
    from services import clustering_endpoint
    from services.read_sorting import sort_similarity_for_dataset

    dataset = SimpleNamespace(cluster_assignments={"r": 0}, cluster_element_info=None)
    state = SimpleNamespace(get_dataset=lambda _id: dataset)
    out = sort_similarity_for_dataset(state, "ds", "chr1", 0, 100, True, cluster_assignments_override={})
    assert out == {"cluster_order": [], "read_sort_order": []}

    working_set = SimpleNamespace(reads=[{"id": "r", "intervals": [[0, 10, 10]]}])
    query = SimpleNamespace(sample_seed="s", dataset_ids=["ds"], build_working_set=lambda _s, _d: working_set)
    monkeypatch.setattr(clustering_endpoint.AnalysisReadQuery, "from_request", classmethod(lambda cls, *a, **k: query))
    req = SimpleNamespace(dataset_id="ds", sample_seed="s", cluster_ids=[0], cluster_assignments={"ds": {}}, max_reads=100)
    res = clustering_endpoint.run_cluster_expand_endpoint(state=state, req=req, chrom="chr1", start=0, end=100, spanning=True)
    assert res["reads"] == []
    # Without an override the stored clustering is used.
    req.cluster_assignments = None
    res = clustering_endpoint.run_cluster_expand_endpoint(state=state, req=req, chrom="chr1", start=0, end=100, spanning=True)
    assert [r["id"] for r in res["reads"]] == ["r"]


# 4. A named gene scope resolves that gene or nothing.
def test_client_gene_scope_names_its_gene():
    from browser_client import BrowserClient as FiberBrowserClient

    client = FiberBrowserClient.__new__(FiberBrowserClient)
    client.get_genes = lambda *a, **k: []
    a = {"id": "A", "name": "GA", "chrom": "chr1", "start": 100, "end": 200}
    context = {"selected_genes": [a], "chrom": "chr1", "start": 0, "end": 1000}
    assert client._resolve_gene_for_analysis_rule({"kind": "gene", "geneId": "B"}, context) is None
    assert client._resolve_gene_for_analysis_rule({"kind": "gene"}, context) is a
    assert client._resolve_gene_for_analysis_rule({"kind": "gene", "geneId": "A"}, context) is a


# 5. Wrapped circular gene IDs resolve to their transcript, shifted.
def test_wrapped_gene_ids_resolve_in_transcription_and_pol2():
    from services.filtering_endpoint import _resolve_transcription_genes
    from services.gene_ids import split_wrapped_gene_id
    from services.pol2_endpoint import _resolve_pol2_genes

    assert split_wrapped_gene_id("tx1:wrap1000") == ("tx1", 1000)
    assert split_wrapped_gene_id("tx1") == ("tx1", 0)
    transcripts = pd.DataFrame([{"transcript_id": "tx1", "start": 10, "end": 60, "strand": "+", "gene_name": "g"}])
    state = SimpleNamespace(gtf_data={"transcripts": transcripts})
    genes = _resolve_transcription_genes(state, ["tx1:wrap1000"])
    assert genes == [{"id": "tx1:wrap1000", "start": 1010, "end": 1060, "strand": "+", "name": "g"}]
    genes = _resolve_pol2_genes(state, ["tx1:wrap1000", "tx1"])
    assert [(g["start"], g["end"]) for g in genes] == [(1010, 1060), (10, 60)]


# 6. /api/meta_all honours dataset_ids and spanning.
def test_meta_all_honours_dataset_ids_and_spanning():
    from services.read_auxiliary_endpoint import get_meta_all_payload

    calls = []

    def get_reads(chrom, start, end, spanning, ds_id):
        calls.append((ds_id, spanning))
        return pd.DataFrame()

    state = SimpleNamespace(translate_chrom=lambda c: c, dataset_order=["A", "B"], get_reads=get_reads)
    out = get_meta_all_payload(state, chrom="chr1", start=0, end=100, spanning=False, dataset_ids=["B"])
    assert calls == [("B", False)]
    assert list(out["profiles"]) == ["B"]
    calls.clear()
    get_meta_all_payload(state, chrom="chr1", start=0, end=100)
    assert calls == [("A", True), ("B", True)]


# 7. A kernel longer than the signal never moves peaks past the region.
def test_short_signal_peaks_stay_in_region():
    from services.signal_peaks import detect_signal_peaks

    peaks = detect_signal_peaks([1, 1, 1], 100, 110, 1, 1)
    assert peaks and all(100 <= p["start"] < p["end"] <= 110 for p in peaks)


# 8. Read images come back at the requested size; long gaps don't overflow.
def test_reads_image_uses_requested_size():
    from PIL import Image
    from services.read_auxiliary_endpoint import get_reads_image_payload

    cols = list(range(0, 400))
    data = np.full((5, 400), -40000, dtype=np.int32)
    df = pd.DataFrame(data, columns=cols)
    df["read_id"] = [f"r{i}" for i in range(5)]
    state = SimpleNamespace(translate_chrom=lambda c: c, get_reads=lambda *a, **k: df,
                            resolve_dataset_id=lambda _id: "ds", get_dataset=lambda _id: None)
    out = get_reads_image_payload(state, chrom="chr1", start=0, end=400, width=800, height=300)
    img = Image.open(io.BytesIO(out["content"]))
    assert img.size == (800, 300)
    default = Image.open(io.BytesIO(get_reads_image_payload(state, chrom="chr1", start=0, end=400)["content"]))
    assert default.size == (400, 15)
    # -40000 is a long gap (accessible), drawn as a gap colour, not a footprint.
    from services.read_rendering import render_reads_to_image
    arr = np.asarray(render_reads_to_image(df))
    from services.read_rendering import COLORMAP
    assert tuple(arr[0, 0]) == tuple(COLORMAP[50])
