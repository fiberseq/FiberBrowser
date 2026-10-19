"""Alt-allele panels: an insertion's carriers re-aligned onto a contig holding the insert.

The fixture (tests/insertion_fixtures.py) plants every nucleosome and m6A mark in
SEQ-frame query coordinates; on the alt contig they must land where the read's bases
align (left flank, insert, right flank), on both strands, and soft-clipped carriers
must show the part of the insert they hold.
"""
from __future__ import annotations

import json
import os
import shutil

import pysam
import pytest

from insertion_fixtures import SITE, make_insertion_bam
from services.alt_allele_align import (
    D, I, M, S, AltLayout, alt_contig_name, clip_to_contig, md_nm, normalize, realign,
)

LOADER = {"include_methylation": True, "include_layers": True}


@pytest.fixture(scope="module")
def fixture(tmp_path_factory):
    return make_insertion_bam(tmp_path_factory.mktemp("insertion"))


@pytest.fixture()
def alt_dir(tmp_path, monkeypatch):
    path = tmp_path / "alt"
    monkeypatch.setenv("FIBERBROWSER_ALT_ALLELE_DIR", str(path))
    return path


def _state(fasta: str):
    from state.browser_state import BrowserState
    state = BrowserState(None, None, None, None)
    assert state._load_fasta(fasta) is None
    return state


@pytest.fixture()
def opened(fixture, alt_dir):
    from services.alt_allele import open_alt_allele
    state = _state(fixture["fasta"])
    source = state.add_dataset("ins", fixture["bam"], label="insertion")
    result = open_alt_allele(state, source.id, {"chrom": "chrT", "pos": SITE, "flank": 3000})
    return state, result


def _records(result):
    bam = result["dataset"]["path"]
    with pysam.AlignmentFile(bam) as fh:
        return {r.query_name: r for r in fh.fetch()}, fh.references, fh.lengths


# ---------------------------------------------------------------------------
# Coordinates


def test_layout_maps_both_ways_through_the_breakpoint():
    lay = AltLayout("chr2L", 9_467_038, 9_184, 20_000, 20_000)
    assert lay.name == alt_contig_name("chr2L", 9_467_038, 9_184) == "chr2L_9467038_INS9184"
    assert lay.length == 49_184 and lay.ref_start == 9_447_038
    assert lay.ref_to_alt(9_467_037) == 19_999          # last left-flank base
    assert lay.ref_to_alt(9_467_038) == 29_184          # first right-flank base: offset by the insert
    assert lay.alt_to_ref(19_999) == 9_467_037
    assert lay.alt_to_ref(20_000) == lay.alt_to_ref(29_183) == 9_467_038  # inside: the breakpoint
    assert lay.alt_to_ref(29_184) == 9_467_038 and lay.alt_to_ref(29_185) == 9_467_039
    for g in (9_447_038, 9_460_000, 9_467_037, 9_467_038, 9_480_000):
        assert lay.alt_to_ref(lay.ref_to_alt(g)) == g
    assert lay.describe(20_000) == {"segment": "insert", "ref": None, "insert": 1}
    assert lay.describe(29_183)["insert"] == 9_184
    assert lay.describe(0) == {"segment": "left", "ref": 9_447_038, "insert": None}
    assert lay.describe(29_184) == {"segment": "right", "ref": 9_467_038, "insert": None}


def test_cigar_normalisation_and_contig_clipping():
    # A deletion or insertion next to a clip goes; a deletion first moves the start.
    assert normalize(10, [(S, 5), (D, 3), (I, 2), (M, 10), (D, 4), (S, 1)]) == (13, [(S, 7), (M, 10), (S, 1)])
    # Bases before 0 and from the contig end on become soft clips.
    start, ops = clip_to_contig(-5, [(M, 20), (D, 2), (M, 10)], 20)
    assert (start, ops) == (0, [(S, 5), (M, 15), (D, 2), (M, 3), (S, 7)])


def test_md_and_nm_against_the_contig():
    md, nm = md_nm(0, [(M, 4), (D, 2), (M, 2), (I, 1), (M, 1)], "ACGTGGTA", "ACCTAAGGA")
    assert md == "2C1^AA3" and nm == 1 + 2 + 1


