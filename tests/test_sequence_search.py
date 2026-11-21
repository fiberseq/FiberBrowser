"""Find a pasted sequence in the genome (services/sequence_search.py, routers/sequence_search.py).

A small synthetic FASTA: the exact / IUPAC scan finds hits on both strands, overlapping ones, across chunk
edges and in loaded plasmid sequences, never in reference N; BLAST (the real blastn, when installed) finds a
long query and reuses the genome database it built; the errors (no genome, a bad query) are answered at
once; and the routes are refused on a public server.
"""
from __future__ import annotations

import os
import random
import shutil
import time

import pytest

from services import insertion_identify as ii
from services import sequence_search as ss

HAVE_BLAST = shutil.which("blastn") is not None and shutil.which("makeblastdb") is not None


def _rand(rng: random.Random, n: int) -> str:
    return "".join(rng.choice("ACGT") for _ in range(n))


def _rc(seq: str) -> str:
    return seq.translate(str.maketrans("ACGT", "TGCA"))[::-1]


PLANT = "GATTACAGGCTTCAAGT"          # 17 bp, not its own reverse complement
LONG_PLANT_LEN = 300


@pytest.fixture(scope="module")
def genome(tmp_path_factory):
    rng = random.Random(11)
    root = tmp_path_factory.mktemp("seqsearch")
    chr1 = list(_rand(rng, 40_000))
    chr1[1_000:1_000 + len(PLANT)] = PLANT                    # + strand
    chr1[20_000:20_000 + len(PLANT)] = _rc(PLANT)             # - strand
    chr1[30_000:30_010] = "NNNNNNNNNN"                         # reference N never matches
    chr1[30_099:30_113] = "CAAAAAAAAAAAAC"                     # overlapping hits of a poly-A query
    long_plant = _rand(rng, LONG_PLANT_LEN)
    chr2 = list(_rand(rng, 25_000))
    chr2[5_000:5_000 + LONG_PLANT_LEN] = long_plant
    chr2[12_000:12_000 + len(PLANT)] = PLANT[:8] + ("T" if PLANT[8] != "T" else "A") + PLANT[9:]  # one mismatch
    seqs = {"chr1": "".join(chr1), "chr2": "".join(chr2)}
    fasta = root / "toy.fa"
    with open(fasta, "w") as fh:
        for name, seq in seqs.items():
            fh.write(f">{name}\n")
            for i in range(0, len(seq), 60):
                fh.write(seq[i:i + 60] + "\n")
    import pysam
    pysam.faidx(str(fasta))
    return {"fasta": str(fasta), "seqs": seqs, "long": long_plant, "root": root}


class _State:
    def __init__(self, fasta=None, plasmids=None, genome="toygenome"):
        self.fasta_path = fasta
        self.current_genome = genome if fasta else None
        self.fasta = None
        self.plasmid_sequences = dict(plasmids or {})
        self.primer_blast_db = None
        self.primer_fasta = None
        self.gtf_data = None
        self.orthogonal_tracks = []


@pytest.fixture(autouse=True)
def _blast_dir(tmp_path, monkeypatch):
    # Never ~/.fiberhmm/blast.
    monkeypatch.setenv("FIBERBROWSER_BLAST_DB_DIR", str(tmp_path / "blastdb"))


def _run(state, seq, **settings):
    parsed = ss.SearchSettings.from_request(settings)
    return ss.search(ss.normalize_query(seq, min_length=parsed.min_length), ss.SearchReference(state), parsed)


def _places(result):
    return sorted((h["chrom"], h["start"], h["strand"], h["mismatches"]) for h in result["hits"])


# ---------------------------------------------------------------------------
# Exact / IUPAC


def test_exact_finds_both_strands(genome):
    result = _run(_State(genome["fasta"]), PLANT, mode="exact")
    assert result["mode"] == "exact"
    assert _places(result) == [("chr1", 1_000, "+", 0), ("chr1", 20_000, "-", 0)]
    plus = next(h for h in result["hits"] if h["strand"] == "+")
    minus = next(h for h in result["hits"] if h["strand"] == "-")
    # The matched bases read as the query on the hit's strand.
    assert plus["matched"] == PLANT and minus["matched"] == PLANT
    assert plus["end"] - plus["start"] == len(PLANT) and plus["identity"] == 100.0


