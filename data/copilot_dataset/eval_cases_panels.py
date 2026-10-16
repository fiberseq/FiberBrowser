"""Held-out eval cases for the analysis panels in depth (records_teach_panels.py).

Same case schema as eval_suite.py (see its docstring for the ``expect`` keys);
registered there with one line. Phrasings are fresh: the dry run checks none of
them is a training command or phrasing.
"""
from __future__ import annotations

from typing import Optional

from data.copilot_dataset.records_teach_workflows import (
    DS_FIBER_DAF, DS_THREE, V_DM6_2R, V_DM6_HB, ex, nav, op, raw, region, tr,
)

V_EVE_TIGHT = {"chrom": "2R", "start": 9_973_000, "end": 9_979_000, "currentGenome": "dm6"}
V_PLASMID = {"chrom": "pUC19", "start": 0, "end": 2_686, "currentGenome": "dm6"}
V_ELSEWHERE = {"chrom": "4", "start": 500_000, "end": 510_000, "currentGenome": "dm6"}

CASES: list[dict] = []


def plan(summary: str, *actions: dict) -> dict:
    return {"summary": summary, "actions": list(actions), "warnings": []}


def _c(*, id: str, category: str, command: str, reference: dict, expect: dict,
       context: dict = V_DM6_2R, dataset_count: int = DS_FIBER_DAF,
       diagnostics: Optional[list] = None, raw_state: Optional[dict] = None,
       phrasings: Optional[list[str]] = None, previous_turns: Optional[list] = None,
       state_overrides: Optional[dict] = None, tags: Optional[list[str]] = None) -> None:
    case = {
        "id": id,
        "category": category,
        "command": command,
        "phrasings": list(phrasings or []),
        "context": context,
        "dataset_count": dataset_count,
        "diagnostics": list(diagnostics or []),
        "raw_state": raw_state if raw_state is not None else raw(context, dataset_count),
        "expect": expect,
        "reference": reference,
        "tags": list(tags or ["panels"]),
        "held_out": True,
    }
    if previous_turns:
        case["previous_turns"] = previous_turns
    if state_overrides:
        case["state_overrides"] = state_overrides
    CASES.append(case)


EVE = {"selected_gene": "eve"}
CLUSTERED = raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,), method="kmeans", k=6)

# ── Peak Detection ───────────────────────────────────────────────────
_c(id="pd_explain_rules", category="teach_panel",
   command="teach me how peak calling is set up here",
   phrasings=["how are peaks defined in this browser", "explain the rules behind the peaks"],
   reference=plan("Peak rules", op("peak-detection"),
                  ex("peak-rule-card", "Each row is a rule with its colour and peak count."),
                  ex("peak-rule-source", "Source is the signal it scans."),
                  ex("peak-rule-cutoffs", "The cutoffs decide what counts as a peak."),
                  tr("scan-peaks-button", "Click Scan to run them.", "peaks_scanned")),
   expect={"key_anchors": ["peak-rule-source", "peak-rule-cutoffs"],
           "allowed_anchors": ["peak-rule-card", "peak-rule-signal", "scan-peaks-button", "peak-add-rule", "peak-rules"],
           "panel": "peak-detection"})

_c(id="pd_more_peaks", category="teach_options",
   command="the peak caller misses weak sites, can I relax it",
   phrasings=["call more peaks please", "my weaker elements aren't picked up as peaks"],
   reference=plan("Relax the peak cutoffs", op("peak-detection"),
                  ex("peak-rule-cutoffs", "Lower the cutoffs, or Fill from percentile."),
                  tr("scan-peaks-button", "Click Scan to re-call.", "peaks_scanned")),
   expect={"key_anchors": ["peak-rule-cutoffs"], "try_it": ["peaks_scanned"],
           "allowed_anchors": ["peak-rule-card", "peak-rule-signal", "scan-peaks-button", "peaks-lock", "peak-rules"]})

