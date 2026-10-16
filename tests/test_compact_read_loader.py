"""Regression tests for compact-read loader helpers."""

from pathlib import Path

import numpy as np

from services import compact_read_loader
from services import bam_tags


class DictMapper:
    def __init__(self, mapping):
        self.mapping = mapping

    def query_to_ref(self, query_pos):
        return self.mapping.get(query_pos)


class BatchDictMapper(DictMapper):
    def __init__(self, mapping):
        super().__init__(mapping)
        self.batch_calls = []
        self.single_calls = []

    def query_to_ref(self, query_pos):
        self.single_calls.append(query_pos)
        return super().query_to_ref(query_pos)

    def query_to_ref_many(self, query_positions):
        self.batch_calls.append(list(query_positions))
        return [self.mapping.get(query_pos) for query_pos in query_positions]


class FakeBam:
    header = {}
    references = ("chr2L",)

    def __init__(self, reads):
        self.reads = reads

    def fetch(self, chrom, start, end):
        assert chrom == "chr2L"
        return self.reads


class FakeBamRead:
    is_unmapped = False
    is_secondary = False
    is_supplementary = False
    is_reverse = False
    query_sequence = "A" * 200
    query_length = 200

    def __init__(self, query_name, reference_start, reference_end, tags=None,
                 is_duplicate=False):
        self.query_name = query_name
        self.reference_start = reference_start
        self.reference_end = reference_end
        self.tags = tags or {}
        self.is_duplicate = is_duplicate
        self.cigartuples = [(0, reference_end - reference_start)]

    def get_tag(self, tag):
        if tag not in self.tags:
            raise KeyError(tag)
        return self.tags[tag]

    def has_tag(self, tag):
        return tag in self.tags

    def get_tags(self):
        return list(self.tags.items())


class FakeBigBed:
    def __init__(self, entries_by_chrom):
        self.entries_by_chrom = entries_by_chrom

    def chroms(self):
        return {chrom: 1000000 for chrom in self.entries_by_chrom}

    def entries(self, chrom, start, end):
        return [
            (entry_start, entry_end, rest)
            for entry_start, entry_end, rest in self.entries_by_chrom.get(chrom, [])
            if entry_end > start and entry_start < end
        ]


def bed12_rest(read_id, block_sizes, block_starts, *extra_columns):
    columns = [
        read_id,
        "0",
        "+",
        "0",
        "0",
        "0",
        str(len(block_sizes)),
        ",".join(str(v) for v in block_sizes) + ",",
        ",".join(str(v) for v in block_starts) + ",",
    ]
    columns.extend(extra_columns)
    return "\t".join(columns)


def test_layer_request_normalization_and_matching():
    include, requested = compact_read_loader.normalize_layer_request(True, None)
    assert include is True
    assert requested is None
    assert compact_read_loader.wants_layer(include, requested, "tf")

    include, requested = compact_read_loader.normalize_layer_request(False, "tf,msp")
    assert include is True
    assert requested == {"tf", "msp", "fire"}
    assert compact_read_loader.wants_layer(include, requested, "msp", "fire")

    include, requested = compact_read_loader.normalize_layer_request(False, "fire")
    assert include is True
    assert requested == {"fire", "msp"}
    assert compact_read_loader.wants_layer(include, requested, "msp")
    assert not compact_read_loader.wants_layer(include, requested, "nuc")

    include, requested = compact_read_loader.normalize_layer_request(True, [])
    assert include is True
    assert requested is None


def test_parse_int_tag_values_handles_common_bam_tag_shapes():
    assert compact_read_loader.parse_int_tag_values("1,2,3,") == [1, 2, 3]
    assert compact_read_loader.parse_int_tag_values([4, 5]) == [4, 5]
    assert compact_read_loader.parse_int_tag_values(np.array([6, 7])) == [6, 7]
    assert compact_read_loader.parse_optional_int_tag_values(object()) is None


def test_map_tagged_footprints_filters_quality_and_soft_clips():
    mapper = DictMapper({
        0: 100,
        4: 104,
        10: 110,
        12: 112,
        20: None,
        22: 122,
    })

    footprints = compact_read_loader.map_tagged_footprints(
        [0, 10, 20],
        [5, 5, 3],
        [50, 90, 100],
        mapper.query_to_ref,
        min_fp_quality=80,
    )

    assert footprints == [(110, 113, 5, 90, 1)]


def test_map_tagged_footprints_uses_batch_cigar_mapping_when_available():
    mapper = BatchDictMapper({0: 100, 4: 104, 10: 110, 14: 114})

    footprints = compact_read_loader.map_tagged_footprints(
        [0, 10],
        [5, 5],
        None,
        mapper.query_to_ref,
    )

    assert footprints == [
        (100, 105, 5, None, 0),
        (110, 115, 5, None, 1),
    ]
    assert mapper.batch_calls == [[0, 4, 10, 14]]
    assert mapper.single_calls == []


def test_swapped_bigbed_column_warning_is_opt_in(capsys, monkeypatch):
    import pandas as pd

    df = pd.DataFrame([{
        "blockCount": "3",
        "blockStarts": "30,20,10,",
        "blockSizes": "0,40,90,",
    }])

    monkeypatch.delenv(compact_read_loader.BIGBED_DIAGNOSTICS_ENV, raising=False)
    assert compact_read_loader.detect_swapped_bed12_columns(df) is True
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(compact_read_loader.BIGBED_DIAGNOSTICS_ENV, "1")
    assert compact_read_loader.detect_swapped_bed12_columns(df) is True
    assert "Detected swapped blockStarts/blockSizes columns" in capsys.readouterr().out


