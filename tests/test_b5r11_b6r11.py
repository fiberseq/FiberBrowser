"""Round-11 fixes: BigWig padded-fetch resolution, Playwright sort_by and
deamination opportunities, session contact-map replacement, contact-matrix
cell budget, APA beyond the expected curve, soft-clipped footprints, circular
notebook motif search."""
from types import SimpleNamespace

import numpy as np
import pytest

from models.domain import CigarCoordMapper
from models.requests import RenderRequest, SessionImportRequest


def test_high_resolution_bigwig_fetch_is_not_upsampled(monkeypatch):
    import services.orthogonal_tracks as ot
    from state.browser_state import BrowserState

    calls = []

    def fake_get_track_data(track, chrom, start, end, bins, **_kw):
        calls.append((start, end, bins))
        return [0.0] * bins

    monkeypatch.setattr(ot, "get_track_data", fake_get_track_data)
    state = BrowserState(None)
    state.orthogonal_tracks = [{"path": "/x/sig.bw", "format": "bigWig", "render_mode": "signal"}]
    values = state.get_track_data(0, "chr1", 0, 12000, bins=12000)
    assert len(values) == 12000
    # The padded window can't hold 12,000 bins under the cap: fetched as asked.
    assert calls == [(0, 12000, 12000)]


def _render_state():
    from models.domain import Dataset
    from state.browser_state import BrowserState
    state = BrowserState(None)
    state.datasets["ds"] = Dataset("ds", "ds.bam", label="ds")
    return state


def test_playwright_sort_by_becomes_read_sort_order(monkeypatch):
    import services.playwright_render as pr

    reads = [
        {"id": "low", "intervals": [[0, 10, -10]]},
        {"id": "high", "intervals": [[0, 80, -80]]},
    ]
    monkeypatch.setattr(pr, "_render_reads_by_dataset", lambda req, state, ids: {"ds": reads})
    req = RenderRequest(chrom="chr1", start=0, end=100, dataset_id="ds", engine="playwright", sort_by="accessibility")
    payload = pr._state_for_request(req, _render_state())
    assert payload["readSortOrder"] == {"ds": ["high", "low"]}


def test_playwright_refuses_a_sort_it_cannot_draw():
    import services.playwright_render as pr

    req = RenderRequest(chrom="chr1", start=0, end=100, dataset_id="ds", engine="playwright", sort_by="similarity")
    with pytest.raises(pr.UnsupportedRenderOption):
        pr._state_for_request(req, _render_state())


def test_playwright_sends_deamination_opportunities():
    import services.playwright_render as pr

    req = RenderRequest(chrom="chr1", start=0, end=100, dataset_id="ds", engine="playwright",
                        show_mods=True, show_deam_opportunities=True)
    payload = pr._state_for_request(req, _render_state())
    assert payload["enabledModTypes"]["deam_opportunity"] is True
    assert payload["enabledModTypes"]["deam"] is True


def _dafc(path):
    return SimpleNamespace(
        cool_file=path, bigbed_file=None, clr=object(), bb=None, resolutions=[1000],
        current_resolution=1000, chroms=["chr1"], chrom_expected_cache={}, chrom_expected_computing=set(),
        linked_sessions={},
    )


def test_importing_a_session_with_another_contact_map_unloads_the_old_one():
    from test_sessions_endpoint import _ImportState
    from services.sessions_endpoint import import_session_for_request

    dafc = _dafc("/maps/a.mcool")
    session = {"version": "2.0", "contact_map": {"cool_file": "/maps/b.mcool"}}
    import_session_for_request(_ImportState(), SessionImportRequest(session=session), dafc_state=dafc)
    assert dafc.cool_file is None and dafc.clr is None

    same = _dafc("/maps/a.mcool")
    session = {"version": "2.0", "contact_map": {"cool_file": "/maps/a.mcool"}}
    import_session_for_request(_ImportState(), SessionImportRequest(session=session), dafc_state=same)
    assert same.cool_file == "/maps/a.mcool"


