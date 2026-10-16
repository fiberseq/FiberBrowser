"""Teach-only records that walk each analysis panel in depth.

The workflow module (records_teach_workflows.py) teaches the core how-tos; this
one goes inside every UI analysis: how to run it (the user's clicks as
``try_it`` steps, gated on state), how to read its result (each tab or plot, and
what it means biologically in one line), its key options, the usual follow-ups,
and "where is / what does X do" questions. Anchors come from
``browser/frontend/src/data/tutorialAnchors.json``; every quoted label matches
the UI.

Registered from records.py (``RECORDS += ...``). Like the workflow module it does
not import records.py, so there's no import cycle; it reuses the workflow
module's record constructor, fixtures and step builders so the live
diagnostics/raw_state go with every record.
"""
from __future__ import annotations

from typing import Optional

try:
    from data.copilot_dataset.records_teach_workflows import (
        DS_FIBER_DAF, DS_FIBER_ONLY, DS_THREE, V_DM6_2L, V_DM6_2R, V_DM6_HB, V_DM6_X, V_HG38_MYC,
        V_HG38_TP53, V_MM10_PAX6, _r, ctx_kw, ex, nav, op, region, sidebar, tr, turn, zoom,
    )
except ImportError:  # imported as a top-level module
    from records_teach_workflows import (  # type: ignore[no-redef]
        DS_FIBER_DAF, DS_FIBER_ONLY, DS_THREE, V_DM6_2L, V_DM6_2R, V_DM6_HB, V_DM6_X, V_HG38_MYC,
        V_HG38_TP53, V_MM10_PAX6, _r, ctx_kw, ex, nav, op, region, sidebar, tr, turn, zoom,
    )

RECORDS: list[dict] = []

V_DM6_EVE_TIGHT = {"chrom": "2R", "start": 9_973_000, "end": 9_979_000, "currentGenome": "dm6"}
V_PLASMID = {"chrom": "pUC19", "start": 0, "end": 2_686, "currentGenome": "dm6"}
GENE_EVE = {"selected_gene": "eve"}
GENE_HB = {"selected_gene": "hb"}


def add(id: str, command: str, phrasings: list[str], actions: list[dict], summary: str, thinking: str, *,
        category: str = "teach_panel", ctx: dict = V_DM6_2R, ds: int = DS_FIBER_DAF,
        diagnostics: Optional[list] = None, state_overrides: Optional[dict] = None,
        previous_turns: Optional[list] = None, **state) -> None:
    kw = dict(ctx_kw(ctx, ds, diagnostics, **state))
    if state_overrides:
        kw["state_overrides"] = state_overrides
    if previous_turns:
        kw["previous_turns"] = previous_turns
    RECORDS.append(_r(id=id, category=category, command=command, phrasings=phrasings, thinking=thinking,
                      summary=summary, actions=actions, **kw))


# ═════════════════════════════════════════════════════════════════════
# Peak Detection panel (peak rules)
# ═════════════════════════════════════════════════════════════════════

PEAK_RULE_WALK = [
    op("peak-detection"),
    ex("peak-rule-card", "Each row is a peak rule: tick it to use it, its colour marks its peaks, and the number is how many it found here."),
    ex("peak-rule-source", "Source is the signal the rule scans: accessibility, FIRE, a footprint layer, a modification, a loaded track, or Custom (draw)."),
    ex("peak-rule-signal", "The plot is that signal across the view with the cutoffs drawn in; peaks are where it rises above them."),
    ex("peak-rule-cutoffs", "Strong, Medium, Weak and Rare are fixed cutoffs from 0 to 1; Fill from percentile sets them once from this view."),
]

add("tp_peaks_rules_walk", "how do the peak rules work?",
    ["explain the peak detection panel", "what is a peak rule", "how is a peak called",
     "walk me through the peak rules panel", "how does the browser decide where peaks are"],
    PEAK_RULE_WALK + [tr("scan-peaks-button", "Click Scan to run the enabled rules on this view.", "peaks_scanned")],
    "How peak rules turn a signal into peaks",
    "The user wants the Peak Detection panel explained: open it, walk a rule's Source, signal plot and cutoffs, then hand them Scan.")

add("tp_peaks_add_rule", "how do I add a new peak rule?",
    ["make my own peak caller rule", "add a peak rule for m6A", "create another peak rule",
     "I want peaks from a different signal"],
    [op("peak-detection"),
     ex("peak-add-rule", "Click + Add Rule for a new rule; it appears as a new row."),
     ex("peak-rule-source", "Open the row and pick its Source, e.g. an m6A or FIRE signal, or a loaded track."),
     ex("peak-rule-cutoffs", "Set the cutoffs, or click Fill from percentile to take them from this view."),
     tr("scan-peaks-button", "Click Scan to find the new rule's peaks.", "peaks_scanned")],
    "Add and configure a peak rule",
    "Adding a rule is a click in the Peak Detection panel; walk + Add Rule, Source and cutoffs, then Scan.")

add("tp_peaks_cutoffs", "my peaks are too strict, how do I loosen them?",
    ["how do I get more peaks", "too few peaks are called", "lower the peak threshold",
     "peaks miss obvious open regions", "make peak calling less stringent"],
    [op("peak-detection"),
     ex("peak-rule-card", "Click the rule's row to open its settings."),
     ex("peak-rule-cutoffs", "Lower the Strong/Medium/Weak/Rare cutoffs (0-1), or Fill from percentile to fit this view."),
     ex("peak-rule-signal", "The cutoff lines move on the signal plot so you can see what will pass."),
     tr("scan-peaks-button", "Click Scan to re-call the peaks.", "peaks_scanned")],
    "Loosen the peak cutoffs",
    "Peak strictness is the rule's signal cutoffs: open the rule, lower them, rescan (the user's click).")

add("tp_peaks_locked_rescan", "why doesn't changing the rule change my peaks?",
    ["the peaks don't update", "rescan does nothing", "my new cutoffs are ignored",
     "it says peaks locked"],
    [ex("peaks-lock", "Peaks are locked, so they keep their positions until you unlock them."),
     ex("peaks-controls-expand", "The lock is in the Peaks group of the toolbar; click the Peaks label if you don't see it."),
     ex("peaks-lock", "Click the lock to unlock, then Scan to re-call with the new cutoffs.")],
    "Locked peaks don't rescan",
    "Changed cutoffs with no effect is almost always the peak lock; point at it and explain unlock then Scan.",
    category="teach_followup")

add("tp_peaks_custom_draw", "can I mark a peak by hand?",
    ["draw my own peak", "add a custom peak region", "how do I define a peak manually",
     "I want a peak where there isn't one"],
    [ex("peaks-controls-expand", "Click the Peaks label to show all of its controls."),
     ex("peak-draw", "Turn on Draw a peak, then drag along the Peaks track over the region you want."),
     ex("peaks-track", "Your peak joins the others and can be selected, clustered on, or used for primers.")],
    "Draw a peak by hand",
    "Hand-drawn peaks: the Draw a peak toggle in the Peaks group, then a drag on the Peaks track.")

add("tp_peaks_presets", "how do I save my peak settings?",
    ["reuse my peak rules later", "save peak rules as a preset", "share my peak calling setup",
     "load peak rules I saved"],
    [op("peak-detection"),
     ex("peak-presets", "Presets ▾ saves the current rules under a name and loads saved sets."),
     ex("peak-presets", "The same menu imports and exports the rules as JSON to share them.")],
    "Save and load peak rule presets",
    "Peak rule presets live under Presets ▾ in the Peak Detection panel.")

add("tp_peaks_import_bed", "can I load peaks from a bed file?",
    ["import my ChIP peaks", "use peaks called somewhere else", "bring in MACS peaks",
     "load a peak BED", "export my peaks as bed"],
    [op("peak-detection"),
     ex("peak-presets", "Open Presets ▾ in the Peak Detection panel."),
     ex("peak-import-bed", "Import Peak BED... loads BED peaks on this chromosome as locked peaks; Export Peaks BED saves yours."),
     ex("peaks-track", "Imported peaks show on the Peaks track and work like called ones.")],
    "Import and export peaks as BED",
    "Peak BED import/export is in the Presets menu of the Peak Detection panel.")

add("tp_peaks_where_panel", "where is the peak detection panel?",
    ["where are the peak settings", "open peak rules", "where do I tune peak calling"],
    [ex("peaks-controls-expand", "Click the Peaks label on the toolbar to show its controls."),
     ex("peak-rules", "Peak rules opens the Peak Detection panel with every rule and its settings.")],
    "Where the peak rules are", "A where-is question: the Peak rules button in the Peaks toolbar group.",
    category="teach_where")

add("tp_peaks_what_fill", "what does fill from percentile do?",
    ["how are the fill from percentile cutoffs chosen", "what is fill from percentile", "explain the percentile button on a peak rule"],
    [op("peak-detection"),
     ex("peak-rule-cutoffs", "Fill from percentile sets Strong/Medium/Weak/Rare to the top 5/15/30/50% of this view's signal, once; after that they're fixed numbers.")],
    "What Fill from percentile does", "A what-does question about a peak rule control.",
    category="teach_what")

add("tp_peaks_what_strength", "what do strong medium weak rare mean for peaks?",
    ["peak strength levels", "why are some peaks darker", "peak layers explained"],
    [op("peak-detection"),
     ex("peak-rule-cutoffs", "Each peak gets the highest level whose cutoff its signal passes: Strong, then Medium, Weak and Rare."),
     ex("peaks-track", "Stronger peaks are drawn darker; labeling rules can target a minimum level.")],
    "Peak strength levels", "Explain the four cutoff levels and how they show on the Peaks track.",
    category="teach_what")

add("tp_peaks_disable_rule", "how do I turn off one of the peak rules?",
    ["stop using the FIRE peak rule", "hide one set of peaks", "disable a rule"],
    [op("peak-detection"),
     ex("peak-rule-card", "Untick the checkbox at the start of the rule's row; its peaks disappear from the Peaks track.")],
    "Turn a peak rule off", "Rule enable is the checkbox on its row.", category="teach_options")

add("tp_peaks_fire_vs_accessibility", "should I call peaks on FIRE or accessibility?",
    ["which peak source is best", "FIRE peaks or accessibility peaks", "which signal for peaks"],
    [op("peak-detection"),
     ex("peak-rule-source", "Accessibility uses every gap between footprints; FIRE uses only confident actuated regulatory elements, so it's cleaner but sparser."),
     ex("peak-add-rule", "You can keep both: add a second rule and compare their peaks on the Peaks track.")],
    "Choosing a peak source", "Explain the two common sources and suggest running both as rules.",
    category="teach_options")

# ═════════════════════════════════════════════════════════════════════
# Regions & plasmids panel (circular-genome)
# ═════════════════════════════════════════════════════════════════════

add("tp_regions_walk", "what is the regions panel for?",
    ["explain the regions panel", "how do I use the regions navigator", "what can I do in regions",
     "walk me through the regions panel"],
    [op("circular-genome"),
     ex("regions-map", "The top map is the whole chromosome; click anywhere to move the view there."),
     ex("regions-zoom-window", "Zoom window sets how much of the chromosome around the view the map below shows."),
     ex("regions-lens", "The zoom window map shows the genes around the view, with the view marked; click a gene to go to it."),
     ex("regions-add-view", "Add View saves the current view to the list below."),
     ex("regions-saved", "Saved regions can be opened side by side as panel copies, each with its own datasets.")],
    "The Regions panel", "Walk the Regions panel top to bottom: map, zoom window, add, saved regions.")