def test_build_intervals_preserves_quality_alignment_after_sorting_and_clipping():
    footprints = [
        (150, 160, 10, 90, 1),
        (120, 130, 10, 80, 0),
    ]

    intervals, fp_qualities, lq_qualities, rq_qualities, terminal_filtered = (
        compact_read_loader.build_intervals_from_footprints(
            footprints,
            ref_start=100,
            ref_end=180,
            region_start=100,
            region_end=200,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
            lq_qualities=[10, 20],
            rq_qualities=[11, 21],
        )
    )

    assert intervals == [[20, 30, 10], [30, 50, -20], [50, 60, 10]]
    assert fp_qualities == [80, 90]
    assert lq_qualities == [10, 20]
    assert rq_qualities == [11, 21]
    assert terminal_filtered is False


def test_build_intervals_reports_terminal_gap_filter():
    intervals, fp_qualities, lq_qualities, rq_qualities, terminal_filtered = (
        compact_read_loader.build_intervals_from_footprints(
            [(700, 710, 10, None, 0)],
            ref_start=100,
            ref_end=800,
            region_start=100,
            region_end=900,
            hide_terminal_gaps=True,
            terminal_gap_threshold=500,
        )
    )

    assert intervals == []
    assert fp_qualities == []
    assert lq_qualities == []
    assert rq_qualities == []
    assert terminal_filtered is True


class FakeBamMolecularHeader(FakeBam):
    # @PG signalling fibertools `ft add-nucleosome` -> molecular-frame ns/nl.
    header = {"PG": [{"ID": "ft.1", "PN": "fibertools-rs",
                      "CL": "/bin/ft add-nucleosome -t 12 in.bam out.bam"}]}


class FakeBamCoordMolecularHeader(FakeBam):
    # Explicit marker used for MA/AQ and legacy molecular-frame coordinates.
    header = {"CO": ["fiberhmm:coord=molecular"]}


def _molecular_nuc_read(is_reverse):
    # ref span 100..300 (cigar all-match), query_length 200 -> query_to_ref(q)=100+q.
    # Molecular nucleosome [10, 130) (size 120 -> nuc), edges lq=5 / rq=6.
    read = FakeBamRead("r", 100, 300,
                       tags={"ns": [10], "nl": [120], "nq": [80], "lq": [5], "rq": [6]})
    read.is_reverse = is_reverse
    return read


def _ma_nuc_read(is_reverse):
    read = _molecular_nuc_read(is_reverse)
    read.tags.update({"MA": "200;nuc+QQQ:11-120", "AQ": [80, 5, 6]})
    return read


def test_bam_compact_loader_flips_molecular_legacy_tags_on_reverse_reads():
    # Forward: molecular == SEQ, no flip. [10,130) -> ref[110,230) -> rel[10,130];
    # edges unswapped (lq=5 genomic-left, rq=6 genomic-right).
    fwd = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p: FakeBamMolecularHeader([_molecular_nuc_read(False)]),
        chrom_map={"2L": "chr2L"},
    )
    assert fwd[0]["intervals"] == [[10, 130, 120]]
    assert fwd[0]["layers"]["nuc"]["qualities"] == [[80], [5], [6]]

    # Reverse: flip seq_start = 200 - (10+120) = 70 -> [70,190) -> ref[170,290)
    # -> rel[70,190]; edges swap (genomic-left = molecular-right = rq=6).
    rev = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p: FakeBamMolecularHeader([_molecular_nuc_read(True)]),
        chrom_map={"2L": "chr2L"},
    )
    assert rev[0]["intervals"] == [[70, 190, 120]]
    assert rev[0]["layers"]["nuc"]["qualities"] == [[80], [6], [5]]


def test_bam_compact_loader_does_not_flip_legacy_tags_without_molecular_header():
    # Same reverse read, but the plain FakeBam has no molecular @PG -> SEQ frame
    # assumed -> no flip, no edge swap (old-FiberHMM behavior preserved).
    rev = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        bam_handle_getter=lambda _p: FakeBam([_molecular_nuc_read(True)]),
        chrom_map={"2L": "chr2L"},
    )
    assert rev[0]["intervals"] == [[10, 130, 120]]
    assert rev[0]["layers"]["nuc"]["qualities"] == [[80], [5], [6]]


def test_bam_compact_loader_does_not_flip_unmarked_ma_aq_on_reverse_reads():
    rev = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        include_layers=True,
        requested_layers=["nuc"],
        bam_handle_getter=lambda _p: FakeBam([_ma_nuc_read(True)]),
        chrom_map={"2L": "chr2L"},
    )

    assert rev[0]["intervals"] == [[10, 130, 120]]
    assert rev[0]["layers"]["nuc"] == {
        "intervals": [[10, 130, 120]],
        "qualities": [[80], [5], [6]],
        "quality_names": ["nq", "lq", "rq"],
    }


