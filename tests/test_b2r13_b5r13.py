"""B2 round 13 (MA-only dense footprints, client intron scope, k-means bins) and
B5 round 13 (circular composite signal, sequence past a linear contig end)."""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _dense_with_read(monkeypatch, tags):
    import pysam
    import services.dense_bam_loader as dense

    class Read:
        query_name = "r"
        reference_start = 0
        reference_end = 200
        cigartuples = [(0, 200)]
        is_reverse = False
        is_secondary = is_supplementary = is_unmapped = is_duplicate = False
        mapping_quality = 60
        query_length = 200

        def get_tag(self, tag):
            if tag not in tags:
                raise KeyError(tag)
            return tags[tag]

        def has_tag(self, tag):
            return tag in tags

    class Bam:
        header = {}
        references = ("chr1",)

        def fetch(self, *a, **k):
            return iter([Read()])

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(pysam, "AlignmentFile", lambda *a, **k: Bam())
    monkeypatch.setattr(dense.os.path, "exists", lambda p: True)
    df = dense.load_reads_from_bam("/x/a.bam", "chr1", 0, 200, spanning_only=False)
    return df.drop(columns=["read_id"]).iloc[0].to_numpy()


def test_dense_loader_reads_ma_only_footprints(monkeypatch):
    # MA intervals are 1-based starts: nuc 11-120 covers query 10..129.
    row = _dense_with_read(monkeypatch, {"MA": "200;nuc+Q:11-120", "AQ": [200]})
    assert (row[10:130] == 120).all()
    assert (row[:10] < 0).all() and (row[130:] < 0).all()


def test_dense_loader_ma_msp_only_read_is_protected_between_msps(monkeypatch):
    row = _dense_with_read(monkeypatch, {"MA": "200;msp+:51-50", "AQ": [200]})
    assert (row[50:100] < 0).all()  # the MSP is accessible
    assert (row[:50] > 0).all() and (row[100:] > 0).all()


def test_client_intron_scope_has_no_introns_for_a_single_exon_gene():
    from browser_client import BrowserClient as FiberBrowserClient
    gene = {"start": 100, "end": 500, "exons": [{"start": 100, "end": 500}]}
    assert FiberBrowserClient._gene_segments(gene, "intron") == []
    two = {"start": 100, "end": 500, "exons": [{"start": 100, "end": 200}, {"start": 300, "end": 500}]}
    assert FiberBrowserClient._gene_segments(two, "intron") == [(200, 300)]


def test_kmeans_sort_bins_the_whole_region(monkeypatch):
    import numpy as np
    import sklearn.cluster as skc
    from services.read_sorting import sort_reads_by_kmeans

    captured = {}
    real = skc.MiniBatchKMeans

    class Spy(real):
        def fit_predict(self, X, *a, **k):
            captured["X"] = np.array(X)
            return super().fit_predict(X, *a, **k)

    monkeypatch.setattr(skc, "MiniBatchKMeans", Spy)
    reads = [{"id": "open_tail", "intervals": [[250, 399, -149]]},
             {"id": "closed", "intervals": [[0, 399, 399]]}]
    sort_reads_by_kmeans(reads, 399, n_clusters=2)
    X = captured["X"]
    assert X[0].sum() > 0  # the accessible tail is seen
    assert X[1].sum() == 0
    assert X[0][-1] == 1.0  # the last bin covers the last bases


def test_composite_signal_keeps_the_wrapped_segment(monkeypatch):
    import services.circular_genome as circ
    import services.figure.tracks.composite as comp
    import services.tracks_endpoint as te

    calls = []

    def fake_payload(state, body):
        calls.append((body.start, body.end))
        return {"tracks": [{"index": 0, "values": [1.0] * body.bins, "render_mode": "signal"}]}

    monkeypatch.setattr(circ, "circular_chrom_size", lambda state, chrom: 1000)
    monkeypatch.setattr(te, "get_tracks_batch_payload", fake_payload)

    class Data:
        def get(self, key, load):
            return load()

    ctx = SimpleNamespace(start=950, end=1050, chrom="p",
                          state=SimpleNamespace(orthogonal_tracks=[{"render_mode": "signal"}]),
                          spec=SimpleNamespace(width=100), fe={}, data=Data())
    comp.track_batch(ctx, 0)
    q_start, q_end = calls[0]
    assert q_start < 950 and q_end > 1050  # logical window across the origin, not clamped at 1000


def test_composite_annotations_across_the_origin_are_shifted(monkeypatch):
    import services.circular_genome as circ
    import services.figure.tracks.composite as comp
    import services.tracks_endpoint as te

    def fake_payload(state, body):
        # One feature at reference 10-20, returned only for the segment holding it.
        ivs = [{"start": 10, "end": 20}] if body.start <= 10 and body.end >= 20 else []
        return {"tracks": [{"index": 0, "intervals": ivs, "render_mode": "annotation"}]}

    monkeypatch.setattr(circ, "circular_chrom_size", lambda state, chrom: 1000)
    monkeypatch.setattr(te, "get_tracks_batch_payload", fake_payload)

    class Data:
        def get(self, key, load):
            return load()

    ctx = SimpleNamespace(start=950, end=1050, chrom="p",
                          state=SimpleNamespace(orthogonal_tracks=[{"render_mode": "annotation"}],
                                                circular_chroms={"p": {"size": 1000}}),
                          spec=SimpleNamespace(width=100), fe={}, data=Data())
    item = comp.track_batch(ctx, 0)
    assert [(iv["start"], iv["end"]) for iv in item["intervals"]] == [(1010, 1020)]


def test_sequence_bases_stay_at_their_positions_past_a_contig_end(monkeypatch):
    import routers.genome as genome
    import services.figure.tracks.sequence as seqmod

    async def fake_get_sequence(chrom, start, end, state=None):
        return {"sequence": "ACGT" * 12 + "AC", "start": 950}  # 50 bases; the reference ends at 1000

    monkeypatch.setattr(genome, "get_sequence", fake_get_sequence)
    monkeypatch.setattr(seqmod, "cluster_sidebar_width", lambda ctx: 0)

    class Data:
        def get(self, key, load):
            return load()

    rects = []

    class Surface:
        def save(self):
            pass

        def restore(self):
            pass

        def translate(self, *a):
            pass

        def text(self, *a, **k):
            pass

        def rect(self, x, y, w, h, fill=None):
            rects.append((x, w, fill))

    ctx = SimpleNamespace(start=950, end=1050, chrom="chr1", state=SimpleNamespace(), data=Data(),
                          width=100, reversed=False, panel=None, fe={})
    seqmod.draw(Surface(), ctx, SimpleNamespace(height=10), 10.0)
    bases = [r for r in rects if r[2] != "#fafafa"]
    assert len(bases) == 50
    assert max(x + w for x, w, _ in bases) <= 50.0 + 1e-9  # past the contig end stays blank