def test_auto_uses_exact_for_short_queries(genome):
    result = _run(_State(genome["fasta"]), PLANT.lower())
    assert result["mode"] == "exact" and result["total"] == 2


def test_mismatches_are_allowed_when_asked(genome):
    result = _run(_State(genome["fasta"]), PLANT, mode="exact", max_mismatches=1)
    assert ("chr2", 12_000, "+", 1) in _places(result)
    # Fewest mismatches first.
    assert [h["mismatches"] for h in result["hits"]] == sorted(h["mismatches"] for h in result["hits"])


def test_iupac_query_matches_the_bases_it_stands_for(genome):
    # R = A/G at position 1 (A), N at position 5 (A): still the planted copies; IUPAC means exact mode.
    query = "G" + "R" + PLANT[2:5] + "N" + PLANT[6:]
    result = _run(_State(genome["fasta"]), query)
    assert result["mode"] == "exact"
    assert {(h["chrom"], h["start"]) for h in result["hits"]} >= {("chr1", 1_000), ("chr1", 20_000)}


def test_overlapping_hits_and_reference_n(genome):
    # A 12-bp poly-A run holds one 12-mer; a 10-mer query finds 3 overlapping starts on +, and poly-T on -.
    result = _run(_State(genome["fasta"]), "A" * 10, mode="exact", min_length=10)
    plus = sorted(h["start"] for h in result["hits"] if h["chrom"] == "chr1" and 30_090 <= h["start"] <= 30_112 and h["strand"] == "+")
    assert plus == [30_100, 30_101, 30_102]
    # The N run matches nothing, even an all-N-tolerant IUPAC query.
    n_hits = _run(_State(genome["fasta"]), "ACGTNNNNNNNNACGT", mode="exact", min_length=8)
    assert not [h for h in n_hits["hits"] if h["chrom"] == "chr1" and 29_990 <= h["start"] <= 30_010]


def test_hits_across_chunk_edges_are_found_once(genome, monkeypatch):
    monkeypatch.setattr(ss, "CHUNK", 1_007)  # the + copy at 1000 straddles the first chunk edge
    result = _run(_State(genome["fasta"]), PLANT, mode="exact")
    assert _places(result) == [("chr1", 1_000, "+", 0), ("chr1", 20_000, "-", 0)]


def test_palindrome_reported_once(genome):
    pal = "GAATTCGCGAATTC"  # its own reverse complement
    state = _State(genome["fasta"], plasmids={"pTest": _rand(random.Random(3), 500) + pal + _rand(random.Random(4), 500)})
    result = _run(state, pal, mode="exact")
    hits = [h for h in result["hits"] if h["chrom"] == "pTest"]
    assert len(hits) == 1 and hits[0]["strand"] == "." and result["palindrome"]


def test_plasmids_are_searched_without_a_genome():
    plasmid = _rand(random.Random(5), 2_000)
    target = plasmid[700:725]
    result = _run(_State(None, plasmids={"pOnly": plasmid}), target)
    assert [(h["chrom"], h["start"], h["strand"]) for h in result["hits"]] == [("pOnly", 700, "+")]


def test_many_hits_are_capped_with_the_total(genome):
    many = _run(_State(genome["fasta"]), "ACGTAC", mode="exact", max_hits=3, min_length=6)
    assert len(many["hits"]) == 3 and many["total"] > 3
    assert any("Showing 3 of" in note for note in many["notes"])


def test_blast_unavailable_falls_back_to_exact(genome, monkeypatch):
    import services.external_tools as et
    monkeypatch.setattr(et, "tool_path", lambda name, **kw: None)
    query = genome["seqs"]["chr1"][1_000:1_045]  # 45 bp: auto would use BLAST
    result = _run(_State(genome["fasta"]), query)
    assert result["mode"] == "exact"
    assert result["hits"][0]["chrom"] == "chr1" and result["hits"][0]["start"] == 1_000
    assert any("exact search instead" in note for note in result["notes"])


