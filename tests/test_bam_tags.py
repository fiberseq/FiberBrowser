"""Regression tests for extracted BAM molecular tag helpers."""

from array import array

from services import bam_handles, bam_tags


class FakeRead:
    query_name = "fake_read"

    def __init__(
        self,
        query_sequence="ATGA",
        tags=None,
        aligned_pairs=None,
        is_reverse=False,
    ):
        self.query_sequence = query_sequence
        self.query_length = len(query_sequence)
        self._tags = tags or {}
        self._aligned_pairs = aligned_pairs or [(0, 100), (1, 101), (2, 102), (3, 103)]
        self.is_reverse = is_reverse

    @property
    def modified_bases(self):
        raise AssertionError("the native pysam MM/ML decoder must not be used")

    def has_tag(self, tag):
        return tag in self._tags

    def get_tag(self, tag):
        return self._tags[tag]

    def get_aligned_pairs(self, with_seq=False):
        if with_seq:
            return [(0, 100, "A"), (1, 101, "C"), (2, 102, "G"), (3, 103, "A")]
        return self._aligned_pairs

    def get_reference_positions(self, full_length=False):
        if full_length:
            refs_by_query = {q: r for q, r in self._aligned_pairs}
            return [refs_by_query.get(q) for q in range(self.query_length)]
        return [r for _, r in self._aligned_pairs if r is not None]


class IdentityOffsetMapper:
    def query_to_ref(self, query_pos):
        return 100 + query_pos


class CountingOffsetMapper:
    def __init__(self):
        self.calls = []

    def query_to_ref(self, query_pos):
        self.calls.append(query_pos)
        return 100 + query_pos


def test_check_bam_index_for_urls_and_missing_files():
    assert bam_handles.check_bam_index("https://example.test/read.bam") is None
    missing = "/tmp/fiberbrowser_missing_index_test.bam"

    service_warning = bam_handles.check_bam_index(missing)

    assert "BAM file not found" in service_warning


def test_parse_mm_ml_tags_by_type():
    read = FakeRead(
        query_sequence="AACG",
        tags={
            "MM": "A+a,0,0;C+m,0;G+u,0;",
            "ML": array("B", [200, 100, 140, 150]),
        },
    )

    expected = {"m6a": [0], "m5c": [2], "deam": [[3, 0]]}

    assert bam_tags.parse_mm_ml_tags_by_type(read, 100, 104, 125) == expected
    assert bam_tags.parse_mm_ml_tags(read, 100, 104, 125) == [0]


def test_parse_mm_ml_tags_reverse_read_uses_original_sequence_orientation():
    # Original molecule AACG is stored as its reverse complement CGTT.
    read = FakeRead(
        query_sequence="CGTT",
        is_reverse=True,
        tags={
            "MM": "A+a,0,0;C+m,0;",
            "ML": array("B", [200, 210, 220]),
        },
    )

    assert bam_tags.parse_mm_ml_tags_by_type(read, 100, 104) == {
        "m6a": [2, 3],
        "m5c": [1],
        "deam": [],
    }


def test_parse_mm_ml_tags_multi_mod_codes_use_interleaved_ml_values():
    read = FakeRead(
        query_sequence="CCAA",
        tags={
            "MM": "C+mh,0,0;",
            # Per-site interleaving: C0 m/h, then C1 m/h.
            "ML": array("B", [200, 10, 20, 210]),
        },
    )

    assert bam_tags.parse_mm_ml_tags_by_type(read, 100, 104) == {
        "m6a": [],
        "m5c": [0],
        "deam": [],
    }


def test_parse_mm_ml_tags_supports_numeric_deamination_code():
    read = FakeRead(
        query_sequence="GGAA",
        tags={"MM": "G+55797,1;", "ML": array("B", [200])},
    )

    assert bam_tags.parse_mm_ml_tags_by_type(read, 100, 104) == {
        "m6a": [],
        "m5c": [],
        "deam": [[1, 0]],
    }


def test_parse_mm_ml_tags_rejects_malformed_or_inconsistent_tags():
    corrupt_delta = FakeRead(
        query_sequence="AAAA",
        tags={"MM": "A+a,4;", "ML": array("B", [200])},
    )
    short_ml = FakeRead(
        query_sequence="AAAA",
        tags={"MM": "A+a,0,0;", "ML": array("B", [200])},
    )
    wrong_mn = FakeRead(
        query_sequence="AAAA",
        tags={"MM": "A+a,0;", "ML": array("B", [200]), "MN": 5},
    )

    empty = {"m6a": [], "m5c": [], "deam": []}
    assert bam_tags.parse_mm_ml_tags_by_type(corrupt_delta, 100, 104) == empty
    assert bam_tags.parse_mm_ml_tags_by_type(short_ml, 100, 104) == empty
    assert bam_tags.parse_mm_ml_tags_by_type(wrong_mn, 100, 104) == empty


def test_parse_deamination_events():
    ry_read = FakeRead(query_sequence="ARYA")
    mismatch_read = FakeRead(query_sequence="ATAA")

    assert bam_tags.parse_iupac_ry_positions(ry_read, 100, 104) == [[1, 0], [2, 1]]
    assert bam_tags.parse_daf_mismatches(mismatch_read, 100, 104) == [[1, 1], [2, 0]]


