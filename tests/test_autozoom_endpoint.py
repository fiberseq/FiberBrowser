from models.requests import AutozoomRequest
from services.autozoom_endpoint import autozoom_from_boundaries


def test_autozoom_from_boundaries_detects_primer_sites_and_clips_inward():
    result = autozoom_from_boundaries(
        [(100, 900), (110, 890), (120, 880), (300, 500)],
        AutozoomRequest(
            distance=200,
            min_reads=2,
            primer_clip=10,
            cluster_window=50,
        ),
        chrom="chr2L",
        start=150,
        end=850,
        search_start=0,
        search_end=1000,
    )

    assert result["success"] is True
    assert result["chrom"] == "chr2L"
    assert result["start"] == 135
    assert result["end"] == 865
    assert result["spanning_reads"] == 3
    assert result["left_primer"] == 125
    assert result["right_primer"] == 875


def test_autozoom_never_puts_the_right_primer_left_of_the_left_one():
    # Most reads start (and end) in bin 10; the rest end before the window, piling
    # up in bin 0. No read ends right of the left primer.
    boundaries = [(500, 540)] * 6 + [(-100, -50)] * 5
    result = autozoom_from_boundaries(
        boundaries,
        AutozoomRequest(distance=200, min_reads=2, primer_clip=10, cluster_window=50),
        chrom="chr2L", start=150, end=850, search_start=0, search_end=1000,
    )
    if "right_primer" in result:
        assert result["right_primer"] >= result["left_primer"]
    if result.get("success"):
        assert result["start"] < result["end"]


def test_autozoom_refuses_a_zero_cluster_window():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        AutozoomRequest(cluster_window=0)
