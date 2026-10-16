"""The bundled demo dataset the guided tour loads."""
from types import SimpleNamespace

import pytest


def test_demo_is_bundled_and_offered_off_public_servers(monkeypatch):
    import services.runtime as runtime
    from services.demo_data import demo_info, demo_path, load_demo
    assert demo_path().exists()
    state = SimpleNamespace(datasets={})
    monkeypatch.setattr(runtime, "_public_mode", False)
    info = demo_info(state)
    assert info["available"] and info["region"]["chrom"] == "chr19" and info["dataset_id"] is None
    monkeypatch.setattr(runtime, "_public_mode", True)
    assert not demo_info(state)["available"]
    assert not load_demo(state)["success"]


def test_a_sandbox_is_offered_the_demo(monkeypatch):
    # A tour tab runs under public-mode rules, but on a local server.
    import services.runtime as runtime
    from services.demo_data import demo_info
    monkeypatch.setattr(runtime, "_public_mode", False)
    with runtime.sandbox_context("sb-" + "a" * 24):
        assert runtime.get_public_mode()
        assert demo_info(SimpleNamespace(datasets={}))["available"]


def test_a_loaded_demo_is_found_not_loaded_twice(monkeypatch):
    import services.runtime as runtime
    from services.demo_data import demo_path, load_demo
    monkeypatch.setattr(runtime, "_public_mode", False)
    state = SimpleNamespace(datasets={"napa": SimpleNamespace(paths=[str(demo_path())])})
    res = load_demo(state)
    assert res["success"] and res["dataset_id"] == "napa" and res["already_loaded"]


# ── More than one demo (3.0: the Variants section's structural-variant demo) ──

def test_every_demo_is_bundled_with_its_index():
    from services.demo_data import DEMOS, demo_path
    assert {"napa", "sv"} <= set(DEMOS)
    for demo_id in DEMOS:
        path = demo_path(demo_id)
        assert path.exists(), demo_id
        assert path.with_name(path.name + ".bai").exists(), demo_id


def test_the_main_demo_stays_the_default(monkeypatch):
    # Callers that know one demo (the tour before 3.0, check_distro.sh) see the NAPA demo as before.
    import services.runtime as runtime
    from services.demo_data import DEMO, DEMOS, demo_info, demo_path
    monkeypatch.setattr(runtime, "_public_mode", False)
    assert DEMO is DEMOS["napa"]
    assert demo_path() == demo_path("napa")
    info = demo_info(SimpleNamespace(datasets={}))
    assert info["id"] == "napa" and info["region"]["chrom"] == "chr19" and info["genome"] == "hg38"
    assert [d["id"] for d in info["demos"]] == ["napa", "sv"]
    assert all(d["available"] for d in info["demos"])


def test_the_sv_demo_is_offered_with_its_insertion(monkeypatch):
    import services.runtime as runtime
    from services.demo_data import demo_info
    monkeypatch.setattr(runtime, "_public_mode", False)
    info = demo_info(SimpleNamespace(datasets={}), "sv")
    assert info["available"] and info["genome"] == "hg38" and info["dataset_id"] is None
    assert info["region"]["chrom"] == "chr1"
    assert info["region"]["start"] < info["insertion"]["ref"] < info["region"]["end"]
    assert info["insertion"] == {"chrom": "chr1", "ref": 23_277_272, "len": 7_471}
    monkeypatch.setattr(runtime, "_public_mode", True)
    assert not any(d["available"] for d in demo_info(SimpleNamespace(datasets={}))["demos"])


def test_each_demo_is_found_loaded_by_its_own_file(monkeypatch):
    import services.runtime as runtime
    from services.demo_data import demo_info, demo_path, load_demo
    monkeypatch.setattr(runtime, "_public_mode", False)
    state = SimpleNamespace(datasets={"napa": SimpleNamespace(paths=[str(demo_path("napa"))]),
                                      "h1": SimpleNamespace(paths=[str(demo_path("sv"))])})
    res = load_demo(state, "sv")
    assert res["success"] and res["dataset_id"] == "h1" and res["already_loaded"] and res["demo"] == "sv"
    assert res["region"]["chrom"] == "chr1"
    assert load_demo(state)["dataset_id"] == "napa"
    assert {d["id"]: d["dataset_id"] for d in demo_info(state)["demos"]} == {"napa": "napa", "sv": "h1"}


def test_an_unknown_demo_is_refused(monkeypatch):
    import services.runtime as runtime
    from services.demo_data import load_demo
    monkeypatch.setattr(runtime, "_public_mode", False)
    res = load_demo(SimpleNamespace(datasets={}), "nope")
    assert not res["success"] and "nope" in res["error"]


