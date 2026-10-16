"""Headless ports of the browser's non-read tracks (services/figure/tracks).

Each track is drawn from synthetic inputs onto an SvgSurface and checked for
the browser's geometry, colours and labels.
"""
from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

from services.figure.data import DataCache
from services.figure.defaults import default_metaprofile
from services.figure.spec import FigureSpec, PanelSpec, TrackSpec, _merge_defaults
from services.figure.surface import SvgSurface
from services.figure.tracks import TrackContext, load_all, module_for

CHROM, START, END = "chr1", 1000, 2000


def _ctx(fe=None, *, start=START, end=END, width=1000, dataset=None, state=None):
    dataset = dataset or {"id": "ds", "label": "DS", "color": "#3b82f6",
                          "available_layers": {"nuc": True, "tf": True}, "derived_layers": {}}
    state = state or SimpleNamespace(datasets={}, orthogonal_tracks=[], fasta=None, plasmid_sequences={}, chroms=[])
    merged = _merge_defaults(fe or {})
    panel = PanelSpec(id="ds", dataset_id="ds", state_key="ds", label="DS", color="#3b82f6", dataset=dataset, tracks=[])
    spec = FigureSpec(chrom=CHROM, start=start, end=end, width=width, panels=[panel], fe=merged, source="session")
    return TrackContext(state, spec, panel, DataCache(state, spec), width)


def _draw(ctx, kind, track=None):
    load_all()
    module = module_for(kind)
    track = track or TrackSpec(kind, None)
    height = module.measure(ctx, track)
    surface = SvgSurface(ctx.width, max(1, height))
    if height:
        module.draw(surface, ctx, track, height)
    return height, surface.to_bytes().decode()


def _rects(svg):
    return [dict(re.findall(r'(\w[\w-]*)="([^"]*)"', m)) for m in re.findall(r"<rect ([^>]*)/>", svg)]


# --- peaks (FireTrack) ---------------------------------------------------------

def test_peaks_rows_named_by_rule_with_gradient_layers_and_selection():
    fe = {"peaksLocked": True, "selectedPeaks": [7], "peakModes": {"7": "tf"},
          "peaksByRule": {"default-accessibility": [
              {"start": 1100, "end": 1200, "index": 0, "layer": 0},
              {"start": 1300, "end": 1400, "index": 1, "layer": 3},
              {"start": 1500, "end": 1600, "index": 7, "layer": 1},
              {"start": 5000, "end": 5100, "index": 9, "layer": 0},  # off screen
          ]}}
    height, svg = _draw(_ctx(fe), "fire")
    assert height == 50
    assert ">Peaks</text>" in svg and ">Accessibility</text>" in svg
    assert ">Custom</text>" not in svg  # empty Custom row: on screen only, not in figures
    rects = _rects(svg)
    # One row: grid 50-14-2 = 34 px; peaks 2 px below the row top, 30 px tall.
    peaks = [r for r in rects if r.get("y") == "16" and r.get("height") == "30"]
    xs = sorted(float(r["x"]) for r in peaks)
    assert xs[:2] == [100.0, 300.0]
    strong = next(r for r in peaks if r["x"] == "100")
    assert strong["stroke"] == "#173eab"  # generateLayerColors(#1d4ed8) darkest step
    # Selected: black 3 px outline then the tf mode fill.
    assert any(r.get("stroke") == "#000000" and r.get("stroke-width") == "3" for r in peaks)
    assert any(r.get("fill") == "#f97316" and r["x"] == "500" for r in peaks)


def test_layer_colors_match_the_browser():
    from services.figure.tracks._util import generate_layer_colors
    # Values from the frontend's generateLayerColors('#1d4ed8', 0.7, true).
    assert [c["stroke"] for c in generate_layer_colors("#1d4ed8", 0.7, True)] == [
        "#173eab", "#1d4ed8", "#597fe9", "#86a1ef"]
    assert generate_layer_colors("#f59e0b", 0.65, False)[3] == {"fill": "rgba(245, 158, 11, 0.65)", "stroke": "#f59e0b"}