def test_md_run_decoder_matches_aligned_pairs_across_cigar_and_viewports():
    import random
    import pysam
    rng = random.Random(4684)
    header = pysam.AlignmentHeader.from_references(['chr1'], [100000])
    for case in range(120):
        cigar = [(5, 3), (4, 5)] + [
            (rng.choice([0, 0, 0, 1, 2, 3, 7, 8]), rng.randint(1, 40))
            for _ in range(30)
        ] + [(0, 40), (4, 4), (5, 2)]
        query, md, matched = [], [], 0
        for op, length in cigar:
            if op in (0, 7, 8):
                for _ in range(length):
                    reference = rng.choice('ACGT')
                    mismatch = op == 8 or (op == 0 and rng.random() < .3)
                    base = rng.choice([b for b in 'ACGT' if b != reference]) if mismatch else reference
                    query.append(base)
                    if mismatch:
                        md.extend([str(matched), reference])
                        matched = 0
                    else:
                        matched += 1
            elif op == 2:
                md.extend([str(matched), '^' + ''.join(rng.choices('ACGT', k=length))])
                matched = 0
            elif op in (1, 4):
                query.extend(rng.choices('ACGT', k=length))
        md.append(str(matched))
        read = pysam.AlignedSegment(header)
        read.query_name = f'cigar{case}'
        read.query_sequence = ''.join(query)
        read.reference_id, read.reference_start = 0, 100
        read.flag = 16 if case % 2 else 0
        read.cigartuples = cigar
        read.set_tag('MD', ''.join(md))
        pairs = read.get_aligned_pairs(with_seq=True)
        for start, end in [(0, 100000), (100, 101), (111, 139), (250, 500), (500, 900)]:
            expected = []
            for q, r, base in pairs:
                if q is not None and r is not None and base is not None and start <= r < end:
                    pair = base.upper() + read.query_sequence[q].upper()
                    if pair in ('CT', 'GA'):
                        expected.append([r - start, 1 if pair == 'CT' else 0])
            assert bam_tags._daf_mismatches_from_md(read, start, end) == expected
            assert bam_tags.parse_daf_mismatches(read, start, end) == expected


def test_md_run_decoder_falls_back_for_unsupported_records():
    from types import SimpleNamespace
    for md, cigar, sequence in [('3?', [(0, 4)], 'ATAA'), ('2', [(0, 4)], 'ATAA'),
                                ('4', [(0, 4)], 'ATA'), ('4', [(0, 4), (6, 1)], 'ATAA'),
                                ('1^C2', [(0, 4)], 'ATAA'),
                                ('5', [(0, 2), (2, 1), (0, 2)], 'ATAA')]:
        read = SimpleNamespace(get_tag=lambda key: md, cigartuples=cigar,
                               reference_start=100, query_sequence=sequence)
        assert bam_tags._daf_mismatches_from_md(read, 100, 104) is None


def test_parse_deamination_opportunities_respects_channel_and_missing_alignment():
    ct_read = FakeRead(
        query_sequence="ACYGT",
        tags={"ST": "CT"},
        aligned_pairs=[(0, 100), (1, 101), (2, 102), (3, None), (4, 104)],
    )
    ga_read = FakeRead(
        query_sequence="AGRCA",
        tags={"ST": "GA"},
        aligned_pairs=[(0, 100), (1, 101), (2, 102), (3, 103), (4, 104)],
    )

    assert bam_tags.parse_deamination_opportunities(
        ct_read, 100, 105, deam_events=[[4, 1]]
    ) == {"ct": [1, 2, 4], "ga": []}
    assert bam_tags.parse_deamination_opportunities(
        ga_read, 100, 105
    ) == {"ct": [], "ga": [1, 2]}


def test_parse_deamination_opportunities_fails_closed_when_channel_is_unresolved():
    read = FakeRead(
        query_sequence="ACGT",
        aligned_pairs=[(0, 100), (1, 101), (2, 102), (3, 103)],
    )

    assert bam_tags.parse_deamination_opportunities(read, 100, 104) == {
        "ct": [],
        "ga": [],
    }


def test_parse_deamination_opportunities_uses_observed_flavor_for_legacy_reads():
    read = FakeRead(
        query_sequence="ATGT",
        aligned_pairs=[(0, 100), (1, 101), (2, 102), (3, 103)],
    )

    assert bam_tags.parse_deamination_opportunities(
        read, 100, 104, deam_events=[[1, 1]]
    ) == {"ct": [1], "ga": []}


