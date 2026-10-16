from services.track_exports import (
    build_multi_track_export,
    build_single_track_export,
    clamp_export_bins,
)


def test_build_single_track_export_matches_bedgraph_shape_and_sanitizes_values():
    export = build_single_track_export(
        chrom="chr2L",
        start=100,
        end=200,
        bins=4,
        values=[1.5, None, float("nan"), 4],
        label="TF signal",
        description="TF signal",
        format="bedgraph",
        fallback_label="track_0",
    )

    assert export["media_type"] == "text/plain"
    assert export["filename"] == "TF_signal_chr2L_100_200.bedGraph"
    assert export["content"].splitlines() == [
        'track type=bedGraph name="TF_signal" description="TF signal"',
        "chr2L\t100\t125\t1.5",
        "chr2L\t125\t150\t0",
        "chr2L\t150\t175\t0",
        "chr2L\t175\t200\t4",
    ]


def test_build_multi_track_export_joins_columns_and_fills_short_values():
    export = build_multi_track_export(
        chrom="chr2L",
        start=0,
        end=3,
        bins=3,
        labels=["track A", "track B"],
        columns=[[1], [2, None, 4]],
    )

    assert export["filename"] == "tracks_chr2L_0_3.tsv"
    assert export["content"].splitlines() == [
        "chrom\tstart\tend\ttrack_A\ttrack_B",
        "chr2L\t0\t1\t1\t2",
        "chr2L\t1\t2\t0\t0",
        "chr2L\t2\t3\t0\t4",
    ]


def test_clamp_export_bins_matches_router_safety_bounds():
    assert clamp_export_bins(0) == 1
    assert clamp_export_bins(200_000) == 100_000
