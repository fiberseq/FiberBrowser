"""SNPs and SNP combinations in a view (the Variants panel): pileup calling, the DAF-safe rule, per-read alleles,
combination grouping, and the endpoints, on explicitly synthetic reads (tests/snp_fixtures.py)."""
from __future__ import annotations

import random

import numpy as np
import pysam
import pytest

import snp_fixtures as sf
from services import snp_scan
from services import variants_endpoint as ve


@pytest.fixture(scope="module")
def fixture(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("snp")
    bam = sf.write_snp_bam(tmp / "snp.bam")
    fasta = sf.write_snp_fasta(tmp / "snp.fa")
    return {"bam": bam, "fasta": fasta}


def _scan(bam_path, start, end, ref=True, **kw):
    seq = sf.reference_sequence()[start:end] if ref else None
    with pysam.AlignmentFile(bam_path) as bam:
        pile = snp_scan.pileup(bam.fetch(sf.CHROM, start, end), sf.CHROM, start, end,
                               ref=snp_scan.encode(seq) if seq else None, **kw)
    return pile


def _matrix(bam_path, start, end, snps):
    with pysam.AlignmentFile(bam_path) as bam:
        return snp_scan.read_alleles(bam.fetch(sf.CHROM, start, end), sf.CHROM, start, end, snps)


def test_pileup_finds_the_two_snps_with_counts_strands_and_maf(fixture):
    pile = _scan(fixture["bam"], *sf.VIEW)
    assert pile.n_reads == 35
    called = snp_scan.call_snps(pile, mode="basecall")
    snps = called["snps"]
    assert [s["pos"] for s in snps] == [sf.SNP1, sf.SNP2]
    table = sf.alleles()
    s1, s2 = snps
    # SNP1: alt on hapA + hapM (18), ref on hapR + part (17); SNP2: alt on hapA only (10 of 32).
    assert s1["ref"] == table[sf.SNP1][0] and s1["alt"] == table[sf.SNP1][1]
    assert s1["counts"] == {table[sf.SNP1][0]: 17, table[sf.SNP1][1]: 18}
    assert s1["depth"] == 35 and s1["maf"] == pytest.approx(17 / 35, abs=1e-4)
    assert s2["alleles"] == [table[sf.SNP2][0], table[sf.SNP2][1]] and s2["depth"] == 32 and s2["minor"] == 10
    assert s2["both_strands"] and s2["strands"]["fwd"]["minor"] == 5 and s2["strands"]["rev"]["minor"] == 5
    assert s2["strand_balance"] == 0.5 and s2["passes"] and s2["daf_safe"] is None
    assert called["fixed"] == 0


def test_thresholds_depth_maf_and_strands_are_adjustable(fixture):
    pile = _scan(fixture["bam"], *sf.VIEW)
    assert [s["pos"] for s in snp_scan.call_snps(pile, min_maf=0.4)["snps"]] == [sf.SNP1]
    assert snp_scan.call_snps(pile, min_depth=36)["snps"] == []
    # Only forward reads: the minor allele is on one strand, so it fails "both strands" (kept, not passing).
    with pysam.AlignmentFile(fixture["bam"]) as bam:
        fwd = [r for r in bam.fetch(sf.CHROM, *sf.VIEW) if not r.is_reverse]
    pile = snp_scan.pileup(fwd, sf.CHROM, *sf.VIEW, ref=snp_scan.encode(sf.reference_sequence()[sf.VIEW[0]:sf.VIEW[1]]))
    snps = snp_scan.call_snps(pile, min_depth=10)["snps"]
    assert snps and all(not s["both_strands"] and not s["passes"] for s in snps)
    assert all(s["passes"] for s in snp_scan.call_snps(pile, min_depth=10, both_strands=False)["snps"])


def test_low_base_quality_is_not_counted(fixture, tmp_path):
    specs = sf.snp_read_specs()
    for spec in specs:
        if "hapA" in spec["name"]:
            q = ["I"] * len(spec["seq"])
            q[sf.SNP2 - spec["start"]] = "+"   # Q10 at SNP2
            spec["qual"] = "".join(q)
    bam = sf.write_reads(tmp_path / "lowq.bam", specs)
    called = snp_scan.call_snps(_scan(bam, *sf.VIEW), mode="basecall")
    assert [s["pos"] for s in called["snps"]] == [sf.SNP1]
    assert snp_scan.call_snps(_scan(bam, *sf.VIEW, min_bq=0), mode="basecall")["snps"][1]["pos"] == sf.SNP2


def test_without_a_reference_the_major_allele_stands_in(fixture):
    called = snp_scan.call_snps(_scan(fixture["bam"], *sf.VIEW, ref=False), mode="basecall")
    s1, s2 = called["snps"]
    assert s1["ref"] is None and s1["alleles"][0] == sf.alleles()[sf.SNP1][1]   # 18 alt > 17 ref
    assert s2["alleles"] == list(sf.alleles()[sf.SNP2])


def test_small_indels_are_listed_as_indels(tmp_path):
    ref = sf.reference_sequence()
    rng = random.Random(1)
    import sv_fixtures as svf
    specs = []
    for i in range(30):
        start = 6_000 + i * 3
        if i < 12:
            cigar = [(0, 8_000 - start), (2, 3), (0, 2_000)]          # 3 bp deletion at 8000
        elif i < 20:
            cigar = [(0, 9_001 - start), (1, 2), (0, 1_999)]          # 2 bp insertion after 9000
        else:
            cigar = [(0, 10_000 - start)]
        specs.append(svf._read_spec(ref, f"indel{i}", start, cigar, bool(i % 2), rng))
    bam = sf.write_reads(tmp_path / "indel.bam", specs)
    snps = snp_scan.call_snps(_scan(bam, 7_000, 9_900), mode="basecall")["snps"]
    kinds = {(s["pos"], s["kind"], s["length"]) for s in snps}
    assert (8_000, "del", 3) in kinds and (9_000, "ins", 2) in kinds
    dele = next(s for s in snps if s["kind"] == "del")
    assert dele["minor"] == 12 and dele["alt"] == "-3"
    matrix = _matrix(bam, 7_000, 9_900, snps)
    groups = snp_scan.single_snp_groups(matrix, snps, snps.index(dele))
    assert [g["count"] for g in groups["groups"][:2]] == [18, 12]


# ---------------------------------------------------------------------------
# DAF-safe filter on synthetic deaminated reads

def _daf_specs():
    """DddA-like reads: CT reads carry C->T at many C's (including C_SITE, every read), GA reads G->A at G's.
    A true C/T SNP at TRUE_SNP is on 40% of both. C_SITE is a deamination hot spot, not a SNP."""
    ref = sf.reference_sequence()
    rng = random.Random(9)
    c_positions = [i for i in range(7_000, 11_000) if ref[i] == "C"]
    g_positions = [i for i in range(7_000, 11_000) if ref[i] == "G"]
    c_site = c_positions[50]
    true_snp = next(i for i in c_positions[200:] if i > c_site + 500)
    specs = []
    for i in range(40):
        direction = "CT" if i % 2 == 0 else "GA"
        seq = list(ref)
        targets = c_positions if direction == "CT" else g_positions
        for p in rng.sample(targets, 40):
            seq[p] = "T" if direction == "CT" else "A"
        if direction == "CT":
            seq[c_site] = "T"                           # deaminated on every CT read
        if i % 5 < 2:
            seq[true_snp] = "T"                         # the real allele, both directions
        start = 6_500
        cigar = [(0, 5_000)]
        spec = {"name": f"daf{i}", "start": start, "cigar": cigar, "seq": "".join(seq[start:start + 5_000]),
                "flag": 16 if i % 4 >= 2 else 0}
        specs.append(spec)
    return specs, c_site, true_snp


def test_daf_safe_keeps_a_true_snp_and_flags_one_strand_deamination(tmp_path):
    specs, c_site, true_snp = _daf_specs()
    bam = sf.write_reads(tmp_path / "daf.bam", specs)
    pile = _scan(bam, 7_000, 11_000)
    assert pile.directions[snp_scan.DIR_CT] == 20 and pile.directions[snp_scan.DIR_GA] == 20
    assert snp_scan.detect_mode(pile, None) == "daf"
    assert snp_scan.detect_mode(pile, "hia5-pacbio") == "basecall"
    snps = {s["pos"]: s for s in snp_scan.call_snps(pile, mode="daf")["snps"]}
    hot = snps[c_site]
    assert hot["daf_safe"] is False and not hot["passes"]
    assert hot["strands"]["CT"]["minor"] == 20 and hot["strands"]["GA"]["minor"] == 0
    assert "deamination" in hot["daf_reason"]
    assert "T on 0/20 GA reads" in hot["daf_reason"]
    real = snps[true_snp]
    assert real["daf_safe"] is True and real["passes"]
    assert real["strands"]["GA"]["minor"] >= 5 and "both conversion directions" in real["daf_reason"]
    # Basecall mode would have kept the hot spot (both alignment strands carry it).
    plain = {s["pos"]: s for s in snp_scan.call_snps(pile, mode="basecall")["snps"]}
    assert plain[c_site]["passes"] and plain[c_site]["daf_safe"] is None


def test_daf_verdict_policy():
    assert snp_scan.daf_verdict(("A", "C"), {}, 0.1)[0] is True
    ok = {"CT": {"depth": 20, "product": 6}, "GA": {"depth": 20, "product": 5}}
    assert snp_scan.daf_verdict(("C", "T"), ok, 0.1)[0] is True
    one_sided = {"CT": {"depth": 20, "product": 10}, "GA": {"depth": 20, "product": 1}}
    assert snp_scan.daf_verdict(("G", "A"), one_sided, 0.1)[0] is False
    # A C heavily deaminated on CT reads (T the major allele there), C on the GA reads: the minor allele (C) is on
    # both, but the product (T) is not on the GA strand: deamination, not a SNP (IND DddB chr3L:15,048,380).
    hot = {"CT": {"depth": 1324, "product": 1171}, "GA": {"depth": 944, "product": 7}}
    safe, why = snp_scan.daf_verdict(("T", "C"), hot, 0.1)
    assert safe is False and "T on 7/944 GA reads" in why
    assert snp_scan.dominant_direction(5, 1) == snp_scan.DIR_CT
    assert snp_scan.dominant_direction(4, 0) == snp_scan.DIR_NONE   # fewer than 5 events
    assert snp_scan.dominant_direction(6, 3) == snp_scan.DIR_NONE   # purity 0.67


# ---------------------------------------------------------------------------
# Combinations

def test_two_snps_make_three_combinations(fixture):
    snps = snp_scan.call_snps(_scan(fixture["bam"], *sf.VIEW), mode="basecall")["snps"]
    matrix = _matrix(fixture["bam"], *sf.VIEW, snps)
    result = snp_scan.combinations(matrix, snps, [0, 1], auto_phase=True)
    r1, a1 = sf.alleles()[sf.SNP1]
    r2, a2 = sf.alleles()[sf.SNP2]
    combos = {g["key"]: g["count"] for g in result["groups"] if g["kind"] == "combo"}
    assert combos == {f"{r1}-{r2}": 14, f"{a1}-{a2}": 10, f"{a1}-{r2}": 8}
    assert result["covering"] == 32
    ni = next(g for g in result["groups"] if g["kind"] == "not-informative")
    assert ni["count"] == 3   # the part* reads miss SNP2
    expected = sf.expected_groups()
    by_group = {}
    for name, gid in result["assignments"].items():
        by_group.setdefault(gid, set()).add(name)
    ids = {g["key"]: g["id"] for g in result["groups"]}
    assert by_group[ids[f"{r1}-{r2}"]] == expected["hapR"]
    assert by_group[ids[f"{a1}-{a2}"]] == expected["hapA"]
    assert result["phase"]["diploid"] is False and "Not a two-haplotype" in result["phase"]["message"]
    # It says which criterion failed, with its value: 14 + 10 of 32 placed reads is 75% (< 80%); complementary, 31% >= 15%.
    assert result["phase"]["failed"] == ["the top two hold 75% of the placed reads (needs at least 80%)"]
    assert "the top two hold 75%" in result["phase"]["message"]


def test_partial_coverage_places_reads_that_fit_one_combination(fixture):
    snps = snp_scan.call_snps(_scan(fixture["bam"], *sf.VIEW), mode="basecall")["snps"]
    matrix = _matrix(fixture["bam"], *sf.VIEW, snps)
    result = snp_scan.combinations(matrix, snps, [0, 1], partial=True)
    r1, _ = sf.alleles()[sf.SNP1]
    r2, _ = sf.alleles()[sf.SNP2]
    ref_group = next(g for g in result["groups"] if g["key"] == f"{r1}-{r2}")
    assert ref_group["count"] == 17   # 14 + the 3 part* reads (reference at SNP1: only hapR fits)
    assert next(g for g in result["groups"] if g["kind"] == "not-informative")["count"] == 0


def test_rare_combinations_merge_into_other(fixture):
    snps = snp_scan.call_snps(_scan(fixture["bam"], *sf.VIEW), mode="basecall")["snps"]
    matrix = _matrix(fixture["bam"], *sf.VIEW, snps)
    result = snp_scan.combinations(matrix, snps, [0, 1], min_reads=9)
    other = next(g for g in result["groups"] if g["kind"] == "other")
    assert other["count"] == 8 and other["merged"] == 1
    assert len([g for g in result["groups"] if g["kind"] == "combo"]) == 2


def test_diploid_phasing_is_said_and_used(tmp_path):
    specs = [s for s in sf.snp_read_specs() if "hapM" not in s["name"] and "part" not in s["name"]]
    bam = sf.write_reads(tmp_path / "dip.bam", specs)
    snps = snp_scan.call_snps(_scan(bam, *sf.VIEW), mode="basecall")["snps"]
    matrix = _matrix(bam, *sf.VIEW, snps)
    result = snp_scan.combinations(matrix, snps, [0, 1])
    assert result["phase"]["diploid"] is True and "Looks diploid" in result["phase"]["message"]
    assert [g["label"].split()[0] for g in result["groups"][:2]] == ["H1", "H2"]


def test_single_snp_splits_ref_and_alt(fixture):
    snps = snp_scan.call_snps(_scan(fixture["bam"], *sf.VIEW), mode="basecall")["snps"]
    matrix = _matrix(fixture["bam"], *sf.VIEW, snps)
    result = snp_scan.single_snp_groups(matrix, snps, 1)
    labels = [(g["label"], g["count"]) for g in result["groups"]]
    r2, a2 = sf.alleles()[sf.SNP2]
    assert labels[0] == (f"ref {r2}", 22) and labels[1] == (f"alt {a2}", 10)
    assert labels[3] == ("Not informative", 3)


def test_hp_tags_group_reads(tmp_path):
    specs = sf.snp_read_specs()
    for spec in specs:
        if "hapA" in spec["name"]:
            spec["tags"] = spec["tags"] + [("HP", 1)]
        elif "hapR" in spec["name"]:
            spec["tags"] = spec["tags"] + [("HP", 2)]
    bam = sf.write_reads(tmp_path / "hp.bam", specs)
    pile = _scan(bam, *sf.VIEW)
    assert pile.hp["1"] == 10 and pile.hp["2"] == 14
    snps = snp_scan.call_snps(pile, mode="basecall")["snps"]
    result = snp_scan.hp_groups(_matrix(bam, *sf.VIEW, snps))
    assert [(g["label"], g["count"]) for g in result["groups"]] == [("HP 1", 10), ("HP 2", 14), ("No HP tag", 11)]


def test_linked_snps_collapse_to_one_tag(fixture):
    snps = snp_scan.call_snps(_scan(fixture["bam"], *sf.VIEW), mode="basecall")["snps"]
    matrix = _matrix(fixture["bam"], *sf.VIEW, snps)
    # SNP1 and SNP2 are not linked (hapM): two tags.
    tags, members = snp_scan.ld_tags(matrix, snps, [0, 1], min_pair_reads=5)
    assert tags == [0, 1]
    # Two copies of SNP2 (perfectly linked): one tag.
    dup = snps + [dict(snps[1], id="copy")]
    matrix2 = snp_scan.AlleleMatrix(matrix.names, np.hstack([matrix.codes, matrix.codes[:, 1:2]]), matrix.reverse,
                                    matrix.hp, matrix.positions + [snps[1]["pos"]], matrix.kinds + ["snv"],
                                    matrix.ids + ["copy"])
    tags, members = snp_scan.ld_tags(matrix2, dup, [0, 1, 2], min_pair_reads=5)
    assert len(tags) == 2 and sorted(len(m) for m in members.values()) == [1, 2]


# ---------------------------------------------------------------------------
# Endpoints

@pytest.fixture
def dataset(client, fixture):
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "snp"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    ds = resp.json()["dataset"]
    ve.clear_cache()
    yield ds
    client.delete(f"/api/datasets/{ds['id']}")
    ve.clear_cache()


def test_snps_endpoint_and_cache(client, dataset, monkeypatch):
    monkeypatch.setattr(ve, "_reference", lambda state, chrom, s, e: snp_scan.encode(sf.reference_sequence()[s:e]))
    body = {"dataset_id": dataset["id"], "chrom": sf.CHROM, "start": sf.VIEW[0], "end": sf.VIEW[1]}
    first = client.post("/api/variants/snps", json=body)
    assert first.status_code == 200, first.text
    data = first.json()
    assert [s["pos"] for s in data["snps"]] == [sf.SNP1, sf.SNP2]
    assert data["mode"] == "basecall" and data["reference"] == "fasta" and data["n_reads"] == 35
    assert data["cached"] is False
    again = client.post("/api/variants/snps", json={**body, "min_maf": 0.4}).json()
    assert again["cached"] is True and [s["pos"] for s in again["snps"]] == [sf.SNP1]
    assert again["scan_key"] != data["scan_key"]


def test_alleles_endpoint_groups_and_errors(client, dataset):
    body = {"dataset_id": dataset["id"], "chrom": sf.CHROM, "start": sf.VIEW[0], "end": sf.VIEW[1]}
    snps = client.post("/api/variants/snps", json=body).json()
    assert snps["reference"] == "none"
    ids = [s["id"] for s in snps["snps"]]
    resp = client.post("/api/variants/alleles", json={**body, "snps": ids})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert sorted(g["count"] for g in data["groups"] if g["kind"] == "combo") == [8, 10, 14]
    assert len(data["assignments"]) == 35
    one = client.post("/api/variants/alleles", json={**body, "snps": ids[1:]}).json()
    assert [g["count"] for g in one["groups"]] == [22, 10, 0, 3]
    info = client.post("/api/variants/alleles", json={**body, "snps": "informative"}).json()
    assert len(info["snps"]) == 2 and info["tags"] is not None
    hp = client.post("/api/variants/alleles", json={**body, "source": "hp"}).json()
    assert hp["groups"][-1]["count"] == 35
    bad = client.post("/api/variants/alleles", json={**body, "snps": ["1:snv:A/C"]})
    assert bad.status_code == 409   # outside the view
    junk = client.post("/api/variants/alleles", json={**body, "snps": ["x"]})
    assert junk.status_code == 400
    # A SNP these thresholds do not call (SNP2 at MAF 0.31 > 0.4 is not called) is still read.
    strict = client.post("/api/variants/alleles", json={**body, "min_maf": 0.4, "snps": ids})
    assert strict.status_code == 200, strict.text
    assert sorted(g["count"] for g in strict.json()["groups"] if g["kind"] == "combo") == [8, 10, 14]
    wide = client.post("/api/variants/snps", json={**body, "start": 0, "end": 400_000})
    assert wide.status_code == 413
    missing = client.post("/api/variants/snps", json={**body, "dataset_id": "nope"})
    assert missing.status_code == 404


def test_svs_and_their_snp_linkage(client, tmp_path):
    """An insertion carried by the hapA reads only: listed, and its carriers carry SNP2's alternate allele."""
    import sv_fixtures as svf
    ref = sf.reference_sequence()
    rng = random.Random(4)
    specs = []
    for hap, (a1, a2, n) in sf.HAPLOTYPES.items():
        seq = sf._haplotype(ref, a1, a2)
        for i in range(n):
            start = sf.READ_START + (i % 5) * 37
            if hap == "hapA":
                cigar = [(0, 10_000 - start), (1, 400), (0, sf.READ_END - 10_000)]
            else:
                cigar = [(0, sf.READ_END - start)]
            specs.append(svf._read_spec(seq, f"snp/{hap}{i}/ccs", start, cigar, bool(i % 2), rng))
    bam = sf.write_reads(tmp_path / "sv_snp.bam", specs)
    resp = client.post("/api/datasets/add", json={"path": bam, "label": "sv-snp"})
    ds = resp.json()["dataset"]
    ve.clear_cache()
    try:
        body = {"dataset_id": ds["id"], "chrom": sf.CHROM, "start": sf.VIEW[0], "end": sf.VIEW[1]}
        svs = client.post("/api/variants/svs", json=body).json()
        assert [(c["t"], c["ref"], c["len"], c["support"]) for c in svs["clusters"]] == [("I", 10_000, 400, 10)]
        link = client.post("/api/variants/sv_linkage", json={**body, "t": "I", "ref": 10_000, "len": 400}).json()
        assert link["counts"] == {"carriers": 10, "reference": 22, "not_informative": 0}
        by_pos = {s["pos"]: s for s in link["snps"]}
        snp2 = by_pos[sf.SNP2]
        assert snp2["linked"] and snp2["carriers"]["fraction"] == 1.0 and snp2["reference"]["fraction"] == 0.0
        assert not by_pos[sf.SNP1]["linked"] and link["linked"] == 1 and link["tested"] == 2
    finally:
        client.delete(f"/api/datasets/{ds['id']}")
        ve.clear_cache()


def test_an_indel_most_reads_carry_reports_the_reference_as_its_minor_allele(tmp_path):
    import sv_fixtures as svf
    ref = sf.reference_sequence()
    rng = random.Random(2)
    specs = []
    for i in range(30):
        start = 6_000 + i * 3
        cigar = [(0, 8_000 - start), (2, 2), (0, 2_000)] if i < 24 else [(0, 10_000 - start)]
        specs.append(svf._read_spec(ref, f"maj{i}", start, cigar, bool(i % 2), rng))
    bam = sf.write_reads(tmp_path / "major_del.bam", specs)
    dele = next(s for s in snp_scan.call_snps(_scan(bam, 7_000, 9_900), mode="basecall")["snps"] if s["kind"] == "del")
    assert dele["alleles"] == ["-2", "ref"] and dele["minor"] == 6
    assert dele["strands"]["fwd"]["minor"] + dele["strands"]["rev"]["minor"] == 6


def test_informative_snps_prefer_blocks_of_linked_snps(client, tmp_path):
    """Two blocks of linked SNPs and a lone SNP: the combination uses one tag per block, not the lone SNP."""
    import sv_fixtures as svf
    ref = sf.reference_sequence()
    rng = random.Random(6)
    block_a = [8_000, 8_100, 8_200]
    block_b = [9_000, 9_100]
    lone = 9_500
    specs = []
    for i in range(40):
        seq = list(ref)
        if i % 2 == 0:
            for p in block_a:
                seq[p] = sf._OTHER[ref[p]]
        if i % 4 < 2 and i < 30:
            for p in block_b:
                seq[p] = sf._OTHER[ref[p]]
        if i % 5 == 0:
            seq[lone] = sf._OTHER[ref[lone]]
        start = 6_000 + (i % 7) * 11
        specs.append(svf._read_spec("".join(seq), f"blk{i}", start, [(0, 12_000 - start)], bool(i % 3 == 0), rng))
    bam = sf.write_reads(tmp_path / "blocks.bam", specs)
    ds = client.post("/api/datasets/add", json={"path": bam, "label": "blocks"}).json()["dataset"]
    ve.clear_cache()
    try:
        body = {"dataset_id": ds["id"], "chrom": sf.CHROM, "start": 7_000, "end": 11_000, "min_depth": 10}
        info = client.post("/api/variants/alleles", json={**body, "snps": "informative"}).json()
        assert [len(t["members"]) for t in info["tags"]] == [3, 2]
        assert len(info["snps"]) == 2
        every = client.post("/api/variants/alleles", json={**body, "snps": "informative", "all_tags": True}).json()
        assert len(every["snps"]) == 3
    finally:
        client.delete(f"/api/datasets/{ds['id']}")
        ve.clear_cache()


def test_alleles_from_the_pileup_match_a_second_pass(fixture, tmp_path):
    """With a reference, the scan keeps each read's differences: the alleles read back equal a pass over the BAM
    (SNVs, a low-quality base, deletions and insertions)."""
    import sv_fixtures as svf
    ref = sf.reference_sequence()
    rng = random.Random(8)
    specs = sf.snp_read_specs()
    for i in range(12):
        start = 6_100 + i * 5
        cigar = [(0, 8_500 - start), (2, 3), (0, 600), (1, 2), (0, 2_000)] if i < 8 else [(0, 11_500 - start)]
        specs.append(svf._read_spec(ref, f"ind{i}", start, cigar, bool(i % 2), rng))
    q = list("I" * len(specs[0]["seq"]))
    q[sf.SNP1 - specs[0]["start"]] = "+"
    specs[0]["qual"] = "".join(q)
    bam = sf.write_reads(tmp_path / "mixed.bam", specs)
    pile = _scan(bam, *sf.VIEW)
    snps = snp_scan.call_snps(pile, mode="basecall", min_maf=0.05)["snps"]
    assert {s["kind"] for s in snps} == {"snv", "del", "ins"}
    fast = snp_scan.alleles_from_pileup(pile, snps)
    slow = _matrix(bam, *sf.VIEW, snps)
    assert fast.names == slow.names
    assert np.array_equal(fast.codes, slow.codes)
    assert fast.codes[0, 0] == snp_scan.N


# ---------------------------------------------------------------------------
# Codex review regressions

def test_two_insertion_lengths_at_one_anchor_are_two_alleles(tmp_path):
    import sv_fixtures as svf
    ref = sf.reference_sequence()
    rng = random.Random(12)
    specs = []
    for i in range(30):
        start = 6_000 + i * 3
        if i < 10:
            cigar = [(0, 9_001 - start), (1, 2), (0, 1_999)]
        elif i < 20:
            cigar = [(0, 9_001 - start), (1, 3), (0, 1_999)]
        else:
            cigar = [(0, 11_000 - start)]
        specs.append(svf._read_spec(ref, f"len{i}", start, cigar, bool(i % 2), rng))
    bam = sf.write_reads(tmp_path / "two_len.bam", specs)
    pile = _scan(bam, 7_000, 10_500)
    called = snp_scan.call_snps(pile, mode="basecall")
    ins = sorted((s["length"], s["minor"]) for s in called["snps"] if s["kind"] == "ins")
    assert ins == [(2, 10), (3, 10)]
    assert called["fixed"] == 0
    snps = called["snps"]
    two = next(j for j, s in enumerate(snps) if s["kind"] == "ins" and s["length"] == 2)
    for matrix in (snp_scan.alleles_from_pileup(pile, snps), _matrix(bam, 7_000, 10_500, snps)):
        codes = dict(zip(matrix.names, matrix.codes[:, two].tolist()))
        assert codes["len0"] == snp_scan.HAS_EVENT
        assert codes["len10"] == snp_scan.N          # the other insertion: neither allele
        assert codes["len25"] == snp_scan.NO_EVENT


def test_a_reference_skip_is_not_coverage(tmp_path):
    ref = sf.reference_sequence()
    specs = [{"name": "spliced", "start": 7_990, "cigar": [(0, 5), (3, 20), (0, 5)],
              "seq": ref[7_990:7_995] + ref[8_015:8_020], "flag": 0}]
    for i in range(3):
        specs.append({"name": f"plain{i}", "start": 7_990, "cigar": [(0, 30)], "seq": ref[7_990:8_020], "flag": 0})
    bam = sf.write_reads(tmp_path / "skip.bam", specs)
    pile = _scan(bam, 7_980, 8_030)
    cands = [{"id": "8000:snv:A/C", "pos": 8_000, "kind": "snv", "alleles": ["A", "C"], "length": 0},
             {"id": "8001:ins:ref/+2", "pos": 8_001, "kind": "ins", "alleles": ["ref", "+2"], "length": 2}]
    fast = snp_scan.alleles_from_pileup(pile, cands)
    slow = _matrix(bam, 7_980, 8_030, cands)
    assert np.array_equal(fast.codes, slow.codes)
    row = fast.codes[fast.names.index("spliced")]
    assert row.tolist() == [snp_scan.MISSING, snp_scan.MISSING]


def test_maf_zero_calls_nothing_where_every_read_agrees(fixture):
    snps = snp_scan.call_snps(_scan(fixture["bam"], 7_500, 7_600), mode="basecall", min_maf=0.0, min_depth=1)["snps"]
    assert snps == []


def test_daf_calls_without_a_reference_do_not_pass(tmp_path):
    specs, c_site, true_snp = _daf_specs()
    bam = sf.write_reads(tmp_path / "daf_noref.bam", specs)
    pile = _scan(bam, 7_000, 11_000, ref=False)
    snps = snp_scan.call_snps(pile, mode="daf", both_strands=False)["snps"]
    assert snps and all(s["daf_safe"] is None and not s["passes"] for s in snps if {*s["alleles"]} in ({"C", "T"}, {"G", "A"}))


def test_daf_fraction_is_fiberhmms_twenty_percent():
    weak = {"CT": {"depth": 50, "product": 5}, "GA": {"depth": 50, "product": 5}}   # 10% each
    safe, why = snp_scan.daf_verdict(("C", "T"), weak, 0.1)
    assert safe is False and "under the policy's 20%" in why
    strong = {"CT": {"depth": 50, "product": 10}, "GA": {"depth": 50, "product": 10}}
    assert snp_scan.daf_verdict(("C", "T"), strong, 0.1)[0] is True


def test_a_read_placed_late_adds_its_alleles_to_the_combination():
    combos, member = snp_scan.assemble([["A", "C", None]] * 3 + [["A", "G", None], ["A", None, "T"]])
    placed = member[4]
    assert placed == member[0] and combos[placed] == ["A", "C", "T"]


def test_a_reloaded_reference_is_a_new_scan(client, dataset, tmp_path, monkeypatch):
    fasta = tmp_path / "ref.fa"
    sf.write_snp_fasta(fasta)
    import pysam as _pysam
    holder = type("F", (), {})()
    holder.filename = str(fasta).encode()
    holder.references = [sf.CHROM]
    holder.fetch = lambda name, s, e: _pysam.FastaFile(str(fasta)).fetch(name, s, e)
    body = {"dataset_id": dataset["id"], "chrom": sf.CHROM, "start": sf.VIEW[0], "end": sf.VIEW[1]}
    import server as srv
    monkeypatch.setattr(srv.state, "fasta", holder, raising=False)
    first = client.post("/api/variants/snps", json=body).json()
    assert first["reference"] == "fasta"
    again = client.post("/api/variants/snps", json=body).json()
    assert again["cached"] is True and again["scan_key"] == first["scan_key"]
    import os, time
    seq = sf.reference_sequence()
    with open(fasta, "w") as fh:
        fh.write(f">{sf.CHROM}\n{seq[:sf.SNP1]}{'C' if seq[sf.SNP1] != 'C' else 'G'}{seq[sf.SNP1 + 1:]}\n")
    os.utime(fasta, (time.time() + 5, time.time() + 5))
    _pysam.faidx(str(fasta))
    fresh = client.post("/api/variants/snps", json=body).json()
    assert fresh["cached"] is False and fresh["scan_key"] != first["scan_key"]


def test_panel_reference_and_split_reads_are_used_and_cached_separately(client, dataset, fixture):
    from services import panel_genomes
    from state import runtime_state
    state = runtime_state.get_browser_state()
    panel_genomes.attach(state, [dataset['id']], fasta_path=fixture['fasta'])
    body = {'dataset_id': dataset['id'], 'chrom': sf.CHROM, 'start': sf.VIEW[0], 'end': sf.VIEW[1]}
    whole = client.post('/api/variants/snps', json=body).json()
    assert whole['reference'] == 'fasta'
    assert whole['n_reads'] == 35
    with pysam.AlignmentFile(fixture['bam']) as bam:
        ids = [read.query_name for read in bam.fetch(sf.CHROM, *sf.VIEW)][:4]
    split = client.post('/api/variants/snps', json={**body, 'read_ids': ids}).json()
    assert split['reference'] == 'fasta'
    assert split['n_reads'] == 4
    assert split['scan_key'] != whole['scan_key']
    empty = client.post('/api/variants/snps', json={**body, 'read_ids': []}).json()
    assert empty['n_reads'] == 0
    assert client.post('/api/variants/snps', json=body).json()['n_reads'] == 35
