"""Identify an insertion (services/insertion_identify.py, services/te_library.py).

A small synthetic genome and TE library: an insert that is a TE copy is called
as that family (full length, strand, TSD); one cut from a gene's exon reports
the gene and exon; a spliced exon1+exon2 copy is flagged a retrocopy; a novel
insert has no hits. Plus the library download/cache, the result cache and
background jobs, and that nothing reaches an external service without the
explicit opt-in.
"""
from __future__ import annotations

import io
import json
import os
import random
import shutil
import subprocess
import threading
import time

import pandas as pd
import pytest

from services import insertion_identify as ii
from services import te_library

HAVE_BLAST = shutil.which("blastn") is not None and shutil.which("makeblastdb") is not None
HAVE_MM2 = shutil.which("minimap2") is not None
ENGINES = [pytest.param("blast", marks=pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")),
           pytest.param("minimap2", marks=pytest.mark.skipif(not HAVE_MM2, reason="minimap2 not installed"))]


def _rand(rng: random.Random, n: int) -> str:
    return "".join(rng.choice("ACGT") for _ in range(n))


def _mutate(rng: random.Random, seq: str, rate: float) -> str:
    return "".join(rng.choice("ACGT".replace(c, "")) if rng.random() < rate else c for c in seq)


def _rc(seq: str) -> str:
    return seq.translate(str.maketrans("ACGT", "TGCA"))[::-1]


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    rng = random.Random(7)
    root = tmp_path_factory.mktemp("identify")
    ltr = _rand(rng, 250)
    te_a = ltr + _rand(rng, 2500) + ltr          # an LTR element, 3000 bp
    line_b = _rand(rng, 1800)                     # a LINE
    # Genome: chr1 with three teA copies (a family), chr2 with a 3-exon gene on + strand.
    chr1 = list(_rand(rng, 60_000))
    for pos in (10_000, 25_000, 40_000):
        chr1[pos:pos + len(te_a)] = list(_mutate(rng, te_a, 0.01))
    chr1 = "".join(chr1)
    exons = [(5_000, 5_400), (8_000, 8_700), (12_000, 12_500)]
    chr2 = _rand(rng, 30_000)
    genome = {"chr1": chr1, "chr2": chr2}
    fasta = root / "genome.fa"
    with open(fasta, "w") as fh:
        for name, seq in genome.items():
            fh.write(f">{name}\n{seq}\n")
    lib = root / "lib.fa"
    lib.write_text(f">teA#LTR/Gypsy\n{te_a}\n>lineB#LINE/Jockey\n{line_b}\n")
    tx = pd.DataFrame([{"chrom": "chr2", "start": 5_000, "end": 12_500, "strand": "+", "transcript_id": "tx1",
                        "gene_name": "geneX", "biotype": "protein_coding", "norm_chrom": "2"}])
    ex = pd.DataFrame([{"chrom": "chr2", "start": s, "end": e, "transcript_id": "tx1"} for s, e in exons])
    gtf = {"transcripts": tx, "exons": ex, "tx_by_chrom": {"2": tx}}
    db = None
    if HAVE_BLAST:
        db = str(root / "genome")
        subprocess.run(["makeblastdb", "-in", str(fasta), "-dbtype", "nucl", "-parse_seqids", "-out", db],
                       check=True, capture_output=True)
    return {"rng": rng, "root": root, "genome": genome, "fasta": str(fasta), "db": db, "lib": str(lib),
            "te_a": te_a, "line_b": line_b, "exons": exons, "gtf": gtf}


@pytest.fixture
def library(world, tmp_path, monkeypatch):
    """The synthetic library installed through download_library (fake opener, no network)."""
    monkeypatch.setenv("FIBERBROWSER_TE_LIBRARY_DIR", str(tmp_path / "te_libraries"))
    entry = {**te_library.LIBRARIES["dmel-canonical-v10.2"], "id": "test-lib", "genomes": ["testgenome"],
             "fasta_sha256": None, "fasta_url": "https://example.invalid/lib.fa",
             "gff_url": "https://example.invalid/lib.gff"}
    monkeypatch.setitem(te_library.LIBRARIES, "test-lib", entry)
    gff = ("##gff-version 3\nFBte1\t.\tLTR_retrotransposon\t1\t3000\t.\t.\t.\tID=FBte1;name=Dmel\\teA\n"
           "FBte1\t.\tfive_prime_LTR\t1\t250\t.\t+\t.\tx=1\nFBte1\t.\tthree_prime_LTR\t2751\t3000\t.\t+\t.\tx=1\n"
           "FBte1\t.\tCDS\t400\t2600\t.\t+\t.\tname=Dmel\\teA\\pol\n")
    calls = []

    def opener(req, timeout=None):
        calls.append(req.full_url)
        body = open(world["lib"], "rb").read() if req.full_url.endswith(".fa") else gff.encode()
        return io.BytesIO(body)

    info = te_library.download_library("test-lib", opener=opener)
    return {"info": info, "calls": calls}


def _flanks(world, chrom, ref):
    seq = world["genome"][chrom]
    return lambda n: (seq[max(0, ref - n):ref], seq[ref:ref + n])


def _identify(world, seq, engine, **kw):
    return ii.identify(seq, None, engine=engine, genome="testgenome", genome_db=world["db"],
                       genome_target=world["fasta"], gtf_data=world["gtf"], **kw)


@pytest.mark.parametrize("engine", ENGINES)
def test_te_copy_is_identified(world, library, engine):
    rng = random.Random(1)
    ref = 50_000
    site = world["genome"]["chr1"][ref:ref + 6]
    # The element on the − strand, with a 6-bp TSD placed at the insert's start.
    insert = site + _rc(_mutate(rng, world["te_a"], 0.01))
    result = _identify(world, insert, engine, chrom="chr1", ref=ref, fetch_flanks=_flanks(world, "chr1", ref))
    top = result["te"]["calls"][0]
    assert top["family"] == "teA" and top["class_label"] == "LTR/Gypsy"
    assert top["strand"] == "-" and top["completeness"] == "full length"
    assert top["identity"] > 95
    assert result["summary"].startswith("Best candidate: teA (LTR/Gypsy)")
    assert result["verdict"]["status"] == "candidate" and result["verdict"]["candidates"] == ["teA"]
    assert result["tsd"] and result["tsd"]["length"] >= 6 and result["tsd"]["confident"]
    kinds = [s["kind"] for s in result["segments"]]
    assert kinds[0] == "tsd" and "te" in kinds
    labels = {f["label"] for f in top["mapped_features"]}
    assert {"5′ LTR", "3′ LTR", "pol"} <= labels
    five = next(f for f in top["mapped_features"] if f["label"] == "5′ LTR")
    assert five["qstart"] > len(insert) / 2  # − strand: the element's 5′ LTR is at the insert's end
    # The genome copies: a family of three, not called a gene fragment.
    assert result["genome"]["copies"] == 3
    assert result["genome"]["genes"] == []
    assert "teA" in result["report"] and "CC0" in result["report"]


@pytest.mark.parametrize("engine", ENGINES)
def test_truncated_line_with_poly_a(world, library, engine):
    rng = random.Random(2)
    insert = _mutate(rng, world["line_b"][1200:], 0.01) + "A" * 15
    result = _identify(world, insert, engine)
    top = result["te"]["calls"][0]
    assert top["family"] == "lineB" and top["completeness"] == "5′-truncated" and top["strand"] == "+"
    assert top["poly_a"] is not None
    assert any(s["kind"] == "polyA" for s in result["segments"])


@pytest.mark.parametrize("engine", ENGINES)
def test_gene_exon_fragment_reports_the_gene(world, library, engine):
    s, e = world["exons"][1]
    insert = world["genome"]["chr2"][s + 50:e - 50]
    result = _identify(world, insert, engine, chrom="chr1", ref=100)
    assert result["te"]["calls"] == []
    gene = result["genome"]["genes"][0]
    assert gene["gene"] == "geneX" and gene["exons"] == [2] and gene["region"] == "exon"
    assert "geneX exon 2" in result["summary"]
    assert any(seg["kind"] == "gene" and seg["gene"] == "geneX" for seg in result["segments"])


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_spliced_copy_is_a_retrocopy(world, library):
    chr2 = world["genome"]["chr2"]
    (s1, e1), (s2, e2) = world["exons"][:2]
    insert = chr2[s1:e1] + chr2[s2:e2]
    result = _identify(world, insert, "blast")
    gene = result["genome"]["genes"][0]
    assert gene["gene"] == "geneX" and gene["exons"] == [1, 2] and gene["spliced"]
    assert "retrocopy" in result["summary"]


@pytest.mark.parametrize("engine", ENGINES)
def test_novel_insert_has_no_hits(world, library, engine):
    insert = _rand(random.Random(99), 1500)
    result = _identify(world, insert, engine)
    assert result["te"]["calls"] == [] and result["genome"]["loci"] == []
    assert result["summary"].startswith("No confident match: novel sequence")
    assert result["verdict"]["status"] == "no_match"
    assert [s["kind"] for s in result["segments"]] == ["unknown"]


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_local_duplication_and_repeat_without_library(world, monkeypatch, tmp_path):
    monkeypatch.setenv("FIBERBROWSER_TE_LIBRARY_DIR", str(tmp_path / "none"))
    chr1 = world["genome"]["chr1"]
    local = ii.identify(chr1[52_000:52_800], None, engine="blast", genome="testgenome", genome_db=world["db"],
                        chrom="chr1", ref=51_000, gtf_data=world["gtf"])
    assert local["genome"]["loci"][0]["near_site"] == 1000
    assert "local duplication" in local["summary"]
    rep = ii.identify(world["te_a"], None, engine="blast", genome="testgenome", genome_db=world["db"],
                      gtf_data=world["gtf"])
    assert rep["te"]["library"] is None
    assert "3 copies" in rep["summary"] or rep["genome"]["copies"] == 3


def test_tsd_either_side():
    assert ii.target_site_duplication("ACGTTGGGGGGGG", "CCCCCC", "ACGTTCAAA")["length"] == 5
    t = ii.target_site_duplication("GGGGGGGGCATG", "TTTTCATG", "AAAA")
    assert t["length"] == 4 and t["side"] == "end"
    assert ii.target_site_duplication("GGGG", "TTTT", "AAAA") is None


def test_dfam_split_ltr_families_are_joined():
    # Dfam: X_LTR (300) + X_I (2000); an insert LTR|I|LTR on + strand.
    hits = [
        {"subject": "X_I#LTR/Gypsy", "identity": 99.0, "length": 2000, "qstart": 300, "qend": 2300,
         "sstart": 0, "send": 2000, "strand": "+", "evalue": 0.0, "bitscore": 3600, "slen": 2000},
        {"subject": "X_LTR#LTR/Gypsy", "identity": 98.0, "length": 300, "qstart": 0, "qend": 300,
         "sstart": 0, "send": 300, "strand": "+", "evalue": 0.0, "bitscore": 540, "slen": 300},
        {"subject": "X_LTR#LTR/Gypsy", "identity": 98.0, "length": 300, "qstart": 2300, "qend": 2600,
         "sstart": 0, "send": 300, "strand": "+", "evalue": 0.0, "bitscore": 540, "slen": 300},
    ]
    call = ii.te_calls(hits, None, 2600)[0]
    assert call["family"] == "X" and call["element_length"] == 2600
    assert call["completeness"] == "full length" and call["element_coverage"] == 1.0
    assert [f["label"] for f in call["features"]] == ["5′ LTR", "3′ LTR"]


def test_low_identity_hits_are_only_related():
    hits = [{"subject": "Y#DNA/hAT", "identity": 70.0, "length": 500, "qstart": 0, "qend": 500, "sstart": 0,
             "send": 500, "strand": "+", "evalue": 1e-20, "bitscore": 100, "slen": 2000}]
    call = ii.te_calls(hits, None, 500)[0]
    assert call["related"]
    result_like = {"length": 500, "te": {"calls": [call], "library": None},
                   "genome": {"genes": [], "copies": 0, "loci": [], "rmsk_family": None}}
    assert ii.verdict(result_like)["status"] == "no_match"
    assert ii.summarise(result_like).startswith("No confident match: the closest library family, Y, is below 80% identity")


def test_gene_fragments_skip_stretches_with_many_loci():
    """A TE-unexplained stretch found at many loci (a repeat) is never called a gene fragment."""
    loci = [{"chrom": "chr2", "strand": "+", "start": i * 10_000, "end": i * 10_000 + 400, "qstart": 0, "qend": 400,
             "qcov": 1.0, "identity": 99.0, "bitscore": 700.0, "evalue": 0.0, "near_site": None, "hsps": []}
            for i in range(10)]
    stretches, _ = ii._stretches_from_loci(loci, 400, chrom=None, ref=None, rmsk_names={})
    assert [s["kind"] for s in stretches] == ["repeat"] and stretches[0]["copies"] == 10


# ---------------------------------------------------------------------------
# Library download and cache


def test_library_download_and_status(world, library):
    assert library["calls"] == ["https://example.invalid/lib.fa", "https://example.invalid/lib.gff"]
    info = te_library.installed_info("test-lib")
    assert info["n_families"] == 2 and info["licence"].startswith("CC0")
    assert info["families"]["teA"]["class"] == "LTR" and info["families"]["teA"]["features"]
    status = te_library.library_status("testgenome")
    assert status["active"] == "test-lib" and status["libraries"][0]["installed"]


def test_library_checksum_mismatch_is_refused(world, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_TE_LIBRARY_DIR", str(tmp_path / "libs"))
    with pytest.raises(RuntimeError, match="checksum"):
        te_library.download_library("dmel-canonical-v10.2", opener=lambda req, timeout=None: io.BytesIO(b">x#DNA\nACGT\n"))
    assert te_library.installed_info("dmel-canonical-v10.2") is None


def test_dfam_library_pages_and_classes(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_TE_LIBRARY_DIR", str(tmp_path / "libs"))
    urls = []

    def opener(req, timeout=None):
        urls.append(req.full_url)
        if "format=summary" in req.full_url:
            return io.BytesIO(json.dumps({"total_count": 2, "results": [
                {"accession": "DF1", "repeat_type_name": "LINE", "repeat_subtype_name": "L1", "title": "a LINE"},
                {"accession": "DF2", "repeat_type_name": "SINE", "repeat_subtype_name": "Alu"}]}).encode())
        return io.BytesIO(json.dumps({"encoding": "identity", "body": ">DF1.3 L1HS\nACGTACGT\n>DF2.1 AluY\nGGGCCC\n"}).encode())

    info = te_library.download_library("dfam-curated-9606", opener=opener, build_blast_db=False)
    assert info["families"]["L1HS"]["class"] == "LINE" and info["families"]["AluY"]["subclass"] == "Alu"
    assert all("dfam.org/api/families" in u and "clade=9606" in u for u in urls)
    assert open(info["fasta"]).read().startswith(">L1HS#LINE/L1")


# ---------------------------------------------------------------------------
# Nothing external without the opt-in


@pytest.fixture
def no_network(monkeypatch):
    calls = []

    def fake(req, *a, **k):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        data = getattr(req, "data", None)
        calls.append((url, data))
        raise AssertionError(f"network call: {url}")
    monkeypatch.setattr("urllib.request.urlopen", fake)
    return calls


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_identify_sends_nothing_by_default(world, library, no_network):
    result = _identify(world, world["te_a"], "blast")
    assert result["genome"]["rmsk"] == "off"
    assert no_network == []


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_rmsk_sends_coordinates_never_the_sequence(world, library):
    seen = []

    def opener(req, timeout=None):
        seen.append((req.full_url, req.data))
        return io.BytesIO(json.dumps({"rmsk": [{"genoStart": 0, "genoEnd": 70_000, "repName": "teA_LTR",
                                                "repClass": "LTR", "repFamily": "Gypsy", "strand": "+"}]}).encode())
    ii._rmsk_cache.clear()
    seq = world["te_a"]
    result = _identify(world, seq, "blast", rmsk=True, rmsk_opener=opener)
    assert seen and all(data is None for _, data in seen)
    for url, _ in seen:
        assert url.startswith("https://api.genome.ucsc.edu/getData/track?")
        assert seq[:40] not in url and "track=rmsk" in url
    assert result["genome"]["rmsk_family"]["name"] == "teA"


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_rmsk_needs_a_verified_coordinate_assembly_not_a_declared_species(world, library, no_network):
    """A custom FASTA declared hg38 has hg38's TE library but not hg38's coordinates: rmsk is not looked up."""
    calls = []

    def opener(req, timeout=None):   # fetch_rmsk swallows an opener's errors: count the calls instead
        calls.append(req.full_url)
        raise OSError("rmsk must not be queried for a declared genome")
    ii._rmsk_cache.clear()
    result = _identify(world, world["te_a"], "blast", rmsk=True, rmsk_opener=opener, coordinate_genome="")
    assert calls == []
    assert result["genome"]["rmsk"] == "unavailable"
    assert no_network == []
    # The same identification with a verified coordinate assembly does look rmsk up (the test can fail).
    ii._rmsk_cache.clear()
    _identify(world, world["te_a"], "blast", rmsk=True, rmsk_opener=opener, coordinate_genome="testgenome")
    assert calls


def test_dfam_refuses_without_opt_in(no_network):
    with pytest.raises(ii.OptInRequired):
        ii.dfam_search("ACGT" * 50, organism="Homo sapiens", opt_in=False)
    with pytest.raises(ii.OptInRequired):
        ii.dfam_search("ACGT" * 50, organism="Homo sapiens", opt_in="yes")  # only True itself
    class S:
        current_genome = "hg38"
    out = ii.dfam_request(S(), seq="ACGT" * 50, opt_in=False)
    assert not out["success"] and out["opt_in_required"]
    assert no_network == []


def test_dfam_with_opt_in_sends_and_parses():
    sent = []
    responses = [
        (200, {"id": "abc-123"}),
        (202, {"status": "PEND", "message": "pending"}),
        (200, {"results": [{"hits": [{"query": "AluY", "accession": "DF2", "type": "SINE", "e_value": "1e-50",
                                      "bit_score": "300", "strand": "+", "seq_start": "1", "seq_end": "300"}]}]}),
    ]

    class Resp(io.BytesIO):
        status = 200

    def opener(req, timeout=None):
        sent.append((req.full_url, req.data))
        status, body = responses.pop(0)
        r = Resp(json.dumps(body).encode())
        r.status = status
        return r
    out = ii.dfam_search("ACGT" * 50, organism="Homo sapiens", opt_in=True, opener=opener, poll_seconds=0)
    assert out["hits"][0]["family"] == "AluY"
    assert sent[0][0] == "https://dfam.org/api/searches" and b"ACGT" in sent[0][1]


def test_dfam_route_needs_opt_in(client, no_network):
    from services.runtime import get_public_mode
    if get_public_mode():
        pytest.skip("public mode")
    r = client.post("/api/insertions/identify/dfam", json={"seq": "ACGT" * 50})
    assert r.status_code == 200 and r.json()["opt_in_required"]
    r = client.post("/api/insertions/identify/dfam", json={"seq": "ACGT" * 50, "opt_in": False})
    assert r.json()["success"] is False
    assert no_network == []


def test_routes_refused_in_public_mode(client, monkeypatch):
    import services.runtime as rt
    monkeypatch.setattr(rt, "get_public_mode", lambda: True)
    from routers.insertions import _local_only
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        _local_only()


# ---------------------------------------------------------------------------
# Jobs and the result cache


class _State:
    def __init__(self, world):
        self.fasta_path = world["fasta"]
        self.current_genome = "testgenome"
        self.gtf_data = world["gtf"]
        self.primer_blast_db = world["db"]
        self.primer_fasta = None
        self.fasta = None


def _wait(job_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        job = ii.get_job(job_id)
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_background_job_then_cache(world, library, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_IDENTIFY_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(ii, "genome_blast_db", lambda state, **kw: world["db"])
    ii._results.clear()
    state = _State(world)
    seq = world["te_a"]
    first = ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))
    assert first["success"] and first["status"] == "running" and first["job_id"]
    # A second request while it runs joins the same job.
    again = ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))
    assert again.get("job_id") == first["job_id"] or again.get("cached")
    job = _wait(first["job_id"])
    assert job["status"] == "done" and job["result"]["te"]["calls"][0]["family"] == "teA"
    cached = ii.identify_request(state, seq=seq.lower(), chrom="chr1", ref=100, length=len(seq))
    assert cached["cached"] and cached["result"]["seq_sha256"] == job["result"]["seq_sha256"]
    # The disk cache survives a restart (the in-memory cache emptied).
    ii._results.clear()
    assert ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))["cached"]
    # Another cluster with the same consensus is its own entry.
    other = ii.identify_request(state, seq=seq, chrom="chr1", ref=999, length=len(seq))
    assert not other.get("cached")
    _wait(other["job_id"])