def test_peaks_custom_row_draws_custom_peaks():
    fe = {"peaksLocked": True, "peaksByRule": {"default-accessibility": [], "default-custom": [
        {"start": 1200, "end": 1250, "index": 1000}]}}
    _, svg = _draw(_ctx(fe), "fire")
    assert ">Custom</text>" in svg
    # Two rows of floor(34/2) = 17 px; custom boxes are row - 2 tall with a 2 px outline.
    assert any(r.get("height") == "15" and r.get("stroke-width") == "2" for r in _rects(svg))


def test_peaks_scan_when_the_view_has_none(monkeypatch):
    calls = []

    def fake_scan(**kwargs):
        calls.append(kwargs)
        return {"peaks": [{"start": 1400, "end": 1500, "index": 0, "layer": 2}]}

    import services.clustering_endpoint as ce
    monkeypatch.setattr(ce, "run_scan_peaks_endpoint", fake_scan)
    _, svg = _draw(_ctx({}), "fire")
    assert len(calls) == 1
    req = calls[0]["req"]
    assert req.signal_source == "accessibility" and req.min_width == 80 and req.threshold_rare == 0.08
    assert calls[0]["dataset_id"] == "ds"
    assert any(r.get("x") == "400" and r.get("width") == "100" for r in _rects(svg))


# --- genes (GeneTrack) ---------------------------------------------------------

def _genes():
    return [
        {"id": "t1", "name": "GENEA", "start": 1100, "end": 1500, "strand": "+",
         "exons": [{"start": 1100, "end": 1150}, {"start": 1400, "end": 1500}]},
        {"id": "t2", "name": "GENEB", "start": 1450, "end": 1900, "strand": "-",
         "exons": [{"start": 1450, "end": 1900}]},
    ]


def test_genes_pack_rows_draw_exons_labels_and_strand_colours():
    ctx = _ctx({"selectedGenes": [{"id": "t2"}]})
    ctx.data.get(("genes", CHROM, START, END), _genes)
    height, svg = _draw(ctx, "gene")
    assert height == 80
    # Overlapping genes take two rows: rowHeight = min(22, 70/2) -> centre 16 and 38.
    assert '<line x1="100" y1="16" x2="500" y2="16" stroke="#2563eb" stroke-width="1.5"/>' in svg
    assert 'y1="38"' in svg and "#dc2626" in svg
    assert ">GENEA</text>" in svg and ">GENEB</text>" in svg
    # Exon: rowHeight * 0.5 tall, centred on the gene line.
    assert '<rect x="100" y="10.5" width="50" height="11" fill="#2563eb"/>' in svg
    # Selected gene: yellow highlight + yellow label (bold).
    assert 'stroke="#fbbf24"' in svg and 'font-weight="bold" font-style="italic" fill="#fbbf24">GENEB<' in svg
    assert "<polyline" in svg  # strand chevrons


def test_genes_empty_region_message():
    ctx = _ctx({})
    ctx.data.get(("genes", CHROM, START, END), lambda: [])
    _, svg = _draw(ctx, "gene")
    assert ">No genes in region</text>" in svg


def test_genes_merge_isoforms_when_rows_get_too_thin():
    genes = [{"id": f"t{i}", "name": "ISO", "start": 1100 + i, "end": 1900, "strand": "+",
              "exons": [{"start": 1100 + i, "end": 1200}]} for i in range(8)]
    ctx = _ctx({})
    ctx.data.get(("genes", CHROM, START, END), lambda: genes)
    _, svg = _draw(ctx, "gene")
    assert ">ISO (8)</text>" in svg
    assert "isoforms merged" not in svg  # an on-screen hint, not figure content


# --- sequence (SequenceTrack) ----------------------------------------------------

def test_sequence_hidden_without_fasta_or_when_zoomed_out():
    assert _draw(_ctx({}, end=START + 200), "sequence")[0] == 0
    state = SimpleNamespace(fasta=object(), plasmid_sequences={}, orthogonal_tracks=[], chroms=[])
    assert _draw(_ctx({}, end=START + 2001, state=state), "sequence")[0] == 0
    assert _draw(_ctx({}, end=START + 2000, state=state), "sequence")[0] == 24


