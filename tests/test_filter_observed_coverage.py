"""Open/closed read filters judge only the part of a peak a read covers."""
from services.filtering_endpoint import _read_passes_accessibility_filter


def test_a_read_covering_part_of_a_peak_is_judged_on_that_part():
    # Accessible over the 10 bp of the 100-bp peak it reaches; the rest is unobserved.
    read = {"intervals": [[0, 10, -10]]}
    kwargs = dict(region_width=100, layer=None)
    assert _read_passes_accessibility_filter(read, [[0, 100]], filter_mode="open", **kwargs)
    assert not _read_passes_accessibility_filter(read, [[0, 100]], filter_mode="closed", **kwargs)


def test_a_read_that_misses_the_peak_passes_neither():
    read = {"intervals": [[200, 300, 150]]}
    kwargs = dict(region_width=400, layer=None)
    assert not _read_passes_accessibility_filter(read, [[0, 100]], filter_mode="open", **kwargs)
    assert not _read_passes_accessibility_filter(read, [[0, 100]], filter_mode="closed", **kwargs)


def test_a_fully_covering_nucleosome_is_closed():
    read = {"intervals": [[0, 100, 147]]}
    kwargs = dict(region_width=100, layer=None)
    assert _read_passes_accessibility_filter(read, [[0, 100]], filter_mode="closed", **kwargs)
    assert not _read_passes_accessibility_filter(read, [[0, 100]], filter_mode="open", **kwargs)


def test_layer_intervals_without_a_size_or_with_extra_columns():
    # Primary intervals with a quality column; a layer given as [start, end] pairs.
    read = {"intervals": [[0, 100, -100, 250]], "layers": {"fire": {"intervals": [[0, 80]]}}}
    assert _read_passes_accessibility_filter(read, [[0, 100]], region_width=100, layer="fire", filter_mode="open")
    assert _read_passes_accessibility_filter(read, [[0, 100]], region_width=100, layer=None, filter_mode="open")