_c(id="pd_import_macs", category="teach_options",
   command="I have narrowPeak calls from MACS2, can they show up here",
   phrasings=["bring my ChIP-seq peak file in", "load peaks I called elsewhere as a bed"],
   reference=plan("Import peaks from BED", op("peak-detection"),
                  ex("peak-presets", "Open Presets ▾."),
                  ex("peak-import-bed", "Import Peak BED... loads them as locked peaks.")),
   expect={"key_anchors": ["peak-import-bed"], "allowed_anchors": ["peak-presets", "peaks-track", "peak-rules"],
           "no_try_it": False})

# ── Regions ──────────────────────────────────────────────────────────
_c(id="rg_ring", category="teach_options",
   command="can the chromosome be drawn as a ring for my construct",
   phrasings=["plasmid ring view", "turn the map into a circle"],
   context=V_PLASMID,
   reference=plan("Circular map", op("circular-genome"),
                  ex("regions-circular-toggle", "Circular switches the map to a ring."),
                  ex("regions-map", "Click the ring to move there.")),
   expect={"key_anchors": ["regions-circular-toggle"], "allowed_anchors": ["regions-map", "regions-plasmid"],
           "panel": "circular-genome"})

_c(id="rg_three_loci", category="teach_panel",
   command="I want eve and hb open at the same time in separate panels",
   phrasings=["open two saved loci next to each other", "view several saved places at once"],
   reference=plan("Save regions and open them", op("circular-genome"),
                  ex("regions-add-view", "Add View saves this locus."),
                  nav("hb"),
                  ex("regions-add-view", "Add View again."),
                  tr("regions-open-all", "Click Open All.", "panel_copy_made")),
   expect={"key_anchors": ["regions-add-view", "regions-open-all"], "allowed_anchors": ["regions-saved", "regions-map"],
           "try_it": ["panel_copy_made"], "navigate": {"gene": "hb"}})

# ── History ──────────────────────────────────────────────────────────
_c(id="hi_many_steps", category="teach_panel",
   command="I want the state from five changes ago",
   phrasings=["roll back several changes", "get back to an earlier step in my analysis"],
   reference=plan("Jump back in history",
                  ex("history-timeline", "The ▾ next to Redo opens the history."),
                  ex("history-steps", "Click the step you want to restore.")),
   expect={"key_anchors": ["history-steps"], "allowed_anchors": ["history-timeline", "undo", "redo", "history-view-step"],
           "no_try_it": False})

# ── Transcription ────────────────────────────────────────────────────
_c(id="tx_pausing_walk", category="teach_panel",
   command="is Pol II paused at eve in this sample",
   phrasings=["check promoter-proximal pausing at eve", "how much paused polymerase is on eve"],
   context=V_ELSEWHERE,  # eve isn't in view, so the plan must go there
   reference=plan("Pol II states at eve", nav("eve"),
                  tr("gene-track", "Cmd/Ctrl+click eve to open Transcription.", "gene_selected", skip_if="has_selected_gene"),
                  ex("transcription-states", "Pause counts reads with Pol II just inside the gene.", requires="has_selected_gene"),
                  ex("transcription-distribution", "Distribution splits it by cluster.")),
   expect={"key_anchors": ["gene-track", "transcription-states"], "try_it": ["gene_selected"],
           "allowed_anchors": ["transcription-distribution", "transcription-filters", "transcription-cooccur",
                               "transcription-pol2com"],
           "navigate": {"gene": "eve"}})

_c(id="tx_keep_elongating", category="teach_panel",
   command="show me only molecules with elongating polymerase",
   phrasings=["hide reads that aren't elongating", "restrict to reads with Pol II in the body"],
   state_overrides=EVE,
   reference=plan("Filter to elongating reads", op("transcription-state", "filters"),
                  ex("transcription-states", "Tick Elongating.", requires="has_selected_gene"),
                  tr("transcription-apply", "Click Apply.", "filter_applied")),
   expect={"key_anchors": ["transcription-states", "transcription-apply"], "try_it": ["filter_applied"],
           "allowed_anchors": ["transcription-clear", "transcription-thresholds", "transcription-min-pol2",
                               "transcription-filters", "gene-track"], "state_true": ["has_selected_gene"]})