add("tp_regions_save_compare", "how do I compare several loci side by side?",
    ["open three regions at once", "look at eve hb and ftz together", "save regions and view them together",
     "multiple loci in one screen"],
    [op("circular-genome"),
     ex("regions-add-view", "Go to the first locus and click Add View to save it."),
     nav("hb"),
     ex("regions-add-view", "Click Add View again to save this one too."),
     ex("regions-saved", "Each saved region can show chosen datasets."),
     tr("regions-open-all", "Click Open All to open every saved region as its own panel.", "panel_copy_made")],
    "Save several regions and open them side by side",
    "Collect regions with Add View (Copilot can navigate between them), then the user clicks Open All.")

add("tp_regions_circular", "how do I see my plasmid as a circle?",
    ["circular view of the plasmid", "show the contig circular", "draw the chromosome as a ring",
     "switch to the circular map"],
    [op("circular-genome"),
     ex("regions-circular-toggle", "Circular / Linear switches the map between a ring and a line; it works for plasmids and small contigs."),
     ex("regions-map", "On the ring, click any position to move the view there; reads across the origin wrap around.")],
    "Circular map view", "Point at the Circular toggle and explain the ring map.", ctx=V_PLASMID)

add("tp_regions_plasmid_load", "how do I add a plasmid map?",
    ["load my plasmid genbank", "load a .dna file", "add a snapgene map", "load an addgene plasmid"],
    [op("circular-genome"),
     ex("regions-plasmid", "Load plasmid map takes a .dna, .gb/.gbk, .embl or SBOL file; it becomes its own contig with its features."),
     ex("regions-plasmid", "Click Load plasmid map and pick the file."),
     ex("regions-circular-toggle", "Switch to Circular to see it as a ring.")],
    "Load a plasmid map", "Loading a plasmid is the user's click on Load plasmid map in Regions.")

add("tp_regions_dataset_choice", "can each saved region show different datasets?",
    ["show only one sample in a region", "pick datasets per region", "saved region shows the wrong sample"],
    [op("circular-genome"),
     ex("regions-saved", "Under each saved region, tick the datasets it should show; at least one stays ticked."),
     ex("regions-saved", "Go moves the main view there; Open adds a panel copy for that region.")],
    "Datasets per saved region", "Per-region dataset checkboxes in Saved regions.", category="teach_options")

add("tp_regions_where", "where do I save regions?",
    ["where is the region list", "bookmark this region for later", "where are saved regions"],
    [op("circular-genome"), ex("regions-add-view", "Add View in the Regions panel saves the current view."),
     ex("regions-saved", "Saved regions are listed under it.")],
    "Where regions are saved", "Where-is: Regions panel Add View and Saved regions.", category="teach_where")

add("tp_regions_what_lens", "what is the zoom window in the regions panel?",
    ["what is the zoom window strip for", "what does the zoom window map show", "explain the zoom window"],
    [op("circular-genome"),
     ex("regions-lens", "The zoom window map shows the genes in a stretch around the view (10 kb to 1 Mb), with the view marked; click a gene to go to it, or anywhere to move the view there."),
     ex("regions-zoom-window", "This menu sets how wide that stretch is.")],
    "The Regions zoom window", "What-does question about the zoom window.", category="teach_what")

add("tp_regions_jump_far", "how do I jump to the other end of the chromosome quickly?",
    ["move far along the chromosome", "go to a distant part of the chromosome", "quick chromosome navigation"],
    [op("circular-genome"),
     ex("regions-map", "Click the far end of the chromosome map; the view moves there."),
     ex("regions-zoom-window", "The zoom window sets how wide the new view is.")],
    "Jump along the chromosome", "Chromosome map click-to-navigate.", category="teach_options")

# ═════════════════════════════════════════════════════════════════════
# History (undo timeline)
# ═════════════════════════════════════════════════════════════════════

add("tp_history_timeline", "how do I go back several steps?",
    ["undo multiple steps", "return to the state before my clustering", "jump back in history",
     "restore an earlier state", "how does the history work"],
    [ex("undo", "Undo (Cmd/Ctrl+Z) steps back one change; Redo is next to it."),
     ex("history-timeline", "The ▾ next to Redo opens the full history."),
     ex("history-steps", "Click any step to restore its analysis state without moving the view."),
     ex("history-view-step", "View restores that step and also jumps to where you were.")],
    "Going back through the history", "Undo for one step, the history timeline for many.")

add("tp_history_view_vs_click", "what is the difference between clicking a history step and view?",
    ["restore a step without moving the view", "history step versus view button", "why didn't restoring move the view"],
    [ex("history-steps", "Clicking a step restores clusters, filters and settings but leaves the view where it is."),
     ex("history-view-step", "View does the same and also moves back to that step's location.")],
    "Restore versus View in history", "What-does question on the history timeline.", category="teach_what")

add("tp_history_clear", "how do I clear the undo history?",
    ["start the history over", "reset the history", "wipe the history list"],
    [ex("history-timeline", "Open the history with the ▾ next to Redo."),
     ex("history-clear", "Clear empties it; your current state stays as it is.")],
    "Clear the history", "Point at history Clear.", category="teach_options")

add("tp_history_undo_merge", "I merged clusters by mistake, can I get them back?",
    ["take back a cluster merge", "unmerge clusters", "I dissolved the wrong cluster"],
    [tr("undo", "Press Undo (Cmd/Ctrl+Z) to bring the clusters back.", "undo_used"),
     ex("history-timeline", "If it was a few steps ago, open the history ▾ and click the step before the merge.")],
    "Undo a merge", "Merges are undoable: Undo as a try_it, or the timeline for older steps.",
    category="teach_followup", clustered=(0,))

add("tp_history_where", "where is the history?",
    ["where is the list of past steps", "where can I see what I did", "where's the undo list"],
    [ex("history-timeline", "The ▾ next to Undo and Redo opens the history of every change.")],
    "Where the history is", "Where-is: history timeline button.", category="teach_where")

add("tp_history_after_tour", "does the tour change my work?",
    ["will the tour undo my clustering", "will the guided tour mess up my session", "is my state safe during the tour"],
    [ex("guided-tour", "The tour saves your state first and restores it when it ends, so your work comes back as it was."),
     ex("history-timeline", "Its snapshot is also in the history as \"Before the guided tour\".")],
    "The tour and your work", "Reassure: the tour snapshots and restores.", category="teach_what")

# ═════════════════════════════════════════════════════════════════════
# Gene track and transcription state
# ═════════════════════════════════════════════════════════════════════

TX_OPEN = [
    ex("gene-track", "Genes are drawn under the reads; click one to select it, Shift+click to add more."),
    tr("gene-track", "Cmd/Ctrl+click the gene to select it and open the Transcription panel.", "gene_selected",
       skip_if="has_selected_gene"),
]

add("tp_tx_walk", "how do I look at Pol II states on a gene?",
    ["analyze transcription state", "is my gene paused", "count the elongating reads on my gene",
     "walk me through the transcription panel", "look at Pol II pausing at eve"],
    [nav("eve")] + TX_OPEN + [
        ex("transcription-states", "Pause, PIC and Elongating count the reads with each Pol II state at the selected genes.",
           requires="has_selected_gene"),
        ex("transcription-distribution", "Distribution shows how many Pol II each read carries and each state's share by cluster."),
        ex("transcription-cooccur", "Co-occur shows how often two states sit on the same molecule."),
        ex("transcription-pol2com", "Pol II COM shows where along the gene each read's Pol II sits.")],
    "Pol II states at a gene",
    "Transcription needs a selected gene: navigate, Cmd+click the gene (try_it gene_selected), then walk the tabs.")

add("tp_tx_what_states", "what do pause PIC and elongating mean?",
    ["define the Pol II states", "how is pausing called", "what is a PIC footprint",
     "how does the browser classify Pol II"],
    [ex("transcription-states", "PIC: a pre-initiation footprint just upstream of the TSS; Pause: a Pol II-sized footprint 10-50 bp into the gene; Elongating: Pol II-sized footprints further into the body.",
        requires="has_selected_gene"),
     ex("transcription-min-pol2", "A read counts as elongating when it has at least this many of them.")],
    "The three Pol II states", "What-does question; answer from the state definitions, pointing at the list.",
    category="teach_what", state_overrides=GENE_EVE)

add("tp_tx_filter_paused", "show only the paused reads",
    ["filter to reads with paused Pol II", "keep just elongating molecules", "hide reads without Pol II",
     "only reads with a PIC"],
    [op("transcription-state", "filters"),
     ex("transcription-states", "Tick the states to keep, e.g. Pause.", requires="has_selected_gene"),
     tr("transcription-apply", "Click Apply to filter the reads.", "filter_applied"),
     ex("transcription-clear", "Clear brings every read back.")],
    "Filter reads by Pol II state", "Transcription filter: tick, Apply (the user's click), Clear.",
    state_overrides=GENE_EVE)

add("tp_tx_threshold", "how many Pol II count as elongating?",
    ["change the elongating threshold", "require two polymerases", "elongating minimum count",
     "set a maximum Pol II count"],
    [op("transcription-state", "filters"),
     ex("transcription-thresholds", "Open State thresholds.", requires="has_selected_gene"),
     ex("transcription-min-pol2", "Minimum Pol II count sets how many elongating footprints a read needs; tick Maximum to cap it too.")],
    "Elongating Pol II thresholds", "Options question about the threshold settings.",
    category="teach_options", state_overrides=GENE_EVE)

add("tp_tx_several_genes", "can I look at several genes at once?",
    ["pool transcription over many genes", "select multiple genes", "Pol II state across a gene set"],
    [ex("gene-track", "Shift+click more genes in the gene track to add them to the selection."),
     tr("gene-track", "Select the genes you want.", "gene_selected", skip_if="has_selected_gene"),
     op("transcription-state"),
     ex("transcription-states", "The counts now pool every selected gene.", requires="has_selected_gene")],
    "Several genes in Transcription", "Shift+click multi-select, then the pooled counts.")

add("tp_tx_by_cluster", "does pausing differ between my clusters?",
    ["Pol II state per cluster", "compare pausing across clusters", "which cluster is elongating"],
    [op("transcription-state", "distribution"),
     ex("transcription-distribution", "With reads clustered, Distribution shows each state's share and the mean Pol II per read for every cluster.",
        requires="has_selected_gene"),
     ex("transcription-pol2com", "Pol II COM shows where the polymerase sits in each cluster.")],
    "Pol II states by cluster", "Reading results by cluster; the data is clustered.",
    category="teach_read", clustered=(0,), state_overrides=GENE_EVE)

add("tp_tx_export", "how do I export the transcription results?",
    ["save the Pol II state table", "download per-read states", "get the transcription counts out"],
    [op("transcription-state"),
     ex("transcription-export", "JSON saves the settings and counts; TSV next to it saves one row per read with its states.",
        requires="has_selected_gene")],
    "Export transcription results", "Point at the JSON/TSV export.", category="teach_options",
    state_overrides=GENE_EVE)