def test_an_insert_placed_off_the_clusters_breakpoint_still_aligns_to_the_insert():
    """The aligner put this carrier's insertion 250 bp left of the cluster's breakpoint: the
    250 reference bases after it belong to the left flank on the contig, so the middle runs
    250 bp off the diagonal at each end (the band is widened for it)."""
    import random
    rng = random.Random(5)
    ref = "".join(rng.choice("ACGT") for _ in range(8000))
    cons = "".join(rng.choice("ACGT") for _ in range(2000))
    layout = AltLayout("c", 3000, 2000, 2000, 2000)
    alt = ref[1000:3000] + cons + ref[3000:5000]
    seq = ref[1000:2750] + cons + ref[2750:5000]
    res = realign([(M, 1750), (I, 2000), (M, 2250)], 1000, seq, {"kind": "cigar", "q": 1750, "len": 2000}, layout, alt)
    assert res is not None and res.insert_bases >= 1990
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": layout.name, "LN": layout.length}]})
    rec = pysam.AlignedSegment(header)
    rec.query_sequence, rec.reference_id, rec.reference_start, rec.cigartuples = seq, 0, res.reference_start, res.cigar
    pairs = dict(rec.get_aligned_pairs(matches_only=True))
    # The insert on the insert (its last bases interleave with the moved flank bases a little:
    # the linear gap model), the right flank where the reference has it.
    assert pairs[1750] == 2000 and abs(pairs[3500] - 3750) <= 2 and abs(pairs[3700] - 3950) <= 30
    assert pairs[4100] == 4000 + (2750 + 350 - 3000)
    # Without the widened band, the insert ran off it.
    from services.alt_allele_align import align_middle
    narrow = realign([(M, 1750), (I, 2000), (M, 2250)], 1000, seq, {"kind": "cigar", "q": 1750, "len": 2000}, layout, alt,
                     aligner=lambda q, t, _o: align_middle(q, t, 0))
    assert narrow.insert_bases < 1800


# ---------------------------------------------------------------------------
# Building from the fixture


def test_the_alt_contig_is_flank_consensus_flank(opened, fixture):
    state, result = opened
    layout = result["layout"]
    assert layout["name"] == f"chrT_{SITE}_INS{layout['insert_len']}"
    assert abs(layout["insert_len"] - len(fixture["te"])) <= 10
    fasta = pysam.FastaFile(os.path.join(os.path.dirname(result["dataset"]["path"]), "alt.fa"))
    alt = fasta.fetch(layout["name"])
    assert len(alt) == layout["length"] == 3000 + layout["insert_len"] + 3000
    assert alt[:3000] == fixture["ref"][SITE - 3000:SITE]
    assert alt[-3000:] == fixture["ref"][SITE:SITE + 3000]
    # The consensus is the element (a few edits from the planted TE at most).
    from services.insertion_consensus import align, OP_MATCH
    ops = align(alt[3000:3000 + layout["insert_len"]], fixture["te"])
    assert (ops == OP_MATCH).mean() > 0.99
    meta = result["alt_allele"]["meta"]
    assert meta["carriers"]["total"] == 24 and meta["carriers"]["written"] == 24
    assert meta["carriers"]["cigar"] == 24 and meta["carriers"]["clip_start"] == 0
    assert meta["carriers"]["clip_end"] == 0 and meta["carriers"]["hard"] == 0
    assert meta["consensus"]["method"] == "majority"
    assert meta["carriers"]["poorly_aligned"] == 0


def test_every_record_is_valid_on_the_contig(opened):
    state, result = opened
    records, refs, lengths = _records(result)
    layout = result["layout"]
    fasta = pysam.FastaFile(os.path.join(os.path.dirname(result["dataset"]["path"]), "alt.fa"))
    alt = fasta.fetch(layout["name"]).upper()
    assert refs == (layout["name"],) and lengths == (layout["length"],)
    for name, rec in records.items():
        assert rec.reference_end <= layout["length"], name
        assert rec.query_length == len(rec.query_sequence) or rec.query_sequence is None
        # The MD agrees with the contig base for base.
        for q, a, ref_base in rec.get_aligned_pairs(matches_only=True, with_seq=True):
            assert ref_base.upper() == alt[a], (name, q, a)
        assert not rec.has_tag("SA")
        assert rec.get_tag("XK") in ("cigar", "clip-start", "clip-end", "hard")


