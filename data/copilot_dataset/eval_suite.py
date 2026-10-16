"""Held-out evaluation suite for the teach-only Copilot.

Copilot is a tutor: it navigates and opens panels, tabs and sidebar sections,
points at controls (named UI anchors), hands the user a turn with ``try_it``
steps, gates steps on state (``skip_if`` / ``requires``), and diagnoses "I'm
stuck" questions from the browser's diagnostics and raw state. It never runs an
operation. This suite scores that behaviour.

Each case carries the same inputs a live request sends: the viewport context,
the loaded datasets (``dataset_count``), ``diagnostics`` and ``raw_state``
(utils/copilotDiagnostics.ts) and, for follow-ups, ``previous_turns``. The
expectations live in ``expect``; each case also carries a hand-written
``reference`` plan that must score 100% (``--dry-run`` proves the scorer).

``expect`` keys (all optional; a case is scored only on the axes it sets):

  key_anchors      ordered anchors that must all appear, in this order
  anchor_alts      list of alternative groups; at least one anchor of each group must appear
  allowed_anchors  further anchors that are fine to use (anchor precision is measured
                   against key_anchors + anchor_alts + allowed_anchors)
  try_it           milestones (or alternative lists) that must each be a try_it's wait_for
  no_try_it        True: the plan must not hand the user a turn (nothing to do)
  gating           [{"cond": [...alternatives], "kind": "skip_if" | "requires" | "any"}]
  state_true       conditions that already hold (satisfy anchors' [needs X])
  diagnosis_fix    anchors the first pointing step must target; "navigate" also accepts
                   a first navigation/zoom step (troubleshooting)
  forbidden_anchors anchors that would mean inventing a problem
  navigate         {"gene": "hb"} or {"chrom", "start", "end"}: a navigation step must go there
  panel            an analysis panel type the walk must show (open_panel, a step's
                   panel_type, or an anchor revealed inside that panel)
  action_types     alternative groups of action types that must appear
  only_types       every action must be one of these types
  steps            (min, max) action count; default (1, 12)

Axes (scripts/eval_copilot_suite.py): validity, no_operations (hard), anchors
(recall + order + precision), try_it, gating (incl. [needs X]), diagnosis,
navigation, panel (tutorial intent), brevity. Coverage = canonical phrasing;
robustness = all phrasings.
"""
from __future__ import annotations

from typing import Any, Optional

from data.copilot_dataset.records_teach_troubleshooting import (
    L1,
    L2,
    L3,
    _panel,
    _raw,
    at_other_locus,
    branch_empty,
    chrom_missing,
    fetch_failed,
    filter_active,
    filter_none,
    focus_hides,
    layers_hidden,
    no_datasets,
    no_gtf,
    no_reads,
    no_reference,
    panel_collapsed,
    quality_all,
    quality_most,
    row_collapsed,
    spanning_few,
    spanning_none,
    still_loading,
    strand_empty,
    zoomed_out,
)
from data.copilot_dataset.records_teach_workflows import (
    D_EMPTY,
    D_NO_REFERENCE,
    DS_FIBER_DAF,
    DS_FIBER_ONLY,
    DS_NONE,
    DS_THREE,
    V_DM6_2L,
    V_DM6_2R,
    V_DM6_3R,
    V_DM6_HB,
    V_DM6_X,
    V_EMPTY,
    V_HG38_MYC,
    V_HG38_TP53,
    V_MM10_PAX6,
    raw,
)

# Diagnostic codes the browser can send (utils/copilotDiagnostics.ts).
DIAGNOSTIC_CODES = (
    "no_datasets", "no_reference", "no_gtf", "layers_hidden", "panel_collapsed", "row_collapsed",
    "panel_at_other_locus", "zoomed_out_past_reads", "chrom_missing_in_dataset", "fetch_failed",
    "still_loading", "filter_matches_none", "filter_active", "focus_hides_all", "branch_scope_empty",
    "strand_panel_empty", "no_reads_in_region", "spanning_only_hides", "quality_filter_hides_all",
)

V_WIDE_2R = {"chrom": "2R", "start": 9_500_000, "end": 10_500_000, "currentGenome": "dm6"}
V_CHR4 = {"chrom": "4", "start": 500_000, "end": 510_000, "currentGenome": "dm6"}
# Away from Pax6, so asking for it needs a navigation step.
V_MM10_ELSEWHERE = {"chrom": "chr11", "start": 98_000_000, "end": 98_050_000, "currentGenome": "mm10"}


# ─────────────────────────────────────────────────────────────────────
# Step builders (reference plans)
# ─────────────────────────────────────────────────────────────────────

def ex(anchor: Optional[str], text: str, **kw) -> dict:
    step: dict[str, Any] = {"type": "explain", "text": text}
    if anchor:
        step["anchor"] = anchor
    step.update(kw)
    return step


def tr(anchor: str, text: str, wait_for: str, **kw) -> dict:
    step = {"type": "try_it", "text": text, "anchor": anchor, "wait_for": wait_for}
    step.update(kw)
    return step


def op(panel: str, tab: Optional[str] = None) -> dict:
    step = {"type": "open_panel", "panel_type": panel}
    if tab:
        step["tab"] = tab
    return step


def nav(gene: str, padding_bp: int = 5000) -> dict:
    return {"type": "navigate_gene", "gene": gene, "padding_bp": padding_bp}


def region(chrom: str, start: int, end: int) -> dict:
    return {"type": "navigate_region", "chrom": chrom, "start": start, "end": end}


def zoom(direction: str, steps: int = 1) -> dict:
    return {"type": "zoom_view", "direction": direction, "steps": steps}


def sidebar(section: str, subsection: Optional[str] = None) -> dict:
    step = {"type": "open_sidebar", "section": section}
    if subsection:
        step["subsection"] = subsection
    return step


def plan(summary: str, *actions: dict) -> dict:
    return {"summary": summary, "actions": list(actions), "warnings": []}


def turn(text: str, summary: str, types: list[str]) -> dict:
    return {"text": text, "summary": summary, "actions": [{"type": t} for t in types]}


# ─────────────────────────────────────────────────────────────────────
# Case constructor
# ─────────────────────────────────────────────────────────────────────

EVAL_CASES: list[dict] = []


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
        "tags": list(tags or []),
        "held_out": True,
    }
    if previous_turns:
        case["previous_turns"] = previous_turns
    if state_overrides:
        case["state_overrides"] = state_overrides
    EVAL_CASES.append(case)


# Shared step wordings
CLUSTER_WALK = [
    ex("cluster-toolbar", "Clustering is the Cluster group on the toolbar."),
    ex("cluster-controls-expand", "Click the Cluster label to show all of its controls."),
    ex("cluster-method", "Pick a method here; K-means is a good default."),
    ex("cluster-k", "K is how many clusters you get; start a little high."),
]


def peaks_then_cluster() -> list[dict]:
    return [
        tr("scan-peaks-button", "Click Scan to find peaks here.", "peaks_scanned", skip_if="has_peaks"),
        tr("peaks-track", "Click a peak to select it (Cmd/Ctrl+click adds more).", "peak_selected",
           skip_if="has_selected_peak"),
        tr("cluster-button", "Now click Cluster.", "clustered"),
    ]


PEAK_GATE = {"cond": ["has_peaks", "has_selected_peak"], "kind": "skip_if"}


# ═════════════════════════════════════════════════════════════════════
# 1. The 15 core how-to workflows (with state variants)
# ═════════════════════════════════════════════════════════════════════

# ── change genome ────────────────────────────────────────────────────
_c(id="wf_genome_switch", category="teach_workflow",
   command="how can I switch to another genome build?",
   phrasings=["I need hg38 instead of dm6, where do I change that", "change the reference assembly",
              "how do I pick a different organism's genome"],
   reference=plan("Switch genomes from the Reference & Tracks sidebar",
                  sidebar("genome", "genome.online"),
                  ex("genome-selector", "Pick a genome from this list; its sequence and genes load together."),
                  tr("genome-selector", "Choose the genome you want.", "genome_loaded"),
                  ex("load-fasta", "For a genome that isn't listed, load your own FASTA here instead.")),
   expect={"key_anchors": ["genome-selector"], "allowed_anchors": ["load-fasta", "load-gtf", "reference-files",
                                                                   "sidebar-reference", "reference-pairs"],
           "try_it": ["genome_loaded"]})