def test_job_cancel_stops_the_subprocess(tmp_path):
    started = threading.Event()

    def fn(runner, progress):
        progress("sleeping", 0.2)
        started.set()
        runner.run(["sleep", "30"])
        return {"schema": ii.SCHEMA}
    job = ii.start_job("identify", "cancel-test", fn, persist=False)
    assert started.wait(5)
    time.sleep(0.2)
    assert ii.cancel_job(job["job_id"])
    done = _wait(job["job_id"], timeout=10)
    assert done["status"] == "cancelled"


def test_missing_tools_fail_clearly(monkeypatch, world):
    monkeypatch.setattr(ii, "tool_path", lambda name, **kw: None)
    out = ii.identify_request(_State(world), seq="ACGT" * 30, chrom="chr1", ref=1, length=120)
    assert not out["success"] and out["missing_tools"]
    assert "brew install blast" in out["error"]
    with pytest.raises(ii.IdentifyError, match="BLAST"):
        ii.identify("ACGT" * 30, None, engine="auto", genome_db="x")


def test_bad_sequence_is_rejected():
    with pytest.raises(ii.IdentifyError, match="not bases"):
        ii.identify("ACGT<script>", None, genome_db="x")
    with pytest.raises(ii.IdentifyError, match="longer"):
        ii.identify("A" * (ii.MAX_QUERY + 1), None, genome_db="x")