def test_sequence_letters_at_base_zoom_and_complement_when_reversed():
    state = SimpleNamespace(fasta=object(), plasmid_sequences={}, orthogonal_tracks=[], chroms=[])
    ctx = _ctx({}, end=START + 4, width=40, state=state)
    ctx.data.get(("sequence", CHROM, START, START + 4), lambda: "ACGT")
    _, svg = _draw(ctx, "sequence")
    fills = [r["fill"] for r in _rects(svg) if r.get("width") == "10"]
    assert fills == ["#00b300", "#0000ff", "#e6a800", "#ff0000"]
    assert re.findall(r">([ACGT])</text>", svg) == ["A", "C", "G", "T"]

    ctx = _ctx({"isReversed": True}, end=START + 4, width=40, state=state)
    ctx.data.get(("sequence", CHROM, START, START + 4), lambda: "AACG")
    _, svg = _draw(ctx, "sequence")
    by_x = sorted((float(r["x"]), r["fill"]) for r in _rects(svg) if r.get("width") == "10")
    # Reversed: complement, drawn right to left (C G T T).
    assert [f for _, f in by_x] == ["#0000ff", "#e6a800", "#ff0000", "#ff0000"]


def test_sequence_blocks_without_letters_between_200bp_and_2kb():
    state = SimpleNamespace(fasta=object(), plasmid_sequences={}, orthogonal_tracks=[], chroms=[])
    ctx = _ctx({}, end=START + 400, width=400, state=state)
    ctx.data.get(("sequence", CHROM, START, START + 400), lambda: "A" * 400)
    _, svg = _draw(ctx, "sequence")
    assert "</text>" not in svg
    assert '<rect x="0" y="2" width="1" height="20" fill="#00b300"/>' in svg


# --- composite (CompositeTrack / AnnotationTrack) ---------------------------------

def _meta_track():
    comp = default_metaprofile([{"id": "ds", "available_layers": {"nuc": True, "tf": True}}])
    return TrackSpec(f"composite-{comp['id']}", None, comp), comp


def _server_meta(ctx):
    """The panel uses the server's metaprofile (no rule sources, clusters or filters)."""
    ctx.data.get(("reads-view", "ds", None) + ctx.region, lambda: {"reads": [], "pool": [], "use_server_meta": True, "zoomed_out": False})


def test_metaprofile_per_source_lines_scaled_to_each_max():
    track, comp = _meta_track()
    ctx = _ctx({"compositeTracks": [comp]})
    _server_meta(ctx)
    ctx.data.get(("composite.profile", "ds", ("nuc", "tf"), (), None) + ctx.region, lambda: {
        "mod": [], "fire": [], "rules": {}, "layers": {"nuc": [0.0, 0.5, 1.0, 0.5], "tf": [0.2, 0.1, 0.0, 0.0]}})
    height, svg = _draw(ctx, track.type, track)
    assert height == 40  # ORTHO_HEIGHT
    assert ">Metaprofile</text>" in svg
    lines = re.findall(r'<polyline points="([^"]+)"[^>]*stroke="(#[0-9a-f]+)"', svg)
    assert [c for _, c in lines] == ["#16a34a", "#e040fb"]
    nuc = [tuple(map(float, p.split(","))) for p in lines[0][0].split()]
    # 4 values over 1000 px -> stepped; per-source max 1.0 maps to the plot top (16), 0 to bottom (36).
    assert nuc[0] == (0.0, 36.0) and nuc[1] == (250.0, 36.0)
    assert (500.0, 16.0) in nuc
    tf = [tuple(map(float, p.split(","))) for p in lines[1][0].split()]
    assert tf[0] == (0.0, 16.0)  # tf's own max (0.2) reaches the top


def test_metaprofile_no_data_message():
    track, comp = _meta_track()
    ctx = _ctx({"compositeTracks": [comp]})
    _server_meta(ctx)
    ctx.data.get(("composite.profile", "ds", ("nuc", "tf"), (), None) + ctx.region, lambda: {"mod": [], "fire": [], "rules": {}, "layers": {}})
    _, svg = _draw(ctx, track.type, track)
    assert ">No data</text>" in svg


