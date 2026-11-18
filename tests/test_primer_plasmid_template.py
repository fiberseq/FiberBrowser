"""Primer design on a loaded plasmid map (a SnapGene .dna), checked against the genome's BLAST database.

The plasmid is held in memory: it is designed on directly, BLASTed against the database the user chose
(the loaded genome's: any hit there is off-target binding) and checked against its own sequence for a
single binding site. No BLAST database is demanded of, or built from, the plasmid.

Everything here is synthetic: a random "dm6" genome, a random plasmid with one stretch copied from that
genome and one stretch repeated within itself, written as a SnapGene .dna with a spaced name. The BLAST
tests run the real makeblastdb/blastn and skip when BLAST+ is not installed.
"""
from __future__ import annotations

import glob
import os
import random
import struct
import subprocess
from types import SimpleNamespace

import pytest

GENOME_LEN = 20_000
PLASMID_LEN = 5_000
# The plasmid: random backbone; [2800, 3600) copied from the genome's chrA[6000, 6800); [4000, 4700) a
# second copy of its own [100, 800).
GENOME_SEGMENT = (2800, 3600, 6000)
SELF_REPEAT = (4000, 4700, 100)
PRIMER_PARAMS = {"min_product": 300, "max_product": 900, "max_results": 2}


def _random_seq(rng, n):
    return "".join(rng.choice("ACGT") for _ in range(n))


def _genome_and_plasmid():
    rng = random.Random(20261117)
    chr_a = _random_seq(rng, GENOME_LEN)
    chr_b = _random_seq(rng, GENOME_LEN // 2)
    plasmid = list(_random_seq(rng, PLASMID_LEN))
    start, end, src = GENOME_SEGMENT
    plasmid[start:end] = chr_a[src:src + (end - start)]
    start, end, src = SELF_REPEAT
    plasmid[start:end] = plasmid[src:src + (end - start)]
    return {"chrA": chr_a, "chrB": chr_b}, "".join(plasmid)


def write_snapgene_dna(path, sequence, *, features=()):
    """A SnapGene .dna in the real segment layout: cookie, DNA (circular), features XML, notes."""
    def segment(kind, payload):
        return bytes([kind]) + struct.pack(">I", len(payload)) + payload
    data = segment(0x09, b"SnapGene" + struct.pack(">HHH", 1, 15, 19))
    data += segment(0x00, bytes([0x01]) + sequence.encode("ascii"))
    xml = "".join(
        f'<Feature recentID="{i}" name="{name}" directionality="1" type="misc_feature">'
        f'<Segment range="{a}-{b}" type="standard"/></Feature>'
        for i, (name, a, b) in enumerate(features))
    data += segment(0x0A, f'<?xml version="1.0"?><Features nextValidID="{len(features)}">{xml}</Features>'.encode())
    data += segment(0x06, b"<Notes><CustomMapLabel>pUAST-attB (v2) my construct</CustomMapLabel></Notes>")
    path.write_bytes(data)


def _write_fasta(path, contigs):
    with open(path, "w") as handle:
        for name, seq in contigs.items():
            handle.write(f">{name}\n")
            for i in range(0, len(seq), 60):
                handle.write(seq[i:i + 60] + "\n")
    import pysam
    pysam.faidx(str(path))


def _blast_tools_or_skip():
    from services.external_tools import tool_path
    missing = [tool for tool in ("makeblastdb", "blastn") if tool_path(tool) is None]
    if missing:
        pytest.skip(f"BLAST+ not installed ({', '.join(missing)} not found): the plasmid BLAST tests run the real tools")
    pytest.importorskip("primer3")  # optional Primer-panel package


@pytest.fixture(scope="module")
def plasmid_setup(tmp_path_factory):
    """A synthetic dm6 FASTA, its real BLAST database, and the plasmid as a spaced-name SnapGene .dna."""
    _blast_tools_or_skip()
    from services.external_tools import tool_path
    root = tmp_path_factory.mktemp("primer plasmid")
    genome, plasmid = _genome_and_plasmid()
    fasta = root / "dm6.fa"
    _write_fasta(fasta, genome)
    # The chosen database sits in a folder with a space (blastn must be handed it quoted). makeblastdb
    # can't write there itself, so it is built in a plain folder and moved.
    build_dir = tmp_path_factory.mktemp("blastbuild")
    subprocess.run([tool_path("makeblastdb"), "-in", f'"{fasta}"', "-dbtype", "nucl", "-parse_seqids",
                    "-out", str(build_dir / "dm6")], check=True, capture_output=True)
    db_dir = root / "chosen db"
    db_dir.mkdir()
    for built in build_dir.iterdir():
        built.rename(db_dir / built.name)
    db = db_dir / "dm6"
    dna = root / "pUAST-attB (v2) my construct.dna"
    write_snapgene_dna(dna, plasmid, features=[("mini-white", 501, 1500), ("attB", 2001, 2300)])
    return SimpleNamespace(root=root, fasta=fasta, db=str(db), dna=dna, plasmid=plasmid, genome=genome)


@pytest.fixture()
def fresh_client(standalone_app, tmp_path, monkeypatch):
    """A TestClient on a fresh main state; any database Build makes lands under tmp_path."""
    import server as srv
    from starlette.testclient import TestClient
    from conftest import auth_headers
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state
    from services.primer_blast_runtime import BLAST_HIT_CACHE
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("FIBERBROWSER_BLAST_DB_DIR", str(tmp_path / "blast cache"))
    BLAST_HIT_CACHE.clear()
    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        yield TestClient(standalone_app, headers=auth_headers()), state
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)
        BLAST_HIT_CACHE.clear()


