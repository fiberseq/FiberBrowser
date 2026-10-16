"""Smoke tests for legacy server.py helper exports.

Most tests should target service modules directly. This small surface keeps
the old notebook/script imports honest without making every service test depend
on server.py as a compatibility barrel.
"""

import numpy as np
import pandas as pd

import server
from services import (
    accessibility_tracks,
    annotation_bigbed,
    bam_handles,
    bam_tags,
    cluster_analysis,
    cluster_assignment,
    clustering_features,
    bigbed_read_loader,
    compact_read_loader,
    fire_tracks,
    gene_annotations,
    motifs,
    orthogonal_tracks,
    read_metrics,
    read_rendering,
    transcription_state,
)


class _CompatFakeBam:
    references = ("chr2L",)

    def __init__(self, reads):
        self.reads = reads

    def fetch(self, chrom, start, end):
        assert chrom == "chr2L"
        return self.reads


class _CompatFakeBamRead:
    is_unmapped = False
    is_secondary = False
    is_supplementary = False
    query_sequence = "A" * 200
    cigartuples = [(0, 100)]

    def __init__(self, query_name, reference_start, reference_end, tags=None):
        self.query_name = query_name
        self.reference_start = reference_start
        self.reference_end = reference_end
        self.tags = tags or {}

    def get_tag(self, tag):
        if tag not in self.tags:
            raise KeyError(tag)
        return self.tags[tag]

    def has_tag(self, tag):
        return tag in self.tags

    def get_tags(self):
        return list(self.tags.items())


class _CompatFakeBigBed:
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


def _compat_bed12_rest(read_id, block_sizes, block_starts, *extra_columns):
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


def test_server_compat_exports_selected_pure_helpers(tmp_path):
    reads_df = pd.DataFrame({"read_id": ["r1"], 0: [50], 1: [100]})
    render_df = pd.DataFrame({100: [10], 101: [10], "read_id": ["r1"]})
    counts = motifs.consensus_to_pwm("ATGN")
    pssm = motifs.pwm_to_pssm(counts)
    jaspar_file = tmp_path / "motifs.jaspar"
    jaspar_file.write_text(
        ">MA0001.1 TestMotif\n"
        "A [ 10 0 0 0 ]\n"
        "C [ 0 10 0 0 ]\n"
        "G [ 0 0 10 0 ]\n"
        "T [ 0 0 0 10 ]\n"
    )
    fire_df = pd.DataFrame([["chr1", 0, 25]], columns=["chrom", "start", "end"])
    compact_reads = [{"id": "r1", "intervals": [[0, 10, 10], [10, 20, -10]]}]
    cluster_reads = [
        {"id": "r1", "intervals": [[0, 10, 5]]},
        {"id": "r2", "intervals": [[0, 10, 120]]},
    ]

    assert np.allclose(server.pwm_to_pssm(counts), motifs.pwm_to_pssm(counts))
    assert server._reverse_complement("AaCcGgTtNnX") == motifs.reverse_complement("AaCcGgTtNnX")
    assert server.scan_sequence("ATGNACGT", pssm, 0.6) == motifs.scan_sequence("ATGNACGT", pssm, 0.6)
    assert server.scan_both_strands("ATGNACGT", pssm, 0.6) == motifs.scan_both_strands("ATGNACGT", pssm, 0.6)
    assert server.parse_jaspar_file(str(jaspar_file)) == motifs.parse_jaspar_file(str(jaspar_file))
    assert np.allclose(
        server.meta_line_plot(reads_df, 0, 2, 10, 90),
        accessibility_tracks.meta_line_plot(reads_df, 0, 2, 10, 90),
    )
    assert np.array_equal(
        server.compute_fire_track(fire_df, "chr1", 0, 25)[0],
        fire_tracks.compute_fire_track(fire_df, "chr1", 0, 25)[0],
    )
    assert server.compact_reads_to_dataframe(
        compact_reads,
        100,
        120,
    ).equals(read_metrics.compact_reads_to_dataframe(compact_reads, 100, 120))
    assert server.sample_by_coverage(compact_reads, 1, 100, 120) == (
        read_metrics.sample_by_coverage(compact_reads, 1, 100, 120)
    )
    assert np.array_equal(
        server.compute_metaprofile_from_compact_reads(compact_reads, 20, 1, 20),
        read_metrics.compute_metaprofile_from_compact_reads(compact_reads, 20, 1, 20),
    )
    assert server.get_footprints_in_region([[10, 20, 10]], 100, -95, -75, "+", 0) == (
        transcription_state.get_footprints_in_region([[10, 20, 10]], 100, -95, -75, "+", 0)
    )
    assert server.evaluate_read_states([[110, 160, 50]], {"start": 100, "end": 500, "strand": "+"}, 0) == (
        transcription_state.evaluate_read_states([[110, 160, 50]], {"start": 100, "end": 500, "strand": "+"}, 0)
    )
    annotations = {"r1": [(105, 110, "tf", 0.8)]}
    assert server.join_annotations_to_reads([{"id": "r1"}], annotations, 100) == (
        annotation_bigbed.join_annotations_to_reads([{"id": "r1"}], annotations, 100)
    )
    assert server.is_annotation_bigbed("/tmp/example.annotations.bb") == (
        annotation_bigbed.is_annotation_bigbed("/tmp/example.annotations.bb")
    )
    assert np.array_equal(
        np.asarray(server.render_reads_to_image(render_df, row_height=2)),
        np.asarray(read_rendering.render_reads_to_image(render_df, row_height=2)),
    )
    assert server.load_orthogonal_tracks("/tmp/fiberbrowser-missing-tracks.txt") == (
        orthogonal_tracks.load_orthogonal_tracks("/tmp/fiberbrowser-missing-tracks.txt")
    )
    assert server.check_bam_index("https://example.test/read.bam") == bam_handles.check_bam_index(
        "https://example.test/read.bam"
    )
    assert server.parse_mm_ml_tags([], 0, 1) == bam_tags.parse_mm_ml_tags([], 0, 1)
    assert server.generate_msp_from_nuc_gaps([[0, 10, 120], [10, 20, -10], [20, 30, 130]]) == (
        bam_tags.generate_msp_from_nuc_gaps([[0, 10, 120], [10, 20, -10], [20, 30, 130]])
    )
    assert server._parse_gtf_attrs('gene_id "gene1";') == gene_annotations._parse_gtf_attrs(
        'gene_id "gene1";'
    )
    assert np.array_equal(
        server.extract_features_from_compact(cluster_reads, [(0, 10)], region_start=0)[0],
        clustering_features.extract_features_from_compact(cluster_reads, [(0, 10)], region_start=0)[0],
    )
    server_clusters = server.cluster_compact_reads(
        cluster_reads,
        [(0, 10)],
        region_start=0,
        n_clusters=2,
        method="combinatorial",
    )
    service_clusters = cluster_assignment.cluster_compact_reads(
        cluster_reads,
        [(0, 10)],
        region_start=0,
        n_clusters=2,
        method="combinatorial",
    )
    assert server_clusters[0] == service_clusters[0]
    assert server_clusters[1] == service_clusters[1]
    assert server.compute_cluster_projection(np.eye(3, dtype=np.float32))[2] == (
        cluster_analysis.compute_cluster_projection(np.eye(3, dtype=np.float32))[2]
    )