_c(id="tx_min_count", category="teach_options",
   command="require at least three polymerases to call a read elongating",
   phrasings=["raise the elongating Pol II minimum", "elongating needs more than one Pol II"],
   state_overrides=EVE,
   reference=plan("Elongating threshold", op("transcription-state", "filters"),
                  ex("transcription-thresholds", "Open State thresholds.", requires="has_selected_gene"),
                  ex("transcription-min-pol2", "Set Minimum Pol II count to 3.")),
   expect={"key_anchors": ["transcription-min-pol2"], "allowed_anchors": ["transcription-thresholds", "transcription-states",
                                                                        "transcription-apply"],
           "state_true": ["has_selected_gene"]})

_c(id="tx_what_pic", category="teach_what",
   command="what counts as a PIC read",
   phrasings=["definition of the pre-initiation complex state", "how is PIC decided"],
   state_overrides=EVE,
   reference=plan("The PIC state",
                  ex("transcription-states", "PIC is a pre-initiation footprint just upstream of the TSS.", requires="has_selected_gene")),
   expect={"key_anchors": ["transcription-states"], "no_try_it": True,
           "allowed_anchors": ["transcription-min-pol2", "transcription-filters"], "state_true": ["has_selected_gene"]})

# ── Co-accessibility ─────────────────────────────────────────────────
_c(id="ca_enhancer_pair", category="teach_panel",
   command="do these two enhancers open on the same molecules",
   phrasings=["check coordinated accessibility of two elements", "are the two open regions linked on single reads"],
   context=V_EVE_TIGHT,
   reference=plan("Co-accessibility", op("co-accessibility"),
                  ex("coacc-matrix", "Each cell is how often two positions open together."),
                  ex("coacc-normalization", "O/E highlights pairs above chance.")),
   expect={"key_anchors": ["coacc-matrix"], "panel": "co-accessibility",
           "allowed_anchors": ["coacc-normalization", "coacc-metadata", "coacc-settings-toggle", "coacc-track-display",
                               "coacc-signal", "coacc-min-coverage"]})

_c(id="ca_zoomed_out", category="teach_followup",
   command="why won't co-accessibility compute for this whole region",
   phrasings=["co-accessibility is blank at this zoom", "the co-accessibility matrix is missing"],
   context=V_DM6_2R,
   reference=plan("Co-accessibility needs a read-length window",
                  ex("coacc-matrix", "It only works over about a read length."),
                  region("2R", 9_973_000, 9_979_000)),
   expect={"key_anchors": ["coacc-matrix"], "action_types": [["navigate_region", "zoom_view", "navigate_gene"]],
           "allowed_anchors": ["zoom-in", "search-bar", "coacc-metadata"]})

_c(id="ca_nucleosome", category="teach_options",
   command="compare nucleosome positions between sites instead of accessibility",
   phrasings=["co-occupancy of nucleosomes across the locus", "matrix of nucleosome co-occurrence"],
   context=V_EVE_TIGHT,
   reference=plan("Nucleosome signal", op("co-accessibility"),
                  ex("coacc-settings-toggle", "Open Settings."),
                  ex("coacc-signal", "Set Signal to Nucleosome.")),
   expect={"key_anchors": ["coacc-signal"], "allowed_anchors": ["coacc-settings-toggle", "coacc-layer", "coacc-matrix"],
           "panel": "co-accessibility"})

_c(id="ca_grey", category="teach_followup",
   command="the co-accessibility map is mostly grey squares",
   phrasings=["lots of masked cells in the matrix", "grey everywhere in co-accessibility"],
   context=V_EVE_TIGHT,
   reference=plan("Masked cells", op("co-accessibility"),
                  ex("coacc-metadata", "This shows how much is masked."),
                  ex("coacc-min-coverage", "Lower Min coverage to fill more cells.")),
   expect={"key_anchors": ["coacc-min-coverage"], "allowed_anchors": ["coacc-metadata", "coacc-settings-toggle", "coacc-matrix"]})

