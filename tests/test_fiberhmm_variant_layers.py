"""FiberHMM ``fiberhmm_var`` / ``fiberhmm_sv`` bigBeds: detection, grouping into the sample's dataset,
the Variants panel and SV split from them, the read-row overlay, and lift with dropped blocks.

Fixtures: tests/fiberhmm_variant_fixtures.py (the sample is described there).
"""
from __future__ import annotations

import os

import pytest

from lab_fixtures import _lab, lab  # noqa: F401

import fiberhmm_variant_fixtures as fx
from fire_fixtures import bed_to_bigbed_tool

CHROM = fx.CHROM
needs_bigbed = pytest.mark.skipif(bed_to_bigbed_tool() is None, reason="bedToBigBed is not installed")


@pytest.fixture(autouse=True)
def _fresh_caches():
    from services import bigbed_detection as bd
    from services import fiberhmm_variant_layers as fvl
    for cache in (bd._bigbed_autosql_type_cache, bd._bigbed_autosql_sample_cache, fvl._field_cache, fvl._vcf_cache):
        cache.clear()
    fvl.clear_cache()
    yield
    fvl.clear_cache()


@pytest.fixture
def sample(tmp_path):
    return fx.write_sample(tmp_path / "sample")


@pytest.fixture
def dataset(client, sample):
    resp = client.post("/api/datasets/add", json={"path": str(sample["footprint"]), "label": "sampleA"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    data = resp.json()["dataset"]
    yield data
    client.delete(f"/api/datasets/{data['id']}")


# ---- parsing (no bigBed needed) ------------------------------------------------

def _var_rest(read, start, sites, alleles, bqs, extra=()):
    sizes = ",".join(str(z) for _p, z in sites) + ","
    starts = ",".join(str(p - start) for p, _z in sites) + ","
    return "\t".join([read, "0", "+", str(start), "0", "0", str(len(sites)), sizes, starts,
                      ",".join(map(str, alleles)) + ",", ",".join(map(str, bqs)) + ",", *map(str, extra)])


def test_parse_var_row_keeps_alleles_aligned_and_reads_hp():
    from services.fiberhmm_variant_layers import parse_var_row
    rest = _var_rest("r1", 100, [(150, 1), (120, 3)], [1, -3], [30, -1], extra=(2, 9))
    row = parse_var_row(CHROM, 100, 400, rest)
    # Sorted by position, each site with its own allele and quality.
    assert row.sites == [(120, 3, -3, -1), (150, 1, 1, 30)]
    assert (row.hp, row.ps) == (2, 9)


def test_parse_var_row_rejects_misaligned_allele_column():
    from services.fiberhmm_variant_layers import parse_var_row
    rest = _var_rest("r1", 100, [(150, 1), (120, 1)], [1], [30, 30])
    assert parse_var_row(CHROM, 100, 400, rest) is None


def test_named_fields_survive_an_extra_trailing_column():
    """FiberHMM may append isDuplicate (or circular fields): hp / ps are found by name."""
    from services.fiberhmm_variant_layers import parse_var_row
    names = {"blockAllele": 9, "blockBq": 10, "isDuplicate": 11, "hp": 12, "ps": 13}
    rest = _var_rest("r1", 100, [(150, 1)], [0], [30], extra=(1, 2, 5))
    row = parse_var_row(CHROM, 100, 400, rest, names)
    assert (row.hp, row.ps) == (2, 5)


def test_sv_row_events_use_the_sv_events_schema():
    from services.fiberhmm_variant_layers import SvRow, sv_row_events
    row = SvRow("r1", CHROM, 1_000, 9_000, "+", [(0, 3_000, 400, 400), (1, 5_000, 1, 120), (2, 1_000, 1, 300),
                                                 (3, 8_999, 1, 900)],
                mapq=60, read_len=10_000, flag=0, sa="chr2,101,-,500S100M,30,2;")
    events = sv_row_events(row)
    assert {"t": "D", "ref": 3_000, "len": 400, "q": -1} in events
    assert {"t": "I", "ref": 5_001, "len": 120, "q": -1} in events  # block = anchor base
    assert {"t": "S", "side": "L", "ref": 1_000, "len": 300, "q": -1} in events
    assert {"t": "S", "side": "R", "ref": 9_000, "len": 900, "q": -1} in events
    sa = [ev for ev in events if ev["t"] == "SA"]
    assert sa and sa[0]["chrom"] == "chr2" and sa[0]["pos"] == 100 and sa[0]["same_strand"] is False
    assert not [ev for ev in sv_row_events(row, link_split=False) if ev["t"] == "SA"]
    assert [ev["t"] for ev in sv_row_events(row, min_len=350, link_split=False)] == ["D", "S"]


# ---- lift (no bigBed needed) ---------------------------------------------------

def _shift_mapper():
    """Source [0, 5,500) -> +1,000; [5,500, 5,600) missing; [5,600, ...) -> +900 (fx.CHAIN)."""
    def map_interval(chrom, start, end):
        a, b = fx.lift_point(start), fx.lift_point(end - 1)
        if a is None or b is None or (start < 5_500 <= end - 1):
            return None
        return chrom, a, b + 1
    return map_interval


def test_lift_var_row_drops_failed_sites_with_their_columns():
    from services.fiberhmm_variant_layers import VarRow, lift_var_row
    row = VarRow("r1", CHROM, 1_000, 9_000, "+", [(3_000, 3, 1, 31), (5_550, 1, -3, 32), (7_000, 1, 0, 33)], 1, 7)
    lifted = lift_var_row(row, _shift_mapper())
    assert lifted.sites == [(4_000, 3, 1, 31), (7_900, 1, 0, 33)]
    assert (lifted.start, lifted.end) == (2_000, 9_900)


def test_lift_sv_row_drops_failed_events_with_type_and_length():
    from services.fiberhmm_variant_layers import SvRow, lift_sv_row
    row = SvRow("r1", CHROM, 1_000, 9_000, "+", [(1, 4_000, 1, 300), (0, 5_400, 300, 300), (0, 6_000, 500, 500)])
    lifted = lift_sv_row(row, _shift_mapper())
    # The deletion across the gap fails; the others keep their own type and length.
    assert lifted.events == [(1, 5_000, 1, 300), (0, 6_900, 500, 500)]


def test_lift_bed12_fields_keeps_per_block_columns_aligned():
    from services.fiberhmm_variant_layers import lift_bed12_fields
    rest = _var_rest("r1", 1_000, [(3_000, 3), (5_550, 1), (7_000, 1)], [1, 2, 0], [31, 32, 33], extra=(1, 7))
    fields = rest.split("\t")
    chrom, start, end, out = lift_bed12_fields(CHROM, 1_000, 9_000, fields, _shift_mapper(), per_block_columns=(9, 10))
    assert (chrom, start, end) == (CHROM, 2_000, 9_900)
    assert out[6] == "2" and out[9] == "1,0," and out[10] == "31,33,"
    assert out[8] == f"{4_000 - 2_000},{7_900 - 2_000},"


def test_chain_mapper_maps_and_inverts(tmp_path):
    from services.fiberhmm_variant_layers import ChainMapper
    path = tmp_path / "x.chain"
    path.write_text(fx.CHAIN)
    m = ChainMapper(str(path))
    assert m.map_interval(CHROM, 5_000, 5_001) == (CHROM, 6_000, 6_001)
    assert m.map_interval(CHROM, 5_550, 5_551) is None
    assert m.map_interval(CHROM, 6_000, 6_500) == (CHROM, 6_900, 7_400)
    assert m.source_intervals(CHROM, 6_000, 7_000) == [(CHROM, 5_000, 5_500), (CHROM, 5_600, 6_100)]


# ---- detection and grouping ------------------------------------------------------

@needs_bigbed
def test_tables_are_detected_and_grouped_with_the_sample(sample):
    from services.bigbed_detection import detect_bigbed_autosql_sample, detect_overlay_type, find_companion_bigbed_files
    assert detect_overlay_type(str(sample["var"])) == "var"
    assert detect_overlay_type(str(sample["sv"])) == "sv"
    assert detect_bigbed_autosql_sample(str(sample["var"])) == fx.SAMPLE
    companions = find_companion_bigbed_files(str(sample["footprint"]), "footprint")
    assert companions["var"] == str(sample["var"]) and companions["sv"] == str(sample["sv"])
    assert companions["msp"] == str(sample["msp"])


@needs_bigbed
def test_dataset_keeps_variant_layers_as_companions_only(dataset, sample):
    assert dataset["companion_layers"]["var"] == [str(sample["var"])]
    assert dataset["companion_layers"]["sv"] == [str(sample["sv"])]
    # Not read-row layers: no layer toggle for them.
    assert "var" not in dataset["available_layers"] and "sv" not in dataset["available_layers"]


@needs_bigbed
def test_folder_open_groups_variant_layers(client, sample):
    resp = client.post("/api/datasets/add", json={"path": str(sample["root"]), "label": "folder"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    data = resp.json()["dataset"]
    try:
        assert data["layer_type"] == "footprint"
        assert data["companion_layers"]["var"] == [str(sample["var"])]
        assert "var" not in data["available_layers"]
    finally:
        client.delete(f"/api/datasets/{data['id']}")


@needs_bigbed
def test_reads_are_not_touched_until_the_overlay_is_asked_for(client, dataset):
    """--all writes these layers routinely: the read rows load as before (no sv / var on them)."""
    resp = client.get("/api/reads/compact", params={
        "chrom": CHROM, "start": 2_000, "end": 8_000, "dataset_id": dataset["id"],
        "include_layers": "true", "max_reads": 100, "spanning_only": "false"})
    assert resp.status_code == 200, resp.text
    reads = resp.json()["reads"]
    assert {r["id"] for r in reads} == set(fx.READS)
    assert not any("sv" in r or "var" in r for r in reads)
    # The footprint rows are still the footprint file's (not the var file's sites).
    r0 = next(r for r in reads if r["id"] == "r00")
    assert len([iv for iv in r0["intervals"] if iv[2] > 0]) > 10


@needs_bigbed
def test_var_layer_alone_gives_span_reads(client, sample, tmp_path):
    only = fx.write_sample(tmp_path / "only", layers=("var",), vcf=False)
    resp = client.post("/api/datasets/add", json={"path": str(only["var"]), "label": "var only"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    data = resp.json()["dataset"]
    try:
        resp = client.get("/api/reads/compact", params={
            "chrom": CHROM, "start": 2_000, "end": 8_000, "dataset_id": data["id"], "max_reads": 100,
            "spanning_only": "false"})
        reads = resp.json()["reads"]
        assert {r["id"] for r in reads} == set(fx.READS)
        assert all(all(iv[2] == 0 for iv in r["intervals"]) for r in reads)
    finally:
        client.delete(f"/api/datasets/{data['id']}")


# ---- the Variants panel ----------------------------------------------------------

def by_pos_ok(scan):
    """Every site once, the overlapping 3,001 included."""
    positions = [s["pos"] for s in scan["snps"]]
    return len(positions) == len(set(positions)) and 3_001 in positions

def _post(client, url, dataset, **body):
    resp = client.post(url, json={"dataset_id": dataset["id"], "chrom": CHROM, "start": 2_000, "end": 8_000,
                                  "min_depth": 1, **body})
    assert resp.status_code == 200, resp.text
    return resp.json()


@needs_bigbed
def test_snps_come_from_the_var_layer_with_vcf_alleles(client, dataset):
    scan = _post(client, "/api/variants/snps", dataset)
    assert scan["source"] == "fiberhmm_var" and scan["vcf"] == fx.VCF_NAME
    assert by_pos_ok(scan)
    by_pos = {s["pos"]: s for s in scan["snps"]}
    site = by_pos[5_000]
    assert site["id"] == "5000:snv:A/G" and site["alleles"] == ["A", "G"]
    # Ambiguous reads are not counted; another base is.
    assert site["counts"] == {"A": 8, "G": 8, "other": 1, "ambiguous": 2}
    assert site["depth"] == 17 and site["ambiguous"] == 2
    assert by_pos[3_000]["kind"] == "del" and by_pos[3_000]["id"] == "3000:del:ref/-2"
    assert scan["n_reads"] == 20


@needs_bigbed
def test_snps_without_the_vcf_use_allele_indices(client, sample, tmp_path):
    novcf = fx.write_sample(tmp_path / "novcf", vcf=False)
    resp = client.post("/api/datasets/add", json={"path": str(novcf["footprint"]), "label": "novcf"})
    data = resp.json()["dataset"]
    try:
        scan = _post(client, "/api/variants/snps", data)
        site = next(s for s in scan["snps"] if s["pos"] == 5_000)
        assert site["id"] == "5000:snv:REF/ALT" and site["counts"]["REF"] == 8
    finally:
        client.delete(f"/api/datasets/{data['id']}")


@needs_bigbed
def test_one_site_groups_reads_by_allele_with_ambiguous_apart(client, dataset):
    grouping = _post(client, "/api/variants/alleles", dataset, snps=["5000:snv:A/G"])
    groups = {g["key"]: g for g in grouping["groups"]}
    assert groups["A"]["count"] == 8 and groups["G"]["count"] == 8
    assert groups["other"]["count"] == 1
    assert groups["ambiguous"]["count"] == 2 and groups["ambiguous"]["kind"] == "not-informative"
    assert groups["not-informative"]["count"] == 1
    # Ambiguous reads are excluded from the covering count.
    assert grouping["covering"] == 17
    a = grouping["assignments"]
    assert a["r00"] == groups["G"]["id"] and a["r08"] == groups["A"]["id"]
    assert a["r16"] == groups["ambiguous"]["id"] and a["r19"] == groups["not-informative"]["id"]
    # Accessibility from the MSP layer: open on REF, closed on ALT.
    acc = grouping["accessibility"]["groups"]
    assert acc["A"]["mean_msp_fraction"] > 0.3 and "G" not in acc
    assert "MSP" in groups["A"]["label"]


@needs_bigbed
def test_site_ids_are_matched_by_position_too(client, dataset):
    grouping = _post(client, "/api/variants/alleles", dataset, snps=["5000:snv:REF/ALT"])
    assert grouping["snps"] == ["5000:snv:A/G"]


@needs_bigbed
def test_several_sites_group_by_combination(client, dataset):
    grouping = _post(client, "/api/variants/alleles", dataset, snps=["3000:del:ref/-2", "5000:snv:A/G"],
                     min_reads=1)
    labels = {g["key"]: g["count"] for g in grouping["groups"] if g["kind"] == "combo"}
    assert labels == {"-2-G": 4, "ref-G": 4, "ref-A": 2}


@needs_bigbed
def test_hp_column_groups_reads(client, dataset):
    grouping = _post(client, "/api/variants/alleles", dataset, source="hp")
    counts = {g["key"]: g["count"] for g in grouping["groups"]}
    assert counts == {"HP1": 8, "HP2": 8, "not-informative": 4}


# ---- SVs ------------------------------------------------------------------------------

@needs_bigbed
def test_svs_in_view_from_the_sv_layer(client, dataset):
    data = _post(client, "/api/variants/svs", dataset, min_len=50)
    clusters = {(c["t"], c["ref"], c["len"]): c for c in data["clusters"]}
    assert clusters[("D", 6_000, 500)]["support"] == 11
    assert ("I", 4_000, 300) in clusters


@needs_bigbed
def test_sv_split_from_the_sv_layer(client, dataset):
    resp = client.post("/api/sv/split", json={"dataset_id": dataset["id"], "chrom": CHROM, "start": 2_000, "end": 8_000,
                                              "t": "D", "ref": 6_000, "len": 500})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    a = data["assignments"]
    assert all(a[f"r{i:02d}"] == 0 for i in range(10)) and a["r12"] == 0
    assert a["r10"] == 1  # spans the deletion without it
    assert data["counts"][0] == 11
    # Reads with no SV record are reference reads when their footprint rows span the deletion.
    # Dev line: r13's insertion and deletion overlap in one record, conflicting evidence the dev SV split leaves
    # not informative unless conflicting calls are included (sv_conflicts); the release counts it as reference.
    assert a["r19"] == 1 and a["r13"] == 2


@needs_bigbed
def test_read_overlay_events_filters_and_split_pieces(client, dataset):
    def overlay(**params):
        resp = client.get("/api/fiberhmm_layers/reads", params={
            "dataset_id": dataset["id"], "chrom": CHROM, "start": 0, "end": 30_000, **params})
        assert resp.status_code == 200, resp.text
        return resp.json()

    data = overlay()
    reads = data["reads"]
    assert reads["r00"]["sv"] == [{"t": "D", "ref": 6_000, "len": 500, "q": -1}]
    # The insertion's block is its anchor base: the event is before the next base.
    assert reads["r10"]["sv"] == [{"t": "I", "ref": 4_000, "len": 300, "q": -1}]
    r11 = reads["r11"]["sv"]
    assert r11[0]["t"] == "S" and r11[0]["side"] == "R" and r11[0]["len"] == 2_000
    assert any(ev["t"] == "SA" and ev["pos"] == 20_000 for ev in r11)
    assert [p["id"] for p in data["pieces"]] == ["r11"]
    assert data["pieces"][0]["start"] == 20_000
    # r00's two var rows (overlapping sites) come back as one read.
    assert reads["r00"]["var"] == [[3_000, 3, 1], [3_001, 1, 1], [5_000, 1, 1], [5_550, 1, 1], [7_000, 1, 0]]
    assert {s["pos"] for s in data["sites"]} == {3_000, 3_001, 5_000, 5_550, 7_000}
    # One record written as two rows: both events, its SA once.
    assert [(ev["t"], ev["ref"]) for ev in reads["r13"]["sv"]] == [("D", 6_099), ("I", 6_100)]
    assert any(c["t"] == "D" and c["ref"] == 6_000 for c in data["sv_summary"]["clusters"])

    filtered = overlay(min_mapq=20, hide_supplementary="true", link_split="false", layers="sv")
    assert "r12" not in filtered["reads"] and filtered["pieces"] == []
    assert not any(ev["t"] == "SA" for ev in filtered["reads"]["r11"]["sv"])
    assert "sites" not in filtered


@needs_bigbed
def test_info_endpoint(client, dataset):
    info = client.get("/api/fiberhmm_layers/info", params={"dataset_id": dataset["id"]}).json()
    assert info["var"] and info["sv"] and info["vcf"] == fx.VCF_NAME and info["lift"] is None
    assert info["vcf_sample"] == "synthetic_B"


# ---- lift through a chain ---------------------------------------------------------------

@needs_bigbed
def test_lifted_layers_drop_sites_and_events_that_fail(client, dataset, sample):
    resp = client.post("/api/fiberhmm_layers/lift", json={"dataset_id": dataset["id"], "chain": str(sample["chain"])})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    try:
        resp = client.get("/api/fiberhmm_layers/reads", params={
            "dataset_id": dataset["id"], "chrom": CHROM, "start": 0, "end": 12_000})
        reads = resp.json()["reads"]
        # 5,550 sits in the chain's gap: dropped with its allele; the rest move.
        assert reads["r00"]["var"] == [[4_000, 3, 1], [4_001, 1, 1], [6_000, 1, 1], [7_900, 1, 0]]
        assert reads["r00"]["sv"] == [{"t": "D", "ref": 6_900, "len": 500, "q": -1}]
        scan = _post(client, "/api/variants/snps", dataset, start=0, end=12_000)
        assert {s["pos"] for s in scan["snps"]} == {4_000, 4_001, 6_000, 7_900}
    finally:
        client.post("/api/fiberhmm_layers/lift", json={"dataset_id": dataset["id"]})


# ---- the read set: the reads the read track shows (uncalled and QC-fail rules) --

UNCALLED = ["u00", "u01"]   # var/sv rows, no footprint / MSP row: the footprint caller skipped them
QCFAIL = "q00"              # QC-fail (sv flag 0x200), and also without a footprint row


def _write_read_set_sample(root):
    from fire_fixtures import bed_to_bigbed_tool as tool_of
    tool = tool_of()
    root.mkdir(parents=True)
    stem = "sampleB"
    fx._write_bigbed(tool, fx.footprint_rows(), fx.FOOTPRINT_AS, root / f"{stem}_nucleosome.bb", "bed12+1")
    fx._write_bigbed(tool, fx.msp_rows(), fx.MSP_AS, root / f"{stem}_msp.bb", "bed12+1")
    var = fx.var_rows()
    sv = fx.sv_rows()
    for read in UNCALLED + [QCFAIL]:
        # ALT (G) at the 5000 site; a deletion at 6000 like r00-r09.
        var.append(fx._bed12(read, "+", [(5_000, 1)]) + ["1,", "30,", -1, -1, 0])
        row = fx._bed12(read, "+", [(6_000, 500)])
        row += ["0,", "500,", 60, 8_000, 0x200 if read == QCFAIL else 0, ".", -1, -1, 0]
        sv.append(row)
    fx._write_bigbed(tool, var, fx.VAR_AS, root / f"{stem}_var.bb", "bed12+5")
    fx._write_bigbed(tool, sv, fx.SV_AS, root / f"{stem}_sv.bb", "bed12+9")
    fx.write_vcf(root / fx.VCF_NAME)
    return root / f"{stem}_nucleosome.bb"


@pytest.fixture
def read_set_dataset(client, tmp_path):
    path = _write_read_set_sample(tmp_path / "read_set")
    resp = client.post("/api/datasets/add", json={"path": str(path), "label": "sampleB"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    data = resp.json()["dataset"]
    yield data
    client.delete(f"/api/datasets/{data['id']}")


@needs_bigbed
@pytest.mark.parametrize("all_reads, include_qcfail, extra", [
    (False, False, set()),                      # the default: both hidden
    (True, False, set(UNCALLED)),               # All reads, including uncalled
    (False, True, {QCFAIL}),                    # QC-fail shown by choice: exempt from the uncalled rule
    (True, True, set(UNCALLED) | {QCFAIL}),
])
def test_allele_groups_and_svs_follow_the_read_tracks_read_set(client, read_set_dataset, all_reads, include_qcfail,
                                                               extra):
    dataset = read_set_dataset
    policy = {"include_qcfail": include_qcfail, **({"min_footprints": -1} if all_reads else {})}
    grouping = _post(client, "/api/variants/alleles", dataset, snps=["5000:snv:A/G"], **policy)
    groups = {g["key"]: g for g in grouping["groups"]}
    hidden = set(UNCALLED) | {QCFAIL}
    assert groups["G"]["count"] == 8 + len(extra)       # r00-r07, and whichever extra reads are shown
    assert groups["A"]["count"] == 8
    assert set(grouping["assignments"]) & hidden == extra
    snps = _post(client, "/api/variants/snps", dataset, **policy)
    assert snps["n_reads"] == 20 + len(extra)
    svs = _post(client, "/api/variants/svs", dataset, min_len=50, **policy)
    deletion = next(c for c in svs["clusters"] if c["t"] == "D" and c["ref"] == 6_000 and c["len"] == 500)
    assert deletion["support"] == 11 + len(extra)
    split = client.post("/api/sv/split", json={"dataset_id": dataset["id"], "chrom": CHROM, "start": 2_000,
                                               "end": 8_000, "t": "D", "ref": 6_000, "len": 500,
                                               "include_qcfail": include_qcfail},
                        params={"hide_uncalled": "false"} if all_reads else {}).json()
    assert set(split["assignments"]) & hidden == extra and split["counts"][0] == 11 + len(extra)
    overlay = client.get("/api/fiberhmm_layers/reads", params={
        "dataset_id": dataset["id"], "chrom": CHROM, "start": 0, "end": 30_000,
        **({"min_footprints": -1} if all_reads else {}), **({"include_qcfail": "true"} if include_qcfail else {})}).json()
    assert set(overlay["reads"]) & hidden == extra


@needs_bigbed
def test_a_dataset_of_variant_layers_alone_hides_nothing_as_uncalled(client, tmp_path):
    # No footprint / MSP layer: no call status to go by, so no read is hidden as uncalled.
    root = tmp_path / "alone"
    sample = fx.write_sample(root, layers=("var",))
    resp = client.post("/api/datasets/add", json={"path": str(sample["var"]), "label": "alone"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    data = resp.json()["dataset"]
    try:
        snps = _post(client, "/api/variants/snps", data)
        assert snps["n_reads"] == 20
    finally:
        client.delete(f"/api/datasets/{data['id']}")


@needs_bigbed
def test_only_fiberhmm_var_and_sv_tables_are_variant_layers(tmp_path):
    """Footprint bigBeds (FiberHMM, fibertools FIRE), generic BED3/6/9/12 bigBeds and other tables
    with similar names are never taken for a var / sv layer."""
    import subprocess
    from fire_fixtures import write_fire_trackhub
    from services import bigbed_detection as bd
    from services import fiberhmm_variant_layers as fvl
    tool = bed_to_bigbed_tool()
    sample = fx.write_sample(tmp_path / "sample")
    fire = write_fire_trackhub(tmp_path / "fire")
    sizes = tmp_path / "chrom.sizes"
    sizes.write_text(f"{CHROM}\t{fx.CHROM_SIZE}\n")

    def generic(name, rows, bed_type, autosql=None):
        bed = tmp_path / f"{name}.bed"
        bed.write_text("".join("\t".join(map(str, r)) + "\n" for r in rows))
        args = [tool, f"-type={bed_type}", str(bed), str(sizes), str(tmp_path / f"{name}.bb")]
        if autosql:
            (tmp_path / f"{name}.as").write_text(autosql)
            args.insert(2, f"-as={tmp_path / f'{name}.as'}")
        subprocess.run(args, check=True, capture_output=True)
        return str(tmp_path / f"{name}.bb")

    row12 = [CHROM, 100, 400, "x", 0, "+", 100, 400, "0", 2, "50,50,", "0,250,"]
    lookalike = '''table {name}
"a lookalike table"
(
string chrom; "c"
uint chromStart; "s"
uint chromEnd; "e"
string name; "n"
)
'''
    others = {
        "bed3": generic("bed3", [[CHROM, 100, 200]], "bed3"),
        "bed6": generic("bed6", [[CHROM, 100, 200, "x", 0, "+"]], "bed6"),
        "bed9": generic("bed9", [row12[:9]], "bed9"),
        "bed12": generic("bed12", [row12], "bed12"),
        **{f"table_{t}": generic(f"table_{t}", [[CHROM, 100, 200, "x"]], "bed4", lookalike.format(name=t))
           for t in ("fiberhmm_variants", "fiberhmm_var_old", "sv", "var", "fiberhmm_svs", "variant_alleles")},
        "fiberhmm_nucleosome": str(sample["footprint"]), "fiberhmm_msp": str(sample["msp"]),
        **{f"fire_{k}": str(fire[k]) for k in ("fire-fibers", "fire-fiber-decorators", "fire-peaks",
                                               "fire-wide-peaks", "hap_differences")},
    }
    for name, path in others.items():
        assert bd.detect_bigbed_autosql_type(path) not in fvl.VARIANT_LAYER_TYPES, name
        assert fvl.strip_variant_paths([path]) == [path], name
    assert bd.detect_bigbed_autosql_type(str(sample["footprint"])) == "footprint"
    assert bd.detect_bigbed_autosql_type(str(sample["var"])) == "var"
    assert bd.detect_bigbed_autosql_type(str(sample["sv"])) == "sv"


# ---- confinement (a lab server's data roots) --------------------------------

def test_vcf_marker_must_be_a_plain_name_next_to_the_var_file(tmp_path, monkeypatch):
    from services import fiberhmm_variant_layers as fvl
    var = tmp_path / "x_var.bb"
    var.write_bytes(b"")
    (tmp_path.parent / "elsewhere.vcf.gz").write_bytes(b"")
    (tmp_path / "ok.vcf.gz").write_bytes(b"")
    for name, expected in (("../elsewhere.vcf.gz", None), ("/etc/x.vcf.gz", None), ("ok.vcf.gz", str(tmp_path / "ok.vcf.gz"))):
        fvl._vcf_cache.clear()
        monkeypatch.setattr(fvl, "source_vcf_name", lambda path, name=name: name)
        assert fvl._vcf_path(str(var)) == expected, name


@needs_bigbed
def test_lab_server_keeps_the_vcf_and_the_chain_inside_the_data_roots(lab, tmp_path):
    from lab_fixtures import member_client
    from services import fiberhmm_variant_layers as fvl
    from services.lab.users import LabUser
    from services.runtime import lab_request_context
    sample = fx.write_sample(lab.data / "sample")
    # The VCF the var file names, linked to a copy outside the data roots.
    secret = lab.outside / fx.VCF_NAME
    sample["vcf"].rename(secret)
    for ext in (".tbi",):
        (sample["root"] / (fx.VCF_NAME + ext)).rename(lab.outside / (fx.VCF_NAME + ext))
    (sample["root"] / fx.VCF_NAME).symlink_to(secret)
    (sample["root"] / (fx.VCF_NAME + ".tbi")).symlink_to(lab.outside / (fx.VCF_NAME + ".tbi"))
    fvl._vcf_cache.clear()
    assert fvl._vcf_path(str(sample["var"])) is not None  # the server's own work: not confined
    with lab_request_context(user=LabUser("alice")):
        assert fvl._vcf_path(str(sample["var"])) is None  # a member's request: outside its roots
    # The lift: a chain outside the data roots (absolute or relative) is refused.
    alice = member_client(lab)
    added = alice.post("/api/datasets/add", json={"path": str(sample["footprint"]), "label": "s"})
    assert added.status_code == 200 and added.json().get("success"), added.text
    dataset_id = added.json()["dataset"]["id"]
    (lab.outside / "shift.chain").write_text(fx.CHAIN)
    for chain in (str(lab.outside / "shift.chain"), os.path.relpath(lab.outside / "shift.chain")):
        resp = alice.post("/api/fiberhmm_layers/lift", json={"dataset_id": dataset_id, "chain": chain})
        assert resp.status_code == 403, (chain, resp.text)
    inside = alice.post("/api/fiberhmm_layers/lift", json={"dataset_id": dataset_id, "chain": str(sample["chain"])})
    assert inside.status_code == 200 and inside.json()["success"], inside.text


# ---- audit follow-ups ---------------------------------------------------------

@needs_bigbed
@pytest.mark.parametrize("how", ["file", "folder", "var_alone"])
def test_opening_reads_no_var_or_sv_rows(client, tmp_path, monkeypatch, how):
    import pyBigWig
    from services import bigbed_handles
    sample = fx.write_sample(tmp_path / "s")
    import sys
    read: list = []
    real_open = pyBigWig.open
    paths_of: dict = {}

    def spy_open(path, *a):
        handle = real_open(path, *a)
        if handle is not None:
            paths_of[id(handle)] = str(path)
        return handle

    def profile(frame, event, arg):
        # Row reads are the handles' C methods: entries() on a var / sv file.
        if event == "c_call" and getattr(arg, "__name__", "") == "entries":
            path = paths_of.get(id(getattr(arg, "__self__", None)), "")
            if path.endswith(("_var.bb", "_sv.bb")):
                import traceback
                read.append((path.rsplit("/", 1)[-1], [f"{f.name}:{f.lineno}" for f in traceback.extract_stack(frame)[-5:]]))

    monkeypatch.setattr(pyBigWig, "open", spy_open)
    for name in dir(bigbed_handles):
        cache = getattr(bigbed_handles, name)
        if name.startswith("_") and not name.startswith("__") and isinstance(cache, dict):
            cache.clear()
    path = {"file": sample["footprint"], "folder": sample["root"], "var_alone": sample["var"]}[how]
    import threading
    sys.setprofile(profile)
    threading.setprofile(profile)  # the route runs in worker threads
    try:
        resp = client.post("/api/datasets/add", json={"path": str(path), "label": f"open_{how}"})
    finally:
        threading.setprofile(None)
        sys.setprofile(None)
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    try:
        assert read == [], read
    finally:
        client.delete(f"/api/datasets/{resp.json()['dataset']['id']}")


def _sample_with(tmp_path, extra_var=(), extra_sv=(), extra_fp=(), stem="sampleC"):
    tool = bed_to_bigbed_tool()
    root = tmp_path / stem
    root.mkdir(parents=True)
    fx._write_bigbed(tool, fx.footprint_rows() + list(extra_fp), fx.FOOTPRINT_AS, root / f"{stem}_nucleosome.bb", "bed12+1")
    fx._write_bigbed(tool, fx.var_rows() + list(extra_var), fx.VAR_AS, root / f"{stem}_var.bb", "bed12+5")
    fx._write_bigbed(tool, fx.sv_rows() + list(extra_sv), fx.SV_AS, root / f"{stem}_sv.bb", "bed12+9")
    fx.write_vcf(root / fx.VCF_NAME)
    return root / f"{stem}_nucleosome.bb"


def _sv_row(read, events, flag=0, sa=".", dup=0):
    row = fx._bed12(read, "+", [(p, z) for _t, p, z, _n in events])
    return row + [",".join(str(e[0]) for e in events) + ",", ",".join(str(e[3]) for e in events) + ",",
                  60, 8_000, flag, sa, -1, -1, dup]


@needs_bigbed
def test_qc_fail_status_does_not_depend_on_the_view(client, tmp_path):
    # A QC-fail read: its variant at 5,000, its only sv record a clip at 8,999 (outside a 4-6 kb view).
    path = _sample_with(tmp_path, extra_var=[fx._bed12("qx", "+", [(5_000, 1)]) + ["1,", "30,", -1, -1, 0]],
                        extra_sv=[_sv_row("qx", [(3, 8_999, 1, 500)], flag=0x200)])
    resp = client.post("/api/datasets/add", json={"path": str(path), "label": "qc"})
    dataset = resp.json()["dataset"]
    try:
        for start, end in ((4_000, 6_000), (2_000, 9_500)):
            def ids(**policy):
                return set(_post(client, "/api/variants/alleles", dataset, snps=["5000:snv:A/G"], start=start,
                                 end=end, **policy)["assignments"])
            assert "qx" not in ids(min_footprints=-1), (start, end)          # QC-fail hidden by default
            assert "qx" in ids(include_qcfail=True), (start, end)            # shown by choice (exempt)
    finally:
        client.delete(f"/api/datasets/{dataset['id']}")


@needs_bigbed
def test_excluded_duplicates_do_not_come_back_as_reference_reads(client, tmp_path):
    # One more carrier of a deletion at 12,000 (d_keep) and a duplicate carrier (d_dup, flag 0x400),
    # both with footprint rows spanning the deletion; nobody else spans it.
    fp = [fx._bed12(r, "+", [(11_000, 1), (11_500, 147), (13_000, 1)]) + [1 if r == "d_dup" else 0]
          for r in ("d_keep", "d_dup")]
    sv = [_sv_row("d_keep", [(0, 12_000, 300, 300)]), _sv_row("d_dup", [(0, 12_000, 300, 300)], flag=0x400, dup=1)]
    path = _sample_with(tmp_path, extra_sv=sv, extra_fp=fp, stem="sampleD")
    dataset = client.post("/api/datasets/add", json={"path": str(path), "label": "dup"}).json()["dataset"]
    try:
        body = {"dataset_id": dataset["id"], "chrom": CHROM, "start": 10_500, "end": 13_500, "t": "D",
                "ref": 12_000, "len": 300}
        split = client.post("/api/sv/split", json=body).json()
        assert split["assignments"] == {"d_keep": 0} and split["counts"] == [1, 0, 0]
        shown = client.post("/api/sv/split", json={**body, "include_duplicates": True}).json()
        assert set(shown["assignments"]) == {"d_keep", "d_dup"} and shown["counts"][0] == 2
        svs = _post(client, "/api/variants/svs", dataset, start=10_500, end=13_500, min_len=50)
        cluster = next(c for c in svs["clusters"] if c["ref"] == 12_000)
        assert cluster["support"] == 1 and svs["n_reads"] == 1
    finally:
        client.delete(f"/api/datasets/{dataset['id']}")


@needs_bigbed
def test_lift_keeps_vcf_labels_and_sa_segments_on_the_target(client, dataset, sample):
    resp = client.post("/api/fiberhmm_layers/lift", json={"dataset_id": dataset["id"], "chain": str(sample["chain"])})
    assert resp.status_code == 200, resp.text
    try:
        scan = _post(client, "/api/variants/snps", dataset, start=0, end=12_000)
        by_pos = {s["pos"]: s for s in scan["snps"]}
        # Source 5,000 (A/G in the VCF) is drawn at 6,000 with its own bases; source 7,000 (C/T) at 7,900.
        assert by_pos[6_000]["id"].endswith(":snv:A/G") and by_pos[7_900]["id"].endswith(":snv:C/T")
        overlay = client.get("/api/fiberhmm_layers/reads", params={
            "dataset_id": dataset["id"], "chrom": CHROM, "start": 0, "end": 30_000}).json()
        sa = [ev for ev in overlay["reads"]["r11"]["sv"] if ev["t"] == "SA"]
        assert sa and all(ev["pos"] == fx.lift_point(20_000) for ev in sa)   # the SA segment lifted too
    finally:
        client.post("/api/fiberhmm_layers/lift", json={"dataset_id": dataset["id"]})


@needs_bigbed
def test_snps_with_svs_and_sv_snp_linkage_say_they_need_the_bam(client, dataset):
    sv = {"t": "D", "ref": 6_000, "len": 500}
    base = {"dataset_id": dataset["id"], "chrom": CHROM, "start": 2_000, "end": 8_000, "min_depth": 1}
    mixed = client.post("/api/variants/alleles", json={**base, "svs": [sv], "snps": ["5000:snv:A/G"]})
    assert mixed.status_code == 409 and "need the BAM" in mixed.json()["detail"]
    linkage = client.post("/api/variants/sv_linkage", json={**base, **sv})
    assert linkage.status_code == 409 and "need the BAM" in linkage.json()["detail"]
    # SVs alone and SNPs alone still group from the layers.
    r = client.post("/api/variants/alleles", json={**base, "svs": [sv]}); assert r.status_code == 200, r.text
    assert client.post("/api/variants/alleles", json={**base, "snps": ["5000:snv:A/G"]}).status_code == 200