def test_server_compat_exports_read_loader_helpers(monkeypatch):
    bam = _CompatFakeBam([
        _CompatFakeBamRead(
            "read1",
            100,
            200,
            tags={"ns": [10], "nl": [20], "nq": [80]},
        )
    ])
    bigbed = _CompatFakeBigBed({
        "chr2L": [
            (100, 170, _compat_bed12_rest("read1", [10, 20], [0, 50], "80,90,")),
        ],
    })
    bed_df = pd.DataFrame([{
        "chrom": "chr2L",
        "start": 100,
        "end": 170,
        "name": "read1",
        "blockCount": "2",
        "blockSizes": "10,20,",
        "blockStarts": "0,50,",
    }])

    monkeypatch.setattr(server, "get_bam_handle", lambda _path: bam)
    monkeypatch.setattr(server, "get_bigbed_handle", lambda _path: bigbed)
    monkeypatch.setattr(server, "detect_overlay_type", lambda _path: "footprint")

    assert server.build_compact_reads_from_bam(
        "reads.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
    ) == compact_read_loader.build_compact_reads_from_bam(
        "reads.bam",
        "chr2L",
        100,
        180,
        spanning_only=False,
        bam_handle_getter=lambda _path: bam,
    )
    assert server.build_compact_reads(
        ["reads.bb"],
        "chr2L",
        100,
        180,
        spanning_only=False,
    ) == compact_read_loader.build_compact_reads_from_bigbed(
        ["reads.bb"],
        "chr2L",
        100,
        180,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: bigbed,
        overlay_type_detector=lambda _path: "footprint",
        format_cache={},
    )
    assert server.build_rd_fast_signed(
        bed_df,
        "chr2L",
        100,
        180,
        spanning_only=False,
    ).equals(bigbed_read_loader.build_rd_fast_signed(
        bed_df,
        "chr2L",
        100,
        180,
        spanning_only=False,
    ))
    assert server.load_reads_from_bigbed(
        ["reads.bb"],
        "chr2L",
        100,
        180,
        spanning_only=False,
    ).equals(bigbed_read_loader.load_reads_from_bigbed(
        ["reads.bb"],
        "chr2L",
        100,
        180,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: bigbed,
        format_cache={},
    ))
    assert server.load_methyl_from_bigbed(
        "reads.bb",
        "chr2L",
        100,
        180,
        layer_type="m6a",
    ) == bigbed_read_loader.load_methyl_from_bigbed(
        "reads.bb",
        "chr2L",
        100,
        180,
        layer_type="m6a",
        bigbed_handle_getter=lambda _path: bigbed,
    )