# ── Annotations ──────────────────────────────────────────────────────
_c(id="an_filter_all", category="teach_panel",
   command="keep molecules that carry both of my annotation types",
   phrasings=["reads with every selected annotation", "filter to reads having all the annotations"],
   reference=plan("Annotation filter", op("annotations", "filter"),
                  ex("annotations-filter-mode", "Choose Has All."),
                  tr("annotations-filter-apply", "Click Apply Filter.", "filter_applied")),
   expect={"key_anchors": ["annotations-filter-mode", "annotations-filter-apply"], "try_it": ["filter_applied"],
           "allowed_anchors": ["annotations-filter", "clear-filter"], "panel": "annotations"})

_c(id="an_cluster_types", category="teach_panel",
   command="group reads by which annotations they have at my peak",
   phrasings=["annotation-based clustering at a peak", "cluster molecules on annotation presence"],
   reference=plan("Cluster by annotation", op("annotations", "cluster"),
                  tr("peaks-track", "Select a peak.", "peak_selected", skip_if="has_selected_peak"),
                  tr("annotations-cluster-button", "Click Cluster.", "clustered")),
   expect={"key_anchors": ["annotations-cluster-button"], "try_it": ["clustered"],
           "allowed_anchors": ["annotations-cluster", "peaks-track", "clusters-overview", "scan-peaks-button"],
           "panel": "annotations"})

_c(id="an_types_toggle", category="teach_options",
   command="hide some annotation types from the reads",
   phrasings=["turn off one annotation overlay", "show fewer annotation types"],
   reference=plan("Annotation types", op("annotations", "types"),
                  ex("annotations-type-list", "Untick the types to hide.")),
   expect={"key_anchors": ["annotations-type-list"], "allowed_anchors": ["annotations-types"], "panel": "annotations"})

# ── Capture ──────────────────────────────────────────────────────────
_c(id="cp_design", category="teach_panel",
   command="I need enrichment target regions around my selected peaks",
   phrasings=["build capture targets from these peaks", "make target regions for hybrid capture"],
   reference=plan("Capture targets", op("capture", "cart"),
                  tr("peaks-track", "Select the peaks.", "peak_selected", skip_if="has_selected_peak"),
                  ex("capture-padding", "Set the padding."),
                  ex("capture-add-bounding", "+ Bounding adds their span."),
                  ex("capture-export-format", "Export from the Export tab.")),
   expect={"key_anchors": ["capture-add-bounding"], "panel": "capture",
           "allowed_anchors": ["capture-target", "capture-padding", "capture-export-format", "capture-download",
                               "peaks-track", "capture-regions-tab", "capture-add-region"],
           "gating": [{"cond": ["has_selected_peak"], "kind": "any"}]})

_c(id="cp_download", category="teach_options",
   command="get my capture list as a Twist file",
   phrasings=["download capture regions for ordering probes", "save the capture design for the vendor"],
   reference=plan("Export capture", op("capture", "export"),
                  ex("capture-export-format", "Pick Twist TSV."),
                  ex("capture-download", "Click Download.")),
   expect={"key_anchors": ["capture-export-format", "capture-download"], "panel": "capture",
           "allowed_anchors": ["capture-regions-tab"]})

# ── Read Stats ───────────────────────────────────────────────────────
_c(id="rs_measure", category="teach_panel",
   command="measure the accessibility of a handful of molecules",
   phrasings=["numbers for a few reads I pick", "how open are the reads I choose"],
   reference=plan("Read Stats",
                  tr("reads-track", "Shift+click the reads.", "reads_selected", skip_if="has_selected_reads"),
                  ex("read-stats-summary", "Summary gives their accessibility.", requires="has_selected_reads")),
   expect={"key_anchors": ["reads-track", "read-stats-summary"], "try_it": ["reads_selected"],
           "allowed_anchors": ["read-stats-table", "read-stats-distributions"]})

_c(id="rs_cluster", category="teach_options",
   command="summary numbers for all reads of the focused cluster",
   phrasings=["read stats for the whole cluster", "statistics of one cluster's molecules"],
   raw_state=CLUSTERED,
   reference=plan("Read Stats for a cluster",
                  ex("cluster-focus-bar", "Focus the cluster.", requires="has_clusters"),
                  op("read-stats"),
                  ex("read-stats-select-cluster", "Select cluster reads picks them."),
                  ex("read-stats-summary", "Summary describes them.", requires="has_selected_reads")),
   expect={"key_anchors": ["read-stats-select-cluster"], "state_true": ["has_clusters"],
           "allowed_anchors": ["cluster-focus-bar", "read-stats-summary", "read-stats-distributions", "clusters-overview"]})