@pytest.mark.parametrize("strand", ["fwd", "rev"])
def test_insert_and_flank_bases_land_on_their_segments(opened, fixture, strand):
    state, result = opened
    records, _r, _l = _records(result)
    layout = result["layout"]
    fl, L = layout["insert_start"], layout["insert_len"]
    checked = 0
    for name, truth in fixture["reads"].items():
        if truth["kind"] != "carrier" or not name.endswith(strand) or truth["pieces"] != 1:
            continue
        pairs = dict(records[name].get_aligned_pairs(matches_only=True))
        q0, n = truth["q"], truth["len"]
        # The insert's first and last bases sit at the insert's ends (indels allow a few bp).
        assert abs(pairs[q0 + 10] - (fl + 10)) <= 6
        assert abs(pairs[q0 + n - 10] - (fl + L - 10)) <= 6
        # Flank bases are exactly where the reference has them (a jittered breakpoint's
        # few bases on the wrong side of the cluster's go with the insert).
        bp = truth["bp"]
        assert pairs[q0 - 10] == (bp - 10) - (SITE - fl)
        assert pairs[q0 + n + 10] == fl + L + (truth["ref_end"] + 10 - SITE)
        checked += 1
    assert checked >= 10


def test_unconfirmed_clips_are_excluded_from_the_default_alt_allele(opened, fixture):
    state, result = opened
    records, _r, _l = _records(result)
    layout = result["layout"]
    fl, L = layout["insert_start"], layout["insert_len"]
    assert not {'clipped_00', 'clipped_left_00', 'hard_right_00'} & set(records)
    assert "other_insert_00" not in records and not any(n.startswith("reference_") for n in records)


def test_calls_and_marks_inside_the_insert_come_from_the_reads(opened, fixture):
    from services.compact_read_loader import _build_compact_reads_from_bam_region
    state, result = opened
    layout = result["layout"]
    records, _r, _l = _records(result)
    reads = _build_compact_reads_from_bam_region(result["dataset"]["path"], layout["name"], 0, layout["length"],
                                                 spanning_only=False, **LOADER)
    by_id = {r["id"]: r for r in reads}
    fl, L = layout["insert_start"], layout["insert_len"]
    for name in ("carrier_00_fwd", "carrier_01_rev"):
        truth = fixture["reads"][name]
        pairs = dict(records[name].get_aligned_pairs(matches_only=True))
        q0, n = truth["q"], truth["len"]
        inner = [(s, k) for s, k in truth["nucs"] if q0 + 50 <= s and s + k <= q0 + n - 50]
        assert inner
        layer = by_id[name]["layers"]["nuc"]["intervals"]
        starts = {int(iv[0]) for iv in layer}
        for s, _k in inner:
            want = pairs.get(s)
            assert want is not None and fl <= want < fl + L
            assert any(abs(want - got) <= 3 for got in starts), (name, s, want)
        marks = set(by_id[name]["methyl_m6a"] if "methyl_m6a" in by_id[name] else by_id[name]["methyl"])
        in_insert = [pairs[p] for p in truth["m6a"] if q0 <= p < q0 + n and p in pairs]
        assert in_insert and sum(1 for a in in_insert if a in marks) >= 0.95 * len(in_insert)