add("tp_tx_empty", "the transcription panel says select a gene",
    ["transcription panel is empty", "why is transcription blank", "how do I fill the transcription panel"],
    TX_OPEN + [ex("transcription-states", "The states for that gene then fill in.", requires="has_selected_gene")],
    "Select a gene for Transcription", "Empty Transcription means no selected gene: teach the gene click.",
    category="teach_followup")

add("tp_tx_where", "where do I find the transcription panel?",
    ["open the Pol II state panel", "where is Pol II analysis", "open transcription state"],
    [ex("gene-track", "Cmd/Ctrl+click a gene in the gene track: it selects the gene and opens Transcription.")],
    "Where Transcription is", "Where-is: Cmd+click a gene.", category="teach_where")

add("tp_gene_select_where", "how do I select a gene?",
    ["click a gene", "choose a gene for analysis", "select eve", "pick more than one gene"],
    [nav("eve"),
     ex("gene-track", "Genes sit under the reads; click one to select it (Shift+click adds more)."),
     tr("gene-track", "Click the gene.", "gene_selected", skip_if="has_selected_gene")],
    "Selecting genes", "Gene selection is a click on the gene track; navigate there first.",
    category="teach_where")

add("tp_tx_what_com", "what is the Pol II COM tab?",
    ["what is the Pol II centre of mass", "what does pol II center of mass mean", "explain the COM plot"],
    [op("transcription-state", "pol2com"),
     ex("transcription-pol2com", "COM is the centre of mass of each read's Pol II footprints along the gene: near 0 means promoter-proximal, higher means further into the body.",
        requires="has_selected_gene")],
    "The Pol II COM tab", "What-does question.", category="teach_what", state_overrides=GENE_EVE)

add("tp_tx_cooccur_read", "how do I read the co-occur tab in transcription?",
    ["do pausing and PIC occur on the same reads", "what does the transcription co-occurrence show", "are pause and PIC on the same molecules"],
    [op("transcription-state", "cooccurrence"),
     ex("transcription-cooccur", "Each cell counts reads carrying both states; a high Pause+PIC count means both sit on the same molecules.",
        requires="has_selected_gene")],
    "Reading Transcription > Co-occur", "Reading a result tab.", category="teach_read",
    state_overrides=GENE_EVE)

# ═════════════════════════════════════════════════════════════════════
# Co-accessibility
# ═════════════════════════════════════════════════════════════════════

COACC_OPEN = [
    op("co-accessibility"),
    ex("coacc-matrix", "Each cell shows how often two positions are accessible on the same molecule; along the diagonal is each position's own accessibility."),
]

add("tp_coacc_walk", "how do I check which positions open together?",
    ["are these two sites open together", "walk me through co-accessibility", "which elements open together",
     "coordinated opening between enhancers", "co-accessibility between two peaks"],
    [region("2R", 9_973_000, 9_979_000)] + COACC_OPEN + [
        ex("coacc-metadata", "Below it: how many reads, the bin size, coverage and how much is masked."),
        ex("coacc-settings-toggle", "Settings changes the signal, normalization and coverage cutoff."),
        ex("coacc-track-display", "Track Display draws it under the reads as a heatmap strip, arcs or a Virtual 4C profile.")],
    "Co-accessibility between positions",
    "Co-accessibility works within about a read length (~15 kb): zoom to the locus, open the panel, walk matrix, metadata and settings.")

add("tp_coacc_read_matrix", "how do I interpret the co-accessibility heatmap?",
    ["what does the matrix mean", "what do red squares mean in co-accessibility", "interpret co-accessibility"],
    COACC_OPEN + [
        ex("coacc-normalization", "With O/E, red means two positions open together more often than their own accessibility predicts; blue means less."),
        ex("coacc-min-coverage", "Grey cells are masked because too few reads cover both positions.")],
    "Reading the co-accessibility matrix", "Reading a result: matrix colours, O/E and masking.",
    category="teach_read", ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_signal", "can I look at nucleosome co-occupancy instead?",
    ["co-occupancy of nucleosomes", "change the co-accessibility signal", "linker co-accessibility",
     "footprint co-occurrence matrix"],
    [op("co-accessibility"),
     ex("coacc-settings-toggle", "Open Settings."),
     ex("coacc-signal", "Signal chooses what is compared: accessibility, nucleosome, small footprint, linker or all footprints."),
     ex("coacc-layer", "The layer chips pick which footprint layer the signal comes from.")],
    "Changing the co-accessibility signal", "Options question on Signal and layer.", category="teach_options",
    ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_normalization", "what normalization should I use for co-accessibility?",
    ["raw vs O/E co-accessibility", "what is O/E distance", "correlation or O/E"],
    [op("co-accessibility"),
     ex("coacc-normalization", "Raw is plain co-occurrence; O/E (marginal) divides by each position's accessibility; O/E (distance) also removes the drop with distance; Correlation is Pearson between positions."),
     ex("coacc-normalization", "O/E (marginal) is a good default for spotting linked elements.")],
    "Co-accessibility normalizations", "Explain the options and suggest a default.", category="teach_options",
    ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_arcs", "can I show co-accessibility as arcs under the reads?",
    ["draw co-accessibility arcs", "virtual 4C from co-accessibility", "show the heatmap under the reads"],
    [op("co-accessibility"),
     ex("coacc-settings-toggle", "Open Settings."),
     ex("coacc-track-display", "Track Display: Heatmap Strip, Arcs, or Virtual 4C draw it on the track under the reads."),
     ex("reads-track", "The drawing follows the view as you move.")],
    "Co-accessibility track display", "Options: Track Display modes.", category="teach_options",
    ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_wide", "co-accessibility says it's limited to read length",
    ["co-accessibility is empty when zoomed out", "why is co-accessibility blank",
     "the matrix won't show for a big region"],
    [ex("coacc-matrix", "Co-accessibility needs both positions on the same molecule, so it works over about one read length (~15 kb)."),
     region("2R", 9_973_000, 9_979_000),
     ex("coacc-matrix", "At this zoom the matrix fills in.")],
    "Co-accessibility needs a read-length window",
    "Wide view: explain the ~15 kb limit and navigate to a tighter window (navigation is allowed).",
    category="teach_followup", ctx=V_DM6_2R)

add("tp_coacc_masked", "most of the co-accessibility matrix is grey",
    ["too many masked cells", "co-accessibility is mostly empty", "masked fraction is high"],
    [op("co-accessibility"),
     ex("coacc-metadata", "The masked share is here: cells are grey when fewer reads than the cutoff cover both positions."),
     ex("coacc-min-coverage", "Lower Min coverage, or use a larger bin size, to fill more cells.")],
    "Masked co-accessibility cells", "Explain masking and point at Min coverage.", category="teach_followup",
    ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_from_footprints", "can I get co-accessibility for my saved footprints layer?",
    ["open co-accessibility for a footprint layer", "co-accessibility from the footprints panel", "layer matrix from footprints"],
    [op("footprint-analysis", "co-occ"),
     ex("footprints-open-coacc", "Layer matrix opens Co-accessibility using this footprint layer and, when set, the reads you filtered."),
     ex("coacc-matrix", "The matrix then compares that layer between positions.")],
    "Co-accessibility from Footprints", "The Footprints Co-occupancy tab's Layer matrix shortcut.",
    category="teach_options", ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_export", "how do I export the co-accessibility matrix?",
    ["save the co-accessibility values", "download the matrix", "co-accessibility to python"],
    [op("co-accessibility"),
     ex("coacc-export", "JSON saves the matrix with its settings; TSV and Python sit next to it.")],
    "Export co-accessibility", "Point at export.", category="teach_options", ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_where", "where can I find the co-accessibility panel?",
    ["take me to the co-accessibility matrix", "open the co-accessibility panel", "find co-accessibility"],
    [op("co-accessibility"), ex("coacc-matrix", "This is the Co-accessibility panel: the matrix for the current view.")],
    "Where Co-accessibility is", "Where-is: open the panel.", category="teach_where", ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_per_dataset", "can I compare co-accessibility between samples?",
    ["separate co-accessibility per sample", "co-accessibility for each dataset separately", "compare two samples' matrices"],
    [op("co-accessibility"),
     ex("coacc-settings-toggle", "Open Settings."),
     ex("coacc-normalization", "With more than one dataset, the Display setting below switches between Combined and Per dataset.")],
    "Per-dataset co-accessibility", "Display: Per dataset (needs 2+ datasets).", category="teach_options",
    ctx=V_DM6_EVE_TIGHT, ds=DS_THREE)

# ═════════════════════════════════════════════════════════════════════
# Annotations (per-read annotation BigBeds)
# ═════════════════════════════════════════════════════════════════════

add("tp_annot_walk", "how do the annotations panel tabs work?",
    ["explain the annotations panel", "what are per-read annotations", "walk me through annotations",
     "how do I use annotation bigbeds"],
    [op("annotations", "files"),
     ex("annotations-files", "Files lists per-read annotation BigBeds (e.g. motif or TF calls on each molecule)."),
     ex("annotations-types", "Types shows each annotation type: toggle it on the reads and set its colour."),
     ex("annotations-filter", "Filter keeps reads that carry, or lack, chosen types."),
     ex("annotations-cluster", "Cluster groups reads by which types they carry at the selected peaks."),
     ex("annotations-profile", "Profile shows each type's density across the view.")],
    "The Annotations panel", "Walk the five tabs in order.")

add("tp_annot_load", "how do I load an annotation bigbed?",
    ["add per-read annotations", "load my motif calls per molecule", "load annotation file"],
    [op("annotations", "files"),
     ex("annotations-load-file", "Click Load File... and pick the annotation BigBed."),
     ex("annotations-types", "Its types then appear in the Types tab.")],
    "Load an annotation file", "Loading is the user's click in Annotations > Files.")

add("tp_annot_types", "how do I show only some annotation types?",
    ["hide an annotation type", "recolour an annotation", "turn annotation overlays on"],
    [op("annotations", "types"),
     ex("annotations-type-list", "Tick the types to draw on the reads; click a swatch to change its colour."),
     ex("annotations-types", "Enable All and Disable All switch every type at once.")],
    "Choosing annotation types", "Types tab options.", category="teach_options")

add("tp_annot_filter", "keep only reads with a CTCF annotation",
    ["filter reads by annotation", "reads that have both annotations", "remove reads with a type",
     "reads lacking an annotation"],
    [op("annotations", "filter"),
     ex("annotations-filter", "Tick the annotation types."),
     ex("annotations-filter-mode", "Has Any keeps reads with any of them, Has All with all, Lacks All with none."),
     tr("annotations-filter-apply", "Click Apply Filter.", "filter_applied"),
     ex("clear-filter", "Clear filter on the toolbar brings every read back.")],
    "Filter reads by annotation", "Annotation filter: tick, mode, Apply (user's click).")