def test_signal_composite_shared_axis_fill_and_catalog_lookup():
    comp = {"id": "c1", "label": "ChIP", "kind": "signal", "scaleMode": "auto", "logScale": False, "visible": True,
            "sources": [{"id": "s", "ref": {"kind": "bigwig", "catalogEntryId": "e1"}, "color": "#2563eb",
                         "visible": True, "scale": 1, "negate": False}]}
    state = SimpleNamespace(orthogonal_tracks=[{"label": "x", "path": "/a.bw"}, {"label": "ChIP", "path": "/b.bw"}],
                            fasta=None, plasmid_sequences={}, chroms=[])
    ctx = _ctx({"compositeTracks": [comp], "catalog": [{"id": "e1", "path": "/b.bw", "kind": "bigwig"}]}, state=state)
    ctx.data.get(("composite.track", 1, CHROM, START, END), lambda: {"values": [-1.0, 1.0], "render_mode": "signal"})
    track = TrackSpec("composite-c1", None, comp)
    _, svg = _draw(ctx, "composite-c1", track)
    assert 'stroke-dasharray="2,2"' in svg  # zero baseline when negatives exist
    assert re.search(r'<polygon [^>]*fill="#2563eb" fill-opacity="0.188"', svg)


def test_annotation_composite_boxes(monkeypatch):
    comp = {"id": "a1", "label": "Sites", "kind": "annotation", "visible": True, "scaleMode": "auto",
            "sources": [{"id": "s", "ref": {"kind": "bigbed", "catalogEntryId": "e1"}, "color": "#7c3aed", "visible": True}]}
    state = SimpleNamespace(orthogonal_tracks=[{"label": "Sites", "path": "/s.bb", "format": "bigBed",
                                                "render_mode": "annotation"}],
                            fasta=None, plasmid_sequences={}, chroms=[])
    ctx = _ctx({"compositeTracks": [comp], "catalog": [{"id": "e1", "path": "/s.bb", "kind": "bigbed"}]}, state=state)
    ctx.data.get(("composite.track", 0, CHROM, START, END), lambda: {
        "render_mode": "annotation", "intervals": [{"start": 1100, "end": 1300, "strand": "+", "name": "siteA"},
                                                   {"start": 1200, "end": 1400, "name": "siteB"}]})
    track = TrackSpec("composite-a1", None, comp)
    height, svg = _draw(ctx, "composite-a1", track)
    assert height == 60  # ANNOTATION_HEIGHT
    assert ">Sites</text>" in svg and ">siteA</text>" in svg
    # Overlapping intervals pack into two 12 px rows below the 14 px label band.
    assert '<rect x="100" y="14" width="200" height="12" fill="#7c3aed" fill-opacity="0.502"' in svg
    assert 'y="27"' in svg


# --- consensus (ConsensusFamilyTrack) ----------------------------------------------

def test_consensus_hidden_without_a_job():
    assert _draw(_ctx({}), "consensus")[0] == 0


def test_consensus_draws_packed_families():
    dataset = {"id": "ds", "derived_layers": {"tf_cr": {"consensus_job_id": "job1"}}}
    ctx = _ctx({}, dataset=dataset)
    catalog = {"region": {"chrom": CHROM, "start": 0, "end": 5000}, "edges": [], "datasets": {"ds": {"catalog": [
        {"family": "f1", "consensus_start": 1100, "consensus_end": 1200, "rates_by_strand": {}},
        {"family": "f2", "consensus_start": 1150, "consensus_end": 1300, "rates_by_strand": {},
         "edge_uncertainty": {"left": [1140, 1160], "right": [1290, 1310]}},
    ]}}}
    ctx.data.get(("consensus.catalog", "job1"), lambda: (catalog, None))
    height, svg = _draw(ctx, "consensus")
    assert height == 60
    assert ">Footprint classes (2)</text>" in svg
    # Palette assigned over the sorted catalog: f1 -> first colour, f2 -> second.
    assert 'fill="#d88724"' in svg and 'fill="#497fc5"' in svg
    assert 'fill-opacity="0.200"' in svg  # uncertainty band


# --- client-side metaprofile (computeMetaprofileFromReads) -------------------------