def test_bam_compact_loader_flips_marked_molecular_ma_aq_on_reverse_reads():
    rev = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        include_layers=True,
        requested_layers=["nuc"],
        bam_handle_getter=lambda _p: FakeBamCoordMolecularHeader([_ma_nuc_read(True)]),
        chrom_map={"2L": "chr2L"},
    )

    assert rev[0]["intervals"] == [[70, 190, 120]]
    assert rev[0]["layers"]["nuc"] == {
        "intervals": [[70, 190, 120]],
        "qualities": [[80], [6], [5]],
        "quality_names": ["nq", "lq", "rq"],
    }


def test_bam_compact_loader_flips_marked_molecular_ma_aq_without_legacy_tags():
    read = _ma_nuc_read(True)
    for tag in ("ns", "nl", "nq", "lq", "rq"):
        read.tags.pop(tag)

    rev = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 300, spanning_only=False,
        include_layers=True,
        requested_layers=["nuc"],
        bam_handle_getter=lambda _p: FakeBamCoordMolecularHeader([read]),
        chrom_map={"2L": "chr2L"},
    )

    assert rev[0]["intervals"] == [[0, 200, 0]]
    assert rev[0]["layers"]["nuc"] == {
        "intervals": [[70, 190, 120]],
        "qualities": [[80], [6], [5]],
        "quality_names": ["nq", "lq", "rq"],
    }


def test_bam_compact_loader_builds_expected_compact_reads():
    read = FakeBamRead(
        "read1",
        100,
        200,
        tags={
            "ns": [10, 50],
            "nl": [20, 30],
            "nq": [80, 90],
            "lq": [10, 20],
            "rq": [11, 21],
            "as": [35],
            "al": [10],
            "aq": [200],
        },
    )
    fake_bam = FakeBam([read])

    def fake_handle(_path):
        return fake_bam

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "2L",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=fake_handle,
        chrom_map={"2L": "chr2L"},
    )

    expected = [{
        "id": "read1",
        "library_id": str(Path("https://example.test/read.bam").resolve()),
        "reference_start": 100, "reference_end": 200, "alignment_orientation": "forward",
        "intervals": [[10, 30, 20], [30, 50, -20], [50, 80, 30]],
        "qualities": [80, 90],
        "fire": [[35, 45, 200]],
        "layers": {
            "tf": {
                "intervals": [[10, 30, 20], [50, 80, 30]],
                "qualities": [[80, 90], [10, 20], [11, 21]],
                "quality_names": ["nq", "lq", "rq"],
            },
            "msp": {
                "intervals": [[35, 45, 10]],
                "qualities": [[200]],
                "quality_names": ["aq"],
            },
        },
    }]

    assert result == expected


def test_bam_compact_loader_preserves_explicit_ma_layers_without_qualities():
    read = FakeBamRead(
        "read1",
        100,
        300,
        tags={
            "ns": [0, 150],
            "nl": [120, 30],
            "MA": "200;nuc+Q:1-120;tf+QQQ:151-30",
        },
    )
    fake_bam = FakeBam([read])

    def fake_handle(_path):
        return fake_bam

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        300,
        spanning_only=False,
        include_layers=True,
        requested_layers=["nuc", "tf"],
        include_layer_qualities=False,
        bam_handle_getter=fake_handle,
    )

    assert result == [{
        "id": "read1",
        "library_id": str(Path("https://example.test/read.bam").resolve()),
        "reference_start": 100, "reference_end": 300, "alignment_orientation": "forward",
        "intervals": [[0, 120, 120], [120, 150, -30], [150, 180, 30]],
        "layers": {
            "nuc": {
                "intervals": [[0, 120, 120]],
                "qualities": None,
                "quality_names": [],
            },
            "tf": {
                "intervals": [[150, 180, 30]],
                "qualities": None,
                "quality_names": [],
            },
        },
    }]


def test_bam_compact_loader_preserves_ma_layer_when_legacy_terminal_filter_fires():
    read = FakeBamRead(
        "read1",
        100,
        300,
        tags={
            # The lone legacy footprint is far enough from both alignment
            # ends to trip the deliberately tight terminal-gap test below.
            "ns": [100],
            "nl": [20],
            # The explicit shadow-layer call remains inside the viewport.
            "MA": "200;tf_sr+QQQ:11-10",
            "AQ": [240, 180, 200],
        },
    )

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        include_layers=True,
        requested_layers=["tf_sr"],
        hide_terminal_gaps=True,
        terminal_gap_threshold=25,
        bam_handle_getter=lambda _path: FakeBam([read]),
    )

    assert result == [{
        "id": "read1",
        "library_id": str(Path("https://example.test/read.bam").resolve()),
        "reference_start": 100, "reference_end": 300, "alignment_orientation": "forward",
        "intervals": [[0, 80, 0]],
        "layers": {
            "tf_sr": {
                "intervals": [[10, 20, 10]],
                "qualities": [[240], [180], [200]],
                "quality_names": ["q0", "q1", "q2"],
            },
        },
    }]


