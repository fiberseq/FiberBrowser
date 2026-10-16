"""Teach-only how-to records for the tutorial Copilot.

Copilot teaches: it navigates and opens panels, tabs and sidebar sections for
the user and points at the exact controls (named UI anchors from
``browser/frontend/src/data/tutorialAnchors.json``), but the user clicks
anything that runs something. ``try_it`` steps hand the user a turn and wait
for a milestone; ``skip_if`` / ``requires`` gate steps on the live state so
layers the user already did are skipped.

Every record carries the troubleshooting context a live request sends
(``diagnostics`` and ``raw_state``, see utils/copilotDiagnostics.ts), so the
model learns to read "State details:" when deciding how much to walk through.

Registered from records.py (``RECORDS += ...``). This module does not import
records.py so it can't form an import cycle; the record constructor and the
viewport fixtures are mirrored here.
"""
from __future__ import annotations

from typing import Any, Optional


# ─────────────────────────────────────────────────────────────────────
# Fixtures (mirrors records.py)
# ─────────────────────────────────────────────────────────────────────

V_DM6_2R = {"chrom": "2R", "start": 9_970_000, "end": 9_980_000, "currentGenome": "dm6"}
V_DM6_3R = {"chrom": "3R", "start": 1_000_000, "end": 1_010_000, "currentGenome": "dm6"}
V_DM6_2L = {"chrom": "2L", "start": 14_000, "end": 20_000, "currentGenome": "dm6"}
V_DM6_X = {"chrom": "X", "start": 195_000, "end": 210_000, "currentGenome": "dm6"}
V_DM6_HB = {"chrom": "3R", "start": 11_998_000, "end": 12_008_000, "currentGenome": "dm6"}
V_DM6_WIDE = {"chrom": "2R", "start": 9_700_000, "end": 10_300_000, "currentGenome": "dm6"}
V_HG38_MYC = {"chrom": "chr8", "start": 127_700_000, "end": 127_720_000, "currentGenome": "hg38"}
V_HG38_SOX2 = {"chrom": "chr3", "start": 181_700_000, "end": 181_720_000, "currentGenome": "hg38"}
V_HG38_TP53 = {"chrom": "chr17", "start": 7_660_000, "end": 7_695_000, "currentGenome": "hg38"}
V_MM10_PAX6 = {"chrom": "chr2", "start": 105_500_000, "end": 105_540_000, "currentGenome": "mm10"}
V_EMPTY = {"chrom": "", "start": 0, "end": 0, "currentGenome": ""}

DS_NONE = 0
DS_FIBER_ONLY = 1   # one BigBed
DS_FIBER_DAF = 2    # BigBed + DAF-seq BAM
DS_THREE = 3        # adds a second fiber-seq BigBed

_DATASETS = [
    ("ds_emb_2_4hr", "Embryo 2-4hr", "bigbed"),
    ("ds_emb_2_5_3hr", "Embryo 2.5-3hr DAF", "bam"),
    ("ds_emb_5_8hr", "Embryo 5-8hr", "bigbed"),
]


def _r(**kw):
    """Same record shape as records._r (kept in sync by the dataset validator)."""
    kw.setdefault("category", "general")
    kw.setdefault("dataset_count", DS_FIBER_DAF)
    kw.setdefault("warnings", [])
    kw.setdefault("phrasings", [])
    record = {
        "id": kw["id"],
        "category": kw["category"],
        "command": kw["command"],
        "phrasings": list(kw["phrasings"]),
        "context": kw["context"],
        "dataset_count": kw["dataset_count"],
        "thinking": kw["thinking"].strip(),
        "plan": {
            "summary": kw["summary"],
            "actions": kw["actions"],
            "warnings": kw["warnings"],
        },
    }
    for key in ("state_overrides", "diagnostics", "raw_state", "previous_turns"):
        if key in kw:
            record[key] = kw[key]
    return record


# ─────────────────────────────────────────────────────────────────────
# Browser context, as utils/copilotDiagnostics.ts sends it
# ─────────────────────────────────────────────────────────────────────

_READS = [(212, 240), (164, 188), (131, 150)]  # (spanning, overlapping) per dataset


def raw(ctx: dict, ds: int = DS_FIBER_DAF, *, clustered: tuple[int, ...] = (), method: Optional[str] = None,
        k: Optional[int] = None, filtered: Optional[dict[int, int]] = None, focus: Optional[dict[int, list[int]]] = None,
        strands: bool = False, copy_view: Optional[dict] = None, spanning_only: bool = False,
        window: int = 50_000, reference: Optional[bool] = None, quality: tuple[str, ...] = (),
        layers: Optional[dict[str, bool]] = None, branch: bool = False, hidden: tuple[int, ...] = ()) -> dict:
    """The compact raw state the browser sends with every Copilot request."""
    chrom = ctx.get("chrom") or ""
    genome = ctx.get("currentGenome") or None
    datasets = [{"id": i, "label": label, "type": typ} for i, label, typ in _DATASETS[:ds]]
    panels: list[dict[str, Any]] = []

    def panel(idx: int, pid: str, *, strand: Optional[str] = None, own_view: Optional[dict] = None) -> dict:
        span, over = _READS[idx]
        in_scope = span if spanning_only else over
        shown = (filtered or {}).get(idx, in_scope)
        p: dict[str, Any] = {"id": pid, "dataset_id": _DATASETS[idx][0], "hidden": idx in hidden}
        if strand:
            p["strand"] = strand
        if own_view:
            p["own_view"] = own_view
        p["filter"] = (filtered or {}).get(idx, "none")
        if focus and idx in focus:
            p["focus"] = focus[idx]
        p["clustered"] = idx in clustered
        if chrom:
            if strand:
                in_scope = shown = in_scope // 2
            p["reads"] = {"shown": shown, "working": in_scope, "in_scope": in_scope,
                          "overlapping": over, "spanning": span}
        return p

    for idx in range(ds):
        if strands and _DATASETS[idx][2] == "bam":
            panels.append(panel(idx, f"panel-{idx + 1}", strand="CT"))
            panels.append(panel(idx, f"panel-{idx + 1}-ga", strand="GA"))
        else:
            panels.append(panel(idx, f"panel-{idx + 1}"))
    if copy_view and ds:
        panels.append(panel(0, "panel-copy", own_view=copy_view))

    clustering: dict[str, Any] = {}
    if method or clustered:
        clustering["method"] = method or "kmeans"
        clustering["k"] = k or 6
    if branch:
        clustering["active_branch"] = True
    return {
        "viewport": {"chrom": chrom, "start": ctx.get("start", 0), "end": ctx.get("end", 0)} if chrom else None,
        "genome": genome,
        "reference_loaded": bool(genome) if reference is None else reference,
        "datasets": datasets,
        "panels": panels[:6],
        "settings": {
            "spanning_only": spanning_only,
            "read_window_bp": window,
            "min_footprints": 0,
            "min_fp_quality": 0,
            "quality_filters": list(quality),
            "layers": layers or {"footprint": True, "nuc": True, "tf": True, "msp": True},
        },
        "clustering": clustering,
    }


D_EMPTY = [
    {"code": "no_datasets", "severity": "blocking", "message": "No dataset is loaded, so there are no reads to show.",
     "fix_anchor": "load-dataset"},
    {"code": "no_reference", "severity": "blocking",
     "message": "No genome or reference is loaded, so there are no chromosomes to browse.",
     "fix_anchor": "genome-selector"},
]
D_NO_REFERENCE = [
    {"code": "no_reference", "severity": "info",
     "message": "No reference genome/FASTA is loaded; sequence, primers and motif scans need one.",
     "fix_anchor": "genome-selector"},
]


def ctx_kw(ctx: dict, ds: int = DS_FIBER_DAF, diagnostics: Optional[list] = None, **state) -> dict:
    """context + dataset_count + the diagnostics/raw_state a live request sends."""
    return {
        "context": ctx,
        "dataset_count": ds,
        "diagnostics": list(diagnostics or []),
        "raw_state": raw(ctx, ds, **state),
    }


# ─────────────────────────────────────────────────────────────────────
# Step builders
# ─────────────────────────────────────────────────────────────────────

def ex(anchor: Optional[str], text: str, **gate) -> dict:
    step: dict[str, Any] = {"type": "explain", "text": text}
    if anchor:
        step["anchor"] = anchor
    step.update(gate)
    return step


def tr(anchor: str, text: str, wait_for: str, **gate) -> dict:
    step = {"type": "try_it", "text": text, "anchor": anchor, "wait_for": wait_for}
    step.update(gate)
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


RECORDS: list[dict] = []


def add(**kw) -> None:
    kw.setdefault("category", "teach_workflow")
    RECORDS.append(_r(**kw))


# ─────────────────────────────────────────────────────────────────────
# Shared step sequences (one wording per control keeps the corpus consistent)
# ─────────────────────────────────────────────────────────────────────

def peaks_first(gate: bool = True) -> list[dict]:
    """Scan, then select a peak; skipped when the user already has them."""
    s = {"skip_if": "has_peaks"} if gate else {}
    p = {"skip_if": "has_selected_peak"} if gate else {}
    return [
        tr("scan-peaks-button", "Click Scan to find peaks in this view.", "peaks_scanned", **s),
        tr("peaks-track", "Click a peak on the Peaks track to select it (Cmd/Ctrl+click adds more peaks).",
           "peak_selected", **p),
    ]


CLUSTER_CONTROLS = [
    ex("cluster-toolbar", "Clustering lives in the Cluster group of the toolbar."),
    ex("cluster-controls-expand", "Click the small Cluster label to show the rest of its controls."),
    ex("cluster-method", "Pick the method here: K-means usually works best; hierarchical, HDBSCAN and combinatorial are the alternatives."),
    ex("cluster-k", "K sets how many clusters K-means makes (2-20). Choose it a little high; you can merge similar ones afterwards."),
]

CLUSTER_RESULTS = [
    ex("clusters-overview", "The Clusters panel lists each cluster with its read count; click a colour in the bar left of the reads to focus one.",
       requires="has_clusters"),
    ex("clusters-profiles", "Profiles overlays each cluster's average footprint profile so you can see where they differ."),
    ex("merge-similar", "Merge similar clusters folds tiny clusters and near-duplicates into their nearest cluster, which tidies up a K chosen a little high."),
]

MERGE_STEPS = [
    ex("merge-similar", "Merge similar clusters folds clusters smaller than a set share of reads, and near-duplicates, into their nearest cluster.",
       requires="has_clusters"),
    ex("merge-settings", "The settings set the smallest cluster (% of reads) and the similarity cutoff; the Projection tab previews the result before and after."),
    ex("clusters-projection", "Projection places every read by its features, so you can see which clusters overlap before you merge."),
    tr("merge-similar", "Click Merge similar clusters when the preview looks right.", "clusters_merged"),
    ex("clusters-overview", "The overview now shows the merged clusters; undo (Cmd/Ctrl+Z) brings the old ones back."),
]

FOOTPRINT_SELECT = [
    ex("reads-track", "Each row is one molecule; the coloured blocks on it are footprints."),
    tr("reads-track", "Cmd/Ctrl+click a footprint on any read to analyse it.", "footprint_selected",
       skip_if="has_selected_footprint"),
    ex("selected-footprint", "The Footprints panel opens with that footprint: its size range and where it sits across the molecules.",
       requires="has_selected_footprint"),
]

SAVE_FOOTPRINT = [
    tr("save-footprint", "Adjust the size range if you like, then click Save to keep this footprint as a definition.",
       "footprint_saved", skip_if="has_saved_footprints"),
    ex("footprints-saved", "Saved footprints are listed in the Saved tab and coloured on every read that carries one.",
       requires="has_saved_footprints"),
]

LOAD_STEPS = [
    ex("load-dataset", "Load File opens a BAM, BigBed, BigWig, GTF, FASTA or a saved session from your computer."),
    tr("load-dataset", "Click Load File and pick your BAM or BigBed; each dataset gets its own panel.", "dataset_loaded"),
    ex("load-by-path", "On a server, type the file's path under Load by path instead."),
    ex("load-remote-url", "Files online load from an https:// or s3:// URL under Load Remote URL."),
    ex("loaded-datasets", "Every loaded dataset is listed under Loaded Datasets: rename, recolour, merge, or bring back a minimized panel."),
]

GENOME_STEPS = [
    ex("sidebar-reference", "Genomes and annotations live in the settings sidebar under Reference & Tracks."),
    tr("genome-selector", "Pick a bundled genome (dm6, hg38, mm10, ...) from the Genome list; its gene annotation loads with it.",
       "genome_loaded"),
    ex("load-fasta", "For any other assembly, load your own reference FASTA here; sequence, primers and motif scans use it."),
    ex("load-gtf", "Then load a matching GTF, GFF or BED annotation so genes can be searched and drawn."),
]

SEARCH_STEPS = [
    ex("search-bar", "Type a gene name or coordinates into the search box and press Enter."),
]

STRAND_STEPS = [
    ex("strand-chip", "DAF-seq panels have a strand chip in the header: Both strands, CT strand only (C→T reads) or GA strand only (G→A reads)."),
    tr("split-by-strand", "Open the chip and choose Split: CT | GA side by side.", "strand_split", skip_if="has_strand_split"),
    ex("strand-chip", "The panel now shows CT and a copy beside it shows GA; both follow the main view, and clusters, peaks and footprint counts use each panel's own reads.",
       requires="has_strand_split"),
]

COPY_STEPS = [
    tr("panel-add-copy", "Hover the dataset panel's header and click + to add a copy of the panel.", "panel_copy_made",
       skip_if="has_panel_copy"),
    ex("panel-link", "The copy follows the main view while it is linked; click Unlink to move it on its own.",
       requires="has_panel_copy"),
    tr("panel-location-bar", "Unlinked, the copy has its own location box: type another gene or region there.", "navigated"),
]

PRIMER_STEPS = [
    tr("peaks-track", "Click the peak you want primers around on the Peaks track (skip this to design around the view).",
       "peak_selected", skip_if="has_selected_peak"),
    ex("primers-design-tab", "The Primers panel's Design tab designs primers around the selected peaks or the view.",
       requires="has_reference"),
    tr("primers-design-button", "Click Design primers; with a BLAST database configured, specificity is checked too.",
       "primers_designed"),
    ex("primers-order-tab", "Add the pairs you like to the Order List tab, which exports an order sheet (IDT, Twist, ...)."),
]

SAVE_STEPS = [
    tr("save-session", "Click Save to download a session file with your data, view, clusters and settings.", "session_saved"),
    ex("session-settings", "The Session section in Data & Sessions also saves, exports or copies a link to the session."),
    ex("restore-session", "To come back later, use Restore session here (or drop the session file on Load File)."),
]


# ═════════════════════════════════════════════════════════════════════
# 1. Core workflows
# ═════════════════════════════════════════════════════════════════════

# ── Change genome ───────────────────────────────────────────────────
add(id="tw_genome_switch_hg38", command="how do I change genomes?",
    phrasings=["how do I switch genome", "change the genome to hg38", "where do I pick a different genome",
               "how do I load hg38", "switch assembly"],
    **ctx_kw(V_DM6_2R),
    thinking="Genome switching lives in the sidebar (Reference & Tracks). Walk the bundled list first, then own FASTA + GTF for other assemblies; loading a genome is the user's click.",
    summary="How to change the genome",
    actions=GENOME_STEPS + [ex("reference-pairs", "Working with two haplotypes or references at once? Load several FASTA/annotation pairs here.")])

add(id="tw_genome_first_time", command="how do I pick a genome to start?",
    phrasings=["nothing is loaded, how do I choose a genome", "how do I set up a reference", "first time here, how do I set the genome",
               "where do I choose the organism"],
    **ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
    thinking="Diagnostics: no reference and no data. Start with the genome (Reference & Tracks), then point at Load File for the reads.",
    summary="Pick a genome, then load data",
    actions=GENOME_STEPS + [ex("load-dataset", "With a genome chosen, load your reads with Load File.")])

