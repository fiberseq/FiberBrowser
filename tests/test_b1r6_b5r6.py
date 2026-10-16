"""Round-6 review fixes: data access (B1) and sessions/rendering (B5)."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


# ── B1 #1: direct loads judge spanning on the alignment, not hidden-gap intervals ──
def _direct_state(dataset):
    class State:
        datasets = {"ds": dataset}
        dataset_order = ["ds"]
        _methylation_cache = {}

        def translate_chrom(self, chrom):
            return chrom

        def get_dataset(self, dataset_id):
            return self.datasets.get(dataset_id)

    return State()


def test_direct_spanning_uses_bam_alignment_bounds(monkeypatch):
    from services.read_endpoint import compact_reads_payload_for_request
    dataset = SimpleNamespace(label="S", color="#000", data_type="bam", paths=[],
                              available_layers={"footprint": True}, cluster_assignments={})
    reads = [
        # Spans [0,1000); terminal gaps hidden, so its intervals start at 100.
        {"id": "spans", "reference_start": 0, "reference_end": 1000,
         "intervals": [[100, 200, 100], [200, 700, -500], [700, 800, 100]]},
        {"id": "partial", "reference_start": 50, "reference_end": 1000,
         "intervals": [[100, 200, 100]]},
    ]
    monkeypatch.setattr("services.read_endpoint.load_direct_reads_for_dataset", lambda *a, **k: list(reads))
    payload = compact_reads_payload_for_request(
        _direct_state(dataset), chrom="chr1", start=0, end=1000, dataset_id="ds",
        include_cigar=True, spanning=True,
    )
    assert [read["id"] for read in payload["reads"]] == ["spans"]
    assert payload["total_spanning"] == 1 and payload["total_overlapping"] == 2


def test_direct_spanning_asks_the_loader_for_reads_without_bounds(monkeypatch):
    from services.read_endpoint import compact_reads_payload_for_request
    dataset = SimpleNamespace(label="S", color="#000", data_type="bigbed", paths=[],
                              available_layers={"footprint": True}, cluster_assignments={})
    everything = [{"id": "a", "intervals": [[100, 200, 100]]}, {"id": "b", "intervals": [[300, 400, 100]]}]
    calls = []

    def loader(*_args, spanning_only=False, **_kwargs):
        calls.append(spanning_only)
        return [everything[0]] if spanning_only else list(everything)

    monkeypatch.setattr("services.read_endpoint.load_direct_reads_for_dataset", loader)
    payload = compact_reads_payload_for_request(
        _direct_state(dataset), chrom="chr1", start=0, end=1000, dataset_id="ds",
        include_duplicates=True, spanning=True,
    )
    assert [read["id"] for read in payload["reads"]] == ["a"]
    assert calls == [False, True]


# ── B1 #2: a GFF3 exon shared by several transcripts belongs to each ──────────
def test_gff3_exon_with_several_parents(tmp_path):
    from services.gene_annotations import load_gtf
    gff = tmp_path / "shared.gff3"
    gff.write_text("\n".join([
        "##gff-version 3",
        "chr1\t.\tgene\t101\t500\t.\t+\t.\tID=g1;Name=G1",
        "chr1\t.\tmRNA\t101\t500\t.\t+\t.\tID=t1;Parent=g1",
        "chr1\t.\tmRNA\t101\t400\t.\t+\t.\tID=t2;Parent=g1",
        "chr1\t.\texon\t101\t200\t.\t+\t.\tParent=t1,t2",
        "chr1\t.\texon\t301\t500\t.\t+\t.\tParent=t1",
    ]) + "\n")
    data = load_gtf(str(gff))
    exons = data["exons"]
    by_tx = {tx: sorted(zip(group["start"], group["end"])) for tx, group in exons.groupby("transcript_id")}
    assert by_tx["t1"] == [(100, 200), (300, 500)]
    assert by_tx["t2"] == [(100, 200)]


# ── B1 #3: a signed URL's format is its path's ──────────────────────────────
def test_remote_url_with_a_query_string_is_recognised():
    from services.dataset_registration import validate_dataset_source
    from utils.validation import detect_data_format
    url = "https://host.example/data/sample.bb?token=abc&x=1"
    assert detect_data_format(url) == "bigbed"
    assert detect_data_format("https://host.example/s.bam?sig=1#frag") == "bam"
    assert validate_dataset_source(url) == (url, False)
    assert validate_dataset_source("https://host.example/s.bam?sig=1")[1] is True


# ── B5 #1: one FASTA replaces a paired reference collection ─────────────────
def test_single_fasta_load_forgets_reference_pairs(tmp_path):
    import pysam
    from state.browser_state import BrowserState
    fasta = tmp_path / "b.fa"
    fasta.write_text(">chr1\nACGTACGTAC\n")
    pysam.faidx(str(fasta))
    state = BrowserState(None, None, None, None)
    state.reference_pairs = [{"fasta": "/old/a.fa", "annotation": None}]
    assert state._load_fasta(str(fasta)) is None
    assert state.reference_pairs is None


# ── B5 #2: a region override doesn't draw the view's peaks on another chromosome ──
def test_region_override_keeps_the_view_peaks_on_their_chromosome():
    from services.figure.spec import resolve_spec
    state = SimpleNamespace(
        datasets={"a": {"id": "a", "label": "a", "available_layers": {"nuc": True}}},
        dataset_order=["a"],
        live_figure_state={
            "viewport": {"chrom": "chr1", "start": 100, "end": 200},
            "frontend_state": {"peaksByRule": {"r1": [{"index": 0, "start": 120, "end": 150}]}},
        },
    )
    spec = resolve_spec(state, chrom="chr2", start=100, end=200)
    assert spec.fe["peaksByRule"]["r1"][0]["chrom"] == "chr1"
    assert spec.fe["_peaksFromAnotherView"] is True
    same = resolve_spec(state)
    assert "chrom" not in same.fe["peaksByRule"]["r1"][0]
    assert not same.fe.get("_peaksFromAnotherView")


# ── B5 #3: explicit render toggles override the view both ways ──────────────
def test_explicit_layer_toggles_reach_the_headless_renderer(monkeypatch):
    from models.requests import RenderRequest
    from services.figure import api
    seen = {}

    def fake_resolve(state, **kwargs):
        seen.update(kwargs["overrides"])
        raise ValueError("stop")

    monkeypatch.setattr(api, "resolve_spec", fake_resolve)
    request = RenderRequest(chrom="c", start=0, end=10, engine="headless",
                            show_layers=True, show_fire=False, show_mods=False)
    response = api.render_request(request, SimpleNamespace())
    assert json.loads(response.body)["error"] == "stop"
    assert seen["_enableModTypes"] == {"tf": True, "nuc": True, "fire": False,
                                       "m6a": False, "m5c": False, "deam": False, "mod": False}
    seen.clear()
    api.render_request(RenderRequest(chrom="c", start=0, end=10, engine="headless"), SimpleNamespace())
    assert "_enableModTypes" not in seen


def test_merged_datasets_keep_lattice_alignment_identity_only():
    from services.read_response_payloads import compact_reads_response_payload
    ident = dict(record_sha256="x", alignment_occurrence=0, reference_start=10, reference_end=90,
                 alignment_orientation="forward")
    single = [dict(id="a", library_id="/one.bam", **ident), dict(id="b", library_id="/one.bam", **ident)]
    merged = [dict(id="a", library_id="/one.bam", **ident), dict(id="a", library_id="/two.bam", **ident)]
    kw = dict(width=100, dataset_id="d", working_count=2, total_in_scope=2, total_spanning=2)
    out = compact_reads_response_payload(display_reads=single, **kw)["reads"]
    assert all("library_id" not in r and "reference_start" not in r for r in out)
    out = compact_reads_response_payload(display_reads=merged, **kw)["reads"]
    assert [r["library_id"] for r in out] == ["/one.bam", "/two.bam"]
    assert all(r["reference_start"] == 10 and "record_sha256" not in r for r in out)