def test_genome_db_does_not_change_primer_settings(world, tmp_path, monkeypatch):
    if not HAVE_BLAST:
        pytest.skip("BLAST+ not installed")
    monkeypatch.setenv("HOME", str(tmp_path))
    state = _State(world)
    state.primer_blast_db = None
    state.current_genome = "synthgenome"
    db = ii.genome_blast_db(state)
    assert db.startswith(str(tmp_path)) and os.path.isfile(db + ".fiberbrowser-source.json")
    assert state.primer_blast_db is None and state.primer_fasta is None
    assert ii.genome_blast_db(state) == db  # reused, not rebuilt


# ---------------------------------------------------------------------------
# Review findings (Codex): each pinned


def _hit(subject, qs, qe, ss, se, strand="+", identity=99.0, slen=1000, bits=None):
    return {"subject": subject, "identity": identity, "length": qe - qs, "qstart": qs, "qend": qe, "sstart": ss,
            "send": se, "strand": strand, "evalue": 0.0, "bitscore": bits or float(qe - qs) * 1.8, "slen": slen}


def test_disconnected_ends_are_not_full_length():
    hits = [_hit("Z#DNA/hAT", 0, 100, 0, 100), _hit("Z#DNA/hAT", 100, 200, 900, 1000)]
    call = ii.te_calls(hits, None, 200)[0]
    assert call["element_coverage"] == 0.2 and call["completeness"] == "internally deleted"


