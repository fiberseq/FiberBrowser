from services.circular_genome import (
    MAX_USER_CIRCULAR_CHROM_SIZE,
    circular_view_segments,
    is_mitochondrial_chrom,
    merge_compact_reads_by_id,
    shift_compact_read,
)


def test_circular_view_segments_split_at_reference_seam():
    segments = circular_view_segments(950, 1050, 1000)

    assert [(s.logical_start, s.logical_end, s.ref_start, s.ref_end) for s in segments] == [
        (950, 1000, 950, 1000),
        (1000, 1050, 0, 50),
    ]


def test_circular_view_segments_support_negative_logical_coords():
    segments = circular_view_segments(-50, 50, 1000)

    assert [(s.logical_start, s.logical_end, s.ref_start, s.ref_end) for s in segments] == [
        (-50, 0, 950, 1000),
        (0, 50, 0, 50),
    ]


def test_circular_view_segments_warns_once_when_truncated(caplog, monkeypatch):
    import logging
    import services.circular_genome as circular_genome

    monkeypatch.setattr(circular_genome, "_TRUNCATION_WARNING_EMITTED", False)
    with caplog.at_level(logging.WARNING, logger="services.circular_genome"):
        segments = circular_genome.circular_view_segments(0, 100, 1, max_segments=3)

    assert len(segments) == 3
    assert "truncated at 3 wrapped segments" in caplog.text

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="services.circular_genome"):
        circular_genome.circular_view_segments(0, 100, 1, max_segments=3)

    assert "truncated at 3 wrapped segments" not in caplog.text


def test_mitochondrial_chrom_names_are_circular_references():
    assert is_mitochondrial_chrom("chrM")
    assert is_mitochondrial_chrom("MT")
    assert is_mitochondrial_chrom("chrMT")
    assert not is_mitochondrial_chrom("chr2L")


def test_shift_and_merge_compact_reads_preserve_layers_and_marks():
    left = {
        "id": "read1",
        "intervals": [[0, 40, 40]],
        "qualities": [10],
        "methyl": [5],
        "layers": {"tf": {"intervals": [[10, 20, 10]], "qualities": [[200]], "quality_names": ["tq"]}},
    }
    right = {
        "id": "read1",
        "intervals": [[0, 30, 30]],
        "qualities": [20],
        "methyl": [8],
        "layers": {"tf": {"intervals": [[4, 12, 8]], "qualities": [[210]], "quality_names": ["tq"]}},
    }

    shifted = shift_compact_read(right, 50)
    merged = merge_compact_reads_by_id([shifted, left])

    assert merged == [{
        "id": "read1",
        "intervals": [[0, 40, 40], [50, 80, 30]],
        "qualities": [10, 20],
        "methyl": [5, 58],
        "layers": {
            "tf": {
                "intervals": [[10, 20, 10], [54, 62, 8]],
                "qualities": [[200, 210]],
                "quality_names": ["tq"],
            },
        },
    }]


def test_get_genes_payload_wraps_circular_windows():
    import pandas as pd
    from types import SimpleNamespace
    from services.read_auxiliary_endpoint import get_genes_payload

    state = SimpleNamespace(
        circular_chroms={"plasmid": {"size": 1000, "source": "test"}},
        gtf_data={
            "transcripts": pd.DataFrame([
                {
                    "chrom": "plasmid",
                    "start": 960,
                    "end": 990,
                    "strand": "+",
                    "transcript_id": "tail_tx",
                    "gene_name": "tail",
                    "biotype": "gene",
                },
                {
                    "chrom": "plasmid",
                    "start": 10,
                    "end": 40,
                    "strand": "-",
                    "transcript_id": "origin_tx",
                    "gene_name": "origin",
                    "biotype": "gene",
                },
            ]),
            "exons": pd.DataFrame([
                {"transcript_id": "tail_tx", "start": 960, "end": 990},
                {"transcript_id": "origin_tx", "start": 10, "end": 40},
            ]),
        },
        translate_chrom=lambda chrom: chrom,
        _chrom_size_for=lambda chrom: 1000,
    )

    payload = get_genes_payload(state, chrom="plasmid", start=950, end=1050)
    by_name = {gene["name"]: gene for gene in payload["content"]["genes"]}

    assert by_name["tail"]["start"] == 960
    assert by_name["origin"]["start"] == 1010
    assert by_name["origin"]["id"] == "origin_tx:wrap1000"


def test_manual_circular_endpoint_rejects_large_chromosomes():
    import asyncio
    from routers.genome import set_circular_chrom_endpoint

    class FakeState:
        circular_chroms = {}

        def _chrom_size_for(self, chrom):
            return MAX_USER_CIRCULAR_CHROM_SIZE + 1

        def set_circular_chrom(self, *args, **kwargs):
            raise AssertionError("large chromosomes should not be marked circular")

    result = asyncio.run(set_circular_chrom_endpoint("chr1", True, state=FakeState()))

    assert result["success"] is False
    assert "limited" in result["error"]


def test_load_direct_reads_wrap_forwards_layer_qualities(monkeypatch):
    """Regression: the circular-wrap recursion in load_direct_reads_for_dataset
    must forward include_layer_qualities. Omitting it raised TypeError (HTTP 500)
    on the default plasmid view, which wraps the origin (e.g. include_cigar=True).
    """
    from types import SimpleNamespace
    import services.read_endpoint as read_endpoint

    captured = []

    def fake_build_direct_bam_reads(state, bam_path, chrom, start, end, **kwargs):
        captured.append(kwargs)
        width = end - start
        return [{"id": "r1", "intervals": [[0, width, width]], "qualities": [10]}]

    monkeypatch.setattr(read_endpoint, "build_direct_bam_reads", fake_build_direct_bam_reads)

    state = SimpleNamespace(
        circular_chroms={"plasmid": {"size": 1000, "source": "test"}},
        translate_chrom=lambda chrom: chrom,
    )
    dataset = SimpleNamespace(data_type="bam", paths=["fake.bam"])

    reads = read_endpoint.load_direct_reads_for_dataset(
        state,
        dataset,
        chrom="plasmid",
        start=950,
        end=1050,
        spanning_only=False,
        include_methylation=False,
        ml_threshold=125,
        min_fp_quality=0,
        include_cigar=True,
        hide_terminal_gaps=True,
        terminal_gap_threshold=500,
        include_layers=False,
        requested_layers=None,
        include_layer_qualities=True,
        infer_legacy_layers=True,
        legacy_nuc_min_size=90,
    )

    # Both wrapped segments hit the BAM leaf, each receiving the forwarded kwarg.
    assert len(captured) == 2
    assert all(call["include_layer_qualities"] is True for call in captured)
    # Same read id across the seam merges into a single read spanning both segments.
    assert [r["id"] for r in reads] == ["r1"]
