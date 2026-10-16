"""Teach-only records for vague, goal-level and ambiguous requests.

Real users rarely ask "how do I use the Co-accessibility panel?". They ask "do
these two sites open together?", "compare", "help", or "the thing with the
colours". These records teach the tutorial Copilot to:

- map a biology goal to the one analysis that answers it, and walk it briefly;
- resolve an ambiguous request from the live state (clusters, a copy, several
  datasets, a filter) and mention one alternative, or, when it's truly open,
  offer the options as a short "which do you mean?" walk with one spotlight per
  option (follow-up records resolve the choice);
- orient a newcomer, adapting to what's loaded (nothing yet: data and genome
  first; data loaded: how to read the reads track), and point at the Tour;
- recognise controls described loosely ("the panel with the circles");
- cope with typos, terse and statement-style input (mostly as phrasings).

Copilot teaches: it may navigate and open panels, tabs and sidebar sections,
but the user clicks anything that runs something (try_it). Every record
carries the diagnostics and raw_state a live request sends.

Registered from records.py (``RECORDS += ...``). Imports only the teach
workflow module, never records.py, so there is no import cycle.
"""
from __future__ import annotations

try:
    from data.copilot_dataset.records_teach_workflows import (
        CLUSTER_CONTROLS, COPY_STEPS, D_EMPTY, D_NO_REFERENCE, DS_FIBER_DAF, DS_FIBER_ONLY, DS_NONE,
        DS_THREE, FOOTPRINT_SELECT, GENOME_STEPS, PRIMER_STEPS, SAVE_STEPS, STRAND_STEPS, V_DM6_2L,
        V_DM6_2R, V_DM6_3R, V_DM6_HB, V_DM6_WIDE, V_DM6_X, V_EMPTY, V_HG38_MYC, V_HG38_SOX2,
        V_HG38_TP53, V_MM10_PAX6, _r, ctx_kw, ex, nav, op, peaks_first, region, sidebar, tr, turn, zoom,
    )
    from data.copilot_dataset.records_teach_troubleshooting import zoomed_out
except ImportError:  # imported as a top-level module
    from records_teach_workflows import (  # type: ignore[no-redef]
        CLUSTER_CONTROLS, COPY_STEPS, D_EMPTY, D_NO_REFERENCE, DS_FIBER_DAF, DS_FIBER_ONLY, DS_NONE,
        DS_THREE, FOOTPRINT_SELECT, GENOME_STEPS, PRIMER_STEPS, SAVE_STEPS, STRAND_STEPS, V_DM6_2L,
        V_DM6_2R, V_DM6_3R, V_DM6_HB, V_DM6_WIDE, V_DM6_X, V_EMPTY, V_HG38_MYC, V_HG38_SOX2,
        V_HG38_TP53, V_MM10_PAX6, _r, ctx_kw, ex, nav, op, peaks_first, region, sidebar, tr, turn, zoom,
    )
    from records_teach_troubleshooting import zoomed_out  # type: ignore[no-redef]


RECORDS: list[dict] = []


def add(category: str, id: str, command: str, phrasings: list[str], ctx: dict, thinking: str,
        summary: str, actions: list[dict], **extra) -> None:
    RECORDS.append(_r(id=id, category=category, command=command, phrasings=phrasings, **ctx,
                      thinking=thinking, summary=summary, actions=actions, **extra))


def goal(*a, **k):
    add("teach_goal", *a, **k)


def amb(*a, **k):
    add("teach_ambiguous", *a, **k)


def orient(*a, **k):
    add("teach_orientation", *a, **k)


def vague(*a, **k):
    add("teach_vague_howto", *a, **k)


CLUSTERED = dict(clustered=(0, 1))
SELECTED_EVE = {"state_overrides": {"selected_gene": "eve"}}

# Short shared walks
CLUSTER_SHORT = [
    ex("cluster-controls-expand", "Click the small Cluster label to show the method and K."),
    ex("cluster-method", "K-means is a good default; K is the number of groups, pick it a little high."),
] + peaks_first() + [
    tr("cluster-button", "Now click Cluster.", "clustered"),
    ex("clusters-overview", "Each cluster is a group of molecules with a similar footprint pattern, with its read count.",
       requires="has_clusters"),
]

TF_WALK = [
    ex("reads-track", "A bound factor leaves a short footprint (roughly 10-80 bp) on each molecule; nucleosomes are ~147 bp."),
    ex("layer-toggles", "Keep the TF layer on so those short footprints are drawn."),
    tr("reads-track", "Cmd/Ctrl+click a short footprint at your site.", "footprint_selected", skip_if="has_selected_footprint"),
    ex("selected-footprint", "The Footprints panel shows how many molecules carry it here: that's how often the site is bound.",
       requires="has_selected_footprint"),
    ex("footprints-classes", "Classes groups footprints by size and lists the motifs they overlap, a hint at which factor it is."),
]

OPEN_WALK = [
    ex("reads-track", "Open DNA shows as gaps between footprints on each molecule; the more molecules with a gap, the more open."),
    ex("layer-toggles", "The accessible (FIRE/MSP) layer marks those open stretches directly."),
    tr("scan-peaks-button", "Click Scan: the Peaks track marks positions that are open on many molecules.", "peaks_scanned",
       skip_if="has_peaks"),
    ex("peaks-track", "A tall peak over your enhancer means it's accessible on a large share of molecules."),
]

TRANSCRIPTION_WALK = [
    ex(None, "Pol II states are read per gene: search for your gene, then click it on the gene track to select it."),
    op("transcription-state", "distribution"),
    ex("transcription-distribution", "Distribution shows how many reads look pre-initiation, paused or elongating at the selected gene.",
       requires="has_selected_gene"),
    ex("transcription-filters", "Filters keeps only the reads in one state, e.g. the paused ones, so you can look at them."),
]

COACC_WALK = [
    op("co-accessibility"),
    ex("coacc-matrix", "Each cell shows how often two positions are open on the same molecule, beyond what chance predicts."),
    ex("coacc-refresh", "Refresh recomputes it for the current view after you move or zoom."),
]

CONTACT_WALK = [
    ex("load-dataset", "Contacts come from a Micro-C or DAF-C map: load the .mcool file with Load File."),
    op("contact-map", "map"),
    ex("contacts-map", "The Map tab shows contact frequency between the two regions; a strong spot off the diagonal means they touch often."),
]

MOTIF_WALK = [
    op("track-browser"),
    ex("tracks-browse-hubs", "Browse hubs has motif collections for your genome; add one to draw motif sites as a track."),
    tr("reads-track", "Cmd/Ctrl+click a footprint to see which motifs it overlaps.", "footprint_selected",
       skip_if="has_selected_footprint"),
    ex("footprints-classes", "Classes lists the motifs under each footprint class.", requires="has_selected_footprint"),
]

EXPORT_FIGURE = [
    ex("layout-menu", "Layout arranges the panels side by side or stacked and evens their widths."),
    ex("labeling-rules", "Labeling rules set the footprint colours, e.g. TF footprints in one colour, nucleosomes in another."),
    ex("row-height", "Row height makes each molecule thicker or thinner."),
    ex("export-figure", "Export saves the view as a PNG, SVG or PDF; SVG and PDF stay editable in Illustrator."),
]

T_COMPARE_OPTIONS = turn("compare", "Which comparison do you mean?", ["explain", "explain", "explain", "explain"])
T_FILTER_OPTIONS = turn("filter", "Which filter do you mean?", ["explain", "explain", "explain"])
T_EXPORT_OPTIONS = turn("export", "What would you like to export?", ["explain", "explain", "explain", "explain"])
T_HEATMAP = turn("where's the heatmap?", "The co-accessibility heatmap", ["open_panel", "explain", "explain"])
T_ANALYZE_PEAK = turn("analyze this peak", "Cluster the reads at the selected peak", ["explain", "try_it", "explain"])
T_RESET_OPTIONS = turn("reset", "What would you like to reset?", ["explain", "explain", "explain"])
T_MERGE_OPTIONS = turn("merge", "Which merge do you mean?", ["explain", "explain"])
T_CLUSTER_WALK = turn("are there different populations of molecules here?", "Find populations by clustering",
                      ["explain", "explain", "try_it", "try_it", "try_it", "explain"])


# ═════════════════════════════════════════════════════════════════════
# 1. Goal-level biology questions
# ═════════════════════════════════════════════════════════════════════

# ── Is my TF bound here? → footprints ───────────────────────────────
goal("tv_tf_bound_here", "is my TF bound here?",
     ["is anything bound at this site", "is there a transcription factor sitting here",
      "how do I tell if a factor occupies this spot", "tf bound here??", "is my factor binding this site or not"],
     ctx_kw(V_DM6_2R),
     "Goal: TF occupancy at a site. The analysis is the footprint itself: short footprints on the molecules, then Cmd/Ctrl+click to see how many carry it. Selecting is the user's click.",
     "Check TF binding with footprints", TF_WALK)

goal("tv_tf_bound_myc", "is a factor bound at the MYC promoter?",
     ["does something bind the MYC promoter", "what's occupying the MYC TSS", "is MYC's promoter bound"],
     ctx_kw(V_HG38_MYC),
     "Goal: binding at a named promoter. We're already at MYC, so TSS-relative coordinates then the footprint walk.",
     "Check binding at the MYC promoter",
     [ex("relative-coords", "Turn on TSS-relative coordinates so positions read as distance from the MYC TSS."),
      *TF_WALK[:4]])

goal("tv_tf_bound_selected", "is this footprint a transcription factor?",
     ["is the footprint I clicked a TF", "TF or nucleosome?", "what kind of footprint is this",
      "is this thing I selected a factor"],
     ctx_kw(V_DM6_2R),
     "The user refers to a selected footprint: size tells TF (short) from nucleosome (~147 bp); classes and motifs narrow it down; a ChIP track can confirm.",
     "TF or nucleosome: reading a footprint",
     [tr("reads-track", "Cmd/Ctrl+click the footprint first if it isn't selected.", "footprint_selected",
         skip_if="has_selected_footprint"),
      ex("selected-footprint", "Its size range is shown here: under ~80 bp is typical of a factor, ~147 bp of a nucleosome.",
         requires="has_selected_footprint"),
      ex("footprints-classes", "Classes shows which motifs it overlaps."),
      ex("tracks-browse-hubs", "To confirm a factor, add its ChIP-seq track from Browse hubs in the Tracks panel.")])

goal("tv_tf_two_factors", "do these two factors bind together?",
     ["do the two sites get bound on the same molecules", "is binding at site A linked to site B",
      "are two TFs co-bound", "do both footprints show up together"],
     ctx_kw(V_DM6_2R),
     "Goal: co-binding. The analysis is co-occupancy of saved footprints: save each site's footprint, then the Co-occupancy tab. Saving is the user's click.",
     "Co-binding with co-occupancy",
     [tr("reads-track", "Cmd/Ctrl+click the footprint at the first site.", "footprint_selected", skip_if="has_saved_footprints"),
      tr("save-footprint", "Click Save to keep it as a definition.", "footprint_saved", skip_if="has_saved_footprints"),
      tr("reads-track", "Now Cmd/Ctrl+click the footprint at the second site.", "footprint_selected"),
      tr("save-footprint", "Save that one too.", "footprint_saved"),
      ex("footprints-cooccupancy", "Co-occupancy counts molecules with both, either or neither, and tests whether they co-occur more than chance.",
         requires="has_saved_footprints")])

goal("tv_tf_occupancy_fraction", "what fraction of molecules have the factor bound?",
     ["how often is this site occupied", "percent of reads with the footprint", "occupancy at my motif",
      "how many molecules are bound here"],
     ctx_kw(V_DM6_3R),
     "Goal: occupancy fraction. Selecting the footprint shows its share of molecules; clustering splits bound vs unbound populations if they want more.",
     "Measure occupancy",
     [tr("reads-track", "Cmd/Ctrl+click the footprint at the site.", "footprint_selected", skip_if="has_selected_footprint"),
      ex("selected-footprint", "The Footprints panel gives the share of molecules that carry it.", requires="has_selected_footprint"),
      ex("cluster-button", "To separate bound and unbound molecules, select a peak there and Cluster.")])

# ── Is this enhancer open? → accessibility / peaks ──────────────────
goal("tv_open_enhancer", "is this enhancer open?",
     ["is this region accessible", "is the enhancer open chromatin", "how open is this element",
      "is this spot accessible or closed", "enhancer open?"],
     ctx_kw(V_DM6_2R),
     "Goal: accessibility of a region. Read the gaps on the reads, the accessible layer, then Scan for peaks (the user's click).",
     "Check accessibility", OPEN_WALK)