def test_compute_metaprofile_first_rule_wins_and_normalises_by_coverage():
    from services.figure.tracks._metaprofile import compute_metaprofile
    small = {"id": "small", "enabled": True, "sizeMin": 10, "sizeMax": 80}
    any_size = {"id": "any", "enabled": True, "sizeMin": 10}
    reads = [
        # covers 0-1000; one 50 bp footprint (small) and one 150 bp (any)
        {"id": "a", "intervals": [[0, 100, 0], [100, 150, 50], [150, 600, 0], [600, 750, 150], [750, 1000, 0]],
         "layers": {"tf": {"intervals": [[100, 150, 50]]}}, "methyl": [10, 20]},
        # covers 0-500 only; a 5 bp call is ignored (< 10)
        {"id": "b", "intervals": [[0, 100, 0], [100, 105, 5], [105, 500, 0]]},
    ]
    prof = compute_metaprofile(reads, 1000, [small, any_size], None)
    assert set(prof["rules"]) == {"small", "any"}
    assert len(prof["rules"]["small"]) == 500
    # bin 60 (bp 120): read a has a small footprint, b covers but has none -> 1/2
    assert prof["rules"]["small"][60] == pytest.approx(0.5)
    assert prof["rules"]["any"][60] == 0  # already matched by the first rule
    # bin 350 (bp 700): only read a covers, and it has the 150 bp footprint
    assert prof["rules"]["any"][350] == pytest.approx(1.0)
    assert prof["layers"]["tf"][60] == pytest.approx(0.5)
    assert prof["mod"][5] == pytest.approx(0.5)  # bp 10 -> bin 5, 1 mark / 2 reads


def test_labeling_rule_source_draws_from_the_panel_reads():
    comp = default_metaprofile([{"id": "ds", "available_layers": {"nuc": True, "tf": True}}])
    comp["sources"] = [{"id": "s1", "visible": True, "color": "#ff0000", "ref": {"kind": "metaprofile", "ruleId": "r1"}}]
    track = TrackSpec(f"composite-{comp['id']}", None, comp)
    cmap = {"rules": [{"id": "r1", "name": "Small", "enabled": True, "sizeMin": 10, "sizeMax": 80, "color": "#ff0000"}]}
    ctx = _ctx({"compositeTracks": [comp], "activeColormap": cmap})
    reads = [{"id": "a", "intervals": [[0, 400, 0], [400, 450, 50], [450, 1000, 0]]}]
    ctx.data.get(("reads-view", "ds", None) + ctx.region, lambda: {"reads": reads, "pool": reads, "use_server_meta": False,
                                                "zoomed_out": False, "payload": {}, "state": {}, "plan": {}})
    ctx.data.get(("genes", CHROM, START, END), lambda: [])
    ctx.data.get(("all_peaks",), lambda: [])
    _, svg = _draw(ctx, track.type, track)
    assert ">No data</text>" not in svg
    assert re.search(r'<polyline points="[^"]+"[^>]*stroke="#ff0000"', svg)


def test_local_profile_zoomed_out_is_empty_not_the_server_profile():
    track, comp = _meta_track()
    ctx = _ctx({"compositeTracks": [comp]})
    ctx.data.get(("reads-view", "ds", None) + ctx.region, lambda: {"reads": [], "pool": [], "use_server_meta": False, "zoomed_out": True})
    ctx.data.get(("composite.profile", "ds", ("nuc", "tf"), (), None) + ctx.region, lambda: {  # would draw curves if used
        "mod": [], "fire": [], "rules": {}, "layers": {"nuc": [0.5, 1.0], "tf": [0.2, 0.1]}})
    _, svg = _draw(ctx, track.type, track)
    assert ">No data</text>" in svg


def test_circular_axis_label_ends_at_the_contig_length():
    from services.figure.tracks.axis import _circular_region_label
    assert _circular_region_label("pX", 0, 5054, 5054, 5054) == "pX:0-5,054 circular"
    assert _circular_region_label("pX", 4000, 6000, 5054, 2000) == "pX:4,000..946 (wrap)"


def test_peaks_custom_row_left_out_when_its_peaks_are_elsewhere():
    fe = {"peaksLocked": True, "peaksByRule": {"default-accessibility": [], "default-custom": [
        {"start": 1200, "end": 1250, "index": 1000, "chrom": "chr9"},
        {"start": 9000, "end": 9100, "index": 1001}]}}
    _, svg = _draw(_ctx(fe), "fire")
    assert ">Custom</text>" not in svg