add("tp_annot_cluster", "cluster reads by their annotations",
    ["group molecules by annotation types", "annotation clustering", "cluster by which motifs are bound"],
    [op("annotations", "cluster"),
     tr("peaks-track", "Select the peaks to cluster at on the Peaks track.", "peak_selected", skip_if="has_selected_peak"),
     ex("annotations-cluster", "Tick the types to use as features and pick Combinatorial or K-means."),
     tr("annotations-cluster-button", "Click Cluster.", "clustered"),
     ex("clusters-overview", "Each cluster is a combination of annotation types.", requires="has_clusters")],
    "Cluster by annotations", "Annotation clustering needs selected peaks; then Cluster (user's click).")

add("tp_annot_profile", "where is each annotation type enriched in this window?",
    ["annotation density along the region", "annotation profile", "plot annotation positions"],
    [op("annotations", "profile"),
     ex("annotations-profile", "Profile shows each type's density across the view; peaks mark where it's common.")],
    "Annotation density profile", "Reading the Profile tab.", category="teach_read")

add("tp_annot_where", "where are the per-read annotation settings?",
    ["where are annotation bigbeds managed", "where is the annotations panel", "open annotations"],
    [op("annotations", "files"), ex("annotations-files", "Annotations holds the per-read annotation files and their tabs.")],
    "Where Annotations is", "Where-is.", category="teach_where")

add("tp_annot_what_mode", "what is the difference between has any and has all?",
    ["what does lacks all do", "has all vs lacks all", "annotation filter modes"],
    [op("annotations", "filter"),
     ex("annotations-filter-mode", "Has Any: at least one ticked type; Has All: every ticked type; Lacks All: none of them.")],
    "Annotation filter modes", "What-does question.", category="teach_what")

# ═════════════════════════════════════════════════════════════════════
# Capture panel
# ═════════════════════════════════════════════════════════════════════

add("tp_capture_walk", "how do I design capture targets?",
    ["make a capture panel", "targeted enrichment regions", "export regions for a probe order",
     "walk me through capture", "build a capture design from peaks"],
    [op("capture", "cart"),
     tr("peaks-track", "Select the peaks you want to target (Cmd/Ctrl+click for several).", "peak_selected",
        skip_if="has_selected_peak"),
     ex("capture-target", "The target preview shows the region those peaks span."),
     ex("capture-padding", "Padding adds bp on each side."),
     ex("capture-add-bounding", "+ Bounding adds that region; + Viewport adds the whole view."),
     ex("capture-export-format", "In Export, pick BED, Twist TSV, FASTA or Probe TSV and Download.")],
    "Design capture targets", "Capture: select peaks, preview, padding, add, export.")

add("tp_capture_export", "how do I export my capture regions for twist?",
    ["download capture regions", "export probes", "capture fasta", "send regions to a vendor"],
    [op("capture", "export"),
     ex("capture-export-format", "Pick Twist TSV (or BED, FASTA, Probe TSV; FASTA and probes need a reference)."),
     ex("capture-download", "Download saves the file.")],
    "Export capture regions", "Point at format and Download.", category="teach_options")

add("tp_capture_viewport", "add the whole view to capture",
    ["add the visible window as a capture target", "capture the current window", "add this region to the capture cart"],
    [op("capture", "cart"),
     ex("capture-add-region", "+ Viewport adds the current view as a capture region, with the padding."),
     ex("capture-regions-tab", "The Regions tab lists them with their sizes.")],
    "Add the view to capture", "Point at + Viewport.", category="teach_options")

add("tp_capture_padding", "how much padding should capture regions have?",
    ["change the capture padding", "extend capture regions", "per-region padding"],
    [op("capture", "cart"),
     ex("capture-padding", "Padding is added on both sides of every region; each region in the list can also have its own."),
     ex("capture-regions-tab", "Sizes in the list include the padding.")],
    "Capture padding", "Options.", category="teach_options")

add("tp_capture_where", "where is the capture cart kept?",
    ["take me to the capture regions", "where is capture", "open the capture panel"],
    [op("capture", "cart"), ex("capture-regions-tab", "Capture > Regions is the cart of regions to target.")],
    "Where Capture is", "Where-is.", category="teach_where")

add("tp_capture_bounding_greyed", "why can't I click + bounding?",
    ["I can't add a bounding region", "bounding is greyed out", "capture add bounding disabled"],
    [ex("capture-target", "+ Bounding needs selected peaks on one chromosome; the target preview shows what's selected."),
     tr("peaks-track", "Select a peak on the Peaks track.", "peak_selected", skip_if="has_selected_peak"),
     ex("capture-add-bounding", "Now + Bounding is available.")],
    "Why + Bounding is disabled", "Prerequisite: selected peaks.", category="teach_followup")

# ═════════════════════════════════════════════════════════════════════
# Read Stats
# ═════════════════════════════════════════════════════════════════════

RS_SELECT = [
    ex("reads-track", "Each row is one molecule."),
    tr("reads-track", "Shift+click reads to select them; Read Stats opens with their numbers.", "reads_selected",
       skip_if="has_selected_reads"),
]

add("tp_rs_walk", "how do I get stats on specific reads?",
    ["read statistics", "how long are these reads", "what's the accessibility of these molecules",
     "walk me through read stats", "stats for the reads I picked"],
    RS_SELECT + [
        ex("read-stats-summary", "Summary: accessibility, footprint counts and sizes, length, MAPQ and strand.",
           requires="has_selected_reads"),
        ex("read-stats-table", "Table lists each read on its own row."),
        ex("read-stats-distributions", "Distributions shows histograms across the selection.")],
    "Read Stats", "Shift+click (try_it reads_selected), then the three tabs.")

add("tp_rs_cluster_reads", "stats for every read in a cluster",
    ["read stats for cluster 2", "select all reads of a cluster", "summarize one cluster's reads"],
    [ex("cluster-focus-bar", "Click the cluster's colour in the bar left of the reads to focus it.", requires="has_clusters"),
     op("read-stats"),
     ex("read-stats-select-cluster", "Select cluster reads picks every read of the focused cluster."),
     ex("read-stats-summary", "Summary then describes that cluster.", requires="has_selected_reads")],
    "Read Stats for a cluster", "Cluster focus + Select cluster reads.", clustered=(0,))

add("tp_rs_export", "how do I export read stats?",
    ["save the read table", "download read statistics", "copy read stats"],
    [op("read-stats"),
     ex("read-stats-export", "TSV downloads one row per read; Copy TSV and JSON are next to it.", requires="has_selected_reads")],
    "Export Read Stats", "Options.", category="teach_options")

add("tp_rs_distributions", "how do I read the read stats distributions?",
    ["what do the read stats histograms mean", "what are the histograms in read stats", "interpret read stats distributions"],
    [op("read-stats", "distributions"),
     ex("read-stats-distributions", "Each histogram is the selected reads' spread: accessibility %, footprint size, read length, MAPQ and modification %; whiskers are 95% intervals.",
        requires="has_selected_reads")],
    "Reading Read Stats distributions", "Reading results.", category="teach_read")

add("tp_rs_deselect", "how do I clear my read selection?",
    ["get rid of the selected reads", "deselect reads", "unselect the molecules"],
    [op("read-stats"), ex("read-stats-deselect", "Deselect clears the selection.", requires="has_selected_reads")],
    "Clear the read selection", "Point at Deselect.", category="teach_options")

add("tp_rs_where", "where is read stats?",
    ["how do I get to read statistics", "open the read stats panel", "read statistics panel"],
    [ex("reads-track", "Shift+click reads to open Read Stats with them.")],
    "Where Read Stats is", "Where-is: Shift+click.", category="teach_where")

add("tp_rs_what_accessibility", "what does accessibility percent mean for a read?",
    ["what does the accessibility number in read stats mean", "read accessibility explained", "what is accessibility_pct"],
    [ex("read-stats-summary", "The share of the read's length not covered by footprints: open DNA on that molecule.",
        requires="has_selected_reads")],
    "Read accessibility %", "What-does question.", category="teach_what")

# ═════════════════════════════════════════════════════════════════════
# Contact map (Micro-C / DAF-C) and two-locus views
# ═════════════════════════════════════════════════════════════════════

add("tp_contacts_load", "how do I load a contact map?",
    ["load my mcool", "open a Micro-C file", "load a hic cooler", "add DAF-C contacts"],
    [ex("load-dataset", "Load File opens a .cool or .mcool contact map like any other file."),
     ex("load-dataset", "Click Load File and pick the .mcool."),
     op("contact-map", "map"),
     ex("contacts-map", "The Map tab then shows the contact matrix for the view.")],
    "Load a contact map", "Contact maps load through Load File; then the Contacts panel.")

add("tp_contacts_settings", "how do I show contacts under the reads?",
    ["contact arcs under the reads", "matrix strip under the reads", "virtual 4C track",
     "show micro-c on the reads"],
    [op("contact-map", "settings"),
     ex("contacts-track-overlay", "Track overlay picks Matrix strip, Arcs or Virtual 4C, and the maximum distance."),
     ex("contacts-matrix-settings", "Matrix strip sets scale, colours and normalization (Raw, Balanced, O/E local or global)."),
     ex("contacts-arcs-settings", "Arcs sets the minimum distance, normalization and strength."),
     ex("contacts-v4c-settings", "Virtual 4C sets normalization and smoothing for the viewpoint profile.")],
    "Contact overlays under the reads", "Contacts > Settings sections.")

add("tp_contacts_open_regions", "how do I see the reads behind a contact?",
    ["open both ends of a contact", "which molecules make this contact", "linked reads for a contact"],
    [op("contact-map", "map"),
     ex("contacts-map", "Drag a rectangle on the contact map around the contact."),
     ex("contacts-open-regions", "Open Regions opens both ends as linked panels of the reads that join them.")],
    "Reads behind a contact", "Select on the map, then Open Regions.")

add("tp_contacts_two_loci", "how do I look at two distant loci side by side?",
    ["view eve and hb together", "compare two loci", "split view of two genes",
     "two regions linked"],
    [op("contact-map", "map"),
     ex("contacts-locus-inputs", "Type a gene or region in Locus X and Locus Y."),
     tr("contacts-create-split", "Click Create Split View.", "panel_copy_made"),
     ex("contacts-split-current", "Split Current View halves the current view instead.")],
    "Two loci side by side", "Without a contact map, the Contacts panel compares loci.")

add("tp_contacts_haplotype", "how do I compare the two haplotypes of a region?",
    ["look at the two alleles", "maternal vs paternal", "side by side haplotype view",
     "compare phased haplotypes"],
    [op("contact-map", "compare"),
     ex("haplotype-compare", "Compare haplotypes opens each haplotype of a region as its own panel."),
     ex("haplotype-form", "Pick the region and the haplotype references, then open the comparison."),
     ex("reference-pairs", "Haplotypes come from FASTA/annotation pairs loaded in Reference & Tracks.")],
    "Haplotype comparison", "Contacts > Compare haplotypes; needs reference pairs.")

add("tp_contacts_norm", "what normalization should I use for the contact map?",
    ["balanced vs O/E", "contact map normalization", "o/e global or local"],
    [op("contact-map", "settings"),
     ex("contacts-matrix-settings", "Raw is counts; Balanced corrects coverage bias; O/E divides by the distance expectation (local to this view, or global)."),
     ex("contacts-matrix-settings", "O/E makes loops and domains stand out from the distance decay.")],
    "Contact map normalization", "Options.", category="teach_options")

