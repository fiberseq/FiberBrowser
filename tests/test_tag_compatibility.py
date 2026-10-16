"""FiberHMM / fibertools tag compatibility (release audit, item 9).

- FiberHMM writes the DAF strand tag as ``st:Z`` (``fiberhmm/daf/encoder.py``); ``ST`` is the older spelling.
- ``fiberhmm-extract --both-strand`` bigBeds (autoSQL table ``fiberhmm_bothstrand``, file ``<ds>_bothstrand.bb``).
- Reads whose footprints are only in an MA tag must count toward ``min_footprints``.
- fibertools-rs: ``ft predict-m6a`` ns/nl are molecular frame; current fibertools writes ``Ma`` (not ``MA``).
"""
import pysam

from services import bam_tags, bigbed_detection as bd, compact_read_loader
from test_compact_read_loader import FakeBam, FakeBamRead, FakeBigBed, bed12_rest


# ---------------------------------------------------------------- st:Z

def _daf_read(tags):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6"}, "SQ": [{"SN": "chrT", "LN": 1000}]})
    read = pysam.AlignedSegment(header)
    read.query_name = "r"
    # Mixed Y and R: without a strand tag the channel is ambiguous and no opportunity rug is emitted.
    read.query_sequence = "ACYGTRCG"
    read.reference_id = 0
    read.reference_start = 100
    read.cigarstring = "8M"
    for tag, value in tags.items():
        read.set_tag(tag, value, value_type="Z")
    return read


def test_lowercase_fiberhmm_strand_tag_selects_the_daf_channel():
    lower = bam_tags.parse_deamination_opportunities(_daf_read({"st": "CT"}), 100, 108)
    upper = bam_tags.parse_deamination_opportunities(_daf_read({"ST": "CT"}), 100, 108)
    assert lower == upper
    assert lower["ct"] and not lower["ga"]
    ga = bam_tags.parse_deamination_opportunities(_daf_read({"st": "GA"}), 100, 108)
    assert ga["ga"] and not ga["ct"]


# ---------------------------------------------------------------- bothstrand bigBeds

def test_fiberhmm_bothstrand_table_and_filename_are_recognised(monkeypatch):
    bd._bigbed_autosql_type_cache.clear()
    bd._bigbed_autosql_sample_cache.clear()
    monkeypatch.setattr(bd, "_read_bigbed_autosql",
                        lambda path: 'table fiberhmm_bothstrand\n"Sample: s1. FiberHMM paired-duplex DAF coverage."\n(\n)')
    assert bd.detect_overlay_type("/tmp/s1_bothstrand.bb") == "bothstrand"
    bd._bigbed_autosql_type_cache.clear()
    bd._bigbed_autosql_sample_cache.clear()
    monkeypatch.setattr(bd, "_read_bigbed_autosql", lambda path: None)
    # fiberhmm-extract names it <dataset>_bothstrand.bb; without it this fell through to 'unknown' and was
    # registered as the dataset's primary footprint layer.
    assert bd.detect_overlay_type("/tmp/s1_bothstrand.bb") == "bothstrand"
    assert bd.display_layer_type("bothstrand") != "BOTHSTRAND"


def test_bothstrand_companion_is_found_next_to_its_footprint_file(tmp_path, monkeypatch):
    tables = {"s1_nucleosome.bb": "fiberhmm_nucleosome", "s1_bothstrand.bb": "fiberhmm_bothstrand",
              "s1_tf.bb": "fiberhmm_tf"}
    for name in tables:
        (tmp_path / name).write_bytes(b"")
    bd._bigbed_autosql_type_cache.clear()
    bd._bigbed_autosql_sample_cache.clear()
    monkeypatch.setattr(bd, "_read_bigbed_autosql",
                        lambda path: f'table {tables[path.rsplit("/", 1)[-1]]}\n"Sample: s1. calls"\n(\n)')
    companions = bd.find_companion_bigbed_files(str(tmp_path / "s1_nucleosome.bb"), "footprint")
    assert companions == {"bothstrand": str(tmp_path / "s1_bothstrand.bb"), "tf": str(tmp_path / "s1_tf.bb")}
    # Filename-only files (no autoSQL) group the same way.
    bd._bigbed_autosql_type_cache.clear()
    bd._bigbed_autosql_sample_cache.clear()
    monkeypatch.setattr(bd, "_read_bigbed_autosql", lambda path: None)
    for name in ("s2_fp.bb", "s2_bothstrand.bb"):
        (tmp_path / name).write_bytes(b"")
    assert bd.find_companion_bigbed_files(str(tmp_path / "s2_fp.bb"), "footprint") == {
        "bothstrand": str(tmp_path / "s2_bothstrand.bb")}