def test_oversized_contact_matrix_is_refused_before_fetching():
    from services.microc_matrix import MatrixTooLarge, fetch_cooler_matrix

    class Clr:
        fetched = False

        def extent(self, region):
            return (0, 248_000)  # chr1 at 1 kb

        def matrix(self, balance=False):
            Clr.fetched = True
            raise AssertionError("must not fetch")

    with pytest.raises(MatrixTooLarge):
        fetch_cooler_matrix(Clr(), "chr1:0-248000000")
    assert not Clr.fetched


def test_apa_leaves_out_pairs_beyond_the_expected_curve():
    from services.microc_apa import compute_apa_from_matrix

    full = np.ones((40, 40), dtype=float) * 10
    peaks = [{"start": 50, "end": 60}, {"start": 150, "end": 160}, {"start": 350, "end": 360}]
    expected = np.full(15, 10.0)  # covers distances 0..14 bins
    result = compute_apa_from_matrix(full, peaks, resolution=10, window=20, chrom_nbins=40,
                                     expected_per_dist=expected)
    # Pair (5, 15) is covered; the pairs reaching bin 35 need distances > 14.
    assert result["n_pairs"] == 1
    assert result["pairs_beyond_expected"] == 2
    assert np.allclose(result["matrix"], 1.0)


def test_soft_clipped_footprint_keeps_its_aligned_part():
    # 10S200M from reference 100: a footprint over query 0..149 covers
    # reference 100..240 (its last 140 bases are aligned).
    mapper = CigarCoordMapper([(4, 10), (0, 200)], 100)
    assert mapper.query_interval_to_ref(0, 149) == (None, None)
    assert mapper.footprint_to_ref(0, 149) == (100, 240)
    assert mapper.footprint_to_ref(20, 49) == mapper.query_interval_to_ref(20, 49)


def test_dense_loader_keeps_soft_clipped_footprints(monkeypatch):
    import pysam
    import services.dense_bam_loader as dense

    class Read:
        query_name = "r"
        reference_start = 100
        reference_end = 300
        cigartuples = [(4, 10), (0, 200)]
        is_reverse = False
        is_secondary = is_supplementary = is_unmapped = is_duplicate = False
        mapping_quality = 60
        query_length = 210

        def get_tag(self, tag):
            tags = {"ns": [0], "nl": [150]}
            if tag not in tags:
                raise KeyError(tag)
            return tags[tag]

        def has_tag(self, tag):
            return tag in ("ns", "nl")

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
    df = dense.load_reads_from_bam("/x/a.bam", "chr1", 100, 300, spanning_only=False)
    row = df.drop(columns=["read_id"]).iloc[0].to_numpy()
    # Reference 100..239 is the footprint's aligned part: protected, not a gap.
    assert (row[:140] > 0).all()
    assert (row[140:200] < 0).all()


def test_notebook_motif_search_reads_across_a_circular_origin():
    from services import motifs as motif_service
    from services.jupyter_motifs import search_motifs_in_regions

    counts = {"A": [10, 0, 0], "C": [0, 0, 0], "G": [0, 10, 0], "T": [0, 0, 10]}
    pssm = motif_service.pwm_to_pssm(counts)
    region = SimpleNamespace(chrom="p", start=9, end=13, name=None)
    fa = {"p": "GTCCCCCCCA"}
    hits = search_motifs_in_regions([region], fa, [("custom:AGT", "AGT", pssm)], extend=0,
                                    threshold=0.9, both_strands=False, circular_chrom_sizes={"p": 10})
    assert [(h["start"], h["end"], h["matched_seq"]) for h in hits] == [(9, 12, "AGT")]
    # A linear contig still stops at its end.
    assert search_motifs_in_regions([region], fa, [("custom:AGT", "AGT", pssm)], extend=0,
                                    threshold=0.9, both_strands=False) == []