add("tp_contacts_where", "where are the micro-c settings?",
    ["where are the contact map display settings", "where are the contact settings", "contact map options"],
    [op("contact-map", "settings"), ex("contacts-settings", "Contacts > Settings holds the overlay, matrix, arcs and Virtual 4C settings.")],
    "Where contact settings are", "Where-is.", category="teach_where")

add("tp_contacts_what_v4c", "what is virtual 4C?",
    ["what does the virtual 4C profile mean", "explain virtual 4C", "what does the viewpoint profile show"],
    [op("contact-map", "settings"),
     ex("contacts-v4c-settings", "Virtual 4C picks one viewpoint and plots how often it contacts every other position in the view, like a 4C experiment.")],
    "Virtual 4C", "What-does question.", category="teach_what")

# ═════════════════════════════════════════════════════════════════════
# Layout panel (merge / link / arrangements)
# ═════════════════════════════════════════════════════════════════════

add("tp_layout_walk", "how do I arrange my dataset panels?",
    ["organize the panels", "walk me through the layout panel", "group my samples",
     "link and merge panels"],
    [ex("layout-menu", "Layout arranges panels side by side or stacked; its menu also opens the Layout panel."),
     op("dataset-layout"),
     ex("layout-select-panel", "Tick panels here to act on them."),
     ex("layout-merge", "Merge combines their reads into one panel; Link makes them move together."),
     ex("layout-tree", "The tree shows what is merged, what is linked, and what moves alone."),
     ex("layout-save-arrangement", "Save Arrangement keeps the whole setup under a name.")],
    "Arranging dataset panels", "Walk the Layout panel.", ds=DS_THREE)

add("tp_layout_merge", "merge my two replicates into one panel",
    ["combine replicate datasets", "pool two BAMs", "merge samples"],
    [op("dataset-layout"),
     ex("layout-select-panel", "Tick both replicate panels."),
     ex("layout-merge", "Click Merge; their reads show together in one panel."),
     ex("layout-unmerge", "Unmerge splits them back into their files.")],
    "Merge datasets", "Merging is the user's click in the Layout panel.", ds=DS_THREE)

add("tp_layout_link", "make two panels move together",
    ["link panels", "sync panels", "keep panels on the same region"],
    [op("dataset-layout"),
     ex("layout-select-panel", "Tick the panels."),
     ex("layout-link", "Link puts them in one group so they move together."),
     ex("layout-unlink", "Unlink lets each move on its own again.")],
    "Link panels", "Link/Unlink in the Layout panel.", ds=DS_THREE)

add("tp_layout_rename", "how do I give a dataset a new name?",
    ["edit a dataset's display name", "change a sample's label", "rename the panel"],
    [op("dataset-layout"), ex("layout-rename", "Click the dataset's label here and type a new name.")],
    "Rename a dataset", "Options.", category="teach_options")

add("tp_layout_save", "save this panel arrangement",
    ["reuse my layout", "save my dataset setup", "load a saved arrangement"],
    [op("dataset-layout"),
     ex("layout-save-arrangement", "Type a name under Save Arrangement and click Save."),
     ex("layout-saved-arrangements", "Saved Arrangements reloads it later, with its datasets and groups.")],
    "Save an arrangement", "Options.", category="teach_options", ds=DS_THREE)

add("tp_layout_reset", "my panels are a mess, how do I reset them?",
    ["reset the layout", "panels are tiny", "restore default panel sizes"],
    [op("dataset-layout"),
     ex("layout-reset", "Reset puts rows, sizes and tracks back to the default layout."),
     ex("layout-menu", "The Layout menu also evens out panel widths.")],
    "Reset the layout", "Point at Reset.", category="teach_followup", ds=DS_THREE)

add("tp_layout_what_tree", "what does the merge link tree show?",
    ["what does the tree in the layout panel mean", "explain the layout tree", "what is a link group"],
    [op("dataset-layout"),
     ex("layout-tree", "Each branch is a group: merged panels share one set of reads, linked panels share one view.")],
    "The Merge / Link Tree", "What-does question.", category="teach_what", ds=DS_THREE)

# ═════════════════════════════════════════════════════════════════════
# Labeling (colour rules)
# ═════════════════════════════════════════════════════════════════════

LABEL_EDIT = [
    op("colormap", "rules"),
    ex("labeling-rule-row", "Each rule colours footprints that match it; the top rule wins."),
    ex("labeling-rule-edit", "Click ▸ to open a rule."),
    ex("labeling-size-range", "The size range (bp) picks which footprints it colours."),
    ex("labeling-rule-color", "Pick a colour, or a gradient across the size range."),
]

add("tp_label_walk", "how do the colour rules work?",
    ["explain labeling rules", "how are footprints coloured", "walk me through labeling",
     "what decides footprint colours"],
    LABEL_EDIT + [
        ex("labeling-target-layers", "Layers limits the rule to some layers."),
        ex("labeling-add-condition", "+ Add condition limits it to footprints in a gene, peak, track or motif.")],
    "How labeling rules colour footprints", "Walk a rule top to bottom.")

add("tp_label_tf_sized", "colour TF-sized footprints red",
    ["make small footprints red", "highlight footprints between 10 and 60 bp", "colour nucleosomes blue"],
    [op("colormap", "rules"),
     ex("add-label-rule", "Click + Rule for a new rule."),
     ex("labeling-size-range", "Set the size range, e.g. 10–60 bp for TF-sized footprints."),
     ex("labeling-rule-color", "Choose red."),
     ex("labeling-rule-row", "Drag it to the top so it wins over broader rules.")],
    "A size-based colour rule", "Adding a rule is the user's click; walk its size and colour.")

add("tp_label_condition", "colour footprints only inside peaks",
    ["colour footprints in a gene", "colour motif-overlapping footprints", "rule that only applies in eve"],
    LABEL_EDIT[:3] + [
        ex("labeling-add-condition", "+ Add condition, then choose In peak, In gene, In track or In motif track (NOT inverts it)."),
        ex("labeling-rule-row", "The rule now colours only footprints that meet its conditions.")],
    "A conditional colour rule", "Conditions on a rule.", category="teach_options")

add("tp_label_quality_gate", "only colour confident FIRE calls",
    ["colour high quality calls only", "quality gate on a colour rule", "hide low confidence footprints colours"],
    LABEL_EDIT[:3] + [
        ex("labeling-add-gate", "+ Add quality gate: e.g. aq ≥ 230 keeps only confident FIRE calls."),
        ex("labeling-quality", "The Quality tab sets filters for every rule at once.")],
    "Quality gates on a rule", "Options: quality gates.", category="teach_options")

add("tp_label_layers", "make a rule only apply to the TF layer",
    ["colour rule for the TF layer only", "colour only nucleosome layer", "restrict a colour rule to one layer"],
    LABEL_EDIT[:3] + [ex("labeling-target-layers", "Under Layers, pick the layer; with none picked it applies to all.")],
    "Layer-specific colour rules", "Options.", category="teach_options")

add("tp_label_display", "how do I change the background colour of reads?",
    ["dark read background", "change the canvas colour", "dim unmatched footprints"],
    [op("colormap", "rules"),
     ex("labeling-display-options", "Display options sets read and canvas backgrounds, unmatched layer opacity and edge shading.")],
    "Read display colours", "Options.", category="teach_options")

add("tp_label_where", "where do the footprint colour rules live?",
    ["where do I edit footprint colours", "open the labeling rules", "where do I set footprint colours"],
    [op("colormap", "rules"), ex("labeling-rules", "Labeling > Rules holds the colour rules.")],
    "Where Labeling is", "Where-is.", category="teach_where")

add("tp_label_what_order", "why does rule order matter in labeling?",
    ["which colour rule takes priority", "which labeling rule wins", "two rules colour the same footprint"],
    [op("colormap", "rules"),
     ex("labeling-rule-row", "Rules are checked top to bottom and the first match colours the footprint; drag ≡ to reorder.")],
    "Labeling rule order", "What-does question.", category="teach_what")

# ═════════════════════════════════════════════════════════════════════
# Clusters panel in depth
# ═════════════════════════════════════════════════════════════════════

add("tp_clusters_vplot", "how do I read the V-plot?",
    ["what is the V-plot", "interpret the v plot", "footprint size vs position plot"],
    [op("cluster-detail", "vplot"),
     ex("clusters-vplot", "Each point is a footprint: position on x, size on y; nucleosomes form a ~147 bp band, TFs sit low.",
        requires="has_clusters"),
     ex("clusters-vplot-settings", "V-plot settings change the size bins, layer and axes.")],
    "Reading the V-plot", "Result tab of Clusters.", category="teach_read", clustered=(0,))

add("tp_clusters_projection", "how do I see if my clusters are really distinct?",
    ["cluster projection", "umap of reads", "are my clusters separated", "pca of the clusters"],
    [op("cluster-detail", "projection"),
     ex("clusters-projection", "Projection places every read by its features and colours it by cluster.", requires="has_clusters"),
     ex("clusters-projection-controls", "Method picks PCA, UMAP or t-SNE; View shows before or after Merge similar clusters."),
     ex("clusters-merge-preview", "Clusters that overlap here are merge candidates; the settings preview what would merge.")],
    "Checking cluster separation", "Projection tab.", category="teach_read", clustered=(0,))

add("tp_clusters_composition", "what footprints make up each cluster?",
    ["footprint type mix per cluster", "cluster composition breakdown", "which footprint types are in cluster 3"],
    [op("cluster-detail", "composition"),
     ex("clusters-composition", "Composition shows each cluster's mix of footprint types.", requires="has_clusters")],
    "Cluster composition", "Result tab.", category="teach_read", clustered=(0,))

add("tp_clusters_enrichment", "which rules are enriched in each cluster?",
    ["cluster enrichment", "is my TF rule enriched in a cluster", "fisher test per cluster"],
    [op("cluster-detail", "enrichment"),
     ex("clusters-enrichment", "Enrichment tests each rule in each cluster against the rest; it appears once you have a labeling or cluster rule.",
        requires="has_clusters")],
    "Cluster enrichment", "Enrichment tab needs a rule.", category="teach_read", clustered=(0,))

add("tp_clusters_save_restore", "can I save a clustering and come back to it?",
    ["save these clusters", "snapshot the clustering", "restore an old clustering"],
    [op("cluster-detail", "overview"),
     ex("cluster-snapshot", "Snapshot saves the current clustering.", requires="has_clusters"),
     ex("clusters-saved", "The Saved tab lists snapshots; restore one to bring its clusters back.")],
    "Save and restore clusterings", "Options.", category="teach_options", clustered=(0,))

add("tp_clusters_branch", "how do I subcluster one cluster?",
    ["break cluster 2 into subclusters", "recluster within a cluster", "cluster branches"],
    [op("cluster-detail", "overview"),
     ex("cluster-focus-bar", "Focus the cluster by clicking its colour in the bar left of the reads.", requires="has_clusters"),
     tr("cluster-button", "Click Cluster again: it clusters just the focused reads into a branch.", "clustered"),
     ex("cluster-branches", "The branch map shows the parent clustering and its branches; click one to switch.")],
    "Subclustering into branches", "Subclustering by focus + Cluster.", clustered=(0,))