def test_daf_tag_detection_logs_are_opt_in(capsys, monkeypatch):
    ry_read = FakeRead(query_sequence="ARYA")
    mismatch_read = FakeRead(query_sequence="ATAA")
    monkeypatch.delenv(bam_tags.BAM_DIAGNOSTICS_ENV, raising=False)
    bam_tags._ry_detection_logged = False
    bam_tags._daf_mismatch_detection_logged = False

    assert bam_tags.parse_iupac_ry_positions(ry_read, 100, 104) == [[1, 0], [2, 1]]
    assert bam_tags.parse_daf_mismatches(mismatch_read, 100, 104) == [[1, 1], [2, 0]]
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(bam_tags.BAM_DIAGNOSTICS_ENV, "1")
    bam_tags._ry_detection_logged = False
    bam_tags._daf_mismatch_detection_logged = False
    bam_tags.parse_iupac_ry_positions(ry_read, 100, 104)
    bam_tags.parse_daf_mismatches(mismatch_read, 100, 104)
    output = capsys.readouterr().out

    assert "Detected IUPAC R/Y encoding" in output
    assert "Detected DAF C-to-T/G-to-A mismatches" in output


def test_bam_legacy_tags_are_molecular_detection():
    # fibertools `ft add-nucleosome` provenance -> molecular
    ft = {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "VN": "0.5.4",
                  "CL": "/bin/ft add-nucleosome -t 12 in.bam out.bam"}]}
    assert bam_tags.bam_legacy_tags_are_molecular(ft) is True
    assert bam_tags.bam_ma_aq_tags_are_molecular(ft) is False

    # explicit coord=molecular marker (the FiberHMM forward-compat contract),
    # in either a @CO comment or a @PG line
    assert bam_tags.bam_legacy_tags_are_molecular(
        {"CO": ["fiberhmm:coord=molecular"]}) is True
    assert bam_tags.bam_ma_aq_tags_are_molecular(
        {"CO": ["fiberhmm:coord=molecular"]}) is True
    assert bam_tags.bam_legacy_tags_are_molecular(
        {"PG": [{"ID": "fiberhmm", "PN": "fiberhmm",
                 "CL": "fiberhmm-call --recall-nucs coord=molecular"}]}) is True
    assert bam_tags.bam_ma_aq_tags_are_molecular(
        {"PG": [{"ID": "fiberhmm", "PN": "fiberhmm",
                 "CL": "fiberhmm-call --recall-nucs coord=molecular"}]}) is True

    # old FiberHMM / plain alignment: only minimap2 + samtools -> SEQ frame
    assert bam_tags.bam_legacy_tags_are_molecular(
        {"PG": [{"ID": "minimap2", "PN": "minimap2", "CL": "minimap2 -ax map-ont ref -"},
                {"ID": "samtools", "PN": "samtools", "CL": "samtools sort"}]}) is False
    assert bam_tags.bam_ma_aq_tags_are_molecular(
        {"PG": [{"ID": "minimap2", "PN": "minimap2", "CL": "minimap2 -ax map-ont ref -"},
                {"ID": "samtools", "PN": "samtools", "CL": "samtools sort"}]}) is False

    # fibertools predict-m6a writes ns/nl too, in molecular frame. This used to assert False (predict-m6a "is not
    # an ns/nl frame signal"), which mirrored every reverse read's nucleosomes/MSPs on predict-m6a BAMs. Evidence:
    # `ft predict-m6a --help` (fibertools-rs v0.13.0) "Also adds nucleosome (nl, ns) and MTase sensitive patches
    # (al, as)"; in the fibertools-rs source predict-m6a calls the same add_nucleosomes_to_record() as
    # add-nucleosomes, with the m6A calls in original-read ("forward") orientation, and ns/nl are flipped back for
    # reverse reads when read (src/utils/bamranges.rs). See tests/test_tag_compatibility.py.
    assert bam_tags.bam_legacy_tags_are_molecular(
        {"PG": [{"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft predict-m6a in.bam out.bam"}]}) is True

    assert bam_tags.bam_legacy_tags_are_molecular({}) is False
    assert bam_tags.bam_legacy_tags_are_molecular(None) is False
    assert bam_tags.bam_ma_aq_tags_are_molecular({}) is False
    assert bam_tags.bam_ma_aq_tags_are_molecular(None) is False


def test_parse_ma_aq_layers():
    ma = "10;tf+QQQ:1-3,5-2;msp.P:8-2"
    aq = [10, 11, 12, 20, 21, 22, 30]
    mapper = IdentityOffsetMapper()

    expected = {
        "tf": {
            "intervals": [[0, 3, 3], [4, 6, 2]],
            "qualities": [[10, 20], [11, 21], [12, 22]],
            "quality_names": ["tq", "el", "er"],
        },
        "msp": {
            "intervals": [[7, 9, 2]],
            "qualities": [[30]],
            "quality_names": ["aq"],
        },
    }

    assert bam_tags.parse_ma_aq_tags_into_layers(ma, aq, mapper, 100, 110) == expected


