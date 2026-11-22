"""Annotation overlays of headless figures: BED track and boxes, opening-width classes, no-opening statistics."""
from __future__ import annotations

import pytest

import headless_figure_data as hfd
from test_headless_figure_options import by_dataset, paths, pdf_text, render, render_error, state  # noqa: F401


@pytest.fixture(scope="module")
def bed(tmp_path_factory):
    path = tmp_path_factory.mktemp("bed") / "regions.bed"
    path.write_text("track name=demo\nchrS\t6000\t6060\tsite-1\nchrS\t3000\t3400\tsite-2\nchrX\t1\t100\tother\n")
    return str(path)


def _expected(bam_path, t0, t1, thresholds=(175, 300, 500)):
    """From the BAM tags directly: per read, spans the target? widest MSP overlapping it (bp)."""
    import pysam
    out = {}
    with pysam.AlignmentFile(bam_path) as bam:
        for r in bam.fetch(hfd.CONTIG, t0, t1):
            blocks = r.get_blocks()
            spans = any(a <= t0 and b >= t1 for a, b in blocks)
            q2r = {q: ref for q, ref in r.get_aligned_pairs(matches_only=True)}
            best = None
            for s, length in zip(r.get_tag("as"), r.get_tag("al")):
                a, b = q2r.get(s), q2r.get(s + length - 1)
                if a is None or b is None:
                    continue
                if a < t1 and b + 1 > t0:
                    best = max(best or 0, length)
            out[r.query_name] = (spans, None if best is None else sum(best >= t for t in thresholds))
    return out


def test_no_opening_and_classes_match_the_reads(state, paths, bed):
    _pdf, manifest = render(state, hfd.session(paths), annotations={"bed": bed, "classes": True, "stats": True})
    names = ["<175 bp", "potentiated", "merged", "actuated"]
    for ds_id, path in paths.items():
        stats = by_dataset(manifest)[ds_id]["annotation"]
        assert stats["target"] == {"chrom": "chrS", "start": 6000, "end": 6060, "name": "site-1"}
        assert stats["patch_layer"] == "msp"
        expected = _expected(path, 6000, 6060)
        spanning = [v for v in expected.values() if v[0]]
        panel = stats["panel"]
        assert panel["n"] == len(spanning) == 60
        assert panel["no_opening"] == sum(1 for v in spanning if v[1] is None) == 12
        assert panel["pct_no_opening"] == 20.0
        assert panel["classes"] == {n: sum(1 for v in spanning if v[1] == i) for i, n in enumerate(names)}
    clusters = by_dataset(manifest)["ds-a"]["annotation"]["clusters"]
    assert sum(c["n"] for c in clusters.values()) == 60
    assert sum(c["no_opening"] for c in clusters.values()) == 12
    assert "clusters" not in by_dataset(manifest)["ds-b"]["annotation"]


def test_side_labels_and_bed_names_are_drawn(state, paths, bed):
    data, _m = render(state, hfd.session(paths), annotations={"bed": bed, "stats": True})
    text = pdf_text(data)
    assert "(site-1)" in text and "(site-2)" in text and "(other)" not in text
    assert "(n=60 \xb7 20% no opening)" in text
    assert "(C0: n=15 \xb7 20% no opening)" in text


def test_reads_not_spanning_the_target_are_left_out(state, paths, bed):
    _pdf, manifest = render(state, hfd.session(paths), annotations={"bed": bed, "target": "site-2", "stats": True})
    partial = sum(1 for k in range(60) if k % 7 == 6)
    panel = by_dataset(manifest)["ds-b"]["annotation"]["panel"]
    assert panel["not_spanning"] == partial and panel["n"] == 60 - partial


def test_custom_classes_and_explicit_target(state, paths):
    ann = {"intervals": [["chrS", 6000, 6060, "x"]], "target": [6000, 6060],
           "classes": {"thresholds": [400], "names": ["narrow", "wide"], "colors": ["#000000", "#ff0000"]}}
    _pdf, manifest = render(state, hfd.session(paths), annotations=ann)
    expected = _expected(paths["ds-b"], 6000, 6060, thresholds=(400,))
    classes = by_dataset(manifest)["ds-b"]["annotation"]["panel"]["classes"]
    assert classes == {"narrow": sum(1 for v in expected.values() if v[0] and v[1] == 0),
                       "wide": sum(1 for v in expected.values() if v[0] and v[1] == 1)}


def test_track_row_height_and_draw_none(state, paths, bed):
    _p, plain = render(state, hfd.session(paths))
    _p, track = render(state, hfd.session(paths), annotations={"bed": bed, "track_height": 20})
    _p, none = render(state, hfd.session(paths), annotations={"bed": bed, "draw": "none"})
    assert track["page"]["height_px"] - plain["page"]["height_px"] == pytest.approx(2 * 20)
    assert none["page"]["height_px"] == plain["page"]["height_px"]


def test_bad_annotation_options(state, paths, bed):
    assert "no read" in render_error(state, hfd.session(paths), annotations={"bed": bed, "stats": True,
                                                                             "patch_layer": "tf"})
    assert "3 names" in render_error(state, hfd.session(paths), annotations={
        "bed": bed, "classes": {"thresholds": [100, 200], "names": ["a"]}})
    assert "unknown option" in render_error(state, hfd.session(paths), annotations={"bed": bed, "colour": "red"})


def test_public_servers_refuse_bed_paths():
    from services.figure.annotations import check_public
    from services.figure_render import FigureError
    with pytest.raises(FigureError):
        check_public({"bed": "/etc/hosts"})
    check_public({"intervals": [["chrS", 1, 2]]})


def test_patches_running_past_the_view_keep_their_full_width(state, paths, bed):
    ann = {"bed": bed, "target": "site-1", "classes": True, "stats": True}
    _p, full = render(state, hfd.session(paths), annotations=ann)
    _p, cut = render(state, hfd.session(paths), annotations=ann, region="chrS:2000-6030")
    for ds_id in ("ds-a", "ds-b"):
        assert by_dataset(cut)[ds_id]["annotation"]["panel"] == by_dataset(full)[ds_id]["annotation"]["panel"]
        assert by_dataset(full)[ds_id]["annotation"]["panel"]["patches_at_window_edge"] == 0


def test_spanning_only_views_still_find_the_patches(state, paths, bed):
    ann = {"bed": bed, "target": "site-1", "classes": True, "stats": True}
    _p, manifest = render(state, hfd.session(paths), annotations=ann, spanning_only=True)
    partial = sum(1 for k in range(60) if k % 7 == 6)
    panel = by_dataset(manifest)["ds-b"]["annotation"]["panel"]
    assert panel["n"] == 60 - partial and panel["no_opening"] == sum(
        1 for k in range(60) if k % 7 != 6 and hfd.OPEN_WIDTHS[k % len(hfd.OPEN_WIDTHS)] == 0)


def test_an_explicit_empty_threshold_list_is_one_class(state, paths, bed):
    """Release audit 3.1.1: classes={"thresholds": []} validated as one class but drew with the default thresholds
    (an index past its one colour)."""
    from test_headless_figure_options import render as _render
    session = hfd.session(paths)
    data, manifest = _render(state, session, annotations={"bed": str(bed), "target": 0, "classes": {"thresholds": [], "names": ["all"], "colors": ["#123456"]}})
    assert data[:4] == b"%PDF"