add("tp_clusters_dynamic", "what does dynamic reassignment do to my clusters?",
    ["do clusters update when I pan", "clusters change when I move", "turn off dynamic clustering"],
    [op("cluster-detail", "overview"),
     ex("cluster-dynamic", "Dynamic reassignment re-assigns reads as you pan, using the clusters' patterns; turn it off to freeze them.",
        requires="has_clusters")],
    "Dynamic reassignment", "What-does question.", category="teach_what", clustered=(0,))

add("tp_clusters_profiles_read", "how do I compare the clusters' profiles?",
    ["how do the cluster profiles differ", "average profile per cluster", "where do my clusters differ"],
    [op("cluster-detail", "profiles"),
     ex("clusters-profiles", "Profiles overlays each cluster's average accessibility; where the lines split is what distinguishes them.",
        requires="has_clusters")],
    "Comparing cluster profiles", "Result tab.", category="teach_read", clustered=(0,))

# ═════════════════════════════════════════════════════════════════════
# Footprints panel in depth (classes / consensus caller)
# ═════════════════════════════════════════════════════════════════════

add("tp_fp_classes_walk", "how do I find the footprint classes in this view?",
    ["run the footprint class caller", "find recurrent footprints", "consensus footprint calling",
     "what TF footprints recur here", "walk me through footprint classes"],
    [op("footprint-analysis", "states"),
     ex("footprints-assay", "Footprint classes need each dataset's assay (DAF-seq DddA/DddB or Fiber-seq Hia5); set it here if asked."),
     ex("footprints-consensus", "Footprint classes finds the footprint states that recur in the view across molecules."),
     ex("consensus-caller", "Find footprint classes runs it on the view and selected datasets; it can take a minute."),
     ex("footprints-class-list", "The classes it finds are listed with size and count; click one to filter the reads to it.")],
    "Finding footprint classes", "Walk the Classes tab; running the caller is the user's click.")

add("tp_fp_stringency", "what does assignment stringency do?",
    ["make class assignment stricter", "loosen the footprint class assignment", "stringency slider"],
    [op("footprint-analysis", "states"),
     ex("footprints-stringency", "Assignment stringency, from Strict to Loose, sets how closely a call must match its class; moving it re-assigns calls live.")],
    "Assignment stringency", "What-does question.", category="teach_what")

add("tp_fp_classes_filter", "show only reads with one footprint class",
    ["keep only molecules with a given footprint class", "filter reads by footprint class", "reads carrying class 2"],
    [op("footprint-analysis", "states"),
     ex("footprints-class-list", "Click a class to filter the reads to molecules that carry it."),
     ex("clear-filter", "Clear filter on the toolbar brings every read back.")],
    "Filter by footprint class", "Class click filters.", category="teach_options")

add("tp_fp_compare_strands", "compare footprint classes between strands",
    ["do the CT and GA strands agree", "compare footprints between my datasets", "strand comparison"],
    [op("footprint-analysis", "states"),
     ex("footprints-compare", "Compare strands and datasets shows how each class's occupancy differs between strands or samples.")],
    "Comparing classes across strands", "Options.", category="teach_options")

add("tp_fp_sizes_read", "what does the selected footprint box show?",
    ["what is the size histogram for my footprint", "footprint size histogram", "explain the selected footprint section"],
    [op("footprint-analysis", "states"),
     ex("footprints-sizes", "The size range saved for this footprint, over the size histogram of nearby footprints; drag the range to adjust it.",
        requires="has_selected_footprint")],
    "The selected footprint block", "Reading the size block.", category="teach_read")

add("tp_fp_saved_export", "how do I export my saved footprints?",
    ["save footprint definitions to a file", "export footprint sequences fasta", "share footprints"],
    [op("footprint-analysis", "saved"),
     ex("footprints-saved-export", "Export saves the definitions, or their sequences as FASTA.", requires="has_saved_footprints"),
     ex("footprints-saved-load", "Load brings saved definitions back from a file.")],
    "Export saved footprints", "Options.", category="teach_options")

add("tp_fp_cooccupancy_read", "how do I read the co-occupancy tab?",
    ["what does footprint co-occupancy show", "are two footprints bound together",
     "interpret co-occupancy"],
    [op("footprint-analysis", "co-occ"),
     ex("footprints-cooccupancy", "Each saved footprint's occupancy, and for pairs how often both are bound on the same molecule versus chance."),
     ex("footprints-cluster-by-groups", "Cluster reads by these footprints groups molecules by which ones they carry.",
        requires="has_saved_footprints"),
     ex("footprints-membership-legend", "The legend then tells what each cluster carries.")],
    "Reading co-occupancy", "Result tab.", category="teach_read")

add("tp_fp_assay_where", "where do I set the assay type?",
    ["footprint classes ask for the assay", "set DAF-seq or fiber-seq", "dataset assay types"],
    [op("footprint-analysis", "states"),
     ex("footprints-assay", "Dataset assay types sets each dataset's assay; it's saved with the session.")],
    "Where the assay type is set", "Where-is.", category="teach_where")

# ═════════════════════════════════════════════════════════════════════
# Tracks and motifs
# ═════════════════════════════════════════════════════════════════════

add("tp_motif_jaspar", "how do I add a JASPAR motif?",
    ["show CTCF motifs", "add a motif track", "search JASPAR", "where are GAGA factor motifs"],
    [ex("open-tracks", "Open Tracks... opens the Tracks panel."),
     op("track-browser"),
     ex("tracks-motif-search", "Type a TF or motif name here; JASPAR matches appear as you type."),
     tr("tracks-motif-search", "Pick the motif to add it as a track.", "track_added"),
     ex("tracks-motif-options", "Motif options sets the match threshold for hits.")],
    "Add a JASPAR motif", "Motif search in the Tracks add box; adding is the user's click.")

add("tp_motif_sequence", "can I search for a DNA sequence motif?",
    ["find GATA sites", "add a sequence motif", "search for a consensus sequence"],
    [op("track-browser"),
     ex("tracks-motif-search", "Type the DNA sequence (IUPAC letters work) in the add box and choose Add sequence motif."),
     ex("tracks-row", "It appears as a track with every match in view.", requires="has_tracks")],
    "Sequence motifs", "Add box accepts sequences.", category="teach_options")

add("tp_motif_file", "how do I load my own motif file?",
    ["load a MEME file", "add a HOMER motif", "use my PWM file"],
    [op("track-browser"),
     ex("tracks-browse-files", "Browse files… takes JASPAR, MEME, HOMER or PFM motif files as well as tracks."),
     tr("tracks-browse-files", "Pick the motif file.", "track_added")],
    "Load a motif file", "Browse files accepts motif formats.")

add("tp_motif_threshold", "too many motif hits, how do I make it stricter?",
    ["motif threshold", "fewer motif matches", "raise the motif score cutoff"],
    [op("track-browser"),
     ex("tracks-motif-options", "Raise Match threshold under Motif options; it applies to every motif track and footprint motif scan."),
     ex("tracks-row", "Each motif track can also hide hits below its own score.", requires="has_tracks")],
    "Motif match threshold", "Options.", category="teach_options")

add("tp_tracks_row", "how do I change a track's colour or scale?",
    ["recolour a signal track", "flip a track negative", "scale a bigwig"],
    [op("track-browser"),
     ex("tracks-row", "Each row is a loaded track: hide or show it, set its colour and scale, or flip it negative.",
        requires="has_tracks")],
    "Track colour and scale", "Options.", category="teach_options")

add("tp_tracks_cart", "save my tracks so I can reload them",
    ["export the track list", "load my set of tracks", "show all tracks at once"],
    [op("track-browser"),
     ex("tracks-cart-actions", "Track actions shows or hides every track, and saves or loads the track list as JSON.")],
    "Saving the track list", "Options.", category="teach_options")

add("tp_tracks_where_add", "where do I add a bigwig?",
    ["add a signal track", "load chip-seq signal", "where do tracks go"],
    [op("track-browser"),
     ex("tracks-add-file", "Paste a path or URL in the add box, or Browse files… for a file on disk."),
     ex("tracks-browse-hubs", "Browse hubs… searches UCSC, ENCODE and ChIP-Atlas.")],
    "Where to add tracks", "Where-is.", category="teach_where")

# ═════════════════════════════════════════════════════════════════════
# Follow-ups across the panels
# ═════════════════════════════════════════════════════════════════════

T_PEAKRULES = turn("how do the peak rules work?", "How peak rules turn a signal into peaks",
                   ["open_panel", "explain", "explain", "explain", "explain", "try_it"])
T_TX = turn("how do I look at Pol II states on a gene?", "Pol II states at a gene",
            ["navigate_gene", "explain", "try_it", "explain", "explain"])
T_COACC = turn("how do I check which positions open together?", "Co-accessibility between positions",
               ["navigate_region", "open_panel", "explain", "explain", "explain"])
T_CAPTURE = turn("how do I design capture targets?", "Design capture targets",
                 ["open_panel", "try_it", "explain", "explain", "explain", "explain"])

add("tp_fu_peaks_now_what", "ok I scanned, now what?",
    ["I have peaks, what can I do with them", "peaks are called, what next", "what do I do with the peaks"],
    [ex("peaks-track", "Click a peak to select it; Cmd/Ctrl+click adds more."),
     ex("cluster-button", "With peaks selected you can cluster the reads on them,"),
     ex("primers-design-tab", "design primers around them in Primers,"),
     ex("capture-regions-tab", "or add them to Capture as target regions.")],
    "What to do with peaks", "Follow-up after scanning.", category="teach_followup",
    previous_turns=[T_PEAKRULES])

add("tp_fu_tx_filter_next", "now how do I keep only those reads?",
    ["keep only reads in that state", "filter to them", "show only those reads"],
    [op("transcription-state", "filters"),
     ex("transcription-states", "Tick the states you want to keep.", requires="has_selected_gene"),
     tr("transcription-apply", "Click Apply.", "filter_applied")],
    "Filter to the Pol II state", "Follow-up to the Transcription walk.", category="teach_followup",
    previous_turns=[T_TX], state_overrides=GENE_EVE)

add("tp_fu_coacc_what_red", "what are the red blocks?",
    ["what do the hot spots mean", "what does red mean", "and the dark squares?"],
    [ex("coacc-normalization", "With O/E, red means two positions open together more than their own accessibility predicts."),
     ex("coacc-matrix", "A red block off the diagonal links two elements that open on the same molecules.")],
    "Reading co-accessibility colours", "Follow-up to the co-accessibility walk.", category="teach_followup",
    previous_turns=[T_COACC], ctx=V_DM6_EVE_TIGHT)

add("tp_fu_capture_export", "done, how do I get the file?",
    ["how do I save the regions now", "how do I download it", "export it now"],
    [op("capture", "export"),
     ex("capture-export-format", "Pick the format."),
     ex("capture-download", "Click Download.")],
    "Download the capture file", "Follow-up to the capture walk.", category="teach_followup",
    previous_turns=[T_CAPTURE])

# ═════════════════════════════════════════════════════════════════════
# More contexts: the same panels on other genomes and datasets
# ═════════════════════════════════════════════════════════════════════