def test_parse_ma_aq_layers_merges_strand_split_sections():
    # fiberhmm-merge writes the CT/GA coverage of one molecule as deam+/deam-:
    # both are the "deam" layer (the last section used to replace the first).
    mapper = IdentityOffsetMapper()
    result = bam_tags.parse_ma_aq_tags_into_layers("60;deam+:1-50;deam-:30-20", None, mapper, 100, 200)
    assert result["deam"] == {"intervals": [[0, 50, 50], [29, 49, 20]], "qualities": None, "quality_names": []}

    # Scored sections: intervals, quality tracks and AN names stay aligned
    # after the merge re-sorts them by position.
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "100;ctcf+Q:40-5;ctcf-Q:10-5,70-5", [40, 10, 70], mapper, 100, 200, an_str="c40,c10,c70")
    assert result["ctcf"]["intervals"] == [[9, 14, 5], [39, 44, 5], [69, 74, 5]]
    assert result["ctcf"]["qualities"] == [[10, 40, 70]]
    assert result["ctcf"]["annotation_names"] == ["c10", "c40", "c70"]


def test_parse_ma_aq_layers_skips_section_with_conflicting_quality_spec():
    # ctcf-QQ can't share ctcf+Q's quality track: it is skipped, and its AQ
    # bytes are stepped over so the next layer still reads its own.
    mapper = IdentityOffsetMapper()
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "100;ctcf+Q:40-5;ctcf-QQ:10-5;msp.P:60-5", [40, 1, 2, 99], mapper, 100, 200)
    assert result["ctcf"] == {"intervals": [[39, 44, 5]], "qualities": [[40]], "quality_names": ["q0"]}
    assert result["msp"]["qualities"] == [[99]]


def test_parse_ma_aq_layers_merge_keeps_source_intervals_aligned():
    mapper = IdentityOffsetMapper()
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "100;tf_sr+QQQQQ:50-10;tf_sr-QQQQQ:5-10", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], mapper, 110, 200)
    layer = result["tf_sr"]
    assert layer["intervals"] == [[0, 4, 10], [39, 49, 10]]
    assert layer["source_intervals"] == [[-6, 4, 10], [39, 49, 10]]
    assert layer["qualities"][0] == [6, 1]


def test_parse_ma_aq_layers_skips_mapping_for_excluded_layers():
    ma = "10;nuc+QQQ:1-3;tf+QQQ:5-2"
    aq = [1, 2, 3, 10, 11, 12]
    mapper = CountingOffsetMapper()

    result = bam_tags.parse_ma_aq_tags_into_layers(
        ma,
        aq,
        mapper,
        100,
        110,
        include_names={"tf"},
    )

    assert result == {
        "tf": {
            "intervals": [[4, 6, 2]],
            "qualities": [[10], [11], [12]],
            "quality_names": ["tq", "el", "er"],
        },
    }
    assert mapper.calls == [4, 5]


def test_parse_ma_aq_layers_preserves_an_circular_names():
    ma = "10;tf+QQQ:1-3,8-3"
    aq = [10, 11, 12, 20, 21, 22]
    mapper = IdentityOffsetMapper()

    result = bam_tags.parse_ma_aq_tags_into_layers(
        ma,
        aq,
        mapper,
        100,
        110,
        an_str="fhw_tf_0,fhw_tf_0",
    )

    assert result["tf"]["annotation_names"] == ["fhw_tf_0", "fhw_tf_0"]
    assert result["tf"]["circular_ids"] == ["fhw_tf_0", "fhw_tf_0"]


def test_parse_ma_aq_layers_forward_read_unaffected_by_frame_args():
    # Passing read_length on a forward read is a no-op: same result as omitting it.
    ma = "10;nuc+QQQ:1-3,5-2"
    aq = [200, 10, 20, 150, 30, 40]
    mapper = IdentityOffsetMapper()

    expected = {
        "nuc": {
            "intervals": [[0, 3, 3], [4, 6, 2]],
            "qualities": [[200, 150], [10, 30], [20, 40]],
            "quality_names": ["nq", "lq", "rq"],
        },
    }

    assert bam_tags.parse_ma_aq_tags_into_layers(ma, aq, mapper, 100, 110) == expected
    assert bam_tags.parse_ma_aq_tags_into_layers(
        ma, aq, mapper, 100, 110, read_length=10, is_reverse=False
    ) == expected


def test_parse_ma_aq_layers_reverse_read_defaults_to_seq_frame():
    # Unmarked MA/AQ tags are SEQ/query-frame. Reverse reads should not flip
    # or swap edge qualities unless the BAM explicitly declares molecular coords.
    ma = "10;nuc+QQQ:1-3,5-2"
    aq = [200, 10, 20, 150, 30, 40]
    mapper = IdentityOffsetMapper()

    result = bam_tags.parse_ma_aq_tags_into_layers(
        ma, aq, mapper, 100, 110, read_length=10, is_reverse=True
    )

    assert result == {
        "nuc": {
            "intervals": [[0, 3, 3], [4, 6, 2]],
            "qualities": [[200, 150], [10, 30], [20, 40]],
            "quality_names": ["nq", "lq", "rq"],
        },
    }