def test_bothstrand_bigbed_loads_as_its_own_interval_layer():
    bb = {
        "fp.bb": FakeBigBed({"chr2L": [(100, 400, bed12_rest("m1", [100, 100], [0, 200]))]}),
        "both.bb": FakeBigBed({"chr2L": [(150, 330, bed12_rest("m1", [30, 50], [0, 130]))]}),
    }
    kinds = {"fp.bb": "footprint", "both.bb": "bothstrand"}
    reads = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb", "both.bb"], "2L", 100, 400, spanning_only=False,
        bigbed_handle_getter=bb.get, overlay_type_detector=kinds.get,
        duplicate_field_detector=lambda _p: False, format_cache={})
    assert len(reads) == 1
    assert reads[0]["layers"]["bothstrand"]["intervals"] == [[50, 80, 30], [180, 230, 50]]
    # The duplex-coverage spans are not footprints: the read's own intervals come from the footprint file.
    assert [iv for iv in reads[0]["intervals"] if iv[2] > 0] == [[0, 100, 100], [200, 300, 100]]

    alone = compact_read_loader.build_compact_reads_from_bigbed(
        ["both.bb"], "2L", 100, 400, spanning_only=False,
        bigbed_handle_getter=bb.get, overlay_type_detector=kinds.get,
        duplicate_field_detector=lambda _p: False, format_cache={})
    assert alone[0]["layers"]["bothstrand"]["intervals"] == [[50, 80, 30], [180, 230, 50]]
    assert "nuc" not in alone[0].get("layers", {})


# ---------------------------------------------------------------- MA-only reads and min_footprints

def test_min_footprints_counts_footprints_carried_only_in_ma():
    reads = [
        FakeBamRead("ma_many", 100, 300, tags={"MA": "200;nuc+QQQ:1-10,31-10,61-10;tf+QQQ:91-10,121-10,151-10",
                                                "AQ": [1] * 18}),
        FakeBamRead("ma_few", 100, 300, tags={"MA": "200;nuc+QQQ:1-10;msp+Q:21-60", "AQ": [1, 1, 1, 1]}),
        FakeBamRead("no_tags", 100, 300),
    ]
    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/reads.bam", "chr2L", 100, 300, spanning_only=False, min_footprints=5,
        bam_handle_getter=lambda _path: FakeBam(reads))
    assert [r["id"] for r in result] == ["ma_many"]
    assert result[0]["layers"]["nuc"]["intervals"][0][:2] == [0, 10]


# ---------------------------------------------------------------- fibertools frame and Ma