add("tp_tx_myc", "is MYC paused in my data?",
    ["Pol II pausing at MYC", "transcription state at MYC", "elongating Pol II on MYC"],
    [nav("MYC")] + TX_OPEN + [
        ex("transcription-states", "Pause counts reads with Pol II 10-50 bp into MYC; compare it with Elongating.",
           requires="has_selected_gene"),
        ex("transcription-distribution", "Distribution shows how it splits across clusters.")],
    "Pol II pausing at MYC", "Same walk on hg38: navigate, select, read the states.", ctx=V_HG38_MYC)

add("tp_coacc_tp53", "co-accessibility at the TP53 promoter",
    ["which TP53 regions open together", "are TP53 enhancers open together", "coordinated opening at TP53"],
    [region("chr17", 7_686_000, 7_690_000)] + COACC_OPEN + [
        ex("coacc-normalization", "O/E (marginal) shows which pairs open together more than expected.")],
    "Co-accessibility at TP53", "Navigate to a read-length window at the promoter, then the matrix.",
    ctx=V_HG38_TP53)

add("tp_annot_pax6", "filter my Pax6 reads by annotation",
    ["annotation types on Pax6 molecules", "reads with an annotation at Pax6", "annotation filter at Pax6"],
    [nav("Pax6"), op("annotations", "filter"),
     ex("annotations-filter", "Tick the types to filter on."),
     ex("annotations-filter-mode", "Choose Has Any, Has All or Lacks All."),
     tr("annotations-filter-apply", "Click Apply Filter.", "filter_applied")],
    "Annotation filter at Pax6", "Navigate, then the annotation filter.", ctx=V_MM10_PAX6)

add("tp_rs_hb", "stats for reads at hb",
    ["summarize the molecules at hb", "how accessible are hb reads", "read stats at hunchback"],
    [nav("hb")] + RS_SELECT + [ex("read-stats-summary", "Summary shows their accessibility and footprints.",
                                  requires="has_selected_reads")],
    "Read Stats at hb", "Navigate, Shift+click, read Summary.", ctx=V_DM6_HB)

add("tp_capture_x", "capture regions around gt",
    ["enrichment targets near gt", "capture design at giant", "target gt for enrichment"],
    [nav("gt"), op("capture", "cart"),
     tr("peaks-track", "Select the peaks around gt.", "peak_selected", skip_if="has_selected_peak"),
     ex("capture-add-bounding", "+ Bounding adds their span, with padding."),
     ex("capture-export-format", "Export it from the Export tab.")],
    "Capture at gt", "Navigate then the capture walk.", ctx=V_DM6_X)

add("tp_peaks_sna_fire", "call FIRE peaks at snail",
    ["find accessible elements at sna with FIRE", "FIRE peaks at sna", "peak calling at snail"],
    [nav("sna"), op("peak-detection"),
     ex("peak-rule-source", "Set a rule's Source to FIRE for confident accessible elements."),
     tr("scan-peaks-button", "Click Scan.", "peaks_scanned")],
    "FIRE peaks at sna", "Navigate then a FIRE rule and Scan.", ctx=V_DM6_2L)

add("tp_layout_single", "can I merge when I only have one dataset?",
    ["the merge button doesn't work", "merge is greyed out", "why can't I merge"],
    [op("dataset-layout"),
     ex("layout-merge", "Merge combines two or more dataset panels, so it needs a second dataset."),
     ex("load-dataset", "Load another with Load File first.")],
    "Merging needs two datasets", "Prerequisite explanation.", category="teach_followup", ds=DS_FIBER_ONLY)


# ═════════════════════════════════════════════════════════════════════
# Second pass: options and results not covered above
# ═════════════════════════════════════════════════════════════════════

# ── Peaks ───────────────────────────────────────────────────────────
add("tp_peaks_track_read", "what do the colours on the peaks track mean?",
    ["how do I read the peaks track", "why are there several rows of peaks", "peak track shading"],
    [ex("peaks-track", "Each enabled rule draws its peaks in its own colour; darker means a stronger cutoff level."),
     ex("peak-rules", "Peak rules lists the rules behind each colour.")],
    "Reading the Peaks track", "Reading the Peaks track.", category="teach_read")

add("tp_peaks_clear_selection", "how do I unselect all the peaks?",
    ["drop every selected peak", "deselect peaks", "start my peak selection over"],
    [ex("peaks-controls-expand", "Click the Peaks label to show its controls."),
     ex("peak-clear-selection", "Clear peak selection deselects every peak.")],
    "Clear the peak selection", "Point at the clear button.", category="teach_options")

add("tp_peaks_select_many", "how do I select several peaks at once?",
    ["pick more than one peak", "multi-select peaks", "choose three peaks to cluster on"],
    [ex("peaks-track", "Click a peak to select it; Cmd/Ctrl+click adds more peaks, and clicking a selected peak again drops it."),
     tr("peaks-track", "Select the peaks you want.", "peak_selected", skip_if="has_selected_peak"),
     ex("peaks-lock", "Lock the peaks so a rescan can't move them while you work.")],
    "Selecting several peaks", "Selection is the user's clicks on the Peaks track.", category="teach_options")

# ── Regions ─────────────────────────────────────────────────────────
add("tp_regions_open_one", "open just one saved region",
    ["go to a saved region", "view one bookmarked region", "jump to a region from the list"],
    [op("circular-genome"),
     ex("regions-saved", "Under each saved region, Go moves the main view there and Open adds it as a panel copy beside the others.")],
    "Opening a saved region", "Options.", category="teach_options")

add("tp_regions_clear", "clear my saved regions",
    ["empty the region list", "remove all saved regions", "delete a saved region"],
    [op("circular-genome"),
     ex("regions-saved", "Clear next to Saved regions empties the list; the x on a region removes just that one.")],
    "Clearing saved regions", "Options.", category="teach_options")

add("tp_regions_plasmid_features", "where do my plasmid's features show up?",
    ["see the genes on my plasmid", "plasmid annotations", "features of the loaded construct"],
    [ex("gene-track", "A loaded plasmid map's features are drawn in the gene track, like genes."),
     op("circular-genome"),
     ex("regions-lens", "The Regions zoom window map shows them too.")],
    "Plasmid features", "Plasmid features in the gene track and the Regions zoom window.", category="teach_read", ctx=V_PLASMID)

# ── History ─────────────────────────────────────────────────────────
add("tp_history_redo", "how do I redo something I undid?",
    ["reverse an undo", "bring back what I undid", "redo shortcut"],
    [ex("redo", "Redo (Cmd/Ctrl+Shift+Z) re-applies the change you just undid."),
     ex("history-timeline", "Or open the history ▾ and click the later step.")],
    "Redo", "Point at Redo.", category="teach_options")

add("tp_history_what_covers", "what does undo cover?",
    ["can I undo navigation", "which changes are undoable", "does undo bring back deleted panels"],
    [ex("undo", "Undo covers analysis changes (clusters, filters, peaks, rules, panels); moving the view has its own history: Alt+← goes back, Alt+→ forward."),
     ex("history-steps", "Each step in the history names what changed.")],
    "What undo covers", "What-does question.", category="teach_what")

# ── Transcription ───────────────────────────────────────────────────
add("tp_tx_refresh", "the transcription counts look out of date",
    ["refresh the transcription counts", "transcription numbers didn't update", "recount Pol II states"],
    [op("transcription-state"),
     ex("transcription-apply", "Refresh, just left of Apply, reloads the counts for the selected genes.", requires="has_selected_gene"),
     ex("quality-filters", "Counts also follow the quality filters and the read sampling, so changing those changes them.")],
    "Refreshing transcription counts", "Follow-up.", category="teach_followup", state_overrides=GENE_EVE)

add("tp_tx_python", "can I get the transcription analysis in python?",
    ["transcription state in a notebook", "copy the python command for Pol II states", "reproduce the Pol II counts"],
    [op("transcription-state"),
     ex("transcription-export", "Python, next to JSON and TSV, copies the matching BrowserClient command.", requires="has_selected_gene")],
    "Transcription in Python", "Options.", category="teach_options", state_overrides=GENE_EVE)

add("tp_tx_with_focus", "transcription state for just one cluster",
    ["Pol II states of the focused reads", "Pol II states in cluster 1 only", "pausing in the focused cluster"],
    [ex("cluster-focus-bar", "Focus the cluster by clicking its colour left of the reads.", requires="has_clusters"),
     op("transcription-state"),
     ex("transcription-states", "The counts now cover only the focused cluster's reads.", requires="has_selected_gene")],
    "Transcription for one cluster", "Cluster focus scopes Transcription.", category="teach_options",
    clustered=(0,), state_overrides=GENE_EVE)

# ── Co-accessibility ────────────────────────────────────────────────
add("tp_coacc_bins", "the co-accessibility matrix is too coarse",
    ["smaller co-accessibility bins", "change the co-accessibility bin size", "higher resolution matrix"],
    [op("co-accessibility"),
     ex("coacc-settings-toggle", "Open Settings."),
     ex("coacc-min-coverage", "Bin size, just below Min coverage, sets the resolution (Auto picks one for the view); smaller bins need more reads.")],
    "Co-accessibility bin size", "Options.", category="teach_options", ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_colours", "change the co-accessibility colours",
    ["log scale for co-accessibility", "different colormap for the matrix", "sqrt scaling"],
    [op("co-accessibility"),
     ex("coacc-settings-toggle", "Open Settings."),
     ex("coacc-normalization", "Scaling (Linear, Log, Sqrt) and Colormap sit right below Normalization.")],
    "Co-accessibility display", "Options.", category="teach_options", ctx=V_DM6_EVE_TIGHT)

add("tp_coacc_refresh", "recompute co-accessibility",
    ["co-accessibility didn't update after my filter", "refresh the co-accessibility matrix", "update co-accessibility after filtering"],
    [op("co-accessibility"),
     ex("coacc-refresh", "Refresh recomputes the matrix for the current view, reads and filters.")],
    "Refresh co-accessibility", "Options.", category="teach_options", ctx=V_DM6_EVE_TIGHT)

# ── Annotations ─────────────────────────────────────────────────────
add("tp_annot_opacity", "the annotation overlays are too dark",
    ["make annotation colours lighter", "annotation overlay opacity", "fade the annotations"],
    [op("annotations", "types"),
     ex("annotations-types", "Overlay opacity at the top of Types sets how strongly annotations are drawn on the reads."),
     ex("annotations-type-list", "Each type also has its own colour and threshold.")],
    "Annotation overlay opacity", "Options.", category="teach_options")

add("tp_annot_threshold", "only show high scoring annotations",
    ["annotation score threshold", "hide weak annotation calls", "filter annotations by score"],
    [op("annotations", "types"),
     ex("annotations-type-list", "Each type in the list has a threshold slider; calls scoring below it aren't drawn.")],
    "Annotation score threshold", "Options.", category="teach_options")

add("tp_annot_profile_export", "export the annotation profile",
    ["annotation profile as a tsv", "save annotation density", "download the annotation profile table"],
    [op("annotations", "profile"),
     ex("annotations-profile", "The Profile tab's TSV button downloads each type's density across the view.")],
    "Export the annotation profile", "Options.", category="teach_options")