def test_parse_ma_aq_layers_marked_molecular_reverse_read_flips_frame_and_swaps_edges():
    # MA/AQ are molecular frame. On a reverse read (L=10) each interval flips to
    # SEQ frame (seq_start = L - (mol_start + len)) and its edge bytes swap
    # (molecular-left lq is the genomic-right edge), then intervals re-sort
    # ascending by genomic start with quality bytes riding along.
    #   nuc0 mol [0,3) -> SEQ [7,10);  nuc1 mol [4,6) -> SEQ [4,6)
    #   sorted genomic-ascending: nuc1 (SEQ 4) then nuc0 (SEQ 7)
    ma = "10;nuc+QQQ:1-3,5-2"
    aq = [200, 10, 20, 150, 30, 40]   # nuc0=(nq200,lq10,rq20), nuc1=(nq150,lq30,rq40)
    mapper = IdentityOffsetMapper()    # query_to_ref = 100 + q

    result = bam_tags.parse_ma_aq_tags_into_layers(
        ma,
        aq,
        mapper,
        100,
        110,
        read_length=10,
        is_reverse=True,
        tags_are_molecular=True,
    )

    assert result == {
        "nuc": {
            # nuc1 -> SEQ[4,6) -> ref[104,106) -> region-rel [4,6];
            # nuc0 -> SEQ[7,10) -> ref[107,110) -> region-rel [7,10]
            "intervals": [[4, 6, 2], [7, 10, 3]],
            # nq in genomic order; lq/rq are the swapped edge bytes:
            #   nuc1 (lq30,rq40) -> genomic-left=rq40, genomic-right=lq30
            #   nuc0 (lq10,rq20) -> genomic-left=rq20, genomic-right=lq10
            "qualities": [[150, 200], [40, 20], [30, 10]],
            "quality_names": ["nq", "lq", "rq"],
        },
    }


def test_strand_rescue_evidence_edges_swap_on_molecular_reverse_reads():
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "10;tf_sr+QQQ:1-3",
        [200, 10, 20],
        IdentityOffsetMapper(),
        100,
        110,
        read_length=10,
        is_reverse=True,
        tags_are_molecular=True,
    )

    assert result["tf_sr"] == {
        "intervals": [[7, 10, 3]],
        "qualities": [[200], [20], [10]],
        "quality_names": ["q0", "q1", "q2"],
    }


def test_tf_family_quality_dimensions_parse_and_keep_family_bytes_on_reverse():
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "10;tf_sr+QQQQQ:1-3",
        [200, 10, 20, 7, 230],
        IdentityOffsetMapper(),
        100,
        110,
        read_length=10,
        is_reverse=True,
        tags_are_molecular=True,
    )

    assert result["tf_sr"] == {
        "intervals": [[7, 10, 3]],
        "source_intervals": [[7, 10, 3]],
        "qualities": [[200], [20], [10], [7], [230]],
        "quality_names": ["q0", "q1", "q2", "fi", "fq"],
    }


def test_materialized_tf_consensus_uses_virtual_overlay_quality_names():
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "20;tf_consensus.QQQQ:2-5",
        [230, 7, 230, 12],
        IdentityOffsetMapper(),
        100,
        120,
        an_str="fhxcr_demo_F007",
    )

    assert result["tf_consensus"]["quality_names"] == ["tq", "fi", "fq", "op"]
    assert result["tf_consensus"]["qualities"] == [[230], [7], [230], [12]]
    assert result["tf_consensus"]["annotation_names"] == ["fhxcr_demo_F007"]


def test_parse_unqualified_ddda_mcg_ma_layer():
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "100;ddda_mcg.:21-5,31-6",
        None,
        IdentityOffsetMapper(),
        100,
        200,
    )

    assert result["ddda_mcg"] == {
        "intervals": [[20, 25, 5], [30, 36, 6]],
        "qualities": None,
        "quality_names": [],
    }


def test_multifamily_latent_members_keep_shared_token_roles_and_segment_qualities():
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "120;tf_sr+QQQQQ:11-29,64-24;nuc_sr+QQQ:94-27",
        [
            251, 255, 79, 21, 253,
            251, 255, 255, 22, 213,
            251, 42, 255,
        ],
        IdentityOffsetMapper(),
        100,
        220,
        an_str=(
            "fhlt_deadbeefdeadbeef_R0,"
            "fhlt_deadbeefdeadbeef_R1,"
            "fhlt_deadbeefdeadbeef_N0_H"
        ),
    )

    assert result["tf_sr"]["annotation_names"] == [
        "fhlt_deadbeefdeadbeef_R0",
        "fhlt_deadbeefdeadbeef_R1",
    ]
    assert result["tf_sr"]["qualities"] == [
        [251, 251],
        [255, 255],
        [79, 255],
        [21, 22],
        [253, 213],
    ]
    assert result["nuc_sr"]["annotation_names"] == [
        "fhlt_deadbeefdeadbeef_N0_H",
    ]
    assert result["nuc_sr"]["qualities"] == [[251], [42], [255]]


def test_layer_payload_keeps_unclipped_reference_bounds_for_analysis():
    result = bam_tags.parse_ma_aq_tags_into_layers(
        "10;tf_sr+QQQQQ:1-5",
        [255, 0, 0, 7, 230],
        IdentityOffsetMapper(),
        102,
        108,
    )
    assert result["tf_sr"]["intervals"] == [[0, 3, 5]]
    assert result["tf_sr"]["source_intervals"] == [[-2, 3, 5]]


