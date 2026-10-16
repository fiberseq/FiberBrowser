"""'Go to reads' / best-covered loci when no read can be shown on the loaded genome.

The user's report: with a genome that does not match the data (dm6 loaded, the
hg38 demo BAM; a dm6 BAM on hg38; a BAM from a longer assembly), the find-reads
helper kept "looking for reads": it offered windows on contigs the reference
lacks or past its ends (an empty view with the same button again), and nothing
bounded a search. Now both endpoints answer at once with a reason and a
message, search only what the browser can show, and always stop.
"""
from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pysam
import pytest

from conftest import auth_headers

ROOT = Path(__file__).resolve().parents[1]
DEMO_BAM = ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"  # hg38, reads on chr19 only
ENDPOINTS = ("/api/reads/top_windows", "/api/reads/random_window")

needs_demo = pytest.mark.skipif(not DEMO_BAM.exists(), reason="NAPA demo BAM not present")


def _fasta(tmp_path: Path, name: str, contigs: dict) -> Path:
    """A small reference named like a genome (dm6.fa -> genome id dm6)."""
    folder = tmp_path / name.split(".")[0]
    folder.mkdir(exist_ok=True)
    path = folder / name
    with open(path, "w") as fh:
        for contig, size in contigs.items():
            fh.write(f">{contig}\n")
            seq = "ACGT" * (size // 4) + "A" * (size % 4)
            for i in range(0, size, 60):
                fh.write(seq[i:i + 60] + "\n")
    pysam.faidx(str(path))
    return path


def _bam(tmp_path: Path, name: str, contigs: dict, reads: list) -> Path:
    """A sorted, indexed BAM; ``reads`` = [(contig, start, length)]."""
    path = tmp_path / name
    header = {"HD": {"VN": "1.6", "SO": "coordinate"},
              "SQ": [{"SN": c, "LN": n} for c, n in contigs.items()]}
    names = list(contigs)
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i, (contig, start, length) in enumerate(sorted(reads, key=lambda r: (names.index(r[0]), r[1]))):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = f"r{i}"
            seg.reference_id = names.index(contig)
            seg.reference_start = start
            seg.cigartuples = [(0, length)]
            seg.query_sequence = "A" * length
            seg.mapping_quality = 60
            out.write(seg)
    pysam.index(str(path))
    return path


@pytest.fixture
def workspace(standalone_app):
    """A fresh main state for one test (restored afterwards): (client, state)."""
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    import services.random_window as rw

    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    rw._TOP_WINDOW_CACHE.clear()
    try:
        yield TestClient(standalone_app, headers=auth_headers()), state
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)
        rw._TOP_WINDOW_CACHE.clear()


def _load(state, fasta: Path, datasets: dict) -> None:
    assert state._load_fasta(str(fasta)) is None
    for dataset_id, path in datasets.items():
        state.add_dataset(dataset_id, str(path), dataset_id)


def _ask(client, endpoint: str, **params) -> tuple[dict, float]:
    t0 = time.monotonic()
    resp = client.get(endpoint, params={"span": 2000, **params})
    assert resp.status_code == 200, resp.text
    return resp.json(), time.monotonic() - t0


@needs_demo
@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("one_dataset", [True, False])
def test_hg38_demo_on_dm6_answers_contig_mismatch_at_once(workspace, tmp_path, endpoint, one_dataset):
    client, state = workspace
    _load(state, _fasta(tmp_path, "dm6.fa", {"chr2L": 5000, "chr3L": 5000}), {"demo": DEMO_BAM})
    body, elapsed = _ask(client, endpoint, **({"dataset_id": "demo"} if one_dataset else {}))
    assert body["success"] is False
    assert body["reason"] == "contig_mismatch"
    assert body["genome"] == "dm6"
    assert "chr19" in body["dataset_contigs"]
    assert body["error"] == "No reads from demo map to the loaded genome (dm6)."
    assert elapsed < 5  # no sampling at all
    if endpoint.endswith("top_windows"):
        assert body["windows"] == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_dm6_bam_on_hg38_answers_contig_mismatch(workspace, tmp_path, endpoint):
    client, state = workspace
    bam = _bam(tmp_path, "fly.bam", {"chr2L": 50_000, "chrX": 50_000},
               [("chr2L", 1000 + 30 * i, 500) for i in range(40)])
    _load(state, _fasta(tmp_path, "hg38.fa", {"chr1": 5000, "chr2": 5000, "chrX": 1000}), {"fly": bam})
    # chrX exists in both, but the fly BAM has no reads there.
    body, _ = _ask(client, endpoint, dataset_id="fly")
    assert body["success"] is False and body["reason"] == "contig_mismatch"
    assert body["error"] == "No reads from fly map to the loaded genome (hg38)."


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_matching_contigs_but_no_reads_answers_no_reads(workspace, tmp_path, endpoint):
    client, state = workspace
    bam = _bam(tmp_path, "empty.bam", {"chr2L": 5000}, [])
    _load(state, _fasta(tmp_path, "dm6.fa", {"chr2L": 5000}), {"empty": bam})
    for params in ({"dataset_id": "empty"}, {}):
        body, elapsed = _ask(client, endpoint, **params)
        assert body["success"] is False and body["reason"] == "no_reads", body
        assert body["error"] == "No reads found in empty."
        assert elapsed < 5