_c(id="wf_genome_custom_fasta", category="teach_workflow",
   command="I have my own FASTA and GTF for a lab strain, how do I use them",
   phrasings=["can I load a custom reference plus annotation", "use my own fasta file as the genome"],
   reference=plan("Load your own FASTA and GTF",
                  sidebar("genome", "genome.reference"),
                  ex("reference-files", "Reference Files holds your own sequence and gene files."),
                  tr("load-fasta", "Load your FASTA here.", "genome_loaded"),
                  ex("load-gtf", "Then load the GTF so genes can be searched and drawn.")),
   expect={"key_anchors": ["load-fasta", "load-gtf"],
           "allowed_anchors": ["reference-files", "sidebar-reference", "reference-pairs", "genome-selector"],
           "try_it": ["genome_loaded"]})

_c(id="wf_genome_no_reference", category="teach_workflow",
   command="there's no sequence track, how do I get one",
   phrasings=["how do I show the DNA bases", "where is the sequence"],
   diagnostics=[no_reference(nothing=False)],
   reference=plan("Load a reference so the sequence shows",
                  ex("genome-selector", "The sequence comes from the reference genome, and none is loaded yet."),
                  tr("genome-selector", "Pick your genome from the list.", "genome_loaded"),
                  ex("load-fasta", "Or load your own FASTA here.")),
   expect={"anchor_alts": [["genome-selector", "load-fasta", "reference-files"]],
           "allowed_anchors": ["sidebar-reference", "load-gtf", "reference-pairs"],
           "try_it": ["genome_loaded"], "diagnosis_fix": ["genome-selector", "load-fasta", "reference-files",
                                                          "sidebar-reference"]})

# ── load data ────────────────────────────────────────────────────────
_c(id="wf_load_empty", category="teach_workflow",
   command="how do I open my fiber-seq bam?",
   phrasings=["how do I get my data in", "I want to look at my BAM file", "load my reads"],
   context=V_EMPTY, dataset_count=DS_NONE, diagnostics=D_EMPTY,
   reference=plan("Load a dataset",
                  ex("load-dataset", "Load File opens a BAM or BigBed; keep its index next to it."),
                  tr("load-dataset", "Click Load File and pick your file.", "dataset_loaded"),
                  ex("load-by-path", "On a server, paste the file's path here instead.")),
   expect={"key_anchors": ["load-dataset"], "allowed_anchors": ["load-by-path", "load-remote-url", "sidebar-data",
                                                                "loaded-datasets", "genome-selector"],
           "try_it": ["dataset_loaded"]})

_c(id="wf_load_remote", category="teach_workflow",
   command="can I open a BigBed that sits on a web server?",
   phrasings=["load a dataset from a URL", "open an S3 file"],
   reference=plan("Load a remote file",
                  sidebar("file", "file.remote"),
                  ex("load-remote-url", "Paste an https:// or s3:// link to a BAM or BigBed here."),
                  tr("load-remote-url", "Paste the URL and load it.", "dataset_loaded")),
   expect={"key_anchors": ["load-remote-url"], "allowed_anchors": ["sidebar-data", "load-by-path", "load-dataset",
                                                                   "loaded-datasets"],
           "try_it": ["dataset_loaded"]})

# ── navigate ─────────────────────────────────────────────────────────
_c(id="wf_nav_search", category="teach_workflow",
   command="what's the quickest way to reach a gene by name?",
   phrasings=["how do I get to a specific locus", "how do I type coordinates in"],
   reference=plan("Search for a gene or coordinates",
                  ex("search-bar", "Type a gene name or coordinates like 2R:9,970,000-9,980,000 here."),
                  tr("search-bar", "Try it: type a gene and press Enter.", "navigated"),
                  ex("zoom-out", "Zoom and pan with these buttons, or scroll and drag the tracks.")),
   expect={"key_anchors": ["search-bar"], "allowed_anchors": ["zoom-in", "zoom-out", "pan-left", "pan-right",
                                                              "chrom-selector", "history-timeline",
                                                              "navigation-settings"]})

_c(id="wf_nav_take_me", category="teach_workflow",
   command="take me to twi and show me how zooming works",
   phrasings=["go to twist and explain the zoom buttons", "bring up twi then teach me zooming"],
   context=V_DM6_2L,
   reference=plan("Go to twi, then zooming",
                  nav("twi"),
                  ex("zoom-in", "Zoom in narrows the view; reads draw once it's within the read window."),
                  ex("zoom-out", "Zoom out widens it again."),
                  tr("zoom-out", "Try zooming out once.", "navigated")),
   expect={"navigate": {"gene": "twi"}, "anchor_alts": [["zoom-in", "zoom-out"]],
           "allowed_anchors": ["pan-left", "pan-right", "search-bar", "read-window-setting"]})

# ── cluster ──────────────────────────────────────────────────────────
_c(id="wf_cluster_fresh", category="teach_workflow",
   command="how do I cluster the reads?",
   phrasings=["group the molecules by their footprints", "explain how I'd cluster these molecules",
              "walk me through grouping reads into clusters"],
   reference=plan("Clustering walkthrough",
                  *CLUSTER_WALK, *peaks_then_cluster(),
                  ex("clusters-overview", "Each cluster with its read count; click one to focus it.",
                     requires="has_clusters"),
                  ex("clusters-merge-similar", "Merge similar clusters tidies up a K chosen too high.")),
   expect={"key_anchors": ["cluster-method", "cluster-button"],
           "anchor_alts": [["cluster-controls-expand", "cluster-toolbar"]],
           "allowed_anchors": ["cluster-k", "scan-peaks-button", "peaks-track", "clusters-overview",
                               "clusters-profiles", "clusters-merge-similar", "merge-similar", "cluster-details-button",
                               "cluster-focus-bar", "clusters-projection"],
           "try_it": ["clustered"], "gating": [PEAK_GATE], "panel": "cluster-detail"})

_c(id="wf_cluster_hierarchical", category="teach_workflow",
   command="can I try hierarchical instead of k-means for the clustering?",
   phrasings=["use a different clustering algorithm", "can I cluster with something other than k-means"],
   reference=plan("Change the clustering method",
                  ex("cluster-controls-expand", "Open the Cluster controls."),
                  ex("cluster-method", "Choose Hierarchical here; K still sets the number of clusters."),
                  tr("cluster-button", "Click Cluster to re-run with it.", "clustered")),
   expect={"key_anchors": ["cluster-method"], "allowed_anchors": ["cluster-controls-expand", "cluster-toolbar",
                                                                  "cluster-k", "cluster-button", "clusters-overview"]})

_c(id="wf_cluster_already_new_k", category="teach_workflow",
   command="I already clustered, how do I redo it with fewer clusters",
   phrasings=["re-cluster with a smaller k", "change the number of clusters and run again"],
   raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,), k=8),
   reference=plan("Lower K and re-cluster",
                  ex("cluster-k", "Lower K here; you're at 8 now."),
                  tr("cluster-button", "Click Cluster to re-run.", "clustered"),
                  ex("clusters-overview", "The new clusters show here.", requires="has_clusters")),
   expect={"key_anchors": ["cluster-k", "cluster-button"],
           "allowed_anchors": ["cluster-controls-expand", "cluster-method", "clusters-overview", "merge-similar",
                               "clusters-merge-similar", "cluster-clear"],
           "try_it": ["clustered"], "state_true": ["has_clusters"], "steps": (1, 6)})

# ── merge clusters ───────────────────────────────────────────────────
_c(id="wf_merge_clustered", category="teach_workflow",
   command="how do I combine clusters that look the same",
   phrasings=["merge near-identical clusters", "too many clusters, how do I collapse them"],
   raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,), k=8),
   reference=plan("Merge similar clusters",
                  ex("clusters-merge-similar", "Merge similar clusters folds small and near-identical clusters "
                                               "into their nearest neighbour."),
                  ex("merge-settings", "The ⚙ sets the smallest cluster and the similarity cutoff, with a preview."),
                  tr("clusters-merge-similar", "Click Merge similar clusters.", "clusters_merged"),
                  ex("clusters-projection", "Projection shows the clusters before and after.")),
   expect={"anchor_alts": [["clusters-merge-similar", "merge-similar"]],
           "allowed_anchors": ["merge-settings", "clusters-projection", "clusters-overview", "cluster-controls-expand",
                               "clusters-profiles"],
           "try_it": ["clusters_merged"], "state_true": ["has_clusters"], "panel": "cluster-detail"})