def _blast_dbs_under(*dirs):
    found = set()
    for directory in dirs:
        for ext in (".nsq", ".nal", ".ndb"):
            found.update(p[:-len(ext)] for p in glob.glob(os.path.join(glob.escape(str(directory)), "**", f"*{ext}"),
                                                          recursive=True))
    return found


def _design(client, chrom, start, end, **extra):
    return client.post("/api/design_primers", json={"chrom": chrom, "start": start, "end": end,
                                                     **PRIMER_PARAMS, **extra}).json()


def _assert_pairs_on_plasmid(result, plasmid):
    assert result["success"] is True, result.get("message")
    pairs = result.get("pairs") or []
    assert pairs
    from primer_designer import rc
    for pair in pairs:
        assert pair["fwd_seq"] in plasmid
        assert rc(pair["rev_seq"]) in plasmid


def test_plasmid_design_with_dm6_open_checks_primers_against_dm6(plasmid_setup, fresh_client, tmp_path):
    client, state = fresh_client
    s = plasmid_setup
    assert client.post("/api/load_fasta", params={"path": str(s.fasta)}).json()["success"] is True
    assert client.post("/api/primer_config", params={"blast_db_path": s.db}).json()["success"] is True
    loaded = client.post("/api/load_plasmid", params={"path": str(s.dna)}).json()
    assert loaded["success"] is True
    chrom = loaded["name"]

    config = client.get("/api/primer_config").json()
    assert config["blast_db"] == s.db and config["blast_db_warning"] is None

    # Backbone on both sides: pairs designed on the plasmid itself.
    backbone = _design(client, chrom, 1600, 1800)
    _assert_pairs_on_plasmid(backbone, s.plasmid)
    assert "checked against dm6 for off-target binding" in backbone["message"]

    # Reverse window inside the stretch copied from the genome: every reverse primer also binds dm6.
    genome_side = _design(client, chrom, 2600, 2800)
    assert genome_side["success"] is False
    assert "0 rev" in genome_side["message"], genome_side["message"]

    # No database was built from (or demanded of) the plasmid.
    assert _blast_dbs_under(s.root, tmp_path) == {s.db}