def test_cross_ltr_hits_do_not_join_the_chain():
    # An LTR element on −: main chain + the far LTR; the query's 5′ LTR also matches the element's 5′ LTR.
    hits = [_hit("R#LTR/Pao", 5, 8000, 1000, 8995, "-", slen=9000, bits=14000),
            _hit("R#LTR/Pao", 8000, 9000, 0, 1000, "-", slen=9000, bits=1800),
            _hit("R#LTR/Pao", 5, 430, 0, 425, "-", slen=9000, bits=700)]
    calls = ii.te_calls(hits, None, 9000)
    assert len(calls) == 1 and calls[0]["completeness"] == "full length"
    assert len(calls[0]["hsps"]) == 2


def test_dfam_internal_only_keeps_the_missing_ltrs():
    info = {"families": {"X_LTR": {"length": 300}, "X_I": {"length": 2000}}}
    hits = [_hit("X_I#LTR/Gypsy", 0, 2000, 0, 2000, slen=2000)]
    call = ii.te_calls(hits, info, 2000)[0]
    assert call["element_length"] == 2600 and call["completeness"] == "internal fragment"
    solo = ii.te_calls([_hit("X_LTR#LTR/Gypsy", 0, 300, 0, 300, slen=300)], info, 300)[0]
    assert solo["family"] == "X (LTR)" and solo["element_length"] == 300