_c(id="wf_merge_not_yet", category="teach_workflow",
   command="how would I merge clusters? I haven't clustered anything yet",
   phrasings=["merge clusters from scratch"],
   reference=plan("Cluster first, then merge",
                  ex("cluster-controls-expand", "Merging needs clusters, so cluster first."),
                  *peaks_then_cluster(),
                  ex("clusters-merge-similar", "Then Merge similar clusters folds near-identical ones together.",
                     requires="has_clusters"),
                  tr("clusters-merge-similar", "Click it when you're ready.", "clusters_merged")),
   expect={"anchor_alts": [["clusters-merge-similar", "merge-similar"]],
           "allowed_anchors": ["cluster-controls-expand", "cluster-toolbar", "cluster-method", "cluster-k",
                               "cluster-button", "scan-peaks-button", "peaks-track", "merge-settings",
                               "clusters-overview"],
           "try_it": ["clustered", "clusters_merged"]})

# ── haplotype / strand ───────────────────────────────────────────────
_c(id="wf_strand_split", category="teach_workflow",
   command="how can I see the CT and GA strands in separate panels",
   phrasings=["split the DAF-seq panel by strand", "look at each deamination strand on its own"],
   reference=plan("Split a DAF-seq panel by strand",
                  ex("strand-chip", "The strand chip picks which strand a DAF-seq panel shows."),
                  tr("split-by-strand", "Choose Split into CT and GA panels.", "strand_split")),
   expect={"anchor_alts": [["strand-chip", "split-by-strand"]], "allowed_anchors": ["strand-chip",
                                                                                     "split-by-strand"],
           "try_it": ["strand_split"]})

_c(id="wf_haplotype", category="teach_workflow",
   command="how do I compare the two haplotypes",
   phrasings=["look at the maternal and paternal copies side by side", "haplotype view please"],
   reference=plan("Compare haplotypes",
                  ex("reference-pairs", "Load each haplotype's FASTA (and annotation) here first."),
                  op("contact-map", "compare"),
                  ex("haplotype-compare", "Compare lines up the same locus on both haplotypes."),
                  tr("haplotype-form", "Pick the two haplotypes and the locus, then open them.",
                     "panel_copy_made")),
   expect={"key_anchors": ["haplotype-form"], "anchor_alts": [["reference-pairs", "haplotype-compare"]],
           "allowed_anchors": ["reference-pairs", "haplotype-compare", "sidebar-reference", "panel-link"],
           "panel": "contact-map"})

# ── panel copy at another locus ──────────────────────────────────────
_c(id="wf_panel_copy", category="teach_workflow",
   command="how can I look at a second locus next to this one",
   phrasings=["open another region beside the current one", "two places at the same time"],
   reference=plan("A copy of the panel at another locus",
                  ex("panel-add-copy", "+ adds a copy of the dataset panel."),
                  tr("panel-add-copy", "Hover the panel header and click +.", "panel_copy_made"),
                  ex("panel-link", "Unlink the copy so it can move on its own.", requires="has_panel_copy"),
                  tr("panel-location-bar", "Type the second locus in the copy's location bar.", "navigated")),
   expect={"key_anchors": ["panel-add-copy"], "anchor_alts": [["panel-link", "panel-location-bar"]],
           "allowed_anchors": ["panel-link", "panel-location-bar"], "try_it": ["panel_copy_made"]})

# ── peaks ────────────────────────────────────────────────────────────
_c(id="wf_peaks_scan", category="teach_workflow",
   command="how are peaks found",
   phrasings=["how do I detect accessible peaks", "what finds the peaks and how do I run it"],
   reference=plan("Scan for peaks",
                  ex("scan-peaks-button", "Scan finds accessible peaks in this view using the peak rules."),
                  tr("scan-peaks-button", "Click Scan.", "peaks_scanned"),
                  ex("peaks-track", "They appear on the Peaks track; click one to select it."),
                  ex("peaks-lock", "Lock keeps them fixed while you move around.")),
   expect={"key_anchors": ["scan-peaks-button"],
           "allowed_anchors": ["peaks-track", "peaks-lock", "peak-rules", "peak-draw", "peaks-controls-expand",
                               "peaks-toolbar", "peak-detection-settings", "peak-detection-rules"],
           "try_it": ["peaks_scanned"]})

_c(id="wf_peak_draw", category="teach_workflow",
   command="can I mark my own peak by hand",
   phrasings=["draw a custom peak", "add a peak where there isn't one"],
   reference=plan("Draw a peak",
                  ex("peaks-controls-expand", "Open the Peaks controls."),
                  ex("peak-draw", "Draw a peak, then drag across the Peaks track to mark it."),
                  tr("peaks-track", "Drag across the region you want.", "peak_selected")),
   expect={"key_anchors": ["peak-draw"], "allowed_anchors": ["peaks-controls-expand", "peaks-track",
                                                             "peaks-toolbar"]})

# ── footprints (Cmd+click) ──────────────────────────────────────────
_c(id="wf_footprint_single", category="teach_workflow",
   command="how do I analyse one footprint",
   phrasings=["what can I learn about a single footprint", "inspect a footprint"],
   reference=plan("Cmd+click a footprint",
                  ex("reads-track", "Footprints are the blocks on each read."),
                  tr("reads-track", "Cmd/Ctrl+click one.", "footprint_selected"),
                  ex("selected-footprint", "Its size range and position are shown here.", requires="has_selected_footprint"),
                  ex("save-footprint", "Save keeps it as a class you can reuse.")),
   expect={"key_anchors": ["reads-track", "selected-footprint"],
           "allowed_anchors": ["save-footprint", "save-footprints", "footprints-classes", "footprints-saved"],
           "try_it": ["footprint_selected"], "panel": "footprint-analysis"})

_c(id="wf_footprint_classes", category="teach_workflow",
   command="how do I find the common footprint types across all reads",
   phrasings=["find footprint classes automatically", "call footprint classes"],
   reference=plan("Find footprint classes",
                  op("footprint-analysis", "states"),
                  ex("footprints-classes", "Classes groups footprints by size and position across reads."),
                  ex("consensus-caller", "Find footprint classes runs the caller on this view; click it.")),
   expect={"anchor_alts": [["footprints-classes", "consensus-caller"]],
           "allowed_anchors": ["footprints-saved", "reads-track"], "panel": "footprint-analysis"})

# ── select reads (Shift+click) ──────────────────────────────────────
_c(id="wf_read_stats", category="teach_workflow",
   command="how do I get stats for a handful of reads",
   phrasings=["compare a few molecules", "per-read statistics"],
   reference=plan("Shift+click reads for Read Stats",
                  tr("reads-track", "Shift+click the reads you want.", "reads_selected"),
                  ex("read-stats-summary", "Summary compares them.", requires="has_selected_reads"),
                  ex("read-stats-table", "Table lists each read.")),
   expect={"key_anchors": ["reads-track"], "anchor_alts": [["read-stats-summary", "read-stats-table"]],
           "try_it": ["reads_selected"], "panel": "read-stats"})

# ── quality filters ──────────────────────────────────────────────────
_c(id="wf_quality", category="teach_workflow",
   command="how do I hide low-quality footprint calls",
   phrasings=["filter out weak footprints", "quality cutoff for calls"],
   reference=plan("Quality cutoffs",
                  ex("quality-filters", "Quality sets per-layer cutoffs on call quality."),
                  ex("quality-controls-expand", "Open it to see the cutoffs."),
                  ex("quality-cutoffs", "Raise a cutoff to drop calls below it.")),
   expect={"key_anchors": ["quality-filters"],
           "allowed_anchors": ["quality-controls-expand", "quality-cutoffs", "labeling-quality", "read-filters"]})

# ── rules ────────────────────────────────────────────────────────────
_c(id="wf_rules_sort", category="teach_workflow",
   command="how do I order reads by how many TF footprints they carry",
   phrasings=["sort molecules by TF count", "put reads with the most TF calls on top"],
   reference=plan("A sort rule",
                  op("cluster-features", "sort"),
                  ex("add-sort-rule", "Add a sort rule counting TF footprints."),
                  tr("sort-button", "Pick the rule under Sort and click it.", "sorted")),
   expect={"anchor_alts": [["add-sort-rule", "rules-sort-tab", "sort-rules"]], "key_anchors": ["sort-button"],
           "allowed_anchors": ["rules-sort-tab", "sort-rules", "sort-controls-expand", "cluster-rules-button"],
           "try_it": ["sorted"]})

_c(id="wf_rules_filter", category="teach_workflow",
   command="how do I show only reads with a footprint at the selected peak",
   phrasings=["keep only molecules occupied at this peak", "filter reads by a footprint"],
   reference=plan("A filter rule",
                  op("cluster-features", "filter"),
                  ex("add-filter-rule", "Add a filter rule: a footprint at the selected peaks."),
                  tr("filter-button", "Choose the rule under Filter and apply it.", "filter_applied"),
                  ex("clear-filter", "Clear shows every read again.")),
   expect={"anchor_alts": [["add-filter-rule", "rules-filter-tab", "filter-rules"]], "key_anchors": ["filter-button"],
           "allowed_anchors": ["rules-filter-tab", "filter-rules", "filter-controls-expand", "clear-filter",
                               "peaks-track", "cluster-rules-button"],
           "try_it": ["filter_applied"]})