add(id="tw_genome_own_assembly", command="how do I use my own reference fasta?",
    phrasings=["load my own genome", "my assembly isn't in the list", "how do I add a custom reference",
               "use a fasta I have locally", "how do I load a reference for a non-model organism"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Own assembly: skip the bundled list and walk Reference Files → Load Reference FASTA → gene annotation. Loading is the user's click.",
    summary="Load your own reference FASTA and annotation",
    actions=[
        ex("reference-files", "Your own reference goes under Reference Files in Reference & Tracks."),
        tr("load-fasta", "Click Load Reference FASTA and pick your .fa/.fasta (an index is made if it lacks one).", "genome_loaded"),
        ex("load-gtf", "Load the matching GTF, GFF or BED annotation to search and draw genes."),
        ex("load-plasmid", "A plasmid or construct can be added as its own contig with Load Plasmid Map."),
        ex("search-bar", "Then search for a gene or coordinates on the new reference."),
    ])

add(id="tw_genome_mm10", command="how do I switch to mouse?",
    phrasings=["change to mm10", "how do I look at mouse data", "switch genome to mouse", "use the mouse genome"],
    **ctx_kw(V_HG38_MYC),
    thinking="Bundled genome switch: Reference & Tracks → Genome list (mm10). The user picks it; afterwards the search box takes mouse genes.",
    summary="Switch to the mouse genome",
    actions=[
        ex("sidebar-reference", "Genomes live in the settings sidebar under Reference & Tracks."),
        tr("genome-selector", "Pick mm10 from the Genome list; its gene annotation loads with it.", "genome_loaded"),
        ex("search-bar", "Then search for a mouse gene, such as Pax6, in the search box."),
        ex("load-dataset", "Load your mouse reads with Load File if they aren't loaded yet."),
    ])

add(id="tw_genome_annotation_only", command="how do I load gene annotations?",
    phrasings=["how do I add a gtf", "genes aren't showing, how do I load them", "load a gff file",
               "where do I load gene models", "add gene annotation"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Annotation only: Reference Files → Load gene annotation. Bundled genomes bring their own, so mention the Genome list too.",
    summary="Load a gene annotation",
    actions=[
        ex("reference-files", "Gene annotations load under Reference Files in Reference & Tracks."),
        ex("load-gtf", "Click Load gene annotation and pick a GTF, GFF or BED file matching your reference."),
        ex("genome-selector", "Bundled genomes in the Genome list come with their annotation already."),
        ex("search-bar", "Once loaded, gene names work in the search box and genes draw on the gene track."),
    ])

add(id="tw_genome_haplotype_refs", command="how do I load two haplotype references?",
    phrasings=["load both haplotypes", "I have a maternal and paternal fasta", "how do I load two fastas at once",
               "load diploid references"],
    **ctx_kw(V_DM6_2R),
    thinking="Two haplotypes = Multiple FASTA / annotation pairs; chromosome names must differ between them. Then the Compare tab puts them side by side.",
    summary="Load two haplotype references",
    actions=[
        ex("reference-files", "References load under Reference Files in Reference & Tracks."),
        ex("reference-pairs", "Multiple FASTA / annotation pairs loads several references at once; give each haplotype distinct chromosome names (e.g. chr2R_mat, chr2R_pat)."),
        tr("reference-pairs", "Add each FASTA (and its annotation) and load them.", "genome_loaded"),
        ex("haplotype-compare", "Then Contacts > Compare opens the two haplotypes side by side in linked panels."),
    ])

add(id="tw_genome_why_needed", command="do I need to load a genome?",
    phrasings=["is a reference required", "why load a fasta", "what do I need the genome for"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY, D_NO_REFERENCE, reference=False),
    thinking="Diagnostics say no reference: reads still show, but sequence, primers and motif scans need one. Point at the Genome list and Load Reference FASTA.",
    summary="What the reference is for",
    actions=[
        ex(None, "Reads draw without a reference, but the sequence track, primer design and motif scans need one, and gene search needs an annotation."),
        ex("genome-selector", "The quickest way: pick a bundled genome from the Genome list."),
        ex("load-fasta", "Or load your own FASTA with Load Reference FASTA."),
    ])

# ── Load data ───────────────────────────────────────────────────────
add(id="tw_load_empty", command="how do I load my data?",
    phrasings=["how do I open a bam", "how do I get my reads in", "load a file", "how do I upload data",
               "where do I open my bigbed"],
    **ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
    thinking="Nothing loaded (diagnostics). Walk Load File (try_it dataset_loaded), then the path/URL alternatives and Loaded Datasets.",
    summary="How to load data",
    actions=LOAD_STEPS)

add(id="tw_load_second", command="how do I add another dataset?",
    phrasings=["load a second bam", "add one more sample", "open another file next to this one",
               "how do I compare two samples", "add a second dataset"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="One dataset is loaded; another Load File adds a second panel. Then Loaded Datasets and Layout manage them.",
    summary="Add another dataset",
    actions=[
        tr("load-dataset", "Click Load File and pick the second file; it opens in its own panel.", "dataset_loaded"),
        ex("loaded-datasets", "Loaded Datasets lists them: rename, recolour or merge them here."),
        ex("layout-menu", "Layout arranges the panels side by side or stacked."),
    ])

add(id="tw_load_remote", command="how do I load a file from a url?",
    phrasings=["load from s3", "open a remote bigbed", "load data from a link", "how do I stream a file from the web",
               "open an https bam"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Remote files: Data & Sessions → Load Remote URL (https:// or s3://). The user pastes and loads.",
    summary="Load a file from a URL",
    actions=[
        ex("sidebar-data", "Remote files load from Data & Sessions in the settings sidebar."),
        tr("load-remote-url", "Paste the https:// or s3:// URL under Load Remote URL and load it.", "dataset_loaded"),
        ex("loaded-datasets", "It appears under Loaded Datasets with its own panel."),
    ])

add(id="tw_load_server_path", command="my data is on the server, how do I open it?",
    phrasings=["load by path", "open a file by typing its path", "I can't use the file picker, how do I load",
               "load a bam from a server path"],
    **ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
    thinking="Server-side file: Load by path. Walk it with try_it dataset_loaded, then the reference.",
    summary="Load a file by path",
    actions=[
        ex("sidebar-data", "Loading by path is in Data & Sessions in the settings sidebar."),
        tr("load-by-path", "Type the file's path under Load by path and load it.", "dataset_loaded"),
        ex("genome-selector", "If no genome is set yet, pick one from the Genome list under Reference & Tracks."),
    ])

add(id="tw_load_what_formats", command="what files can I load?",
    phrasings=["which formats are supported", "can I load bigwig", "does it take bam files", "what file types work"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Formats question: Load File's description lists them; tracks go through the Tracks panel.",
    summary="Supported files",
    actions=[
        ex("load-dataset", "Load File takes BAM and BigBed reads, BigWig tracks, GTF/GFF annotations, FASTA references and saved sessions."),
        ex("tracks-add-file", "Signal and annotation tracks (BigWig, BigBed, BED) can also be added in the Tracks panel."),
        ex("load-plasmid", "Plasmid maps (GenBank, SnapGene, EMBL, SBOL) load as their own contig."),
    ])

add(id="tw_load_manage", command="how do I rename a dataset?",
    phrasings=["change a dataset's color", "how do I recolor a sample", "rename my bam", "change the dataset label"],
    **ctx_kw(V_DM6_2R, DS_THREE),
    thinking="Renaming/recolouring is in Loaded Datasets (Data & Sessions); the Layout panel also renames.",
    summary="Rename or recolour a dataset",
    actions=[
        ex("loaded-datasets", "Loaded Datasets in Data & Sessions lists every dataset: click its name to rename it or its swatch to recolour it."),
        ex("layout-panel", "The Layout panel also renames, links and merges dataset panels."),
    ])

# ── Navigate / search ───────────────────────────────────────────────
add(id="tw_nav_basics", command="how do I navigate?",
    phrasings=["how do I move around", "how do I get around the genome", "teach me navigation",
               "how do I zoom and pan", "how do I move the view"],
    **ctx_kw(V_DM6_2R),
    thinking="Navigation walk: search (try_it navigated), chromosome list, zoom, pan, Go to reads, history.",
    summary="How to navigate",
    actions=[
        ex("search-bar", "Type a gene name or coordinates like 2R:9,970,000-9,980,000 into the search box and press Enter."),
        tr("search-bar", "Try it: search for eve.", "navigated"),
        ex("chrom-selector", "The chromosome selector jumps to any chromosome of the reference."),
        ex("zoom-in", "Zoom in and out 1.5x with these buttons, or + and - (up/down arrows) on the keyboard."),
        ex("pan-left", "Pan left and right with these or the left/right arrow keys."),
        ex("go-to-reads", "Go to reads jumps to the next best-covered window at this zoom."),
        ex("history-timeline", "The history timeline next to Undo steps back to any earlier view or change."),
    ])

add(id="tw_nav_find_gene_hg38", command="how do I find a gene?",
    phrasings=["how do I search for MYC", "how do I go to a gene", "where do I type a gene name", "look up a gene"],
    **ctx_kw(V_HG38_TP53),
    thinking="Gene search: the search box takes gene names once an annotation is loaded; try_it navigated. Mention TSS-relative coordinates for the gene.",
    summary="How to find a gene",
    actions=[
        ex("search-bar", "Type a gene name, such as MYC, into the search box and press Enter."),
        tr("search-bar", "Search for a gene now.", "navigated"),
        ex("relative-coords", "TSS-relative coordinates show positions relative to the selected gene's TSS."),
        ex("navigation-settings", "How much padding goes around a gene is set under Navigation in Reads & Display."),
    ])

add(id="tw_nav_zoom", command="how do I zoom in?",
    phrasings=["zoom out", "how do I zoom", "make the region smaller", "how do I see a wider region"],
    **ctx_kw(V_DM6_2R),
    thinking="Zoom only: buttons + keyboard; note the read window so a wide zoom-out shows coverage.",
    summary="How to zoom",
    actions=[
        ex("zoom-in", "Zoom in 1.5x here, or press + (up arrow)."),
        ex("zoom-out", "Zoom out 1.5x here, or press - (down arrow)."),
        ex("read-window-setting", "Past Show reads up to, the reads turn into a coverage histogram; raise it here to draw reads over wider views."),
    ])

add(id="tw_nav_coordinates", command="how do I go to specific coordinates?",
    phrasings=["jump to a position", "go to chr2R:9,970,000", "type in coordinates", "how do I enter a region"],
    **ctx_kw(V_DM6_3R),
    thinking="Coordinates go in the search box in chrom:start-end form; try_it navigated.",
    summary="Go to coordinates",
    actions=[
        ex("search-bar", "Type coordinates like 3R:1,000,000-1,010,000 (commas optional) into the search box."),
        tr("search-bar", "Press Enter to go there.", "navigated"),
        ex("chrom-selector", "To browse a whole chromosome, pick it from the chromosome selector."),
    ])

add(id="tw_nav_back", command="how do I go back to where I was?",
    phrasings=["go back to the previous view", "how do I get back", "undo my navigation", "return to the last region"],
    **ctx_kw(V_DM6_HB),
    thinking="Back = Undo or the history timeline; views are part of history.",
    summary="Go back to an earlier view",
    actions=[
        ex("undo", "Undo (Cmd/Ctrl+Z) steps back through your changes, including where you were."),
        ex("history-timeline", "The timeline next to it lists every step; click one to jump straight back to it."),
    ])

add(id="tw_nav_best_coverage", command="how do I find where my reads are?",
    phrasings=["where is there coverage", "find a region with reads", "jump to reads", "I can't find any reads, where are they"],
    **ctx_kw(V_DM6_WIDE, DS_FIBER_ONLY),
    thinking="Go to reads jumps to the best-covered window at this zoom; try_it navigated.",
    summary="Jump to where the reads are",
    actions=[
        ex("go-to-reads", "Go to reads jumps to the next best-covered window at the current zoom, deepest first."),
        tr("go-to-reads", "Click Go to reads.", "navigated"),
        ex("zoom-out", "Zoom out first to search a wider area; zoom back in to draw the reads."),
    ])

add(id="tw_nav_mouse_gene", command="how do I look at Pax6?",
    phrasings=["take me to pax6", "where is pax6", "show me Pax6"],
    **ctx_kw(V_MM10_PAX6),
    thinking="Copilot may navigate: go to Pax6, then show the search box so the user knows how to do it themselves.",
    summary="Go to Pax6",
    actions=[
        nav("Pax6", 5000),
        ex("search-bar", "Here is Pax6. Next time, type any gene name into the search box and press Enter."),
        ex("relative-coords", "TSS-relative coordinates measure positions from the gene's TSS."),
    ])

add(id="tw_nav_reverse", command="how do I flip the view to the other strand?",
    phrasings=["reverse the view", "show 3' to 5'", "how do I see a minus-strand gene the right way round"],
    **ctx_kw(V_DM6_2L),
    thinking="Reverse view flips the display; for DAF strands point at the strand chip instead.",
    summary="Reverse the view",
    actions=[
        ex("reverse-view", "Reverse view flips the view 3' to 5'; reads and coordinates reverse with it."),
        ex("strand-chip", "To show only one DAF-seq strand instead (CT or GA reads), use the strand chip in the panel header."),
    ])

# ── Cluster ─────────────────────────────────────────────────────────
add(id="tw_cluster_fresh", command="how do I cluster reads?",
    phrasings=["how do I cluster", "walk me through clustering", "how do I group reads", "cluster my reads",
               "how does clustering work here", "teach me clustering"],
    **ctx_kw(V_DM6_2R),
    thinking="Nothing clustered yet (State details). Walk the Cluster group: expand the controls, method, K; then the user scans, selects a peak and clicks Cluster (try_it each, skipped if already done), then the results panel.",
    summary="How to cluster reads",
    actions=CLUSTER_CONTROLS + peaks_first() + [tr("cluster-button", "Now click Cluster.", "clustered")] + CLUSTER_RESULTS)

add(id="tw_cluster_hg38", command="how do I cluster reads at this locus?",
    phrasings=["cluster the reads here", "how do I find subpopulations of reads", "group molecules by their footprints"],
    **ctx_kw(V_HG38_MYC, DS_FIBER_ONLY),
    thinking="Same clustering walk; peaks first because clustering uses the selected peaks.",
    summary="How to cluster the reads here",
    actions=CLUSTER_CONTROLS + peaks_first() + [tr("cluster-button", "Click Cluster.", "clustered")] + CLUSTER_RESULTS)

add(id="tw_cluster_recluster", command="how do I recluster with a different k?",
    phrasings=["change k and cluster again", "redo the clustering", "try a different number of clusters",
               "how do I change the cluster method", "re-run clustering"],
    **ctx_kw(V_DM6_2R, clustered=(0,), method="kmeans", k=6),
    thinking="State details: already clustered (K-means, K=6). Skip the peak steps; show the expanded controls, then the user re-clicks Cluster.",
    summary="Recluster with new settings",
    actions=[
        ex("cluster-controls-expand", "Click the small Cluster label to show the method and K."),
        ex("cluster-method", "Change the method here if you want: K-means, KMeans++, hierarchical, HDBSCAN or combinatorial."),
        ex("cluster-k", "Set a new K (2-20)."),
        ex("cluster-snapshot", "To keep the current result, click Snapshot in the Clusters panel first; it comes back from the Saved tab.",
           requires="has_clusters"),
        tr("cluster-button", "Click Cluster to rerun on the same peaks.", "clustered"),
    ])

add(id="tw_cluster_done_what_now", command="how do I look at my clusters?",
    phrasings=["where are my clusters", "show me the clusters", "how do I see the cluster results", "what do my clusters look like"],
    **ctx_kw(V_DM6_2R, clustered=(0, 1), method="kmeans", k=5),
    thinking="Already clustered: short answer, open the Clusters panel and walk its tabs.",
    summary="Where the cluster results are",
    actions=[
        op("cluster-detail", "overview"),
        ex("clusters-overview", "Overview lists each cluster with its read count; click one to focus it, or hide it.", requires="has_clusters"),
        ex("clusters-profiles", "Profiles overlays the clusters' average profiles."),
        ex("clusters-composition", "Composition shows each cluster's mix of footprint types."),
        ex("clusters-vplot", "V-Plot plots footprint size against position for each cluster."),
    ])

add(id="tw_cluster_method_choice", command="which clustering method should I use?",
    phrasings=["kmeans or hdbscan", "what's the difference between the cluster methods", "what is combinatorial clustering",
               "which method is best"],
    **ctx_kw(V_DM6_2R),
    thinking="Explain the methods at the method dropdown; K-means is the usual choice.",
    summary="Clustering methods",
    actions=[
        ex("cluster-controls-expand", "Click the small Cluster label to show the method dropdown."),
        ex("cluster-method", "K-means (or KMeans++) usually works best: set K a little high and merge similar clusters after. Hierarchical builds a tree; HDBSCAN finds dense groups and leaves outliers unassigned; combinatorial gives one cluster per on/off pattern across the selected peaks."),
        ex("cluster-k", "K only applies to K-means and KMeans++."),
    ])

add(id="tw_cluster_multi_peak", command="how do I cluster using several peaks?",
    phrasings=["cluster on two peaks", "select multiple peaks for clustering", "cluster across a few peaks"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Multi-peak: Cmd/Ctrl+click adds peaks; then Cluster uses all selected peaks.",
    summary="Cluster on several peaks",
    actions=[
        tr("scan-peaks-button", "Click Scan to find peaks.", "peaks_scanned", skip_if="has_peaks"),
        tr("peaks-track", "Click one peak, then Cmd/Ctrl+click the others to add them.", "peak_selected"),
        ex("peak-clear-selection", "Clear peak selection (in the expanded Peaks controls) starts over."),
        tr("cluster-button", "Click Cluster; it uses every selected peak.", "clustered"),
        ex("clusters-overview", "Each cluster is a group of reads with a similar footprint pattern across those peaks.", requires="has_clusters"),
    ])

add(id="tw_cluster_no_data", command="how do I cluster?",
    phrasings=["how do I cluster reads", "cluster"],
    **ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
    thinking="Diagnostics: no data. Clustering needs reads, so first load a dataset (try_it), then the cluster walk.",
    summary="Load data, then cluster",
    actions=[
        ex(None, "Clustering needs reads, and none are loaded yet."),
        tr("load-dataset", "Click Load File and open your BAM or BigBed first.", "dataset_loaded"),
    ] + CLUSTER_CONTROLS[1:] + peaks_first() + [tr("cluster-button", "Click Cluster.", "clustered")])

add(id="tw_cluster_focus", command="how do I focus on one cluster?",
    phrasings=["show only one cluster", "hide the other clusters", "isolate a cluster", "how do I hide a cluster"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Focus is done in the colour bar or the Overview list; show unhide too.",
    summary="Focus on one cluster",
    actions=[
        ex("clusters-overview", "Click a cluster in Overview (or its colour in the bar left of the reads) to focus it.", requires="has_clusters"),
        tr("clusters-overview", "Click the cluster you want to see.", "cluster_focused"),
        ex("cluster-focus-bar", "Unhide all shows every cluster again."),
    ])

add(id="tw_cluster_lock_order", command="how do I stop clusters from reordering?",
    phrasings=["keep the cluster order", "lock the cluster order", "my clusters keep shuffling"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Lock cluster order lives in the expanded Sort controls; needs clusters.",
    summary="Lock the cluster order",
    actions=[
        ex("sort-controls-expand", "Click the small Sort label to show the rest of its controls."),
        ex("cluster-order-lock", "Lock cluster order keeps the clusters in place when you re-sort or zoom.", requires="has_clusters"),
    ])

# ── Merge clusters ──────────────────────────────────────────────────
add(id="tw_merge_similar", command="how do I merge clusters?",
    phrasings=["merge similar clusters", "I have too many clusters", "combine clusters", "tidy up my clusters",
               "how does merge similar clusters work"],
    **ctx_kw(V_DM6_2R, clustered=(0,), k=8),
    thinking="Clustered with K=8 (State details). Walk Merge similar clusters: settings, projection preview, the user's click, then the result.",
    summary="How to merge similar clusters",
    actions=[op("cluster-detail")] + MERGE_STEPS)

add(id="tw_merge_no_clusters", command="how do I merge similar clusters?",
    phrasings=["merge clusters", "combine near duplicate clusters"],
    **ctx_kw(V_DM6_2R),
    thinking="No clusters yet: merge needs a clustering, so the first step requires has_clusters (the runner teaches it first), then the merge walk.",
    summary="Cluster, then merge similar clusters",
    actions=[
        ex(None, "Merging needs a clustering first."),
        ex("cluster-controls-expand", "Click the small Cluster label to show the method and K; choose K a little high."),
    ] + peaks_first() + [tr("cluster-button", "Click Cluster.", "clustered")] + MERGE_STEPS)

add(id="tw_merge_settings", command="how do I change the merge settings?",
    phrasings=["what is the 5% setting", "change the similarity cutoff", "merge more aggressively",
               "where are the merge similar clusters settings"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Settings live in the Clusters panel (⚙ beside Merge similar clusters) with a preview in Projection.",
    summary="Merge similar clusters settings",
    actions=[
        op("cluster-detail", "projection"),
        ex("merge-settings", "Smallest cluster (% of reads): clusters under it are folded into their nearest cluster. Similarity cutoff: two clusters more alike than this are merged.",
           requires="has_clusters"),
        ex("clusters-projection", "The Projection tab previews the clusters before and after with these settings."),
        tr("merge-similar", "Click Merge similar clusters to apply them.", "clusters_merged"),
    ])

add(id="tw_merge_two_specific", command="how do I merge two specific clusters?",
    phrasings=["combine cluster 2 and 3", "merge these two clusters", "join two clusters by hand"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="By hand: select the clusters in Overview and merge from there; Merge similar clusters is the automatic version.",
    summary="Merge chosen clusters",
    actions=[
        op("cluster-detail", "overview"),
        ex("clusters-overview", "In Overview, select the clusters you want together and merge them from there.", requires="has_clusters"),
        tr("clusters-overview", "Select the two clusters and merge them.", "clusters_merged"),
        ex("merge-similar", "Merge similar clusters does this automatically for tiny and near-duplicate clusters."),
    ])

# ── Haplotype / strand ──────────────────────────────────────────────
add(id="tw_strand_split", command="how do I look at the two strands separately?",
    phrasings=["split CT and GA", "how do I see each DAF strand", "separate the strands", "show CT and GA reads side by side",
               "how do I view one strand"],
    **ctx_kw(V_DM6_2R),
    thinking="DAF-seq strands: the strand chip in the DAF panel header, then Split: CT | GA side by side (try_it strand_split).",
    summary="View the DAF-seq strands separately",
    actions=STRAND_STEPS + [ex("cluster-button", "Clustering after the split clusters each strand's reads on their own.")])

add(id="tw_strand_already_split", command="how do I look at the two strands separately?",
    phrasings=["split the strands", "show each strand"],
    **ctx_kw(V_DM6_2R, strands=True),
    thinking="State details show CT and GA panels already: short answer, point at the chip to switch back.",
    summary="The strands are already split",
    actions=[
        ex("strand-chip", "Your view is already split: one panel shows CT reads and the one beside it GA reads. Pick Both strands on the chip to go back to one panel."),
    ])

add(id="tw_strand_one_only", command="how do I only show the CT strand?",
    phrasings=["show only GA reads", "hide the GA strand", "only CT reads please", "filter to one strand"],
    **ctx_kw(V_DM6_2R),
    thinking="One strand: the chip's CT strand only / GA strand only options.",
    summary="Show one DAF-seq strand",
    actions=[
        ex("strand-chip", "Open the strand chip in the DAF-seq panel header and pick CT strand only (or GA strand only)."),
        ex("split-by-strand", "Split: CT | GA side by side shows both in two panels instead."),
    ])

add(id="tw_haplotype_compare", command="how do I look at a haplotype?",
    phrasings=["compare two haplotypes", "how do I view haplotypes side by side", "look at maternal vs paternal",
               "how do I compare alleles", "haplotype view"],
    **ctx_kw(V_DM6_2R),
    thinking="Haplotypes: load both references as pairs, then Contacts > Compare opens them side by side (try_it panel_copy_made); linked panels follow each other.",
    summary="Compare two haplotypes",
    actions=[
        ex("reference-pairs", "First load both haplotypes as Multiple FASTA / annotation pairs, with distinct chromosome names."),
        op("contact-map", "compare"),
        ex("haplotype-compare", "Contacts > Compare puts two haplotypes (or two loci) side by side in linked panels."),
        tr("haplotype-form", "Pick the two haplotype chromosomes and open them.", "panel_copy_made"),
        ex("panel-link", "They move together while linked; Unlink lets one wander.", requires="has_panel_copy"),
        ex("cluster-button", "Peaks and clustering then work across both panels together."),
    ])

add(id="tw_haplotype_have_copy", command="how do I compare haplotypes?",
    phrasings=["haplotype comparison", "compare the two alleles"],
    **ctx_kw(V_DM6_2R, copy_view={"chrom": "2R_pat", "start": 9_970_000, "end": 9_980_000}),
    thinking="State details: a copy already shows another view (2R_pat). Short: explain the location bar and link.",
    summary="Your comparison panel is open",
    actions=[
        ex("panel-location-bar", "Your copy already shows 2R_pat: its location box moves it on its own.", requires="has_panel_copy"),
        ex("panel-link", "Link it to make both panels follow the same coordinates."),
        ex("cluster-button", "Clustering with both panels in view clusters the two haplotypes together, peak by peak."),
    ])

# ── Panel copy at another locus ─────────────────────────────────────
add(id="tw_copy_other_locus", command="how do I look at two places at once?",
    phrasings=["view two loci side by side", "open a second region", "compare two genes side by side",
               "show another region in a second panel", "split the view"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Panel copy: + adds a linked copy (try_it panel_copy_made), Unlink, then its own location box (try_it navigated).",
    summary="Two regions side by side",
    actions=COPY_STEPS + [ex("cluster-button", "Clustering with both in view matches their peaks left to right and clusters both loci together.")])

add(id="tw_copy_exists", command="how do I move the second panel to another gene?",
    phrasings=["change the copy's region", "navigate only the second panel", "move just one panel"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY, copy_view={"chrom": "3R", "start": 11_998_000, "end": 12_008_000}),
    thinking="A copy exists (own view 3R). Point at its location bar and the link toggle.",
    summary="Move the copy on its own",
    actions=[
        ex("panel-link", "The copy is unlinked, so it moves on its own.", requires="has_panel_copy"),
        tr("panel-location-bar", "Type a gene or region into the copy's own location box.", "navigated"),
        ex("panel-link", "Link it again to make it follow the main view."),
    ])

add(id="tw_copy_hg38", command="how do I compare MYC and SOX2?",
    phrasings=["put SOX2 next to MYC", "show two genes at once"],
    **ctx_kw(V_HG38_MYC, DS_FIBER_ONLY),
    thinking="Main view is at MYC; the user adds a copy, unlinks it and types SOX2 in its box.",
    summary="MYC and SOX2 side by side",
    actions=[
        tr("panel-add-copy", "Hover the panel header and click + to add a copy.", "panel_copy_made", skip_if="has_panel_copy"),
        ex("panel-link", "Click Unlink on the copy so it can move on its own.", requires="has_panel_copy"),
        tr("panel-location-bar", "Type SOX2 into the copy's location box.", "navigated"),
        ex("layout-menu", "Layout puts the two panels side by side or stacked."),
    ])

# ── Peaks ───────────────────────────────────────────────────────────
add(id="tw_peaks_basics", command="how do I find peaks?",
    phrasings=["how do I scan for peaks", "how do peaks work", "detect accessible peaks", "where are the peaks",
               "teach me peaks"],
    **ctx_kw(V_DM6_2R),
    thinking="Peaks walk: toolbar group, Scan (try_it), select (try_it), lock, draw, rules.",
    summary="How to find and use peaks",
    actions=[
        ex("peaks-toolbar", "Peaks live in the Peaks group of the toolbar."),
        tr("scan-peaks-button", "Click Scan to detect peaks in this view.", "peaks_scanned"),
        tr("peaks-track", "Click a peak on the Peaks track to select it; Cmd/Ctrl+click adds more.", "peak_selected"),
        ex("peaks-controls-expand", "Click the small Peaks label to show the rest of its controls."),
        ex("peaks-lock", "Lock peaks freezes them so navigating doesn't rescan."),
        ex("peak-draw", "Draw a peak lets you mark your own: click a start and an end on the Peaks track."),
        ex("peak-rules", "Peak rules set what counts as a peak: source layer, threshold and width."),
    ])

add(id="tw_peaks_draw", command="how do I draw my own peak?",
    phrasings=["make a custom peak", "mark a region as a peak", "add a peak by hand"],
    **ctx_kw(V_DM6_2R),
    thinking="Custom peak: Draw a peak in the expanded Peaks controls.",
    summary="Draw a custom peak",
    actions=[
        ex("peaks-controls-expand", "Click the small Peaks label to show its extra controls."),
        ex("peak-draw", "Turn on Draw a peak, then click a start and an end on the Peaks track."),
        tr("peaks-track", "Draw your peak and click it to select it.", "peak_selected"),
    ])

add(id="tw_peaks_lock", command="why do my peaks change when I move?",
    phrasings=["keep my peaks fixed", "stop peaks from rescanning", "lock the peaks"],
    **ctx_kw(V_DM6_2R),
    thinking="Peaks rescan per view unless locked: point at Lock peaks.",
    summary="Lock peaks",
    actions=[
        ex(None, "Peaks are rescanned for each view unless you lock them."),
        ex("peaks-controls-expand", "Click the small Peaks label to show the lock."),
        ex("peaks-lock", "Lock peaks freezes the current peaks so navigating doesn't rescan them."),
    ])

add(id="tw_peaks_threshold", command="how do I change the peak threshold?",
    phrasings=["make peak calling stricter", "change what counts as a peak", "edit peak rules", "peaks are too small"],
    **ctx_kw(V_DM6_2R),
    thinking="Peak rules (Rules > Peaks or the Peak rules button) and the Peak Detection defaults.",
    summary="Change peak detection",
    actions=[
        ex("peak-rules", "Peak rules (in the expanded Peaks controls) edit the source layer, threshold and minimum width."),
        ex("rules-peaks-tab", "They are also in the Rules panel's Peaks tab."),
        ex("peak-detection-settings", "Defaults for new scans are under Peak Detection in Analysis & Reproducibility."),
        tr("scan-peaks-button", "Click Scan again to apply the new rules.", "peaks_scanned"),
    ])

# ── Footprints (Cmd+click) ──────────────────────────────────────────
add(id="tw_footprint_analyse", command="how do I analyse a footprint?",
    phrasings=["how do I look at one footprint", "what does cmd click do", "how do I inspect a footprint",
               "how do I open the footprints panel", "analyse a spot"],
    **ctx_kw(V_DM6_2R),
    thinking="Cmd/Ctrl+click opens the Footprints panel with that footprint (try_it footprint_selected), then save and the tabs.",
    summary="Analyse a footprint",
    actions=FOOTPRINT_SELECT + SAVE_FOOTPRINT + [
        ex("footprints-classes", "Classes groups the footprints you Cmd/Ctrl+clicked, with their sizes and motifs."),
        ex("consensus-caller", "Find footprint classes finds the recurrent footprint classes in this view across molecules."),
    ])

add(id="tw_footprint_save", command="how do I save a footprint?",
    phrasings=["keep this footprint", "save a footprint definition", "how do saved footprints work", "mark a footprint"],
    **ctx_kw(V_DM6_2R),
    thinking="Saving needs a selected footprint first (try_it, skipped if one is selected), then Save (try_it footprint_saved).",
    summary="Save a footprint",
    actions=FOOTPRINT_SELECT + SAVE_FOOTPRINT + [
        ex("footprints-cooccupancy", "Co-occupancy then shows which saved footprints occur together on the same molecules."),
    ])

add(id="tw_footprint_classes", command="what are footprint classes?",
    phrasings=["how do I find footprint classes", "find recurring footprints", "what does find footprint classes do"],
    **ctx_kw(V_DM6_2R),
    thinking="Classes tab + Find footprint classes (consensus caller); the user runs it.",
    summary="Footprint classes",
    actions=[
        op("footprint-analysis", "states"),
        ex("footprints-classes", "Classes shows the footprints you Cmd/Ctrl+clicked, grouped by size, with motifs."),
        ex("consensus-caller", "Find footprint classes looks across every molecule in view for recurrent footprint classes (families)."),
    ])

add(id="tw_footprint_multi", command="how do I select several footprints?",
    phrasings=["pick more than one footprint", "cmd click multiple footprints", "save many footprints at once"],
    **ctx_kw(V_DM6_2R),
    thinking="Cmd/Ctrl+click repeatedly; Save all selected footprints appears with 2+.",
    summary="Select several footprints",
    actions=[
        tr("reads-track", "Cmd/Ctrl+click one footprint, then Cmd/Ctrl+click more to add them.", "footprint_selected"),
        ex("save-footprints", "With two or more selected, Save all selected footprints saves each with its default size range.",
           requires="has_selected_footprint"),
        ex("footprints-saved", "They are then listed in the Saved tab."),
    ])

# ── Select reads (Shift+click) ──────────────────────────────────────
add(id="tw_select_reads", command="how do I select reads?",
    phrasings=["how do I pick a read", "what does shift click do", "select a molecule", "how do I get stats on reads",
               "how do I look at one read"],
    **ctx_kw(V_DM6_2R),
    thinking="Shift+click selects a read (try_it reads_selected) and Read Stats summarises the selection.",
    summary="Select reads",
    actions=[
        ex("reads-track", "Each row is one molecule."),
        tr("reads-track", "Shift+click a read to select it; Shift+click more to add them.", "reads_selected"),
        ex("read-stats-summary", "Read Stats sums up the selected reads.", requires="has_selected_reads"),
        ex("read-stats-table", "The Table tab has one row per read: span, footprints, accessibility and MAPQ."),
    ])

add(id="tw_select_reads_stats", command="how do I see read statistics?",
    phrasings=["open read stats", "how many footprints does this read have", "read length and mapq"],
    **ctx_kw(V_DM6_2R),
    thinking="Read Stats needs selected reads: try_it Shift+click (skipped if selected), then the tabs.",
    summary="Read statistics",
    actions=[
        tr("reads-track", "Shift+click the reads you want statistics for.", "reads_selected", skip_if="has_selected_reads"),
        op("read-stats", "summary"),
        ex("read-stats-summary", "Summary covers the selected reads together.", requires="has_selected_reads"),
        ex("read-stats-table", "Table lists each read on its own."),
    ])

# ── Quality filters ─────────────────────────────────────────────────
add(id="tw_quality_calls", command="how do I hide low quality footprints?",
    phrasings=["filter by call quality", "hide bad calls", "how do quality filters work", "set a minimum quality",
               "remove low confidence footprints"],
    **ctx_kw(V_DM6_2R),
    thinking="Call quality: the Quality group (expand → cutoffs per layer); Labeling > Quality has the shading.",
    summary="Hide low-quality calls",
    actions=[
        ex("quality-filters", "Quality in the toolbar sets a minimum call quality per layer; calls below it are hidden."),
        ex("quality-controls-expand", "Click the small Quality label to show its cutoffs."),
        ex("quality-cutoffs", "Set the minimum for each layer (nucleosomes, TF footprints, FIRE, ...)."),
        ex("labeling-quality", "Labeling > Quality also shades calls by quality instead of hiding them."),
        ex("read-filters", "Whole reads with too few footprints are filtered under Read Filters in Reads & Display."),
    ])

add(id="tw_quality_reads", command="how do I filter out reads with few footprints?",
    phrasings=["hide sparse reads", "minimum number of footprints per read", "filter reads by quality"],
    **ctx_kw(V_DM6_2R),
    thinking="Read-level filters live under Read Filters in the sidebar.",
    summary="Filter sparse reads",
    actions=[
        ex("sidebar-reads-display", "Read-level filters are under Reads & Display in the settings sidebar."),
        ex("read-filters", "Read Filters sets the minimum footprints per read, plus gap and quality filters."),
        ex("quality-filters", "Per-call quality cutoffs are in the toolbar's Quality group."),
    ])

add(id="tw_quality_active", command="how do I undo the quality filter?",
    phrasings=["turn off quality filtering", "reset the quality cutoffs", "show all calls again"],
    **ctx_kw(V_DM6_2R, quality=("tf:tq>=200",)),
    thinking="State details show an active tf:tq>=200 cutoff; point at the cutoffs to clear it.",
    summary="Clear the quality cutoff",
    actions=[
        ex("quality-controls-expand", "Click the small Quality label to show the cutoffs."),
        ex("quality-cutoffs", "Your TF cutoff (tq ≥ 200) is set here; clear or lower it to show every call again."),
    ])

# ── Rules ───────────────────────────────────────────────────────────
add(id="tw_rules_full", command="how do rules work?",
    phrasings=["walk me through rules", "how do I make a rule", "what are cluster sort and filter rules",
               "teach me the rules panel", "how do I set up rules"],
    **ctx_kw(V_DM6_2R),
    thinking="Rules walk: Cluster, Sort, Filter tabs; the user applies Sort and Filter (try_it) and clears the filter.",
    summary="How rules work",
    actions=[
        ex("cluster-rules-button", "Cluster rules (in the expanded Cluster controls) opens the Rules panel."),
        ex("rules-cluster-tab", "Cluster rules define which footprints at which regions make clusters."),
        ex("add-cluster-rule", "Add cluster rule creates one; it then appears as a clustering mode."),
        ex("rules-sort-tab", "Sort rules order reads, e.g. by TF footprint count at the selected peaks."),
        ex("add-sort-rule", "Add sort rule creates one."),
        tr("sort-button", "Pick a sort rule and click Sort.", "sorted"),
        ex("rules-filter-tab", "Filter rules hide reads that fail them."),
        ex("add-filter-rule", "Add filter rule creates one."),
        tr("filter-button", "Pick a filter rule and click Filter.", "filter_applied"),
        tr("clear-filter", "Clear filter shows every read again; click it.", "filter_cleared"),
    ])

add(id="tw_rules_sort", command="how do I sort the reads?",
    phrasings=["order reads by something", "sort reads by footprints", "how does sorting work", "sort by accessibility"],
    **ctx_kw(V_DM6_2R),
    thinking="Sorting: Sort button + sort rules (Rules > Sort).",
    summary="Sort reads",
    actions=[
        ex("sort-button", "Sort orders the reads (and clusters) by the chosen sort rule."),
        ex("sort-controls-expand", "Click the small Sort label to show its other controls."),
        ex("sort-rules", "Sort rules opens the Rules panel's Sort tab to make or edit a rule."),
        ex("add-sort-rule", "Add sort rule, e.g. TF footprint count at the selected peaks."),
        tr("sort-button", "Choose your rule and click Sort.", "sorted"),
    ])

add(id="tw_rules_filter", command="how do I filter reads?",
    phrasings=["hide some reads", "show only reads with a footprint here", "filter molecules", "how does the filter button work"],
    **ctx_kw(V_DM6_2R),
    thinking="Filtering: Filter button + filter rules; Clear filter undoes it.",
    summary="Filter reads",
    actions=[
        ex("filter-button", "Filter hides reads that fail the chosen filter rule."),
        ex("filter-controls-expand", "Click the small Filter label to show its other controls."),
        ex("filter-rules", "Filter rules opens the Rules panel's Filter tab."),
        ex("add-filter-rule", "Add filter rule, e.g. reads with a TF footprint at the selected peak."),
        tr("filter-button", "Choose your rule and click Filter.", "filter_applied"),
        ex("clear-filter", "Clear filter shows every read again."),
    ])

add(id="tw_rules_clear_filter", command="how do I remove the filter?",
    phrasings=["clear the filter", "show all reads again", "undo the filter"],
    **ctx_kw(V_DM6_2R, filtered={0: 37}),
    thinking="State details: a filter shows 37 reads. Point at Clear filter (try_it filter_cleared).",
    summary="Clear the read filter",
    actions=[
        ex("filter-controls-expand", "Click the small Filter label to show Clear filter."),
        tr("clear-filter", "Click Clear filter.", "filter_cleared"),
    ])

add(id="tw_rules_label", command="how do I color footprints?",
    phrasings=["change the colors", "color reads by size", "how do labeling rules work", "color TF footprints differently",
               "what do the colours mean"],
    **ctx_kw(V_DM6_2R),
    thinking="Colouring is the Labeling panel's rules (size, layer, region, motif, track overlap).",
    summary="Colour footprints with labeling rules",
    actions=[
        op("colormap", "rules"),
        ex("labeling-rules", "Labeling rules colour footprints by size, layer, region, motif or overlap with a track; the first matching rule wins."),
        ex("add-label-rule", "Add labeling rule creates a colour rule."),
        ex("labeling-quality", "The Quality tab shades calls by their quality."),
    ])

# ── Add tracks ──────────────────────────────────────────────────────
add(id="tw_tracks_hubs", command="how do I add a track?",
    phrasings=["add chip-seq data", "load an encode track", "how do I add ucsc tracks", "add a bigwig",
               "show a chip track under the reads"],
    **ctx_kw(V_HG38_MYC),
    thinking="Tracks panel: Browse hubs for UCSC/ENCODE/ChIP-Atlas, Add a track file for own files (try_it track_added), + Metaprofile.",
    summary="Add tracks",
    actions=[
        ex("open-tracks", "Open Tracks... in Reference & Tracks (or the Tracks panel) adds online and local tracks."),
        op("track-browser"),
        ex("tracks-browse-hubs", "Browse hubs lists UCSC, ENCODE and ChIP-Atlas tracks for the current genome."),
        tr("tracks-add-file", "Pick a hub track, or add your own BigWig, BigBed or BED by path, URL or upload.", "track_added"),
        ex("tracks-add-metaprofile", "+ Metaprofile adds a track averaged from your own reads."),
    ])

add(id="tw_tracks_own_bigwig", command="how do I add my own bigwig?",
    phrasings=["load a signal track", "add a bed file as a track", "show my own track"],
    **ctx_kw(V_DM6_2R),
    thinking="Own file: Tracks panel → Add a track file or URL.",
    summary="Add your own track file",
    actions=[
        op("track-browser"),
        tr("tracks-add-file", "Add your BigWig, BigBed or BED by path, URL or upload.", "track_added"),
        ex("panel-subtracks", "Sub-track settings in the panel header show, hide or reorder tracks."),
    ])

add(id="tw_tracks_metaprofile", command="how do I add a metaprofile?",
    phrasings=["average profile track", "show the average accessibility", "metaprofile of my reads"],
    **ctx_kw(V_DM6_2R),
    thinking="+ Metaprofile in the Tracks panel.",
    summary="Add a metaprofile track",
    actions=[
        op("track-browser"),
        ex("tracks-add-metaprofile", "+ Metaprofile adds a track averaged from your reads' layers or colour rules."),
        tr("tracks-add-metaprofile", "Click it and pick the layer to average.", "track_added"),
    ])

# ── Primers ─────────────────────────────────────────────────────────
add(id="tw_primers", command="how do I design primers?",
    phrasings=["make primers for this peak", "primer design", "how do I get primers", "design PCR primers here",
               "walk me through primers"],
    **ctx_kw(V_DM6_2R),
    thinking="Primers: select a peak (try_it, skipped if selected), Design tab, Design primers (try_it primers_designed), Order List.",
    summary="Design primers",
    actions=[op("primer-design", "design")] + PRIMER_STEPS)

add(id="tw_primers_no_reference", command="how do I design primers?",
    phrasings=["primers", "design primers here"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY, D_NO_REFERENCE, reference=False),
    thinking="Diagnostics: no reference, and primer design needs the sequence. Teach loading a genome first, then the primer walk.",
    summary="Load a reference, then design primers",
    actions=[
        ex(None, "Primer design needs the reference sequence, and none is loaded."),
        tr("genome-selector", "Pick your genome from the Genome list (or load your FASTA).", "genome_loaded"),
        op("primer-design", "design"),
    ] + PRIMER_STEPS)

add(id="tw_primers_order", command="where is my primer order list?",
    phrasings=["how do I order primers", "export primers for ordering", "download the primer list"],
    **ctx_kw(V_DM6_2R),
    thinking="Order List tab in the Primers panel.",
    summary="Primer order list",
    actions=[
        op("primer-design", "order"),
        ex("primers-order-tab", "The Order List tab holds the primers you added and exports an order sheet (IDT, Twist, ...)."),
    ])

# ── Export / save ───────────────────────────────────────────────────
add(id="tw_save_session", command="how do I save my session?",
    phrasings=["save my work", "how do I come back to this later", "save everything", "keep my analysis",
               "how do I save"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Save downloads a session file (try_it session_saved); Session settings and Restore session for later.",
    summary="Save the session",
    actions=SAVE_STEPS)

add(id="tw_export_figure", command="how do I export a figure?",
    phrasings=["save an image", "export svg", "make a figure", "export a pdf of this view", "download a png"],
    **ctx_kw(V_DM6_2R),
    thinking="Export in the top bar: PNG, SVG, PDF or the data.",
    summary="Export a figure",
    actions=[
        ex("export-figure", "Export saves the view as a PNG, SVG or PDF figure, or the data behind it."),
        ex("panel-full-view", "Full view expands one panel first if you want a single-panel figure."),
        ex("layout-menu", "Layout arranges the panels the way you want them in the figure."),
    ])

add(id="tw_restore_session", command="how do I open a saved session?",
    phrasings=["load my session", "reopen my work", "restore a session", "get my last session back"],
    **ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
    thinking="Restore session in Data & Sessions, or drop the file on Load File.",
    summary="Restore a session",
    actions=[
        ex("sidebar-data", "Sessions are in Data & Sessions in the settings sidebar."),
        tr("restore-session", "Click Restore session and pick your session file.", "dataset_loaded"),
        ex("load-dataset", "Load File also opens a session file."),
    ])

add(id="tw_export_data", command="how do I export the data behind a plot?",
    phrasings=["download the numbers", "export as tsv", "get the raw data out"],
    **ctx_kw(V_DM6_2R),
    thinking="Export also exports data; panels have their own exports.",
    summary="Export data",
    actions=[
        ex("export-figure", "Export also saves the data behind the view, not just the figure."),
        ex("read-stats-table", "Read Stats' Table tab exports per-read numbers for selected reads.", requires="has_selected_reads"),
    ])


# ═════════════════════════════════════════════════════════════════════
# 1b. More state and phrasing variants of the core workflows
# ═════════════════════════════════════════════════════════════════════

_VARIANT_CTX = [
    ("dm6_3r", V_DM6_3R, DS_FIBER_DAF),
    ("dm6_x", V_DM6_X, DS_THREE),
    ("hg38_sox2", V_HG38_SOX2, DS_FIBER_ONLY),
    ("mm10", V_MM10_PAX6, DS_FIBER_ONLY),
]

for key, ctx, ds in _VARIANT_CTX:
    add(id=f"tw_cluster_variant_{key}", command="how do I cluster the reads here?",
        phrasings=["show me how to cluster", "how do I find groups of molecules", "cluster these molecules"],
        **ctx_kw(ctx, ds),
        thinking="No clustering in State details: full clustering walk with gated peak steps.",
        summary="How to cluster reads",
        actions=CLUSTER_CONTROLS + peaks_first() + [tr("cluster-button", "Click Cluster.", "clustered")] + CLUSTER_RESULTS[:2])

    add(id=f"tw_peaks_variant_{key}", command="how do I select a peak?",
        phrasings=["how do I click a peak", "choose a peak", "pick peaks for clustering"],
        **ctx_kw(ctx, ds),
        thinking="Peaks must be scanned before they can be selected (gated), then Cmd/Ctrl+click for more.",
        summary="Select a peak",
        actions=[
            tr("scan-peaks-button", "Click Scan to find peaks.", "peaks_scanned", skip_if="has_peaks"),
            tr("peaks-track", "Click a peak on the Peaks track; Cmd/Ctrl+click adds more.", "peak_selected"),
            ex("peak-clear-selection", "Clear peak selection (expanded Peaks controls) deselects them all."),
        ])

    add(id=f"tw_footprint_variant_{key}", command="how do I analyse footprints here?",
        phrasings=["look at the footprints", "how do I use the footprints panel", "footprint analysis"],
        **ctx_kw(ctx, ds),
        thinking="Footprints panel is empty until a footprint is Cmd/Ctrl+clicked: try_it first, then its tabs.",
        summary="Analyse footprints",
        actions=FOOTPRINT_SELECT + [
            ex("footprints-classes", "Classes groups your selected footprints by size, with motifs."),
            ex("save-footprint", "Save keeps a footprint as a definition you can reuse anywhere."),
            ex("footprints-cooccupancy", "Co-occupancy compares saved footprints on the same molecules."),
        ])

    add(id=f"tw_save_variant_{key}", command="how do I save this view?",
        phrasings=["save what I'm looking at", "keep this for later", "save my progress"],
        **ctx_kw(ctx, ds, clustered=(0,) if ds > 1 else ()),
        thinking="Session save (try_it session_saved) + restore for later.",
        summary="Save a session",
        actions=SAVE_STEPS[:1] + SAVE_STEPS[2:])

    add(id=f"tw_tracks_variant_{key}", command="how do I add a track here?",
        phrasings=["add a data track", "show another track", "add annotation track"],
        **ctx_kw(ctx, ds),
        thinking="Tracks panel: hubs for the current genome or an own file (try_it track_added).",
        summary="Add a track",
        actions=[
            op("track-browser"),
            ex("tracks-browse-hubs", "Browse hubs lists UCSC, ENCODE and ChIP-Atlas tracks for this genome."),
            tr("tracks-add-file", "Pick a hub track, or add your own file by path, URL or upload.", "track_added"),
        ])

for key, ctx in (("dm6_2l", V_DM6_2L), ("dm6_hb", V_DM6_HB), ("dm6_x", V_DM6_X)):
    add(id=f"tw_strand_variant_{key}", command="how do I see the CT and GA strands?",
        phrasings=["split by strand", "separate DAF strands", "how do strands work"],
        **ctx_kw(ctx),
        thinking="DAF dataset loaded (State details lists a bam): strand chip, then Split (try_it strand_split).",
        summary="Split the DAF-seq strands",
        actions=STRAND_STEPS)

    add(id=f"tw_merge_variant_{key}", command="I have too many clusters, what do I do?",
        phrasings=["reduce the number of clusters", "clusters look redundant", "clean up clusters"],
        **ctx_kw(ctx, clustered=(0, 1), k=10),
        thinking="Clustered with K=10: Merge similar clusters (with its preview), or recluster with a lower K.",
        summary="Merge similar clusters",
        actions=MERGE_STEPS + [ex("cluster-k", "Or lower K and cluster again.")])

    add(id=f"tw_copy_variant_{key}", command="how do I add a second panel?",
        phrasings=["duplicate this panel", "copy the panel", "open the same data twice"],
        **ctx_kw(ctx, DS_FIBER_ONLY),
        thinking="+ in the panel header makes a linked copy (try_it panel_copy_made), then link/unlink.",
        summary="Add a copy of the panel",
        actions=COPY_STEPS[:2] + [ex("panel-close", "Close panel removes the copy again.")])

for key, ctx, ds in (("empty_dm6", V_EMPTY, DS_NONE), ("hg38", V_HG38_MYC, DS_FIBER_ONLY)):
    diag = D_EMPTY if ds == DS_NONE else []
    add(id=f"tw_load_variant_{key}", command="how do I load a bigbed file?",
        phrasings=["open my footprint calls", "load fiberhmm output", "load a bigbed"],
        **ctx_kw(ctx, ds, diag),
        thinking="Load File (try_it dataset_loaded); companion layer files next to it load together.",
        summary="Load a BigBed",
        actions=LOAD_STEPS[:2] + [
            ex("loaded-datasets", "Companion layer files (TF, m6A, ...) loaded together join the same dataset; they are listed under Loaded Datasets."),
        ])


# ═════════════════════════════════════════════════════════════════════
# 2. Multi-layer chains (8-12 steps, with Copilot's navigation between)
# ═════════════════════════════════════════════════════════════════════

def saved_footprint_chain(to_gene: str) -> list[dict]:
    return [
        ex("reads-track", "Footprints are the coloured blocks on each read. Cmd/Ctrl+click one to analyse it."),
        tr("reads-track", "Cmd/Ctrl+click a footprint in the reads.", "footprint_selected", skip_if="has_saved_footprints"),
        ex("selected-footprint", "The Footprints panel shows the footprint's size range and where it sits.",
           skip_if="has_saved_footprints"),
        tr("save-footprint", "Adjust the size range if you like, then click Save.", "footprint_saved",
           skip_if="has_saved_footprints"),
        ex("footprints-saved", "Saved footprints are listed here and coloured on every read that carries one.",
           requires="has_saved_footprints"),
        nav(to_gene, 5000),
        ex("footprints-cooccupancy", f"At {to_gene}, Co-occupancy shows which saved footprints occur together on the same molecules."),
        ex("footprints-cooccupancy", "Its \"Cluster reads by these footprints\" button groups reads by which saved footprints they carry."),
        tr("footprints-cooccupancy", "Click Cluster reads by these footprints.", "clustered"),
        ex("clusters-overview", "Each cluster is a combination of saved footprints, with its read count.", requires="has_clusters"),
    ]


for key, ctx, gene in (("eve_hb", V_DM6_2R, "hb"), ("hb_eve", V_DM6_HB, "eve"), ("myc_sox2", V_HG38_MYC, "SOX2")):
    add(id=f"tw_chain_saved_fp_{key}", category="teach_chain",
        command="how do I save a footprint and use it somewhere else?",
        phrasings=["save a footprint and check it at another gene", "reuse a footprint definition elsewhere",
                   "how do saved footprints work across loci", "define a footprint then cluster by it"],
        **ctx_kw(ctx),
        thinking=f"Four layers: select → save → move ({gene}) → co-occupancy clustering. skip_if drops the layers already done; Copilot navigates between.",
        summary=f"Save a footprint and reuse it at {gene}",
        actions=saved_footprint_chain(gene))

add(id="tw_chain_saved_fp_have_saved", category="teach_chain",
    command="how do I use my saved footprints at another gene?",
    phrasings=["use saved footprints elsewhere", "co-occupancy of my saved footprints at hb"],
    **ctx_kw(V_DM6_2R),
    thinking="The user already saved footprints; the select/save layers skip at run time, so the same chain applies.",
    summary="Reuse saved footprints at hb",
    actions=saved_footprint_chain("hb"))


def cluster_branch_chain() -> list[dict]:
    return CLUSTER_CONTROLS[1:3] + peaks_first() + [
        tr("cluster-button", "Click Cluster.", "clustered", skip_if="has_clusters"),
        ex("merge-similar", "Merge similar clusters tidies up near-duplicates.", requires="has_clusters"),
        tr("merge-similar", "Click Merge similar clusters.", "clusters_merged"),
        ex("clusters-overview", "In Overview, pick one cluster and subcluster it to split it further; this starts a branch."),
        tr("clusters-overview", "Subcluster the cluster you want to explore.", "clustered"),
        ex("cluster-branches", "The branch map shows the original clustering and your subcluster branch; click a branch to switch."),
        ex("cluster-snapshot", "Snapshot saves a clustering to come back to from the Saved tab."),
    ]


for key, ctx in (("dm6", V_DM6_2R), ("hg38", V_HG38_TP53)):
    add(id=f"tw_chain_cluster_branch_{key}", category="teach_chain",
        command="how do I cluster, merge and then subcluster one cluster?",
        phrasings=["how do cluster branches work", "split one cluster further", "subcluster a cluster",
                   "cluster then drill into one cluster"],
        **ctx_kw(ctx),
        thinking="Chain: cluster → merge → subcluster (a branch) → branch map; each layer is the user's click, skipped if done.",
        summary="Cluster, merge, then subcluster",
        actions=cluster_branch_chain())


def primer_chain(gene: str) -> list[dict]:
    return [
        nav(gene, 3000),
        tr("scan-peaks-button", "Click Scan to find peaks here.", "peaks_scanned", skip_if="has_peaks"),
        tr("peaks-track", "Click the peak you want primers around.", "peak_selected"),
        op("primer-design", "design"),
        ex("primers-design-tab", "The Design tab designs primers around the selected peak.", requires="has_reference"),
        tr("primers-design-button", "Click Design primers.", "primers_designed"),
        ex("primers-design-tab", "Each pair lists its product size and, with BLAST configured, specificity."),
        ex("primers-order-tab", "Add the pairs you like to the Order List, then export the order sheet from there."),
    ]


for key, ctx, gene in (("eve", V_DM6_2R, "eve"), ("myc", V_HG38_MYC, "MYC"), ("sna", V_DM6_2L, "sna")):
    add(id=f"tw_chain_primers_{key}", category="teach_chain",
        command=f"how do I get primers for a peak at {gene} and order them?",
        phrasings=[f"design and order primers near {gene}", f"primers for the {gene} enhancer",
                   "from a peak to a primer order"],
        **ctx_kw(ctx),
        thinking=f"Chain: go to {gene} → Scan → select a peak → Design → Order List. Copilot navigates; the user clicks.",
        summary=f"Primers for a peak at {gene}",
        actions=primer_chain(gene))


def setup_chain(gene: str, genome_hint: str) -> list[dict]:
    return [
        tr("load-dataset", "Click Load File and open your BAM or BigBed.", "dataset_loaded", skip_if="has_dataset"),
        ex("sidebar-reference", "Next, the genome: Reference & Tracks in the settings sidebar."),
        tr("genome-selector", f"Pick {genome_hint} from the Genome list.", "genome_loaded", skip_if="has_gtf"),
        tr("search-bar", f"Search for {gene} and press Enter.", "navigated"),
        ex("cluster-controls-expand", "Click the small Cluster label to show the method and K."),
        tr("scan-peaks-button", "Click Scan to find peaks.", "peaks_scanned"),
        tr("peaks-track", "Click a peak to select it.", "peak_selected"),
        tr("cluster-button", "Click Cluster.", "clustered"),
        ex("clusters-overview", "Here are your clusters with their read counts.", requires="has_clusters"),
    ]


for key, ctx, ds, diag, gene, genome in (
        ("empty_eve", V_EMPTY, DS_NONE, D_EMPTY, "eve", "dm6"),
        ("empty_myc", V_EMPTY, DS_NONE, D_EMPTY, "MYC", "hg38"),
        ("loaded_pax6", V_MM10_PAX6, DS_FIBER_ONLY, [], "Pax6", "mm10")):
    add(id=f"tw_chain_setup_{key}", category="teach_chain",
        command=f"I'm new, how do I get from my file to clusters at {gene}?",
        phrasings=["how do I start from scratch", "walk me through the whole thing", "from loading to clustering",
                   f"load data and cluster reads at {gene}"],
        **ctx_kw(ctx, ds, diag),
        thinking="Setup chain: load → genome → find the gene → peaks → cluster. Layers already done skip (has_dataset, has_gtf).",
        summary=f"From your file to clusters at {gene}",
        actions=setup_chain(gene, genome))


def haplotype_chain() -> list[dict]:
    return [
        ex("reference-files", "Load both haplotypes under Reference Files in Reference & Tracks."),
        ex("reference-pairs", "Use Multiple FASTA / annotation pairs, with distinct chromosome names per haplotype."),
        tr("reference-pairs", "Load the two FASTA/annotation pairs.", "genome_loaded", skip_if="has_reference"),
        op("contact-map", "compare"),
        ex("haplotype-compare", "Compare puts the two haplotypes side by side in linked panels."),
        tr("haplotype-form", "Pick the two haplotype chromosomes and open them.", "panel_copy_made"),
        ex("panel-link", "Linked, both panels follow the same coordinates.", requires="has_panel_copy"),
        tr("scan-peaks-button", "Click Scan; each panel gets its own peaks.", "peaks_scanned"),
        tr("cluster-button", "Select peaks and click Cluster to cluster both haplotypes together.", "clustered"),
        ex("clusters-overview", "Clusters now mix reads from both haplotypes, so you can compare their proportions.", requires="has_clusters"),
    ]


for key, ctx in (("dm6", V_DM6_2R), ("hg38", V_HG38_MYC)):
    add(id=f"tw_chain_haplotype_{key}", category="teach_chain",
        command="how do I compare the two haplotypes and cluster them?",
        phrasings=["haplotype comparison end to end", "cluster maternal and paternal together",
                   "allele-specific clustering"],
        **ctx_kw(ctx),
        thinking="Chain: load pairs → Compare form → linked panels → peaks per panel → cluster both together.",
        summary="Compare and cluster two haplotypes",
        actions=haplotype_chain())


def two_loci_chain(other: str) -> list[dict]:
    return [
        tr("panel-add-copy", "Hover the panel header and click + to add a copy.", "panel_copy_made", skip_if="has_panel_copy"),
        ex("panel-link", "Click Unlink so the copy can move on its own.", requires="has_panel_copy"),
        tr("panel-location-bar", f"Type {other} into the copy's location box.", "navigated"),
        tr("scan-peaks-button", "Click Scan; both panels get their own peaks.", "peaks_scanned"),
        tr("peaks-track", "Select a peak in each panel.", "peak_selected"),
        tr("cluster-button", "Click Cluster: peaks are matched left to right and both loci are clustered together.", "clustered"),
        ex("clusters-profiles", "Profiles compares the clusters; each cluster holds reads from both loci.", requires="has_clusters"),
        ex("merge-similar", "Merge similar clusters tidies up if K was high."),
    ]


for key, ctx, other in (("eve_hb", V_DM6_2R, "hb"), ("myc_sox2", V_HG38_MYC, "SOX2")):
    add(id=f"tw_chain_two_loci_{key}", category="teach_chain",
        command=f"how do I cluster reads here and at {other} together?",
        phrasings=["cluster two loci together", "compare clusters at two genes", "multi-locus clustering"],
        **ctx_kw(ctx, DS_FIBER_ONLY),
        thinking="Chain: copy → unlink → navigate the copy → peaks per panel → cluster both.",
        summary=f"Cluster this locus and {other} together",
        actions=two_loci_chain(other))

add(id="tw_chain_rules_to_filter", category="teach_chain",
    command="how do I keep only reads with a TF footprint at my peak?",
    phrasings=["filter to reads bound at the peak", "show only occupied molecules", "keep reads with a footprint here"],
    **ctx_kw(V_DM6_2R),
    thinking="Chain: select the peak → make a filter rule (TF footprints, selected peaks) → Filter → Clear to undo.",
    summary="Keep reads with a TF footprint at the peak",
    actions=[
        tr("scan-peaks-button", "Click Scan.", "peaks_scanned", skip_if="has_peaks"),
        tr("peaks-track", "Select your peak.", "peak_selected", skip_if="has_selected_peak"),
        ex("filter-controls-expand", "Click the small Filter label to show the filter controls."),
        ex("filter-rules", "Filter rules opens the Rules panel's Filter tab."),
        ex("add-filter-rule", "Add a filter rule: TF-footprint layer, scope Selected peaks, count at least 1."),
        tr("filter-button", "Pick the rule and click Filter.", "filter_applied"),
        ex("reads-track", "Only molecules with a TF footprint at the peak are shown now."),
        ex("clear-filter", "Clear filter brings back every read."),
    ])

add(id="tw_chain_strand_cluster", category="teach_chain",
    command="how do I cluster each DAF strand separately?",
    phrasings=["cluster CT and GA reads apart", "strand-specific clustering", "cluster per strand"],
    **ctx_kw(V_DM6_2R),
    thinking="Chain: split by strand → peaks → cluster; each strand panel clusters its own reads.",
    summary="Cluster the CT and GA strands separately",
    actions=STRAND_STEPS + peaks_first() + [
        tr("cluster-button", "Click Cluster; each strand panel is clustered on its own reads.", "clustered"),
        ex("clusters-overview", "The Clusters panel lists each panel's clusters.", requires="has_clusters"),
    ])


# ═════════════════════════════════════════════════════════════════════
# 3. Where is ... / what is ... / what does X do
# ═════════════════════════════════════════════════════════════════════

# (id, command, phrasings, steps, thinking, needs_open_panel)
WHERE: list[tuple[str, str, list[str], list[dict], str]] = [
    ("search", "where is the search box?", ["where do I type a gene", "where's search"],
     [ex("search-bar", "Here: type a gene name or coordinates and press Enter.")], "Single anchored explain."),
    ("scan", "where is the scan button?", ["how do I scan", "where do I find peaks"],
     [ex("scan-peaks-button", "Scan detects peaks in the current view with the enabled peak rules.")], "Single anchored explain."),
    ("cluster_btn", "where is the cluster button?", ["where do I cluster", "where's cluster"],
     [ex("cluster-button", "Cluster groups reads by their footprints at the selected peaks."),
      ex("cluster-controls-expand", "Click the small Cluster label for the method and K.")], "Button, then its expand toggle."),
    ("method", "where do I change the clustering method?", ["where is the k setting", "change k", "where's the cluster mode"],
     [ex("cluster-controls-expand", "Click the small Cluster label to show the rest of its controls."),
      ex("cluster-method", "The method is here; K is right next to it.")], "The method is behind the expand toggle."),
    ("layers", "where are the layer toggles?", ["how do I hide nucleosomes", "turn off TF footprints", "show m6A"],
     [ex("layers-controls-expand", "Click the small Layers label to show every layer."),
      ex("layer-toggles", "Show or hide each layer: nucleosomes, TF footprints, FIRE/MSP, m6A, 5mC, deamination.")],
     "Layers are behind the Layers expand toggle."),
    ("undo", "how do I undo?", ["undo that", "where is undo", "I made a mistake"],
     [ex("undo", "Undo (Cmd/Ctrl+Z) reverses the last change."),
      ex("history-timeline", "The timeline next to it jumps back several steps at once.")], "Undo + timeline."),
    ("redo", "how do I redo?", ["redo that", "undo my undo"],
     [ex("redo", "Redo (Cmd/Ctrl+Shift+Z) re-applies what you undid.")], "Single anchored explain."),
    ("sidebar", "where are the settings?", ["open settings", "where is the sidebar", "preferences"],
     [ex("sidebar-toggle", "This button (or Cmd/Ctrl+B) shows the settings sidebar: Data & Sessions, Reference & Tracks, Reads & Display, Analysis & Reproducibility.")],
     "Sidebar toggle."),
    ("save", "where is save?", ["how do I save", "save button"],
     [ex("save-session", "Save downloads a session file you can reload later.")], "Single anchored explain."),
    ("export", "where is export?", ["how do I export", "export button"],
     [ex("export-figure", "Export saves a PNG, SVG or PDF figure, or the data behind it.")], "Single anchored explain."),
    ("tour", "is there a tutorial?", ["give me the tour", "how do I learn this browser", "start the guided tour"],
     [ex("guided-tour", "Tour runs a scripted walk through the main tools on a demo dataset; you can also ask me how to do anything.")],
     "Point at the Tour button."),
    ("layout", "how do I arrange the panels?", ["put panels side by side", "stack the panels", "change the layout"],
     [ex("layout-menu", "Layout arranges panels side by side or stacked and evens out their widths."),
      ex("layout-panel", "The Layout panel also renames, links and merges dataset panels.")], "Layout menu + panel."),
    ("full_view", "how do I make one panel bigger?", ["maximize a panel", "full screen one dataset", "expand a panel"],
     [ex("panel-full-view", "Full view fills the window with one panel; click it again to restore.")], "Single anchored explain."),
    ("minimize", "how do I hide a panel?", ["minimize a dataset", "get a panel out of the way", "close a panel"],
     [ex("panel-minimize", "Minimize turns the panel into a chip at the bottom; click the chip to bring it back."),
      ex("panel-close", "Close panel removes it (and the dataset, if it's its last panel).")], "Minimize vs close."),
    ("subtracks", "how do I hide the gene track?", ["hide the sequence track", "reorder tracks", "show the axis"],
     [ex("panel-subtracks", "Sub-track settings in the panel header show, hide or reorder the axis, genes, sequence, peaks and other tracks.")],
     "Sub-track settings."),
    ("row_height", "how do I make reads bigger?", ["bigger rows", "make reads thinner", "change read height"],
     [ex("reads-controls-expand", "Click the small Reads label to show its controls."),
      ex("row-height", "Row height sets pixels per read; Cmd/Ctrl+scroll over the reads does it too.")], "Row height is in the Reads group."),
    ("sample", "how do I show all reads instead of a sample?", ["why only some reads", "show every read", "sample fewer reads"],
     [ex("read-display-mode", "This switches between drawing every read and a random sample."),
      ex("reproducibility", "The sample size and seed are under Reproducibility.")], "All/sample toggle."),
    ("read_window", "how do I show reads over a bigger region?", ["reads disappear when I zoom out", "raise the read limit",
                                                               "show reads up to 100 kb"],
     [ex("read-window-setting", "Show reads up to sets the largest view in which reads are drawn; beyond it you see coverage.")],
     "Read window setting."),
    ("spanning", "what does spanning only do?", ["why are some reads hidden", "show partial reads", "spanning toggle"],
     [ex("spanning-toggle", "Spanning only shows just the reads that cover the whole view edge to edge; turn it off to see every overlapping read.")],
     "Spanning toggle."),
    ("relative", "how do I use TSS coordinates?", ["positions relative to the TSS", "relative coordinates"],
     [ex("relative-coords", "TSS-relative coordinates show positions relative to the selected gene's TSS.")], "Relative coords."),
    ("reproducible", "how do I make clustering reproducible?", ["set a random seed", "same clusters every time", "sampling seed"],
     [ex("reproducibility", "Reproducibility sets the sample size and seed, so clustering and profiles repeat exactly.")],
     "Reproducibility section."),
    ("analysis_strip", "where are the analysis panels?", ["how do I open a panel", "list of panels", "where is the clusters panel"],
     [ex("analysis-strip", "Each analysis panel (Clusters, Footprints, Rules, ...) has a button in this strip; click one to open it.")],
     "Analysis strip."),
    ("footprints_panel", "where is the footprints panel?", ["open footprints", "footprint analysis panel"],
     [op("footprint-analysis"),
      ex("footprints-classes", "Here: it fills in once you Cmd/Ctrl+click a footprint on a read.")], "Open panel, note it needs a Cmd+click."),
    ("rules_panel", "where is the rules panel?", ["open rules", "where do I make rules"],
     [op("cluster-features", "cluster"),
      ex("rules-cluster-tab", "Rules has Cluster, Sort, Filter and Peaks tabs for reusable rules.")], "Open Rules."),
    ("labeling_panel", "where do I change colors?", ["open labeling", "colour settings"],
     [op("colormap", "rules"), ex("labeling-rules", "Labeling rules colour footprints by size, layer, region, motif or track overlap.")],
     "Open Labeling."),
    ("tracks_panel", "where is the tracks panel?", ["open tracks", "where do I add tracks"],
     [op("track-browser"), ex("tracks-browse-hubs", "Browse hubs, add your own track files, or add a metaprofile here.")], "Open Tracks."),
    ("primers_panel", "where is primer design?", ["open primers", "primer panel"],
     [op("primer-design", "design"), ex("primers-design-tab", "Design primers around the selected peaks or the view here.")], "Open Primers."),
    ("coacc_panel", "where is co-accessibility?", ["open co-accessibility", "coacc panel"],
     [op("co-accessibility"), ex("coacc-matrix", "How often pairs of positions are open on the same molecule.")], "Open Co-accessibility."),
    ("regions_panel", "where is the regions panel?", ["saved regions", "circular genome view"],
     [op("circular-genome"), ex("regions-add-view", "Add View saves the current view as a region to come back to.")], "Open Regions."),
    ("capture_panel", "where is the capture cart?", ["capture regions", "probe design panel"],
     [op("capture"), ex("capture-add-region", "Add the view or selection as a capture region."),
      ex("capture-export", "Export them as BED, FASTA or probes.")], "Open Capture."),
    ("contacts_panel", "where is the contact map?", ["micro-c map", "open contacts"],
     [op("contact-map", "map"), ex("contacts-map", "The Micro-C / DAF-C contact map for the loaded map file.")], "Open Contacts."),
    ("transcription_panel", "where is the transcription panel?", ["pol II states", "paused polymerase"],
     [op("transcription-state", "filters"),
      ex("transcription-filters", "Filter reads by Pol II state (PIC, paused, elongating) at the selected genes.", requires="has_selected_gene")],
     "Open Transcription; it needs a selected gene."),
    ("history_panel", "where is the history panel?", ["show history", "list of my changes"],
     [ex("history-timeline", "The history timeline next to Undo lists every step of the session.")], "History timeline."),
    ("annotations_panel", "where are the annotations?", ["per-read annotations", "annotation files"],
     [op("annotations", "files"), ex("annotations-files", "Per-read annotation files and their types."),
      ex("annotations-filter", "Filter reads by annotation type here.")], "Open Annotations."),
    ("loaded", "where are my loaded datasets?", ["list my datasets", "which files are loaded"],
     [ex("loaded-datasets", "Loaded Datasets in Data & Sessions lists every dataset.")], "Loaded Datasets."),
    ("copilot", "what can you do?", ["what are you", "how do I use copilot", "help"],
     [ex("copilot-input", "Ask me how to do anything: I open the right panels, point at the controls and walk you through them, and hand you the clicks. Try \"how do I cluster reads?\" or \"why are no reads visible?\".")],
     "Explain what Copilot does."),
]

WHAT: list[tuple[str, str, list[str], list[dict], str]] = [
    ("merge_similar", "what does merge similar clusters do?", ["what is merge similar", "explain merge similar clusters"],
     [ex("merge-similar", "It folds clusters smaller than a set share of reads, and near-duplicate clusters, into their nearest cluster; every read goes to the nearest remaining cluster.")],
     "Explain at the control."),
    ("go_to_reads", "what does go to reads do?", ["what is the dice button", "random window"],
     [ex("go-to-reads", "It jumps to the next best-covered window at this zoom, deepest first.")], "Explain at the control."),
    ("peaks_track", "what is the peaks track?", ["what are the bars above the reads", "what are peaks"],
     [ex("peaks-track", "Detected peaks: regions accessible on many molecules. Click one to select it for clustering or primers.")],
     "Explain at the track."),
    ("reads_track", "what am I looking at?", ["what do the rows mean", "explain the reads", "what is each line"],
     [ex("reads-track", "Each row is one DNA molecule. Coloured blocks are footprints (nucleosomes, TF footprints); gaps between them are accessible."),
      ex("layer-toggles", "The Layers controls choose which footprint types are drawn.")], "Orient the user."),
    ("coacc", "what is co-accessibility?", ["what does the coacc matrix show", "explain co-accessibility"],
     [op("co-accessibility"), ex("coacc-matrix", "For each pair of positions, how often both are open on the same molecule, beyond chance.")],
     "Open + explain."),
    ("vplot", "what is a v-plot?", ["explain the v-plot", "what does the v shape mean"],
     [ex("clusters-vplot", "Footprint size (y) against position (x), per cluster: nucleosomes sit high, TF footprints low.", requires="has_clusters")],
     "V-Plot needs clusters."),
    ("projection", "what is the projection tab?", ["what are the dots in projection", "explain projection"],
     [ex("clusters-projection", "Each dot is a read placed by its footprint features; clusters that overlap here are similar.", requires="has_clusters")],
     "Projection needs clusters."),
    ("composition", "what does composition show?", ["cluster composition"],
     [ex("clusters-composition", "Each cluster's mix of footprint types.", requires="has_clusters")], "Composition needs clusters."),
    ("dynamic", "what is dynamic reassignment?", ["why do reads change clusters when I pan", "reassign reads"],
     [ex("cluster-dynamic", "As you pan, reads are reassigned to the nearest existing cluster so the clustering follows you.", requires="has_clusters")],
     "Dynamic reassignment."),
    ("unhide", "how do I show all clusters again?", ["unhide clusters", "reads disappeared after clicking a cluster"],
     [ex("cluster-focus-bar", "Unhide all shows every cluster again after a focus.", requires="has_clusters")], "Unhide all."),
    ("cooc", "what is co-occupancy?", ["footprint co-occupancy", "which footprints occur together"],
     [op("footprint-analysis", "co-occ"),
      ex("footprints-cooccupancy", "For your saved footprints: how often they occur together on the same molecule. It can also cluster reads by them.")],
     "Open tab + explain."),
    ("strand", "what are CT and GA reads?", ["what is the strand chip", "DAF-seq strands"],
     [ex("strand-chip", "DAF-seq deaminates one strand per molecule: CT reads show C→T changes, GA reads G→A. The chip picks which to show.")],
     "Explain the strands."),
    ("quality", "what does the quality setting do?", ["what are the quality cutoffs", "what is call quality"],
     [ex("quality-filters", "Each footprint call has a quality score; Quality hides calls below the cutoff you set per layer.")],
     "Quality."),
    ("labeling_quality", "what does quality shading do?", ["fade low quality calls"],
     [op("colormap", "quality"), ex("labeling-quality", "Shades each call by its quality instead of hiding it.")], "Labeling > Quality."),
    ("saved_clusters", "how do I get an old clustering back?", ["restore a clustering", "saved clusterings", "go back to my earlier clusters"],
     [ex("cluster-snapshot", "Snapshot saves the current clustering.", requires="has_clusters"),
      ex("clusters-saved", "The Saved tab lists saved clusterings; click one to restore it.")], "Snapshot + Saved tab."),
    ("peak_detection", "what are peak rules?", ["how are peaks called", "peak detection settings"],
     [ex("peak-detection-rules", "Each rule turns a signal (e.g. accessibility) into peaks with a threshold and minimum width.")],
     "Peak Detection panel."),
    ("find_classes", "what does find footprint classes do?", ["consensus caller", "footprint families"],
     [ex("consensus-caller", "It looks across all molecules in view for recurrent footprint classes (families) and labels each read's calls.")],
     "Consensus caller."),
    ("regions", "what is add view?", ["save this region", "bookmark a region"],
     [ex("regions-add-view", "Add View saves the current view as a named region in the Regions panel.")], "Regions."),
    ("plasmid", "how do I load a plasmid?", ["open a snapgene file", "add a construct", "view a plasmid map"],
     [ex("load-plasmid", "Load Plasmid Map adds a GenBank, SnapGene, EMBL or SBOL map as its own contig."),
      ex("regions-plasmid", "The Regions panel can load one too and show it as a circular contig.")], "Plasmid loading."),
    ("merge_datasets", "how do I merge two datasets?", ["combine two bams", "merge samples into one panel"],
     [op("dataset-layout"), ex("layout-merge", "Select the panels and click Merge datasets to show them as one.")], "Layout merge."),
    ("link_datasets", "how do I link panels?", ["make panels move together", "sync two panels"],
     [op("dataset-layout"), ex("layout-link", "Select the panels and link them so they move together.")], "Layout link."),
]

for rid, command, phrasings, steps, thinking in WHERE:
    add(id=f"tw_where_{rid}", category="teach_where", command=command, phrasings=phrasings,
        **ctx_kw(V_DM6_2R), thinking=thinking, summary=command.rstrip("?").capitalize(), actions=steps)

for rid, command, phrasings, steps, thinking in WHAT:
    clustered = (0,) if any(s.get("requires") == "has_clusters" or s.get("anchor", "").startswith("cluster")
                            for s in steps) else ()
    add(id=f"tw_what_{rid}", category="teach_what", command=command, phrasings=phrasings,
        **ctx_kw(V_DM6_2R, clustered=clustered), thinking=thinking, summary=command.rstrip("?").capitalize(),
        actions=steps)

# A few "where" questions in other genomes/states so the context varies.
for rid, ctx, ds, command, steps in (
        ("hg38_search", V_HG38_SOX2, DS_FIBER_ONLY, "where do I search for a gene?",
         [ex("search-bar", "Type a gene name such as SOX2, or coordinates, and press Enter.")]),
        ("mm10_layers", V_MM10_PAX6, DS_FIBER_ONLY, "how do I turn off the nucleosome layer?",
         [ex("layers-controls-expand", "Click the small Layers label."),
          ex("layer-toggles", "Untick nucleosomes to hide them; the other layers stay.")]),
        ("empty_load", V_EMPTY, DS_NONE, "where do I load files?",
         [ex("load-dataset", "Load File, top left: open a BAM, BigBed, BigWig, GTF, FASTA or session.")]),
        ("x_scan", V_DM6_X, DS_THREE, "where's the scan button?",
         [ex("scan-peaks-button", "Scan finds peaks in this view for every panel.")]),
        ("3r_undo", V_DM6_3R, DS_FIBER_DAF, "how do I undo that?",
         [ex("undo", "Undo (Cmd/Ctrl+Z) reverses the last change.")])):
    add(id=f"tw_where_{rid}", category="teach_where", command=command,
        phrasings=[], **ctx_kw(ctx, ds, D_EMPTY if ds == DS_NONE else []),
        thinking="Short anchored answer.", summary=command.rstrip("?").capitalize(), actions=steps)


# ═════════════════════════════════════════════════════════════════════
# 4. Follow-ups (previous_turns)
# ═════════════════════════════════════════════════════════════════════

def turn(text: str, summary: str, types: list[str]) -> dict:
    return {"text": text, "summary": summary, "actions": [{"type": t} for t in types]}


T_CLUSTER = turn("how do I cluster reads?", "How to cluster reads",
                 ["explain", "explain", "try_it", "try_it", "try_it", "explain"])
T_LOAD = turn("how do I load my data?", "How to load data", ["explain", "try_it", "explain", "explain"])
T_FOOTPRINT = turn("how do I analyse a footprint?", "Analyse a footprint", ["explain", "try_it", "explain", "try_it"])
T_PEAKS = turn("how do I find peaks?", "How to find and use peaks", ["explain", "try_it", "try_it", "explain"])
T_GENOME = turn("how do I change genomes?", "How to change the genome", ["explain", "try_it", "explain", "explain"])
T_STRAND = turn("how do I look at the two strands separately?", "View the DAF-seq strands separately",
                ["explain", "try_it", "explain"])
T_PROJECTION = turn("what is the projection tab?", "What is the projection tab", ["explain"])
T_MERGE = turn("how do I merge clusters?", "How to merge similar clusters", ["open_panel", "explain", "explain", "try_it"])
T_FILTER = turn("how do I filter reads?", "Filter reads", ["explain", "explain", "try_it"])
T_COPY = turn("how do I look at two places at once?", "Two regions side by side", ["try_it", "explain", "try_it"])

FOLLOWUPS = [
    ("clicked_cluster", "ok I clicked cluster, now what?", ["done, what next?", "I clustered, what now", "clusters are there, next?"],
     V_DM6_2R, dict(clustered=(0,)), [T_CLUSTER],
     "Previous turn taught clustering and State details show clusters: continue with the results, not the clustering steps.",
     "What to do with your clusters",
     [op("cluster-detail", "overview"),
      ex("clusters-overview", "Overview: each cluster and its read count; click one to focus it.", requires="has_clusters"),
      ex("clusters-profiles", "Profiles compares their average profiles."),
      ex("merge-similar", "Too many near-duplicates? Merge similar clusters."),
      ex("sort-button", "Sort orders the reads within each cluster.")]),
    ("after_load", "what next?", ["ok it's loaded, now what?", "what should I do now", "I loaded my file, what next"],
     V_DM6_2R, {}, [T_LOAD],
     "Data is loaded (previous turn). Next: navigate to a locus, then peaks and clustering.",
     "Next steps after loading",
     [ex("search-bar", "Go to a gene or region: type it here and press Enter."),
      tr("search-bar", "Search for a gene you care about.", "navigated"),
      ex("go-to-reads", "Or let Go to reads find a well-covered window."),
      ex("scan-peaks-button", "Then Scan for peaks and select one to cluster the reads there."),
      ex("guided-tour", "Tour walks through every main tool on a demo dataset.")]),
    ("after_footprint", "now what?", ["I saved it, what next", "ok the footprint is saved", "what can I do with it now"],
     V_DM6_2R, {}, [T_FOOTPRINT],
     "Footprint saved (previous turn): show where it lives and how to use it (co-occupancy, clustering by it, another locus).",
     "Using a saved footprint",
     [ex("footprints-saved", "Your footprint is in the Saved tab and coloured on every read that carries it.", requires="has_saved_footprints"),
      ex("footprints-cooccupancy", "Save a few more, then Co-occupancy shows which occur together on the same molecules."),
      ex("footprints-cooccupancy", "Cluster reads by these footprints groups reads by which saved footprints they carry."),
      ex("search-bar", "Saved footprints pinned to a position apply at that locus; navigate there any time.")]),
    ("after_peaks", "ok I selected a peak, what can I do with it?", ["peak selected, now what", "what do I do with the peak"],
     V_DM6_2R, {}, [T_PEAKS],
     "A peak is selected: its uses are clustering, primers, filters/sorts scoped to it.",
     "What a selected peak is for",
     [ex("cluster-button", "Cluster groups the reads by their footprints at the selected peak.", requires="has_selected_peak"),
      ex("primers-design-tab", "Primers designs PCR primers around it."),
      ex("filter-rules", "Rules can filter or sort reads by what they carry at the selected peaks."),
      ex("peaks-lock", "Lock peaks keeps it while you move around.")]),
    ("undo_cluster", "how do I undo that?", ["undo the clustering", "go back to before I clustered", "remove the clusters"],
     V_DM6_2R, dict(clustered=(0,)), [T_CLUSTER],
     "Previous turn clustered: undo reverses it, or Clear clusters removes the clustering.",
     "Undo the clustering",
     [ex("undo", "Undo (Cmd/Ctrl+Z) reverses the clustering."),
      ex("cluster-controls-expand", "Or click the small Cluster label to show Clear clusters."),
      ex("cluster-clear", "Clear clusters removes the current clustering.", requires="has_clusters")]),
    ("undo_merge", "undo that merge", ["I don't like the merge", "unmerge the clusters", "go back"],
     V_DM6_2R, dict(clustered=(0,)), [T_MERGE],
     "Previous turn merged: Undo brings the clusters back; the timeline shows exactly where.",
     "Undo the merge",
     [ex("undo", "Undo (Cmd/Ctrl+Z) brings the merged clusters back."),
      ex("history-timeline", "The timeline shows the merge step if you want to jump further back."),
      ex("merge-settings", "Next time, lower the similarity cutoff to merge less.", requires="has_clusters")]),
    ("back_to_clusters", "go back to the clusters", ["show me the clusters again", "open the clusters panel", "back to clusters"],
     V_DM6_2R, dict(clustered=(0,)), [T_PROJECTION],
     "Reopen the Clusters panel on Overview.",
     "Back to the Clusters panel",
     [op("cluster-detail", "overview"),
      ex("clusters-overview", "Here are your clusters.", requires="has_clusters")]),
    ("explain_tab_again", "explain that tab again", ["what was that tab", "say that again", "I didn't get that"],
     V_DM6_2R, dict(clustered=(0,)), [T_PROJECTION],
     "The last explained tab was Projection: open it and explain it more slowly.",
     "The Projection tab again",
     [op("cluster-detail", "projection"),
      ex("clusters-projection", "Each dot is one read, placed so that reads with similar footprints sit close together.", requires="has_clusters"),
      ex("clusters-projection", "Dots are coloured by cluster: clusters whose dots overlap are similar and good candidates to merge."),
      ex("merge-settings", "The merge settings here preview which clusters Merge similar clusters would combine.")]),
    ("after_genome", "the genome is loaded, what now?", ["genome done, next", "what's next after the genome"],
     V_HG38_MYC, dict(), [T_GENOME],
     "Genome loaded: next is the data and a locus.",
     "After choosing the genome",
     [ex("load-dataset", "Load your reads with Load File if you haven't yet."),
      tr("search-bar", "Search for a gene, e.g. MYC.", "navigated"),
      ex("go-to-reads", "Go to reads jumps to well-covered windows.")]),
    ("after_split", "which panel is which strand?", ["how do I tell CT from GA", "which one is GA"],
     V_DM6_2R, dict(strands=True), [T_STRAND],
     "Split exists (State details): the chip on each panel names its strand.",
     "Telling the strand panels apart",
     [ex("strand-chip", "Each panel's chip names its strand: CT strand or GA strand. Pick Both strands to merge them back.")]),
    ("after_filter_what", "why did most reads disappear?", ["where did my reads go", "reads vanished after filtering"],
     V_DM6_2R, dict(filtered={0: 12}), [T_FILTER],
     "The previous turn applied a filter and State details shows 12 reads left: the filter is doing it; Clear filter restores them.",
     "The filter hides most reads",
     [ex("filter-button", "Your filter keeps only reads that pass the rule; 12 do here."),
      ex("filter-controls-expand", "Click the small Filter label to show Clear filter."),
      tr("clear-filter", "Click Clear filter to see every read again.", "filter_cleared")]),
    ("after_copy", "how do I get rid of the copy?", ["close the second panel", "remove the copy panel"],
     V_DM6_2R, dict(copy_view={"chrom": "3R", "start": 11_998_000, "end": 12_008_000}), [T_COPY],
     "A copy exists: Close panel on the copy removes it; Minimize just hides it.",
     "Remove the panel copy",
     [ex("panel-close", "Hover the copy's header and click Close panel.", requires="has_panel_copy"),
      ex("panel-minimize", "Minimize keeps it as a chip instead.")]),
    ("more_detail_cluster", "tell me more about the cluster method", ["explain the methods more", "why k-means"],
     V_DM6_2R, {}, [T_CLUSTER],
     "Follow-up on the method step of the previous walk.",
     "More about clustering methods",
     [ex("cluster-controls-expand", "Click the small Cluster label."),
      ex("cluster-method", "K-means splits reads into K groups by their footprint pattern at the selected peaks; KMeans++ picks better starting points. Hierarchical builds a tree, HDBSCAN finds dense groups and leaves outliers unassigned, combinatorial makes one cluster per on/off pattern.")]),
    ("skip_ahead", "I already did the peaks, skip to clustering", ["skip that, I have peaks", "just show me the cluster part"],
     V_DM6_2R, {}, [T_CLUSTER],
     "The user has peaks: the cluster walk from the button, gated on has_selected_peak.",
     "Clustering from the Cluster button",
     [tr("cluster-button", "Click Cluster.", "clustered", requires="has_selected_peak"),
      ex("clusters-overview", "Your clusters with their read counts.", requires="has_clusters")]),
    ("stuck_try_it", "it's not doing anything", ["nothing happened", "the step is stuck", "I clicked but nothing"],
     V_DM6_2R, {}, [T_CLUSTER],
     "A try_it is waiting for a result. Cluster needs a selected peak; point at the peaks track, then Cluster again.",
     "Getting the clustering step to work",
     [ex(None, "The walkthrough waits until the step's result appears; Skip moves on without it."),
      tr("peaks-track", "Clustering needs a selected peak: click one on the Peaks track.", "peak_selected", skip_if="has_selected_peak"),
      tr("cluster-button", "Now click Cluster.", "clustered")]),
]

for rid, command, phrasings, ctx, state, prev, thinking, summary, steps in FOLLOWUPS:
    add(id=f"tw_followup_{rid}", category="teach_followup", command=command, phrasings=phrasings,
        **ctx_kw(ctx, **state), previous_turns=prev, thinking=thinking, summary=summary, actions=steps)


# ═════════════════════════════════════════════════════════════════════
# 5. Beyond what Copilot does: "just do it", off-topic
# ═════════════════════════════════════════════════════════════════════

DO_IT = [
    ("cluster", "just cluster the reads for me", ["cluster it", "do the clustering", "cluster this with k=5"],
     "I don't click for you, but I'll walk you through it: clustering is a few clicks.",
     CLUSTER_CONTROLS[1:] + peaks_first() + [tr("cluster-button", "Click Cluster.", "clustered")]),
    ("scan", "scan the peaks", ["find peaks for me", "run peak detection"],
     "I point, you click: Scan is right here.",
     [tr("scan-peaks-button", "Click Scan to detect the peaks.", "peaks_scanned")]),
    ("load", "load my bam file", ["open my data for me", "load the file"],
     "I can't open your files, but here's how.",
     [tr("load-dataset", "Click Load File and pick your BAM.", "dataset_loaded")]),
    ("merge", "merge the clusters for me", ["merge them", "run merge similar"],
     "I'll show you where; the merge is your click.",
     [ex("merge-settings", "Check the settings and preview first.", requires="has_clusters"),
      tr("merge-similar", "Click Merge similar clusters.", "clusters_merged")]),
    ("export", "export a figure for me", ["save a png of this", "make me an svg"],
     "Exports are your click, but here's the button.",
     [ex("export-figure", "Click Export and choose PNG, SVG or PDF.")]),
    ("primers", "design primers for this peak", ["make me primers", "get primers here"],
     "Primer design runs when you click it; here's the walk.",
     [op("primer-design", "design")] + PRIMER_STEPS[1:3]),
    ("filter", "filter to reads with a footprint at the peak", ["keep only bound reads", "filter them"],
     "Filtering is your click; I'll show you the rule and the button.",
     [ex("add-filter-rule", "Add a filter rule: TF footprints at the selected peaks, at least 1."),
      tr("filter-button", "Pick it and click Filter.", "filter_applied")]),
    ("split", "split the strands", ["split by strand", "separate CT and GA"],
     "Splitting is one click in the strand chip.",
     [tr("split-by-strand", "Open the strand chip and choose Split: CT | GA side by side.", "strand_split")]),
    ("save", "save my session", ["save this", "save it"],
     "Saving downloads a file, so it's your click.",
     [tr("save-session", "Click Save.", "session_saved")]),
    ("genome", "switch to hg38", ["change genome to hg38", "load hg38"],
     "Switching genomes is your click; the list is here.",
     [tr("genome-selector", "Pick hg38 from the Genome list.", "genome_loaded")]),
]

for rid, command, phrasings, intro, steps in DO_IT:
    clustered = (0,) if rid == "merge" else ()
    add(id=f"tw_doit_{rid}", category="teach_boundary", command=command, phrasings=phrasings,
        **ctx_kw(V_DM6_2R, clustered=clustered),
        thinking="Copilot teaches: it points at the control and hands the user the click instead of running the operation.",
        summary=f"You run it; here's how ({rid})", actions=[ex(None, intro)] + steps)

# Navigation is fine to do for the user.
add(id="tw_doit_navigate_ok", category="teach_boundary", command="take me to eve",
    phrasings=["go to eve", "show me eve", "navigate to eve"],
    **ctx_kw(V_DM6_3R),
    thinking="Navigation is something Copilot may do; go there and show where the user would search next time.",
    summary="Go to eve",
    actions=[nav("eve", 5000), ex("search-bar", "Here is eve. You can also type any gene into the search box.")])

add(id="tw_doit_open_panel_ok", category="teach_boundary", command="open the clusters panel",
    phrasings=["show the clusters panel", "open clusters"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Opening panels is allowed; open it and point at Overview.",
    summary="Open the Clusters panel",
    actions=[op("cluster-detail", "overview"), ex("clusters-overview", "Your clusters, with their read counts.", requires="has_clusters")])

add(id="tw_doit_zoom_ok", category="teach_boundary", command="zoom out a bit",
    phrasings=["zoom out", "show a wider view"],
    **ctx_kw(V_DM6_2R),
    thinking="Zooming is navigation, which Copilot may do.",
    summary="Zoom out",
    actions=[zoom("out", 2), ex("zoom-out", "Zoomed out. These buttons (or - on the keyboard) zoom any time.")])

OFF_TOPIC = [
    ("weather", "what's the weather like?", ["tell me a joke", "what time is it"]),
    ("python", "write me a python script to parse my bam", ["write code for me", "help me with pandas"]),
    ("paper", "summarize this paper for me", ["write my methods section", "draft an abstract"]),
    ("email", "write an email to my PI", ["help me with an email"]),
    ("biology_general", "explain CRISPR to me", ["how does PCR work", "what is RNA splicing"]),
]

for rid, command, phrasings in OFF_TOPIC:
    add(id=f"tw_offtopic_{rid}", category="teach_boundary", command=command, phrasings=phrasings,
        **ctx_kw(V_DM6_2R),
        thinking="Off-topic for a browser tutor: a brief redirect to what Copilot can help with.",
        summary="Outside what I can help with",
        actions=[ex("copilot-input", "I'm the browser's guide: I can show you how to load data, navigate, cluster, analyse footprints, design primers and more, or help when something looks wrong. What would you like to do in the browser?")])

add(id="tw_offtopic_fiberseq_concept", category="teach_boundary", command="what is fiber-seq?",
    phrasings=["what is DAF-seq", "what am I looking at in fiber-seq data"],
    **ctx_kw(V_DM6_2R),
    thinking="A concept question tied to the view: a short answer grounded in the reads track and layers.",
    summary="Fiber-seq and DAF-seq in the browser",
    actions=[
        ex("reads-track", "Fiber-seq and DAF-seq mark accessible DNA on single molecules; each row here is one molecule."),
        ex("layer-toggles", "Protected stretches are drawn as footprints: nucleosomes, TF footprints; FIRE/MSP marks accessible patches."),
        ex("strand-chip", "DAF-seq marks one strand per molecule (CT or GA reads); the strand chip picks which to show."),
    ])



# ═════════════════════════════════════════════════════════════════════
# 6. More contexts and states for the core workflows
# ═════════════════════════════════════════════════════════════════════

for key, ctx, ds in _VARIANT_CTX:
    add(id=f"tw_reads_variant_{key}", command="how do I pick out individual reads?",
        phrasings=["select some molecules", "how do I look at a few reads", "shift click reads"],
        **ctx_kw(ctx, ds),
        thinking="Shift+click selects reads (try_it reads_selected); Read Stats is empty until then.",
        summary="Select reads",
        actions=[
            tr("reads-track", "Shift+click a read to select it; Shift+click more to add them.", "reads_selected"),
            ex("read-stats-summary", "Read Stats sums up the selected reads.", requires="has_selected_reads"),
            ex("read-stats-table", "Table lists each selected read: span, footprints, accessibility, MAPQ."),
        ])

    add(id=f"tw_filter_variant_{key}", command="how do I hide reads I don't want?",
        phrasings=["filter the molecules", "show only some reads", "how do filters work"],
        **ctx_kw(ctx, ds),
        thinking="Filter button + filter rules; Clear filter to undo.",
        summary="Filter reads",
        actions=[
            ex("filter-controls-expand", "Click the small Filter label to show the filter controls."),
            ex("filter-rules", "Filter rules opens the Rules panel's Filter tab, where you define what a read must carry."),
            tr("filter-button", "Pick a rule and click Filter.", "filter_applied"),
            ex("clear-filter", "Clear filter shows every read again."),
        ])

    add(id=f"tw_quality_variant_{key}", command="how do I only show confident calls?",
        phrasings=["raise the quality cutoff", "hide uncertain footprints", "filter calls by score"],
        **ctx_kw(ctx, ds),
        thinking="Quality group: expand, then the per-layer cutoffs.",
        summary="Show only confident calls",
        actions=[
            ex("quality-controls-expand", "Click the small Quality label to show the cutoffs."),
            ex("quality-cutoffs", "Set a minimum call quality per layer; calls below it are hidden."),
            ex("labeling-quality", "Labeling > Quality shades calls by quality instead of hiding them."),
        ])

    add(id=f"tw_export_variant_{key}", command="how do I make a figure of this?",
        phrasings=["export this view", "get a publication figure", "save a figure"],
        **ctx_kw(ctx, ds),
        thinking="Export in the top bar; Layout and sub-track settings to arrange first.",
        summary="Make a figure",
        actions=[
            ex("layout-menu", "Arrange the panels with Layout first if you like."),
            ex("panel-subtracks", "Sub-track settings hide tracks you don't want in the figure."),
            ex("export-figure", "Export saves a PNG, SVG or PDF of the view."),
        ])

    add(id=f"tw_genome_variant_{key}", command="how do I switch to a different genome?",
        phrasings=["change the reference", "use another assembly", "wrong genome, how do I change it"],
        **ctx_kw(ctx, ds),
        thinking="Reference & Tracks, then the Genome list (try_it genome_loaded), or own FASTA + GTF.",
        summary="Switch genome",
        actions=GENOME_STEPS)

for key, ctx, gene in (("sna", V_DM6_2L, "sna"), ("myc", V_HG38_MYC, "MYC"), ("hb", V_DM6_HB, "hb")):
    add(id=f"tw_primers_variant_{key}", command=f"how do I design primers near {gene}?",
        phrasings=[f"primers for {gene}", f"PCR primers at {gene}"],
        **ctx_kw(ctx),
        thinking="Primer walk; Copilot can navigate there first.",
        summary=f"Primers near {gene}",
        actions=[nav(gene, 3000), op("primer-design", "design")] + PRIMER_STEPS)

# ── State-specific variants ─────────────────────────────────────────
add(id="tw_cluster_with_filter", command="how do I cluster only the reads I filtered?",
    phrasings=["cluster the filtered reads", "does clustering use my filter"],
    **ctx_kw(V_DM6_2R, filtered={0: 60}),
    thinking="State details: a filter shows 60 reads. Clustering uses the reads each panel shows, so the filter carries over.",
    summary="Cluster the filtered reads",
    actions=[
        ex("filter-button", "Your filter is active: 60 reads are shown, and clustering uses the reads each panel shows."),
    ] + peaks_first() + [
        tr("cluster-button", "Click Cluster.", "clustered"),
        ex("clear-filter", "Clear the filter later to see every read again."),
    ])

add(id="tw_cluster_three_datasets", command="how do I cluster all three samples?",
    phrasings=["cluster every dataset", "cluster across samples", "cluster all panels"],
    **ctx_kw(V_DM6_X, DS_THREE),
    thinking="Three datasets: Cluster works on every panel, or only the selected ones.",
    summary="Cluster all samples",
    actions=CLUSTER_CONTROLS[1:3] + peaks_first() + [
        ex("reads-track", "Cluster works on every dataset panel, or only on the panels you selected (click a panel header to select it)."),
        tr("cluster-button", "Click Cluster.", "clustered"),
        ex("clusters-overview", "The Clusters panel shows each panel's clusters.", requires="has_clusters"),
    ])

add(id="tw_cluster_hidden_clusters", command="how do I bring back hidden clusters?",
    phrasings=["I hid a cluster, how do I show it", "unhide a cluster", "where did my cluster go"],
    **ctx_kw(V_DM6_2R, clustered=(0,), focus={0: [2]}),
    thinking="State details: focus on cluster 2. Unhide all restores the rest.",
    summary="Show hidden clusters",
    actions=[
        ex("cluster-focus-bar", "Only cluster 2 is shown; Unhide all brings back every cluster.", requires="has_clusters"),
        tr("cluster-focus-bar", "Click Unhide all.", "cluster_focused"),
    ])

add(id="tw_peaks_have_many", command="how do I choose which peak to use?",
    phrasings=["there are lots of peaks, which one", "pick the right peak", "which peak should I select"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY),
    thinking="Zoom in to the element of interest, then click its peak; Cmd/Ctrl+click for more.",
    summary="Choosing a peak",
    actions=[
        ex("peaks-track", "Taller peaks are open on more molecules; pick the one at your element of interest."),
        ex("zoom-in", "Zoom in around it to see the reads there."),
        tr("peaks-track", "Click the peak to select it.", "peak_selected"),
    ])

add(id="tw_footprint_selected_already", command="I selected a footprint, how do I keep it?",
    phrasings=["save the footprint I picked", "keep this selection"],
    **ctx_kw(V_DM6_2R),
    thinking="A footprint is selected: the Save step (try_it footprint_saved) is next.",
    summary="Save the selected footprint",
    actions=[
        ex("selected-footprint", "Your footprint's size range and position are shown here.", requires="has_selected_footprint"),
        tr("save-footprint", "Adjust the size range if needed and click Save.", "footprint_saved"),
        ex("footprints-saved", "It's now in the Saved tab and coloured on the reads.", requires="has_saved_footprints"),
    ])

add(id="tw_copy_three_way", command="how do I look at three regions?",
    phrasings=["three loci at once", "more than two panels"],
    **ctx_kw(V_DM6_2R, DS_FIBER_ONLY, copy_view={"chrom": "3R", "start": 11_998_000, "end": 12_008_000}),
    thinking="One copy exists; add another copy the same way and move it.",
    summary="A third region",
    actions=[
        tr("panel-add-copy", "Click + on a panel header to add another copy.", "panel_copy_made"),
        ex("panel-link", "Unlink the new copy.", requires="has_panel_copy"),
        tr("panel-location-bar", "Type the third region into its location box.", "navigated"),
        ex("layout-menu", "Layout arranges the three panels."),
    ])

add(id="tw_session_link", command="how do I share my view with a colleague?",
    phrasings=["send someone this view", "copy a link to the session", "share the session"],
    **ctx_kw(V_DM6_2R),
    thinking="Session section: save, export or copy a link.",
    summary="Share the view",
    actions=[
        ex("session-settings", "The Session section saves, exports or copies a link to the session."),
        tr("save-session", "Or click Save and send them the session file.", "session_saved"),
    ])

add(id="tw_load_bam_index", command="do I need an index for my bam?",
    phrasings=["my bam has no bai", "bam index"],
    **ctx_kw(V_EMPTY, DS_NONE, D_EMPTY),
    thinking="A local BAM without an index is indexed on load; point at Load File.",
    summary="BAM indexes",
    actions=[
        ex("load-dataset", "Load File opens the BAM; a local BAM without a .bai index is indexed for you."),
        tr("load-dataset", "Click Load File and pick your BAM.", "dataset_loaded"),
    ])

add(id="tw_coacc_walk", command="how do I look at co-accessibility?",
    phrasings=["how do I use co-accessibility", "which positions open together", "coaccessibility matrix"],
    **ctx_kw(V_DM6_2R),
    thinking="Open the panel and walk the matrix and refresh.",
    summary="Co-accessibility",
    actions=[
        op("co-accessibility"),
        ex("coacc-matrix", "For each pair of positions in view: how often both are open on the same molecule."),
        ex("coacc-refresh", "Refresh recomputes it for the current view after you move."),
        ex("zoom-in", "It works best over a few kb; zoom in around the elements you're comparing."),
    ])

add(id="tw_transcription_walk", command="how do I look at Pol II states?",
    phrasings=["paused polymerase analysis", "transcription state", "how many reads are elongating"],
    **ctx_kw(V_DM6_2R),
    thinking="The Transcription panel needs a selected gene: requires has_selected_gene, then Distribution and Filters.",
    summary="Pol II states",
    actions=[
        ex("search-bar", "Search for your gene, then click it on the gene track to select it."),
        op("transcription-state", "distribution"),
        ex("transcription-distribution", "Distribution shows the share of reads in each Pol II state (PIC, paused, elongating).",
           requires="has_selected_gene"),
        ex("transcription-filters", "Filters keeps only reads in a chosen state."),
    ])

add(id="tw_capture_walk", command="how do I design capture probes?",
    phrasings=["capture regions", "make probes for these regions", "export capture bed"],
    **ctx_kw(V_DM6_2R),
    thinking="Capture panel: add regions, export BED/FASTA/probes.",
    summary="Capture regions and probes",
    actions=[
        op("capture"),
        ex("capture-add-region", "Add the current view or selection as a capture region; repeat for each."),
        ex("capture-export", "The Export tab writes them as BED, FASTA or probes."),
    ])

add(id="tw_contacts_walk", command="how do I look at a contact map?",
    phrasings=["micro-c", "daf-c map", "open a contact matrix"],
    **ctx_kw(V_DM6_2R),
    thinking="Contacts panel: load the map file with Load File, then the Map tab.",
    summary="Contact maps",
    actions=[
        ex("load-dataset", "Load the contact map file (.mcool) with Load File."),
        op("contact-map", "map"),
        ex("contacts-map", "The Map tab shows the Micro-C / DAF-C contacts for the view."),
        ex("haplotype-compare", "Compare puts two haplotypes or loci side by side."),
    ])

add(id="tw_annotations_walk", command="how do I filter reads by annotation?",
    phrasings=["per-read annotations", "filter by read annotation type"],
    **ctx_kw(V_DM6_2R),
    thinking="Annotations panel: Files, then Filter.",
    summary="Filter by per-read annotations",
    actions=[
        op("annotations", "files"),
        ex("annotations-files", "Per-read annotation files and their types are listed here."),
        ex("annotations-filter", "The Filter tab keeps reads carrying the annotation types you choose."),
    ])



# ═════════════════════════════════════════════════════════════════════
# 7. More chains, follow-ups and quick answers
# ═════════════════════════════════════════════════════════════════════

add(id="tw_chain_peak_label_sort", category="teach_chain",
    command="how do I colour TF footprints at my peak and sort reads by them?",
    phrasings=["highlight footprints at the peak then sort", "colour and sort by TF binding at a peak"],
    **ctx_kw(V_DM6_2R),
    thinking="Chain: select peak → labeling rule (TF at the peak) → sort rule by TF count → Sort.",
    summary="Colour and sort by TF footprints at a peak",
    actions=[
        tr("scan-peaks-button", "Click Scan.", "peaks_scanned", skip_if="has_peaks"),
        tr("peaks-track", "Select your peak.", "peak_selected", skip_if="has_selected_peak"),
        op("colormap", "rules"),
        ex("add-label-rule", "Add a labeling rule: TF-footprint layer, region = the selected peak, a bright colour."),
        ex("labeling-rules", "Rules apply top to bottom; the first match colours a footprint."),
        ex("sort-rules", "Next, Sort rules opens the Rules panel's Sort tab."),
        ex("add-sort-rule", "Add a sort rule counting TF footprints at the selected peaks."),
        tr("sort-button", "Pick it and click Sort.", "sorted"),
        ex("reads-track", "Reads with TF footprints at the peak are now on top, in your colour."),
    ])

add(id="tw_chain_track_then_label", category="teach_chain",
    command="how do I add a chip track and colour footprints that overlap it?",
    phrasings=["colour footprints under chip peaks", "label footprints overlapping a track"],
    **ctx_kw(V_HG38_MYC),
    thinking="Chain: add the track (try_it track_added) → labeling rule with a track-overlap condition.",
    summary="Colour footprints that overlap a track",
    actions=[
        op("track-browser"),
        ex("tracks-browse-hubs", "Browse hubs finds ChIP tracks for hg38 (ENCODE, ChIP-Atlas)."),
        tr("tracks-add-file", "Add the track you want.", "track_added"),
        op("colormap", "rules"),
        ex("add-label-rule", "Add a labeling rule with the condition 'overlaps track' and pick your new track."),
        ex("labeling-rules", "Footprints overlapping the track now take that colour."),
    ])

add(id="tw_chain_select_reads_stats_cluster", category="teach_chain",
    command="how do I compare the reads in one cluster?",
    phrasings=["stats for one cluster's reads", "look at the molecules in a cluster"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Chain: focus a cluster → Shift+click its reads → Read Stats.",
    summary="Statistics for one cluster's reads",
    actions=[
        ex("clusters-overview", "Click the cluster in Overview to focus it.", requires="has_clusters"),
        tr("clusters-overview", "Focus the cluster you care about.", "cluster_focused"),
        tr("reads-track", "Shift+click reads from it to select them.", "reads_selected"),
        ex("read-stats-summary", "Read Stats sums up those reads.", requires="has_selected_reads"),
        ex("read-stats-table", "Table compares them read by read."),
        ex("cluster-focus-bar", "Unhide all shows the other clusters again."),
    ])

add(id="tw_chain_quality_then_cluster", category="teach_chain",
    command="how do I cluster using only high-quality calls?",
    phrasings=["cluster after filtering by quality", "quality filter then cluster"],
    **ctx_kw(V_DM6_2R),
    thinking="Chain: quality cutoffs → peaks → cluster; clustering sees the filtered calls.",
    summary="Cluster on high-quality calls",
    actions=[
        ex("quality-controls-expand", "Click the small Quality label."),
        ex("quality-cutoffs", "Set the minimum call quality for the layers you cluster on."),
    ] + peaks_first() + [
        tr("cluster-button", "Click Cluster; calls below the cutoff don't count.", "clustered"),
        ex("clusters-profiles", "Compare the cluster profiles.", requires="has_clusters"),
    ])

add(id="tw_chain_save_restore", category="teach_chain",
    command="how do I save my clusters and get them back tomorrow?",
    phrasings=["keep my clusters for later", "save the analysis and reload it"],
    **ctx_kw(V_DM6_2R, clustered=(0,)),
    thinking="Chain: Snapshot (optional) → Save session (try_it) → Restore session later.",
    summary="Save clusters and restore them later",
    actions=[
        ex("cluster-snapshot", "Snapshot keeps this clustering inside the session's Saved tab.", requires="has_clusters"),
        tr("save-session", "Click Save to download the session.", "session_saved"),
        ex("restore-session", "Tomorrow: Restore session with that file brings back the data, view and clusters."),
        ex("clusters-saved", "Snapshotted clusterings are in the Saved tab."),
    ])

T_RULES = turn("how do rules work?", "How rules work", ["explain", "explain", "explain", "try_it", "explain", "try_it"])
T_PRIMERS = turn("how do I design primers?", "Design primers", ["open_panel", "try_it", "explain", "try_it", "explain"])
T_SAVE = turn("how do I save my session?", "Save the session", ["try_it", "explain", "explain"])
T_TRACKS = turn("how do I add a track?", "Add tracks", ["explain", "open_panel", "explain", "try_it", "explain"])
T_SELECT = turn("how do I select reads?", "Select reads", ["explain", "try_it", "explain", "explain"])

MORE_FOLLOWUPS = [
    ("rules_next", "ok the filter is on, what next?", ["filter applied, now what"],
     V_DM6_2R, dict(filtered={0: 44}), [T_RULES],
     "A filter is active (State details: 44 reads). Next: cluster or sort the filtered reads, or clear it.",
     "After filtering",
     [ex("cluster-button", "Cluster now clusters only the 44 filtered reads."),
      ex("sort-button", "Sort orders them."),
      ex("clear-filter", "Clear filter brings back every read.")]),
    ("primers_next", "I have primers, now what?", ["primers designed, what next", "how do I order them"],
     V_DM6_2R, {}, [T_PRIMERS],
     "Primers designed: add to the order list and export.",
     "After designing primers",
     [op("primer-design", "order"),
      ex("primers-order-tab", "Add the pairs you want to the Order List, then export the order sheet (IDT, Twist, ...).")]),
    ("save_where", "where did it save?", ["where is the session file", "I can't find the saved file"],
     V_DM6_2R, {}, [T_SAVE],
     "Save downloads the file through the browser: the downloads folder.",
     "Where the session file went",
     [ex("save-session", "Save downloads the session file through your web browser, usually into your Downloads folder."),
      ex("restore-session", "Open it again with Restore session or Load File.")]),
    ("track_not_showing", "I added the track but I don't see it", ["where is my new track", "track didn't appear"],
     V_HG38_MYC, {}, [T_TRACKS],
     "Tracks show under the reads; sub-track settings may hide them, and they draw in the current region only.",
     "Finding the new track",
     [ex("panel-subtracks", "New tracks appear under the reads; check Sub-track settings that it isn't hidden."),
      ex("zoom-out", "A track with no data here stays empty; zoom out or move to where it has signal.")]),
    ("selected_now_what", "I selected some reads, what can I do with them?", ["reads selected, now what"],
     V_DM6_2R, {}, [T_SELECT],
     "Selected reads: Read Stats, footprints on them, or keep them via a filter.",
     "Using selected reads",
     [ex("read-stats-summary", "Read Stats summarises them.", requires="has_selected_reads"),
      ex("read-stats-table", "Table compares them one by one."),
      ex("reads-track", "Cmd/Ctrl+click a footprint on one of them to analyse that footprint.")]),
    ("cluster_again_k", "can I try a bigger k?", ["more clusters please", "try k of 10"],
     V_DM6_2R, dict(clustered=(0,), k=6), [T_CLUSTER],
     "Clustered with K=6: raise K and click Cluster again.",
     "Recluster with a bigger K",
     [ex("cluster-controls-expand", "Click the small Cluster label."),
      ex("cluster-k", "Raise K (up to 20)."),
      tr("cluster-button", "Click Cluster again.", "clustered"),
      ex("merge-similar", "Merge similar clusters afterwards folds any near-duplicates.")]),
    ("load_second_next", "the second file is loaded, how do I compare them?", ["compare my two samples now"],
     V_DM6_2R, dict(), [T_LOAD],
     "Two datasets: cluster both together, or arrange them side by side.",
     "Comparing two samples",
     [ex("layout-menu", "Layout puts the two panels side by side or stacked."),
      ex("cluster-button", "Clustering with both in view clusters both samples together, so you can compare cluster proportions."),
      ex("layout-merge", "Merge datasets combines them into one panel if they're replicates.")]),
    ("undo_filter", "undo that", ["take the filter off", "go back"],
     V_DM6_2R, dict(filtered={0: 12}), [T_FILTER],
     "Previous turn applied a filter: Clear filter, or Undo.",
     "Undo the filter",
     [tr("clear-filter", "Click Clear filter (or press Cmd/Ctrl+Z).", "filter_cleared")]),
    ("strand_cluster_next", "now how do I cluster each strand?", ["cluster them now", "cluster the split panels"],
     V_DM6_2R, dict(strands=True), [T_STRAND],
     "Split exists: peaks then Cluster; each strand panel clusters its own reads.",
     "Cluster each strand",
     peaks_first() + [tr("cluster-button", "Click Cluster; each strand panel is clustered on its own reads.", "clustered")]),
    ("thanks", "thanks!", ["great, thank you", "perfect"],
     V_DM6_2R, {}, [T_CLUSTER],
     "Acknowledge and mention what else is possible.",
     "You're welcome",
     [ex("copilot-input", "Glad to help. Ask me how to do anything else, or why something looks off.")]),
]

for rid, command, phrasings, ctx, state, prev, thinking, summary, steps in MORE_FOLLOWUPS:
    add(id=f"tw_followup_{rid}", category="teach_followup", command=command, phrasings=phrasings,
        **ctx_kw(ctx, **state), previous_turns=prev, thinking=thinking, summary=summary, actions=steps)

MORE_WHERE = [
    ("reads_display", "where are the read display settings?", ["read colours and separators", "display settings"],
     [ex("read-display-settings", "Read Display sets row height, separators, colours and display limits.")]),
    ("navigation", "how do I change the gene padding?", ["more space around genes", "navigation settings"],
     [ex("navigation-settings", "Navigation sets the padding around genes and autozoom.")]),
    ("peak_defaults", "where are the peak detection defaults?", ["default peak settings"],
     [ex("peak-detection-settings", "Peak Detection in Analysis & Reproducibility sets the defaults for Scan.")]),
    ("fasta", "where do I load a fasta?", ["load reference sequence", "add a reference fasta"],
     [ex("load-fasta", "Load Reference FASTA in Reference & Tracks > Reference Files.")]),
    ("gtf", "where do I load a gtf?", ["load gene models", "add annotation"],
     [ex("load-gtf", "Load gene annotation in Reference & Tracks > Reference Files.")]),
    ("genome_list", "where is the genome list?", ["bundled genomes", "list of genomes"],
     [ex("genome-selector", "The Genome list in Reference & Tracks: dm6, hg38, mm10 and more, each with its annotation.")]),
    ("chrom", "how do I go to another chromosome?", ["switch chromosome", "chromosome list"],
     [ex("chrom-selector", "Pick any chromosome of the reference here.")]),
    ("clear_peaks", "how do I deselect peaks?", ["clear my peak selection", "unselect peaks"],
     [ex("peaks-controls-expand", "Click the small Peaks label."),
      ex("peak-clear-selection", "Clear peak selection deselects them all.")]),
    ("clear_clusters", "how do I remove the clustering?", ["delete clusters", "clear clusters"],
     [ex("cluster-controls-expand", "Click the small Cluster label."),
      ex("cluster-clear", "Clear clusters removes the current clustering.", requires="has_clusters")]),
    ("cluster_details", "how do I open cluster details?", ["cluster details button"],
     [ex("cluster-controls-expand", "Click the small Cluster label."),
      ex("cluster-details-button", "Cluster details opens the Clusters panel.", requires="has_clusters")]),
    ("sort_where", "where is the sort button?", ["sort reads button"],
     [ex("sort-button", "Sort orders reads (and clusters) by the chosen sort rule.")]),
    ("filter_where", "where is the filter button?", ["filter reads button"],
     [ex("filter-button", "Filter hides reads that fail the chosen filter rule.")]),
]

for rid, command, phrasings, steps in MORE_WHERE:
    clustered = (0,) if any(st.get("requires") == "has_clusters" for st in steps) else ()
    add(id=f"tw_where_{rid}", category="teach_where", command=command, phrasings=phrasings,
        **ctx_kw(V_DM6_2R, clustered=clustered), thinking="Short anchored answer.",
        summary=command.rstrip("?").capitalize(), actions=steps)

MORE_DOIT = [
    ("sort", "sort the reads by accessibility", ["sort them", "order the reads"],
     "Sorting is your click; here's the rule and the button.",
     [ex("sort-rules", "Pick or make a sort rule in the Rules panel's Sort tab."),
      tr("sort-button", "Click Sort.", "sorted")]),
    ("track", "add the ENCODE CTCF track", ["add a ctcf track", "load chip-seq for me"],
     "Adding a track is your click; here's where.",
     [op("track-browser"), ex("tracks-browse-hubs", "Browse hubs and search for CTCF."),
      tr("tracks-add-file", "Add the track you pick.", "track_added")]),
    ("copy", "open a second panel at hb", ["put hb in another panel"],
     "Making the copy is your click; I'll walk you through it.",
     [tr("panel-add-copy", "Click + on the panel header.", "panel_copy_made"),
      ex("panel-link", "Unlink the copy.", requires="has_panel_copy"),
      tr("panel-location-bar", "Type hb into its location box.", "navigated")]),
    ("footprint", "save that footprint", ["save this footprint for me"],
     "Saving is your click, right here.",
     [tr("save-footprint", "Click Save in the Footprints panel.", "footprint_saved", requires="has_selected_footprint")]),
]

for rid, command, phrasings, intro, steps in MORE_DOIT:
    add(id=f"tw_doit_{rid}", category="teach_boundary", command=command, phrasings=phrasings,
        **ctx_kw(V_HG38_MYC if rid == "track" else V_DM6_2R),
        thinking="Copilot teaches: point at the control and hand the user the click.",
        summary=f"You run it; here's how ({rid})", actions=[ex(None, intro)] + steps)



# ── Extra paraphrases (every record gets at least three) ────────────
_EXTRA_PHRASINGS: dict[str, list[str]] = {
    "tw_cluster_no_data": ["I want to cluster but nothing is loaded", "how do I start clustering"],
    "tw_merge_no_clusters": ["how do I merge clusters when I haven't clustered yet"],
    "tw_strand_already_split": ["show CT and GA separately"],
    "tw_haplotype_have_copy": ["how do I use the second haplotype panel"],
    "tw_copy_hg38": ["MYC and SOX2 side by side please"],
    "tw_primers_no_reference": ["how do I make primers"],
    "tw_chain_saved_fp_have_saved": ["check my saved footprints at another gene"],
    "tw_where_search": ["how do I search"],
    "tw_where_scan": ["where is peak scanning"],
    "tw_where_cluster_btn": ["which button clusters"],
    "tw_where_redo": ["where is redo"],
    "tw_where_save": ["where do I save my work"],
    "tw_where_export": ["where do I export images"],
    "tw_where_relative": ["show coordinates from the TSS"],
    "tw_where_footprints_panel": ["where do footprint results show up"],
    "tw_where_rules_panel": ["where are cluster rules"],
    "tw_where_labeling_panel": ["where are the colour rules"],
    "tw_where_tracks_panel": ["where do I browse tracks"],
    "tw_where_primers_panel": ["where do I make primers"],
    "tw_where_coacc_panel": ["where is the co-accessibility matrix"],
    "tw_where_regions_panel": ["where are my saved regions"],
    "tw_where_capture_panel": ["where do I make capture regions"],
    "tw_where_contacts_panel": ["where do I see contacts"],
    "tw_where_transcription_panel": ["where is the Pol II panel"],
    "tw_where_history_panel": ["where do I see what I did"],
    "tw_where_annotations_panel": ["where do I filter by annotation"],
    "tw_where_loaded": ["show my loaded files"],
    "tw_what_merge_similar": ["what happens when I merge similar clusters"],
    "tw_what_go_to_reads": ["what does the go to reads button do"],
    "tw_what_peaks_track": ["what does a peak mean"],
    "tw_what_coacc": ["how do I read the co-accessibility matrix"],
    "tw_what_vplot": ["how do I read a v-plot"],
    "tw_what_projection": ["what does the projection plot mean"],
    "tw_what_composition": ["what is the composition tab", "what's in cluster composition"],
    "tw_what_dynamic": ["what does dynamic mean in the clusters panel"],
    "tw_what_unhide": ["I only see one cluster now"],
    "tw_what_cooc": ["what does co-occupancy tell me"],
    "tw_what_strand": ["what does CT mean"],
    "tw_what_quality": ["what is tq"],
    "tw_what_labeling_quality": ["shade calls by quality", "what does the quality tab in labeling do"],
    "tw_what_peak_detection": ["how does peak detection work"],
    "tw_what_find_classes": ["what are footprint families"],
    "tw_what_regions": ["what are regions"],
    "tw_what_merge_datasets": ["merge replicates into one panel"],
    "tw_what_link_datasets": ["link two datasets"],
    "tw_where_hg38_search": ["how do I look up a gene", "search for SOX2", "find a gene by name"],
    "tw_where_mm10_layers": ["hide nucleosomes", "turn off a layer", "how do I show only TF footprints"],
    "tw_where_empty_load": ["how do I open a file", "where is load", "load data where"],
    "tw_where_x_scan": ["how do I scan for peaks", "find peaks button", "where do I scan"],
    "tw_where_3r_undo": ["undo", "go back one step", "I didn't mean that"],
    "tw_followup_after_peaks": ["what's a peak selection for"],
    "tw_followup_after_genome": ["ok hg38 is loaded"],
    "tw_followup_after_split": ["which side is CT"],
    "tw_followup_after_filter_what": ["only a few reads left, why"],
    "tw_followup_after_copy": ["delete the copy"],
    "tw_followup_more_detail_cluster": ["what's the difference between the methods again"],
    "tw_followup_skip_ahead": ["I already have peaks selected"],
    "tw_doit_scan": ["can you scan"],
    "tw_doit_load": ["please load my data"],
    "tw_doit_merge": ["just merge"],
    "tw_doit_export": ["export for me"],
    "tw_doit_primers": ["do the primer design"],
    "tw_doit_filter": ["apply a filter for me"],
    "tw_doit_split": ["do the strand split"],
    "tw_doit_save": ["save for me"],
    "tw_doit_genome": ["load the human genome"],
    "tw_doit_open_panel_ok": ["go to the clusters panel"],
    "tw_doit_zoom_ok": ["zoom out please"],
    "tw_offtopic_weather": ["how's your day"],
    "tw_offtopic_python": ["debug my R script"],
    "tw_offtopic_paper": ["write a grant for me"],
    "tw_offtopic_email": ["draft a message to my collaborator", "write a cover letter"],
    "tw_offtopic_biology_general": ["what is chromatin remodeling"],
    "tw_offtopic_fiberseq_concept": ["what do the colours on the reads mean"],
    "tw_primers_variant_sna": ["design primers at sna"],
    "tw_primers_variant_myc": ["design primers at MYC"],
    "tw_primers_variant_hb": ["design primers at hb"],
    "tw_cluster_with_filter": ["cluster just the reads I'm showing"],
    "tw_footprint_selected_already": ["how do I save the footprint I clicked"],
    "tw_copy_three_way": ["add a third panel"],
    "tw_load_bam_index": ["do I need to index my bam first"],
    "tw_annotations_walk": ["show only reads with an annotation"],
    "tw_chain_peak_label_sort": ["colour the peak's TF footprints and sort by them"],
    "tw_chain_track_then_label": ["label footprints under a ChIP track"],
    "tw_chain_select_reads_stats_cluster": ["read stats for a single cluster"],
    "tw_chain_quality_then_cluster": ["cluster on confident calls only"],
    "tw_chain_save_restore": ["save the clustering for tomorrow"],
    "tw_followup_rules_next": ["what do I do with the filtered reads", "now that it's filtered, what next"],
    "tw_followup_primers_next": ["how do I get the order sheet"],
    "tw_followup_save_where": ["where's my saved session"],
    "tw_followup_track_not_showing": ["the track is blank"],
    "tw_followup_selected_now_what": ["what now with these reads", "I shift-clicked some reads"],
    "tw_followup_cluster_again_k": ["let's do more clusters"],
    "tw_followup_load_second_next": ["how do I compare the two datasets", "both files are in, now what"],
    "tw_followup_undo_filter": ["remove that filter"],
    "tw_followup_strand_cluster_next": ["cluster CT and GA now"],
    "tw_followup_thanks": ["awesome thanks"],
    "tw_where_reads_display": ["change read colours"],
    "tw_where_navigation": ["change navigation settings"],
    "tw_where_peak_defaults": ["change default peak detection", "peak scan defaults"],
    "tw_where_fasta": ["where is the reference fasta loader"],
    "tw_where_gtf": ["where do I add genes"],
    "tw_where_genome_list": ["which genomes are available"],
    "tw_where_chrom": ["jump to chromosome 3R"],
    "tw_where_clear_peaks": ["remove the peak selection"],
    "tw_where_clear_clusters": ["get rid of the clusters"],
    "tw_where_cluster_details": ["open the clusters panel from the toolbar", "cluster details"],
    "tw_where_sort_where": ["how do I sort", "sort button"],
    "tw_where_filter_where": ["how do I filter", "filter button"],
    "tw_doit_sort": ["sort for me"],
    "tw_doit_track": ["add ctcf"],
    "tw_doit_copy": ["show hb in a second panel", "make a copy at hb"],
    "tw_doit_footprint": ["keep this footprint", "save it as a footprint"],
}

for _record in RECORDS:
    for _p in _EXTRA_PHRASINGS.get(_record["id"], []):
        if _p not in _record["phrasings"] and _p != _record["command"]:
            _record["phrasings"].append(_p)


def category_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in RECORDS:
        counts[record["category"]] = counts.get(record["category"], 0) + 1
    return counts