def test_unrequested_ma_layer_does_not_bypass_legacy_terminal_filter():
    read = FakeBamRead(
        "read1",
        100,
        300,
        tags={
            "ns": [100],
            "nl": [20],
            "MA": "200;nuc+Q:11-10",
            "AQ": [240],
        },
    )

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        include_layers=True,
        requested_layers=["tf_sr"],
        hide_terminal_gaps=True,
        terminal_gap_threshold=25,
        bam_handle_getter=lambda _path: FakeBam([read]),
    )

    assert result == []

    # An unscoped "all layers" request is used by generic analysis callers;
    # it must not turn every v3 MA-tagged read into a synthetic neutral row.
    all_layers = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        include_layers=True,
        requested_layers=None,
        hide_terminal_gaps=True,
        terminal_gap_threshold=25,
        bam_handle_getter=lambda _path: FakeBam([read]),
    )
    assert all_layers == []


def test_deamination_opportunity_scan_is_explicitly_requested(monkeypatch):
    read = FakeBamRead(
        "read1",
        100,
        300,
        tags={},
    )
    calls = []

    def fake_opportunities(*args):
        calls.append(args)
        return {"ct": [4], "ga": [9]}

    monkeypatch.setattr(
        bam_tags,
        "parse_mm_ml_tags_by_type",
        lambda *_args: {"m6a": [], "m5c": [], "deam": []},
    )
    monkeypatch.setattr(bam_tags, "parse_iupac_ry_positions", lambda *_args: [])
    monkeypatch.setattr(bam_tags, "parse_daf_mismatches", lambda *_args: [])
    monkeypatch.setattr(bam_tags, "parse_deamination_opportunities", fake_opportunities)
    common = dict(
        bam_path="https://example.test/read.bam",
        chrom="chr2L",
        region_start=100,
        region_end=250,
        spanning_only=False,
        include_methylation=True,
        hide_terminal_gaps=False,
        bam_handle_getter=lambda _path: FakeBam([read]),
    )

    ordinary = compact_read_loader.build_compact_reads_from_bam(**common)
    assert calls == []
    assert "possible_deam_ct" not in ordinary[0]

    opportunity = compact_read_loader.build_compact_reads_from_bam(
        **common,
        requested_layers=["deam_opportunity"],
    )
    assert len(calls) == 1
    assert opportunity[0]["possible_deam_ct"] == [4]
    assert opportunity[0]["possible_deam_ga"] == [9]


def test_bam_compact_loader_treats_all_zero_fire_aq_as_missing():
    read = FakeBamRead(
        "read1",
        100,
        200,
        tags={
            "ns": [10, 50],
            "nl": [20, 30],
            "as": [35],
            "al": [10],
            "aq": [0],
        },
    )
    fake_bam = FakeBam([read])

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=lambda _path: fake_bam,
        chrom_map={"chr2L": "chr2L"},
    )

    assert result[0]["fire"] == [[35, 45, 128]]
    assert result[0]["layers"]["msp"] == {
        "intervals": [[35, 45, 10]],
        "qualities": None,
        "quality_names": [],
    }


def test_bam_compact_loader_prefers_explicit_ma_layers_over_inferred_legacy_layers():
    read = FakeBamRead(
        "read1",
        100,
        320,
        tags={
            "ns": [0, 120],
            "nl": [100, 100],
            "nq": [80, 90],
            "MA": "0;nuc+Q:50-10",
            "AQ": [240],
        },
    )

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        320,
        spanning_only=False,
        include_layers=True,
        requested_layers=["nuc"],
        bam_handle_getter=lambda _path: FakeBam([read]),
    )

    assert result[0]["layers"]["nuc"] == {
        "intervals": [[49, 59, 10]],
        "qualities": [[240]],
        "quality_names": ["q0"],
    }


def test_bam_compact_loader_keeps_raw_read_extents_without_tags():
    read = FakeBamRead("raw1", 90, 150)

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/raw.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=lambda _path: FakeBam([read]),
    )

    assert result == [{"id": "raw1", "intervals": [[0, 50, 0]],
        "library_id": str(Path("https://example.test/raw.bam").resolve()),
        "reference_start": 90, "reference_end": 150, "alignment_orientation": "forward"}]


def test_narrow_bam_view_keeps_named_annotations_before_the_first_footprint():
    read = FakeBamRead('edge', 100, 300, tags={
        'ns': [13], 'nl': [120], 'as': [0], 'al': [13],
        'MA': '200;nuc.Q:14-120;msp.:1-13', 'AQ': [150],
    })
    result = compact_read_loader.build_compact_reads_from_bam(
        'https://example.test/reads.bam', 'chr2L', 100, 110, spanning_only=False,
        include_layers=True, bam_handle_getter=lambda _: FakeBam([read]),
    )
    assert len(result) == 1
    assert result[0]['intervals'] == [[0, 10, 0]]
    assert result[0]['layers']['msp']['intervals'] == [[0, 10, 13]]


def test_canonical_bam_channel_outside_the_view_still_suppresses_legacy_inference():
    read = FakeBamRead('canonical', 100, 400, tags={
        'ns': [20, 200], 'nl': [40, 100],
        'MA': '300;nuc.Q:21-40,201-100;tf.Q:161-20', 'AQ': [50, 60, 70],
    })
    result = compact_read_loader.build_compact_reads_from_bam(
        'https://example.test/reads.bam', 'chr2L', 100, 180, spanning_only=False,
        include_layers=True, bam_handle_getter=lambda _: FakeBam([read]),
    )
    assert len(result) == 1
    assert result[0]['layers']['nuc']['intervals'] == [[20, 60, 40]]
    assert 'tf' not in result[0]['layers']