def test_a_mixed_panel_draws_reference_reads_across_the_insert_as_a_deletion(fixture, alt_dir):
    from services.alt_allele import open_alt_allele
    state = _state(fixture["fasta"])
    source = state.add_dataset("ins", fixture["bam"])
    result = open_alt_allele(state, source.id, {"chrom": "chrT", "pos": SITE, "flank": 3000,
                                                "include_reference": True})
    records, _r, _l = _records(result)
    L = result["layout"]["insert_len"]
    refs = [r for n, r in records.items() if n.startswith("reference_")]
    assert len(refs) == 16
    for rec in refs:
        assert (D, L) in rec.cigartuples and rec.get_tag("XK") == "reference"
    assert "with 16 reference reads" in result["dataset"]["label"] and " + " not in result["dataset"]["label"]


def test_reopening_reuses_the_built_files(opened, fixture):
    from services.alt_allele import open_alt_allele
    state, first = opened
    assert first["built"] is True
    again = open_alt_allele(state, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000})
    assert again["built"] is False and again["dataset"]["id"] == first["dataset"]["id"]


def test_the_alt_dataset_has_its_own_reference(opened):
    from services import panel_genomes
    state, result = opened
    did = result["dataset"]["id"]
    key = panel_genomes.dataset_genome(state, did)
    assert key and key.startswith("fasta:alt_") and key == result["genome_key"]
    info = result["genome"]
    assert info["label"].startswith("Alt allele chrT:15,000 +") and info["has_fasta"]
    assert [c["name"] for c in info["chroms"]] == [result["layout"]["name"]]
    loci = panel_genomes.payload(state)["loci"]
    assert loci[did]["chrom"] == result["layout"]["name"]
    view = panel_genomes.genome_view(state, key)
    assert view.fasta.fetch(result["layout"]["name"], 3000, 3010)
    assert result["dataset"]["alt_allele"]["definition"]["flank"] == 3000
    assert result["dataset"]["label"].startswith("Carriers of +") and " + " not in result["dataset"]["label"]


# ---------------------------------------------------------------------------
# DAF


@pytest.fixture(scope="module")
def daf_fixture(tmp_path_factory):
    from insertion_fixtures import make_daf_insertion_bam
    out = make_daf_insertion_bam(tmp_path_factory.mktemp("daf_insertion"))
    pysam.faidx(out["fasta"])
    return out


def test_daf_alt_allele_uses_fiberhmms_consensus_and_keeps_deamination_inside(daf_fixture, alt_dir):
    pytest.importorskip("fiberhmm.daf.insert_consensus")
    from services.alt_allele import open_alt_allele
    from services.compact_read_loader import _build_compact_reads_from_bam_region
    state = _state(daf_fixture["fasta"])
    source = state.add_dataset("daf", daf_fixture["bam"])
    source.consensus_chemistry = "dddb"
    result = open_alt_allele(state, source.id, {"chrom": "chrD", "pos": daf_fixture["site"], "flank": 1000})
    assert result["alt_allele"]["meta"]["consensus"]["method"] == "daf"
    layout = result["layout"]
    fasta = pysam.FastaFile(os.path.join(os.path.dirname(result["dataset"]["path"]), "alt.fa"))
    insert = fasta.fetch(layout["name"])[layout["insert_start"]:layout["insert_end"]]
    rotation = (daf_fixture['site'] - layout['ref']) % len(insert)
    expected = daf_fixture['te']
    if rotation:
        expected = expected[-rotation:] + expected[:-rotation]
    assert insert == expected  # chemistry is preserved when the allele rotates to its canonical anchor
    reads = _build_compact_reads_from_bam_region(result["dataset"]["path"], layout["name"], 0, layout["length"],
                                                 spanning_only=False, include_methylation=True, include_layers=True)
    open_start = layout['insert_start'] + rotation
    half = open_start + daf_fixture["open_half"]
    inside = [p for r in reads if r["id"].startswith("ct") for p, *_ in r.get("deam", [])
              if open_start <= int(p) < half]
    # Normalization moves the boundary through repeat-equivalent bases. The
    # leading rotated prefix can come from the converted observed left flank;
    # the planted packed part still follows the shifted open interval.
    packed = [p for r in reads for p, *_ in r.get("deam", []) if half <= int(p) < layout['insert_end']]
    n_open_c = daf_fixture["te"][:daf_fixture["open_half"]].count("C")
    assert len(inside) > 0.6 * 24 * n_open_c   # ~80% of the open Cs deaminated on 24 C->T reads
    assert len(packed) == 0