def test_plasmid_design_without_a_genome_uses_the_chosen_dm6_db(plasmid_setup, fresh_client, tmp_path):
    """The reported case: no genome FASTA open, the dm6 BLAST database chosen, a .dna loaded."""
    client, state = fresh_client
    s = plasmid_setup
    assert client.post("/api/primer_config", params={"blast_db_path": s.db}).json()["success"] is True
    loaded = client.post("/api/load_plasmid", params={"path": str(s.dna)}).json()
    chrom = loaded["name"]
    assert state.current_genome == "plasmids"

    config = client.get("/api/primer_config").json()
    assert config["blast_db"] == s.db
    assert config["blast_db_warning"] is None  # 'plasmids' is not a genome a database must match
    assert config["fasta_local"] is None and config["plasmids"] == [chrom]

    _assert_pairs_on_plasmid(_design(client, chrom, 1600, 1800), s.plasmid)
    assert _design(client, chrom, 2600, 2800)["success"] is False

    # Build has no genome to work from, and says what to do instead of failing on the plasmid.
    built = client.post("/api/primer_blast_db/build").json()
    assert built["success"] is False
    assert "No genome FASTA is open" in built["message"] and "Browse" in built["message"]
    assert chrom in built["message"]
    assert _blast_dbs_under(s.root, tmp_path) == {s.db}


def test_plasmid_without_any_db_names_the_genome_db_to_choose(plasmid_setup, fresh_client):
    client, state = fresh_client
    loaded = client.post("/api/load_plasmid", params={"path": str(plasmid_setup.dna)}).json()
    result = _design(client, loaded["name"], 1600, 1800)
    assert result["success"] is False
    assert "No BLAST database chosen" in result["message"] and "Browse" in result["message"]
    assert "No database of the plasmid itself is needed" in result["message"]


def test_self_check_rejects_primers_repeated_in_the_plasmid(plasmid_setup, fresh_client):
    client, state = fresh_client
    s = plasmid_setup
    client.post("/api/primer_config", params={"blast_db_path": s.db})
    chrom = client.post("/api/load_plasmid", params={"path": str(s.dna)}).json()["name"]
    # The forward window [100, 800) is repeated at [4000, 4700): no forward primer binds once.
    repeated = _design(client, chrom, 800, 1000)
    assert repeated["success"] is False and "0 fwd" in repeated["message"], repeated["message"]
    # The self check is a parameter: off, those primers pass (they bind dm6 nowhere).
    _assert_pairs_on_plasmid(_design(client, chrom, 800, 1000, check_template_self=False), s.plasmid)


def test_plasmid_shorter_than_min_product_says_so(plasmid_setup, fresh_client):
    client, state = fresh_client
    client.post("/api/primer_config", params={"blast_db_path": plasmid_setup.db})
    chrom = client.post("/api/load_plasmid", params={"path": str(plasmid_setup.dna)}).json()["name"]
    result = client.post("/api/design_primers", json={"chrom": chrom, "start": 1600, "end": 1800}).json()
    assert result["success"] is False
    assert "not longer than the minimum product" in result["message"] and "Min product" in result["message"]


def test_genome_regions_still_need_their_home_hit(plasmid_setup, fresh_client):
    """A contig of the database's own FASTA keeps the one-home-hit rule and the database match."""
    client, state = fresh_client
    s = plasmid_setup
    client.post("/api/load_fasta", params={"path": str(s.fasta)})
    client.post("/api/primer_config", params={"blast_db_path": s.db})
    client.post("/api/load_plasmid", params={"path": str(s.dna)})
    result = _design(client, "chrA", 10000, 10200)
    assert result["success"] is True, result.get("message")
    for pair in result["pairs"]:
        assert pair["fwd_seq"] in s.genome["chrA"]


def test_build_names_the_ids_makeblastdb_rejects(plasmid_setup, tmp_path, monkeypatch):
    """No database is built from renamed ids (nothing could map hits back): the message names the ids to rename."""
    from services.primer_config import build_blast_db_from_fasta
    fasta = tmp_path / "custom ref.fa"
    long_id = "pUAST-attB_v2_my_construct_with_a_very_long_descriptive_name_and_more"
    fasta.write_text(f">{long_id} description\n{plasmid_setup.plasmid}\n>short\nACGTACGTACGT\n")
    state = SimpleNamespace(fasta=None, fasta_path=None, primer_fasta=None, primer_blast_db=None,
                            current_genome=None, plasmid_sequences={})
    out_dir = tmp_path / "db out"
    result = build_blast_db_from_fasta(state, fasta_path=str(fasta), output_dir=str(out_dir))
    assert result["success"] is False
    assert long_id in result["message"] and "50 characters" in result["message"]
    assert "Rename" in result["message"] and "short" not in result["message"].split("Rename")[0].split(":")[-1]
    assert not glob.glob(str(out_dir / "*.fa")) and state.primer_blast_db is None