def test_feature_spanning_two_hsps_is_whole():
    call = {"strand": "+", "features": [{"type": "ORF", "label": "pol", "start": 100, "end": 900}],
            "hsps": [{"qstart": 0, "qend": 500, "estart": 0, "eend": 500, "bitscore": 900},
                     {"qstart": 500, "qend": 1000, "estart": 500, "eend": 1000, "bitscore": 900}]}
    f = ii.map_features(call)[0]
    assert (f["qstart"], f["qend"], f["partial"]) == (100, 900, False)


def test_locus_depth_counts_only_aligned_parts():
    hits = [_hit("chr9", 0, 100, 10_000, 10_100), _hit("chr9", 900, 1000, 10_900, 11_000)]
    loci = ii.build_loci(hits, 1000)
    assert loci[0]["qivals"] == [[0, 100], [900, 1000]]
    stretches, _ = ii._stretches_from_loci(loci, 1000, chrom=None, ref=None, rmsk_names={})
    assert [(s["qstart"], s["qend"]) for s in stretches] == [(0, 100), (900, 1000)]


def _gtf(exons, strand="+", with_exons=True):
    tx = pd.DataFrame([{"chrom": "chr2", "start": exons[0][0], "end": exons[-1][1], "strand": strand,
                        "transcript_id": "t", "gene_name": "g", "biotype": "protein_coding", "norm_chrom": "2"}])
    ex = pd.DataFrame([{"chrom": "chr2", "start": a, "end": b, "transcript_id": "t"} for a, b in exons]) if with_exons else None
    return {"transcripts": tx, "exons": ex, "tx_by_chrom": {"2": tx}}


def test_no_exon_rows_gives_a_gene_body_overlap_not_exon_1():
    gtf = _gtf([(1000, 5000)], with_exons=False)
    g = ii.gene_overlaps([_hit("chr2", 0, 500, 2000, 2500)], gtf)[0]
    assert g["region"] == "gene" and g["exons"] == []


def test_genomic_deletion_is_not_a_retrocopy():
    gtf = _gtf([(1000, 1200), (3000, 3200)])
    # Each hit keeps 50 intron bases beside its exon; the middle of the intron is deleted.
    deletion = [_hit("chr2", 0, 250, 1000, 1250), _hit("chr2", 250, 500, 2950, 3200)]
    assert not ii.gene_overlaps(deletion, gtf)[0]["spliced"]
    spliced = [_hit("chr2", 0, 200, 1000, 1200), _hit("chr2", 200, 400, 3000, 3200)]
    g = ii.gene_overlaps(spliced, gtf)[0]
    assert g["spliced"] and g["exons"] == [1, 2]


def test_gene_orientation_is_relative_to_the_consensus():
    gtf = _gtf([(1000, 1400)])
    g = ii.gene_overlaps([_hit("chr2", 0, 400, 1000, 1400, strand="-")], gtf)[0]
    assert g["strand"] == "+" and g["orientation"] == "-"


