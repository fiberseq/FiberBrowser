"""Held-out eval cases for vague, goal-level and ambiguous requests.

The same case schema, reference plans and axes as eval_suite.py (which calls
``add_cases(globals())`` once its helpers exist). Phrasings are fresh: none may
appear in the training corpus (the --dry-run held-out check enforces it).
Ambiguous cases accept "any of these anchors" through ``anchor_alts``.
"""
from __future__ import annotations


def add_cases(ns: dict) -> None:
    _c, ex, tr, op, nav, region, zoom, sidebar, plan, turn, raw = (
        ns["_c"], ns["ex"], ns["tr"], ns["op"], ns["nav"], ns["region"], ns["zoom"], ns["sidebar"],
        ns["plan"], ns["turn"], ns["raw"])
    V_DM6_2R, V_DM6_2L, V_DM6_3R, V_EMPTY, V_HG38_MYC = (
        ns["V_DM6_2R"], ns["V_DM6_2L"], ns["V_DM6_3R"], ns["V_EMPTY"], ns["V_HG38_MYC"])
    DS_NONE, DS_FIBER_ONLY, DS_FIBER_DAF, DS_THREE, D_EMPTY = (
        ns["DS_NONE"], ns["DS_FIBER_ONLY"], ns["DS_FIBER_DAF"], ns["DS_THREE"], ns["D_EMPTY"])

    CLUSTER_ANCHORS = ["cluster-toolbar", "cluster-controls-expand", "cluster-method", "cluster-k",
                       "scan-peaks-button", "peaks-track", "cluster-button", "clusters-overview",
                       "clusters-profiles", "clusters-projection", "merge-similar"]

    def clustered(ctx, ds=DS_FIBER_DAF):
        return raw(ctx, ds, clustered=(0, 1))

    # ── 1. Goal-level biology questions ──────────────────────────────
    _c(id="vg_goal_tf_on_motif", category="teach_goal",
       command="is there a protein sitting on my motif?",
       phrasings=["is my motif occupied", "does something bind my site in these molecules"],
       reference=plan("Check binding with footprints",
                      ex("reads-track", "A bound factor leaves a short footprint on each molecule."),
                      tr("reads-track", "Cmd/Ctrl+click the footprint on your motif.", "footprint_selected",
                         skip_if="has_selected_footprint"),
                      ex("selected-footprint", "The Footprints panel shows how many molecules carry it.",
                         requires="has_selected_footprint")),
       expect={"key_anchors": ["reads-track"],
               "anchor_alts": [["selected-footprint", "footprints-classes", "footprints-cooccupancy"]],
               "allowed_anchors": ["layer-toggles", "footprints-saved", "save-footprint", "tracks-browse-hubs",
                                   "relative-coords"],
               "try_it": ["footprint_selected"], "panel": "footprint-analysis"})

    _c(id="vg_goal_how_open", category="teach_goal",
       command="how open is the chromatin at this enhancer",
       phrasings=["is this enhancer accessible on most fibers", "degree of openness here"],
       reference=plan("Check accessibility",
                      ex("reads-track", "Open DNA shows as gaps between footprints."),
                      tr("scan-peaks-button", "Click Scan to mark open positions.", "peaks_scanned", skip_if="has_peaks"),
                      ex("peaks-track", "A tall peak means open on many molecules.")),
       expect={"anchor_alts": [["peaks-track", "scan-peaks-button", "reads-track", "read-stats-summary"]],
               "allowed_anchors": ["layer-toggles", "peak-detection-settings", "read-stats-summary",
                                   "reads-toolbar", "peaks-toolbar"]})

    _c(id="vg_goal_histones", category="teach_goal",
       command="can I see where histones are positioned",
       phrasings=["histone positions on the reads", "show nucleosome occupancy"],
       reference=plan("See nucleosomes",
                      ex("layer-toggles", "Turn on the nucleosome layer: ~147 bp footprints."),
                      ex("reads-track", "Stripes lining up across molecules are positioned nucleosomes.")),
       expect={"anchor_alts": [["layer-toggles", "reads-track", "tracks-add-metaprofile", "labeling-rules"]],
               "allowed_anchors": ["layers-controls-expand", "add-label-rule", "row-height"]})

    _c(id="vg_goal_same_fibers", category="teach_goal",
       command="do the two elements tend to be accessible on the same fibers?",
       phrasings=["are both elements open together per molecule", "joint accessibility of two elements"],
       reference=plan("Co-accessibility",
                      op("co-accessibility"),
                      ex("coacc-matrix", "How often two positions are open on the same molecule."),
                      ex("coacc-refresh", "Refresh after you move.")),
       expect={"anchor_alts": [["coacc-matrix"]], "panel": "co-accessibility",
               "allowed_anchors": ["coacc-refresh", "search-bar", "zoom-in", "zoom-out"]})

    _c(id="vg_goal_configurations", category="teach_goal",
       command="are there multiple chromatin configurations among these molecules?",
       phrasings=["do reads split into distinct patterns", "several kinds of molecule here?"],
       reference=plan("Cluster the molecules",
                      ex("cluster-controls-expand", "Show the cluster controls."),
                      tr("peaks-track", "Select a peak.", "peak_selected", skip_if="has_selected_peak"),
                      tr("cluster-button", "Click Cluster.", "clustered"),
                      ex("clusters-overview", "Each cluster is one configuration.", requires="has_clusters")),
       expect={"key_anchors": ["cluster-button"], "try_it": ["clustered"], "allowed_anchors": CLUSTER_ANCHORS})

    _c(id="vg_goal_pause", category="teach_goal",
       command="how much polymerase is stuck in the promoter-proximal pause?",
       phrasings=["fraction of paused Pol II", "promoter-proximal pausing here"],
       reference=plan("Pol II states",
                      ex(None, "Select the gene by clicking it on the gene track."),
                      op("transcription-state", "distribution"),
                      ex("transcription-distribution", "Share of reads in each Pol II state.",
                         requires="has_selected_gene")),
       expect={"anchor_alts": [["transcription-distribution", "transcription-filters"]], "panel": "transcription-state",
               "allowed_anchors": ["search-bar"]})

    _c(id="vg_goal_parental", category="teach_goal",
       command="does the maternal copy look different from the paternal one?",
       phrasings=["parental alleles differ?", "compare the two parental haplotypes here"],
       reference=plan("Compare haplotypes",
                      ex("reference-pairs", "Load both haplotype references here."),
                      op("contact-map", "compare"),
                      tr("haplotype-form", "Open the comparison.", "panel_copy_made")),
       expect={"anchor_alts": [["haplotype-compare", "haplotype-form", "reference-pairs"]],
               "allowed_anchors": ["reference-files", "haplotype-compare"]})

    _c(id="vg_goal_touch_3d", category="teach_goal",
       command="does this enhancer physically touch the promoter in 3D?",
       phrasings=["is there a loop between enhancer and promoter", "3D proximity of two elements"],
       reference=plan("Contact map",
                      ex("load-dataset", "Load the .mcool contact map with Load File."),
                      op("contact-map", "map"),
                      ex("contacts-map", "An off-diagonal spot means they touch often.")),
       expect={"anchor_alts": [["contacts-map"]], "panel": "contact-map",
               "allowed_anchors": ["load-dataset", "panel-add-copy", "haplotype-compare"]})

    _c(id="vg_goal_pcr_confirm", category="teach_goal",
       command="I'd like to confirm this peak with a PCR assay",
       phrasings=["qPCR validation of this site", "get oligos to test this region"],
       reference=plan("Primers",
                      tr("peaks-track", "Select the peak.", "peak_selected", skip_if="has_selected_peak"),
                      ex("primers-design-tab", "The Primers panel designs around it.", requires="has_reference"),
                      tr("primers-design-button", "Click Design primers.", "primers_designed")),
       expect={"anchor_alts": [["primers-design-tab", "primers-design-button"]], "try_it": ["primers_designed"],
               "allowed_anchors": ["peaks-track", "primers-order-tab", "genome-selector"],
               "panel": "primer-design"})

    _c(id="vg_goal_grant_image", category="teach_goal",
       command="I need a clean image of this locus for a grant",
       phrasings=["publication quality picture of this view", "save a nice image for slides"],
       reference=plan("Export a figure",
                      ex("layout-menu", "Arrange the panels."),
                      ex("export-figure", "Export as SVG or PDF.")),
       expect={"key_anchors": ["export-figure"],
               "allowed_anchors": ["layout-menu", "labeling-rules", "row-height", "save-session", "panel-full-view"]})

    _c(id="vg_goal_highest_coverage", category="teach_goal",
       command="jump to wherever the coverage is highest",
       phrasings=["go to my deepest region", "where's the densest coverage"],
       reference=plan("Best-covered window",
                      {"type": "go_to_top_locus"},
                      ex("go-to-reads", "Go to reads steps to the next covered window.")),
       expect={"action_types": [["go_to_top_locus", "navigate_region"]], "allowed_anchors": ["go-to-reads", "search-bar"]})

    _c(id="vg_goal_binding_motifs", category="teach_goal",
       command="which binding motifs are in this window?",
       phrasings=["list motif hits in view", "any TF motifs here"],
       reference=plan("Motifs",
                      op("track-browser"),
                      ex("tracks-browse-hubs", "Add a motif collection from Browse hubs.")),
       expect={"anchor_alts": [["tracks-browse-hubs", "footprints-classes"]],
               "allowed_anchors": ["reads-track", "selected-footprint", "genome-selector", "tracks-add-file"]})

    # ── 2. Ambiguous requests ────────────────────────────────────────
    _c(id="vg_amb_compare_stuff", category="teach_ambiguous",
       command="can we compare stuff",
       phrasings=["let's compare", "comparing things?"],
       dataset_count=DS_FIBER_ONLY,
       reference=plan("Which comparison?",
                      ex("reads-track", "Two samples: one panel each."),
                      ex("panel-add-copy", "Two places: a panel copy."),
                      ex("cluster-button", "Groups of molecules: Cluster.")),
       expect={"anchor_alts": [["reads-track", "panel-add-copy", "cluster-button", "haplotype-compare", "layout-menu"]],
               "allowed_anchors": ["reads-track", "panel-add-copy", "cluster-button", "haplotype-compare",
                                   "layout-menu", "load-dataset", "clusters-profiles"]})

    _c(id="vg_amb_how_compare", category="teach_ambiguous",
       command="how do these compare",
       phrasings=["contrast them for me", "any difference between them?"],
       dataset_count=DS_THREE,
       reference=plan("Compare the samples",
                      ex("reads-track", "Each sample has its own panel."),
                      ex("layout-menu", "Layout lines them up."),
                      ex("cluster-button", "Cluster across all panels.")),
       expect={"anchor_alts": [["reads-track", "layout-menu", "cluster-button", "layout-link"]],
               "allowed_anchors": ["panel-add-copy", "loaded-datasets", "scan-peaks-button", "peaks-track",
                                   "layout-panel"]})

    _c(id="vg_amb_distinguish_groups", category="teach_ambiguous",
       command="what distinguishes these groups",
       phrasings=["how are the clusters different", "what sets the groups apart"],
       dataset_count=DS_FIBER_ONLY, raw_state=clustered(V_DM6_2R, DS_FIBER_ONLY),
       reference=plan("Compare clusters",
                      op("cluster-detail", "profiles"),
                      ex("clusters-profiles", "Average profile per cluster.", requires="has_clusters")),
       expect={"anchor_alts": [["clusters-profiles", "clusters-composition", "clusters-vplot", "clusters-projection"]],
               "panel": "cluster-detail", "state_true": ["has_clusters"],
               "allowed_anchors": ["clusters-overview"]})

    _c(id="vg_amb_get_it_out", category="teach_ambiguous",
       command="can I get this out of the browser",
       phrasings=["take this with me", "export options?"],
       reference=plan("Export options",
                      ex("export-figure", "A picture or its data."),
                      ex("save-session", "The whole session.")),
       expect={"anchor_alts": [["export-figure", "save-session", "primers-order-tab", "capture-export"]],
               "allowed_anchors": ["export-figure", "save-session", "primers-order-tab", "capture-export",
                                   "session-settings", "read-stats-table"]})

    _c(id="vg_amb_filter_stuff", category="teach_ambiguous",
       command="filter stuff out",
       phrasings=["remove some reads", "weed out molecules"],
       reference=plan("Which filter?",
                      ex("quality-filters", "Low-confidence calls."),
                      ex("filter-rules", "Reads by content.")),
       expect={"anchor_alts": [["quality-filters", "filter-rules", "annotations-filter", "filter-button", "quality-cutoffs"]],
               "allowed_anchors": ["quality-filters", "filter-rules", "annotations-filter", "filter-button",
                                   "quality-cutoffs", "read-filters", "filter-controls-expand", "quality-controls-expand",
                                   "add-filter-rule", "clear-filter"]})

    _c(id="vg_amb_learn_from_peak", category="teach_ambiguous",
       command="what can I learn from this peak",
       phrasings=["use this peak for something", "peak, now what can I do"],
       reference=plan("Cluster at the peak",
                      tr("peaks-track", "Select the peak.", "peak_selected", skip_if="has_selected_peak"),
                      tr("cluster-button", "Click Cluster.", "clustered"),
                      ex("primers-design-tab", "Or design primers around it.")),
       expect={"anchor_alts": [["cluster-button", "peaks-track", "primers-design-tab"]],
               "allowed_anchors": CLUSTER_ANCHORS + ["primers-design-tab", "filter-rules", "peaks-lock"]})

    _c(id="vg_amb_see_more", category="teach_ambiguous",
       command="I want to see more",
       phrasings=["wider please", "give me a bigger picture"],
       context=V_DM6_2L,
       reference=plan("Zoom out", zoom("out", 1),
                      ex("zoom-out", "Zoom out shows more of the region.")),
       expect={"anchor_alts": [["zoom-out", "read-display-mode", "read-window-setting"]],
               "allowed_anchors": ["zoom-out", "read-display-mode", "read-window-setting", "search-bar", "zoom-in"]})

    _c(id="vg_amb_combine_those", category="teach_ambiguous",
       command="combine the similar ones",
       phrasings=["fold these together", "collapse near duplicates"],
       dataset_count=DS_FIBER_ONLY, raw_state=clustered(V_DM6_2R, DS_FIBER_ONLY),
       reference=plan("Merge similar clusters",
                      ex("merge-similar", "Merge similar clusters folds near-duplicates.", requires="has_clusters"),
                      tr("merge-similar", "Click it.", "clusters_merged")),
       expect={"key_anchors": ["merge-similar"], "state_true": ["has_clusters"], "try_it": ["clusters_merged"],
               "allowed_anchors": ["merge-settings", "clusters-projection", "clusters-merge-similar", "clusters-overview",
                                   "cluster-controls-expand"]})

    _c(id="vg_amb_fu_two_locations", category="teach_ambiguous",
       command="two genomic locations",
       phrasings=["different loci please", "two spots in the genome"],
       dataset_count=DS_FIBER_ONLY,
       previous_turns=[turn("compare", "Which comparison do you mean?", ["explain", "explain", "explain", "explain"])],
       reference=plan("Two places side by side",
                      tr("panel-add-copy", "Click + to add a panel copy.", "panel_copy_made", skip_if="has_panel_copy"),
                      ex("panel-link", "Unlink it to move it.", requires="has_panel_copy")),
       expect={"key_anchors": ["panel-add-copy"], "try_it": ["panel_copy_made"],
               "allowed_anchors": ["panel-link", "panel-location-bar"]})

    # ── 3. Orientation ───────────────────────────────────────────────
    _c(id="vg_or_help_empty", category="teach_orientation",
       command="I could use some help",
       phrasings=["assist me please", "not sure how to begin"],
       context=V_EMPTY, dataset_count=DS_NONE, diagnostics=D_EMPTY,
       reference=plan("Getting started",
                      ex("guided-tour", "The Tour shows every tool on a demo."),
                      ex("load-dataset", "Or load your own data.")),
       expect={"anchor_alts": [["guided-tour", "load-dataset", "genome-selector"]],
               "allowed_anchors": ["guided-tour", "load-dataset", "genome-selector", "load-by-path", "sidebar-reference"]})

    _c(id="vg_or_how_works", category="teach_orientation",
       command="hey, how does this work?",
       phrasings=["how do I use this thing", "explain how this browser works"],
       reference=plan("Orientation",
                      ex("reads-track", "Each row is one molecule."),
                      ex("guided-tour", "The Tour walks through everything.")),
       expect={"anchor_alts": [["reads-track", "guided-tour", "analysis-strip"]],
               "allowed_anchors": ["peaks-toolbar", "cluster-toolbar", "search-bar", "scan-peaks-button",
                                   "cluster-button", "layer-toggles", "sidebar-toggle", "peaks-track", "analysis-strip"]})

    _c(id="vg_or_step_one", category="teach_orientation",
       command="never done this, what's step one?",
       phrasings=["first thing I should do", "how should I begin here"],
       reference=plan("First steps",
                      ex("search-bar", "Go to a locus."),
                      ex("scan-peaks-button", "Scan for peaks."),
                      ex("guided-tour", "Or take the Tour.")),
       expect={"anchor_alts": [["search-bar", "guided-tour", "scan-peaks-button", "reads-track"]],
               "allowed_anchors": ["cluster-button", "go-to-reads", "peaks-track", "load-dataset"]})

    _c(id="vg_or_block_colours", category="teach_orientation",
       command="why are the blocks coloured differently?",
       phrasings=["meaning of the block colours", "what's with all the colours on the reads"],
       reference=plan("Colours",
                      ex("layer-toggles", "Each layer has its own colour."),
                      ex("labeling-rules", "Labeling rules recolour by size or region.")),
       expect={"anchor_alts": [["layer-toggles", "labeling-rules"]],
               "allowed_anchors": ["loaded-datasets", "reads-track", "layers-controls-expand", "add-label-rule"]})

    _c(id="vg_or_screen_areas", category="teach_orientation",
       command="what are the different areas on the screen?",
       phrasings=["describe the layout of the app", "what's each part of the window"],
       reference=plan("Parts of the screen",
                      ex("search-bar", "Top: search and the toolbar."),
                      ex("reads-track", "Middle: the dataset panels."),
                      ex("analysis-strip", "Bottom: analysis panels.")),
       expect={"anchor_alts": [["reads-track", "sidebar-toggle", "analysis-strip", "search-bar"]],
               "allowed_anchors": ["reads-track", "sidebar-toggle", "analysis-strip", "search-bar", "guided-tour",
                                   "peaks-toolbar", "cluster-toolbar"]})

    _c(id="vg_or_sample_data", category="teach_orientation",
       command="is there sample data to play with?",
       phrasings=["demo file?", "something to practice on"],
       context=V_EMPTY, dataset_count=DS_NONE, diagnostics=D_EMPTY,
       reference=plan("The demo", ex("guided-tour", "The Tour loads a demo dataset.")),
       expect={"key_anchors": ["guided-tour"], "allowed_anchors": ["load-dataset"]})

    # ── 4. Loosely described controls and messy input ───────────────
    _c(id="vg_vague_circular", category="teach_vague_howto",
       command="that circular view",
       phrasings=["the ring shaped map", "the round chromosome picture"],
       reference=plan("Regions",
                      op("circular-genome"),
                      ex("regions-add-view", "Add View saves the current view.")),
       expect={"anchor_alts": [["regions-add-view", "regions-plasmid"]], "panel": "circular-genome"})

    _c(id="vg_vague_colour_by_size", category="teach_vague_howto",
       command="the colour-by-size feature",
       phrasings=["colouring footprints by length", "size based colouring"],
       reference=plan("Labeling rules",
                      op("colormap", "rules"),
                      ex("labeling-rules", "Rules colour footprints by size.")),
       expect={"anchor_alts": [["labeling-rules", "add-label-rule"]], "panel": "colormap"})

    _c(id="vg_vague_square_heat", category="teach_vague_howto",
       command="the square heat thing",
       phrasings=["that grid of colours", "the checkerboard plot"],
       reference=plan("Co-accessibility matrix",
                      op("co-accessibility"),
                      ex("coacc-matrix", "How often pairs of positions are open together.")),
       expect={"anchor_alts": [["coacc-matrix", "contacts-map"]],
               "allowed_anchors": ["coacc-refresh", "contacts-map", "coacc-matrix"]})

    _c(id="vg_vague_header_plus", category="teach_vague_howto",
       command="what's the + in the header for?",
       phrasings=["plus sign on the panel", "that + icon"],
       reference=plan("The + button",
                      ex("panel-add-copy", "+ adds a copy of the panel.")),
       expect={"key_anchors": ["panel-add-copy"], "allowed_anchors": ["panel-link", "panel-location-bar"]})

    _c(id="vg_vague_tiny_marks", category="teach_vague_howto",
       command="what are the tiny marks on the molecules",
       phrasings=["little specks on the reads", "small ticks along each read"],
       reference=plan("Modified bases", ex("layer-toggles", "Those are modified bases; toggle them here.")),
       expect={"key_anchors": ["layer-toggles"], "allowed_anchors": ["row-height", "layers-controls-expand"]})

    _c(id="vg_vague_clsuter", category="teach_vague_howto",
       command="clsuter reads??",
       phrasings=["clustring", "grp the reads"],
       reference=plan("Clustering",
                      tr("peaks-track", "Select a peak.", "peak_selected", skip_if="has_selected_peak"),
                      tr("cluster-button", "Click Cluster.", "clustered")),
       expect={"key_anchors": ["cluster-button"], "try_it": ["clustered"], "allowed_anchors": CLUSTER_ANCHORS})

    _c(id="vg_vague_genome_gone", category="teach_vague_howto",
       command="genome list gone?",
       phrasings=["where did the genome picker go", "genome menu??"],
       reference=plan("The genome list",
                      sidebar("genome", "genome.online"),
                      ex("genome-selector", "It's in Reference & Tracks.")),
       expect={"key_anchors": ["genome-selector"],
               "allowed_anchors": ["sidebar-reference", "load-fasta", "reference-files", "sidebar-toggle"]})