def test_build_into_and_from_folders_with_spaces(plasmid_setup, tmp_path, monkeypatch):
    """makeblastdb splits -in on spaces and can't write -out under a path with spaces: both are handled."""
    from services.primer_config import build_blast_db_from_fasta
    from services.primer_blast_runtime import blast_and_score_cached
    src_dir = tmp_path / "Fly Lab refs"
    src_dir.mkdir()
    fasta = src_dir / "dm6.fa"
    fasta.write_bytes(plasmid_setup.fasta.read_bytes())
    state = SimpleNamespace(fasta=None, fasta_path=None, primer_fasta=None, primer_blast_db=None,
                            current_genome=None, plasmid_sequences={})
    monkeypatch.setattr("services.primer_config.set_primer_paths",
                        lambda st, *, fasta=None, blast_db=None, wait=True: setattr(st, "primer_blast_db", blast_db) or True)
    result = build_blast_db_from_fasta(state, fasta_path=str(fasta), output_dir=str(tmp_path / "my blast dbs"))
    assert result["success"] is True, result["message"]
    assert " " in result["blast_db"]
    primer = plasmid_setup.genome["chrA"][10000:10022]
    passing, counts, *_rest, stderr = blast_and_score_cached([primer], result["blast_db"])
    assert stderr == "" and counts[primer]["on_target"] == 1


def test_build_refuses_a_plasmid_map_named_as_the_fasta(plasmid_setup, tmp_path):
    from services.primer_config import build_blast_db_from_fasta
    state = SimpleNamespace(fasta=None, fasta_path=None, primer_fasta=None, primer_blast_db=None, current_genome=None)
    result = build_blast_db_from_fasta(state, fasta_path=str(plasmid_setup.dna), output_dir=str(tmp_path / "db"))
    assert result["success"] is False
    assert "is not a FASTA file" in result["message"] and "Load plasmid map" in result["message"]


# ── Unit checks (no BLAST+) ──────────────────────────────────────────────────

def test_template_self_counts_both_strands_and_the_origin():
    from services.primer_blast_scoring import template_self_counts
    rng = random.Random(3)
    template = _random_seq(rng, 400)
    primer = template[100:120]
    assert template_self_counts(primer, template)["home"] == 1
    from primer_designer import rc
    doubled = template[:300] + rc(primer) + template[320:]
    assert template_self_counts(primer, doubled)["home"] == 2
    across = template[-10:] + template[:10]  # spans the origin of the circle
    assert template_self_counts(across, template, circular=True)["home"] == 1
    assert template_self_counts(across, template, circular=False)["home"] == 0


def test_runtime_config_reads_a_picker_genome_from_its_download(tmp_path):
    """A genome opened from the Online picker keeps its URL in fasta_path; design reads the cached copy."""
    from services.primer_orchestration import resolve_primer_runtime_config
    local = tmp_path / "dm6.fa"
    local.write_text(">chr2L\nACGT\n")
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(fasta=SimpleNamespace(filename=str(local), references=["chr2L"],
                                                  get_reference_length=lambda c: 4),
                            fasta_path="https://example.org/dm6.fa.gz", primer_fasta=None,
                            primer_blast_db=str(tmp_path / "dm6"), current_genome="dm6")
    runtime, error = resolve_primer_runtime_config(state, chroms=["chr2L"], require_blastn=False)
    assert error is None
    assert runtime.fasta_path == str(local)


# ── Audit round (3.0.4): name collisions, a chosen background database, failed batches, the origin ──

def test_a_plasmid_wins_for_its_own_name_over_a_fasta_contig(tmp_path):
    """A loaded plasmid named like a FASTA contig is designed on from memory, not from the genome."""
    from services.primer_reference import get_fasta_interface, resolve_template_chrom
    fasta = tmp_path / "g.fa"
    _write_fasta(fasta, {"chrA": "A" * 200, "1": "C" * 200})
    state = SimpleNamespace(fasta=None, fasta_path=str(fasta), plasmid_sequences={"chrA": "G" * 120})
    fetch, length, available = get_fasta_interface(state, str(fasta))
    key = resolve_template_chrom("chrA", available, state)
    assert key == "chrA" and length(key) == 120 and fetch(key, 0, 5) == "GGGGG"