# ── tracks ───────────────────────────────────────────────────────────
_c(id="wf_tracks_file", category="teach_workflow",
   command="how do I add a ChIP-seq bigwig",
   phrasings=["overlay my own signal track", "add a bedgraph or bigwig"],
   reference=plan("Add a track file",
                  op("track-browser"),
                  tr("tracks-add-file", "Add your bigWig by file or URL here.", "track_added")),
   expect={"key_anchors": ["tracks-add-file"], "allowed_anchors": ["tracks-browse-hubs", "open-tracks"],
           "try_it": ["track_added"], "panel": "track-browser"})

_c(id="wf_tracks_hubs", category="teach_workflow",
   command="where can I find public tracks like ENCODE",
   phrasings=["browse UCSC tracks", "add a public annotation track"],
   reference=plan("Browse hubs",
                  op("track-browser"),
                  ex("tracks-browse-hubs", "Browse hubs lists UCSC, ENCODE and ChIP-Atlas tracks for this genome."),
                  tr("tracks-browse-hubs", "Pick one to add it.", "track_added")),
   expect={"key_anchors": ["tracks-browse-hubs"], "allowed_anchors": ["tracks-add-file", "open-tracks"],
           "panel": "track-browser"})

# ── primers ──────────────────────────────────────────────────────────
_c(id="wf_primers", category="teach_workflow",
   command="how do I design primers around this peak",
   phrasings=["make PCR primers for a peak", "primer design walkthrough"],
   reference=plan("Design primers",
                  tr("peaks-track", "Select the peak first.", "peak_selected", skip_if="has_selected_peak"),
                  op("primer-design", "design"),
                  tr("primers-design-button", "Click Design primers.", "primers_designed"),
                  ex("primers-order-tab", "Save good pairs to the Order List.")),
   expect={"key_anchors": ["primers-design-button"],
           "allowed_anchors": ["peaks-track", "primers-design-tab", "primers-order-tab", "scan-peaks-button"],
           "try_it": ["primers_designed"], "panel": "primer-design"})

# ── export / save ────────────────────────────────────────────────────
_c(id="wf_save_session", category="teach_workflow",
   command="how do I save my work so I can come back tomorrow",
   phrasings=["save a session", "keep everything for later"],
   reference=plan("Save a session",
                  tr("save-session", "Click Save to download a session file.", "session_saved"),
                  ex("restore-session", "Later, open it here.")),
   expect={"key_anchors": ["save-session"], "allowed_anchors": ["restore-session", "session-settings",
                                                                "sidebar-data"],
           "try_it": ["session_saved"]})

_c(id="wf_export_figure", category="teach_workflow",
   command="how do I make a figure of this view",
   phrasings=["export this as PDF", "save a picture of the tracks"],
   reference=plan("Export a figure",
                  ex("export-figure", "Export saves this view as PNG, PDF or SVG.")),
   expect={"key_anchors": ["export-figure"], "allowed_anchors": ["save-session"], "steps": (1, 4)})

_c(id="wf_other_genome_mouse", category="teach_workflow",
   command="how do I cluster reads at Pax6",
   phrasings=["cluster around Pax6"],
   context=V_MM10_ELSEWHERE,
   reference=plan("Cluster at Pax6",
                  nav("Pax6"),
                  ex("cluster-method", "Pick the method and K here."),
                  *peaks_then_cluster()),
   expect={"navigate": {"gene": "Pax6"}, "key_anchors": ["cluster-button"],
           "allowed_anchors": ["cluster-method", "cluster-k", "cluster-controls-expand", "cluster-toolbar",
                               "scan-peaks-button", "peaks-track", "clusters-overview"],
           "try_it": ["clustered"]})

# ═════════════════════════════════════════════════════════════════════
# 2. Multi-layer chains
# ═════════════════════════════════════════════════════════════════════

_c(id="ch_saved_fp_hb", category="teach_chain",
   command="walk me through saving a footprint class and then reusing it at hb",
   phrasings=["save a footprint here and use it at hunchback", "define a footprint then check it at hb"],
   reference=plan("Save a footprint, reuse it at hb",
                  tr("reads-track", "Cmd/Ctrl+click a footprint.", "footprint_selected",
                     skip_if="has_saved_footprints"),
                  tr("save-footprint", "Adjust its size range, then Save.", "footprint_saved",
                     skip_if="has_saved_footprints"),
                  ex("footprints-saved", "Saved footprints are listed here.", requires="has_saved_footprints"),
                  nav("hb"),
                  ex("footprints-cooccupancy", "Co-occupancy shows which saved footprints sit on the same reads."),
                  tr("footprints-cooccupancy", "Click Cluster reads by these footprints.", "clustered"),
                  ex("clusters-overview", "Each cluster is a combination of your footprints.",
                     requires="has_clusters")),
   expect={"key_anchors": ["reads-track", "save-footprint", "footprints-cooccupancy"],
           "allowed_anchors": ["footprints-saved", "selected-footprint", "clusters-overview", "save-footprints"],
           "try_it": ["footprint_selected", "footprint_saved"], "navigate": {"gene": "hb"},
           "gating": [{"cond": ["has_saved_footprints"], "kind": "any"}], "steps": (5, 14)})

_c(id="ch_cluster_merge_branch", category="teach_chain",
   command="how do I cluster, clean up the clusters, then drill into one of them",
   phrasings=["cluster, merge the duplicates and subcluster one", "full clustering workflow with branches"],
   reference=plan("Cluster, merge, subcluster",
                  ex("cluster-method", "Pick the method and K."),
                  *peaks_then_cluster(),
                  tr("clusters-merge-similar", "Click Merge similar clusters.", "clusters_merged",
                     requires="has_clusters"),
                  tr("clusters-overview", "Click a cluster to focus it.", "cluster_focused"),
                  ex("cluster-branches", "Cluster again now to split just that cluster; the branch map tracks it.")),
   expect={"key_anchors": ["cluster-button", "cluster-branches"],
           "anchor_alts": [["clusters-merge-similar", "merge-similar"]],
           "allowed_anchors": ["cluster-method", "cluster-k", "cluster-controls-expand", "scan-peaks-button",
                               "peaks-track", "clusters-overview", "cluster-focus-bar", "merge-settings"],
           "try_it": ["clustered", "clusters_merged"], "steps": (5, 14)})

_c(id="ch_peak_primers_order", category="teach_chain",
   command="from finding a peak to ordering primers for it, how does that go",
   phrasings=["peaks to primers to the order sheet"],
   reference=plan("Peak → primers → order list",
                  tr("scan-peaks-button", "Click Scan.", "peaks_scanned", skip_if="has_peaks"),
                  tr("peaks-track", "Select a peak.", "peak_selected"),
                  op("primer-design", "design"),
                  tr("primers-design-button", "Click Design primers.", "primers_designed"),
                  ex("primers-order-tab", "Save the pairs you like; the Order List exports them.")),
   expect={"key_anchors": ["peaks-track", "primers-design-button", "primers-order-tab"],
           "allowed_anchors": ["scan-peaks-button", "primers-design-tab"],
           "try_it": ["peak_selected", "primers_designed"], "panel": "primer-design", "steps": (4, 14)})

_c(id="ch_setup_to_cluster", category="teach_chain",
   command="I'm brand new, get me from nothing to clustered reads at eve",
   phrasings=["start to finish: load, find eve, cluster"],
   context=V_EMPTY, dataset_count=DS_NONE, diagnostics=D_EMPTY,
   reference=plan("From empty to clusters at eve",
                  tr("genome-selector", "Pick your genome.", "genome_loaded", skip_if="has_reference"),
                  tr("load-dataset", "Load your BAM or BigBed.", "dataset_loaded"),
                  nav("eve"),
                  ex("cluster-method", "Pick the method and K."),
                  *peaks_then_cluster()),
   expect={"key_anchors": ["load-dataset", "cluster-button"], "navigate": {"gene": "eve"},
           "allowed_anchors": ["genome-selector", "load-fasta", "sidebar-reference", "search-bar", "cluster-method",
                               "cluster-k", "cluster-controls-expand", "scan-peaks-button", "peaks-track",
                               "clusters-overview", "load-by-path"],
           "try_it": ["dataset_loaded", "clustered"], "steps": (5, 14)})