# ── Contact map ──────────────────────────────────────────────────────
_c(id="cm_overlay", category="teach_panel",
   command="draw the Micro-C contacts as arcs under my reads",
   phrasings=["contact arcs on the read track", "overlay loops under the molecules"],
   reference=plan("Contact arcs", op("contact-map", "settings"),
                  ex("contacts-track-overlay", "Pick Arcs."),
                  ex("contacts-arcs-settings", "Set their minimum distance and strength.")),
   expect={"key_anchors": ["contacts-track-overlay"], "panel": "contact-map",
           "allowed_anchors": ["contacts-arcs-settings", "contacts-settings", "contacts-matrix-settings",
                               "contacts-v4c-settings"]})

_c(id="cm_reads_of_contact", category="teach_panel",
   command="which molecules support that contact",
   phrasings=["the reads that link the two ends of a contact", "open the molecules behind a loop"],
   reference=plan("Reads behind a contact", op("contact-map", "map"),
                  ex("contacts-map", "Drag a rectangle around the contact."),
                  ex("contacts-open-regions", "Open Regions opens both ends.")),
   expect={"key_anchors": ["contacts-open-regions"], "allowed_anchors": ["contacts-map"], "panel": "contact-map"})

_c(id="cm_two_genes", category="teach_panel",
   command="put eve and hb next to each other as a linked pair",
   phrasings=["split the screen between two genes", "compare loci X and Y side by side"],
   reference=plan("Two loci", op("contact-map", "map"),
                  ex("contacts-locus-inputs", "Type eve and hb as Locus X and Y."),
                  tr("contacts-create-split", "Click Create Split View.", "panel_copy_made")),
   expect={"key_anchors": ["contacts-locus-inputs", "contacts-create-split"],
           "allowed_anchors": ["contacts-split-current", "contacts-map"], "panel": "contact-map"})

# ── Layout ───────────────────────────────────────────────────────────
_c(id="ly_pool", category="teach_panel",
   command="pool two of my samples into a single panel",
   phrasings=["combine datasets into one track", "merge the two fiber-seq samples"],
   dataset_count=DS_THREE,
   reference=plan("Merge datasets", op("dataset-layout"),
                  ex("layout-select-panel", "Tick both panels."),
                  ex("layout-merge", "Click Merge.")),
   expect={"key_anchors": ["layout-merge"], "allowed_anchors": ["layout-select-panel", "layout-tree", "layout-unmerge",
                                                               "layout-panel"],
           "panel": "dataset-layout"})

_c(id="ly_save", category="teach_options",
   command="remember this dataset arrangement for next time",
   phrasings=["store my current panel setup", "keep this layout as a preset"],
   dataset_count=DS_THREE,
   reference=plan("Save an arrangement", op("dataset-layout"),
                  ex("layout-save-arrangement", "Name it and click Save."),
                  ex("layout-saved-arrangements", "Reload it from Saved Arrangements.")),
   expect={"key_anchors": ["layout-save-arrangement"], "allowed_anchors": ["layout-saved-arrangements", "layout-panel"],
           "panel": "dataset-layout"})

# ── Labeling ─────────────────────────────────────────────────────────
_c(id="lb_small_red", category="teach_panel",
   command="make every footprint under 60 bp show up in red",
   phrasings=["paint the small footprints red", "a red colour for TF-sized calls"],
   reference=plan("Size colour rule", op("colormap", "rules"),
                  ex("add-label-rule", "Click + Rule."),
                  ex("labeling-size-range", "Set 0–60 bp."),
                  ex("labeling-rule-color", "Pick red.")),
   expect={"key_anchors": ["labeling-size-range", "labeling-rule-color"], "panel": "colormap",
           "allowed_anchors": ["add-label-rule", "labeling-rule-row", "labeling-rule-edit", "labeling-rules"]})