# ── Capture ─────────────────────────────────────────────────────────
add("tp_capture_rename_remove", "rename or remove a capture region",
    ["delete a capture region", "give a capture region a name", "change one region's padding"],
    [op("capture", "cart"),
     ex("capture-regions-tab", "In the Regions list, click a region's name to rename it, set its own padding next to it, or remove it with ×.")],
    "Editing capture regions", "Options.", category="teach_options")

add("tp_capture_fasta_needs_ref", "why can't I export capture fasta?",
    ["capture export needs a reference", "capture fasta is greyed out", "probe export disabled"],
    [op("capture", "export"),
     ex("capture-export-format", "FASTA and Probe TSV need the reference sequence."),
     ex("genome-selector", "Load a genome or FASTA in Reference & Tracks, then they're available.")],
    "Capture FASTA needs a reference", "Prerequisite.", category="teach_followup")

# ── Read Stats ──────────────────────────────────────────────────────
add("tp_rs_table", "how do I read the read stats table?",
    ["what are the columns in read stats", "per-read table explained", "read stats table columns"],
    [op("read-stats", "table"),
     ex("read-stats-table", "One row per selected read: dataset, span, footprint count and size, accessibility, modification %, MAPQ and strand.",
        requires="has_selected_reads")],
    "Reading the Read Stats table", "Reading results.", category="teach_read")

add("tp_rs_missing", "read stats says some reads are missing",
    ["selected reads not found", "missing in current scope", "why only some of my reads have stats"],
    [op("read-stats"),
     ex("read-stats-summary", "Selected reads outside the current view or filters can't be measured here; move back to where you selected them.",
        requires="has_selected_reads")],
    "Missing reads in Read Stats", "Follow-up.", category="teach_followup")

add("tp_rs_cigar", "can I see a read's alignment in read stats?",
    ["alignment details for one molecule", "show the cigar of a read", "read alignment details"],
    [op("read-stats", "summary"),
     ex("read-stats-summary", "With one read selected, Summary shows its alignment and CIGAR, with footprints and modified bases.",
        requires="has_selected_reads")],
    "One read's alignment", "Reading a single-read Summary.", category="teach_read")

# ── Contacts ────────────────────────────────────────────────────────
add("tp_contacts_matrix_look", "the contact matrix strip is too faint",
    ["change the contact colours", "log scale for contacts", "brighter micro-c matrix"],
    [op("contact-map", "settings"),
     ex("contacts-matrix-settings", "Matrix strip: Scale (Log, Sqrt, Linear), Colors and Norm change how it looks.")],
    "Contact matrix appearance", "Options.", category="teach_options")

add("tp_contacts_arcs_correction", "what is accessibility correction for arcs?",
    ["why correct arcs for accessibility", "arcs accessibility correction", "correct contacts for accessibility"],
    [op("contact-map", "settings"),
     ex("contacts-arcs-settings", "Accessibility correction scales each arc by how open its two ends are, so contacts between open sites don't dominate just by being open.")],
    "Arc accessibility correction", "What-does question.", category="teach_what")

add("tp_contacts_linked_panels", "what are the linked panels after open regions?",
    ["what are the two new panels from the contact", "what did open regions make", "two panels after selecting a contact"],
    [ex("panel-location-bar", "Each end of the contact gets its own panel with its own location.", requires="has_panel_copy"),
     ex("panel-link", "They show only the reads that join the two ends; unlink to explore each on its own.")],
    "Panels from Open Regions", "Follow-up.", category="teach_followup")

# ── Layout ──────────────────────────────────────────────────────────
add("tp_layout_unmerge", "split a merged dataset back up",
    ["undo a dataset merge", "separate merged files", "unmerge my replicates"],
    [op("dataset-layout"),
     ex("layout-select-panel", "Tick the merged panel."),
     ex("layout-unmerge", "Unmerge splits it back into one panel per file.")],
    "Unmerging datasets", "Options.", category="teach_options", ds=DS_THREE)

add("tp_layout_equal_widths", "make all panels the same width",
    ["equal panel widths", "even out the panels", "panels side by side evenly"],
    [ex("layout-menu", "The Layout menu evens out panel widths and switches side by side or stacked."),
     op("dataset-layout"),
     ex("layout-tree", "The Merge / Link Tree has buttons to link panels in pairs, all together, or none, and to equalize widths.")],
    "Even panel widths", "Options.", category="teach_options", ds=DS_THREE)

add("tp_layout_link_pairs", "link my samples in pairs",
    ["pair up the panels", "link treated with control", "link panels two by two"],
    [op("dataset-layout"),
     ex("layout-select-panel", "Tick the panels in order."),
     ex("layout-tree", "The tree's pair-link button links them two by two in panel order.")],
    "Linking panels in pairs", "Options.", category="teach_options", ds=DS_THREE)

# ── Labeling ────────────────────────────────────────────────────────
add("tp_label_gradient", "colour footprints by size with a gradient",
    ["size gradient colouring", "gradient colour rule", "colour small to large footprints"],
    LABEL_EDIT[:3] + [ex("labeling-rule-color", "Switch the colour to a gradient and set Start and End; sizes in the range blend between them.")],
    "Gradient colour rules", "Options.", category="teach_options")

add("tp_label_not_condition", "colour footprints that are not in a peak",
    ["colour outside peaks", "rule for footprints outside genes", "exclude peaks from a colour rule"],
    LABEL_EDIT[:3] + [ex("labeling-add-condition", "+ Add condition, choose In peak, and tick NOT so it matches footprints outside peaks.")],
    "NOT conditions", "Options.", category="teach_options")

add("tp_label_quality_tab", "what is the labeling quality tab?",
    ["quality tab in labeling", "labeling quality settings", "quality filters for colours"],
    [op("colormap", "quality"),
     ex("labeling-quality", "Quality sets per-layer quality filters for every rule at once, e.g. hide low-confidence TF calls.")],
    "The Labeling Quality tab", "What-does question.", category="teach_what")

# ── Clusters ────────────────────────────────────────────────────────
add("tp_clusters_vplot_compare", "compare V-plots between clusters",
    ["footprint size patterns by cluster", "v-plot per cluster", "do clusters have different footprint sizes"],
    [op("cluster-detail", "vplot"),
     ex("clusters-vplot", "The V-plot shows one panel per cluster; a nucleosome band in one and small footprints in another means different chromatin states.",
        requires="has_clusters")],
    "V-plots by cluster", "Reading results.", category="teach_read", clustered=(0,))

add("tp_clusters_projection_side", "show clusters before and after merging together",
    ["projection before versus after merge", "side by side projection", "compare merge preview"],
    [op("cluster-detail", "projection"),
     ex("clusters-projection-controls", "Set View to Side-by-side to see the clusters now and after Merge similar clusters.",
        requires="has_clusters")],
    "Before/after projection", "Options.", category="teach_options", clustered=(0,))

add("tp_clusters_focus_hide", "hide one cluster",
    ["focus a cluster", "look at just one cluster", "hide a cluster from view"],
    [ex("cluster-focus-bar", "Click a cluster's colour in the bar left of the reads to focus it; Unhide all brings the rest back.", requires="has_clusters"),
     op("cluster-detail", "overview"),
     ex("clusters-overview", "The overview can also hide or focus clusters from their rows.")],
    "Focusing and hiding clusters", "Options.", category="teach_options", clustered=(0,))

# ── Footprints ──────────────────────────────────────────────────────
add("tp_fp_cooccupancy_export", "export the co-occupancy table",
    ["co-occupancy tsv", "save co-occupancy counts", "download co-occupancy statistics"],
    [op("footprint-analysis", "co-occ"),
     ex("footprints-cooccupancy", "Export TSV at the top of Co-occupancy saves each footprint's and each pair's counts, statistics and read IDs.")],
    "Export co-occupancy", "Options.", category="teach_options")

add("tp_fp_saved_colour", "change a saved footprint's colour",
    ["pick the colour for a saved footprint", "recolour a saved footprint", "saved footprint colours on the reads"],
    [op("footprint-analysis", "saved"),
     ex("footprints-saved", "Each saved footprint in the Saved tab has its own colour, used on every read that carries it.",
        requires="has_saved_footprints")],
    "Saved footprint colours", "Options.", category="teach_options")

add("tp_fp_find_again", "I moved, how do I find the footprint classes here?",
    ["rerun footprint classes after navigating", "find classes again", "footprint classes for a new region"],
    [op("footprint-analysis", "states"),
     ex("consensus-caller", "Find again reruns on the current view and selected datasets."),
     ex("footprints-class-list", "The new classes replace the list when it finishes.")],
    "Finding classes again", "Follow-up.", category="teach_followup")

add("tp_fp_assay_missing", "footprint classes asks which assay made the data",
    ["which assay should I pick", "DddA or DddB", "set up datasets to continue"],
    [op("footprint-analysis", "states"),
     ex("footprints-assay", "Pick each dataset's assay: DAF-seq with DddA or DddB, or Fiber-seq with Hia5; it chooses the right footprint model."),
     ex("consensus-caller", "Then Find footprint classes becomes available.")],
    "Setting the assay type", "Prerequisite.", category="teach_followup")

# ── Tracks ──────────────────────────────────────────────────────────
add("tp_tracks_upload", "upload a track from my laptop",
    ["add a local bigwig", "upload a bed file", "my file isn't on the server"],
    [op("track-browser"),
     ex("tracks-browse-files", "Upload…, next to Browse files…, sends a file from this computer."),
     ex("tracks-add-file", "The track then appears in the list.")],
    "Uploading a track", "Options.", category="teach_options")

add("tp_tracks_remove", "remove a track",
    ["delete a signal track", "unload a motif track", "get rid of a track"],
    [op("track-browser"),
     ex("tracks-row", "Each track's × removes it and unloads its source if nothing else uses it.", requires="has_tracks")],
    "Removing a track", "Options.", category="teach_options")

add("tp_tracks_hubs_read", "what can I find in browse hubs?",
    ["what are the hub catalogues", "ENCODE tracks in the browser", "ChIP-Atlas tracks"],
    [op("track-browser"),
     ex("tracks-browse-hubs", "Browse hubs… searches UCSC, ENCODE and ChIP-Atlas for the current genome, with filters by assay, target and cell type.")],
    "Browsing track hubs", "What-does question.", category="teach_what")

# ── Gene track ──────────────────────────────────────────────────────
add("tp_gene_deselect", "how do I deselect the gene?",
    ["clear the gene selection", "unselect eve", "stop analysing the selected gene"],
    [ex("gene-track", "Click the selected gene again, or an empty part of the gene track, to clear the selection.")],
    "Clearing the gene selection", "Options.", category="teach_options", state_overrides=GENE_EVE)

add("tp_gene_hover", "how do I see a gene's name?",
    ["which gene is this", "gene names aren't shown", "identify a gene in the track"],
    [ex("gene-track", "Hover a gene to see its name and coordinates; zoom in and names are drawn on the track.")],
    "Gene names", "What-does question.", category="teach_what")


# ─────────────────────────────────────────────────────────────────────
# Sanity checks on import
# ─────────────────────────────────────────────────────────────────────

assert len({r["id"] for r in RECORDS}) == len(RECORDS), "duplicate record ids in records_teach_panels"