def test_bam_compact_loader_raw_only_is_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv(compact_read_loader.BAM_DIAGNOSTICS_ENV, raising=False)
    monkeypatch.delenv("FIBERBROWSER_PROFILE_BAM", raising=False)
    read = FakeBamRead("raw1", 90, 150)

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/raw.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=lambda _path: FakeBam([read]),
    )

    assert result == [{"id": "raw1", "intervals": [[0, 50, 0]],
        "library_id": str(Path("https://example.test/raw.bam").resolve()),
        "reference_start": 90, "reference_end": 150, "alignment_orientation": "forward"}]
    assert capsys.readouterr().out == ""


def test_bam_compact_loader_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv(compact_read_loader.BAM_DIAGNOSTICS_ENV, raising=False)
    monkeypatch.delenv("FIBERBROWSER_PROFILE_BAM", raising=False)
    reads = [
        FakeBamRead(
            "tagged1",
            100,
            200,
            tags={"ns": [10], "nl": [20], "nq": [80]},
        ),
        FakeBamRead("raw1", 120, 180),
    ]

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        min_fp_quality=10,
        bam_handle_getter=lambda _path: FakeBam(reads),
    )

    assert [read["id"] for read in result] == ["tagged1", "raw1"]
    assert capsys.readouterr().out == ""


def test_bam_compact_loader_chrom_miss_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv(compact_read_loader.BAM_DIAGNOSTICS_ENV, raising=False)
    monkeypatch.delenv("FIBERBROWSER_PROFILE_BAM", raising=False)

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chrMissing",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=lambda _path: FakeBam([]),
    )

    assert result == []
    assert capsys.readouterr().out == ""


def test_bam_compact_loader_chrom_miss_can_print_bam_diagnostics(capsys, monkeypatch):
    monkeypatch.setenv(compact_read_loader.BAM_DIAGNOSTICS_ENV, "1")

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chrMissing",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=lambda _path: FakeBam([]),
    )

    assert result == []
    assert "Chromosome chrMissing not found in BAM" in capsys.readouterr().out


def test_bam_compact_loader_can_print_bam_diagnostics(capsys, monkeypatch):
    monkeypatch.setenv(compact_read_loader.BAM_DIAGNOSTICS_ENV, "1")
    reads = [
        FakeBamRead(
            "tagged1",
            100,
            200,
            tags={"ns": [10], "nl": [20], "nq": [80]},
        ),
        FakeBamRead("raw1", 120, 180),
    ]

    compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        min_fp_quality=10,
        bam_handle_getter=lambda _path: FakeBam(reads),
    )

    output = capsys.readouterr().out
    assert "First read tag info" in output
    assert "Filtering by min_fp_quality=10" in output
    assert "Reads without tags (included as raw): 1" in output


def test_bigbed_compact_loader_builds_expected_compact_reads():
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 260, bed12_rest("read1", [100, 100], [0, 120], "80,90,")),
        ],
    })

    def fake_handle(_path):
        return fake_bigbed

    def fake_overlay(_path):
        return "footprint"

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb"],
        "2L",
        100,
        260,
        spanning_only=False,
        bigbed_handle_getter=fake_handle,
        overlay_type_detector=fake_overlay,
        format_cache={},
    )

    expected = [{
        "id": "read1",
        "intervals": [[0, 100, 100], [100, 120, -20], [120, 160, 100]],
        "layers": {
            "nuc": {
                "intervals": [[0, 100, 100], [120, 160, 100]],
                "qualities": [[80, 90]],
                "quality_names": ["nq"],
            },
            "msp": {
                "intervals": [[100, 120, 20]],
                "qualities": None,
                "quality_names": [],
            },
        },
    }]

    assert result == expected


def test_bam_duplicates_are_hidden_by_default_and_toggleable():
    reads = [
        FakeBamRead("unique", 100, 180),
        FakeBamRead("copy", 100, 180, is_duplicate=True),
    ]
    common = dict(
        bam_path="https://example.test/reads.bam",
        chrom="chr2L",
        region_start=100,
        region_end=180,
        spanning_only=False,
        bam_handle_getter=lambda _path: FakeBam(reads),
    )

    hidden = compact_read_loader.build_compact_reads_from_bam(**common)
    shown = compact_read_loader.build_compact_reads_from_bam(
        **common, include_duplicates=True,
    )

    assert [read["id"] for read in hidden] == ["unique"]
    assert [read["id"] for read in shown] == ["unique", "copy"]
    assert shown[1]["duplicate"] is True


def test_bam_min_footprints_uses_whole_fiber_before_viewport_clipping():
    reads = [
        FakeBamRead(
            "passes",
            100,
            300,
            tags={"ns": [0, 30, 60, 90, 120, 150], "nl": [10] * 6},
        ),
        FakeBamRead(
            "fails",
            100,
            300,
            tags={"ns": [0, 30, 60, 90], "nl": [10] * 4},
        ),
    ]

    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/reads.bam",
        "chr2L",
        100,
        115,
        spanning_only=False,
        min_footprints=5,
        bam_handle_getter=lambda _path: FakeBam(reads),
    )

    assert [read["id"] for read in result] == ["passes"]
    # The gap to the next footprint (at 130) is part of the read, clipped to view.
    assert result[0]["intervals"] == [[0, 10, 10], [10, 15, -20]]