_c(id="ch_two_loci", category="teach_chain",
   command="how do I put eve and ftz side by side and cluster both",
   phrasings=["compare eve with ftz in two panels"],
   reference=plan("Two loci, clustered together",
                  nav("eve"),
                  tr("panel-add-copy", "Click + on the panel header.", "panel_copy_made"),
                  ex("panel-link", "Unlink the copy.", requires="has_panel_copy"),
                  tr("panel-location-bar", "Type ftz in the copy's location bar.", "navigated"),
                  *peaks_then_cluster()),
   expect={"key_anchors": ["panel-add-copy", "cluster-button"],
           "allowed_anchors": ["panel-link", "panel-location-bar", "scan-peaks-button", "peaks-track",
                               "cluster-method", "cluster-k", "clusters-overview"],
           "try_it": ["panel_copy_made", "clustered"], "steps": (4, 14)})

_c(id="ch_rule_then_filter", category="teach_chain",
   command="set up a rule for reads with a TF call at the peak and then filter by it",
   phrasings=["make a filter rule and apply it"],
   reference=plan("Rule, then filter",
                  tr("peaks-track", "Select the peak.", "peak_selected", skip_if="has_selected_peak"),
                  op("cluster-features", "filter"),
                  ex("add-filter-rule", "Add a rule: a TF footprint at the selected peaks."),
                  tr("filter-button", "Choose it under Filter and apply.", "filter_applied"),
                  ex("clear-filter", "Clear shows everything again.")),
   expect={"key_anchors": ["add-filter-rule", "filter-button"],
           "allowed_anchors": ["peaks-track", "rules-filter-tab", "filter-rules", "filter-controls-expand",
                               "clear-filter"],
           "try_it": ["filter_applied"]})

# ═════════════════════════════════════════════════════════════════════
# 3. Where / what
# ═════════════════════════════════════════════════════════════════════

def _where(id: str, command: str, anchors: list[str], text: str, *, phrasings=(), panel: Optional[str] = None,
           raw_state: Optional[dict] = None, state_true=(), open_panel: Optional[tuple] = None,
           category: str = "teach_where", allowed=()) -> None:
    steps = []
    if open_panel:
        steps.append(op(*open_panel))
    steps.append(ex(anchors[0], text))
    exp: dict[str, Any] = {"anchor_alts": [list(anchors)], "allowed_anchors": list(allowed), "steps": (1, 4)}
    if panel:
        exp["panel"] = panel
    if state_true:
        exp["state_true"] = list(state_true)
    _c(id=id, category=category, command=command, phrasings=list(phrasings), raw_state=raw_state,
       reference=plan(text, *steps), expect=exp)


_where("wh_undo", "where's undo", ["undo"], "Undo is here; the ▾ next to it opens the history timeline.",
       phrasings=["revert my last step, where is that", "take back my last change"], allowed=["history-timeline", "redo"])
_where("wh_layers", "where do I turn the nucleosome layer off", ["layer-toggles", "layers-controls-expand"],
       "The layer toggles switch footprints, nucleosomes, TF calls and FIRE on and off.",
       phrasings=["make the nucleosome calls go away", "toggle layers"])
_where("wh_read_window", "where's the setting for how wide reads get drawn", ["read-window-setting"],
       "Show reads up to sets the widest view that still draws individual reads.",
       phrasings=["change the read window"], allowed=["read-display-settings", "sidebar-reads-display"])
_where("wh_spanning", "where's the spanning-only switch", ["spanning-toggle"],
       "Spanning only keeps reads that cross the whole view.", phrasings=["only full-length reads"])
_where("wh_tour", "is there a built-in tour?", ["guided-tour"], "Tour walks through the whole browser.",
       phrasings=["where does the guided walkthrough start"])
_where("wh_restore", "where do I reopen an old session", ["restore-session"],
       "Restore session opens a saved session file.", phrasings=["load my saved session"],
       allowed=["sidebar-data", "session-settings"])
_where("wh_labels", "where do I set the colors for footprint types", ["labeling-rules", "add-label-rule"],
       "Labeling rules colour footprints by size, layer or position.", phrasings=["change the read colours"],
       panel="colormap", open_panel=("colormap", "rules"))
_where("wh_coacc", "where can I see which sites open together", ["coacc-matrix"],
       "The co-accessibility matrix shows which sites open together on the same molecules.",
       phrasings=["co-accessibility heatmap"], panel="co-accessibility", open_panel=("co-accessibility",),
       allowed=["coacc-refresh"])
_where("wt_projection", "what does the projection tab show", ["clusters-projection"],
       "Projection places every read by its footprint pattern, coloured by cluster.",
       phrasings=["explain the projection view"], raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,)),
       state_true=["has_clusters"], panel="cluster-detail", category="teach_what")
_where("wt_k", "what does K mean here", ["cluster-k"], "K is the number of clusters K-means makes.",
       phrasings=["what's the k box"], category="teach_what", allowed=["cluster-controls-expand", "cluster-method"])
_where("wt_lock", "what does locking peaks do", ["peaks-lock"],
       "Lock keeps the current peaks fixed as you move, instead of rescanning.", phrasings=["why lock peaks"],
       category="teach_what", allowed=["peaks-controls-expand", "scan-peaks-button"])
_where("wt_merge_similar", "what does merge similar clusters actually do", ["merge-similar", "clusters-merge-similar"],
       "It folds small clusters and near-identical ones into their nearest neighbour.",
       phrasings=["explain merge similar"], category="teach_what", allowed=["merge-settings", "cluster-controls-expand"])
_where("wt_reverse", "what is the reverse view button", ["reverse-view"],
       "Reverse view flips the display so minus-strand genes read left to right.", phrasings=["flip the view"],
       category="teach_what")
_where("wt_capture", "what is the capture panel for", ["capture-add-region"],
       "Capture collects regions for a targeted-capture design and exports them.",
       phrasings=["what are capture regions used for"], category="teach_what", panel="capture", open_panel=("capture",),
       allowed=["capture-export"])

# ═════════════════════════════════════════════════════════════════════
# 4. Follow-ups (previous_turns)
# ═════════════════════════════════════════════════════════════════════

T_CLUSTER = turn("how do I cluster the reads", "Clustering walkthrough", ["explain", "try_it", "try_it", "try_it"])
T_PEAKS = turn("how are peaks found", "Scan for peaks", ["explain", "try_it", "explain"])
T_MERGE = turn("merge similar clusters", "Merge similar clusters", ["explain", "try_it"])
T_FOOTPRINT = turn("how do I analyse one footprint", "Cmd+click a footprint", ["explain", "try_it", "explain"])
T_COMPOSITION = turn("what does composition show", "Composition tab", ["open_panel", "explain"])

_c(id="fu_clicked_cluster", category="teach_followup", command="ok done, what am I looking at now?",
   phrasings=["I clicked cluster, now what", "clusters are there, explain"],
   previous_turns=[T_CLUSTER], raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0, 1)),
   reference=plan("Reading the clusters",
                  op("cluster-detail", "overview"),
                  ex("clusters-overview", "Each cluster with its read count; click one to focus it."),
                  ex("clusters-profiles", "Profiles overlays each cluster's average footprint profile.")),
   expect={"key_anchors": ["clusters-overview"],
           "allowed_anchors": ["clusters-profiles", "clusters-composition", "clusters-projection", "clusters-vplot",
                               "clusters-merge-similar", "cluster-focus-bar", "merge-similar"],
           "state_true": ["has_clusters"], "panel": "cluster-detail"})

_c(id="fu_peaks_next", category="teach_followup", command="peaks are showing, what next?",
   phrasings=["now what after scanning"], previous_turns=[T_PEAKS],
   reference=plan("Use the peaks",
                  tr("peaks-track", "Click a peak to select it.", "peak_selected"),
                  ex("cluster-method", "Pick a method and K."),
                  tr("cluster-button", "Click Cluster to group reads at that peak.", "clustered")),
   expect={"key_anchors": ["peaks-track"], "allowed_anchors": ["cluster-button", "cluster-method", "cluster-k",
                                                               "primers-design-button", "peaks-lock"],
           "try_it": ["peak_selected"]})

_c(id="fu_undo_merge", category="teach_followup", command="how do I take that back?",
   phrasings=["undo the merge", "revert what I just did"], previous_turns=[T_MERGE],
   raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,)),
   reference=plan("Undo", ex("undo", "Undo reverses the merge; the ▾ timeline jumps further back.")),
   expect={"key_anchors": ["undo"], "allowed_anchors": ["history-timeline", "cluster-snapshot"], "steps": (1, 4)})