# ---------------------------------------------------------------------------
# Endpoint and sessions


def test_open_endpoint_registers_a_dataset_on_its_own_reference(client, fixture, alt_dir):
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion"})
    source = resp.json()["dataset"]
    alt_id = None
    try:
        resp = client.post("/api/alt_allele/open", json={"dataset_id": source["id"], "chrom": "chrT",
                                                          "ref": SITE, "length": 2010, "flank": 2000})
        data = resp.json()
        assert resp.status_code == 200 and data["success"], data
        alt_id = data["dataset"]["id"]
        name = data["layout"]["name"]
        assert data["locus"]["chrom"] == name and data["locus"]["start"] < data["layout"]["insert_start"]
        resp = client.get("/api/reads/compact", params={
            "chrom": name, "start": data["layout"]["insert_start"], "end": data["layout"]["insert_end"],
            "dataset_id": alt_id, "max_reads": 100, "spanning": "false"})
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["reads"]) >= 24
        # Clustering on the insert, on the alt contig (the panel's own reference).
        resp = client.post("/api/cluster_all", params={
            "chrom": name, "start": data["layout"]["insert_start"], "end": data["layout"]["insert_end"],
            "spanning": "false", "panel_genome": data["genome_key"]},
            json={"peak_regions": [{"start": data["layout"]["insert_start"] + 100,
                                     "end": data["layout"]["insert_end"] - 100}],
                  "k": 2, "method": "kmeans", "dataset_ids": [alt_id]})
        assert resp.status_code == 200, resp.text
        clustered = resp.json()["results"][alt_id]
        assert len(clustered.get("assignments") or clustered.get("cluster_assignments") or {}) >= 20, clustered.keys()
        listed = {d["id"]: d for d in client.get("/api/datasets").json()["datasets"]}
        assert listed[alt_id]["genome"] == data["genome_key"] and listed[alt_id]["alt_allele"]
        bad = client.post("/api/alt_allele/open", json={"dataset_id": source["id"], "chrom": "chrT", "pos": 100})
        assert bad.json()["success"] is False
    finally:
        if alt_id:
            client.delete(f"/api/datasets/{alt_id}")
        client.delete(f"/api/datasets/{source['id']}")


def test_a_session_rebuilds_the_alt_allele_from_its_definition(fixture, alt_dir, tmp_path):
    from services import panel_genomes
    from services.alt_allele import open_alt_allele
    from services.session_files import _session_refs
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    state = _state(fixture["fasta"])
    state.fasta_path = fixture["fasta"]
    source = state.add_dataset("ins", fixture["bam"], label="insertion")
    result = open_alt_allele(state, source.id, {"chrom": "chrT", "pos": SITE, "flank": 3000})
    alt_id = result["dataset"]["id"]
    from models.requests import SessionExportRequest, SessionImportRequest
    session = build_session_export_for_request(state, SessionExportRequest(chrom="chrT", start=0, end=30000))["session"]
    session = json.loads(json.dumps(session, default=str))
    entry = next(d for d in session["datasets"] if d["id"] == alt_id)
    assert entry["alt_allele"]["definition"]["flank"] == 3000
    # The built files need no relinking (the source BAM is listed; the alt BAM and contig are not).
    refs = {r["path"] for r in _session_refs(session, lambda p: bool(p))}
    assert fixture["bam"] in refs and not any("alt" in os.path.basename(os.path.dirname(p)) for p in refs
                                                 if str(p).endswith(("carriers.bam", "alt.fa")))
    # The cache is gone (another computer, a cleaned folder): import rebuilds it.
    shutil.rmtree(alt_dir)
    fresh = _state(fixture["fasta"])
    out = import_session_for_request(fresh, SessionImportRequest(session=session))
    assert not out.get("datasets_failed"), out
    assert alt_id in fresh.datasets and fresh.dataset_order.index(alt_id) == session["datasets"].index(entry)
    rebuilt = fresh.datasets[alt_id]
    assert os.path.isfile(rebuilt.path) and rebuilt.alt_allele["layout"] == result["layout"]
    assert rebuilt.label == entry["label"]
    key = panel_genomes.dataset_genome(fresh, alt_id)
    assert key
    # The restored reference is named for the insertion again (whichever path attached it).
    assert panel_genomes.payload(fresh)["genomes"][0]["label"].startswith("Alt allele chrT:15,000 +")