@needs_demo
@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_reads_only_past_the_reference_end_are_not_offered(workspace, tmp_path, endpoint):
    """A BAM from a longer assembly: its reads beyond the loaded chromosome can't be shown."""
    client, state = workspace
    _load(state, _fasta(tmp_path, "hg38.fa", {"chr19": 5000}), {"demo": DEMO_BAM})
    body, elapsed = _ask(client, endpoint, dataset_id="demo")
    assert body["success"] is False and body["reason"] == "not_found", body
    assert elapsed < 20


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_windows_stay_on_the_loaded_reference(workspace, tmp_path, endpoint):
    """Reads inside and past the reference's chr2L, and on a contig it lacks: only the first are offered."""
    client, state = workspace
    reads = ([("chr2L", 2000 + 20 * i, 400) for i in range(30)]
             + [("chr2L", 40_000 + 20 * i, 400) for i in range(300)]
             + [("chrUn_x", 100 + 20 * i, 400) for i in range(300)])
    bam = _bam(tmp_path, "longer.bam", {"chr2L": 60_000, "chrUn_x": 20_000}, reads)
    _load(state, _fasta(tmp_path, "dm6.fa", {"chr2L": 10_000}), {"longer": bam})
    body, _ = _ask(client, endpoint, dataset_id="longer", span=1000)
    assert body["success"] is True, body
    windows = body["windows"] if "windows" in body else [body]
    assert windows and all(w["chrom"] == "chr2L" and w["end"] <= 10_000 for w in windows), windows


def test_a_slow_search_stops_at_its_budget(monkeypatch):
    """However slow coverage is, a search ends by its time budget with a definite answer."""
    import services.random_window as rw

    def slow_coverage(*_a, **_k):
        time.sleep(0.05)
        return {"coverage": [0.0, 0.0], "max": 0}

    monkeypatch.setattr(rw, "compute_binned_read_coverage", slow_coverage)
    monkeypatch.setattr(rw, "_bam_contigs", lambda _path: [("chr1", 10.0, 100_000)])
    monkeypatch.setattr(rw, "_sample_anchor", lambda _ds, _rng, _span, *_c: ("chr1", 5000, 100_000))
    rw._TOP_WINDOW_CACHE.clear()
    ds = SimpleNamespace(id="d", label="d", data_type="bam", paths=["x.bam"])
    state = SimpleNamespace(get_dataset=lambda i: ds, dataset_order=["d"], chroms=[])

    t0 = time.monotonic()
    top = rw.top_covered_windows(state, span=1000, dataset_id="d", samples=10_000, budget_s=0.3)
    assert time.monotonic() - t0 < 2
    assert top["success"] is False and top["reason"] == "timeout" and top.get("partial") is True
    assert not rw._TOP_WINDOW_CACHE  # an unfinished ranking is not kept

    t0 = time.monotonic()
    rand = rw.random_covered_window(state, span=1000, max_attempts=10_000, budget_s=0.3)
    assert time.monotonic() - t0 < 2
    assert rand["success"] is False and rand["reason"] == "timeout"


def test_anchor_search_does_not_scan_a_whole_contig(monkeypatch):
    """A contig whose reads are all secondary is given up on after a bounded scan."""
    import services.random_window as rw

    class Read:
        is_unmapped, is_secondary, is_supplementary = False, True, False
        reference_start, reference_end = 10, 20

    fetched = []

    class Bam:
        def fetch(self, contig, start, end):
            for i in range(10 ** 7):
                fetched.append(1)
                yield Read()

    monkeypatch.setattr(rw, "get_bam_handle", lambda _p: Bam())
    import random
    anchor = rw._sample_bam_anchor([rw._Contig("x.bam", "chr1", 1.0, 1_000_000)], random.Random(1))
    assert anchor is None
    assert len(fetched) <= 2 * (rw.MAX_ANCHOR_SCAN + 1)


@needs_demo
def test_without_a_loaded_genome_every_dataset_is_searched(workspace, tmp_path):
    """No FASTA: the chromosome list is the first BAM's header; a second assembly's reads are still found."""
    client, state = workspace
    fly = _bam(tmp_path, "fly.bam", {"chr2L": 50_000}, [("chr2L", 1000 + 30 * i, 500) for i in range(40)])
    state.add_dataset("fly", str(fly), "fly")
    state.add_dataset("demo", str(DEMO_BAM), "demo")
    assert [c.name for c in state.chroms] == ["chr2L"] and state.fasta is None
    body, _ = _ask(client, "/api/reads/top_windows", dataset_id="demo")
    assert body["success"] is True and body["windows"][0]["chrom"] == "chr19"