_c(id="fu_back_to_clusters", category="teach_followup", command="take me back to the clusters",
   phrasings=["show the clusters again"], previous_turns=[T_FOOTPRINT],
   raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,)),
   reference=plan("Back to the Clusters panel", op("cluster-detail", "overview"),
                  ex("clusters-overview", "Here are your clusters.")),
   expect={"panel": "cluster-detail", "allowed_anchors": ["clusters-overview", "clusters-profiles"],
           "state_true": ["has_clusters"], "steps": (1, 3)})

_c(id="fu_tab_again", category="teach_followup", command="go over that last tab one more time",
   phrasings=["say that again about the composition tab"], previous_turns=[T_COMPOSITION],
   raw_state=raw(V_DM6_2R, DS_FIBER_DAF, clustered=(0,)),
   reference=plan("Composition, again",
                  ex("clusters-composition", "Composition shows each cluster's mix of footprint types.")),
   expect={"key_anchors": ["clusters-composition"], "state_true": ["has_clusters"], "steps": (1, 3)})

_c(id="fu_nothing_happened", category="teach_followup", command="I hit Cluster but the reads didn't change",
   phrasings=["cluster didn't do anything"], previous_turns=[T_CLUSTER],
   reference=plan("Select a peak first",
                  ex("cluster-button", "Cluster groups reads at the selected peaks, and none are selected."),
                  tr("scan-peaks-button", "Click Scan.", "peaks_scanned", skip_if="has_peaks"),
                  tr("peaks-track", "Click a peak to select it.", "peak_selected"),
                  tr("cluster-button", "Now click Cluster.", "clustered")),
   expect={"key_anchors": ["peaks-track"], "allowed_anchors": ["cluster-button", "scan-peaks-button"],
           "try_it": ["peak_selected"]})

# ═════════════════════════════════════════════════════════════════════
# 5. "Just do it for me" — guide, don't operate
# ═════════════════════════════════════════════════════════════════════

_c(id="bd_cluster_eve", category="teach_boundary", command="just cluster eve for me with k=4",
   phrasings=["do the clustering at eve yourself, k 4", "cluster eve, k=4, go"],
   context=V_CHR4,  # eve isn't in view, so the plan must go there
   reference=plan("You'll click Cluster; here's where",
                  nav("eve"),
                  ex("cluster-k", "Set K to 4 here."),
                  *peaks_then_cluster()),
   expect={"navigate": {"gene": "eve"}, "key_anchors": ["cluster-k", "cluster-button"],
           "allowed_anchors": ["cluster-controls-expand", "cluster-method", "scan-peaks-button", "peaks-track"],
           "try_it": ["clustered"]})

_c(id="bd_scan", category="teach_boundary", command="scan the peaks for me",
   phrasings=["run a peak scan now"],
   reference=plan("Scan is your click", tr("scan-peaks-button", "Click Scan.", "peaks_scanned")),
   expect={"key_anchors": ["scan-peaks-button"], "try_it": ["peaks_scanned"], "allowed_anchors": ["peaks-track"],
           "steps": (1, 4)})

_c(id="bd_load_path", category="teach_boundary", command="load /data/runs/sample1.bam",
   phrasings=["open /data/runs/sample1.bam for me"],
   reference=plan("Load it by path",
                  sidebar("file", "file.loadpath"),
                  tr("load-by-path", "Paste /data/runs/sample1.bam here and load it.", "dataset_loaded")),
   expect={"anchor_alts": [["load-by-path", "load-dataset"]], "try_it": ["dataset_loaded"],
           "allowed_anchors": ["sidebar-data", "load-dataset", "load-by-path"], "steps": (1, 4)})

_c(id="bd_export", category="teach_boundary", command="export a PDF of this right now",
   phrasings=["save this view as pdf for me"],
   reference=plan("Export is your click", ex("export-figure", "Export, then choose PDF.")),
   expect={"key_anchors": ["export-figure"], "steps": (1, 3)})

_c(id="bd_clear_filter", category="teach_boundary", command="remove the filter please",
   phrasings=["get rid of the read filter"],
   raw_state=raw(V_DM6_2R, DS_FIBER_DAF, filtered={0: 40}),
   diagnostics=[filter_active(L1, 40, 240)],
   reference=plan("Clear the filter",
                  ex("filter-controls-expand", "Open the Filter controls."),
                  tr("clear-filter", "Click Clear.", "filter_cleared")),
   expect={"key_anchors": ["clear-filter"], "try_it": ["filter_cleared"],
           "allowed_anchors": ["filter-controls-expand"], "steps": (1, 4)})

_c(id="bd_zoom_out", category="teach_boundary", command="zoom out for me",
   phrasings=["make the view wider"],
   reference=plan("Zooming out", zoom("out", 1)),
   expect={"action_types": [["zoom_view", "navigate_region"]], "steps": (1, 3), "no_try_it": True})

# ═════════════════════════════════════════════════════════════════════
# 6. Troubleshooting — diagnostics-driven (every code, plus combinations)
# ═════════════════════════════════════════════════════════════════════

def _ts(id: str, command: str, diags: list, fix: list[str], ref: list[dict], *, context=V_DM6_2R,
        ds: int = DS_FIBER_DAF, raw_state: Optional[dict] = None, phrasings=(), expect_extra: Optional[dict] = None,
        tags=()) -> None:
    exp: dict[str, Any] = {"diagnosis_fix": fix}
    exp.update(expect_extra or {})
    _c(id=id, category="troubleshoot_diagnostics", command=command, phrasings=list(phrasings), context=context,
       dataset_count=ds, diagnostics=diags, raw_state=raw_state, reference=plan("Diagnosis", *ref), expect=exp,
       tags=list(tags))


_ts("td_no_datasets", "why is the screen empty?", [no_datasets()], ["load-dataset"],
    [ex("load-dataset", "No dataset is loaded yet."), tr("load-dataset", "Load your file.", "dataset_loaded")],
    ds=DS_NONE, raw_state=raw(V_DM6_2R, DS_NONE), phrasings=["no reads anywhere"],
    expect_extra={"try_it": ["dataset_loaded"]})

_ts("td_no_reference", "why can't I choose a chromosome?", [no_reference(nothing=True), no_datasets()],
    ["genome-selector", "load-fasta", "reference-files", "load-dataset", "sidebar-reference"],
    [ex("genome-selector", "No genome is loaded, so there are no chromosomes."),
     tr("genome-selector", "Pick your genome.", "genome_loaded")],
    context=V_EMPTY, ds=DS_NONE, raw_state=raw(V_EMPTY, DS_NONE), phrasings=["no chromosomes to pick from"])

_ts("td_no_gtf", "why can't I find eve in the search?", [no_gtf()], ["load-gtf", "reference-files"],
    [ex("load-gtf", "No gene annotation is loaded, so gene names can't be searched."),
     ex("load-gtf", "Load a GTF for this genome here.")],
    phrasings=["gene search finds nothing"])

_ts("td_layers_hidden", "the reads are grey bars with no footprints", [layers_hidden(tf_off=True)],
    ["layer-toggles", "layers-controls-expand"],
    [ex("layer-toggles", "All the footprint layers are switched off."),
     ex("layers-controls-expand", "Turn footprint, nucleosome or TF back on here.")],
    raw_state=raw(V_DM6_2R, layers={"footprint": False, "nuc": False, "tf": False, "msp": True}),
    phrasings=["footprints vanished"])

_ts("td_panel_collapsed", "where did my second dataset go?", [panel_collapsed(L2)], ["panel-expand"],
    [ex("panel-expand", f'"{L2}" is minimized; click its chip to bring it back.')],
    raw_state=raw(V_DM6_2R, hidden=(1,)), phrasings=["one panel disappeared"])

_ts("td_row_collapsed", "a whole row of panels is gone", [row_collapsed(L2)], ["layout-rows"],
    [ex("layout-rows", "That row is collapsed; click its bar to expand it.")],
    raw_state=raw(V_DM6_2R, hidden=(1,)))

_ts("td_other_locus", "why do the two panels disagree about what's here?", [at_other_locus(L1)],
    ["panel-location-bar", "panel-link"],
    [ex("panel-location-bar", "That copy shows its own region, set here."),
     ex("panel-link", "Link it to follow the main view again.")],
    raw_state=raw(V_DM6_2R, copy_view={"chrom": "3R", "start": 12_000_000, "end": 12_010_000}),
    expect_extra={"state_true": ["has_panel_copy"]})