# ---------------------------------------------------------------------------
# Errors


def test_no_genome_is_a_clear_error():
    out = ss.search_request(_State(None), sequence=PLANT)
    assert out["success"] is False and out["code"] == "no_genome" and "genome" in out["error"].lower()


@pytest.mark.parametrize("text, words", [
    ("", "Paste"),
    ("ACGT", "at least"),
    ("ACGTACGTACGTXYZ", "Not DNA"),
    (">a\nACGTACGTACGTAC\n>b\nACGTACGTACGTAC", "one sequence"),
    ("NNNNNNNNNNNNNNNNNNNNACGT", "ambiguous"),
])
def test_bad_queries_are_refused(genome, text, words):
    out = ss.search_request(_State(genome["fasta"]), sequence=text)
    assert out["success"] is False and out["code"] == "bad_query" and words in out["error"]


def test_fasta_text_and_numbers_are_accepted():
    assert ss.normalize_query(">my seq\n1 gattacaggc ttcaagt\n") == PLANT
    assert ss.normalize_query("GAUUACAGGCUUCAAGU") == PLANT


def test_bad_settings_are_refused(genome):
    out = ss.search_request(_State(genome["fasta"]), sequence=PLANT, settings={"mode": "fuzzy"})
    assert out["success"] is False and out["code"] == "bad_query"
    clamped = ss.SearchSettings.from_request({"max_hits": 10**9, "max_mismatches": -3})
    assert clamped.max_hits == ss.LIMITS["max_hits"][1] and clamped.max_mismatches == 0


# ---------------------------------------------------------------------------
# Jobs, the track, BED


def _wait(job_id, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        job = ss.get_search_job(job_id)
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.05)
    raise AssertionError("search did not finish")


def test_job_then_track_and_bed(genome):
    state = _State(genome["fasta"])
    started = ss.search_request(state, sequence=PLANT, settings={"mode": "exact"})
    assert started["success"] and started["job_id"]
    job = _wait(started["job_id"])
    assert job["status"] == "done" and job["result"]["total"] == 2
    added = ss.add_hits_track(state, started["job_id"])
    assert added["success"] and state.orthogonal_tracks[added["track_index"]]["temporary"]
    track = state.orthogonal_tracks[added["track_index"]]
    assert track["format"] == "bed" and len(track["bed_intervals"]["chr1"]) == 2
    # Adding again reuses the track.
    assert ss.add_hits_track(state, started["job_id"])["track_index"] == added["track_index"]
    bed = ss.hits_to_bed(job["result"]["hits"])
    rows = [line.split("\t") for line in bed.splitlines()[1:]]
    assert rows[0][:3] == ["chr1", "1000", str(1000 + len(PLANT))] and rows[1][5] == "-"


def test_temporary_tracks_are_not_saved_in_sessions(genome, tmp_path):
    """A session export / import round trip: the hits track is left out (nothing in tracks_failed), a
    BED track of a file is kept."""
    import json
    from models.requests import SessionExportRequest, SessionImportRequest
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    from state.browser_state import BrowserState
    state = BrowserState(None, None, None, None)
    assert state._load_fasta(genome["fasta"]) is None
    bed = tmp_path / "a.bed"
    bed.write_text("chr1\t10\t20\tx\n")
    started = ss.search_request(state, sequence=PLANT, settings={"mode": "exact"})
    assert _wait(started["job_id"])["status"] == "done"
    assert ss.add_hits_track(state, started["job_id"])["success"]
    from services.tracks_endpoint import add_track_for_request
    assert add_track_for_request(state, path=str(bed), label="a")["success"]
    session = build_session_export_for_request(state, SessionExportRequest(chrom="chr1", start=0, end=1000))["session"]
    session = json.loads(json.dumps(session, default=str))
    assert [t["path"] for t in session["orthogonal_tracks"]] == [str(bed)]
    fresh = BrowserState(None, None, None, None)
    assert fresh._load_fasta(genome["fasta"]) is None
    out = import_session_for_request(fresh, SessionImportRequest(session=session))
    assert not out.get("tracks_failed") and [t["path"] for t in fresh.orthogonal_tracks] == [str(bed)]