def test_alias_matching_never_maps_onto_a_plasmid_or_a_plasmid_onto_the_genome(tmp_path):
    from services.primer_orchestration import resolve_primer_runtime_config
    from services.primer_reference import get_fasta_interface, resolve_template_chrom
    fasta = tmp_path / "dm6.fa"
    _write_fasta(fasta, {"chr1": "C" * 300, "2": "T" * 300})
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(fasta=None, fasta_path=str(fasta), primer_fasta=None, primer_blast_db=str(tmp_path / "dm6"),
                            current_genome="dm6", plasmid_sequences={"1": "G" * 150, "chr2": "A" * 150},
                            plasmid_metadata={}, circular_chroms={})
    _f, _l, available = get_fasta_interface(state, str(fasta))
    # Plasmid "1" next to genome "chr1": each name is its own contig.
    assert resolve_template_chrom("1", available, state) == "1"
    assert resolve_template_chrom("chr1", available, state) == "chr1"
    # A genome name never resolves onto a plasmid by the chr-prefix alias ("chr2" is the plasmid; "2" is genome).
    assert resolve_template_chrom("2", available, state) == "2"
    runtime, error = resolve_primer_runtime_config(state, chroms=["1"], require_blastn=False)
    assert error is None
    assert runtime.sequence_templates == frozenset({"1"}) and runtime.expects_home_hit("1") is False
    runtime, error = resolve_primer_runtime_config(state, chroms=["chr1"], require_blastn=False)
    assert error is None and runtime.expects_home_hit("chr1") is True


def test_a_chosen_background_database_sticks_while_the_genome_is_unchanged(tmp_path):
    """dm6 open; the user chooses hg38 to screen plasmid primers: reading the config keeps hg38."""
    from services.primer_config import primer_config_payload, set_primer_paths
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    for name in ("dm6", "hg38"):
        (tmp_path / f"{name}.nin").write_text("")
    state = SimpleNamespace(fasta=None, fasta_path=str(fasta), primer_fasta=None, primer_blast_db=None,
                            current_genome="dm6", plasmid_sequences={"pX": "ACGT" * 50})
    set_primer_paths(state, blast_db=str(tmp_path / "hg38"), pin=True)
    payload = primer_config_payload(state)
    assert payload["blast_db"] == str(tmp_path / "hg38")
    assert state.primer_blast_db == str(tmp_path / "hg38")
    # A genome change still follows: the chosen database was chosen for dm6, not for the new genome.
    state.current_genome = "hg38"
    state.fasta_path = str(tmp_path / "hg38.fa")
    (tmp_path / "hg38.fa").write_text(">chr1\nACGT\n")
    assert primer_config_payload(state)["blast_db"] == str(tmp_path / "hg38")


def test_chosen_background_via_the_route_is_used_for_plasmid_design(tmp_path, standalone_app, monkeypatch):
    from services.primer_config import primer_config_payload
    from services.primer_orchestration import resolve_primer_runtime_config
    fasta = tmp_path / "dm6.fa"
    _write_fasta(fasta, {"chr2L": "ACGT" * 100})
    for name in ("dm6", "hg38"):
        (tmp_path / f"{name}.nin").write_text("")
    import asyncio
    from routers.primers_config import set_primer_config
    state = SimpleNamespace(fasta=None, fasta_path=str(fasta), primer_fasta=None, primer_blast_db=None,
                            current_genome="dm6", plasmid_sequences={"pX": "ACGT" * 50}, plasmid_metadata={},
                            circular_chroms={})
    monkeypatch.setattr("services.external_tools.blast_summary", lambda: {})
    out = asyncio.run(set_primer_config(fasta_path=None, blast_db_path=str(tmp_path / "hg38"), state=state))
    assert out["blast_db"] == str(tmp_path / "hg38")
    assert primer_config_payload(state)["blast_db"] == str(tmp_path / "hg38")
    runtime, error = resolve_primer_runtime_config(state, chroms=["pX"], require_blastn=False)
    assert error is None and runtime.blast_db_path == str(tmp_path / "hg38")
    # A dm6 contig is checked against the matching dm6 database for that run; the choice stays hg38.
    runtime, error = resolve_primer_runtime_config(state, chroms=["chr2L"], require_blastn=False)
    assert error is None and runtime.blast_db_path == str(tmp_path / "dm6")
    assert state.primer_blast_db == str(tmp_path / "hg38")