goal("tv_open_hg38", "how accessible is this region?",
     ["how open is this locus", "is the chromatin open here", "measure accessibility here"],
     ctx_kw(V_HG38_SOX2),
     "Accessibility, with a number: the peak shows where; Shift+click reads and Read Stats gives each read's accessible fraction.",
     "Accessibility with numbers",
     [*OPEN_WALK[:3],
      tr("reads-track", "For numbers, Shift+click a few reads (or drag across them) to select them.", "reads_selected"),
      ex("read-stats-summary", "Read Stats gives the accessible percentage for the selected reads.", requires="has_selected_reads")])

goal("tv_open_which_sample", "is this site more open in one sample?",
     ["which sample is more accessible here", "is accessibility different between my conditions",
      "does the enhancer open up in the later timepoint"],
     ctx_kw(V_DM6_2R, DS_THREE),
     "Three datasets: each has its own panel and its own peaks, so comparing peaks panel by panel answers it; Read Stats gives numbers per dataset.",
     "Compare accessibility between samples",
     [ex("reads-track", "Each dataset has its own panel; open stretches show as gaps between footprints."),
      tr("scan-peaks-button", "Click Scan: each panel gets its own peaks.", "peaks_scanned", skip_if="has_peaks"),
      ex("peaks-track", "Compare the peak over your site between panels: taller means open on more molecules."),
      ex("layout-menu", "Layout can stack the panels so the same position lines up.")])

goal("tv_open_nfr", "is there a nucleosome-free region at the promoter?",
     ["is the TSS nucleosome depleted", "NFR at this gene?", "is the promoter free of nucleosomes"],
     ctx_kw(V_DM6_2R),
     "Goal: NFR at a TSS. TSS-relative coordinates, then read nucleosome-sized footprints around 0; a metaprofile averages it.",
     "Look for a nucleosome-free region",
     [nav("eve", 2000),
      ex("relative-coords", "Turn on TSS-relative coordinates so 0 is the eve TSS."),
      ex("reads-track", "Nucleosomes are the ~147 bp footprints; a stretch just upstream of 0 without them on most molecules is the NFR."),
      ex("tracks-add-metaprofile", "Add a metaprofile to average nucleosome occupancy over all the molecules.")])

# ── Where are the nucleosomes? ──────────────────────────────────────
goal("tv_nucleosomes_where", "where are the nucleosomes?",
     ["show me nucleosome positions", "how do I see nucleosomes", "which footprints are nucleosomes",
      "where do nucleosomes sit here"],
     ctx_kw(V_DM6_3R),
     "Goal: nucleosome positions. The nucleosome layer, their size (~147 bp), a labeling rule to colour them, a metaprofile to average.",
     "See nucleosome positions",
     [ex("layer-toggles", "Turn on the nucleosome layer; nucleosomes are the ~147 bp footprints."),
      ex("reads-track", "Each molecule shows where its nucleosomes sit; stripes that line up across molecules are well positioned."),
      ex("labeling-rules", "A labeling rule can colour footprints of 120-180 bp so nucleosomes stand out."),
      ex("tracks-add-metaprofile", "A metaprofile averages nucleosome occupancy across the molecules.")])

goal("tv_nucleosomes_phased", "are the nucleosomes well positioned here?",
     ["are nucleosomes phased", "is there nucleosome phasing", "how regular is the nucleosome array"],
     ctx_kw(V_HG38_TP53),
     "Positioning is best seen as a metaprofile (peaks = positioned) plus sorting reads so the arrays line up.",
     "Nucleosome positioning",
     [ex("tracks-add-metaprofile", "Add a metaprofile of the nucleosome layer: sharp, evenly spaced peaks mean well-positioned nucleosomes."),
      ex("layer-toggles", "Keep the nucleosome layer on so the arrays are drawn on each molecule."),
      tr("sort-button", "Sort the reads (e.g. by accessibility) so similar arrays sit together.", "sorted")])

# ── Do these two sites open together? → co-accessibility ────────────
goal("tv_coacc_two_sites", "do these two sites open together?",
     ["are these two places open on the same molecules", "are the two peaks coordinated",
      "is opening at A linked to opening at B", "coordinated accessibility between sites"],
     ctx_kw(V_DM6_2R),
     "Goal: coordinated opening. That's co-accessibility; both sites must be in view and within a read's length.",
     "Coordinated opening with co-accessibility",
     [ex("search-bar", "Make sure both sites are in view (type a region that spans them)."), *COACC_WALK])

goal("tv_coacc_enhancer_promoter", "are the enhancer and promoter open on the same molecules?",
     ["enhancer promoter co-accessibility", "do the eve enhancer and promoter open together",
      "linked accessibility between enhancer and TSS"],
     ctx_kw(V_DM6_2R),
     "Co-accessibility over a window holding both; navigate to eve with padding, then the panel.",
     "Enhancer-promoter co-accessibility",
     [nav("eve", 8000), *COACC_WALK,
      ex(None, "Look for a strong cell linking the enhancer position with the promoter.")])

goal("tv_coacc_far_apart", "are these distant elements coordinated?",
     ["are two elements 300 kb apart linked", "do far apart regions open together", "long range coordination"],
     ctx_kw(V_DM6_WIDE),
     "Far apart: molecules don't span both, so co-accessibility can't; a contact map shows physical proximity instead, or a panel copy at each site.",
     "Distant elements",
     [ex(None, "Single molecules only span a few kb, so co-accessibility works within that distance."),
      ex("contacts-map", "For elements far apart, a Micro-C / DAF-C contact map shows whether they touch."),
      ex("panel-add-copy", "Or add a panel copy and put one site in each panel to compare them side by side.")])

# ── Compare my two samples ──────────────────────────────────────────
goal("tv_compare_samples", "compare my two samples",
     ["how do I compare my samples", "compare conditions", "compare wild type and mutant",
      "side by side comparison of my datasets", "compare my 2 samples"],
     ctx_kw(V_DM6_2R, DS_THREE),
     "Several datasets loaded: each is a panel; lay them out side by side, link them, and cluster across all of them.",
     "Compare samples",
     [ex("reads-track", "Each loaded dataset has its own panel, all following the same view."),
      ex("layout-menu", "Layout arranges the panels side by side or stacked."),
      ex("cluster-button", "Clustering runs across every shown panel, so the same cluster means the same pattern in each sample."),
      ex("loaded-datasets", "Rename and recolour the datasets under Loaded Datasets so they're easy to tell apart.")])

goal("tv_compare_samples_one", "I want to compare two conditions",
     ["compare my treatment to control", "how do I compare two datasets", "compare samples side by side"],
     ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
     "Only one dataset is loaded (State details): load the second, then they sit in separate panels.",
     "Load the second sample, then compare",
     [ex("reads-track", "Only one dataset is loaded so far."),
      tr("load-dataset", "Click Load File and add the other condition.", "dataset_loaded"),
      ex("layout-menu", "Each dataset gets a panel; Layout arranges them side by side."),
      ex("scan-peaks-button", "Scan and Cluster then work across both panels.")])

goal("tv_compare_pool", "pool my replicates",
     ["combine my replicates into one", "merge two BAMs into one track", "treat these two files as one sample"],
     ctx_kw(V_DM6_2R, DS_THREE),
     "Pooling = merging datasets in the Layout panel; the user selects and merges.",
     "Pool replicates",
     [op("dataset-layout"),
      ex("layout-panel", "The Layout panel lists every dataset panel."),
      ex("layout-merge", "Select the replicates and click Merge datasets to pool their reads into one panel."),
      ex("layout-link", "Or keep them separate and Link them so they move together.")])

goal("tv_compare_numbers", "which sample has more open reads at this peak?",
     ["quantify the difference between samples", "numbers for each condition at the peak", "how many reads are open in each"],
     ctx_kw(V_DM6_2R, DS_THREE),
     "Numbers per sample: Read Stats on a Shift+click selection per panel; clustering gives counts per cluster per sample.",
     "Numbers per sample",
     [tr("reads-track", "In one panel, Shift+click (or drag across) the reads over the peak.", "reads_selected"),
      ex("read-stats-summary", "Read Stats gives their accessibility; repeat in the other panel.", requires="has_selected_reads"),
      ex("cluster-button", "Or Cluster at the peak: the Clusters panel counts reads per cluster in each sample.")])

# ── Different populations of molecules? → clustering ────────────────
goal("tv_populations", "are there different populations of molecules here?",
     ["are there distinct chromatin states across reads", "do the molecules fall into groups",
      "subpopulations of molecules", "are all the reads the same or are there types"],
     ctx_kw(V_DM6_2R),
     "Goal: heterogeneity across molecules. The analysis is clustering at a peak: expand the controls, peaks, Cluster (user's clicks), then the overview.",
     "Find populations by clustering", CLUSTER_SHORT)

goal("tv_populations_clustered", "which populations do I have?",
     ["what are the groups", "what do my clusters mean", "tell me about the subpopulations"],
     ctx_kw(V_DM6_2R, **CLUSTERED),
     "Already clustered (State details): skip clustering; read the results.",
     "Reading your populations",
     [op("cluster-detail", "overview"),
      ex("clusters-overview", "Each cluster is one population, with its read count.", requires="has_clusters"),
      ex("clusters-profiles", "Profiles shows where the populations differ."),
      ex("clusters-projection", "Projection places every read by its pattern, so you can see how distinct the groups are.")])

goal("tv_populations_hg38", "are there different chromatin states at SOX2?",
     ["different states across molecules at SOX2", "heterogeneity at the SOX2 locus", "subpopulations at SOX2"],
     ctx_kw(V_HG38_SOX2),
     "Clustering at SOX2; we're there already.",
     "Clustering at SOX2", CLUSTER_SHORT)

goal("tv_heterogeneity", "how heterogeneous is this locus?",
     ["how variable are the molecules", "is this locus uniform", "how much cell to cell variation is there"],
     ctx_kw(V_DM6_3R),
     "Heterogeneity: cluster, then Projection shows how spread the molecules are.",
     "Measure heterogeneity",
     CLUSTER_SHORT[:2] + peaks_first() + [
         tr("cluster-button", "Click Cluster.", "clustered"),
         ex("clusters-projection", "Projection shows every read as a dot: tight, separate groups mean distinct states; one cloud means uniform.",
            requires="has_clusters")])

# ── Paused Pol II → transcription ───────────────────────────────────
goal("tv_paused_pol2", "which reads are paused Pol II?",
     ["find paused polymerase", "which molecules have paused pol ii", "show me the paused reads",
      "pausing at this gene"],
     ctx_kw(V_DM6_2R),
     "Goal: Pol II state per read. That's the Transcription panel at a selected gene; selecting the gene is the user's click.",
     "Find paused Pol II", TRANSCRIPTION_WALK)

goal("tv_paused_pol2_selected", "how many reads are paused at eve?",
     ["what share of eve reads are paused", "is Pol II paused at eve", "eve pausing"],
     ctx_kw(V_DM6_2R), **SELECTED_EVE,
     thinking="eve is already the selected gene: straight to the Transcription panel's Distribution and Filters.",
     summary="Pol II pausing at eve",
     actions=[op("transcription-state", "distribution"),
              ex("transcription-distribution", "Distribution gives the share of eve reads paused, elongating or pre-initiation.",
                 requires="has_selected_gene"),
              ex("transcription-filters", "Filters keeps just the paused reads so you can look at them.")])

goal("tv_transcribed_fraction", "how much of this gene is being transcribed?",
     ["is this gene active", "fraction of molecules with elongating polymerase", "is the gene on"],
     ctx_kw(V_DM6_3R),
     "Transcription activity per read = Pol II states at the selected gene.",
     "Is the gene transcribed?", TRANSCRIPTION_WALK)

# ── Allele-specific? → haplotype comparison ─────────────────────────
goal("tv_allele_specific", "is this allele-specific?",
     ["is accessibility different between alleles", "allele specific binding", "does one haplotype differ",
      "maternal vs paternal differences"],
     ctx_kw(V_DM6_2R),
     "Goal: allele differences. Needs two haplotype references (reference pairs) and the Compare tab, which opens linked panels (user's click).",
     "Compare haplotypes",
     [ex("reference-pairs", "Load both haplotype references here, with distinct chromosome names."),
      op("contact-map", "compare"),
      ex("haplotype-compare", "Compare puts the two haplotypes side by side in linked panels."),
      tr("haplotype-form", "Pick the two haplotypes and open the comparison.", "panel_copy_made")])

goal("tv_strand_specific", "is the signal strand-specific?",
     ["do the two strands look different", "compare CT and GA reads", "is it the same on both strands"],
     ctx_kw(V_DM6_2R, DS_FIBER_DAF),
     "DAF-seq dataset: splitting CT and GA strands is the strand chip.",
     "Compare the DAF-seq strands", STRAND_STEPS)