def test_track_is_remade_from_its_search_and_refused_once_gone(genome):
    """A cart entry re-registered (reload, undo, lost index) gets the hits back while the server holds the search."""
    from services.tracks_endpoint import add_track_for_request
    state = _State(genome["fasta"])
    started = ss.search_request(state, sequence=PLANT, settings={"mode": "exact"})
    assert _wait(started["job_id"])["status"] == "done"
    again = add_track_for_request(state, path=f"seqsearch://{started['job_id']}", label="hits")
    assert again["success"] and again["render_mode"] == "annotation"
    assert state.orthogonal_tracks[again["track_index"]]["bed_intervals"]["chr1"]
    gone = add_track_for_request(state, path="seqsearch://no-such-search")
    assert gone["success"] is False and "search again" in gone["message"]


def test_job_cancel(genome, monkeypatch):
    # A slow scan: one base per chunk, so Cancel lands between chunks.
    monkeypatch.setattr(ss, "CHUNK", 50)
    state = _State(genome["fasta"])
    started = ss.search_request(state, sequence=PLANT, settings={"mode": "exact"})
    assert ss.cancel_search_job(started["job_id"])
    job = _wait(started["job_id"])
    assert job["status"] in ("cancelled", "done")


# ---------------------------------------------------------------------------
# BLAST (the real blastn when it is installed)


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_blast_finds_a_long_query_and_reuses_its_database(genome, tmp_path, monkeypatch):
    from services.external_tools import tool_path
    assert tool_path("blastn") and tool_path("makeblastdb")
    state = _State(genome["fasta"])
    query = _rc(genome["long"])  # the minus strand of the chr2 copy
    first = _run(state, query)
    assert first["mode"] == "blast" and first["task"] == "megablast"
    top = first["hits"][0]
    assert (top["chrom"], top["start"], top["end"], top["strand"]) == ("chr2", 5_000, 5_000 + LONG_PLANT_LEN, "-")
    assert top["identity"] == 100.0 and top["mismatches"] == 0 and top["evalue"] < 1e-50
    assert top["matched"] == query
    # The database was built once, beside the others; the next search reuses it (no makeblastdb run).
    prefix = os.path.join(str(tmp_path / "blastdb"), "toygenome", "toygenome")
    from services.primer_config import blast_db_exists
    assert blast_db_exists(prefix)
    calls = []
    real_build = ii._build_blast_db
    monkeypatch.setattr(ii, "_build_blast_db", lambda *a, **k: calls.append(a) or real_build(*a, **k))
    second = _run(state, query)
    assert calls == [] and second["hits"][0]["start"] == 5_000
    assert ss.blast_status(ss.SearchReference(state))["db_ready"] is True
    # No staging folder is left behind.
    assert not [n for n in os.listdir(os.path.dirname(prefix)) if n.startswith(".blastdb-build-")]


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_blast_short_approximate_query(genome):
    state = _State(genome["fasta"])
    query = genome["seqs"]["chr1"][1_000:1_040]  # 40 bp, includes the planted 17-mer
    result = _run(state, query, mode="blast")
    assert result["mode"] == "blast" and result["task"] == "blastn-short"
    assert (result["hits"][0]["chrom"], result["hits"][0]["start"]) == ("chr1", 1_000)