def test_ft_predict_m6a_ns_nl_are_molecular_frame():
    # fibertools-rs predict-m6a calls add_nucleosomes_to_record(record, modified_bases_forward, ...)
    # (src/subcommands/predict_m6a.rs), i.e. the same molecular-frame writer as add-nucleosomes, and reads ns/nl
    # back as "forward" starts that it flips for reverse reads (src/utils/bamranges.rs). `ft predict-m6a --help`
    # (v0.13.0): "Also adds nucleosome (nl, ns) and MTase sensitive patches (al, as)".
    for cl in ("ft predict-m6a in.bam out.bam", "ft m6a -t 8 in.bam out.bam", "/bin/ft fire in.bam out.bam"):
        assert bam_tags.bam_legacy_tags_are_molecular({"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "CL": cl}]}) is True
    # A later FiberHMM run rewrote ns/nl in SEQ frame (old FiberHMM, no coord=molecular): FiberHMM wins.
    assert bam_tags.bam_legacy_tags_are_molecular({"PG": [
        {"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft predict-m6a in.bam out.bam"},
        {"ID": "fiberhmm", "PN": "fiberhmm", "PP": "ft.1", "CL": "fiberhmm-apply -i in.bam -o out.bam"}]}) is False
    # A fibertools command that does not write nucleosomes is no frame signal.
    assert bam_tags.bam_legacy_tags_are_molecular(
        {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft extract --all out.tsv in.bam"}]}) is False


def test_ft_predict_m6a_reverse_read_nucleosomes_are_not_mirrored():
    class PredictHeader(FakeBam):
        header = {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft predict-m6a in.bam out.bam"}]}

    read = FakeBamRead("r", 100, 300, tags={"ns": [10], "nl": [120]})
    read.is_reverse = True
    rev = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "chr2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p: PredictHeader([read]))
    # molecular [10,130) on a 200 bp reverse read = SEQ [70,190)
    assert rev[0]["layers"]["nuc"]["intervals"] == [[70, 190, 120]]


def test_current_fibertools_ma_tag_is_read_in_molecular_frame():
    # `ft add-nucleosomes` v0.13 writes no ns/nl, only e.g. Ma:Z:3000;nuc.:301-150,...;msp.:451-550, with the
    # same 1-based offsets on forward and reverse reads (molecular frame).
    class AddNucHeader(FakeBam):
        header = {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "VN": "0.13.0", "CL": "ft add-nucleosomes in.bam out.bam"}]}

    def read(rev):
        r = FakeBamRead("fwd" if not rev else "rev", 100, 300, tags={"Ma": "200;nuc.:11-120;msp.:141-40"})
        r.is_reverse = rev
        return r

    fwd, rev = (compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "chr2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p, r=r: AddNucHeader([r]))[0] for r in (read(False), read(True)))
    assert fwd["layers"]["nuc"]["intervals"] == [[10, 130, 120]]
    assert fwd["layers"]["msp"]["intervals"] == [[140, 180, 40]]
    assert rev["layers"]["nuc"]["intervals"] == [[70, 190, 120]]
    assert rev["layers"]["msp"]["intervals"] == [[20, 60, 40]]


def _ft_bam(tmp_path):
    """A real indexed BAM as `ft add-nucleosomes` v0.13 writes it (Ma only, no ns/nl)."""
    path = tmp_path / "ft_nuc.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 2000}],
              "PG": [{"ID": "ft.1", "PN": "fibertools-rs", "VN": "0.13.0", "CL": "ft add-nucleosomes in.bam out.bam"}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, rev in (("fwd", False), ("rev", True)):
            r = pysam.AlignedSegment(out.header)
            r.query_name = name; r.query_sequence = "A" * 200; r.flag = 16 if rev else 0
            r.reference_id = 0; r.reference_start = 100; r.cigarstring = "200M"; r.mapping_quality = 60
            r.set_tag("Ma", "200;nuc.:11-120;msp.:141-40", value_type="Z")
            out.write(r)
    pysam.index(str(path))
    return str(path)


def test_ma_tag_layers_are_detected_and_drawn_by_the_dense_loader(tmp_path):
    from services.bam_diagnostics import diagnose_bam_tags
    from services.dense_bam_loader import load_reads_from_bam
    path = _ft_bam(tmp_path)
    assert {"nuc", "msp"} <= set(diagnose_bam_tags(path, chrom="chrT", limit=5)["ma_layers"])
    frame = load_reads_from_bam(path, "chrT", 100, 300, spanning_only=False)
    rows = frame.set_index("read_id")
    # nucleosome: forward ref [110,230); reverse is mirrored within the molecule -> ref [170,290)
    assert rows.loc["fwd", 110] == 120 and rows.loc["fwd", 229] == 120 and rows.loc["fwd", 230] <= 0
    assert rows.loc["rev", 170] == 120 and rows.loc["rev", 289] == 120 and rows.loc["rev", 169] <= 0