def test_cancel_after_the_work_never_publishes(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_IDENTIFY_CACHE_DIR", str(tmp_path / "c"))
    gate = threading.Event()

    def fn(runner, progress):
        gate.wait(5)
        return {"schema": ii.SCHEMA}
    job = ii.start_job("identify", "late-cancel", fn)
    assert ii.cancel_job(job["job_id"])
    gate.set()
    done = _wait(job["job_id"], timeout=10)
    assert done["status"] == "cancelled" and ii.cached_result("late-cancel") is None


def test_job_runs_on_a_snapshot_of_the_state(world, monkeypatch):
    seen = {}
    gate = threading.Event()

    def fake_identify(seq, state, **kw):
        gate.wait(5)
        seen["fasta"], seen["gtf"] = state.fasta_path, state.gtf_data
        return {"schema": ii.SCHEMA, "seq_sha256": "x"}
    monkeypatch.setattr(ii, "identify", fake_identify)
    monkeypatch.setattr(ii, "choose_engine", lambda e="auto": "blast")
    monkeypatch.setenv("FIBERBROWSER_IDENTIFY_CACHE_DIR", str(world["root"] / "snapcache"))
    state = _State(world)
    out = ii.identify_request(state, seq="ACGT" * 40, chrom="chr1", ref=7, length=160, force=True)
    state.fasta_path, state.gtf_data = "/elsewhere.fa", None  # the user switches genome meanwhile
    gate.set()
    done = _wait(out["job_id"])
    assert seen["fasta"] == world["fasta"] and seen["gtf"] is world["gtf"]
    assert done["result"]["reference_id"]


def test_annotation_is_part_of_the_cache_key(world):
    state = _State(world)
    with_gtf = ii.genome_signature(state, "blast")
    state.gtf_data = None
    assert ii.genome_signature(state, "blast") != with_gtf
    assert ii.reference_id(state) != ii.reference_id(_State(world))


# --- One click: the library is set up by Identify itself (bundled copy or one download) ---


GFF_TEST = ("##gff-version 3\nFBte1\t.\tLTR_retrotransposon\t1\t3000\t.\t.\t.\tID=FBte1;name=Dmel\\teA\n"
            "FBte1\t.\tfive_prime_LTR\t1\t250\t.\t+\t.\tx=1\n")


@pytest.fixture
def offered(world, tmp_path, monkeypatch):
    """test-lib offered for testgenome, not installed; returns the folder a bundle would use."""
    monkeypatch.setenv("FIBERBROWSER_TE_LIBRARY_DIR", str(tmp_path / "te_libraries"))
    monkeypatch.setenv("FIBERBROWSER_BUNDLED_TE_LIBRARIES", str(tmp_path / "bundle"))
    monkeypatch.setenv("FIBERBROWSER_IDENTIFY_CACHE_DIR", str(tmp_path / "cache"))
    entry = {**te_library.LIBRARIES["dmel-canonical-v10.2"], "id": "test-lib", "genomes": ["testgenome"],
             "fasta_sha256": None, "fasta_url": "https://example.invalid/lib.fa",
             "gff_url": "https://example.invalid/lib.gff"}
    monkeypatch.setitem(te_library.LIBRARIES, "test-lib", entry)
    ii._results.clear()
    return tmp_path / "bundle" / "test-lib"


def _bundle(folder, world):
    folder.mkdir(parents=True)
    shutil.copy(world["lib"], folder / "lib.fa")
    (folder / "lib.gff").write_text(GFF_TEST)


def test_bundled_library_installs_without_the_network(world, offered, no_network):
    _bundle(offered, world)
    status = te_library.library_status("testgenome")
    assert status["active"] is None and status["libraries"][0]["bundled"] is True
    assert te_library.auto_library("testgenome")["id"] == "test-lib"
    seen = []
    info = te_library.ensure_library("test-lib", progress=lambda m, f: seen.append(m))
    assert info["n_families"] == 2 and info["bundled"] and info["families"]["teA"]["features"]
    assert no_network == [] and "bundled with FiberBrowser" in seen[0]
    assert te_library.auto_library("testgenome") is None  # installed now: nothing to set up


def test_checksum_applies_to_the_bundled_copy(world, offered, monkeypatch):
    _bundle(offered, world)
    monkeypatch.setitem(te_library.LIBRARIES["test-lib"], "fasta_sha256", "0" * 64)
    with pytest.raises(RuntimeError, match="checksum"):
        te_library.download_library("test-lib")


def test_download_progress_names_size_and_licence(world, offered, monkeypatch):
    seen = []

    def opener(req, timeout=None):
        return io.BytesIO(open(world["lib"], "rb").read() if req.full_url.endswith(".fa") else GFF_TEST.encode())
    monkeypatch.setattr("urllib.request.urlopen", opener)
    te_library.ensure_library("test-lib", progress=lambda m, f: seen.append(m))
    assert "once" in seen[0] and "MB" in seen[0] and "CC0" in seen[0]


def test_cancel_stops_setting_the_library_up(world, offered):
    _bundle(offered, world)
    abort = threading.Event()
    abort.set()
    with pytest.raises(te_library.LibraryAborted):
        te_library.ensure_library("test-lib", abort=abort)
    assert te_library.installed_info("test-lib") is None


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_first_identify_sets_the_library_up_then_caches(world, offered, monkeypatch, no_network):
    _bundle(offered, world)
    monkeypatch.setattr(ii, "genome_blast_db", lambda state, **kw: world["db"])
    state = _State(world)
    seq = world["te_a"]
    first = ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))
    job = _wait(first["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["te"]["library"]["id"] == "test-lib" and job["result"]["te"]["calls"][0]["family"] == "teA"
    assert "library_note" not in job["result"]
    # The next request uses the installed library and finds the result under its real key.
    again = ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))
    assert again.get("cached"), again
    ii._results.clear()
    assert ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq)).get("cached")