goal("tv_haplotype_reads", "compare maternal and paternal reads",
     ["look at each haplotype separately", "split reads by haplotype", "phased reads side by side"],
     ctx_kw(V_DM6_2R),
     "Haplotype comparison via reference pairs and Contacts > Compare.",
     "Haplotypes side by side",
     [ex("reference-files", "Haplotypes are two references: load them under Reference Files."),
      ex("reference-pairs", "Add each haplotype's FASTA (and annotation) here."),
      op("contact-map", "compare"),
      tr("haplotype-form", "Choose the two haplotypes and open them side by side.", "panel_copy_made")])

# ── What's bound at this promoter? ──────────────────────────────────
goal("tv_bound_promoter_eve", "what's bound at the eve promoter?",
     ["what factors sit on the eve promoter", "what's at the eve TSS", "eve promoter occupancy"],
     ctx_kw(V_DM6_3R),
     "Navigate to eve (allowed), TSS-relative coords, then footprints and motifs; ChIP tracks confirm.",
     "What's bound at the eve promoter",
     [nav("eve", 2000),
      ex("relative-coords", "TSS-relative coordinates put the eve TSS at 0."),
      tr("reads-track", "Cmd/Ctrl+click a short footprint near 0.", "footprint_selected", skip_if="has_selected_footprint"),
      ex("footprints-classes", "Classes lists motifs under the footprints, which suggests the factors."),
      ex("tracks-browse-hubs", "ChIP tracks from Browse hubs confirm which factor it is.")])

goal("tv_bound_promoter_here", "what's bound at this promoter?",
     ["what is sitting on this promoter", "which proteins bind here", "what's occupying this TSS"],
     ctx_kw(V_HG38_TP53),
     "Same walk without navigating: we're at the promoter.",
     "What's bound here",
     [ex("relative-coords", "Turn on TSS-relative coordinates to read positions from the TSS."),
      *TF_WALK[2:],
      ex("tracks-browse-hubs", "Add ChIP-seq tracks from Browse hubs to see which factors bind here.")])

# ── Best-covered region → go to reads ───────────────────────────────
goal("tv_best_covered", "find the best-covered region",
     ["where is there the most data", "take me somewhere with lots of reads", "find a well covered spot",
      "where are my reads concentrated"],
     ctx_kw(V_DM6_2R),
     "go_to_top_locus is navigation: jump to the best-covered window, then point at Go to reads for the next.",
     "Go to the best-covered window",
     [{"type": "go_to_top_locus"},
      ex("go-to-reads", "Go to reads jumps to the next well-covered window each time you click it.")])

goal("tv_best_covered_hg38", "where do I have reads?",
     ["I can't find my reads anywhere", "which regions have coverage", "find reads in this genome"],
     ctx_kw(V_HG38_MYC),
     "Navigation to covered windows is allowed; then Go to reads for more.",
     "Find where the reads are",
     [{"type": "go_to_top_locus"},
      ex("go-to-reads", "Click Go to reads to step through the best-covered windows."),
      ex("search-bar", "Or type a gene you know is covered.")])

# ── Design primers to validate this ─────────────────────────────────
goal("tv_primers_validate", "design primers to validate this",
     ["I want to validate this by PCR", "make primers for this region", "primers to check this peak",
      "validate with qPCR"],
     ctx_kw(V_DM6_2R),
     "Goal: validation primers. Primers panel around the selected peak; design is the user's click.",
     "Primers to validate a region", PRIMER_STEPS)

goal("tv_primers_no_reference", "can I design primers here?",
     ["primers for this spot", "make PCR primers here", "primer design for this locus"],
     ctx_kw(V_DM6_2R, DS_FIBER_ONLY, D_NO_REFERENCE, reference=False),
     "Diagnostics: no reference; primers need the sequence. Load a genome first, then design.",
     "Load a reference, then design primers",
     [ex("genome-selector", "Primers need the reference sequence, and none is loaded."),
      tr("genome-selector", "Pick your genome from the list.", "genome_loaded"),
      ex("primers-design-tab", "Then the Primers panel's Design tab designs around the selected peak or the view.",
         requires="has_reference"),
      tr("primers-design-button", "Click Design primers.", "primers_designed")])

# ── Make a figure for my paper ──────────────────────────────────────
goal("tv_figure_paper", "make a figure for my paper",
     ["how do I make a publication figure", "export a nice figure", "I need a figure for a manuscript",
      "figure for my talk"],
     ctx_kw(V_DM6_2R),
     "Figure: layout, colours, row height, then Export (the user's click) as SVG/PDF.",
     "Make a figure", EXPORT_FIGURE)

goal("tv_figure_samples", "make a figure comparing my samples",
     ["figure with all three samples", "export the panels side by side", "multi panel figure"],
     ctx_kw(V_DM6_2R, DS_THREE),
     "Three panels: arrange them, colour, export; save the session to redo it later.",
     "Figure with several samples",
     [*EXPORT_FIGURE, ex("save-session", "Save the session so you can reproduce the figure later.")])

goal("tv_figure_clusters", "make a figure of my clusters",
     ["export the clustered reads", "figure showing the clusters", "picture of the clusters for a paper"],
     ctx_kw(V_DM6_2R, **CLUSTERED),
     "Clustered: lock the order so it doesn't shift, then export.",
     "Figure of the clusters",
     [ex("cluster-order-lock", "Lock the cluster order so the groups stay put.", requires="has_clusters"),
      ex("labeling-rules", "Labeling rules set the footprint colours."),
      ex("export-figure", "Export saves the view as PNG, SVG or PDF, with the cluster bar.")])

# ── What motifs are here? ───────────────────────────────────────────
goal("tv_motifs_here", "what motifs are here?",
     ["are there motifs in this region", "show me TF motifs", "which motifs overlap the peak",
      "motif sites here"],
     ctx_kw(V_DM6_2R),
     "Motifs: a motif collection track from Browse hubs, and the motifs under footprints in Classes.",
     "Find motifs", MOTIF_WALK)

goal("tv_motifs_footprint", "which motif is under this footprint?",
     ["what motif is this footprint on", "does this footprint sit on a motif", "motif at the footprint I clicked"],
     ctx_kw(V_HG38_MYC),
     "The motif under a selected footprint is in Footprints > Classes.",
     "The motif under a footprint",
     [tr("reads-track", "Cmd/Ctrl+click the footprint.", "footprint_selected", skip_if="has_selected_footprint"),
      ex("footprints-classes", "Classes lists the motifs that overlap it.", requires="has_selected_footprint")])

goal("tv_motifs_no_reference", "show me motif sites",
     ["where are the motif matches", "scan for motifs", "motif track"],
     ctx_kw(V_DM6_2R, DS_FIBER_ONLY, D_NO_REFERENCE, reference=False),
     "Motif scans need the reference (diagnostics: none loaded): load a genome, then the motif track.",
     "Load a reference, then motifs",
     [ex("genome-selector", "Motif scans need the genome sequence; pick your genome first."),
      tr("genome-selector", "Choose it from the list.", "genome_loaded"),
      op("track-browser"),
      ex("tracks-browse-hubs", "Then add a motif collection from Browse hubs.")])

# ── Are these two loci in contact? → contact map ────────────────────
goal("tv_loci_contact", "are these two loci in contact?",
     ["do these regions touch", "is the enhancer looping to the promoter", "are the two sites physically close",
      "3D contact between these regions"],
     ctx_kw(V_DM6_2R),
     "Goal: physical contact. That's a Micro-C / DAF-C contact map in the Contacts panel.",
     "Physical contacts from a contact map", CONTACT_WALK)

goal("tv_loci_contact_far", "does this enhancer contact a gene far away?",
     ["long range looping", "is there a loop to a distant promoter", "long distance interaction"],
     ctx_kw(V_DM6_WIDE),
     "Long-range contact: contact map; a panel copy can show the distant gene's reads.",
     "Long-range contacts",
     [*CONTACT_WALK,
      ex("panel-add-copy", "Add a panel copy and move it to the distant gene to see its reads alongside.")])

# ── More goals ──────────────────────────────────────────────────────
goal("tv_single_molecules", "I want to look at individual molecules",
     ["show me single reads", "how do I inspect one read", "look at molecules one by one"],
     ctx_kw(V_DM6_2R),
     "Single molecules: the reads track, row height, all vs sampled reads, and Shift+click for details.",
     "Look at single molecules",
     [ex("reads-track", "Each row is one molecule, from its start to its end."),
      ex("row-height", "Row height makes each molecule taller so its footprints are easier to see."),
      ex("read-display-mode", "Switch between all reads and a sample of them here."),
      tr("reads-track", "Shift+click a read to select it.", "reads_selected"),
      ex("read-stats-summary", "Read Stats shows that molecule's length, footprints and accessibility.", requires="has_selected_reads")])

goal("tv_data_quality", "is my data any good?",
     ["check my data quality", "how good are these reads", "is this a good library", "QC my reads"],
     ctx_kw(V_DM6_2R),
     "QC: Read Stats on a selection, the quality settings, and spanning-only.",
     "Check data quality",
     [tr("reads-track", "Shift+click or drag across a set of reads to select them.", "reads_selected"),
      ex("read-stats-summary", "Read Stats summarises their length, footprint count and accessibility.", requires="has_selected_reads"),
      ex("quality-filters", "Quality sets cutoffs for footprint call confidence."),
      ex("spanning-toggle", "Spanning only keeps reads that cover the whole view.")])

goal("tv_see_m6a", "can I see the m6A calls?",
     ["show methylation marks", "where are the m6A sites", "show modified bases", "see the methyl marks"],
     ctx_kw(V_DM6_2R),
     "Base modifications are a layer: the layer toggles.",
     "Show m6A marks",
     [ex("layers-controls-expand", "Click the small Layers label to show every layer."),
      ex("layer-toggles", "Turn on the m6A layer to draw each methylated base as a mark on the reads."),
      ex("row-height", "A taller row height makes the marks easier to see.")])

goal("tv_see_deamination", "where did deamination happen?",
     ["show the deaminated bases", "DAF-seq deamination marks", "see C to T conversions"],
     ctx_kw(V_DM6_2R, DS_FIBER_DAF),
     "DAF-seq: the deamination layer, plus the strand chip for CT vs GA.",
     "Show deamination",
     [ex("layer-toggles", "Turn on the deamination layer to draw each converted base on the DAF-seq reads."),
      ex("strand-chip", "The strand chip shows CT reads, GA reads or both.")])

goal("tv_overlay_chip", "overlay ChIP-seq for my factor",
     ["add a ChIP track", "compare to ChIP-seq peaks", "show ENCODE binding data", "load my ChIP bigwig"],
     ctx_kw(V_HG38_MYC),
     "External tracks: Tracks panel, Browse hubs or add own file (user's click).",
     "Overlay a ChIP-seq track",
     [op("track-browser"),
      ex("tracks-browse-hubs", "Browse hubs searches ENCODE, UCSC and ChIP-Atlas for your genome; search for your factor."),
      tr("tracks-add-file", "Or add your own BigWig or BED file or URL here.", "track_added"),
      ex("tracks-add-metaprofile", "A metaprofile of it can be drawn above the reads too.")])

goal("tv_average_profile", "show me the average accessibility across the region",
     ["average profile", "aggregate accessibility plot", "mean occupancy along the view"],
     ctx_kw(V_DM6_2R),
     "Averages are metaprofiles in the Tracks panel.",
     "Average profile",
     [op("track-browser"),
      ex("tracks-add-metaprofile", "Add metaprofile draws the average of a layer (accessibility, nucleosomes, TFs) across all molecules."),
      ex(None, "Once you've clustered, the Clusters panel's Profiles tab shows the same average for each cluster.")],
     )

goal("tv_open_reads_top", "put the open reads at the top",
     ["sort molecules by how open they are", "order reads so the accessible ones come first", "bring open molecules to the top"],
     ctx_kw(V_DM6_2R),
     "Sorting is the Sort button; Sort rules define custom orders.",
     "Sort reads by accessibility",
     [ex("sort-controls-expand", "Click the small Sort label to show the sort options."),
      tr("sort-button", "Click Sort to order the reads, e.g. by accessibility at the selected peaks.", "sorted"),
      ex("sort-rules", "Sort rules let you define your own order, like the number of TF footprints at a peak.")])

goal("tv_keep_open_reads", "keep only reads that are open at the peak",
     ["hide the closed molecules", "show only accessible reads", "filter to open reads at my peak"],
     ctx_kw(V_DM6_2R),
     "Filter rule in the Rules panel, then Filter (user's click).",
     "Filter to open reads",
     [op("cluster-features", "filter"),
      ex("add-filter-rule", "Add a filter rule, e.g. accessible at the selected peaks."),
      tr("filter-button", "Click Filter to keep only the reads that pass.", "filter_applied"),
      ex("clear-filter", "Clear filter brings every read back.")])

goal("tv_capture_targets", "I want to target these regions for sequencing",
     ["design capture probes for my regions", "targeted sequencing panel", "make a capture panel"],
     ctx_kw(V_DM6_2R),
     "Capture panel: add regions, export probes.",
     "Design capture targets",
     [op("capture"),
      ex("capture-add-region", "Add the current view as a capture region; move and repeat for each target."),
      ex("capture-export", "The Export tab writes the targets as BED, FASTA or probes.")])