def test_bigbed_isduplicate_is_hidden_by_default_and_toggleable():
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 180, bed12_rest("unique", [80], [0], "0")),
            (100, 180, bed12_rest("copy", [80], [0], "1")),
        ],
    })
    common = dict(
        bigbed_path=["fp.bb"],
        chrom="chr2L",
        region_start=100,
        region_end=180,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        overlay_type_detector=lambda _path: "footprint",
        duplicate_field_detector=lambda _path: True,
        format_cache={},
    )

    hidden = compact_read_loader.build_compact_reads_from_bigbed(**common)
    shown = compact_read_loader.build_compact_reads_from_bigbed(
        **common, include_duplicates=True,
    )

    assert [read["id"] for read in hidden] == ["unique"]
    assert [read["id"] for read in shown] == ["unique", "copy"]
    assert shown[1]["duplicate"] is True


def test_bigbed_min_footprints_uses_whole_fiber_before_viewport_clipping():
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 300, bed12_rest("passes", [10] * 6, [0, 30, 60, 90, 120, 150])),
            (100, 300, bed12_rest("fails", [10] * 4, [0, 30, 60, 90])),
        ],
    })

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb"],
        "chr2L",
        100,
        115,
        spanning_only=False,
        min_footprints=5,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        overlay_type_detector=lambda _path: "footprint",
        format_cache={},
    )

    assert [read["id"] for read in result] == ["passes"]
    # The gap to the next footprint (at 130) is part of the read, clipped to view.
    assert result[0]["intervals"] == [[0, 10, 10], [10, 15, -20]]


def test_bigbed_compact_loader_reads_footprint_edge_sharpness_columns():
    # BED12+3 footprint track (recaller): blockNq, blockEl, blockEr. The nuc
    # layer should carry all three edge-sharpness dims so the browser can render
    # edge ambiguity. Mirrors the tf+QQQ layout applied to nucleosomes.
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 260, bed12_rest("read1", [100, 100], [0, 120], "80,90,", "200,40,", "255,10,")),
        ],
    })

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb"],
        "2L",
        100,
        260,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        overlay_type_detector=lambda _path: "footprint",
        format_cache={},
    )

    nuc = result[0]["layers"]["nuc"]
    assert nuc["quality_names"] == ["nq", "el", "er"]
    assert nuc["qualities"] == [[80, 90], [200, 40], [255, 10]]


def test_bigbed_compact_loader_footprint_without_edge_columns_stays_bed12_plus1():
    # Legacy / HMM-only footprint bigBed: only blockNq present. The per-column
    # guard stops after nq, so el/er are simply absent (no crash, no zero-fill).
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 260, bed12_rest("read1", [100, 100], [0, 120], "80,90,")),
        ],
    })

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb"],
        "2L",
        100,
        260,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        overlay_type_detector=lambda _path: "footprint",
        format_cache={},
    )

    nuc = result[0]["layers"]["nuc"]
    assert nuc["quality_names"] == ["nq"]
    assert nuc["qualities"] == [[80, 90]]


def test_bigbed_compact_loader_merges_companion_layers_by_read_id(capsys, monkeypatch):
    monkeypatch.delenv(compact_read_loader.BIGBED_DIAGNOSTICS_ENV, raising=False)
    handles = {
        "fp.bb": FakeBigBed({
            "chr2L": [
                (100, 260, bed12_rest("read1", [100, 95], [0, 140], "80,90,")),
            ],
        }),
        "tf.bb": FakeBigBed({
            "chr2L": [
                (100, 160, bed12_rest("read1", [5], [20], "200,", "3,", "4,")),
            ],
        }),
        "msp.bb": FakeBigBed({
            "chr2L": [
                (100, 160, bed12_rest("read1", [5], [30], "150,")),
            ],
        }),
        "deam.bb": FakeBigBed({
            "chr2L": [
                (100, 160, bed12_rest("read1", [2], [5], "1,")),
            ],
        }),
    }

    def fake_overlay(path):
        return {
            "fp.bb": "footprint",
            "tf.bb": "tf",
            "msp.bb": "msp",
            "deam.bb": "deam",
        }[path]

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb", "tf.bb", "msp.bb", "deam.bb"],
        "2L",
        100,
        250,
        spanning_only=False,
        bigbed_handle_getter=lambda path: handles[path],
        overlay_type_detector=fake_overlay,
        format_cache={},
    )

    assert result == [{
        "id": "read1",
        "intervals": [[0, 100, 100], [100, 140, -40], [140, 150, 95]],
        "layers": {
            "nuc": {
                "intervals": [[0, 100, 100], [140, 150, 95]],
                "qualities": [[80, 90]],
                "quality_names": ["nq"],
            },
            "msp": {
                "intervals": [[30, 35, 5]],
                "qualities": [[150]],
                "quality_names": ["aq"],
            },
            "tf": {
                "intervals": [[20, 25, 5]],
                "qualities": [[200], [3], [4]],
                "quality_names": ["tq", "el", "er"],
            },
        },
        "deam": [[5, 1], [6, 1]],
    }]
    assert capsys.readouterr().out == ""