def test_a_failed_blast_batch_fails_the_request(monkeypatch):
    """Mixed 3C: the genome batch passes a primer, the plasmid batch fails: no primer passes, with an error."""
    from services import primer_blast_runtime as rt
    from services.primer_blast_validation import validate_shared_blast_result
    from services.primer_orchestration import PrimerRuntimeConfig

    def fake(seqs, db, check_three_prime=True, expect_home_hit=True, **kw):
        if expect_home_hit:
            return set(seqs), {s: {"on_target": 1, "off_target": 0, "three_prime_threats": 0} for s in seqs}, len(seqs), 0, ""
        return set(), {}, 0, 0, ""  # blastn failed with nothing on stderr
    monkeypatch.setattr(rt, "blast_and_score_cached", fake)
    runtime = PrimerRuntimeConfig(fasta_path=None, blast_db_path="/db/dm6", sequence_templates=frozenset({"pX"}))
    shared = "ACGTACGTACGTACGTACGT"
    passing, counts, *_n, stderr = rt.score_primer_specificity(
        [([shared, "TTTTACGTACGTACGTAAAA"], "chr2L"), ([shared, "GGGGACGTACGTACGTCCCC"], "pX")], runtime,
        templates={"pX": ("ACGT" * 50, True)})
    assert passing == set()
    assert "BLAST failed" in (validate_shared_blast_result(passing, counts, stderr) or {}).get("response", {}).get("message", "")


def test_self_check_counts_each_circular_site_once():
    """A primer at the origin of a circular plasmid has one site and no spurious 3'-end threat."""
    from services.primer_blast_scoring import template_self_counts
    from primer_designer import rc
    template = _random_seq(random.Random(5), 400)
    for primer in (template[0:20], rc(template[0:20]), template[-8:] + template[:12], rc(template[-8:] + template[:12])):
        counts = template_self_counts(primer, template, circular=True)
        assert counts == {"home": 1, "three_prime_threats": 0}, (primer, counts)


def test_mixed_genome_and_plasmid_3c_is_refused_clearly(tmp_path):
    """3.0.4: a 3C request with one locus on the genome and one on a plasmid map is refused (each would need
    its own database), not run against the genome database for both."""
    from services.primer_orchestration import resolve_primer_runtime_config
    fasta = tmp_path / "dm6.fa"
    _write_fasta(fasta, {"chr2L": "ACGT" * 100})
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(fasta=None, fasta_path=str(fasta), primer_fasta=None, primer_blast_db=str(tmp_path / "dm6"),
                            current_genome="dm6", plasmid_sequences={"pX": "ACGT" * 50}, plasmid_metadata={},
                            circular_chroms={})
    runtime, error = resolve_primer_runtime_config(state, chroms=["chr2L", "pX"], require_blastn=False)
    assert runtime is None
    assert "pX" in error["message"] and "chr2L" in error["message"] and "separately" in error["message"]


def test_build_folder_advice_names_only_what_exists(tmp_path, monkeypatch):
    """The 3.0.3 tree has no FIBERBROWSER_BLAST_DB_DIR: the advice must not name it."""
    import services.primer_config as pc
    monkeypatch.setattr(pc, "makeblastdb_available", lambda: True)
    fasta = tmp_path / "g.fa"
    fasta.write_text(">chr1\nACGT\n")
    blocked = tmp_path / "ro"
    blocked.mkdir()
    blocked.chmod(0o500)
    try:
        state = SimpleNamespace(fasta=None, fasta_path=None, primer_fasta=None, primer_blast_db=None,
                                current_genome=None, plasmid_sequences={})
        result = pc.build_blast_db_from_fasta(state, fasta_path=str(fasta), output_dir=str(blocked / "db"))
    finally:
        blocked.chmod(0o700)
    assert result["success"] is False
    assert "FIBERBROWSER_BLAST_DB_DIR" not in result["message"] and "Browse" in result["message"]