@pytest.mark.skipif(not HAVE_BLAST, reason="BLAST+ not installed")
def test_library_that_cannot_be_set_up_is_tried_again(world, offered, monkeypatch, no_network):
    monkeypatch.setattr(ii, "genome_blast_db", lambda state, **kw: world["db"])
    state = _State(world)
    seq = world["te_a"]
    first = ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))
    job = _wait(first["job_id"])
    assert job["status"] == "done", job  # genome hits still reported
    assert job["result"]["te"]["library"] is None and "could not be set up" in job["result"]["library_note"]
    again = ii.identify_request(state, seq=seq, chrom="chr1", ref=100, length=len(seq))
    assert not again.get("cached")  # not filed: the next Identify tries the library again
    _wait(again["job_id"])


def test_cancelled_job_with_a_cache_key_never_publishes(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_IDENTIFY_CACHE_DIR", str(tmp_path / "c"))
    gate = threading.Event()

    def fn(runner, progress):
        gate.wait(5)
        return {"schema": ii.SCHEMA}
    job = ii.start_job("identify", "pending-key", fn, cache_key=lambda: "real-key")
    assert ii.cancel_job(job["job_id"])
    gate.set()
    assert _wait(job["job_id"], timeout=10)["status"] == "cancelled"
    assert ii.cached_result("real-key") is None and ii.cached_result("pending-key") is None
    done = ii.start_job("identify", "pending-key-2", lambda r, p: {"schema": ii.SCHEMA}, cache_key=lambda: "real-key-2")
    assert _wait(done["job_id"])["status"] == "done"
    assert ii.cached_result("real-key-2") is not None and ii.cached_result("pending-key-2") is None


def test_cancel_while_another_job_sets_the_library_up(world, offered):
    _bundle(offered, world)
    abort = threading.Event()
    te_library._ensure_lock.acquire()  # another job is setting it up
    try:
        threading.Timer(0.3, abort.set).start()
        started = time.time()
        with pytest.raises(te_library.LibraryAborted):
            te_library.ensure_library("test-lib", abort=abort)
        assert time.time() - started < 3
    finally:
        te_library._ensure_lock.release()


def test_cancel_stops_indexing_and_publishes_nothing(world, offered, monkeypatch, tmp_path):
    _bundle(offered, world)
    fake = tmp_path / "makeblastdb"
    fake.write_text("#!/bin/sh\nsleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setattr(te_library, "tool_path", lambda name, **kw: str(fake))
    abort = threading.Event()
    threading.Timer(0.5, abort.set).start()
    started = time.time()
    with pytest.raises(te_library.LibraryAborted):
        te_library.download_library("test-lib", abort=abort)
    assert time.time() - started < 5
    assert te_library.installed_info("test-lib") is None


def test_a_downloaded_genome_is_searched_through_its_local_copy(tmp_path):
    """A catalogue genome loaded from a URL: fasta_path is the URL, the open handle reads the cached
    download, the local file BLAST/minimap2 need (integ/fb35 smoke: Identify refused a downloaded dm6)."""
    from types import SimpleNamespace
    from services import insertion_identify as ii
    local = tmp_path / "dm6.fa"
    local.write_text(">chr2L\nACGT\n")
    state = SimpleNamespace(fasta_path="https://example.org/dm6.fa", fasta=SimpleNamespace(filename=str(local)),
                            current_genome="dm6", gtf_data=None, gtf_path=None)
    assert ii.local_reference_fasta(state) == str(local)
    assert ii.StateSnapshot(state).fasta_path == str(local)
    state.fasta = SimpleNamespace(filename="ssh://cluster/dm6.fa")  # a cluster FASTA: no local file
    assert ii.local_reference_fasta(state) is None
    assert ii.StateSnapshot(state).fasta_path == "https://example.org/dm6.fa"


def test_reference_copies_are_the_best_whole_copies_away_from_the_site():
    """'Open the reference copies': loci covering at least half the insert, not the insertion's own site,
    one per place (overlaps: the best), best first, at most n."""
    loci = [
        {"chrom": "chr2L", "start": 9_471_000, "end": 9_473_000, "strand": "+", "qcov": 0.98, "identity": 99.9, "bitscore": 3500, "near_site": 0},
        {"chrom": "chr3R", "start": 100_000, "end": 101_900, "strand": "-", "qcov": 0.97, "identity": 98.0, "bitscore": 3300, "near_site": None,
         "rmsk": {"name": "HOBO", "class": "DNA", "family": "hAT", "class_label": "DNA transposon", "fraction": 0.9}},
        {"chrom": "chr3R", "start": 100_500, "end": 101_000, "strand": "-", "qcov": 0.6, "identity": 97.0, "bitscore": 900, "near_site": None},
        {"chrom": "chrX", "start": 5_000, "end": 6_800, "strand": "+", "qcov": 0.9, "identity": 96.5, "bitscore": 2900, "near_site": None},
        {"chrom": "chr4", "start": 10, "end": 300, "strand": "+", "qcov": 0.15, "identity": 99.0, "bitscore": 500, "near_site": None},
        {"chrom": "chr2R", "start": 7_000, "end": 8_800, "strand": "+", "qcov": 0.9, "identity": 97.5, "bitscore": 2900, "near_site": None},
    ]
    copies = ii.reference_copies({"loci": loci}, 3)
    assert [(c["chrom"], c["start"]) for c in copies] == [("chr3R", 100_000), ("chr2R", 7_000), ("chrX", 5_000)]
    assert copies[0]["rmsk"]["name"] == "HOBO" and copies[0]["strand"] == "-"
    assert ii.reference_copies({"loci": loci}, 1) == copies[:1]
    assert ii.reference_copies({"loci": []}) == [] and ii.reference_copies(None) == []


def _call(family, bitscore, qstart, qend, identity=95.0, qlen=1000, related=False):
    return {"family": family, "class_label": "DNA/hAT", "identity": identity, "bitscore": bitscore,
            "qstart": qstart, "qend": qend, "query": [[qstart, qend]], "query_coverage": (qend - qstart) / qlen,
            "related": related, "strand": "+", "completeness": "full length"}


def _result(calls, loci=None, genes=None, rmsk=None, qlen=1000):
    return {"length": qlen, "te": {"calls": calls, "library": {"label": "lib", "version": "1"}},
            "genome": {"genes": genes or [], "copies": 0, "loci": loci or [], "rmsk_family": rmsk}}


def test_verdict_thresholds_candidate_ambiguous_no_match():
    """docs/identify.md: >= 80% identity over >= 50% of the insert is a candidate; another family within 5% of the best
    bitscore over the same bases makes it ambiguous; nothing passing is no confident match."""
    one = _result([_call("hobo", 1000, 0, 1000)])
    assert ii.verdict(one)["status"] == "candidate"
    assert ii.summarise(one).startswith("Best candidate: hobo")
    # A second family, 3% lower, over the same bases: ambiguous.
    two = _result([_call("hobo", 1000, 0, 1000), _call("hopper", 970, 50, 1000)])
    v = ii.verdict(two)
    assert v["status"] == "ambiguous" and v["candidates"] == ["hobo", "hopper"]
    assert ii.summarise(two).startswith("Ambiguous: hobo (DNA/hAT, 95.0%) or hopper")
    # 10% lower: still the best candidate.
    assert ii.verdict(_result([_call("hobo", 1000, 0, 1000), _call("hopper", 900, 0, 1000)]))["status"] == "candidate"
    # The same score on other bases (a nested insertion), or the same family's LTR call: not ambiguous.
    assert ii.verdict(_result([_call("hobo", 1000, 0, 600), _call("roo", 990, 600, 1000)]))["status"] == "candidate"
    assert ii.verdict(_result([_call("roo", 1000, 0, 1000), _call("roo (LTR)", 990, 0, 900)]))["status"] == "candidate"
    # Too little of the insert, too low an identity: no confident match.
    assert ii.verdict(_result([_call("hobo", 400, 0, 300)]))["status"] == "no_match"
    assert ii.verdict(_result([_call("hobo", 400, 0, 1000, identity=75.0, related=True)]))["status"] == "no_match"
    low = ii.verdict(_result([_call("hobo", 400, 0, 300)]))
    assert "30% of the insert" in low["reason"] and low["thresholds"]["min_identity"] == 80.0
    # A genome locus that passes is a candidate from the genome.
    locus = {"chrom": "chr2", "start": 10, "end": 1010, "identity": 99.0, "qcov": 0.97}
    assert ii.verdict(_result([], loci=[locus]))["source"] == "genome"
    named = {**locus, "rmsk": {"name": "ROO", "class": "LTR", "family": "Pao", "class_label": "LTR/Pao", "fraction": 0.99}}
    assert ii.verdict(_result([], loci=[named], rmsk={"name": "ROO", "class_label": "LTR/Pao"}))["source"] == "repeatmasker"
    assert ii.verdict(_result([], loci=[{**locus, "qcov": 0.2}]))["status"] == "no_match"


def test_verdict_picks_the_best_qualifying_candidate_and_names_it():
    """Codex review: the best candidate is the best-ranked one that passes (a higher-scoring one that doesn't is not
    it); RepeatMasker names only from qualifying copies; the summary names the verdict's candidate."""
    # Family A scores higher but covers 49% of the insert; family B passes: B is the candidate.
    a = {**_call("famA", 1000, 0, 490), "identity": 99.0, "query_coverage": 0.49}
    b = {**_call("famB", 900, 0, 600), "identity": 85.0, "query_coverage": 0.60}
    v = ii.verdict(_result([a, b]))
    assert v["status"] == "candidate" and v["candidates"] == ["famB"]
    assert ii.summarise(_result([a, b])).startswith("Best candidate: famB")
    # A RepeatMasker name on a copy under 80% identity never names the insert; an unnamed qualifying copy is a genome
    # candidate.
    weak = {"chrom": "chr3", "start": 5, "end": 900, "identity": 79.0, "qcov": 0.9,
            "rmsk": {"name": "WEAK", "class": "LTR", "family": "x", "class_label": "LTR/x", "fraction": 1.0}}
    good = {"chrom": "chr2", "start": 10, "end": 1010, "identity": 95.0, "qcov": 1.0}
    v = ii.verdict(_result([], loci=[weak, good], rmsk={"name": "WEAK", "class_label": "LTR/x"}))
    assert v["source"] == "genome" and v["candidates"] == ["chr2:11"]
    # A weak TE call (20% of the insert) and a qualifying genome copy: the summary describes the genome copy.
    low = {**_call("WeakTE", 300, 0, 200), "identity": 90.0, "query_coverage": 0.2}
    r = _result([low], loci=[good])
    assert ii.verdict(r)["source"] == "genome"
    assert ii.summarise(r).startswith("Best candidate: matches chr2:11") and "WeakTE" not in ii.summarise(r)