def test_bigbed_compact_loader_normalizes_fire_companion_to_msp_layer(monkeypatch):
    handles = {
        "fp.bb": FakeBigBed({
            "chr2L": [
                (100, 220, bed12_rest("read1", [100], [0], "80,")),
            ],
        }),
        "fire.bb": FakeBigBed({
            "chr2L": [
                (100, 220, bed12_rest("read1", [12], [40], "210,")),
            ],
        }),
    }

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb", "fire.bb"],
        "2L",
        100,
        220,
        spanning_only=False,
        bigbed_handle_getter=lambda path: handles[path],
        overlay_type_detector=lambda path: "fire" if path == "fire.bb" else "footprint",
        format_cache={},
    )

    assert result[0]["layers"]["msp"] == {
        "intervals": [[40, 52, 12]],
        "qualities": [[210]],
        "quality_names": ["aq"],
    }


def test_bigbed_compact_loader_can_print_merge_diagnostics(capsys, monkeypatch):
    monkeypatch.setenv(compact_read_loader.BIGBED_DIAGNOSTICS_ENV, "1")
    handles = {
        "fp.bb": FakeBigBed({
            "chr2L": [
                (100, 160, bed12_rest("read1", [10], [0])),
            ],
        }),
        "tf.bb": FakeBigBed({
            "chr2L": [
                (100, 160, bed12_rest("read1", [5], [20])),
            ],
        }),
    }

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb", "tf.bb"],
        "2L",
        100,
        150,
        spanning_only=False,
        bigbed_handle_getter=lambda path: handles[path],
        overlay_type_detector=lambda path: "tf" if path == "tf.bb" else "footprint",
        format_cache={},
    )

    assert len(result) == 1
    assert "build_compact_reads: merged 1 reads from 2 files" in capsys.readouterr().out


def test_bigbed_compact_loader_parses_fiberlayers_rows_as_named_layers():
    handles = {
        "classes.fiberlayers.bb": FakeBigBed({
            "chr2L": [
                (
                    100,
                    170,
                    bed12_rest("read1", [6, 8], [10, 40], "short_tf", "tf", "rule-1", "180,220,"),
                ),
            ],
        }),
    }

    result = compact_read_loader.build_compact_reads_from_bigbed(
        ["classes.fiberlayers.bb"],
        "2L",
        100,
        170,
        spanning_only=False,
        include_layers=True,
        requested_layers=["short_tf"],
        bigbed_handle_getter=lambda path: handles[path],
        overlay_type_detector=lambda path: "fiberlayers",
        format_cache={},
    )

    assert result == [{
        "id": "read1",
        "intervals": [],
        "layers": {
            "short_tf": {
                "intervals": [[10, 16, 6], [40, 48, 8]],
                "qualities": [[180, 220]],
                "quality_names": ["confidence"],
            },
        },
    }]


def test_compact_loader_parses_local_fiberlayers_bed_payload(tmp_path):
    bed = tmp_path / "classes.fiberlayers.bed"
    bed.write_text(
        "\t".join([
            "chr2L", "100", "170", "read1", "0", ".", "100", "170", "47,158,68",
            "2", "6,8,", "10,40,", "short_tf", "tf", "rule-1", "180,220,",
        ]) + "\n",
        encoding="utf-8",
    )

    result = compact_read_loader.build_compact_reads_from_bigbed(
        [str(bed)],
        "2L",
        100,
        170,
        spanning_only=False,
        include_layers=True,
        requested_layers=["short_tf"],
        bigbed_handle_getter=lambda path: (_ for _ in ()).throw(AssertionError(f"unexpected BigBed open: {path}")),
        overlay_type_detector=lambda path: "unknown",
        format_cache={},
    )

    assert result == [{
        "id": "read1",
        "intervals": [],
        "layers": {
            "short_tf": {
                "intervals": [[10, 16, 6], [40, 48, 8]],
                "qualities": [[180, 220]],
                "quality_names": ["confidence"],
            },
        },
    }]


def test_msp_only_bam_reads_draw_msps_as_accessible():
    assert compact_read_loader.msp_complement([20, 60], [10, 15], 100) == ([0, 30, 75], [20, 30, 25])
    read = FakeBamRead("m", 100, 200, tags={"as": [20, 60], "al": [10, 15]})
    result = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 100, 200, spanning_only=False,
        bam_handle_getter=lambda _p: FakeBam([read]), chrom_map={"2L": "chr2L"},
    )
    footprints = [iv for iv in result[0]["intervals"] if iv[2] > 0]
    assert [iv[:2] for iv in footprints] == [[0, 20], [30, 60], [75, 100]]


def test_window_inside_an_internal_gap_keeps_the_read():
    # Footprints at the read's two ends only: a narrow window inside the gap
    # between them still shows the read, as that gap (full size 180).
    read = FakeBamRead("gap", 100, 300, tags={"ns": [0, 190], "nl": [10, 10]})
    bam = compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "2L", 150, 160, spanning_only=False,
        bam_handle_getter=lambda _p: FakeBam([read]), chrom_map={"2L": "chr2L"},
    )
    assert [r["id"] for r in bam] == ["gap"]
    assert bam[0]["intervals"] == [[0, 10, -180]]

    fake_bigbed = FakeBigBed({"chr2L": [(100, 300, bed12_rest("gap", [10, 10], [0, 190]))]})
    bb = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb"], "chr2L", 150, 160, spanning_only=False,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        overlay_type_detector=lambda _path: "footprint",
        format_cache={},
    )
    assert [r["id"] for r in bb] == ["gap"]
    assert bb[0]["intervals"] == [[0, 10, -180]]