goal("tv_keep_for_later", "keep this analysis for later",
     ["hold on to all of this", "come back to this tomorrow", "don't lose my clusters", "I want to pick this up later"],
     ctx_kw(V_DM6_2R, **CLUSTERED),
     "Saving a session keeps data, view, clusters and settings.",
     "Save your analysis", SAVE_STEPS)

goal("tv_reads_over_gene", "show me reads over my gene",
     ["go to my gene", "reads at Pax6", "take me to my gene of interest"],
     ctx_kw(V_MM10_PAX6),
     "Search is the user's click; we can also navigate directly when the gene is named. Pax6 is named: navigate.",
     "Go to Pax6",
     [nav("Pax6", 5000),
      ex("search-bar", "Next time, type any gene or coordinates here and press Enter."),
      ex("reads-track", "The molecules over Pax6 are shown here.")])

goal("tv_two_loci_side_by_side", "compare two loci",
     ["look at two genes side by side", "view two regions at once", "compare eve and hb"],
     ctx_kw(V_DM6_2R),
     "Two places at once: a panel copy, unlinked and moved.",
     "Two loci side by side", COPY_STEPS)

goal("tv_highlight_nucleosome_size", "highlight nucleosome-sized footprints",
     ["colour the big footprints", "make nucleosomes a different colour", "highlight footprints by size"],
     ctx_kw(V_DM6_2R),
     "Colour by size: a labeling rule.",
     "Colour footprints by size",
     [op("colormap", "rules"),
      ex("labeling-rules", "Labeling rules colour footprints by size, layer, region, motif or track overlap."),
      ex("add-label-rule", "Add a rule for 120-180 bp and pick a colour; the first matching rule wins.")])

goal("tv_cluster_counts", "how many molecules are in each state?",
     ["count reads per cluster", "size of each population", "what fraction is in each group"],
     ctx_kw(V_DM6_2R, **CLUSTERED),
     "Clustered: the overview has read counts per cluster.",
     "Reads per cluster",
     [op("cluster-detail", "overview"),
      ex("clusters-overview", "Each cluster's read count is listed here, per dataset.", requires="has_clusters"),
      ex("clusters-composition", "Composition shows each cluster's mix of footprint types.")])

goal("tv_where_tf_sites", "where are the CTCF sites?",
     ["show CTCF binding", "find CTCF motifs", "where does CTCF bind here"],
     ctx_kw(V_HG38_TP53),
     "A named factor: ChIP tracks or motif collections from Browse hubs.",
     "Find CTCF sites",
     [op("track-browser"),
      ex("tracks-browse-hubs", "Search Browse hubs for CTCF: a ChIP-seq track shows binding, a motif collection shows sites."),
      tr("tracks-add-file", "Add the track you pick.", "track_added"),
      tr("reads-track", "Then Cmd/Ctrl+click a footprint at a CTCF site to see its occupancy.", "footprint_selected")])

goal("tv_mouse_start", "I'm studying Klf4 in mouse, how do I start?",
     ["set up for mouse Klf4", "start on mouse data at Klf4", "look at Klf4"],
     ctx_kw(V_HG38_MYC),
     "Viewport is on hg38: switch to mm10 first (user's pick), then go to Klf4.",
     "Mouse genome, then Klf4",
     [ex("sidebar-reference", "Genomes live in the settings sidebar under Reference & Tracks."),
      tr("genome-selector", "Pick mm10 from the Genome list.", "genome_loaded"),
      tr("search-bar", "Then search for Klf4.", "navigated"),
      ex("load-dataset", "Load your mouse reads with Load File if they aren't loaded yet.")])


# ═════════════════════════════════════════════════════════════════════
# 2. Ambiguous requests (resolve from state, or offer the options)
# ═════════════════════════════════════════════════════════════════════

COMPARE_OPTIONS = [
    ex(None, "Compare what? Here are the usual comparisons."),
    ex("reads-track", "Two samples: each loaded dataset has its own panel, and Layout puts them side by side."),
    ex("panel-add-copy", "Two places: + adds a copy of a panel that you can move to another locus."),
    ex("cluster-button", "Groups of molecules: Cluster, then Clusters > Profiles compares them."),
    ex("haplotype-compare", "Two haplotypes: Contacts > Compare puts them side by side."),
]