_ts("td_zoomed_out", "why can't I see any reads right now?", [zoomed_out(L1, "1.0 Mb"), zoomed_out(L2, "1.0 Mb")],
    ["navigate", "zoom-in", "read-window-setting", "search-bar"],
    [ex("read-window-setting", "You're at 1 Mb, past the 100 kb read window, so coverage is drawn instead."),
     region("2R", 9_950_000, 10_050_000)],
    context=V_WIDE_2R, raw_state=raw(V_WIDE_2R), phrasings=["I only see coverage", "reads aren't showing up"])

_ts("td_chrom_missing", "why is chromosome 4 empty?", [chrom_missing(L1, "4"), chrom_missing(L2, "4")],
    ["navigate", "search-bar", "chrom-selector"],
    [ex("search-bar", "Your files have no reads on chromosome 4."), nav("eve")],
    context=V_CHR4, raw_state=raw(V_CHR4))

_ts("td_fetch_failed", "the reads just say failed", [fetch_failed(L1)],
    ["reads-track", "loaded-datasets", "load-by-path", "search-bar", "navigate"],
    [ex("reads-track", "Reads for this dataset failed to load."),
     ex("loaded-datasets", "Check the file is still reachable here, then reload it.")])

_ts("td_still_loading", "the panel is totally empty", [still_loading(L1), still_loading(L2)], ["reads-track"],
    [ex("reads-track", "The reads are still loading; give it a moment.")],
    expect_extra={"no_try_it": True, "forbidden_anchors": ["clear-filter", "load-dataset", "panel-expand",
                                                           "quality-filters", "spanning-toggle"]})

_ts("td_filter_none", "why don't I see any reads?", [filter_none(L1)], ["clear-filter", "filter-controls-expand"],
    [ex("clear-filter", "A read filter matched no reads."), tr("clear-filter", "Click Clear.", "filter_cleared")],
    raw_state=raw(V_DM6_2R, filtered={0: 0}), phrasings=["everything disappeared after filtering"],
    expect_extra={"try_it": ["filter_cleared"]})

_ts("td_filter_active", "why are there fewer reads than before?", [filter_active(L1, 40, 240)],
    ["clear-filter", "filter-controls-expand"],
    [ex("clear-filter", "A filter shows 40 of 240 reads; Clear shows them all.")],
    raw_state=raw(V_DM6_2R, filtered={0: 40}))

_ts("td_focus_hides", "all the reads vanished after I clicked a cluster", [focus_hides(L1)],
    ["cluster-focus-bar", "clusters-overview"],
    [ex("cluster-focus-bar", "The cluster focus hides every read; Unhide all brings them back.",
        requires="has_clusters")],
    raw_state=raw(V_DM6_2R, clustered=(0,), focus={0: [7]}), expect_extra={"state_true": ["has_clusters"]})

_ts("td_branch_empty", "the branch I switched to shows nothing", [branch_empty(L1)],
    ["cluster-branches", "cluster-focus-bar", "clusters-overview"],
    [ex("cluster-branches", "This branch holds no reads for that panel; switch back in the branch map.")],
    raw_state=raw(V_DM6_2R, clustered=(0,), branch=True), expect_extra={"state_true": ["has_clusters"]})

_ts("td_strand_empty", "the GA panel is empty", [strand_empty(L2, "GA")], ["strand-chip"],
    [ex("strand-chip", "No GA-strand reads here; switch strand with the chip.")],
    raw_state=raw(V_DM6_2R, strands=True), expect_extra={"state_true": ["has_strand_split"]})

_ts("td_no_reads_region", "nothing here at all", [no_reads(L1), no_reads(L2)],
    ["navigate", "search-bar", "go-to-reads"],
    [ex("go-to-reads", "No reads in this region; Go to reads jumps to covered sequence."),
     {"type": "go_to_top_locus"}],
    context=V_DM6_X, raw_state=raw(V_DM6_X))

_ts("td_spanning_none", "why is the track empty with spanning on?", [spanning_none(L1, 240)], ["spanning-toggle"],
    [ex("spanning-toggle", "Spanning only is on and no read spans the whole view."),
     ex("spanning-toggle", "Turn it off or zoom in.")],
    raw_state=raw(V_DM6_2R, spanning_only=True))

_ts("td_quality_all", "I raised a quality cutoff and now it's empty", [quality_all(L1)],
    ["quality-filters", "quality-cutoffs", "quality-controls-expand", "read-filters"],
    [ex("quality-filters", "The quality settings remove every read."),
     ex("quality-cutoffs", "Lower the cutoff here.")],
    raw_state=raw(V_DM6_2R, quality=("tf:tq>=240",)))

# combinations — the most blocking cause first
_ts("tc_zoom_and_filter", "no reads, what's going on?", [zoomed_out(L1, "1.0 Mb"), filter_active(L1, 30, 240)],
    ["navigate", "zoom-in", "read-window-setting"],
    [ex("read-window-setting", "You're past the read window, so no reads are drawn."),
     region("2R", 9_950_000, 10_050_000),
     ex("clear-filter", "A filter is also on; Clear shows every read.")],
    context=V_WIDE_2R, raw_state=raw(V_WIDE_2R, filtered={0: 30}))

_ts("tc_collapsed_and_filter", "why is it blank?", [panel_collapsed(L2, blocking=False), filter_none(L1)],
    ["clear-filter", "filter-controls-expand"],
    [ex("clear-filter", "A filter matched no reads."), tr("clear-filter", "Click Clear.", "filter_cleared"),
     ex("panel-expand", f'"{L2}" is minimized too.')],
    raw_state=raw(V_DM6_2R, filtered={0: 0}, hidden=(1,)))

_ts("tc_spanning_and_quality", "all my molecules disappeared", [spanning_few(L1, 12, 240), quality_all(L1)],
    ["quality-filters", "quality-cutoffs", "quality-controls-expand"],
    [ex("quality-filters", "The quality settings remove every read."),
     ex("spanning-toggle", "Spanning only also hides most reads.")],
    raw_state=raw(V_DM6_2R, spanning_only=True, quality=("nuc:nq>=250",)))

_ts("tc_empty_browser", "nothing works", [no_datasets(), no_reference(nothing=True)],
    ["load-dataset", "genome-selector", "load-fasta", "sidebar-reference"],
    [ex("genome-selector", "Nothing is loaded yet: pick a genome."),
     tr("load-dataset", "Then load your data.", "dataset_loaded")],
    context=V_EMPTY, ds=DS_NONE, raw_state=raw(V_EMPTY, DS_NONE))

_ts("tc_hg38_chrom_missing", "no reads at MYC?", [chrom_missing(L1, "chr8")],
    ["navigate", "search-bar", "chrom-selector"],
    [ex("search-bar", "This dataset has no reads on chr8; check the file's genome."),
     ex("loaded-datasets", "Loaded Datasets lists what each file covers.")],
    context=V_HG38_MYC, ds=DS_FIBER_ONLY, raw_state=raw(V_HG38_MYC, DS_FIBER_ONLY))

# ═════════════════════════════════════════════════════════════════════
# 7. Troubleshooting — raw-state fallback (no blocking diagnostic)
# ═════════════════════════════════════════════════════════════════════

_c(id="rs_looks_fine", category="troubleshoot_state", command="is anything wrong with my view?",
   phrasings=["sanity-check what I'm looking at", "does this look right"],
   reference=plan("Looks fine",
                  ex("reads-track", "Nothing is hidden: both panels show all their reads."),
                  ex("spanning-toggle", "If you expected more reads, Spanning only and zoom are the usual causes.")),
   expect={"no_try_it": True,
           "forbidden_anchors": ["clear-filter", "load-dataset", "panel-expand", "layout-rows", "genome-selector",
                                 "cluster-focus-bar"], "steps": (1, 4)})

_c(id="rs_few_reads", category="troubleshoot_state", command="why are there so few reads here",
   phrasings=["read count seems low"],
   raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=6, overlapping=6, spanning=4),
                             _panel("p2", L2, shown=5, overlapping=5, spanning=3)]),
   reference=plan("Low coverage here",
                  ex("reads-track", "Only 6 reads cover this region; nothing is filtered."),
                  ex("go-to-reads", "Go to reads jumps to better-covered sequence.")),
   expect={"anchor_alts": [["go-to-reads", "search-bar", "zoom-out", "reads-track"]],
           "forbidden_anchors": ["clear-filter", "load-dataset", "panel-expand", "quality-filters"],
           "no_try_it": True})

_c(id="rs_copy_panel", category="troubleshoot_state", command="why doesn't the copy move when I navigate",
   phrasings=["the second panel is stuck"],
   raw_state=raw(V_DM6_2R, copy_view={"chrom": "3R", "start": 12_000_000, "end": 12_010_000}),
   reference=plan("It's unlinked",
                  ex("panel-link", "The copy is unlinked, so it keeps its own region; link it to follow.")),
   expect={"anchor_alts": [["panel-link", "panel-location-bar"]], "state_true": ["has_panel_copy"],
           "steps": (1, 4)})