def test_reopening_the_built_bam_by_path_knows_its_definition(opened):
    state, result = opened
    from state.browser_state import BrowserState
    other = BrowserState(None, None, None, None)
    src = other.add_dataset("ins", state.datasets["ins"].path)
    ds = other.add_dataset("again", result["dataset"]["path"])
    assert ds.alt_allele["definition"] == result["alt_allele"]["definition"]
    assert ds.alt_allele["source_dataset_id"] == src.id


# ---------------------------------------------------------------------------
# Codex review regressions


@pytest.mark.parametrize("cigar,kind,start", [
    ([(M, 100), (5, 50)], "hard", 2900),      # alignment ends at the breakpoint, the rest hard-clipped
    ([(5, 50), (M, 100)], "hard", 3000),      # starts there
])
def test_a_hard_clip_is_kept_once(cigar, kind, start):
    import random
    rng = random.Random(1)
    ref = "".join(rng.choice("ACGT") for _ in range(8000))
    layout = AltLayout("c", 3000, 500, 2000, 2000)
    alt = ref[1000:3000] + "A" * 500 + ref[3000:5000]
    seq = ref[start:start + 100]
    res = realign(cigar, start, seq, {"kind": kind}, layout, alt)
    assert sum(n for op, n in res.cigar if op == 5) == 50
    assert sum(n for op, n in res.cigar if op in (M, I, S)) == 100


def test_a_soft_clip_holding_more_insert_than_its_length_reaches_its_end():
    """A 600-base right clip that is the insert's first 640 bases with a 40-base deletion:
    its distal end is free, so it reaches insert position ~640 (not 600)."""
    import random
    rng = random.Random(9)
    ref = "".join(rng.choice("ACGT") for _ in range(8000))
    cons = "".join(rng.choice("ACGT") for _ in range(2000))
    layout = AltLayout("c", 3000, 2000, 2000, 2000)
    alt = ref[1000:3000] + cons + ref[3000:5000]
    clip = cons[:300] + cons[340:640]
    seq = ref[2000:3000] + clip
    plan = {"kind": "clip-start", "q": 1000, "len": 600}
    res = realign([(M, 1000), (S, 600)], 2000, seq, plan, layout, alt)
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": layout.name, "LN": layout.length}]})
    rec = pysam.AlignedSegment(header)
    rec.query_sequence, rec.reference_id, rec.reference_start, rec.cigartuples = seq, 0, res.reference_start, res.cigar
    pairs = dict(rec.get_aligned_pairs(matches_only=True))
    assert abs(pairs[1599] - (2000 + 639)) <= 3 and abs(pairs[1300] - (2000 + 340)) <= 3
    assert 35 <= sum(n for op, n in res.cigar if op == D) - sum(n for op, n in res.cigar if op == I) <= 45


def test_the_cache_key_follows_the_reference_file(tmp_path):
    from services.alt_allele import _cache_key
    fasta = tmp_path / "ref.fa"
    fasta.write_text(">c\nACGT\n")
    d = {"chrom": "c", "ref": 1, "length": 2}
    first = _cache_key(["x.bam"], d, False, "main", str(fasta), None)
    assert first == _cache_key(["x.bam"], d, False, "main", str(fasta), None)
    fasta.write_text(">c\nACGTACGT\n")  # another reference at the same path
    assert _cache_key(["x.bam"], d, False, "main", str(fasta), None) != first
    assert _cache_key(["x.bam"], d, False, "main", str(fasta), {"p1": "c"}) != _cache_key(["x.bam"], d, False, "main", str(fasta), None)