_c(id="lb_confident", category="teach_options",
   command="colour just the high confidence calls",
   phrasings=["apply colours only to confident footprints", "quality threshold for a colour rule"],
   reference=plan("Quality gate", op("colormap", "rules"),
                  ex("labeling-rule-edit", "Open the rule."),
                  ex("labeling-add-gate", "+ Add quality gate.")),
   expect={"key_anchors": ["labeling-add-gate"], "panel": "colormap",
           "allowed_anchors": ["labeling-rule-edit", "labeling-rule-row", "labeling-quality", "labeling-rules"]})

# ── Clusters / Footprints / Tracks depth ─────────────────────────────
_c(id="cl_vplot_read", category="teach_read",
   command="what should I look for in the v-plot",
   phrasings=["interpreting the size versus position plot", "reading footprint size positions per cluster"],
   raw_state=CLUSTERED,
   reference=plan("Reading the V-plot", op("cluster-detail", "vplot"),
                  ex("clusters-vplot", "Nucleosomes form a ~147 bp band; TFs sit low.", requires="has_clusters")),
   expect={"key_anchors": ["clusters-vplot"], "state_true": ["has_clusters"], "no_try_it": True,
           "allowed_anchors": ["clusters-vplot-settings"]})

_c(id="cl_separation", category="teach_read",
   command="are my clusters actually different from each other",
   phrasings=["check cluster separation visually", "do the clusters overlap"],
   raw_state=CLUSTERED,
   reference=plan("Projection", op("cluster-detail", "projection"),
                  ex("clusters-projection", "Projection places reads by their features.", requires="has_clusters"),
                  ex("clusters-projection-controls", "Try UMAP or PCA.")),
   expect={"key_anchors": ["clusters-projection"], "state_true": ["has_clusters"],
           "allowed_anchors": ["clusters-projection-controls", "clusters-merge-preview", "clusters-profiles"]})

_c(id="fp_find_classes", category="teach_panel",
   command="what footprint states recur across molecules in this window",
   phrasings=["discover the recurring footprint types here", "call footprint classes for this view"],
   reference=plan("Footprint classes", op("footprint-analysis", "states"),
                  ex("footprints-consensus", "Footprint classes finds recurring states."),
                  ex("consensus-caller", "Click Find footprint classes."),
                  ex("footprints-class-list", "The classes are listed here.")),
   expect={"key_anchors": ["consensus-caller"], "panel": "footprint-analysis",
           "allowed_anchors": ["footprints-consensus", "footprints-class-list", "footprints-assay", "footprints-stringency",
                               "footprints-classes"]})

_c(id="tk_jaspar", category="teach_panel",
   command="add the GAF motif from JASPAR",
   phrasings=["show GAGA factor motif hits", "look up a TF motif and add it"],
   reference=plan("Add a JASPAR motif", op("track-browser"),
                  ex("tracks-motif-search", "Type the motif name."),
                  tr("tracks-motif-search", "Pick it from the list.", "track_added")),
   expect={"key_anchors": ["tracks-motif-search"], "try_it": ["track_added"], "panel": "track-browser",
           "allowed_anchors": ["tracks-motif-options", "open-tracks", "tracks-row", "tracks-add-file"]})

_c(id="tk_threshold", category="teach_options",
   command="motif hits are everywhere, tighten them up",
   phrasings=["stricter motif matching", "reduce spurious motif matches"],
   reference=plan("Motif threshold", op("track-browser"),
                  ex("tracks-motif-options", "Raise Match threshold.")),
   expect={"key_anchors": ["tracks-motif-options"], "allowed_anchors": ["tracks-row", "tracks-motif-search"],
           "panel": "track-browser"})

_c(id="gn_select_hb", category="teach_where",
   command="how do I pick hb as my gene",
   phrasings=["select hunchback in the gene track", "choose hb for analysis"],
   context=V_DM6_HB,
   reference=plan("Select a gene",
                  ex("gene-track", "Click hb in the gene track."),
                  tr("gene-track", "Click it.", "gene_selected", skip_if="has_selected_gene")),
   expect={"key_anchors": ["gene-track"], "try_it": ["gene_selected"], "allowed_anchors": ["search-bar"]})