def test_legacy_layer_helpers():
    intervals = [[0, 10, 120], [10, 20, -10], [20, 30, 130], [30, 40, 50]]
    fire_intervals = [[5, 8, 200], [40, 45, 128]]

    assert bam_tags.generate_msp_from_nuc_gaps(intervals) == [[10, 20, 10]]

    expected_layers = {
        "nuc": {
            "intervals": [[0, 10, 120], [20, 30, 130]],
            "qualities": [[90, 91], [80, 81], [70, 71]],
            "quality_names": ["nq", "lq", "rq"],
        },
        "tf": {
            "intervals": [[30, 40, 50]],
            "qualities": [[92], [82], [72]],
            "quality_names": ["nq", "lq", "rq"],
        },
        "msp": {
            "intervals": [[5, 8, 3], [40, 45, 5]],
            "qualities": [[200, 128]],
            "quality_names": ["aq"],
        },
    }

    assert bam_tags.build_legacy_layers(
        intervals,
        [90, 91, 92],
        [80, 81, 82],
        [70, 71, 72],
        fire_intervals,
        0,
        50,
    ) == expected_layers


def test_legacy_layer_build_honors_requested_inference_flags():
    intervals = [[0, 10, 120], [10, 20, -10], [20, 30, 130], [30, 40, 50]]

    assert bam_tags.build_legacy_layers(
        intervals,
        [],
        [],
        [],
        [],
        0,
        50,
        infer_tf=False,
        infer_nuc=True,
        infer_msp=False,
    ) == {
        "nuc": {
            "intervals": [[0, 10, 120], [20, 30, 130]],
            "qualities": None,
            "quality_names": [],
        },
    }


def test_legacy_layer_inference_splits_tf_nuc_and_msp_by_adjustable_cutoff():
    intervals = [[0, 100, 100], [100, 105, -5], [105, 185, 80], [185, 190, -5], [190, 285, 95]]

    assert bam_tags.infer_legacy_layers_from_intervals(intervals, nuc_min_size=90) == {
        "tf": {
            "intervals": [[105, 185, 80]],
            "qualities": None,
            "quality_names": [],
        },
        "nuc": {
            "intervals": [[0, 100, 100], [190, 285, 95]],
            "qualities": None,
            "quality_names": [],
        },
        "msp": {
            "intervals": [[100, 190, 90]],
            "qualities": None,
            "quality_names": [],
        },
    }

    assert bam_tags.infer_legacy_layers_from_intervals(intervals, nuc_min_size=80)["msp"] == {
        "intervals": [[100, 105, 5], [185, 190, 5]],
        "qualities": None,
        "quality_names": [],
    }


def test_legacy_fire_all_zero_quality_is_unqualified():
    layers = bam_tags.build_legacy_layers(
        [[0, 10, 120]],
        [],
        [],
        [],
        [[2, 5, 0], [6, 8, 0]],
        0,
        10,
    )

    assert layers["msp"] == {
        "intervals": [[2, 5, 3], [6, 8, 2]],
        "qualities": None,
        "quality_names": [],
    }


def test_joint_duplex_opportunity_rug_uses_both_coverage_masks():
    read=FakeRead(query_sequence='CYGRCYGR',tags={'cs':'ct;ga','MA':'8;deam+:1-4;deam-:5-4'},
        aligned_pairs=[(i,100+i) for i in range(8)])
    assert bam_tags.parse_deamination_opportunities(read,100,108,[[1,1],[3,0],[5,1],[7,0]])=={'ct':[0,1],'ga':[6,7]}
    read._tags['MA']='8;deam+:1-4,6-1;deam-:5-4'
    assert bam_tags.parse_deamination_opportunities(read,100,108)=={'ct':[0,1,5],'ga':[6,7]}


def test_reverse_mm_deamination_flavor_matches_reference_channel():
    read=FakeRead(query_sequence='GGGG',tags={'MM':'C+u,0;','ML':[200]},is_reverse=True,
        aligned_pairs=[(i,100+i) for i in range(4)])
    assert bam_tags.parse_mm_ml_tags_by_type(read,100,104)['deam']==[[3,0]]
def test_annotation_projection_excludes_inserted_endpoints():
    from models.domain import CigarCoordMapper
    mapper=CigarCoordMapper([(4,5),(0,10),(1,3),(0,10)],100)
    assert mapper.aligned_query_interval_to_ref(5,17)==(100,110)
    assert mapper.aligned_query_interval_to_ref(15,17)==(None,None)
    assert mapper.aligned_query_interval_to_ref(0,10)==(100,106)
    assert mapper.aligned_query_interval_to_ref(16,20)==(110,113)