def test_a_session_rebuilds_from_a_source_on_its_own_reference(fixture, alt_dir):
    """The source dataset has a reference of its own (no main genome): on import its reference is
    restored before the alt allele is rebuilt, so the flanks are its sequence (not N)."""
    from models.requests import SessionExportRequest, SessionImportRequest
    from services import panel_genomes
    from services.alt_allele import open_alt_allele
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    from state.browser_state import BrowserState
    state = BrowserState(None, None, None, None)
    source = state.add_dataset("ins", fixture["bam"], label="insertion")
    panel_genomes.attach(state, ["ins"], fasta_path=fixture["fasta"], span=0)
    result = open_alt_allele(state, source.id, {"chrom": "chrT", "pos": SITE, "flank": 3000})
    alt_id = result["dataset"]["id"]
    session = build_session_export_for_request(state, SessionExportRequest(chrom="chrT", start=0, end=30000))["session"]
    session = json.loads(json.dumps(session, default=str))
    shutil.rmtree(alt_dir)
    fresh = BrowserState(None, None, None, None)
    out = import_session_for_request(fresh, SessionImportRequest(session=session))
    assert not out.get("datasets_failed"), out
    rebuilt = fresh.datasets[alt_id]
    key = panel_genomes.dataset_genome(fresh, alt_id)
    ctx = panel_genomes.contexts(fresh)[key]
    assert os.path.dirname(ctx.fasta_path) == os.path.dirname(rebuilt.path)  # its own contig, this build's
    alt = pysam.FastaFile(ctx.fasta_path).fetch(result["layout"]["name"])
    assert alt[:3000] == fixture["ref"][SITE - 3000:SITE]


def test_motif_tracks_scan_the_alt_contig_inside_the_insert(client, fixture, alt_dir):
    """A motif track in an alt-allele panel: the panel asks with its own reference (panel_genome), so the
    contig's sequence (the insert included) is served and scanned; the main genome has no such contig."""
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion"})
    source = resp.json()["dataset"]
    alt_id = None
    track_count = len(client.get("/api/tracks").json().get("tracks", []))
    try:
        data = client.post("/api/alt_allele/open", json={"dataset_id": source["id"], "chrom": "chrT",
                                                          "ref": SITE, "length": 2010, "flank": 2000}).json()
        assert data["success"], data
        alt_id = data["dataset"]["id"]
        name, key = data["layout"]["name"], data["genome_key"]
        i0, i1 = data["layout"]["insert_start"], data["layout"]["insert_end"]
        # The contig's sequence is served on its own reference (the insert's bases).
        seq = client.get("/api/sequence", params={"chrom": name, "start": i0 + 200, "end": i0 + 216, "panel_genome": key}).json()
        motif = seq.get("sequence", "").upper()
        assert len(motif) == 16 and set(motif) <= set("ACGT"), seq
        added = client.post("/api/tracks/add_motif_sequence", json={"sequence": motif, "label": "insert motif", "threshold": 0.99}).json()
        assert added.get("success", True), added
        tracks = client.get("/api/tracks").json()["tracks"]
        idx = len(tracks) - 1
        assert len(tracks) == track_count + 1
        body = {"track_indices": [idx], "chrom": name, "start": i0, "end": i1, "bins": 100, "annotation_filters": {}}
        hits = client.post("/api/tracks/batch", params={"panel_genome": key}, json=body).json()["tracks"][0]["intervals"]
        assert hits, "the motif inside the insert is found on the alt contig"
        assert any(i0 + 190 <= h["start"] <= i0 + 210 for h in hits), hits[:5]
        assert all(i0 <= h["start"] and h["end"] <= i1 for h in hits)
        # Without the panel's reference: the main genome has no such contig, so nothing (not another place).
        main = client.post("/api/tracks/batch", json=body).json()["tracks"][0]
        assert not main.get("intervals")
    finally:
        tracks = client.get("/api/tracks").json().get("tracks", [])
        for i in range(len(tracks) - 1, track_count - 1, -1):
            client.delete(f"/api/tracks/{i}")
        if alt_id:
            client.delete(f"/api/datasets/{alt_id}")
        client.delete(f"/api/datasets/{source['id']}")