def test_walk_read_intervals_keeps_the_gap_before_the_first_footprint_in_view():
    walk = compact_read_loader.walk_read_intervals(
        [(0, 100, 100), (150, 250, 100)], 0, 250, 120, 300, True,
    )
    assert walk == [(120, 150, -50, None), (150, 250, 100, 1)]


def test_m5c_bigbed_ddda_mcg_spans_are_a_layer_not_5mc_marks():
    # FiberHMM's m5c BigBed: "native" has 1 bp 5mC calls (blockMl = ML);
    # "ddda" has DddA mCG spans (blockMl 0), including a 1 bp span.
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 140, bed12_rest("native", [1, 1], [5, 20], "200,180")),
            (100, 140, bed12_rest("ddda", [12, 1], [2, 30], "0,0")),
        ],
    })
    common = dict(
        bigbed_path=["m5c.bb"], chrom="chr2L", region_start=100, region_end=140,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        overlay_type_detector=lambda _path: "m5c",
        format_cache={},
    )
    reads = {read["id"]: read for read in compact_read_loader.build_compact_reads_from_bigbed(**common)}
    assert reads["native"]["methyl_m5c"] == [5, 20]
    assert "layers" not in reads["native"]
    ddda = reads["ddda"]
    assert "methyl_m5c" not in ddda and "methyl" not in ddda
    assert ddda["layers"]["ddda_mcg"]["intervals"] == [[2, 14, 12], [30, 31, 1]]

    # Not requested: the DddA read shows as its span, without the layer and
    # still without dense 5mC marks.
    only_nuc = {read["id"]: read for read in compact_read_loader.build_compact_reads_from_bigbed(
        **common, requested_layers=["nuc"])}
    assert only_nuc["native"]["methyl_m5c"] == [5, 20]
    assert only_nuc["ddda"]["intervals"] == [[0, 40, 0]]
    assert "layers" not in only_nuc["ddda"] and "methyl_m5c" not in only_nuc["ddda"]

    # Without a blockMl column, a block wider than 1 bp is a span.
    no_ml = FakeBigBed({"chr2L": [(100, 140, bed12_rest("ddda", [12], [2]))]})
    reads = compact_read_loader.build_compact_reads_from_bigbed(
        **{**common, "bigbed_handle_getter": lambda _path: no_ml})
    assert reads[0]["layers"]["ddda_mcg"]["intervals"] == [[2, 14, 12]]


def test_merged_read_between_companion_calls_is_independent_of_load_span():
    from services.working_sets import project_broad_read_to_viewport
    handles = {
        'sample_nucleosome.bb': FakeBigBed({'chr2L': [(100, 1000, bed12_rest('gap', [100], [0]))]}),
        'sample_tf.bb': FakeBigBed({'chr2L': [(100, 1000, bed12_rest('gap', [50], [850]))]}),
    }
    def load(start, end):
        return compact_read_loader.build_compact_reads_from_bigbed(
            list(handles), 'chr2L', start, end, spanning_only=False, min_footprints=1,
            hide_terminal_gaps=True, terminal_gap_threshold=500, infer_legacy_layers=False,
            bigbed_handle_getter=handles.get,
            overlay_type_detector=lambda p: 'tf' if p.endswith('_tf.bb') else 'footprint',
            duplicate_field_detector=lambda p: False, format_cache={p: False for p in handles})
    wide = load(0, 1200)
    narrow = load(400, 600)
    assert len(wide) == len(narrow) == 1
    assert narrow[0]['id'] == wide[0]['id'] == 'gap'
    assert narrow[0]['intervals'] == [[0, 200, -800]]
    projected, _ = project_broad_read_to_viewport(wide[0], viewport_offset=400, region_width=200, include_methylation=False, layer_key=None)
    assert narrow[0]['intervals'] == [list(iv) for iv in projected['intervals']]


def test_visible_companion_keeps_its_footprint_row_outside_the_view():
    from services.working_sets import project_broad_read_to_viewport
    handles = {
        'sample_nucleosome.bb': FakeBigBed({'chr2L': [(700, 1000, bed12_rest('edge', [100, 100], [0, 200]))]}),
        'sample_tf.bb': FakeBigBed({'chr2L': [(550, 990, bed12_rest('edge', [30, 40], [0, 400], '200,150,'))]}),
    }
    def load(start, end):
        return compact_read_loader.build_compact_reads_from_bigbed(
            list(handles), 'chr2L', start, end, spanning_only=False, min_footprints=2,
            hide_terminal_gaps=True, terminal_gap_threshold=500, infer_legacy_layers=False,
            bigbed_handle_getter=handles.get,
            overlay_type_detector=lambda p: 'tf' if p.endswith('_tf.bb') else 'footprint',
            duplicate_field_detector=lambda p: False, format_cache={p: False for p in handles})
    (wide,) = load(0, 1200)
    (narrow,) = load(500, 600)
    projected, _ = project_broad_read_to_viewport(wide, viewport_offset=500, region_width=100,
                                                include_methylation=False, layer_key=None)
    assert narrow['id'] == projected['id']
    assert narrow['intervals'] == [list(iv) for iv in projected['intervals']]
    assert narrow['layers'] == projected['layers']