def test_parse_ma_aq_layers_gives_each_deam_strand_its_own_layer():
    mapper = IdentityOffsetMapper()
    ma = "60;deam+:1-50;deam-:30-20"
    both = bam_tags.parse_ma_aq_tags_into_layers(ma, None, mapper, 100, 200)
    assert both["deam_ct"]["intervals"] == [[0, 50, 50]]
    assert both["deam_ga"]["intervals"] == [[29, 49, 20]]
    assert both["deam"]["intervals"] == [[0, 50, 50], [29, 49, 20]]
    only_ct = bam_tags.parse_ma_aq_tags_into_layers(ma, None, mapper, 100, 200, include_names={"deam_ct"})
    assert set(only_ct) == {"deam_ct"}
    # Other layers' strand sections are not split.
    assert set(bam_tags.parse_ma_aq_tags_into_layers("60;ctcf+:1-5;ctcf-:9-5", None, mapper, 100, 200)) == {"ctcf"}


def test_mm_base_positions_match_a_per_base_scan():
    import random
    from services.bam_tags import mm_base_positions
    rng = random.Random(3)
    seq = "".join(rng.choice("ACGTacgtNnUu") for _ in range(5000))
    for bases in ("A", "C", "G", "T", "TU"):
        expected = [i for i, b in enumerate(seq) if b.upper() in set(bases)]
        assert mm_base_positions(seq, bases) == expected
    assert mm_base_positions("", "A") == []


def test_the_vectorised_mm_decoder_matches_the_reference_decoder():
    """fb-n10 perf: _decode_mm_ml_calls (numpy, per MM section) returns exactly what the
    per-delta reference decoder returns (calls, Python types, None for corrupt tags), on
    random tags with several sections and codes, both strands, and malformed variants."""
    import random

    import pysam

    rng = random.Random(5)
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "c", "LN": 100_000}]})

    def record(seq, mm, ml, reverse=False, mn=None):
        read = pysam.AlignedSegment(header)
        read.query_name = "r"
        read.query_sequence = seq
        read.flag = 16 if reverse else 0
        read.reference_id, read.reference_start = 0, 10
        read.cigartuples = [(5, 2), (4, 3), (0, 5), (1, 2), (7, len(seq) - 15), (3, 7), (8, 3), (4, 2)]
        read.set_tag("MM", mm)
        if ml is not None:
            read.set_tag("ML", array("B", ml))
        if mn is not None:
            read.set_tag("MN", mn)
        return read

    cases = []
    for _ in range(60):
        seq = "".join(rng.choice("ACGT") for _ in range(rng.randint(30, 400)))
        sections, ml = [], []
        for base, codes in (("A", "a"), ("C", "mh"), ("T", "17596"), ("N", "n")):
            if rng.random() < 0.3:
                continue
            count = (len(seq) if base == "N" else seq.count(base)) // 3
            deltas = [rng.randint(0, 2) for _ in range(count)]
            sections.append(f"{base}+{codes}{rng.choice(['', '?', '.'])}," + ",".join(map(str, deltas)))
            ml += [rng.randint(0, 255) for _ in range(len(deltas) * (1 if codes.isdigit() else len(codes)))]
        mm = ";".join(sections) + ";"
        cases.append(record(seq, mm, ml, reverse=rng.random() < 0.5))
        cases.append(record(seq, mm, ml[:-1] if ml else [1]))              # ML too short
        cases.append(record(seq, mm.replace(",1", ",01", 1), ml))        # a leading zero
        cases.append(record(seq, mm.replace(",2", ",x", 1), ml))         # not a number
        cases.append(record(seq, "A+a," + ",".join(["5"] * len(seq)) + ";", None))  # past the last A
        cases.append(record(seq, mm, ml, mn=len(seq) + 1))               # MN disagrees
        cases.append(record(seq, mm, None))                              # no ML
    for read in cases:
        fast, reference = bam_tags._decode_mm_ml_calls(read), bam_tags._decode_mm_ml_calls_reference(read)
        assert fast == reference
        assert [tuple(map(type, call)) for call in fast or []] == [tuple(map(type, call)) for call in reference or []]
        for lo, hi, threshold in ((0, 100_000, -1), (25, 150, 125), (10, 300, 255), (0, 100_000, 256)):
            assert bam_tags.parse_mm_ml_tags_by_type(read, lo, hi, threshold) == (
                bam_tags._parse_mm_ml_tags_by_type_reference(read, lo, hi, threshold))


def test_a_padded_cigar_keeps_the_aligned_pairs_mapping():
    """Codex review: pysam's get_aligned_pairs advances the query index across padding (P),
    get_reference_positions does not; marks keep the aligned-pairs placement there."""
    import pysam

    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "c", "LN": 1000}]})
    read = pysam.AlignedSegment(header)
    read.query_name, read.query_sequence = "p", "AAAA"
    read.reference_id, read.reference_start = 0, 100
    read.cigartuples = [(0, 2), (6, 1), (0, 2)]
    read.set_tag("MM", "A+a,0,0,0,0;")
    read.set_tag("ML", array("B", [200] * 4))
    pairs = {q: r for q, r in read.get_aligned_pairs() if q is not None and r is not None}
    expected = sorted(pairs[q] - 100 for q in range(4) if q in pairs)
    assert bam_tags.parse_mm_ml_tags_by_type(read, 100, 200, 125)["m6a"] == expected