_c(id="rs_focus_one", category="troubleshoot_state", command="why do I only see some of the reads",
   phrasings=["reads went missing after clustering"],
   raw_state=raw(V_DM6_2R, clustered=(0,), focus={0: [2]}),
   reference=plan("A cluster is focused",
                  ex("cluster-focus-bar", "You're focused on cluster 2; Unhide all shows every cluster.",
                     requires="has_clusters")),
   expect={"key_anchors": ["cluster-focus-bar"], "state_true": ["has_clusters"],
           "forbidden_anchors": ["load-dataset", "clear-filter"]})

_c(id="rs_strands", category="troubleshoot_state", command="why is my DAF dataset in two panels",
   phrasings=["there are two copies of the DAF data"],
   raw_state=raw(V_DM6_2R, strands=True),
   reference=plan("Split by strand", ex("strand-chip", "It's split into CT and GA strand panels; the chip merges them.")),
   expect={"key_anchors": ["strand-chip"], "state_true": ["has_strand_split"], "steps": (1, 3)})

_c(id="rs_tf_off", category="troubleshoot_state", command="where did the TF calls go",
   phrasings=["no small footprints anymore"],
   raw_state=raw(V_DM6_2R, layers={"footprint": True, "nuc": True, "tf": False, "msp": True}),
   reference=plan("The TF layer is off", ex("layer-toggles", "The TF layer is switched off; turn it back on here.")),
   expect={"anchor_alts": [["layer-toggles", "layers-controls-expand"]], "steps": (1, 3),
           "forbidden_anchors": ["load-dataset", "clear-filter"]})

# ═════════════════════════════════════════════════════════════════════
# 8. Other "I'm stuck" questions
# ═════════════════════════════════════════════════════════════════════

_c(id="st_scan_none", category="troubleshoot_stuck", command="scan didn't find any peaks",
   phrasings=["no peaks after scanning"],
   reference=plan("Loosen the peak rules",
                  ex("peak-rules", "Peak rules set the threshold; this region may be below it."),
                  ex("peak-detection-settings", "Detection settings are here."),
                  tr("scan-peaks-button", "Scan again after adjusting.", "peaks_scanned")),
   expect={"anchor_alts": [["peak-rules", "peak-detection-settings", "peak-detection-rules", "rules-peaks-tab"]],
           "allowed_anchors": ["scan-peaks-button", "peaks-controls-expand", "zoom-out", "peak-draw"]})

_c(id="st_cluster_grey", category="troubleshoot_stuck", command="the Cluster button is greyed out",
   phrasings=["Cluster won't let me press it"],
   reference=plan("Select a peak first",
                  ex("cluster-button", "Cluster needs selected peaks."),
                  tr("scan-peaks-button", "Click Scan.", "peaks_scanned", skip_if="has_peaks"),
                  tr("peaks-track", "Select a peak.", "peak_selected", skip_if="has_selected_peak"),
                  tr("cluster-button", "Now click Cluster.", "clustered")),
   expect={"key_anchors": ["cluster-button"], "anchor_alts": [["peaks-track", "scan-peaks-button"]],
           "try_it": ["peak_selected"], "gating": [PEAK_GATE]})

_c(id="st_genes_missing", category="troubleshoot_stuck", command="I don't see any genes",
   phrasings=["no gene track"], diagnostics=[no_gtf()],
   reference=plan("Load a GTF", ex("load-gtf", "No gene annotation is loaded; add a GTF here.")),
   expect={"diagnosis_fix": ["load-gtf", "reference-files", "genome-selector"]})

_c(id="st_bam_wont_load", category="troubleshoot_stuck", command="my bam file won't open",
   phrasings=["loading my BAM fails"],
   reference=plan("Loading a BAM",
                  ex("load-by-path", "Paste the full path; the index is built automatically if it's missing."),
                  tr("load-by-path", "Try loading it by path.", "dataset_loaded")),
   expect={"anchor_alts": [["load-by-path", "load-dataset", "loaded-datasets", "load-remote-url"]],
           "allowed_anchors": ["sidebar-data"]})

_c(id="st_fp_panel_empty", category="troubleshoot_stuck", command="footprint analysis shows nothing at all",
   phrasings=["nothing in footprint analysis"],
   reference=plan("Cmd+click a footprint", tr("reads-track", "Cmd/Ctrl+click a footprint in the reads.",
                                              "footprint_selected"),
                  ex("selected-footprint", "Its details appear here.", requires="has_selected_footprint")),
   expect={"key_anchors": ["reads-track"], "try_it": ["footprint_selected"],
           "allowed_anchors": ["selected-footprint", "footprints-classes"]})

_c(id="st_readstats_empty", category="troubleshoot_stuck", command="read stats says nothing is selected",
   phrasings=["read stats panel is blank"],
   reference=plan("Shift+click reads", tr("reads-track", "Shift+click reads to select them.", "reads_selected"),
                  ex("read-stats-summary", "Their stats appear here.", requires="has_selected_reads")),
   expect={"key_anchors": ["reads-track"], "try_it": ["reads_selected"],
           "allowed_anchors": ["read-stats-summary", "read-stats-table"]})

_c(id="st_primers_fail", category="troubleshoot_stuck", command="primer design keeps failing",
   phrasings=["can't get primers"], diagnostics=[no_reference(nothing=False)],
   reference=plan("Primers need a reference",
                  ex("load-fasta", "Primer design needs the reference sequence, and none is loaded."),
                  tr("genome-selector", "Pick a genome or load a FASTA.", "genome_loaded")),
   expect={"diagnosis_fix": ["load-fasta", "reference-files", "genome-selector", "sidebar-reference"]})

_c(id="st_slow", category="troubleshoot_stuck", command="everything is really slow",
   phrasings=["panning feels sluggish"], context=V_HG38_TP53,
   reference=plan("Draw fewer reads",
                  ex("read-display-mode", "Sample draws a subset of reads instead of all of them."),
                  ex("read-window-setting", "A smaller read window keeps wide views fast.")),
   expect={"anchor_alts": [["read-display-mode", "read-window-setting", "zoom-in", "read-display-settings"]],
           "no_try_it": True})

# ═════════════════════════════════════════════════════════════════════
# 9. Off-topic
# ═════════════════════════════════════════════════════════════════════

def _off(id: str, command: str, text: str, phrasings=()) -> None:
    _c(id=id, category="off_topic", command=command, phrasings=list(phrasings),
       reference=plan("Off topic", ex(None, text)),
       expect={"only_types": ["explain"], "steps": (1, 2), "no_try_it": True})


_off("ot_capital", "what's the capital of france?", "I can only help with using the browser.",
     phrasings=["tell me a fun fact"])
_off("ot_poem", "write me a poem about chromatin", "I'm here to help with the browser, not writing.")
_off("ot_r_script", "fix my R script", "I can't help with code, only with using FiberBrowser.")
_off("ot_nucleosome", "what is a nucleosome?",
     "DNA wrapped around histones; in the reads it shows as a ~147 bp footprint.")

# Each analysis panel in depth (records_teach_panels.py).
from data.copilot_dataset.eval_cases_panels import CASES as _PANEL_CASES; EVAL_CASES.extend(_PANEL_CASES)  # noqa: E402,E702


from data.copilot_dataset.eval_cases_vague import add_cases as _add_vague_cases; _add_vague_cases(globals())  # noqa: E402,E702


# ─────────────────────────────────────────────────────────────────────
# Sanity checks on import
# ─────────────────────────────────────────────────────────────────────

assert all("id" in c and "command" in c and "reference" in c for c in EVAL_CASES), "EVAL_CASES missing fields"
assert len({c["id"] for c in EVAL_CASES}) == len(EVAL_CASES), "EVAL_CASES has duplicate ids"


def expanded_runs() -> list[dict]:
    """One entry per (case, phrasing); the canonical command is phrasing 0."""
    out = []
    for case in EVAL_CASES:
        phrasings = [case["command"]] + list(case.get("phrasings") or [])
        for i, phrase in enumerate(phrasings):
            entry = dict(case)
            entry["case_id"] = case["id"]
            entry["run_id"] = f"{case['id']}__p{i}"
            entry["command"] = phrase
            entry["phrasing_index"] = i
            entry["is_canonical"] = (i == 0)
            out.append(entry)
    return out


def category_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for case in EVAL_CASES:
        counts[case["category"]] = counts.get(case["category"], 0) + 1
    return counts