amb("tv_amb_compare", "compare",
    ["compare these", "can you compare", "i want to compare", "comparison?"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    "Truly ambiguous: one dataset, nothing clustered, no copy. Offer the four comparisons, one spotlight each.",
    "Which comparison do you mean?", COMPARE_OPTIONS)

amb("tv_amb_compare_samples_state", "compare them",
    ["compare the datasets", "how do they compare", "what's different between them"],
    ctx_kw(V_DM6_2R, DS_THREE),
    "Three datasets loaded and nothing else: 'them' is most likely the samples. Walk that, mention loci as the alternative.",
    "Compare the samples",
    [ex("reads-track", "Your three samples each have a panel; they follow the same view."),
     ex("layout-menu", "Layout lines them up side by side or stacked."),
     ex("cluster-button", "Clustering runs across all panels, so clusters compare directly between samples."),
     ex("panel-add-copy", "If you meant two places instead, + adds a panel copy you can move.")])

amb("tv_amb_compare_clusters_state", "compare these groups",
    ["compare them", "what's the difference between them", "how are they different"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY, **CLUSTERED),
    "Clusters exist and one dataset: 'these groups' are the clusters. Profiles and composition compare them.",
    "Compare the clusters",
    [op("cluster-detail", "profiles"),
     ex("clusters-profiles", "Profiles overlays each cluster's average so you can see where they differ.", requires="has_clusters"),
     ex("clusters-composition", "Composition compares their mix of footprint types."),
     ex("clusters-vplot", "V-Plot compares footprint sizes by position, cluster by cluster.")])

amb("tv_amb_compare_copy_state", "compare the two",
    ["compare these two views", "compare both panels", "how do the two panels differ"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY, copy_view={"chrom": "3R", "start": 11_998_000, "end": 12_008_000}),
    "State details: a panel copy shows 3R (hb). 'The two' are the main view and the copy.",
    "Compare the main view and the copy",
    [ex("panel-location-bar", "The copy shows its own region; its location bar says where.", requires="has_panel_copy"),
     ex("panel-link", "Link it to follow the main view again, or keep it unlinked to compare two loci."),
     ex("cluster-button", "Cluster clusters both panels together, so the same cluster means the same pattern at both places.")])

amb("tv_amb_compare_fu_samples", "the two samples",
    ["my samples", "the datasets", "between conditions"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY), previous_turns=[T_COMPARE_OPTIONS],
    thinking="The previous turn offered comparisons; they chose samples. Only one dataset is loaded, so load the second first.",
    summary="Compare two samples",
    actions=[tr("load-dataset", "Load the second sample with Load File.", "dataset_loaded"),
             ex("layout-menu", "Each gets a panel; Layout arranges them side by side."),
             ex("scan-peaks-button", "Scan and Cluster work across both panels.")])

amb("tv_amb_compare_fu_places", "two places",
    ["two regions", "two loci", "different genes"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY), previous_turns=[T_COMPARE_OPTIONS],
    thinking="They chose two places from the options: the panel copy walk.",
    summary="Two places side by side", actions=COPY_STEPS)

amb("tv_amb_compare_fu_groups", "groups of molecules",
    ["the clusters one", "compare groups", "groups of reads"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY), previous_turns=[T_COMPARE_OPTIONS],
    thinking="They chose clusters: walk clustering, then Profiles.",
    summary="Cluster, then compare the groups",
    actions=peaks_first() + [tr("cluster-button", "Click Cluster.", "clustered"),
                             op("cluster-detail", "profiles"),
                             ex("clusters-profiles", "Profiles compares the groups' average patterns.", requires="has_clusters")])

amb("tv_amb_look_at_this", "look at this",
    ["what is this", "check this out", "can you look at this"],
    ctx_kw(V_DM6_2R),
    "No selection in state and nothing to point at: explain how to tell Copilot or the browser what 'this' is.",
    "Looking at something specific",
    [ex(None, "Which part? You can pick things out like this."),
     ex("reads-track", "A footprint: Cmd/Ctrl+click it to open the Footprints panel."),
     ex("reads-track", "A read: Shift+click it to see Read Stats."),
     ex("peaks-track", "A peak: click it to select it for clustering or primers.")])

amb("tv_amb_look_gene_selected", "tell me about this gene",
    ["what about this gene", "analyze this gene", "what can I learn about this gene"],
    ctx_kw(V_DM6_2R), **SELECTED_EVE,
    thinking="eve is the selected gene: TSS-relative view and the Transcription panel are the gene-level analyses.",
    summary="What you can do with the selected gene",
    actions=[ex("relative-coords", "TSS-relative coordinates read positions from the eve TSS."),
             op("transcription-state", "distribution"),
             ex("transcription-distribution", "Pol II states of the reads at eve.", requires="has_selected_gene"),
             ex("scan-peaks-button", "Scan finds accessible peaks near it for clustering.")])

amb("tv_amb_analyze_peak", "analyze this peak",
    ["do something with this peak", "analyse the peak", "what's going on at this peak"],
    ctx_kw(V_DM6_2R),
    "Most likely: cluster the reads at the selected peak. Mention primers as the alternative.",
    "Cluster the reads at the peak",
    [ex(None, "The usual analysis of a peak is clustering its molecules by their footprints."),
     tr("peaks-track", "Click the peak to select it.", "peak_selected", skip_if="has_selected_peak"),
     tr("cluster-button", "Click Cluster.", "clustered"),
     ex("clusters-overview", "The groups of molecules at the peak, with counts.", requires="has_clusters"),
     ex("primers-design-tab", "If you wanted primers for it instead, the Primers panel designs them around the peak.")])

amb("tv_amb_analyze_peak_fu_primers", "no, I meant primers",
    ["primers instead", "I want primers for it", "not clustering, primers"],
    ctx_kw(V_DM6_2R), previous_turns=[T_ANALYZE_PEAK],
    thinking="Correction after the clustering walk: primers around the selected peak.",
    summary="Primers around the peak", actions=PRIMER_STEPS)

amb("tv_amb_analyze_peak_fu_footprints", "what's bound at it?",
    ["the footprints at the peak", "what factors are at the peak", "what binds there"],
    ctx_kw(V_DM6_2R), previous_turns=[T_ANALYZE_PEAK],
    thinking="Follow-up about binding at the peak: footprint walk.",
    summary="Footprints at the peak", actions=TF_WALK[2:])

amb("tv_amb_sort", "sort these molecules",
    ["sort", "can you sort these", "order them", "sort pls"],
    ctx_kw(V_DM6_2R),
    "No clusters: 'them' are the reads. Sort button; rules for custom orders.",
    "Sort the reads",
    [ex("sort-controls-expand", "Click the small Sort label for the options."),
     tr("sort-button", "Click Sort to order the reads.", "sorted"),
     ex("sort-rules", "Sort rules set what they're ordered by, e.g. TF footprints at a peak.")])

amb("tv_amb_sort_clustered", "sort these",
    ["sort them out", "put them in order", "reorder"],
    ctx_kw(V_DM6_2R, **CLUSTERED),
    "Clusters exist: sorting orders reads within each cluster; the cluster order can be locked.",
    "Sort within clusters",
    [tr("sort-button", "Click Sort: reads are ordered within each cluster.", "sorted"),
     ex("sort-controls-expand", "Click the small Sort label for more options."),
     ex("cluster-order-lock", "Lock cluster order keeps the clusters themselves in place.", requires="has_clusters")])

amb("tv_amb_filter", "filter",
    ["filter those", "I want to filter", "can I filter", "filtering?"],
    ctx_kw(V_DM6_2R),
    "No filter active: offer the three kinds.",
    "Which filter do you mean?",
    [ex("quality-filters", "Low-quality calls: Quality sets confidence cutoffs."),
     ex("filter-rules", "Reads by content: filter rules keep reads with, e.g., a footprint at a peak."),
     ex("annotations-filter", "Reads by annotation: the Annotations panel filters by per-read annotation types.")])

amb("tv_amb_filter_fu_quality", "the low quality ones",
    ["quality", "bad reads", "noisy calls"],
    ctx_kw(V_DM6_2R), previous_turns=[T_FILTER_OPTIONS],
    thinking="They chose quality: walk the quality controls.",
    summary="Filter low-quality calls",
    actions=[ex("quality-controls-expand", "Click the small Quality label."),
             ex("quality-cutoffs", "Set cutoffs for call confidence; calls below them are hidden."),
             ex("read-filters", "Read Filters in the sidebar also drops short reads or reads with few footprints.")])

amb("tv_amb_filter_fu_rule", "reads with a footprint at the peak",
    ["by content", "the rule one", "rule based filtering"],
    ctx_kw(V_DM6_2R), previous_turns=[T_FILTER_OPTIONS],
    thinking="They chose rule filters.",
    summary="Filter by a rule",
    actions=[op("cluster-features", "filter"),
             ex("add-filter-rule", "Add a filter rule: footprint of a size range at the selected peaks."),
             tr("filter-button", "Click Filter.", "filter_applied")])

amb("tv_amb_filter_active", "filter these",
    ["filter", "more filtering", "change the filter"],
    ctx_kw(V_DM6_2R, filtered={0: 40}),
    "State details: a filter is already active on the first panel (40 reads). Explain it and how to change or clear it.",
    "Your current filter",
    [ex("filter-button", "A filter is on: the first panel shows 40 reads that pass it."),
     ex("filter-rules", "Edit the rule here to filter differently."),
     ex("clear-filter", "Clear filter shows every read again.")])

EXPORT_OPTIONS = [
    ex("export-figure", "A picture: Export saves the view as PNG, SVG or PDF, or its data."),
    ex("save-session", "Your whole analysis: Save downloads a session file."),
    ex("primers-order-tab", "Primers: the Order List tab exports an order sheet."),
    ex("capture-export", "Capture targets: Capture > Export writes BED, FASTA or probes."),
]

amb("tv_amb_export", "export",
    ["export this", "how do I export stuff", "download", "get it out of here"],
    ctx_kw(V_DM6_2R),
    "Export of what is unclear: offer figure, session, primers, capture.",
    "What would you like to export?", EXPORT_OPTIONS)

amb("tv_amb_export_fu_figure", "the picture",
    ["a figure", "an image", "the plot"],
    ctx_kw(V_DM6_2R), previous_turns=[T_EXPORT_OPTIONS],
    thinking="They chose the figure.",
    summary="Export a figure", actions=EXPORT_FIGURE[2:])

amb("tv_amb_export_fu_data", "the data behind it",
    ["the numbers", "a table", "the raw values"],
    ctx_kw(V_DM6_2R), previous_turns=[T_EXPORT_OPTIONS],
    thinking="Data export: Export also saves the data behind the view; Read Stats has a table for selected reads.",
    summary="Export the data",
    actions=[ex("export-figure", "Export can also save the data behind the view instead of an image."),
             tr("reads-track", "For per-read numbers, Shift+click or drag across reads.", "reads_selected"),
             ex("read-stats-table", "Read Stats > Table lists each selected read and exports it.", requires="has_selected_reads")])

amb("tv_amb_show_more", "show me more",
    ["more", "see more", "show more"],
    ctx_kw(V_DM6_2L),
    "Ambiguous: more region or more reads. The view is narrow (6 kb), so zoom out (navigation, allowed) and mention all reads.",
    "Zoom out",
    [zoom("out", 1),
     ex("zoom-out", "Zoom out shows more of the region; reads are drawn up to the read window."),
     ex("read-display-mode", "If you meant more reads, switch from a sample to all reads here.")])

amb("tv_amb_show_more_reads", "show more reads",
    ["I want to see all the reads", "why am I only seeing part of the reads", "more molecules"],
    ctx_kw(V_DM6_2R),
    "More reads: all vs sampled, row height, spanning-only.",
    "Show more reads",
    [ex("reads-controls-expand", "Click the small Reads label."),
     ex("read-display-mode", "Switch from a sample to all reads here."),
     ex("row-height", "A smaller row height fits more reads on screen."),
     ex("spanning-toggle", "Turn off Spanning only to include reads that don't cover the whole view.")])

amb("tv_amb_bigger", "make it bigger",
    ["bigger", "make it larger", "I can't see it, too small"],
    ctx_kw(V_DM6_2R),
    "Bigger could mean the rows or the panel; offer both, plus zoom.",
    "Make it bigger",
    [ex("row-height", "Taller molecules: raise the row height."),
     ex("panel-full-view", "A bigger panel: Full view gives one panel the whole window."),
     ex("zoom-in", "More detail: zoom in.")])

amb("tv_amb_colour", "change the colour",
    ["change colours", "different colour please", "recolour"],
    ctx_kw(V_DM6_2R),
    "Colour of footprints (labeling rules) or of a dataset (Loaded Datasets).",
    "Which colour?",
    [ex("labeling-rules", "Footprint colours: Labeling rules colour by size, layer, region or motif."),
     ex("loaded-datasets", "A dataset's colour: set it under Loaded Datasets.")])

amb("tv_amb_save", "save",
    ["where do I save stuff", "keep this", "can I store this"],
    ctx_kw(V_DM6_2R),
    "Save the whole session (most likely), or a footprint definition.",
    "Save your work",
    [tr("save-session", "Click Save to download a session with your data, view and settings.", "session_saved"),
     ex("footprints-saved", "To keep a footprint definition instead, save it from the Footprints panel; it's listed in Saved.")])

amb("tv_amb_save_clustered", "save what I have",
    ["keep these", "save these clusters", "save these results"],
    ctx_kw(V_DM6_2R, **CLUSTERED),
    "Clusters exist: a cluster snapshot keeps this clustering; Save keeps everything.",
    "Save the clustering",
    [ex("cluster-snapshot", "Snapshot saves this clustering so you can switch back to it.", requires="has_clusters"),
     ex("clusters-saved", "Saved snapshots are listed in the Saved tab."),
     tr("save-session", "Save downloads the whole session too.", "session_saved")])

amb("tv_amb_reset", "reset",
    ["reset everything", "start over", "undo everything"],
    ctx_kw(V_DM6_2R, **CLUSTERED),
    "Reset what? View, clusters or a step. Offer the three.",
    "What would you like to reset?",
    [ex("undo", "One step back: Undo (Cmd/Ctrl+Z); the timeline goes further."),
     ex("cluster-clear", "The clustering: Clear clusters removes it.", requires="has_clusters"),
     ex("search-bar", "The view: type a region here, or ask me to reset the view.")])

amb("tv_amb_reset_fu_view", "just the view",
    ["the zoom", "back to the default view", "reset the zoom"],
    ctx_kw(V_DM6_2R, **CLUSTERED), previous_turns=[T_RESET_OPTIONS],
    thinking="Reset the view: reset_view is navigation, so do it.",
    summary="Reset the view",
    actions=[{"type": "reset_view"}, ex("history-timeline", "The timeline can jump back to any earlier view.")])

amb("tv_amb_merge", "merge",
    ["combine", "merge these", "merge stuff"],
    ctx_kw(V_DM6_2R, DS_THREE),
    "Merge clusters or merge datasets? No clusters in state; three datasets. Offer both, datasets first.",
    "Which merge do you mean?",
    [ex("layout-merge", "Datasets: the Layout panel's Merge datasets pools replicates into one panel."),
     ex("merge-similar", "Clusters: Merge similar clusters folds near-duplicates together once you've clustered.")])

amb("tv_amb_merge_clustered", "merge those",
    ["combine them", "merge these together", "join those clusters"],
    ctx_kw(V_DM6_2R, DS_FIBER_ONLY, **CLUSTERED),
    "Clusters exist and one dataset: merge clusters.",
    "Merge similar clusters",
    [ex("merge-similar", "Merge similar clusters folds small and near-duplicate clusters into their nearest one.",
        requires="has_clusters"),
     ex("merge-settings", "The settings set how small and how similar; the Projection tab previews it."),
     tr("merge-similar", "Click Merge similar clusters.", "clusters_merged")])

amb("tv_amb_merge_fu_datasets", "the datasets, not clusters",
    ["the files", "the replicates", "the data files"],
    ctx_kw(V_DM6_2R, DS_THREE), previous_turns=[T_MERGE_OPTIONS],
    thinking="They chose merging datasets.",
    summary="Merge datasets",
    actions=[op("dataset-layout"),
             ex("layout-merge", "Select the datasets and click Merge datasets."),
             ex("layout-link", "Or link them instead, to keep separate panels that move together.")])

amb("tv_amb_open_panel", "open the panel",
    ["open it", "which panel", "show the panel"],
    ctx_kw(V_DM6_2R),
    "No panel named: point at the analysis strip where every analysis panel opens.",
    "Where the analysis panels are",
    [ex("analysis-strip", "Every analysis panel opens from this strip: Clusters, Footprints, Rules, Tracks and more."),
     ex(None, "Tell me which analysis you want and I'll open it and walk you through it.")])

amb("tv_amb_next", "next",
    ["then what", "and then?", "next step"],
    ctx_kw(V_DM6_2R), previous_turns=[turn("how do I find peaks?", "How to find and use peaks",
                                            ["explain", "try_it", "try_it", "explain"])],
    thinking="After the peaks walk, the natural next step is clustering at the selected peak.",
    summary="Next: cluster at the peak",
    actions=[ex("cluster-controls-expand", "Show the cluster controls with the small Cluster label."),
             tr("cluster-button", "With a peak selected, click Cluster.", "clustered", requires="has_selected_peak"),
             ex("clusters-overview", "Your clusters, with counts.", requires="has_clusters")])

amb("tv_amb_run_it", "run it",
    ["go", "do it", "start"],
    ctx_kw(V_DM6_2R), previous_turns=[T_CLUSTER_WALK],
    thinking="'Run it' after the clustering walk: the Cluster click is the user's. Hand it over.",
    summary="Your turn: run the clustering",
    actions=[ex(None, "You run it: I'll show you where."),
             tr("cluster-button", "Click Cluster.", "clustered"),
             ex("clusters-overview", "Here are the results.", requires="has_clusters")])

amb("tv_amb_again", "do that again",
    ["again", "repeat that", "once more"],
    ctx_kw(V_DM6_3R), previous_turns=[T_CLUSTER_WALK],
    thinking="Repeat the clustering, here at the new view: the user clicks; peaks first if needed.",
    summary="Cluster again here",
    actions=peaks_first() + [tr("cluster-button", "Click Cluster again.", "clustered")])

amb("tv_amb_zoom", "zoom",
    ["zoom please", "zoom it", "change the zoom"],
    ctx_kw(V_DM6_2R),
    "In or out? Point at both and the search box for exact regions.",
    "Zooming",
    [ex("zoom-in", "Zoom in for more detail."), ex("zoom-out", "Zoom out for more of the region."),
     ex("search-bar", "Or type an exact region here.")])

amb("tv_amb_clean_up_clustered", "clean this up",
    ["tidy this up", "too messy", "simplify"],
    ctx_kw(V_DM6_2R, **CLUSTERED),
    "Clustered: tidying = merging similar clusters and locking order.",
    "Tidy the clusters",
    [ex("merge-similar", "Merge similar clusters folds tiny and near-duplicate clusters away.", requires="has_clusters"),
     tr("merge-similar", "Click it when you're ready.", "clusters_merged"),
     ex("cluster-order-lock", "Lock cluster order keeps them in place while you work.")])

amb("tv_amb_clean_up", "this looks messy",
    ["clean up the view", "too cluttered", "too much on screen"],
    ctx_kw(V_DM6_2R, DS_THREE),
    "Not clustered, three panels: tidy the layout and the layers.",
    "Tidy the view",
    [ex("layout-menu", "Layout evens out panel widths or stacks them."),
     ex("layer-toggles", "Turn off layers you don't need."),
     ex("panel-minimize", "Minimize panels you're not looking at.")])

amb("tv_amb_highlight", "highlight it",
    ["mark it", "make it stand out", "highlight this footprint"],
    ctx_kw(V_DM6_2R),
    "Highlight a footprint: save it (coloured everywhere) or a labeling rule.",
    "Highlighting",
    [tr("reads-track", "Cmd/Ctrl+click the footprint.", "footprint_selected", skip_if="has_selected_footprint"),
     tr("save-footprint", "Save it: saved footprints are coloured on every read that carries them.", "footprint_saved"),
     ex("labeling-rules", "Or colour a whole size class with a labeling rule.")])

amb("tv_amb_numbers", "give me numbers",
    ["quantify this", "stats please", "I need numbers"],
    ctx_kw(V_DM6_2R),
    "Numbers: Read Stats for reads, the Footprints panel for occupancy, the Clusters overview for counts.",
    "Where the numbers are",
    [ex("reads-track", "Reads: Shift+click or drag across reads and Read Stats summarises them."),
     ex("reads-track", "Footprints: Cmd/Ctrl+click one and the Footprints panel gives its occupancy."),
     ex("cluster-button", "Groups: Cluster, then the Clusters panel counts reads per cluster.")])


# ═════════════════════════════════════════════════════════════════════
# 3. Orientation
# ═════════════════════════════════════════════════════════════════════

orient("tv_help_empty", "help me",
       ["hi", "hello?", "what do I do", "i need some help"],
       ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
       "Nothing loaded (diagnostics). Start: the Tour (it loads a demo), or load data and a genome.",
       "Getting started",
       [ex("guided-tour", "Tour walks you through every main tool on a demo dataset: the quickest start."),
        ex("load-dataset", "Or load your own data with Load File (BAM or BigBed)."),
        ex("genome-selector", "Pick your genome here so genes and sequence show.")])

orient("tv_help_loaded", "help me",
       ["hey, help", "can you help", "I need some help here"],
       ctx_kw(V_DM6_2R),
       "Data is loaded: orient to the reads track and the main toolbar groups, offer the Tour.",
       "A quick orientation",
       [ex("reads-track", "Each row is one molecule; coloured blocks are footprints, gaps are open DNA."),
        ex("peaks-toolbar", "Scan finds accessible peaks; select one to analyse it."),
        ex("cluster-toolbar", "Cluster groups molecules by their footprints at the selected peaks."),
        ex("analysis-strip", "Analysis panels (Clusters, Footprints, Tracks and more) open from here."),
        ex("guided-tour", "Tour walks through all of it step by step.")])

orient("tv_new_empty", "I'm new",
       ["first time using this", "new user here", "never used this before"],
       ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
       "Newcomer, empty browser: Tour first, then data.",
       "Welcome",
       [ex("guided-tour", "Start with the Tour: it loads a demo and shows every main tool."),
        ex("load-dataset", "When you're ready, load your own file with Load File."),
        ex(None, "Ask me 'how do I…' any time and I'll show you where things are.")])

orient("tv_new_loaded", "where do I start?",
       ["what should I do first", "where to begin", "how do I get going"],
       ctx_kw(V_DM6_2R),
       "Data loaded: search a locus, scan peaks, cluster; the Tour for the full picture.",
       "Where to start",
       [ex("search-bar", "Go to a gene or region you care about."),
        ex("scan-peaks-button", "Scan finds accessible peaks there."),
        ex("cluster-button", "Select a peak and Cluster to find groups of molecules."),
        ex("guided-tour", "The Tour shows every tool in order.")])

orient("tv_start_hg38", "how do I get started with my human data?",
       ["getting started with hg38", "first steps with human fiber-seq", "set up for human data"],
       ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
       "Empty: genome (hg38), then load, then a gene.",
       "Get started with human data",
       [tr("genome-selector", "Pick hg38 from the Genome list.", "genome_loaded"),
        tr("load-dataset", "Load your BAM or BigBed with Load File.", "dataset_loaded"),
        ex("search-bar", "Then search for a gene, e.g. MYC.")])

orient("tv_what_can_it_do", "what can this do?",
       ["what is this tool for", "what does fiberbrowser do", "features?", "what is this capable of"],
       ctx_kw(V_DM6_2R),
       "Overview of the main analyses, one spotlight each, then the Tour.",
       "What FiberBrowser does",
       [ex("reads-track", "Shows single molecules: footprints, open DNA and base modifications per read."),
        ex("cluster-button", "Finds groups of molecules with similar footprint patterns."),
        ex("footprints-classes", "Measures footprints: occupancy, size classes and motifs."),
        ex("tracks-browse-hubs", "Adds external tracks such as ChIP-seq and motifs."),
        ex("primers-design-tab", "Designs primers and capture regions."),
        ex("guided-tour", "The Tour walks through each of these.")])

orient("tv_what_looking_at", "so what am I actually looking at?",
       ["what is this screen", "what am I seeing", "what's all this"],
       ctx_kw(V_DM6_2R),
       "Data loaded: explain the reads track, peaks track, layers and the gene/axis.",
       "Reading the screen",
       [ex("reads-track", "Each row is one DNA molecule; blocks are protein footprints, gaps are accessible DNA."),
        ex("layer-toggles", "Colours are layers: TF footprints, nucleosomes, accessible stretches, modified bases."),
        ex("peaks-track", "The Peaks track marks positions open on many molecules."),
        ex("search-bar", "The location is shown and changed here.")])

orient("tv_what_looking_daf", "what am I looking at here?",
       ["explain what's shown", "what are these reads", "what do these rows mean"],
       ctx_kw(V_DM6_2R, DS_FIBER_DAF),
       "A DAF-seq dataset is loaded too: mention strands.",
       "Reading fiber-seq and DAF-seq panels",
       [ex("reads-track", "Each row is one molecule; blocks are footprints, gaps are open DNA."),
        ex("strand-chip", "DAF-seq panels read one strand per molecule; the strand chip shows CT, GA or both."),
        ex("layer-toggles", "Colours are layers: footprints, nucleosomes, accessible stretches, deamination.")])

orient("tv_what_looking_zoomed", "what is this grey histogram?",
       ["why are there bars instead of reads", "what's this coverage thing", "why a histogram"],
       ctx_kw(V_DM6_WIDE, diagnostics=[zoomed_out("Embryo 2-4hr", "600.0 kb", "50.0 kb")]),
       "Diagnostics: zoomed out past the read window, so coverage is shown. Zoom in (navigation) and explain.",
       "Coverage is shown when zoomed out",
       [ex("read-window-setting", "Zoomed out past the read window, each panel shows read coverage instead of molecules."),
        region("2R", 9_975_000, 10_025_000),
        ex("zoom-in", "Zoomed in, the molecules are drawn again.")])

orient("tv_explain_screen", "explain this screen",
       ["give me a tour of the layout", "what are the parts of the screen", "walk me around the interface"],
       ctx_kw(V_DM6_2R),
       "Parts: toolbar, sidebar, dataset panels, analysis strip; Tour for more.",
       "The parts of the screen",
       [ex("search-bar", "Top: search and zoom, then toolbar groups for reads, peaks, clustering, sorting and filters."),
        ex("sidebar-toggle", "The settings sidebar holds data, genome, display and analysis settings."),
        ex("reads-track", "The middle: one panel per dataset, molecules as rows."),
        ex("analysis-strip", "Bottom: analysis panels open here."),
        ex("guided-tour", "Tour goes through each part in detail.")])

orient("tv_colours_mean", "what do the colours mean?",
       ["what are the colours", "why are some blocks different colours", "colour legend?"],
       ctx_kw(V_DM6_2R),
       "Colours: layers, labeling rules, dataset colour.",
       "What the colours mean",
       [ex("layer-toggles", "Each layer has a colour: TF footprints, nucleosomes, accessible stretches, modified bases."),
        ex("labeling-rules", "Labeling rules recolour footprints by size, region or motif; the first match wins."),
        ex("loaded-datasets", "Each dataset also has its own colour, shown in its panel header.")])

orient("tv_colours_clustered", "what's the coloured bar?",
       ["what are the colours on the left", "the coloured strip by the reads", "what does the colour column mean"],
       ctx_kw(V_DM6_2R, **CLUSTERED),
       "Clustered: the bar left of the reads is cluster membership.",
       "The cluster bar",
       [ex("cluster-focus-bar", "The bar left of the reads colours each molecule by its cluster.", requires="has_clusters"),
        ex("clusters-overview", "Click a colour to focus that cluster; the Clusters panel lists them all.")])

orient("tv_panels_difference", "what's the difference between the panels?",
       ["why are there so many panels", "which panel does what", "panels explained"],
       ctx_kw(V_DM6_2R, DS_THREE),
       "Dataset panels vs analysis panels vs sidebar.",
       "Dataset panels and analysis panels",
       [ex("reads-track", "Dataset panels show the molecules of one dataset each, all following the view."),
        ex("analysis-strip", "Analysis panels (Clusters, Footprints, Rules, Tracks…) open from this strip and analyse the view."),
        ex("sidebar-toggle", "The sidebar holds settings: data, genome, display, analysis.")])

orient("tv_sidebar_what", "what's in the sidebar?",
       ["what are the sidebar sections", "the settings sidebar", "sidebar contents"],
       ctx_kw(V_DM6_2R),
       "The four sidebar sections.",
       "The settings sidebar",
       [ex("sidebar-data", "Data & Sessions: load files and sessions, loaded datasets."),
        ex("sidebar-reference", "Reference & Tracks: genome, FASTA, annotations."),
        ex("sidebar-reads-display", "Reads & Display: read window, display and read filters."),
        ex("sidebar-analysis", "Analysis & Reproducibility: peak detection settings and seeds.")])

orient("tv_toolbar_what", "what are all these buttons?",
       ["what does the toolbar do", "explain the toolbar", "so many buttons"],
       ctx_kw(V_DM6_2R),
       "Toolbar groups, left to right.",
       "The toolbar",
       [ex("reads-toolbar", "Reads: how molecules are shown."),
        ex("peaks-toolbar", "Peaks: Scan, lock and draw peaks."),
        ex("cluster-toolbar", "Cluster: group molecules; click a group's small label for more controls."),
        ex("sort-button", "Sort and Filter: order and filter reads."),
        ex("quality-filters", "Quality: confidence cutoffs.")])

orient("tv_tutorial_exists", "is there some kind of tutorial?",
       ["is there a walkthrough", "guided tour?", "how do I learn this"],
       ctx_kw(V_DM6_2R),
       "The Tour.",
       "The guided Tour",
       [ex("guided-tour", "Tour walks through every main tool step by step; your data and view come back afterwards."),
        ex(None, "You can also ask me 'how do I…' about any task.")])

orient("tv_try_without_data", "can I try it without my own data?",
       ["is there demo data", "I don't have a file yet", "example dataset?"],
       ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
       "The Tour loads a demo dataset.",
       "Try it with the demo",
       [ex("guided-tour", "Tour loads a demo dataset and shows every tool on it."),
        ex("load-dataset", "Later, load your own with Load File.")])

orient("tv_shortcuts", "any shortcuts?",
       ["keyboard shortcuts", "tips and tricks", "power user tips"],
       ctx_kw(V_DM6_2R),
       "The main modifier clicks and undo.",
       "Useful shortcuts",
       [ex("reads-track", "Cmd/Ctrl+click a footprint to analyse it; Shift+click a read for Read Stats."),
        ex("peaks-track", "Cmd/Ctrl+click adds peaks to the selection."),
        ex("undo", "Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z redoes.")])

orient("tv_lost_clustered", "I'm lost",
       ["I don't know what I'm doing", "confused", "where was I"],
       ctx_kw(V_DM6_2R, **CLUSTERED),
       "State: clustered. Tell them where they are and the next steps; timeline for going back.",
       "Where you are",
       [ex("clusters-overview", "You've clustered the reads here; the Clusters panel lists the groups.", requires="has_clusters"),
        ex("history-timeline", "The timeline shows every step you took and jumps back to any of them."),
        ex("guided-tour", "The Tour recaps every tool.")])

orient("tv_what_next_state", "what should I do next?",
       ["what now", "any suggestions", "what else can I do here"],
       ctx_kw(V_DM6_2R, **CLUSTERED),
       "No previous turn, but clusters exist: results, footprints, save.",
       "Next steps with your clusters",
       [ex("clusters-profiles", "Compare the clusters' average profiles.", requires="has_clusters"),
        ex("merge-similar", "Merge near-duplicate clusters."),
        ex("reads-track", "Cmd/Ctrl+click a footprint that differs between clusters to measure it."),
        ex("save-session", "Save the session to keep it.")])

orient("tv_what_can_you_do", "what are you able to help with?",
       ["what are you for", "how can copilot help", "what do you do"],
       ctx_kw(V_DM6_2R),
       "Explain Copilot's role: it teaches and navigates; the user clicks.",
       "What I can do",
       [ex(None, "I show you how to do things: I open the right panels, move the view and point at each control, and you click."),
        ex(None, "Ask 'how do I cluster?', 'where is the genome list?' or 'why are no reads visible?'."),
        ex("guided-tour", "For a full walkthrough, try the Tour.")])


# ═════════════════════════════════════════════════════════════════════
# 4. Underspecified how-tos (loosely described controls)
# ═════════════════════════════════════════════════════════════════════

vague("tv_thing_colours", "how do I do the thing with the colours",
      ["the colour thing", "that colouring feature", "the colour rules thing"],
      ctx_kw(V_DM6_2R),
      "The colouring feature is the Labeling panel's rules.",
      "Labeling rules",
      [op("colormap", "rules"),
       ex("labeling-rules", "Labeling rules colour footprints by size, layer, region, motif or track overlap."),
       ex("add-label-rule", "Add a rule, set its condition and colour; the first matching rule wins.")])

vague("tv_thing_clustering", "that clustering thing",
      ["the clustering", "how does the grouping thing work", "that group-the-reads feature"],
      ctx_kw(V_DM6_2R),
      "Clustering walk.",
      "Clustering", CLUSTER_SHORT)

vague("tv_thing_circles", "the panel with the circles",
      ["the circle panel", "the round genome view", "circular map thing"],
      ctx_kw(V_DM6_2R),
      "The circle panel is Regions (circular genome/plasmid view).",
      "The Regions panel",
      [op("circular-genome"),
       ex("regions-add-view", "Regions shows the chromosome as a circle; Add View saves the current view as a region."),
       ex("regions-plasmid", "Load a plasmid map here to browse a plasmid as a circle.")])

vague("tv_thing_heatmap", "where's the heatmap?",
      ["the heatmap thing", "the square plot", "the matrix"],
      ctx_kw(V_DM6_2R),
      "No contact map is loaded (nothing in state): the heatmap is most likely co-accessibility; mention the contact map.",
      "The co-accessibility heatmap",
      [op("co-accessibility"),
       ex("coacc-matrix", "This heatmap shows how often pairs of positions are open on the same molecule."),
       ex("contacts-map", "If you meant the Micro-C / DAF-C contact map, it's the Contacts panel's Map tab.")])

vague("tv_thing_heatmap_fu_contacts", "no, the contact one",
      ["the micro-c one", "the other heatmap", "contact map"],
      ctx_kw(V_DM6_2R), previous_turns=[T_HEATMAP],
      thinking="Correction: the contact map heatmap.",
      summary="The contact map", actions=CONTACT_WALK)

vague("tv_thing_arcs", "the arcs",
      ["what are the arcs", "the loop drawing", "curved lines thing"],
      ctx_kw(V_DM6_2R),
      "Arcs link two positions: co-accessibility (open together) or contacts (touch). Offer both.",
      "What the arcs show",
      [ex("coacc-matrix", "Arcs can link positions that are open on the same molecules: that's co-accessibility."),
       ex("contacts-map", "Or positions that touch in 3D: that's the contact map.")])

vague("tv_thing_sidebar", "the sidebar thing",
      ["where's the sidebar", "the side menu", "the settings panel on the side"],
      ctx_kw(V_DM6_2R),
      "The settings sidebar.",
      "The settings sidebar",
      [ex("sidebar-toggle", "This button opens the settings sidebar."),
       ex("sidebar-data", "It has sections for data and sessions, the reference, display and analysis settings.")])

vague("tv_thing_lock", "what's the little lock?",
      ["the lock icon", "what does the padlock do", "lock button"],
      ctx_kw(V_DM6_2R),
      "The lock next to Scan keeps peaks; clustered order has its own lock.",
      "The lock",
      [ex("peaks-controls-expand", "Click the small Peaks label to show it."),
       ex("peaks-lock", "Lock peaks keeps the current peaks while you move around, instead of rescanning."),
       ex(None, "After clustering, a second lock in the Sort group keeps the cluster order.")])

vague("tv_thing_plus", "what's the plus button on the panel?",
      ["the + on the panel header", "the little plus", "what does + do"],
      ctx_kw(V_DM6_2R),
      "The + adds a panel copy.",
      "The + button",
      [ex("panel-add-copy", "+ adds a copy of the dataset panel; it follows the main view until you unlink it."),
       tr("panel-add-copy", "Try it: click +.", "panel_copy_made", skip_if="has_panel_copy"),
       ex("panel-link", "Unlink the copy to move it somewhere else.", requires="has_panel_copy")])

vague("tv_thing_bar_left", "the bar next to the reads",
      ["the coloured column", "what's that strip on the left", "the colours beside each read"],
      ctx_kw(V_DM6_2R, **CLUSTERED),
      "Clustered: the cluster bar.",
      "The cluster bar",
      [ex("cluster-focus-bar", "It colours each molecule by its cluster; click a colour to focus that cluster.",
          requires="has_clusters")])

vague("tv_thing_dots", "the little dots on the reads",
      ["what are the specks", "dots on the molecules", "the tick marks on reads"],
      ctx_kw(V_DM6_2R),
      "Dots are modified bases (m6A / deamination) as a layer.",
      "The dots are modified bases",
      [ex("layer-toggles", "The dots are modified bases (m6A, or deamination on DAF-seq); toggle them with the layer switches."),
       ex("row-height", "A taller row height makes them easier to see.")])

vague("tv_thing_bottom", "the panels at the bottom",
      ["what's down there", "the bottom strip", "the tabs at the bottom"],
      ctx_kw(V_DM6_2R),
      "The analysis strip.",
      "The analysis strip",
      [ex("analysis-strip", "Each analysis panel (Clusters, Footprints, Rules, Tracks, Primers…) opens from here.")])

vague("tv_thing_bumps", "the row with the bumps",
      ["the bumpy track", "the humps above the reads", "what's that row of hills"],
      ctx_kw(V_DM6_2R),
      "The Peaks track.",
      "The Peaks track",
      [ex("peaks-track", "That's the Peaks track: each bump is a position open on many molecules."),
       tr("scan-peaks-button", "Click Scan to (re)find them.", "peaks_scanned", skip_if="has_peaks")])

vague("tv_thing_timeline", "the timeline thing",
      ["the history thing", "list of steps", "where are my previous steps"],
      ctx_kw(V_DM6_2R),
      "History timeline.",
      "The history timeline",
      [ex("history-timeline", "The timeline lists every step you took; click one to jump back."),
       ex("undo", "Undo steps back one at a time.")])

vague("tv_thing_vplot", "the v shaped plot",
      ["the V plot", "the triangle plot", "the size vs position plot"],
      ctx_kw(V_DM6_2R, **CLUSTERED),
      "V-Plot in the Clusters panel.",
      "The V-Plot",
      [op("cluster-detail", "vplot"),
       ex("clusters-vplot", "Footprint size (up) against position (across): nucleosomes sit high, TF footprints low.",
          requires="has_clusters")])

vague("tv_thing_scatter", "the scatter plot with dots",
      ["the dot cloud", "the plot with lots of points", "PCA thing"],
      ctx_kw(V_DM6_2R, **CLUSTERED),
      "Projection tab.",
      "The Projection tab",
      [op("cluster-detail", "projection"),
       ex("clusters-projection", "Each dot is one read, placed by its footprint pattern and coloured by cluster.",
          requires="has_clusters")])

vague("tv_thing_order_sheet", "the order sheet",
      ["where's the order list", "primer order thing", "the shopping list for primers"],
      ctx_kw(V_DM6_2R),
      "Primers > Order List.",
      "The primer Order List",
      [op("primer-design", "order"),
       ex("primers-order-tab", "Pairs you add from the Design tab collect here; export them as an order sheet.")])

vague("tv_thing_ct_ga", "that CT GA button",
      ["the strand button", "the CT GA thing", "strand switch"],
      ctx_kw(V_DM6_2R, DS_FIBER_DAF),
      "The strand chip.", "The strand chip", STRAND_STEPS)

vague("tv_thing_type_coords", "where do I type coordinates",
      ["where do I put a region", "where's the box to type a position", "how do I enter coordinates"],
      ctx_kw(V_DM6_2R),
      "The search box.", "The search box",
      [ex("search-bar", "Type a gene or chr:start-end here and press Enter."),
       tr("search-bar", "Try it with a region.", "navigated")])

vague("tv_thing_rules", "the rules thing",
      ["rules panel", "where are the rules", "that rule builder"],
      ctx_kw(V_DM6_2R),
      "The Rules panel: cluster, sort, filter tabs.",
      "The Rules panel",
      [op("cluster-features", "cluster"),
       ex("rules-cluster-tab", "Cluster rules define what counts as a feature when clustering."),
       ex("rules-sort-tab", "Sort rules set custom read orders."),
       ex("rules-filter-tab", "Filter rules keep only reads that match.")])

vague("tv_thing_quality", "the quality thing",
      ["quality settings", "the confidence thing", "quality cutoff"],
      ctx_kw(V_DM6_2R),
      "The Quality group.",
      "Quality settings",
      [ex("quality-filters", "Quality hides calls below a confidence you choose."),
       ex("quality-controls-expand", "Click the small Quality label to show the cutoffs."),
       ex("quality-cutoffs", "Set the cutoffs here.")])

vague("tv_thing_encode", "the ENCODE thing",
      ["the UCSC tracks thing", "external data thing", "hub browser"],
      ctx_kw(V_HG38_MYC),
      "Browse hubs in the Tracks panel.",
      "Browse hubs",
      [op("track-browser"),
       ex("tracks-browse-hubs", "Browse hubs searches ENCODE, UCSC and ChIP-Atlas tracks for your genome."),
       tr("tracks-browse-hubs", "Search for a factor and add a track.", "track_added")])

vague("tv_thing_footprint", "the footprint thing",
      ["the footprint analysis thing", "that footprint panel", "the footprints feature"],
      ctx_kw(V_DM6_2R),
      "Footprints panel via Cmd/Ctrl+click.",
      "The Footprints panel", FOOTPRINT_SELECT)

vague("tv_thing_layout", "the layout thing",
      ["arranging panels", "how do I rearrange", "the side by side button"],
      ctx_kw(V_DM6_2R, DS_THREE),
      "Layout menu and panel.",
      "Layout",
      [ex("layout-menu", "Layout puts panels side by side or stacked and evens their widths."),
       ex("layout-panel", "The Layout panel links, merges and reorders dataset panels.")])

vague("tv_thing_merge_button", "the merge button",
      ["where's merge", "merge thing", "the merge option"],
      ctx_kw(V_DM6_2R),
      "Two merges exist; no clusters in state. Offer both.",
      "Which merge button",
      [ex("merge-similar", "Merge similar clusters, in the Cluster group, tidies clusters once you've clustered."),
       ex("layout-merge", "Merge datasets, in the Layout panel, pools datasets into one panel.")])

vague("tv_thing_capture", "the capture thing",
      ["capture panel", "the probes thing", "capture probes thing"],
      ctx_kw(V_DM6_2R),
      "Capture panel.",
      "Capture",
      [op("capture"),
       ex("capture-add-region", "Add regions to capture here."),
       ex("capture-export", "Export them as BED, FASTA or probes.")])

vague("tv_thing_tss", "the TSS coordinates thing",
      ["the relative position thing", "coordinates from the TSS", "zero at the TSS"],
      ctx_kw(V_DM6_2R),
      "TSS-relative coordinates.",
      "TSS-relative coordinates",
      [ex("relative-coords", "This switch shows positions as distance from the selected gene's TSS."),
       ex(None, "Select a gene first by clicking it on the gene track.")])

vague("tv_thing_that_panel_again", "open that panel again",
      ["bring it back", "show it again", "where did it go"],
      ctx_kw(V_DM6_2R, **CLUSTERED),
      previous_turns=[turn("what are the clusters?", "The Clusters panel", ["open_panel", "explain"])],
      thinking="The previous turn showed the Clusters panel: reopen it.",
      summary="The Clusters panel again",
      actions=[op("cluster-detail", "overview"),
               ex("clusters-overview", "Here it is.", requires="has_clusters")])


# ═════════════════════════════════════════════════════════════════════
# 5. Messy input (mostly phrasings above; a few standalone terse ones)
# ═════════════════════════════════════════════════════════════════════

vague("tv_messy_cluster", "cluster?",
      ["clustr", "how clustering", "hw do i cluster reeds", "cluster reads pls"],
      ctx_kw(V_DM6_2R),
      "Terse/typo: clustering walk.",
      "Clustering", CLUSTER_SHORT)

vague("tv_messy_genome_dropdown", "I can't find the genome dropdown",
      ["cant find genome list", "where is the genome menu", "genome selector missing?", "no genome dropdown"],
      ctx_kw(V_DM6_2R),
      "Statement-style: point at the genome list (in the sidebar).",
      "The genome list",
      [sidebar("genome", "genome.online"),
       ex("genome-selector", "It's here, in the sidebar under Reference & Tracks."),
       tr("genome-selector", "Pick your genome.", "genome_loaded")])

vague("tv_messy_footprint", "footprnt panel?",
      ["fp analysis", "footprints pls", "open footprint pnael"],
      ctx_kw(V_DM6_2R),
      "Terse: Footprints panel via Cmd/Ctrl+click.",
      "Open the Footprints panel", FOOTPRINT_SELECT)

vague("tv_messy_primers", "primer??",
      ["primrs", "need primers", "pcr primers pls"],
      ctx_kw(V_DM6_2R),
      "Terse: primer walk.",
      "Primers", PRIMER_STEPS)

vague("tv_messy_load", "cant load my file",
      ["file wont open", "how open bam", "load?"],
      ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
      "Nothing loaded: load walk.",
      "Load a file",
      [ex("load-dataset", "Load File opens a BAM or BigBed; keep the index file next to it."),
       tr("load-dataset", "Click Load File and pick it.", "dataset_loaded"),
       ex("load-by-path", "On a server, paste its path here instead.")])

vague("tv_messy_haplotype", "haplotypes??",
      ["allele view", "phasing thing", "haplotype comparison pls"],
      ctx_kw(V_DM6_2R),
      "Terse: haplotype comparison.",
      "Haplotype comparison",
      [ex("reference-pairs", "Load both haplotype references here."),
       op("contact-map", "compare"),
       tr("haplotype-form", "Pick the two haplotypes and open the comparison.", "panel_copy_made")])

vague("tv_messy_the_genome", "change genome to human",
      ["switch to human genome", "human genome pls", "use hg38 genome"],
      ctx_kw(V_DM6_2R),
      "Genome switch (user picks hg38).",
      "Switch to hg38", GENOME_STEPS)


# ═════════════════════════════════════════════════════════════════════
# 6. More goals, ambiguity, orientation and terse input
# ═════════════════════════════════════════════════════════════════════

goal("tv_enhancer_over_time", "does the enhancer open up over development?",
     ["is it more accessible at later stages", "accessibility change across timepoints",
      "does opening increase from 2-4hr to 5-8hr"],
     ctx_kw(V_DM6_2R, DS_THREE),
     "Timecourse = several datasets: peaks per panel, then cluster across all and compare counts per sample.",
     "Accessibility across timepoints",
     [tr("scan-peaks-button", "Click Scan: each timepoint's panel gets its own peaks.", "peaks_scanned", skip_if="has_peaks"),
      ex("peaks-track", "Compare the peak over the enhancer from panel to panel."),
      tr("peaks-track", "Select that peak.", "peak_selected", skip_if="has_selected_peak"),
      tr("cluster-button", "Click Cluster: all timepoints are clustered together.", "clustered"),
      ex("clusters-overview", "The overview counts each cluster per dataset, so you can see an open state grow over time.",
         requires="has_clusters")])

goal("tv_bound_vs_unbound", "separate bound from unbound molecules",
     ["split reads by whether the factor is bound", "group molecules by binding", "bound vs unbound reads"],
     ctx_kw(V_DM6_2R),
     "Split by binding: save the footprint, then Co-occupancy's Cluster reads by these footprints.",
     "Split molecules by binding",
     [tr("reads-track", "Cmd/Ctrl+click the footprint at the site.", "footprint_selected", skip_if="has_saved_footprints"),
      tr("save-footprint", "Click Save.", "footprint_saved", skip_if="has_saved_footprints"),
      ex("footprints-cooccupancy", "Co-occupancy splits molecules by which saved footprints they carry.", requires="has_saved_footprints"),
      tr("footprints-cooccupancy", "Click Cluster reads by these footprints.", "clustered"),
      ex("clusters-overview", "Now bound and unbound molecules are separate clusters.", requires="has_clusters")])

goal("tv_footprint_sizes", "what sizes are the footprints here?",
     ["footprint size distribution", "how big are the footprints", "size of the protected regions"],
     ctx_kw(V_DM6_3R),
     "Sizes: the Footprints panel's classes; V-Plot after clustering.",
     "Footprint sizes",
     [tr("reads-track", "Cmd/Ctrl+click a footprint.", "footprint_selected", skip_if="has_selected_footprint"),
      ex("footprints-classes", "Classes groups the footprints here by size range.", requires="has_selected_footprint"),
      ex(None, "After clustering, the Clusters panel's V-Plot tab shows size against position for each cluster.")])

goal("tv_strongest_open", "where is the most accessible spot here?",
     ["find the most open position", "strongest accessibility in view", "where is it most open"],
     ctx_kw(V_HG38_MYC),
     "Scan and read the tallest peak.",
     "Find the most accessible spot",
     [tr("scan-peaks-button", "Click Scan.", "peaks_scanned", skip_if="has_peaks"),
      ex("peaks-track", "The tallest peak is the position open on the most molecules."),
      ex("peak-detection-settings", "Peak Detection settings change how sensitive the scan is.")])

goal("tv_many_genes", "I want to look at many genes at once",
     ["view a list of regions", "go through several loci", "save regions to come back to"],
     ctx_kw(V_DM6_2R),
     "Regions panel saves views and opens them together; panel copies for two at once.",
     "Many regions",
     [op("circular-genome"),
      ex("regions-add-view", "Add View saves the current view as a region; navigate and repeat for each gene."),
      ex(None, "Saved regions open again from the list, together or one by one."),
      ex("panel-add-copy", "For two side by side, + adds a panel copy you can move.")])

goal("tv_tss_named", "show me the TSS of TP53",
     ["take me to the TP53 promoter", "TP53 start site", "zoom to TP53's TSS"],
     ctx_kw(V_HG38_MYC),
     "Navigate to TP53 (allowed), then TSS-relative coordinates.",
     "The TP53 TSS",
     [nav("TP53", 2000),
      ex("relative-coords", "Turn on TSS-relative coordinates so the TP53 TSS is at 0."),
      ex("reads-track", "Footprints and open DNA around 0 are the promoter.")])

goal("tv_regulatory_elements", "where are the regulatory elements?",
     ["find enhancers here", "which parts are regulatory", "where are the cis elements"],
     ctx_kw(V_DM6_2R),
     "Accessible peaks mark candidate elements; hub tracks annotate them.",
     "Find regulatory elements",
     [tr("scan-peaks-button", "Click Scan: accessible peaks mark candidate regulatory elements.", "peaks_scanned",
         skip_if="has_peaks"),
      ex("peaks-track", "Each peak is a position open on many molecules."),
      op("track-browser"),
      ex("tracks-browse-hubs", "Add enhancer or ChIP annotations from Browse hubs to label them.")])

goal("tv_dna_sequence", "what's the DNA sequence here?",
     ["show me the bases", "sequence at this site", "what nucleotides are here"],
     ctx_kw(V_DM6_2R),
     "Sequence draws when zoomed in (under ~2 kb) with a reference loaded: zoom in (navigation).",
     "Show the DNA sequence",
     [region("2R", 9_974_500, 9_975_500),
      ex("zoom-in", "Zoomed in to 1 kb, the reference bases are drawn above the reads."),
      ex("genome-selector", "No bases? Load the genome or your FASTA first.")])

goal("tv_group_by_sites", "group reads by which sites are bound",
     ["cluster by footprint combinations", "molecules by combination of bound sites", "which combinations of sites occur"],
     ctx_kw(V_DM6_2R),
     "Combinations of bound sites = clustering by saved footprints.",
     "Group reads by bound sites",
     [ex("footprints-saved", "Save a footprint at each site first (Cmd/Ctrl+click, then Save); they're listed here."),
      ex("footprints-cooccupancy", "Co-occupancy shows how often the saved footprints occur together.", requires="has_saved_footprints"),
      tr("footprints-cooccupancy", "Click Cluster reads by these footprints.", "clustered"),
      ex("clusters-overview", "Each cluster is one combination of bound sites.", requires="has_clusters")])

goal("tv_cluster_per_sample", "is one cluster enriched in a sample?",
     ["which sample has more of cluster 2", "cluster proportions per sample", "does a state change between samples"],
     ctx_kw(V_DM6_2R, DS_THREE, **CLUSTERED),
     "Clustered across samples: the overview counts per dataset.",
     "Clusters per sample",
     [op("cluster-detail", "overview"),
      ex("clusters-overview", "Each cluster's reads are counted per dataset: compare the shares across samples.", requires="has_clusters"),
      ex("clusters-composition", "Composition compares what each cluster is made of.")])

amb("tv_amb_close", "close it",
    ["get rid of it", "close this", "remove it"],
    ctx_kw(V_DM6_2R, copy_view={"chrom": "3R", "start": 11_998_000, "end": 12_008_000}),
    "A panel copy exists: 'it' is most likely the copy. Close or minimize.",
    "Close the panel copy",
    [ex("panel-close", "Hover the copy's header and click Close panel.", requires="has_panel_copy"),
     ex("panel-minimize", "Minimize keeps it as a small chip instead.")])

amb("tv_amb_hide", "hide it",
    ["make it go away", "hide that", "don't show it"],
    ctx_kw(V_DM6_2R, **CLUSTERED),
    "Hide a cluster (clustered state), a panel or a layer: offer the three.",
    "What would you like to hide?",
    [ex("cluster-focus-bar", "A cluster: click its colour in the bar to focus the others, or hide it from the Clusters panel.",
        requires="has_clusters"),
     ex("panel-minimize", "A panel: Minimize folds it into a chip."),
     ex("layer-toggles", "A layer: switch it off here.")])

amb("tv_amb_count", "count them",
    ["how many are there", "count", "number of them"],
    ctx_kw(V_DM6_2R, **CLUSTERED),
    "Clustered: counts per cluster in the overview.",
    "Counts per cluster",
    [op("cluster-detail", "overview"),
     ex("clusters-overview", "Each cluster's read count is listed here.", requires="has_clusters")])

amb("tv_amb_count_unclustered", "how many reads?",
    ["count the reads", "number of molecules here", "read count"],
    ctx_kw(V_DM6_2R),
    "No clusters: Read Stats on a selection; the panel header has the total.",
    "Counting reads",
    [ex("reads-track", "Each panel shows its reads in view; Shift+click or drag across reads to select some."),
     tr("reads-track", "Select the reads you want counted.", "reads_selected"),
     ex("read-stats-summary", "Read Stats counts and summarises them.", requires="has_selected_reads")])

orient("tv_genome_no_data", "the genome is set, what's next?",
       ["I picked a genome, now what", "genome loaded but no reads", "what after choosing the genome"],
       ctx_kw(V_DM6_2L, DS_NONE, diagnostics=[
           {"code": "no_datasets", "severity": "blocking",
            "message": "No dataset is loaded, so there are no reads to show.", "fix_anchor": "load-dataset"}]),
       "Diagnostics: no datasets but a genome. Load data next, then a gene.",
       "Next: load your data",
       [tr("load-dataset", "Click Load File and pick your BAM or BigBed.", "dataset_loaded"),
        ex("search-bar", "Then search for a gene you care about."),
        ex("guided-tour", "Or take the Tour on the demo dataset first.")])

vague("tv_thing_gene_track", "the track with the genes",
      ["where are the genes drawn", "gene models track", "the gene annotation row"],
      ctx_kw(V_DM6_2R),
      "The gene track has no anchor: describe it, and the search box for genes.",
      "The gene track",
      [ex(None, "Genes are drawn in the gene track above the reads; click a gene to select it (for TSS coordinates and Pol II states)."),
       ex("search-bar", "Type a gene name here to jump to it."),
       ex("load-gtf", "No genes? Load a gene annotation here.")])

vague("tv_thing_layer_switches", "the layer switches",
      ["the toggles for layers", "where do I turn layers on and off", "layer buttons"],
      ctx_kw(V_DM6_2R),
      "Layer toggles.",
      "The layer toggles",
      [ex("layers-controls-expand", "Click the small Layers label to show every layer."),
       ex("layer-toggles", "Each switch shows or hides a layer: footprints, nucleosomes, TFs, accessible stretches, modified bases.")])

vague("tv_thing_full_screen", "make one panel full screen",
      ["blow one panel up", "just show one panel big", "fullscreen panel"],
      ctx_kw(V_DM6_2R, DS_THREE),
      "Full view on the panel header.",
      "Full view",
      [ex("panel-full-view", "Full view gives one panel the whole window; click it again to go back.")])

vague("tv_thing_chip", "where did my panel go? there's a little chip",
      ["my panel turned into a chip", "panel minimized, how to restore", "bring the panel back from the chip"],
      ctx_kw(V_DM6_2R),
      "The minimized panel chip.",
      "Restore a minimized panel",
      [ex("panel-expand", "Click the chip to bring the panel back."),
       ex("loaded-datasets", "Loaded Datasets can restore it too.")])

vague("tv_messy_coacc", "coacc?",
      ["co accesibility", "coaccessibility pls", "co-access thing"],
      ctx_kw(V_DM6_2R),
      "Terse: co-accessibility.",
      "Co-accessibility", COACC_WALK)

vague("tv_messy_tour", "tour pls",
      ["start the tour", "walkthrough pls", "tour me"],
      ctx_kw(V_DM6_2R),
      "The Tour button.",
      "The guided Tour",
      [ex("guided-tour", "Click Tour: it walks through every main tool, and your data and view come back afterwards.")])

vague("tv_messy_contacts", "microc map??",
      ["daf-c heatmap?", "contact matrx", "hi-c style map"],
      ctx_kw(V_DM6_2R),
      "Terse: contact map.",
      "Contact map", CONTACT_WALK)

vague("tv_messy_motifs", "motifs pls",
      ["motfs", "show motifs", "motif sites?"],
      ctx_kw(V_DM6_2R),
      "Terse: motifs.",
      "Motifs", MOTIF_WALK)

vague("tv_messy_compare", "compair samples",
      ["cmpare my samples", "sample comparision", "compare samps"],
      ctx_kw(V_DM6_2R, DS_THREE),
      "Typo: compare samples with three loaded.",
      "Compare samples",
      [ex("reads-track", "Each sample has its own panel, all following the same view."),
       ex("layout-menu", "Layout puts them side by side or stacked."),
       ex("cluster-button", "Clustering runs across all panels, so clusters compare directly.")])