def test_strand_panels_request_their_strand():
    from services.figure.spec import build_panels
    from types import SimpleNamespace
    ds = SimpleNamespace(id="ds", label="DS", color="#000", paths=["/x.bam"], path="/x.bam", data_type="bam",
                         available_layers={"deam": True}, to_dict=lambda: {"id": "ds", "label": "DS", "data_type": "bam"})
    state = SimpleNamespace(datasets={"ds": ds}, dataset_order=["ds"])
    fe = {"panels": [{"id": "a", "datasetId": "ds", "strand": "CT", "subTracks": [{"type": "reads", "visible": True}]},
                     {"id": "b", "datasetId": "ds", "stateKey": "b", "strand": "GA", "subTracks": [{"type": "reads", "visible": True}]}]}
    panels = build_panels(state, _merge_defaults(fe))
    assert [p.strand for p in panels] == ["CT", "GA"]


def test_a_panel_at_another_locus_draws_its_own_region():
    from dataclasses import replace
    from services.figure.spec import build_panels
    ds = SimpleNamespace(id="ds", label="DS", color="#000", paths=["/x.bam"], path="/x.bam", data_type="bam",
                         available_layers={}, to_dict=lambda: {"id": "ds", "label": "DS", "data_type": "bam"})
    state = SimpleNamespace(datasets={"ds": ds}, dataset_order=["ds"])
    fe = {"panels": [{"id": "a", "datasetId": "ds", "subTracks": [{"type": "axis", "visible": True}]},
                     {"id": "b", "datasetId": "ds", "stateKey": "b", "subTracks": [{"type": "axis", "visible": True}],
                      "viewportOverride": {"chrom": "chr1_hap2", "start": 5000, "end": 6000}}]}
    panels = build_panels(state, _merge_defaults(fe))
    assert [p.region for p in panels] == [None, ("chr1_hap2", 5000, 6000)]
    ctx = _ctx()
    assert (ctx.chrom, ctx.start, ctx.end) == (CHROM, START, END)
    other = replace(ctx, panel=panels[1])
    assert (other.chrom, other.start, other.end) == ("chr1_hap2", 5000, 6000)
    # Main-view peaks (no chrom) stay out of it; its own tagged peaks show.
    fe_peaks = {"peaksLocked": True, "peaksByRule": {"default-accessibility": [
        {"start": 5100, "end": 5200, "index": 0, "layer": 0},
        {"start": 5500, "end": 5600, "index": 1, "layer": 0, "chrom": "chr1_hap2"}]}}
    peaks_ctx = replace(_ctx(fe_peaks), panel=panels[1])
    xs = [float(r["x"]) for r in _rects(_draw(peaks_ctx, "fire")[1]) if r.get("height") == "30"]
    assert xs == [500.0]


def test_read_colouring_sees_only_the_panels_own_peaks():
    from dataclasses import replace
    from services.figure.tracks.reads import _all_peaks
    fe = {"peaksByRule": {"default-accessibility": [
        {"start": 1100, "end": 1200, "index": 0},
        {"start": 1100, "end": 1200, "index": 1, "chrom": "chr2"}]}}
    ctx = _ctx(fe)
    other = replace(ctx, panel=replace(ctx.panel, id="b", region=("chr2", 1000, 2000)))
    assert [p["index"] for p in _all_peaks(ctx)] == [0]
    assert [p["index"] for p in _all_peaks(other)] == [1]


def test_panels_of_one_dataset_without_ids_get_their_own_ids_and_reads():
    from dataclasses import replace
    from services.figure.spec import build_panels
    from services.figure.tracks.reads import _display
    ds = SimpleNamespace(id="ds", label="DS", color="#000", paths=["/x.bam"], path="/x.bam", data_type="bam",
                         available_layers={}, to_dict=lambda: {"id": "ds", "label": "DS", "data_type": "bam"})
    state = SimpleNamespace(datasets={"ds": ds}, dataset_order=["ds"])
    fe = {"panels": [{"datasetId": "ds", "strand": "CT", "subTracks": [{"type": "reads", "visible": True}]},
                     {"datasetId": "ds", "strand": "GA", "subTracks": [{"type": "reads", "visible": True}]}]}
    a, b = build_panels(state, _merge_defaults(fe))
    assert a.id != b.id
    ctx = _ctx()
    ca, cb = replace(ctx, panel=a), replace(ctx, panel=b)
    ctx.data.get(("reads-view", a.id, "CT") + ctx.region, lambda: {"reads": ["ct"]})
    ctx.data.get(("reads-view", b.id, "GA") + ctx.region, lambda: {"reads": ["ga"]})
    assert _display(ca)["reads"] == ["ct"] and _display(cb)["reads"] == ["ga"]