def test_a_stopped_build_leaves_no_database(genome, tmp_path, monkeypatch):
    """Cancel during makeblastdb: nothing at the prefix that a later search would take for a database."""
    if not HAVE_BLAST:
        pytest.skip("BLAST+ not installed")
    from services.primer_config import blast_db_exists
    prefix = str(tmp_path / "stopped" / "db")
    os.makedirs(os.path.dirname(prefix))

    class _Stopped(ii._Runner):
        def run(self, cmd, **kw):
            out = cmd[cmd.index("-out") + 1]
            open(out + ".nsq", "w").close()  # a partial volume in the staging folder
            raise ii.IdentifyAborted("Stopped")
    with pytest.raises(ii.IdentifyAborted):
        ii._build_blast_db(genome["fasta"], prefix, _Stopped())
    assert not blast_db_exists(prefix) and os.listdir(os.path.dirname(prefix)) == []


# ---------------------------------------------------------------------------
# Routes


@pytest.fixture
def client(genome, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.sequence_search import router
    from state.dependencies import get_state
    state = _State(genome["fasta"])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    return TestClient(app), state


def test_routes_search_poll_and_track(client):
    http, state = client
    status = http.get("/api/sequence_search/status").json()
    assert status["searchable"] and status["defaults"]["exact_max_length"] == ss.DEFAULTS["exact_max_length"]
    started = http.post("/api/sequence_search", json={"sequence": PLANT, "max_hits": 10}).json()
    assert started["success"], started
    for _ in range(400):
        job = http.get(f"/api/sequence_search/jobs/{started['job_id']}").json()
        if job["status"] == "done":
            break
        time.sleep(0.05)
    assert job["result"]["total"] == 2 and job["result"]["settings"]["max_hits"] == 10
    track = http.post(f"/api/sequence_search/jobs/{started['job_id']}/track", json={}).json()
    assert track["success"] and track["path"].startswith("seqsearch://")
    assert http.get("/api/sequence_search/jobs/nope").json()["status"] == "missing"
    bad = http.post("/api/sequence_search", json={"sequence": "hello world"}).json()
    assert bad["success"] is False and bad["code"] == "bad_query"


def test_routes_take_no_paths(client):
    """The request body names a sequence and numbers only: unknown keys (a path) are ignored, not opened."""
    http, _ = client
    out = http.post("/api/sequence_search", json={"sequence": PLANT, "fasta_path": "/etc/passwd", "path": "/etc"}).json()
    assert out["success"]
    from routers.sequence_search import SequenceSearchRequest
    assert not [f for f in SequenceSearchRequest.model_fields if f.endswith(("path", "file", "dir", "fasta"))]


def test_routes_refused_in_public_mode(client, monkeypatch):
    import services.runtime as rt
    http, _ = client
    monkeypatch.setattr(rt, "get_public_mode", lambda: True)
    assert http.get("/api/sequence_search/status").status_code == 403
    assert http.post("/api/sequence_search", json={"sequence": PLANT}).status_code == 403


def test_routes_are_classified_public_denied():
    from services.public_mode_guard import PUBLIC_ALLOWED
    from tests.test_public_mode_guard import PUBLIC_DENIED
    routes = {("GET", "/api/sequence_search/status"), ("POST", "/api/sequence_search"),
              ("GET", "/api/sequence_search/jobs/{job_id}"), ("DELETE", "/api/sequence_search/jobs/{job_id}"),
              ("POST", "/api/sequence_search/jobs/{job_id}/track")}
    assert routes <= PUBLIC_DENIED and not (routes & PUBLIC_ALLOWED)


# ---------------------------------------------------------------------------
# Several paired references (release audit 3.1.0)


def _paired_state(tmp_path):
    import pysam

    class _Lock:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    rng = random.Random(5)
    first, second = _rand(rng, 3_000), list(_rand(rng, 3_000))
    second[1_500:1_500 + len(PLANT)] = PLANT
    fastas = []
    for name, (contig, seq) in {"a.fa": ("refA_1", first), "b.fa": ("refB_1", "".join(second))}.items():
        path = tmp_path / name
        path.write_text(f">{contig}\n{seq}\n")
        pysam.faidx(str(path))
        fastas.append(str(path))
    state = _State(fastas[0])
    state.reference_pairs = [{"fasta": f, "annotation": None} for f in fastas]
    from services.reference_collection import ReferenceCollection
    from services.fasta_handles import ThreadLocalFasta
    state.fasta = ReferenceCollection([ThreadLocalFasta(f) for f in fastas])
    state.current_genome = None
    return state, fastas


def test_exact_search_covers_every_paired_reference(tmp_path):
    state, _ = _paired_state(tmp_path)
    result = _run(state, PLANT, mode="exact")
    assert [(h["chrom"], h["start"], h["strand"]) for h in result["hits"]] == [("refB_1", 1_500, "+")]


def test_blast_queries_every_paired_reference_database(tmp_path, monkeypatch):
    state, fastas = _paired_state(tmp_path)
    asked = []
    monkeypatch.setattr(ii, "genome_blast_db", lambda snap, **kw: f"db:{snap.fasta_path}")
    monkeypatch.setattr(ss, "blast_status", lambda reference=None: {"available": True, "hint": ""})

    def run_blastn(seq, db, **kw):
        asked.append(db)
        if db != f"db:{fastas[1]}":
            return []
        return [{"subject": "refB_1", "sstart": 1_500, "send": 1_500 + len(seq), "strand": "+", "length": len(seq),
                 "nident": len(seq), "identity": 100.0, "evalue": 1e-10, "bitscore": 50.0, "qstart": 0,
                 "qend": len(seq)}]
    monkeypatch.setattr(ii, "run_blastn", run_blastn)
    result = _run(state, PLANT, mode="blast")
    assert asked == [f"db:{f}" for f in fastas]
    assert [(h["chrom"], h["start"]) for h in result["hits"]] == [("refB_1", 1_500)]
    assert result["hits"][0]["matched"] == PLANT


@pytest.mark.parametrize("genome", [None, "pairgenome"])
def test_paired_references_with_equal_basenames_get_their_own_blast_databases(tmp_path, monkeypatch, genome):
    """hap1/reference.fa and hap2/reference.fa (and, with a declared genome, every paired FASTA) once resolved to one
    database prefix: the second build replaced the first, and the second reference was searched twice."""
    import pysam
    fastas = []
    for hap in ("hap1", "hap2"):
        (tmp_path / hap).mkdir()
        path = tmp_path / hap / "reference.fa"
        path.write_text(f">{hap}_1\n{_rand(random.Random(hap), 600)}\n")
        pysam.faidx(str(path))
        fastas.append(str(path))
    state = _State(fastas[0])
    state.reference_pairs = [{"fasta": f, "annotation": None} for f in fastas]
    state.current_genome = genome
    built = {}

    def fake_build(fasta, prefix, runner):
        built[prefix] = fasta
        with open(prefix + ".nal", "w") as fh:
            fh.write(fasta)
    monkeypatch.setattr(ii, "_build_blast_db", fake_build)
    monkeypatch.setattr(ii, "tool_path", lambda name: "/bin/true")
    monkeypatch.setattr(ss, "blast_status", lambda reference=None: {"available": True, "hint": ""})
    searched = []

    def run_blastn(seq, db, **kw):
        with open(db + ".nal") as fh:
            searched.append(fh.read())
        return []
    monkeypatch.setattr(ii, "run_blastn", run_blastn)
    _run(state, "ACGT" * 10, mode="blast")
    assert sorted(searched) == sorted(fastas)
    assert len(built) == 2
    # Each database is found again (no rebuild) on the next search.
    searched.clear()
    _run(state, "ACGT" * 10, mode="blast")
    assert sorted(searched) == sorted(fastas) and len(built) == 2


def test_a_reused_primer_database_is_never_another_paired_references_build_target(tmp_path, monkeypatch):
    """hap1's primer database sits where hap2's default database would go (both named after reference.fa): hap1
    resolved to it, hap2 was built at that same prefix and replaced it, and both searches read hap2."""
    import pysam
    from services.primer_config import default_blast_db_prefix, record_blast_db_source
    fastas = []
    for hap in ("hap1", "hap2"):
        (tmp_path / hap).mkdir()
        path = tmp_path / hap / "reference.fa"
        path.write_text(f">{hap}_1\n{_rand(random.Random(hap), 600)}\n")
        pysam.faidx(str(path))
        fastas.append(str(path))
    state = _State(fastas[0], genome="paired")
    state.reference_pairs = [{"fasta": f, "annotation": None} for f in fastas]
    primer_db = default_blast_db_prefix(state, fastas[1])  # where hap2's default database goes
    os.makedirs(os.path.dirname(primer_db), exist_ok=True)
    with open(primer_db + ".nal", "w") as fh:
        fh.write(fastas[0])
    record_blast_db_source(primer_db, fastas[0])
    state.primer_blast_db = primer_db
    built = {}

    def fake_build(fasta, prefix, runner):
        built[prefix] = fasta
        with open(prefix + ".nal", "w") as fh:
            fh.write(fasta)
    monkeypatch.setattr(ii, "_build_blast_db", fake_build)
    monkeypatch.setattr(ii, "tool_path", lambda name: "/bin/true")
    monkeypatch.setattr(ss, "blast_status", lambda reference=None: {"available": True, "hint": ""})
    searched = []

    def run_blastn(seq, db, **kw):
        with open(db + ".nal") as fh:
            searched.append((db, fh.read()))
        return []
    monkeypatch.setattr(ii, "run_blastn", run_blastn)
    _run(state, "ACGT" * 10, mode="blast")
    assert sorted(f for _db, f in searched) == sorted(fastas)
    assert len({db for db, _f in searched}) == 2
    assert searched[0][0] == primer_db and primer_db not in built
    with open(primer_db + ".nal") as fh:
        assert fh.read() == fastas[0]


def test_a_single_reference_keeps_its_blast_database_prefix(tmp_path, monkeypatch):
    """The paired-reference disambiguation never moves a single reference's database (primer design shares it)."""
    from services.primer_config import default_blast_db_prefix
    path = tmp_path / "reference.fa"
    path.write_text(">c1\nACGTACGTACGT\n")
    state = _State(str(path))
    snaps = ss.SearchReference(state).blast_states()
    assert len(snaps) == 1 and getattr(snaps[0], "blast_db_prefix", None) is None
    assert default_blast_db_prefix(state, str(path)).endswith(os.path.join("toygenome", "toygenome"))


def test_replacing_a_later_paired_reference_changes_the_reference_id(tmp_path):
    state, fastas = _paired_state(tmp_path)
    before = ss.SearchReference(state).reference_id
    other = tmp_path / "c.fa"
    other.write_text(">refC_1\nACGTACGTACGTACGTACGT\n")
    state.reference_pairs = [state.reference_pairs[0], {"fasta": str(other), "annotation": None}]
    assert ss.SearchReference(state).reference_id != before


# ---------------------------------------------------------------------------
# Cancel inside a chunk (release audit 3.1.0)


class _Stop(Exception):
    pass


def _stop_on_second_call():
    calls = []

    def check():
        calls.append(1)
        if len(calls) > 1:
            raise _Stop()
    return check, calls


@pytest.mark.parametrize("query", ["A" * 40 + "N" * 40, "A" * 40])  # mask scan; literal str.find scan
def test_cancel_is_checked_within_a_chunk_of_a_repetitive_contig(query, monkeypatch):
    monkeypatch.setattr(ss, "CHECK_WORK", 10_000, raising=False)
    state = _State(plasmids={"polyA": "A" * 200_000})
    check, calls = _stop_on_second_call()
    parsed = ss.SearchSettings.from_request({"mode": "exact", "max_hits": 1})
    with pytest.raises(_Stop):
        ss.exact_search(ss.normalize_query(query), ss.SearchReference(state), parsed, check=check)
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# Lab members: own jobs and Cancel (release audit 3.1.0)


def test_identical_searches_by_two_lab_members_are_separate_jobs(monkeypatch):
    import threading
    from types import SimpleNamespace
    from services import runtime
    release = threading.Event()

    def slow_search(seq, reference, settings, *, runner=None, progress=None, public=False):
        while not release.wait(0.01):
            runner.check()
        return {"hits": [], "total": 0}
    monkeypatch.setattr(ss, "search", slow_search)
    monkeypatch.setattr(runtime, "_lab_mode", True)
    state = _State(plasmids={"p": "ACGT" * 100})
    alice, bob = SimpleNamespace(name="alice"), SimpleNamespace(name="bob")
    try:
        with runtime.lab_request_context(alice):
            a = ss.search_request(state, sequence=PLANT)
        with runtime.lab_request_context(bob):
            b = ss.search_request(state, sequence=PLANT)
            assert b["job_id"] != a["job_id"]
            assert ss.get_search_job(a["job_id"]) is None and not ss.cancel_search_job(a["job_id"])
        with runtime.lab_request_context(alice):
            assert ss.search_request(state, sequence=PLANT)["job_id"] == a["job_id"]  # her own running search
            assert ss.cancel_search_job(a["job_id"])
        with runtime.lab_request_context(bob):
            assert ss.get_search_job(b["job_id"])["status"] == "running"
    finally:
        release.set()
    monkeypatch.setattr(runtime, "_lab_mode", False)
    release.clear()
    try:
        first = ss.search_request(state, sequence=PLANT)
        assert ss.search_request(state, sequence=PLANT)["job_id"] == first["job_id"]  # local: shared, as before
        assert ss.get_search_job(first["job_id"]) is not None
    finally:
        release.set()


def test_hits_of_another_reference_are_not_added_as_a_track(genome, tmp_path):
    """Release audit 3.1.0: search genome A, switch to genome B (same contig names), add A's hits: refused."""
    state = _State(genome["fasta"])
    started = ss.search_request(state, sequence=PLANT, settings={"mode": "exact"})
    assert _wait(started["job_id"])["status"] == "done"
    other = tmp_path / "other.fa"
    other.write_text(">chr1\n" + "ACGT" * 500 + "\n")
    state.fasta_path, state.current_genome = str(other), "othergenome"
    added = ss.add_hits_track(state, started["job_id"])
    assert not added["success"] and added["code"] == "stale_reference" and state.orthogonal_tracks == []
    from services.tracks_endpoint import add_track_for_request as add_track
    via_cart = add_track(state, path=f"seqsearch://{started['job_id']}")
    assert not via_cart["success"] and "different reference" in via_cart["message"] and state.orthogonal_tracks == []
    state.fasta_path, state.current_genome = genome["fasta"], "toygenome"
    assert ss.add_hits_track(state, started["job_id"])["success"]


def test_a_long_minus_strand_blast_hit_keeps_its_five_prime_bases(monkeypatch):
    """A minus-strand hit longer than MATCHED_SEQ_MAX: ``matched`` is its first bases in query orientation (the
    reference end, reverse-complemented), not its last ones."""
    rng = random.Random(9)
    query = _rand(rng, 1_500)
    contig = _rand(rng, 500) + _rc(query) + _rand(rng, 500)
    state = _State(plasmids={})
    reference = ss.SearchReference(state)
    monkeypatch.setattr(ss.SearchReference, "contigs", lambda self: [("c1", len(contig), lambda s, e: contig[s:e])])
    reference.blast_state = object()
    monkeypatch.setattr(ss.SearchReference, "blast_states", lambda self: [object()])
    monkeypatch.setattr(ii, "genome_blast_db", lambda snap, **kw: "db")
    monkeypatch.setattr(ii, "run_blastn", lambda seq, db, **kw: [{
        "subject": "c1", "sstart": 500, "send": 2_000, "strand": "-", "length": 1_500, "nident": 1_500,
        "identity": 100.0, "evalue": 0.0, "bitscore": 2_000.0, "qstart": 0, "qend": 1_500}])
    hit = ss.blast_search(query, reference, ss.SearchSettings(), runner=ii._Runner(), progress=lambda m, f: None,
                          approximate=False)["hits"][0]
    assert hit["matched"] == query[:ss.MATCHED_SEQ_MAX] and hit["matched_truncated"]