def test_iupac_slice_matches_reference_positions_for_mixed_cigars():
    import random
    import pysam
    rng = random.Random(137)
    for _ in range(300):
        cigar = [(4, rng.randint(1, 10))]
        cigar.extend((rng.choice([0, 1, 2, 3, 7, 8]), rng.randint(1, 30)) for _ in range(10))
        cigar.extend([(0, 20), (4, 5)])
        read = pysam.AlignedSegment()
        read.query_name = 'mixed'
        read.reference_start = 100
        read.cigartuples = cigar
        read.flag = rng.choice([0, 16])
        read.query_sequence = ''.join(rng.choice('ACGTRY') for _ in range(sum(n for op, n in cigar if op in (0, 1, 4, 7, 8))))
        refs = read.get_reference_positions(full_length=True)
        for lo, hi in [(80, 400), (110, 150), (145, 210)]:
            expected = [[p-lo, 0 if base == 'R' else 1]
                        for base, p in zip(read.query_sequence, refs)
                        if base in 'RY' and p is not None and lo <= p < hi]
            assert bam_tags.parse_iupac_ry_positions(read, lo, hi) == expected


def test_ma_header_runtime_import_failure_is_not_silently_seq(monkeypatch):
    import builtins
    import pytest
    original = builtins.__import__

    def broken(name, *args, **kwargs):
        if name == 'fiberhmm.io.annotation_frame':
            raise RuntimeError('injected numba cache import failure')
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', broken)
    with pytest.raises(RuntimeError, match='injected numba cache'):
        bam_tags.bam_ma_group_frame({'CO': ['fiberhmm:coord=molecular']})


def test_ma_header_policy_runtime_failure_is_not_silently_seq(monkeypatch):
    import pytest
    def broken(header):
        raise RuntimeError('injected header policy failure')
    monkeypatch.setattr(bam_tags, 'bam_ma_aq_tags_are_molecular', broken)
    with pytest.raises(RuntimeError, match='injected header policy'):
        bam_tags.bam_ma_group_frame({'CO': ['fiberhmm:coord=molecular']})


def test_missing_optional_frame_policy_preserves_declared_geometry_on_both_strands(monkeypatch):
    import builtins
    original = builtins.__import__

    def missing(name, *args, **kwargs):
        if name == 'fiberhmm.io.annotation_frame':
            raise ImportError('optional policy unavailable')
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', missing)
    frame = bam_tags.bam_ma_group_frame({'CO': ['fiberhmm:coord=molecular']})
    assert frame.header_molecular
    for reverse, interval, qualities in [(False, [0, 3, 3], [[200], [10], [20]]),
                                          (True, [7, 10, 3], [[200], [20], [10]])]:
        result = bam_tags.parse_ma_aq_tags_into_layers(
            '10;nuc+QQQ:1-3', [200, 10, 20], IdentityOffsetMapper(), 100, 110,
            read_length=10, is_reverse=reverse, tags_are_molecular=frame)
        assert result['nuc']['intervals'] == [interval]
        assert result['nuc']['qualities'] == qualities


def test_cached_ma_parse_preserves_quality_name_and_call_offsets():
    mapper = IdentityOffsetMapper()
    ma = "60;tf.Q:bad-2,1-4,,9-3;tf.Q:20-2"
    kwargs = dict(an_str="bad,first,second,third", call_meta=(60, 0, False))
    first = bam_tags.parse_ma_aq_tags_into_layers(ma, [10, 20, 30], mapper, 100, 200, **kwargs)
    second = bam_tags.parse_ma_aq_tags_into_layers(ma, [40, 50, 60], mapper, 100, 200, **kwargs)
    assert first['tf']['intervals'] == second['tf']['intervals'] == [[0, 4, 4], [8, 11, 3], [19, 21, 2]]
    assert first['tf']['annotation_names'] == ['first', 'second', 'third']
    assert first['tf']['qualities'] == [[10, 20, 30]]
    assert second['tf']['qualities'] == [[40, 50, 60]]
    assert first['tf']['_fiberbrowser_calls'] == [['MA0:0', 0, 4], ['MA0:1', 8, 11], ['MA1:0', 19, 21]]
    # Cache ownership never escapes: changing a returned layer cannot change later parses.
    first['tf']['intervals'][0][0] = 99
    again = bam_tags.parse_ma_aq_tags_into_layers(ma, [10, 20, 30], mapper, 100, 200, **kwargs)
    assert again['tf']['intervals'][0] == [0, 4, 4]


def test_ma_batch_projection_matches_scalar_cigar_mapper():
    import random
    from models.domain import CigarCoordMapper
    rng = random.Random(19)
    mapper = CigarCoordMapper([(4, 20), (0, 80), (1, 20), (0, 70), (2, 25), (7, 90), (3, 40), (8, 80), (4, 10)], 100)
    intervals = [(a := rng.randrange(-50, 450), a + rng.randrange(-5, 180)) for _ in range(500)]
    expected = [mapper.aligned_query_interval_to_ref(a, b - 1) for a, b in intervals]
    assert bam_tags._ma_aligned_intervals(mapper, intervals) == expected
    assert bam_tags._ma_aligned_intervals(mapper, [(2**100, 2**100 + 1)] * 16) is None