def test_headless_metaprofile_reads_use_the_legacy_layer_settings(monkeypatch):
    import services.read_endpoint as read_endpoint
    seen = {}
    monkeypatch.setattr(read_endpoint, "compact_reads_payload_for_request", lambda state, **kw: seen.update(kw) or {})
    ctx = _ctx({"legacyNucMinSize": 150, "legacyLayerInference": False})
    ctx.data.compact_reads("ds", include_metaprofile=True, metaprofile_layers=["nuc"])
    assert seen["legacy_nuc_min_size"] == 150 and seen["infer_legacy_layers"] is False


def test_peak_scans_take_every_panel_of_a_dataset(monkeypatch):
    from dataclasses import replace
    import services.clustering_endpoint as ce
    import services.figure.tracks.reads as reads_mod
    from services.figure.tracks.peaks import _scan_rule
    ctx = _ctx({})
    ga = replace(ctx.panel, id="ds#2", strand="GA")
    ct = replace(ctx.panel, strand="CT")
    ctx = replace(ctx, spec=replace(ctx.spec, panels=[ct, ga]), panel=ct)
    monkeypatch.setattr(reads_mod, "display_read_ids", lambda c: ["r1", "r2"] if c.panel.strand == "CT" else ["r2", "r3"])
    seen = {}
    monkeypatch.setattr(ce, "run_scan_peaks_endpoint", lambda **kw: seen.update(kw) or {"peaks": []})
    _scan_rule(ctx, {"id": "default-accessibility", "source": "accessibility"})
    assert seen["req"].read_ids_by_dataset == {"ds": ["r1", "r2", "r3"]}


def test_chrom_size_reads_chrominfo_objects_and_dicts():
    from services.figure.tracks.composite import _chrom_size
    ctx = _ctx()
    ctx.state.chroms = [SimpleNamespace(name="chr2", size=50), SimpleNamespace(name=CHROM, size=5000)]
    assert _chrom_size(ctx) == 5000
    ctx.state.chroms = [{"name": CHROM, "length": 700}]
    assert _chrom_size(ctx) == 700
    ctx.state.chroms = [SimpleNamespace(name="chrX", size=9)]
    assert _chrom_size(ctx) is None


def test_figures_use_the_quality_filters_saved_with_their_view(monkeypatch):
    from services.figure import compose
    from services.read_quality_filters import active_quality_filters
    state = SimpleNamespace(quality_filters=[{"layer": "tf", "quality_name": "tq", "min_value": 10}])
    seen = []
    monkeypatch.setattr(compose, "_render", lambda spec, st, *a: seen.append(active_quality_filters(st)) or b"")
    ctx = _ctx({"activeColormap": {"qualityFilters": [
        {"layer": "fire", "qualityName": "aq", "minValue": 230, "enabled": True},
        {"layer": "tf", "qualityName": "tq", "minValue": 50, "enabled": False},
    ]}})
    compose.render(ctx.spec, state)
    assert seen == [[{"layer": "fire", "quality_name": "aq", "min_value": 230.0}]]
    # Outside the figure, the server's own filters apply again.
    assert active_quality_filters(state) == state.quality_filters


def test_request_quality_filters_override_the_servers_for_working_sets():
    from services.read_quality_filters import active_quality_filters, quality_filters_for_request
    state = SimpleNamespace(quality_filters=[{"layer": "fire", "quality_name": "aq", "min_value": 230}])
    assert active_quality_filters(state) == state.quality_filters
    with quality_filters_for_request([]):
        assert active_quality_filters(state) == []
    with quality_filters_for_request([{"layer": "tf", "quality_name": "tq", "min_value": 5}]):
        assert active_quality_filters(state)[0]["layer"] == "tf"
    assert active_quality_filters(SimpleNamespace()) == []