def test_only_a_bundled_demo_counts_as_one(tmp_path):
    from services.demo_data import demo_path, is_bundled_demo_dataset
    other = tmp_path / "h1_chr1_insertion.bam"
    other.write_bytes(b"")
    state = SimpleNamespace(datasets={
        "sv": SimpleNamespace(paths=[str(demo_path("sv"))]),
        "copy": SimpleNamespace(paths=[str(other)]),
        "mixed": SimpleNamespace(paths=[str(demo_path("sv")), str(other)]),
    })
    state.get_dataset = state.datasets.get
    assert is_bundled_demo_dataset(state, "sv")
    assert not is_bundled_demo_dataset(state, "copy")
    assert not is_bundled_demo_dataset(state, "mixed")
    assert not is_bundled_demo_dataset(state, "missing")
    assert not is_bundled_demo_dataset(state, None)


@pytest.mark.parametrize("demo_id", ["napa", "sv"])
def test_every_bundled_demo_header_is_sanitized(demo_id):
    # The demo BAMs are public: their headers keep what the browser reads (the
    # references, the read groups, the FiberHMM chemistry, MA types and annotation
    # frame) and nothing
    # about where or how they were made (no @PG, no file paths, no internal ids).
    import pysam
    from services.demo_data import DEMOS, demo_path
    assert set(DEMOS) == {"napa", "sv"}  # a new demo joins the parametrize list
    with pysam.AlignmentFile(str(demo_path(demo_id)), "rb") as bam:
        header = bam.header.to_dict()
        text = str(bam.header)
        assert "PG" not in header
        assert not any(line.startswith("@PG") for line in text.splitlines())
        for marker in ("/mnt/", "/mmfs", "/gpfs/", "/scratch/", "/Users/", "/home/", "/tmp/"):
            assert marker not in text, marker
        assert set(header) <= {"HD", "SQ", "RG", "CO"}
        comments = header.get("CO", [])
        assert any(c.startswith("FIBERHMM-CHEMISTRY:") for c in comments)
        assert all(c.startswith(("FIBERHMM-CHEMISTRY:", "MA-TYPES:")) or c == "fiberhmm:coord=molecular"
                   for c in comments)
        # The @PG lines carried coord=molecular (how ns/nl/as/al/MA are framed on reverse
        # reads): FiberHMM's own @CO marker (append_coord_marker) keeps it, or every
        # reverse read's calls would be drawn mirrored.
        assert "fiberhmm:coord=molecular" in comments
        from services.bam_tags import bam_ma_aq_tags_are_molecular, legacy_tag_frame_report
        assert legacy_tag_frame_report(header)["frame"] == "molecular"
        assert bam_ma_aq_tags_are_molecular(header)
        # Without the marker the reads' own "." footprint groups still give molecular (MA and legacy tags);
        # FIBERHMM-CHEMISTRY alone does not.
        from services.bam_tags import bam_legacy_frame, ma_footprint_groups_are_molecular, read_legacy_tags_are_molecular
        without_marker = {**header, "CO": [c for c in comments if c != "fiberhmm:coord=molecular"]}
        assert legacy_tag_frame_report(without_marker)["frame"] == "seq"
        read = next(r for r in bam.fetch(until_eof=True) if r.has_tag("MA"))
        assert ma_footprint_groups_are_molecular(read.get_tag("MA"))
        assert read_legacy_tags_are_molecular(read, bam_legacy_frame(without_marker))
        rg_ids = {rg["ID"] for rg in header.get("RG", [])}
        for read in bam.fetch(until_eof=True):
            if read.has_tag("RG"):
                assert read.get_tag("RG") in rg_ids


def test_the_sv_demo_keeps_its_read_group_calls_and_haplotypes():
    import pysam
    from services.demo_data import demo_path
    with pysam.AlignmentFile(str(demo_path("sv")), "rb") as bam:
        header = bam.header.to_dict()
        assert header["RG"] == [{"ID": "H1", "SM": "H1", "LB": "H1", "PL": "PACBIO"}]
        assert any("fiberhmm_version=3.0.0" in c for c in header["CO"])
        assert any(c.startswith("MA-TYPES:") for c in header["CO"])
        assert len(header["SQ"]) > 24 and header["SQ"][0]["SN"] == "chr1"
        reads = list(bam.fetch("chr1", 23_273_500, 23_281_000))
    assert len(reads) > 100
    tags = {t for r in reads for t, _ in r.get_tags()}
    assert {"MM", "ML", "MA", "AQ", "ns", "nl", "as", "al", "HP", "PS"} <= tags
