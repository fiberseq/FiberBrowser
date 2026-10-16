"""Teach-only troubleshooting records: "why are no reads visible?" and other "I'm stuck" questions.

The browser sends the planner concrete diagnostics (utils/copilotDiagnostics.ts),
each with a fix anchor, and a compact raw state. The user message renders them as
a "Diagnostics:" block, plus a "State details:" block when nothing is blocking or
a warning. These records teach the model to read that block, explain the most
blocking cause in one plain sentence, and point at the control that fixes it:

- it navigates or opens panels itself where that's allowed (zooming in to the
  read window, the next covered window, a sidebar section);
- it asks the user to click anything that runs something (clear a filter, load a
  file, focus a cluster) with a try_it step that waits for the result;
- with no blocking diagnostic it reasons from the state details, and says so
  plainly when the state looks fine instead of inventing a problem.

Diagnostic messages mirror the frontend's wording, with dataset labels in double
quotes; fix anchors are the ones the frontend uses.
"""
from __future__ import annotations


# Mock datasets (mock_state.make_mock_state): ids and labels, in load order.
L1, L2, L3 = "Embryo 2-4hr", "Embryo 2.5-3hr DAF", "Embryo 5-8hr"
D1, D2, D3 = "ds_emb_2_4hr", "ds_emb_2_5_3hr", "ds_emb_5_8hr"
_ID = {L1: D1, L2: D2, L3: D3}

V_WIDE_2R = {"chrom": "2R", "start": 9_500_000, "end": 10_500_000, "currentGenome": "dm6"}   # 1.0 Mb
V_WIDE_3R = {"chrom": "3R", "start": 12_000_000, "end": 12_400_000, "currentGenome": "dm6"}  # 400 kb
V_WIDE_MYC = {"chrom": "chr8", "start": 127_000_000, "end": 128_500_000, "currentGenome": "hg38"}  # 1.5 Mb
V_CHR4 = {"chrom": "4", "start": 500_000, "end": 510_000, "currentGenome": "dm6"}
V_Y = {"chrom": "Y", "start": 1_000_000, "end": 1_010_000, "currentGenome": "dm6"}
V_GENOME_ONLY = {"chrom": "2L", "start": 1_000_000, "end": 1_010_000, "currentGenome": "dm6"}


# ─────────────────────────────────────────────────────────────────────
# Diagnostics, worded as utils/copilotDiagnostics.ts words them
# ─────────────────────────────────────────────────────────────────────

def _d(code: str, severity: str, message: str, fix: str | None = None, label: str | None = None) -> dict:
    out = {"code": code, "severity": severity, "message": message}
    if fix:
        out["fix_anchor"] = fix
    if label:
        out["dataset_id"] = _ID[label]
    return out


def no_datasets():
    return _d("no_datasets", "blocking", "No dataset is loaded, so there are no reads to show.", "load-dataset")


def no_reference(nothing: bool = True):
    if nothing:
        return _d("no_reference", "blocking",
                  "No genome or reference is loaded, so there are no chromosomes to browse.", "genome-selector")
    return _d("no_reference", "info",
              "No reference genome/FASTA is loaded; sequence, primers and motif scans need one.", "genome-selector")


def no_gtf():
    return _d("no_gtf", "info", "No gene annotation (GTF) is loaded, so genes can't be searched or drawn.", "load-gtf")


def layers_hidden(tf_off: bool = True):
    if tf_off:
        return _d("layers_hidden", "blocking",
                  "The footprint, nucleosome and TF layers are all switched off, so reads show no footprints.",
                  "layer-toggles")
    return _d("layers_hidden", "warning",
              "The footprint and nucleosome layers are switched off, so reads show only TF calls.", "layer-toggles")


def panel_collapsed(label: str, blocking: bool = True, maximized: bool = False):
    msg = (f'Another panel is maximized, so "{label}" is hidden.' if maximized
           else f'The "{label}" panel is minimized.')
    return _d("panel_collapsed", "blocking" if blocking else "info", msg, "panel-expand", label)


def row_collapsed(label: str, blocking: bool = True):
    return _d("row_collapsed", "blocking" if blocking else "info",
              f'The layout row holding "{label}" is collapsed.', "layout-rows", label)


def at_other_locus(label: str):
    return _d("panel_at_other_locus", "info",
              f'The "{label}" panel shows its own region (a copy), not the main view.', None, label)


def zoomed_out(label: str, width: str, window: str = "100.0 kb"):
    return _d("zoomed_out_past_reads", "blocking",
              f'"{label}" shows {width}; reads are drawn only up to {window}, so it shows coverage instead. '
              "Zoom in or raise the read window.", "read-window-setting", label)


def chrom_missing(label: str, chrom: str):
    return _d("chrom_missing_in_dataset", "blocking",
              f'"{label}" has no reads on {chrom} (its files don\'t contain that chromosome).', "search-bar", label)


def fetch_failed(label: str, warning: str | None = "Could not load reads for this region."):
    msg = f'Reads for "{label}" failed to load' + (f": {warning}" if warning else ".")
    return _d("fetch_failed", "blocking", msg, None, label)


def still_loading(label: str):
    return _d("still_loading", "info", f'Reads for "{label}" are still loading.', None, label)


def filter_none(label: str):
    return _d("filter_matches_none", "blocking",
              f'A read filter on "{label}" matched no reads, so none are shown.', "clear-filter", label)


def filter_active(label: str, shown: int, working: int):
    return _d("filter_active", "warning",
              f'A read filter on "{label}" shows {shown} of {working} reads.', "clear-filter", label)


def focus_hides(label: str):
    return _d("focus_hides_all", "blocking",
              f'The cluster focus on "{label}" leaves no reads visible.', "cluster-focus-bar", label)


def branch_empty(label: str):
    return _d("branch_scope_empty", "blocking",
              f'The active cluster branch holds no reads for "{label}".', "cluster-focus-bar", label)


def strand_empty(label: str, strand: str):
    return _d("strand_panel_empty", "blocking",
              f'The {strand}-strand panel of "{label}" has no reads of that strand here.', "strand-chip", label)


def no_reads(label: str):
    return _d("no_reads_in_region", "blocking", f'"{label}" has no reads in this region.', "search-bar", label)


def spanning_none(label: str, overlapping: int):
    return _d("spanning_only_hides", "blocking",
              f'Spanning-only is on and none of the {overlapping} reads in "{label}" span the whole view.',
              "spanning-toggle", label)


def spanning_few(label: str, spanning: int, overlapping: int):
    return _d("spanning_only_hides", "warning",
              f'Spanning-only is on: {spanning} of {overlapping} reads in "{label}" span the whole view.',
              "spanning-toggle", label)


def quality_all(label: str):
    return _d("quality_filter_hides_all", "blocking",
              f'The read quality settings remove every read in "{label}".', "quality-filters", label)


def quality_most(label: str, removed: int, in_scope: int):
    return _d("quality_filter_hides_all", "warning",
              f'The read quality settings remove {removed} of {in_scope} reads in "{label}".',
              "quality-filters", label)


# ─────────────────────────────────────────────────────────────────────
# Raw state, shaped like computeCopilotRawState
# ─────────────────────────────────────────────────────────────────────

def _panel(pid: str, label: str, *, shown=None, working=None, in_scope=None, overlapping=None, spanning=None,
           filt="none", focus=None, clustered=False, strand=None, own_view=None, loading=False, zoomed_out=False,
           hidden=False) -> dict:
    out: dict = {"id": pid, "dataset_id": _ID[label], "hidden": hidden}
    if strand:
        out["strand"] = strand
    if own_view:
        out["own_view"] = own_view
    out["filter"] = filt
    if focus:
        out["focus"] = focus
    out["clustered"] = clustered
    if shown is not None:
        reads = {"shown": shown,
                 "working": working if working is not None else shown,
                 "in_scope": in_scope if in_scope is not None else (working if working is not None else shown),
                 "overlapping": overlapping if overlapping is not None else (in_scope or working or shown),
                 "spanning": spanning if spanning is not None else shown}
        if loading:
            reads["loading"] = True
        if zoomed_out:
            reads["zoomed_out"] = True
        out["reads"] = reads
    return out


def _raw(view: dict, panels: list[dict], *, labels=(L1, L2), genome="dm6", spanning_only=False,
         read_window=100_000, min_footprints=0, min_fp_quality=0, quality_filters=(), layers=None,
         method="kmeans", k=6, branch=None) -> dict:
    types = {L1: "bigbed", L2: "bam", L3: "bigbed"}
    clustering: dict = {"method": method, "k": k}
    if branch is not None:
        clustering["active_branch"] = branch
    return {
        "viewport": {"chrom": view["chrom"], "start": view["start"], "end": view["end"]},
        "genome": genome,
        "reference_loaded": bool(genome),
        "datasets": [{"id": _ID[lab], "label": lab, "type": types[lab]} for lab in labels],
        "panels": panels,
        "settings": {
            "spanning_only": spanning_only,
            "read_window_bp": read_window,
            "min_footprints": min_footprints,
            "min_fp_quality": min_fp_quality,
            "quality_filters": list(quality_filters),
            "layers": layers or {"footprint": True, "nuc": True, "tf": True, "fire": True},
        },
        "clustering": clustering,
    }


def _zoom_to(view: dict, window: int) -> dict:
    """A window of `window` bp centred on the current view."""
    mid = (view["start"] + view["end"]) // 2
    half = window // 2
    return {"type": "navigate_region", "chrom": view["chrom"], "start": mid - half, "end": mid + half}


def _build() -> dict[str, list[dict]]:
    """The records by section. Imports the shared fixtures when called, so this
    module and records.py (which appends these records) can be imported in
    either order."""
    from data.copilot_dataset.records import (
        DS_FIBER_DAF,
        DS_FIBER_ONLY,
        DS_THREE,
        V_DM6_2L,
        V_DM6_2R,
        V_DM6_3R,
        V_DM6_X,
        V_EMPTY,
        V_HG38_MYC,
        V_HG38_TP53,
        _r,
    )

    def _t(**kw):
        kw.setdefault("category", "troubleshoot_diagnostics")
        return _r(**kw)


    # ═════════════════════════════════════════════════════════════════════
    # 1. Diagnostics-driven
    # ═════════════════════════════════════════════════════════════════════

    DIAGNOSTIC_RECORDS: list[dict] = [

        # ── no_datasets ───────────────────────────────────────────────────
        _t(id="ts_no_datasets_reads", command="why are no reads visible?",
           phrasings=["where are the reads", "the browser is empty"],
           context=V_DM6_2R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="Diagnostics: no_datasets is blocking — nothing is loaded, so there is nothing to draw. The fix is loading a dataset; that's the user's click, so a try_it on load-dataset, then mention the path and URL options.",
           summary="No dataset is loaded yet",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "No dataset is loaded yet, so there are no reads to draw."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Click Load File and pick a BAM or BigBed (with its index next to it)."},
               {"type": "explain", "anchor": "load-by-path",
                "text": "If the file is on a server, paste its path here instead."},
           ]),

        _t(id="ts_no_datasets_blank", command="it's blank",
           phrasings=["nothing shows up", "I just see an empty screen"],
           context=V_DM6_3R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="Only no_datasets fires, and it's blocking. Point at Load File and wait for a dataset; once one is loaded the reads draw in the current view.",
           summary="Load a dataset to see reads",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "The view is empty because no dataset is loaded."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Click Load File and choose your fiber-seq or DAF-seq file."},
               {"type": "explain", "anchor": "reads-track", "requires": "has_dataset",
                "text": "Its reads appear here, one molecule per row."},
           ]),

        _t(id="ts_no_datasets_remote", command="the track is empty, my data is on S3",
           phrasings=["nothing loads, the BAM is in a bucket"],
           context=V_HG38_MYC, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="no_datasets is blocking. The user's data is remote, so open the Data & Sessions sidebar and point at Load Remote URL rather than the local file picker.",
           summary="Load the remote dataset by URL",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "No dataset is loaded yet, so the tracks are empty."},
               {"type": "open_sidebar", "section": "file", "subsection": "file.remote"},
               {"type": "try_it", "anchor": "load-remote-url", "wait_for": "dataset_loaded",
                "text": "Paste the s3:// or https:// URL of the BAM or BigBed here and load it."},
           ]),

        _t(id="ts_no_datasets_where_data", command="where did my data go",
           phrasings=["my dataset is gone"],
           context=V_DM6_2L, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="no_datasets: nothing is loaded now — maybe the page was reloaded. Point at Restore session (brings back the last saved state) and Load File.",
           summary="Nothing is loaded; restore the session or load the file again",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "No dataset is loaded right now, so there are no reads."},
               {"type": "explain", "anchor": "restore-session",
                "text": "If you saved a session, Restore session brings your datasets and view back."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Or load the file again with Load File."},
           ]),

        # ── no_reference ──────────────────────────────────────────────────
        _t(id="ts_no_reference_nothing", command="why can't I browse anything?",
           phrasings=["there are no chromosomes", "the chromosome list is empty"],
           context=V_EMPTY, dataset_count=0,
           diagnostics=[no_reference(True), no_datasets()],
           thinking="Two blocking diagnostics: no_reference (no chromosomes at all) and no_datasets. Start with the genome, since it gives the chromosomes, then the data.",
           summary="Pick a genome, then load data",
           actions=[
               {"type": "explain", "anchor": "genome-selector",
                "text": "No genome is loaded, so there are no chromosomes to browse yet."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome from the list (or load your own FASTA below it)."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded", "skip_if": "has_dataset",
                "text": "Then load your reads with Load File."},
           ]),

        _t(id="ts_no_reference_primers", command="why can't I design primers?",
           phrasings=["primer design doesn't work", "the primer button fails"],
           context=V_DM6_2R,
           diagnostics=[no_reference(False)],
           thinking="no_reference is info-level here: reads show, but primers need the reference sequence. Open the reference section and point at the genome list / FASTA loader.",
           summary="Primers need a reference sequence",
           actions=[
               {"type": "explain", "anchor": "genome-selector",
                "text": "No reference sequence is loaded; primer design needs one to read the bases."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome here, or load your FASTA under Reference Files."},
               {"type": "explain", "anchor": "primers-design-button",
                "text": "Then Design primers works on the selected peak or view."},
           ]),

        _t(id="ts_no_reference_sequence", command="why is there no DNA sequence track?",
           phrasings=["where are the bases", "I can't see the sequence"],
           context=V_DM6_2L,
           diagnostics=[no_reference(False)],
           thinking="no_reference (info): without a FASTA the sequence row can't draw. Point at Load Reference FASTA; note the sequence only shows when zoomed in close.",
           summary="Load a reference FASTA for the sequence",
           actions=[
               {"type": "explain", "anchor": "load-fasta",
                "text": "No reference FASTA is loaded, so there are no bases to draw."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome, or load your own FASTA just above."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "The sequence row appears once you zoom in to a couple of kilobases."},
           ]),

        # ── no_gtf ────────────────────────────────────────────────────────
        _t(id="ts_no_gtf_genes", command="why don't I see any genes?",
           phrasings=["the gene track is empty", "no genes are drawn"],
           context=V_DM6_2R,
           diagnostics=[no_gtf()],
           thinking="no_gtf: no annotation is loaded, so genes can't be drawn. Point at the loader in Reference Files; a genome from the list also brings its annotation.",
           summary="Load a gene annotation",
           actions=[
               {"type": "explain", "anchor": "load-gtf",
                "text": "No gene annotation (GTF) is loaded, so there are no genes to draw."},
               {"type": "explain", "anchor": "load-gtf",
                "text": "Load a GTF or GFF3 here; it should match your reference's chromosome names."},
               {"type": "explain", "anchor": "genome-selector",
                "text": "Picking a genome from the list loads its standard annotation too."},
           ]),

        _t(id="ts_no_gtf_search", command="gene search doesn't find eve",
           phrasings=["searching a gene name does nothing", "it can't find my gene"],
           context=V_DM6_2R,
           diagnostics=[no_gtf()],
           thinking="no_gtf explains the failed search: names resolve through the annotation. Load one, then the search box finds genes; coordinates work meanwhile.",
           summary="Gene search needs an annotation",
           actions=[
               {"type": "explain", "anchor": "search-bar",
                "text": "Gene names are looked up in the gene annotation, and none is loaded."},
               {"type": "explain", "anchor": "load-gtf",
                "text": "Load a GTF here (or pick a genome from the list), then search again."},
               {"type": "explain", "anchor": "search-bar",
                "text": "Meanwhile coordinates work, e.g. 2R:9,970,000-9,980,000."},
           ]),

        _t(id="ts_no_gtf_tss", command="why is the TSS-relative option greyed out?",
           phrasings=["relative coordinates don't work"],
           context=V_HG38_MYC,
           diagnostics=[no_gtf()],
           thinking="TSS-relative coordinates need a gene, which needs an annotation — no_gtf fires. Point at the GTF loader, then the relative-coords control.",
           summary="Relative coordinates need genes",
           actions=[
               {"type": "explain", "anchor": "relative-coords",
                "text": "TSS-relative coordinates are measured from a gene, and no gene annotation is loaded."},
               {"type": "explain", "anchor": "load-gtf",
                "text": "Load your annotation here, then pick a gene to measure from."},
           ]),

        # ── layers_hidden ─────────────────────────────────────────────────
        _t(id="ts_layers_all_off", command="the reads are just grey bars",
           phrasings=["I can't see any footprints", "the reads look blank"],
           context=V_DM6_2R,
           diagnostics=[layers_hidden(True)],
           thinking="layers_hidden is blocking: footprint, nucleosome and TF layers are all off, so reads are bare. Point at the Layers controls (the reveal expands them).",
           summary="The footprint layers are switched off",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "The footprint, nucleosome and TF layers are all switched off, so the reads show no footprints."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Tick them back on here; each layer can be shown or hidden on its own."},
           ]),

        _t(id="ts_layers_only_tf", command="where did the nucleosomes go?",
           phrasings=["I only see small footprints", "only TF footprints show"],
           context=V_DM6_3R,
           diagnostics=[layers_hidden(False)],
           thinking="layers_hidden (warning): footprint and nucleosome layers are off, only TF shows. Point at the layer toggles.",
           summary="The nucleosome layer is hidden",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "The footprint and nucleosome layers are off, so only TF calls are drawn."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Turn nucleosomes (and footprints) back on here."},
           ]),

        _t(id="ts_layers_off_nothing", command="nothing shows on the reads",
           phrasings=["why are my reads empty"],
           context=V_HG38_TP53,
           diagnostics=[layers_hidden(True)],
           thinking="Blocking layers_hidden — all footprint-type layers are off. The reads are there; they just have nothing drawn on them.",
           summary="All footprint layers are off",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The reads are loaded, but every footprint layer is switched off, so they look empty."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Switch the footprint, nucleosome and TF layers back on here."},
           ]),

        # ── panel_collapsed ───────────────────────────────────────────────
        _t(id="ts_panel_minimized", command="my panel disappeared",
           phrasings=["where did my dataset go", "the reads panel is gone"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[panel_collapsed(L1, blocking=True)],
           thinking="panel_collapsed is blocking — the only dataset panel is minimized. Point at the minimized chip; expanding it is a click the user makes.",
           summary="The panel is minimized",
           actions=[
               {"type": "explain", "anchor": "panel-expand",
                "text": 'The "Embryo 2-4hr" panel is minimized, not closed.'},
               {"type": "explain", "anchor": "panel-expand",
                "text": "Click its chip to bring the panel back."},
           ]),

        _t(id="ts_panel_minimized_one_of_two", command="I only see one of my datasets",
           phrasings=["the DAF panel is missing"],
           context=V_DM6_2R,
           diagnostics=[panel_collapsed(L2, blocking=False)],
           thinking="panel_collapsed (info) for the DAF dataset only — the other panel shows. It's minimized; point at its chip and at Loaded Datasets as the other place to restore it.",
           summary="The DAF panel is minimized",
           actions=[
               {"type": "explain", "anchor": "panel-expand",
                "text": 'The "Embryo 2.5-3hr DAF" panel is minimized.'},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "Click its chip, or restore it from Loaded Datasets in the sidebar."},
           ]),

        _t(id="ts_panel_maximized", command="the other datasets vanished",
           phrasings=["I can only see one panel now", "where are my other panels"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           diagnostics=[panel_collapsed(L2, blocking=False, maximized=True),
                        panel_collapsed(L3, blocking=False, maximized=True)],
           thinking="Both findings say another panel is maximized, hiding the rest. The fix is the Full view toggle on the maximized panel.",
           summary="One panel is maximized",
           actions=[
               {"type": "explain", "anchor": "panel-full-view",
                "text": "One panel is maximized, which hides the others."},
               {"type": "explain", "anchor": "panel-full-view",
                "text": "Click Full view on that panel again to show all panels."},
           ]),

        _t(id="ts_panel_minimized_empty", command="why is the track area empty?",
           phrasings=["everything is gone from the screen"],
           context=V_DM6_3R, dataset_count=DS_FIBER_DAF,
           diagnostics=[panel_collapsed(L1, True), panel_collapsed(L2, True)],
           thinking="Every dataset panel is minimized (both blocking). Nothing is lost; expand them from their chips.",
           summary="All dataset panels are minimized",
           actions=[
               {"type": "explain", "anchor": "panel-expand",
                "text": "Both dataset panels are minimized, so the track area is empty."},
               {"type": "explain", "anchor": "panel-expand",
                "text": "Click each chip to expand them again."},
           ]),

        # ── row_collapsed ─────────────────────────────────────────────────
        _t(id="ts_row_collapsed", command="half my panels disappeared",
           phrasings=["a row of panels is gone"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           diagnostics=[row_collapsed(L3, blocking=False)],
           thinking="row_collapsed: the row holding one dataset is collapsed. Point at the row bar; clicking it expands the row.",
           summary="A layout row is collapsed",
           actions=[
               {"type": "explain", "anchor": "layout-rows",
                "text": 'The row holding "Embryo 5-8hr" is collapsed.'},
               {"type": "explain", "anchor": "layout-rows",
                "text": "Click its row bar to expand it again."},
           ]),

        _t(id="ts_row_collapsed_all", command="why is nothing showing?",
           phrasings=["the screen is empty but I loaded data"],
           context=V_DM6_2L,
           diagnostics=[row_collapsed(L1, True), row_collapsed(L2, True)],
           thinking="Both panels sit in collapsed rows (blocking). The data is loaded; expand the rows.",
           summary="The panel rows are collapsed",
           actions=[
               {"type": "explain", "anchor": "layout-rows",
                "text": "Your panels are in collapsed rows, so nothing is drawn."},
               {"type": "explain", "anchor": "layout-rows",
                "text": "Click the row bar above each row to open it."},
           ]),

        _t(id="ts_row_collapsed_daf", command="where's the DAF panel",
           phrasings=["I can't find the DAF dataset"],
           context=V_DM6_2R,
           diagnostics=[row_collapsed(L2, blocking=False)],
           thinking="row_collapsed (info) for the DAF dataset. It's in a collapsed row; point at the row bar.",
           summary="The DAF panel's row is collapsed",
           actions=[
               {"type": "explain", "anchor": "layout-rows",
                "text": 'The "Embryo 2.5-3hr DAF" panel is in a collapsed row.'},
               {"type": "explain", "anchor": "layout-rows",
                "text": "Click that row's bar to show it."},
           ]),

        # ── panel_at_other_locus ──────────────────────────────────────────
        _t(id="ts_other_locus_different", command="why does the second panel show different reads?",
           phrasings=["the two panels don't match", "why are the panels showing different things"],
           context=V_DM6_2R,
           diagnostics=[at_other_locus(L2)],
           thinking="panel_at_other_locus: the second panel is an unlinked copy with its own region, so it shows other reads. Point at its location bar and the Link button.",
           summary="That panel is a copy at another region",
           actions=[
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": "That panel is a copy with its own region, shown in its location bar."},
               {"type": "explain", "anchor": "panel-link",
                "text": "Click Link to make it follow the main view again."},
           ]),

        _t(id="ts_other_locus_didnt_move", command="the bottom panel doesn't move when I navigate",
           phrasings=["one panel stays put when I search"],
           context=V_DM6_3R,
           diagnostics=[at_other_locus(L1)],
           thinking="panel_at_other_locus explains it: an unlinked copy keeps its own region. Link it or navigate it from its own location bar.",
           summary="An unlinked copy keeps its own region",
           actions=[
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": "This panel is unlinked, so it keeps its own region; its location bar navigates it."},
               {"type": "explain", "anchor": "panel-link",
                "text": "Click Link and it follows the main view again."},
           ]),

        _t(id="ts_other_locus_empty_copy", command="the copy is empty",
           phrasings=["the new panel has no reads"],
           context=V_DM6_2R,
           diagnostics=[no_reads(L1), at_other_locus(L1)],
           thinking="Blocking no_reads_in_region, and the info says it's a copy at its own region — so the copy points somewhere without reads. Point at its location bar to move it.",
           summary="The copy points at a region with no reads",
           actions=[
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": 'The copy shows its own region, and "Embryo 2-4hr" has no reads there.'},
               {"type": "explain", "anchor": "panel-location-bar",
                "text": "Type a region or gene with coverage into its location bar."},
           ]),

        # ── zoomed_out_past_reads ─────────────────────────────────────────
        _t(id="ts_zoomed_out_basic", command="why are no reads visible?",
           phrasings=["where did the reads go", "I only see a histogram"],
           context=V_WIDE_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "1.0 Mb")],
           thinking="zoomed_out_past_reads is blocking: 1.0 Mb is wider than the 100 kb read window, so coverage is drawn instead. Navigation is mine to do: zoom to a 100 kb window at the centre, then show the read-window setting as the alternative.",
           summary="Zoomed out past the read window",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "You're viewing 1.0 Mb; reads are drawn only up to 100 kb, so you see coverage instead."},
               _zoom_to(V_WIDE_2R, 100_000),
               {"type": "explain", "anchor": "read-window-setting",
                "text": "To draw reads over wider views, raise \"Show reads up to\" here (wider is slower)."},
           ]),

        _t(id="ts_zoomed_out_coverage", command="the track only shows a grey histogram",
           phrasings=["why is it just a coverage plot"],
           context=V_WIDE_3R,
           diagnostics=[zoomed_out(L1, "400.0 kb"), zoomed_out(L2, "400.0 kb")],
           thinking="Both panels report zoomed_out_past_reads (400 kb > 100 kb). One fix covers both: zoom in to the read window. I'll zoom and explain the setting.",
           summary="The view is wider than the read window",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "The view is 400 kb wide, past the 100 kb read window, so both panels show coverage."},
               _zoom_to(V_WIDE_3R, 100_000),
               {"type": "explain", "anchor": "zoom-in",
                "text": "Reads draw from here in; use zoom in or the search box to go closer."},
           ]),

        _t(id="ts_zoomed_out_user_zoom", command="nothing shows up at this zoom",
           phrasings=["at this zoom level the reads vanish"],
           context=V_WIDE_MYC,
           diagnostics=[zoomed_out(L1, "1.5 Mb", "50.0 kb"), zoomed_out(L2, "1.5 Mb", "50.0 kb")],
           thinking="zoomed_out_past_reads again, with a 50 kb window. Let the user pick where to zoom — a try_it on the search box waits for them to navigate — and show the setting.",
           summary="Zoom in past 50 kb to see reads",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "At 1.5 Mb you're past the 50 kb read window, so reads aren't drawn."},
               {"type": "try_it", "anchor": "search-bar", "wait_for": "navigated",
                "text": "Type a gene or a region under 50 kb here (or drag-zoom on the axis)."},
               {"type": "explain", "anchor": "read-window-setting",
                "text": "You can raise the read window here, but wide windows get slow."},
           ]),

        _t(id="ts_zoomed_out_read_window", command="can I see reads over a wider region?",
           phrasings=["how do I show reads at this zoom"],
           context=V_WIDE_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "400.0 kb")],
           thinking="The user wants reads over 400 kb; zoomed_out_past_reads confirms the 100 kb window is the limit. Point at the read-window setting and warn it costs speed.",
           summary="Raise the read window",
           actions=[
               {"type": "explain", "anchor": "read-window-setting",
                "text": "Reads are drawn only up to the read window, now 100 kb."},
               {"type": "explain", "anchor": "read-window-setting",
                "text": "Raise \"Show reads up to\" past 400 kb to draw reads here; wider windows load more data and draw slower."},
           ]),

        _t(id="ts_zoomed_out_after_search", command="I searched a chromosome and see no reads",
           phrasings=["I went to the whole chromosome and the reads disappeared"],
           context={"chrom": "2L", "start": 0, "end": 23_500_000, "currentGenome": "dm6"}, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "23.5 Mb")],
           thinking="A whole chromosome is 23.5 Mb, far past the read window (blocking). Suggest jumping to a covered window — go_to_top_locus is navigation — and explain.",
           summary="A whole chromosome is past the read window",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "The whole chromosome is 23.5 Mb; reads only draw below 100 kb."},
               {"type": "go_to_top_locus"},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "Go to reads jumps to the best-covered window at a readable zoom; click it again for the next one."},
           ]),

        # ── chrom_missing_in_dataset ──────────────────────────────────────
        _t(id="ts_chrom_missing_basic", command="why are there no reads on chromosome 4?",
           phrasings=["chr4 is empty", "no reads here"],
           context=V_CHR4, dataset_count=DS_FIBER_ONLY,
           diagnostics=[chrom_missing(L1, "4")],
           thinking="chrom_missing_in_dataset is blocking: the file has no chromosome 4. Nothing to fix in settings — move to a chromosome the data covers. Go to reads finds covered windows.",
           summary="The dataset has no reads on this chromosome",
           actions=[
               {"type": "explain", "anchor": "chrom-selector",
                "text": '"Embryo 2-4hr" has no reads on chromosome 4; its file doesn\'t contain it.'},
               {"type": "go_to_top_locus"},
               {"type": "explain", "anchor": "chrom-selector",
                "text": "Pick another chromosome here, or use Go to reads to jump to covered windows."},
           ]),

        _t(id="ts_chrom_missing_naming", command="the reads don't show on chr2R",
           phrasings=["my BAM shows nothing but the genes are there"],
           context={"chrom": "chr2R", "start": 9_970_000, "end": 9_980_000, "currentGenome": "dm6"},
           diagnostics=[chrom_missing(L1, "chr2R"), chrom_missing(L2, "chr2R")],
           thinking="Both datasets lack chr2R. Genes draw, so the annotation uses that name; the data files likely name the chromosome differently or cover other contigs. Point at the chromosome list and loaded datasets.",
           summary="The data files don't contain this chromosome",
           actions=[
               {"type": "explain", "anchor": "chrom-selector",
                "text": "Neither dataset contains chr2R, so there are no reads to draw here."},
               {"type": "explain", "anchor": "chrom-selector",
                "text": "Check which chromosomes your files cover; pick one of those here."},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "If the file should cover chr2R, check it was aligned to this same reference."},
           ]),

        _t(id="ts_chrom_missing_one", command="the DAF panel is empty on Y",
           phrasings=["only one dataset has reads here"],
           context=V_Y,
           diagnostics=[chrom_missing(L2, "Y")],
           thinking="chrom_missing_in_dataset for the DAF dataset only: it has no Y. Explain that the other dataset covers it and offer to move to a shared chromosome.",
           summary="The DAF dataset has no chromosome Y",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": '"Embryo 2.5-3hr DAF" has no reads on Y, so its panel is empty here.'},
               {"type": "explain", "anchor": "chrom-selector",
                "text": "Pick a chromosome both datasets cover to compare them."},
           ]),

        # ── fetch_failed ──────────────────────────────────────────────────
        _t(id="ts_fetch_failed_basic", command="why are no reads visible?",
           phrasings=["the reads won't load", "it says could not load reads"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[fetch_failed(L1)],
           thinking="fetch_failed is blocking: the request for this region failed. The usual causes are a moved or unreachable file. Point at Loaded Datasets to check the path, and nudge the view to retry.",
           summary="The reads failed to load",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": 'Loading reads for "Embryo 2-4hr" failed for this region.'},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "Check the file is still at its path (or its server is reachable) here."},
               {"type": "pan_view", "direction": "right"},
               {"type": "explain", "anchor": "pan-left",
                "text": "Moving the view retries the request; pan back if it loads."},
           ]),

        _t(id="ts_fetch_failed_remote", command="the S3 track stopped loading",
           phrasings=["my remote BAM stopped working"],
           context=V_HG38_TP53, dataset_count=DS_FIBER_ONLY,
           diagnostics=[fetch_failed(L1, "503 Service Unavailable")],
           thinking="fetch_failed with a 503 — the remote server didn't answer. Nothing in the browser to change; wait and retry by moving the view, or reload the URL.",
           summary="The remote file didn't respond",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The server holding \"Embryo 2-4hr\" returned 503, so this region didn't load."},
               {"type": "explain", "anchor": "pan-right",
                "text": "Try again in a moment by moving the view a little."},
               {"type": "explain", "anchor": "load-remote-url",
                "text": "If it keeps failing, load the URL again here."},
           ]),

        _t(id="ts_fetch_failed_one", command="one of the panels shows an error",
           phrasings=["the DAF panel says it failed"],
           context=V_DM6_3R,
           diagnostics=[fetch_failed(L2, "Could not load reads for this region.")],
           thinking="fetch_failed on the DAF dataset only; the other loads. Likely that file moved or its index is missing. Point at Loaded Datasets.",
           summary="The DAF dataset failed to load here",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": 'Reads for "Embryo 2.5-3hr DAF" failed to load; the other panel is fine.'},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "Check its file (and the .bai next to it) is still where it was loaded from."},
           ]),

        # ── still_loading ─────────────────────────────────────────────────
        _t(id="ts_still_loading", command="why is it empty?",
           phrasings=["nothing yet", "the reads aren't there"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[still_loading(L1)],
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=0, working=0, in_scope=0, loading=True)], labels=(L1,)),
           thinking="Only still_loading (info): the reads for this view are on their way. No problem to fix; wait. Large views or remote files take longer.",
           summary="The reads are still loading",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": 'Reads for "Embryo 2-4hr" are still loading; they appear in a moment.'},
               {"type": "explain", "anchor": "read-window-setting",
                "text": "Big windows and remote files take longer; a smaller read window loads faster."},
           ]),

        _t(id="ts_still_loading_remote", command="it's taking forever",
           phrasings=["the reads are slow to appear"],
           context=V_HG38_MYC,
           diagnostics=[still_loading(L1), still_loading(L2)],
           raw_state=_raw(V_HG38_MYC, [_panel("p1", L1, shown=0, working=0, loading=True),
                                       _panel("p2", L2, shown=0, working=0, loading=True)], genome="hg38"),
           thinking="Both panels still loading (info), nothing blocking. Explain it's in progress and what speeds it up: a narrower view, sampling.",
           summary="Still loading; a smaller view is faster",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Both datasets are still loading this region."},
               {"type": "explain", "anchor": "read-display-mode",
                "text": "Showing a sample of reads instead of all of them draws faster."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "A narrower view also loads quicker."},
           ]),

        # ── filter_matches_none ───────────────────────────────────────────
        _t(id="ts_filter_none_basic", command="why are no reads visible?",
           phrasings=["all my reads disappeared", "the track went empty after filtering"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_none(L1)],
           thinking="filter_matches_none is blocking: a read filter matched nothing. Clearing it is the user's click — try_it on clear-filter, waiting for filter_cleared — then show where to adjust the rule.",
           summary="A read filter matches no reads",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": 'A read filter on "Embryo 2-4hr" matched no reads, so none are shown.'},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter to show every read again."},
               {"type": "explain", "anchor": "filter-rules",
                "text": "To filter again, loosen the rule's threshold here."},
           ]),

        _t(id="ts_filter_none_after_move", command="the reads vanished when I moved",
           phrasings=["after I navigated nothing shows"],
           context=V_DM6_3R,
           diagnostics=[filter_none(L1), filter_none(L2)],
           thinking="Both panels have a filter that now matches nothing (blocking) — the filter kept read IDs from where it was applied. Clear it.",
           summary="The read filter matches nothing here",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "A read filter is still on, and no reads here match it."},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter."},
           ]),

        _t(id="ts_filter_none_rule", command="my filter rule shows nothing",
           phrasings=["the filter hid everything"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_none(L1)],
           thinking="filter_matches_none: the rule's condition matched no read. Explain, let them clear it, then show the Filter rules tab to adjust the threshold or scope.",
           summary="The filter rule matches no reads",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "The filter rule matched no reads here, so the panel is empty."},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter to get the reads back."},
               {"type": "explain", "anchor": "rules-filter-tab",
                "text": "Here you can loosen the rule (a lower count, or a wider scope) and apply it again."},
           ]),

        _t(id="ts_filter_none_cooccurrence", command="I clicked a co-occupancy cell and everything disappeared",
           phrasings=["the footprint filter emptied the track"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_none(L1)],
           thinking="A co-occupancy cell applies a read filter; this one matched nothing here (blocking). Clear it from the toolbar.",
           summary="The footprint filter matched no reads",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "That cell applied a read filter, and no reads here match it."},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter to show every read."},
           ]),

        # ── filter_active (warning) ───────────────────────────────────────
        _t(id="ts_filter_active_some", command="why do I only see some of my reads?",
           phrasings=["reads are missing", "fewer reads than before"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_active(L1, 42, 380)],
           thinking="filter_active (warning): a filter shows 42 of 380 reads. That's the cause; point at Clear filter and say it's reversible.",
           summary="A read filter is active",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": 'A read filter is on: "Embryo 2-4hr" shows 42 of its 380 reads.'},
               {"type": "explain", "anchor": "clear-filter",
                "text": "Click Clear filter to see them all; the rule stays saved."},
           ]),

        _t(id="ts_filter_active_forgot", command="where did half the reads go?",
           phrasings=["the panel has fewer reads than the other"],
           context=V_DM6_3R,
           diagnostics=[filter_active(L2, 110, 240)],
           thinking="filter_active on the DAF dataset only: 110 of 240. Name the filter, point at Clear filter.",
           summary="The DAF panel has a filter on",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": 'A filter on "Embryo 2.5-3hr DAF" shows 110 of 240 reads.'},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter if you want all of them back."},
           ]),

        _t(id="ts_filter_active_explain", command="is something hiding reads?",
           phrasings=["are my reads being filtered"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_active(L1, 18, 205)],
           thinking="Yes: filter_active shows 18 of 205. Answer directly and show where filters are managed.",
           summary="Yes, a filter shows 18 of 205 reads",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "Yes: a read filter shows 18 of the 205 reads here."},
               {"type": "explain", "anchor": "filter-rules",
                "text": "The filter rules live here; Clear filter removes the current one."},
           ]),

        # ── focus_hides_all ───────────────────────────────────────────────
        _t(id="ts_focus_hides_all", command="why are no reads visible?",
           phrasings=["all the reads disappeared after clustering", "the clustered reads are gone"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[focus_hides(L1)],
           thinking="focus_hides_all is blocking: the cluster focus leaves nothing visible. Unhiding clusters is the user's click in the Clusters panel; try_it with cluster_focused.",
           summary="The cluster focus hides every read",
           actions=[
               {"type": "explain", "anchor": "cluster-focus-bar", "requires": "has_clusters",
                "text": 'The cluster focus on "Embryo 2-4hr" hides every cluster that has reads.'},
               {"type": "try_it", "anchor": "cluster-focus-bar", "wait_for": "cluster_focused",
                "text": "Click Unhide all to show every cluster again."},
           ]),

        _t(id="ts_focus_hides_all_hidden", command="I hid some clusters and now nothing shows",
           phrasings=["I hid a cluster and the panel went blank"],
           context=V_DM6_3R,
           diagnostics=[focus_hides(L2)],
           thinking="focus_hides_all for the DAF panel: every visible cluster is hidden. Show the Clusters panel overview and Unhide all.",
           summary="Every cluster is hidden",
           actions=[
               {"type": "explain", "anchor": "clusters-overview", "requires": "has_clusters",
                "text": 'Every cluster with reads in "Embryo 2.5-3hr DAF" is hidden.'},
               {"type": "try_it", "anchor": "cluster-focus-bar", "wait_for": "cluster_focused",
                "text": "Click Unhide all, or click a cluster to focus it."},
           ]),

        _t(id="ts_focus_hides_all_move", command="after I moved the clusters are empty",
           phrasings=["the focused cluster has no reads here"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           diagnostics=[focus_hides(L1)],
           thinking="focus_hides_all after moving: the focused cluster has no reads in this region. Unhide all.",
           summary="The focused cluster has no reads here",
           actions=[
               {"type": "explain", "anchor": "cluster-focus-bar", "requires": "has_clusters",
                "text": "The cluster you focused has no reads in this region."},
               {"type": "try_it", "anchor": "cluster-focus-bar", "wait_for": "cluster_focused",
                "text": "Click Unhide all to see the other clusters."},
           ]),

        # ── branch_scope_empty ────────────────────────────────────────────
        _t(id="ts_branch_empty", command="why are no reads visible in this subcluster?",
           phrasings=["the subcluster view is empty"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[branch_empty(L1)],
           thinking="branch_scope_empty is blocking: the active cluster branch holds no reads for this panel. Point at the branch map to go back to the parent, and the focus bar.",
           summary="The active cluster branch is empty here",
           actions=[
               {"type": "explain", "anchor": "cluster-branches", "requires": "has_clusters",
                "text": "The active cluster branch has no reads for this panel."},
               {"type": "explain", "anchor": "cluster-branches",
                "text": "Click the root (or another branch) in the branch map to go back."},
           ]),

        _t(id="ts_branch_empty_copy", command="the new panel is blank",
           phrasings=["I made a copy while in a subcluster and it's empty"],
           context=V_DM6_3R,
           diagnostics=[branch_empty(L2)],
           thinking="branch_scope_empty for the DAF dataset: the branch has no reads for it. Explain and point at the branch map.",
           summary="The subcluster branch has no reads for this panel",
           actions=[
               {"type": "explain", "anchor": "cluster-branches", "requires": "has_clusters",
                "text": 'The active subcluster branch holds no reads for "Embryo 2.5-3hr DAF".'},
               {"type": "explain", "anchor": "cluster-focus-bar",
                "text": "Go back to the root branch, or unhide clusters here."},
           ]),

        # ── strand_panel_empty ────────────────────────────────────────────
        _t(id="ts_strand_empty_ga", command="why is the GA panel empty?",
           phrasings=["the GA strand has no reads", "one strand panel is blank"],
           context=V_DM6_2R,
           diagnostics=[strand_empty(L2, "GA")],
           thinking="strand_panel_empty is blocking: no GA-strand reads here. It's a property of the data in this region, not a bug; the strand chip switches the panel's strand.",
           summary="No GA-strand reads in this region",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": 'The GA-strand panel of "Embryo 2.5-3hr DAF" has no GA reads here.'},
               {"type": "explain", "anchor": "strand-chip",
                "text": "Use the strand chip to show both strands, or move to a region with GA coverage."},
           ]),

        _t(id="ts_strand_empty_ct", command="the CT panel shows nothing",
           phrasings=["no reads in the CT panel"],
           context=V_DM6_3R,
           diagnostics=[strand_empty(L2, "CT")],
           thinking="strand_panel_empty for CT. Explain and offer Go to reads for a better-covered window.",
           summary="No CT-strand reads here",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": "No CT-strand reads fall in this region, so the CT panel is empty."},
               {"type": "go_to_top_locus"},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "Go to reads jumps to the next well-covered window."},
           ]),

        _t(id="ts_strand_empty_split", command="I split by strand and one side is blank",
           phrasings=["after splitting one panel is empty"],
           context=V_DM6_2L,
           diagnostics=[strand_empty(L2, "GA")],
           thinking="strand_panel_empty after a split: the region only has CT-strand reads. Explain the split and how to merge the strands back.",
           summary="This region only has CT-strand reads",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": "DAF-seq reads come from one strand each, and here all are CT, so the GA panel is empty."},
               {"type": "explain", "anchor": "strand-chip",
                "text": "Set the chip back to both strands to show them in one panel."},
           ]),

        # ── no_reads_in_region ────────────────────────────────────────────
        _t(id="ts_no_reads_region", command="why are no reads visible?",
           phrasings=["this region is empty", "nothing here"],
           context=V_DM6_X, dataset_count=DS_FIBER_ONLY,
           diagnostics=[no_reads(L1)],
           thinking="no_reads_in_region is blocking: the file simply has no reads here. Navigation is mine: go to the next well-covered window, then point at Go to reads for more.",
           summary="No reads in this region",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": '"Embryo 2-4hr" has no reads in this region.'},
               {"type": "go_to_top_locus"},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "This jumps to the best-covered windows; click Go to reads for the next one."},
           ]),

        _t(id="ts_no_reads_targeted", command="there are no reads at my gene",
           phrasings=["my locus has no coverage"],
           context=V_DM6_3R,
           diagnostics=[no_reads(L1), no_reads(L2)],
           thinking="Both datasets have no reads here (blocking). For targeted data the coverage is only at the captured loci; point at the search box and Go to reads.",
           summary="No coverage at this locus",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Neither dataset has reads in this region."},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "If your data is targeted, Go to reads jumps to the covered loci."},
               {"type": "explain", "anchor": "search-bar",
                "text": "Or search the gene you captured."},
           ]),

        _t(id="ts_no_reads_one", command="the second dataset shows nothing",
           phrasings=["one panel has no reads"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           diagnostics=[no_reads(L3)],
           thinking="Only the third dataset has no reads here (blocking for that panel). The others are fine; it's coverage, not a setting.",
           summary="That dataset has no reads here",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": '"Embryo 5-8hr" has no reads in this region; the other panels do.'},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "Go to reads jumps to covered windows if you want to compare somewhere else."},
           ]),

        _t(id="ts_no_reads_after_search", command="I searched a gene and there are no reads",
           phrasings=["the gene I went to is empty"],
           context={"chrom": "3R", "start": 16_690_000, "end": 16_730_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           diagnostics=[no_reads(L1)],
           thinking="no_reads_in_region at the searched gene: the dataset doesn't cover it. Explain, then offer the nearest covered window.",
           summary="The dataset doesn't cover this gene",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": '"Embryo 2-4hr" has no reads at this gene.'},
               {"type": "go_to_top_locus"},
           ]),

        # ── spanning_only_hides ───────────────────────────────────────────
        _t(id="ts_spanning_none", command="why are no reads visible?",
           phrasings=["no reads show at this zoom", "the reads are gone"],
           context={"chrom": "2R", "start": 9_950_000, "end": 9_990_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           diagnostics=[spanning_none(L1, 312)],
           thinking="spanning_only_hides is blocking: 312 reads overlap but none spans the whole 40 kb view. Either zoom in (mine) or turn spanning-only off (the user's toggle).",
           summary="Spanning-only hides every read",
           actions=[
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only is on, and none of the 312 reads spans the whole view."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Turn it off to show every read that overlaps the view."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "Or zoom in: more reads span a narrower view."},
           ]),

        _t(id="ts_spanning_few", command="why so few reads?",
           phrasings=["only a handful of reads", "I expected more reads"],
           context={"chrom": "2R", "start": 9_960_000, "end": 9_985_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           diagnostics=[spanning_few(L1, 14, 260)],
           thinking="spanning_only_hides (warning): 14 of 260 overlapping reads span the view. That's the reason; point at the toggle.",
           summary="Spanning-only keeps 14 of 260 reads",
           actions=[
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only is on: 14 of the 260 reads here cover the whole view."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Turn it off to see all 260; keep it on when you want only full-length molecules."},
           ]),

        _t(id="ts_spanning_wide", command="the reads went away when I zoomed out a bit",
           phrasings=["zooming out removed most reads"],
           context={"chrom": "3R", "start": 1_000_000, "end": 1_060_000, "currentGenome": "dm6"},
           diagnostics=[spanning_none(L1, 180), spanning_few(L2, 3, 95)],
           thinking="Spanning-only: as the view widens fewer molecules span it — none in one panel (blocking), 3 of 95 in the other. Explain the effect and both fixes.",
           summary="Wider views have fewer spanning reads",
           actions=[
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "With Spanning only on, a read must cover the whole view; at 60 kb almost none do."},
               _zoom_to({"chrom": "3R", "start": 1_000_000, "end": 1_060_000}, 20_000),
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Or turn Spanning only off to see every overlapping read."},
           ]),

        _t(id="ts_spanning_what", command="what does spanning only do? my reads are missing",
           phrasings=["is spanning only hiding reads"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           diagnostics=[spanning_few(L1, 40, 190)],
           thinking="Explain the option and confirm from the warning that it's hiding 150 reads.",
           summary="Spanning-only shows full-length molecules only",
           actions=[
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only keeps just the reads that cover the whole view."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Here that's 40 of 190 reads; turn it off to see the rest."},
           ]),

        # ── quality_filter_hides_all ──────────────────────────────────────
        _t(id="ts_quality_all", command="why are no reads visible?",
           phrasings=["the quality filter removed everything", "all reads were filtered out"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[quality_all(L1)],
           thinking="quality_filter_hides_all is blocking: the quality settings remove every read. Point at the Quality group; its cutoffs are revealed by expanding it.",
           summary="The quality settings remove every read",
           actions=[
               {"type": "explain", "anchor": "quality-filters",
                "text": 'The read quality settings remove every read in "Embryo 2-4hr".'},
               {"type": "explain", "anchor": "quality-cutoffs",
                "text": "Lower or switch off the cutoffs here."},
               {"type": "explain", "anchor": "read-filters",
                "text": "Minimum footprints per read is set here, in the sidebar."},
           ]),

        _t(id="ts_quality_most", command="why did most reads disappear?",
           phrasings=["a lot of reads are gone", "where did my reads go"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[quality_most(L1, 240, 300)],
           thinking="quality_filter_hides_all (warning): 240 of 300 removed by quality settings. Point at the cutoffs.",
           summary="Quality settings remove 240 of 300 reads",
           actions=[
               {"type": "explain", "anchor": "quality-filters",
                "text": "The quality settings remove 240 of the 300 reads here."},
               {"type": "explain", "anchor": "quality-cutoffs",
                "text": "Relax the cutoffs here to keep more reads."},
           ]),

        _t(id="ts_quality_min_footprints", command="the reads with few footprints are missing",
           phrasings=["short reads don't show"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           diagnostics=[quality_most(L1, 90, 150)],
           thinking="quality_filter_hides_all (warning) — likely the minimum-footprints setting. Open the sidebar's read filters and point at it.",
           summary="A minimum-footprints setting removes reads",
           actions=[
               {"type": "explain", "anchor": "quality-filters",
                "text": "The read quality settings remove 90 of 150 reads here."},
               {"type": "open_sidebar", "section": "view", "subsection": "view.advanced"},
               {"type": "explain", "anchor": "read-filters",
                "text": "Minimum footprints per read is set here; lower it to keep sparser reads."},
           ]),

        _t(id="ts_quality_daf", command="the DAF reads are gone",
           phrasings=["DAF panel empty after I set a quality cutoff"],
           context=V_DM6_2R,
           diagnostics=[quality_all(L2)],
           thinking="quality_filter_hides_all blocking on the DAF dataset only. Point at the cutoffs; note the cutoff may suit one assay and not the other.",
           summary="The quality cutoff removes every DAF read",
           actions=[
               {"type": "explain", "anchor": "quality-filters",
                "text": 'The quality settings remove every read in "Embryo 2.5-3hr DAF".'},
               {"type": "explain", "anchor": "quality-cutoffs",
                "text": "A cutoff tuned for one assay can remove all of another's reads; relax it here."},
           ]),

        # ── combinations ──────────────────────────────────────────────────
        _t(id="ts_combo_zoom_and_filter", command="why are no reads visible?",
           phrasings=["nothing shows and I don't know why"],
           context=V_WIDE_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "1.0 Mb"), filter_active(L1, 30, 900)],
           thinking="Two findings: zoomed_out_past_reads (blocking) and filter_active (warning). The zoom is why nothing shows at all; fix it first (I zoom in), then mention the filter that will still hide most reads.",
           summary="Zoomed out, and a filter is on",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "You're at 1.0 Mb, past the 100 kb read window, so no reads are drawn."},
               _zoom_to(V_WIDE_2R, 100_000),
               {"type": "explain", "anchor": "clear-filter",
                "text": "A read filter is also on (30 of 900 reads); Clear filter shows them all."},
           ]),

        _t(id="ts_combo_filter_none_spanning", command="the panel is empty",
           phrasings=["everything disappeared"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_none(L1), spanning_few(L1, 20, 300)],
           thinking="filter_matches_none (blocking) is why it's empty; spanning-only (warning) also trims reads. Clear the filter first, then note spanning-only.",
           summary="A filter matches nothing; spanning-only also trims",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "A read filter matched no reads, so the panel is empty."},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only is also on, keeping 20 of 300 reads; turn it off to see all."},
           ]),

        _t(id="ts_combo_no_data_no_genome", command="how do I get started? nothing is here",
           phrasings=["I opened the browser and it's empty"],
           context=V_EMPTY, dataset_count=0,
           diagnostics=[no_datasets(), no_reference(True)],
           thinking="Nothing loaded at all: no_datasets and no_reference, both blocking. Genome first (chromosomes and genes), then data — two try_its.",
           summary="Pick a genome, then load a dataset",
           actions=[
               {"type": "explain", "anchor": "genome-selector",
                "text": "Nothing is loaded yet: first a genome, then your reads."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome from the list."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Now load your BAM or BigBed with Load File."},
               {"type": "explain", "anchor": "guided-tour",
                "text": "The Tour button walks through the main features on a demo dataset."},
           ]),

        _t(id="ts_combo_layers_quality", command="my reads look empty and sparse",
           phrasings=["few reads and no footprints on them"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[layers_hidden(False), quality_most(L1, 150, 260)],
           thinking="Two warnings: layers (footprint and nucleosome off) and quality (150 of 260 removed). Both explain the symptom; handle layers then quality.",
           summary="Layers are off and quality removes reads",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "The footprint and nucleosome layers are off, so reads show only TF calls."},
               {"type": "explain", "anchor": "quality-cutoffs",
                "text": "The quality settings also remove 150 of 260 reads; relax them here."},
           ]),

        _t(id="ts_combo_chrom_copy", command="the copy shows no reads on chr4",
           phrasings=["the second panel is empty on 4"],
           context=V_DM6_2R,
           diagnostics=[chrom_missing(L2, "4"), at_other_locus(L2)],
           thinking="The copy is at its own region on chromosome 4 (info), and the DAF dataset has no chromosome 4 (blocking). Move the copy with its location bar.",
           summary="The copy is on a chromosome the dataset lacks",
           actions=[
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": 'The copy shows chromosome 4, and "Embryo 2.5-3hr DAF" has no reads there.'},
               {"type": "explain", "anchor": "panel-location-bar",
                "text": "Type another region here, or click Link to follow the main view."},
           ]),

        _t(id="ts_combo_focus_filter", command="nothing left after focusing a cluster",
           phrasings=["I focused a cluster and the reads vanished"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[focus_hides(L1), filter_active(L1, 60, 400)],
           thinking="focus_hides_all is blocking and a filter is also on. The focus and filter together leave nothing: the focused cluster's reads are filtered out. Unhide first, then point at the filter.",
           summary="The focus and a filter together hide everything",
           actions=[
               {"type": "explain", "anchor": "cluster-focus-bar", "requires": "has_clusters",
                "text": "The focused cluster has no reads that pass the current read filter."},
               {"type": "try_it", "anchor": "cluster-focus-bar", "wait_for": "cluster_focused",
                "text": "Click Unhide all to show every cluster."},
               {"type": "explain", "anchor": "clear-filter",
                "text": "A read filter also shows only 60 of 400 reads; Clear filter removes it."},
           ]),

        _t(id="ts_combo_strand_spanning", command="the GA panel is empty but the CT one isn't",
           phrasings=["why is one strand blank"],
           context={"chrom": "2R", "start": 9_955_000, "end": 9_995_000, "currentGenome": "dm6"},
           diagnostics=[strand_empty(L2, "GA"), spanning_few(L2, 8, 120)],
           thinking="strand_panel_empty blocks the GA panel; spanning-only (warning) also trims the CT side. Explain the strand, then note spanning-only.",
           summary="No GA reads here; spanning-only trims the rest",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": "No GA-strand reads fall in this view, so the GA panel is empty."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only is on too (8 of 120 reads span the view); turning it off may bring GA reads in."},
           ]),

        _t(id="ts_combo_loading_filter", command="why is the track blank right now",
           phrasings=["it's empty for a moment"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[still_loading(L1), filter_active(L1, 5, 50)],
           thinking="still_loading is info; filter_active is a warning. The main thing is it's loading; also mention the filter that will show only a few reads when done.",
           summary="Still loading; a filter is also on",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The reads are still loading for this view."},
               {"type": "explain", "anchor": "clear-filter",
                "text": "When they arrive, a read filter will show only a few; Clear filter removes it."},
           ]),

        _t(id="ts_combo_fetch_zoom", command="nothing loads",
           phrasings=["the browser shows nothing"],
           context=V_WIDE_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "400.0 kb"), fetch_failed(L1, None)],
           thinking="Two blocking findings: zoomed out past the window and a failed fetch. Zoom first — a narrower request may also succeed where the wide one failed.",
           summary="Zoomed out past the read window; the wide request failed",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "At 400 kb you're past the read window, and loading this wide region failed."},
               _zoom_to(V_WIDE_3R, 100_000),
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "If it still fails here, check the file under Loaded Datasets."},
           ]),

        _t(id="ts_combo_collapsed_and_minimized", command="where is everything",
           phrasings=["my panels are all gone"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           diagnostics=[panel_collapsed(L1, True), row_collapsed(L2, True), row_collapsed(L3, True)],
           thinking="Every dataset panel is hidden: one minimized, two in a collapsed row. Point at both controls.",
           summary="Panels are minimized or in collapsed rows",
           actions=[
               {"type": "explain", "anchor": "panel-expand",
                "text": '"Embryo 2-4hr" is minimized; click its chip to bring it back.'},
               {"type": "explain", "anchor": "layout-rows",
                "text": "The other two are in a collapsed row; click the row bar to open it."},
           ]),
    ]


    # ═════════════════════════════════════════════════════════════════════
    # 2. Raw-state fallback (no blocking or warning diagnostic)
    # ═════════════════════════════════════════════════════════════════════

    def _s(**kw):
        kw.setdefault("category", "troubleshoot_state")
        kw.setdefault("diagnostics", [])
        return _r(**kw)


    STATE_RECORDS: list[dict] = [
        _s(id="tss_fine_scrolled", command="why are no reads visible?",
           phrasings=["I don't see any reads"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=240, working=240)], labels=(L1,)),
           thinking="No diagnostics, and the state says 240 reads are shown in an unfiltered, visible panel. So the reads are there; likely scrolled or too small. Don't invent a cause — say it looks normal and point at row height and the read area.",
           summary="240 reads are loaded; check the row height and scroll",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The browser shows 240 reads loaded here, with no filter or setting hiding them."},
               {"type": "explain", "anchor": "row-height",
                "text": "If rows are very thin they're hard to see; make them taller here."},
               {"type": "explain", "anchor": "reads-track",
                "text": "Scroll inside the panel if they're below the visible area."},
           ]),

        _s(id="tss_few_reads_low_coverage", command="why are there so few reads?",
           phrasings=["only a few reads here", "coverage looks low"],
           context=V_DM6_X, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_X, [_panel("p1", L1, shown=4, working=4, in_scope=4, overlapping=4)], labels=(L1,)),
           thinking="State: 4 reads, all shown, no filter, spanning-only off. Nothing is hiding reads — this region just has low coverage. Offer a better-covered window.",
           summary="The region has low coverage; nothing is hidden",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Only 4 reads overlap this region, and all 4 are shown; nothing is hidden."},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "Go to reads jumps to the best-covered windows if you want more molecules."},
           ]),

        _s(id="tss_few_reads_offer_top", command="coverage is terrible here",
           phrasings=["hardly any molecules"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_3R, [_panel("p1", L1, shown=7, working=7)], labels=(L1,)),
           thinking="7 reads, none filtered — low coverage is real here. I can navigate: jump to the best-covered window.",
           summary="Jump to a better-covered window",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "There are 7 reads here and none is filtered out; the coverage is just low."},
               {"type": "go_to_top_locus"},
           ]),

        _s(id="tss_copy_other_locus", command="why don't the two panels match?",
           phrasings=["the panels show different regions"],
           context=V_DM6_2R,
           diagnostics=[at_other_locus(L2)],
           raw_state=_raw(V_DM6_2R, [
               _panel("p1", L1, shown=210),
               _panel("p2", L2, shown=95, own_view={"chrom": "3R", "start": 1_000_000, "end": 1_010_000}),
           ]),
           thinking="Only an info diagnostic (panel_at_other_locus); state shows the second panel has its own view at 3R. That's by design for an unlinked copy.",
           summary="The second panel is an unlinked copy at 3R",
           actions=[
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": "The second panel is an unlinked copy showing 3R:1,000,000-1,010,000."},
               {"type": "explain", "anchor": "panel-link",
                "text": "Click Link to make it follow the main view."},
           ]),

        _s(id="tss_focus_one_cluster", command="why do I only see some reads?",
           phrasings=["half the reads are missing"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=64, working=320, focus=[2], clustered=True)], labels=(L1,)),
           thinking="No diagnostics. State: clustered, focus on cluster 2, 64 of 320 shown. The focus is showing only one cluster — explain and point at Unhide all.",
           summary="Only cluster 2 is shown",
           actions=[
               {"type": "explain", "anchor": "cluster-focus-bar", "requires": "has_clusters",
                "text": "You're focused on cluster 2, so 64 of 320 reads are shown."},
               {"type": "explain", "anchor": "cluster-focus-bar",
                "text": "Click Unhide all to show every cluster."},
           ]),

        _s(id="tss_strand_panel", command="why are some reads missing in this panel?",
           phrasings=["this panel has fewer reads than I expected"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [
               _panel("p1", L1, shown=180),
               _panel("p2", L2, shown=70, strand="CT"),
           ]),
           thinking="State: the DAF panel is a CT-strand panel (strand: CT) with 70 reads. It shows only one strand by design; the chip switches it.",
           summary="That panel shows the CT strand only",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": "This DAF panel shows only CT-strand reads (70 here)."},
               {"type": "explain", "anchor": "strand-chip",
                "text": "Set the chip to both strands to see all its reads."},
           ]),

        _s(id="tss_tf_layer_off", command="where are the TF footprints?",
           phrasings=["I don't see the small footprints"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200)], labels=(L1,),
                          layers={"footprint": True, "nuc": True, "tf": False, "fire": True}),
           thinking="No diagnostic (footprint and nuc are on), but the state shows tf:false. That's why the TF calls don't show.",
           summary="The TF layer is switched off",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "The TF layer is switched off, so TF-sized footprints aren't drawn."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Tick TF here to show them."},
           ]),

        _s(id="tss_fire_off", command="why are the FIRE elements gone?",
           phrasings=["no FIRE calls"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200)], labels=(L1,),
                          layers={"footprint": True, "nuc": True, "tf": True, "fire": False}),
           thinking="State: fire:false in layers. The FIRE layer is off.",
           summary="The FIRE layer is off",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "The FIRE layer is switched off in the layer controls."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Tick FIRE to show accessible elements again."},
           ]),

        _s(id="tss_bigbed_no_m6a", command="why can't I see m6A marks?",
           phrasings=["no methylation shows", "where are the m6A dots"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=190)], labels=(L1,)),
           thinking="State: the only dataset is a BigBed of footprint calls. m6A marks come from BAM MM/ML tags; this file doesn't carry them. Not a setting — explain.",
           summary="This BigBed has no m6A marks",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "\"Embryo 2-4hr\" is a BigBed of footprint calls; it doesn't store m6A positions."},
               {"type": "explain", "anchor": "load-dataset",
                "text": "Load the BAM with MM/ML tags to see methylation marks."},
           ]),

        _s(id="tss_bigbed_no_layer", command="why is there no nucleosome layer?",
           phrasings=["the nuc layer toggle does nothing"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_3R, [_panel("p1", L1, shown=160)], labels=(L1,)),
           thinking="State: BigBed dataset, layers all on, 160 reads. If the file carries only primary footprints, there's no separate nucleosome layer; the footprints are drawn by size. Explain; companion files add layers.",
           summary="The BigBed has footprint calls, not a separate nucleosome layer",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "This BigBed stores one footprint track; nucleosome- and TF-sized footprints are drawn from it by size."},
               {"type": "explain", "anchor": "load-dataset",
                "text": "Separate layers come from companion files (_tf.bb, _nuc.bb) loaded together."},
           ]),

        _s(id="tss_sampled", command="why do I see only 200 reads when there are thousands?",
           phrasings=["not all reads are shown"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200, working=200, in_scope=3400, overlapping=3400)],
                          labels=(L1,)),
           thinking="State: 200 shown of 3,400 in scope, no filter. That's sampling for display. Point at the All/sample toggle.",
           summary="The display shows a sample of reads",
           actions=[
               {"type": "explain", "anchor": "read-display-mode",
                "text": "3,400 reads overlap here; the display shows a sample of 200."},
               {"type": "explain", "anchor": "read-display-mode",
                "text": "Switch to All here to draw every read (slower for deep regions)."},
           ]),

        _s(id="tss_min_footprints", command="why are some reads not shown?",
           phrasings=["a few reads are missing"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2L, [_panel("p1", L1, shown=130, working=130, in_scope=150)], labels=(L1,),
                          min_footprints=3),
           thinking="No diagnostic (only 20 of 150 removed — under the warning threshold). State shows min_footprints 3, which removes sparse reads. Point at the setting.",
           summary="A minimum-footprints setting removes 20 reads",
           actions=[
               {"type": "explain", "anchor": "read-filters",
                "text": "Minimum footprints per read is 3, which removes 20 of the 150 reads."},
               {"type": "explain", "anchor": "read-filters",
                "text": "Set it to 0 here to keep every read."},
           ]),

        _s(id="tss_quality_mild", command="is a quality filter on?",
           phrasings=["are reads being quality filtered"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=210, working=210, in_scope=230)], labels=(L1,),
                          quality_filters=["tf:tq>=100"]),
           thinking="State: one quality filter (tf tq>=100), 210 of 230 kept. Answer yes, how much it removes, and where it lives.",
           summary="Yes: a TF quality cutoff removes 20 reads",
           actions=[
               {"type": "explain", "anchor": "quality-filters",
                "text": "Yes: a TF quality cutoff (tq ≥ 100) is on and removes 20 of 230 reads."},
               {"type": "explain", "anchor": "quality-cutoffs",
                "text": "Adjust or switch it off here."},
           ]),

        _s(id="tss_no_problem", command="is anything wrong?",
           phrasings=["check my setup", "does everything look right"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=220), _panel("p2", L2, shown=150)]),
           thinking="No diagnostics; both panels show reads, no filters, default settings. Everything looks fine — say so rather than invent a problem.",
           summary="Everything looks normal",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Nothing looks wrong: both datasets show reads here, with no filters or hidden panels."},
               {"type": "explain", "anchor": "guided-tour",
                "text": "If you're unsure what to try next, the Tour walks through the main features."},
           ]),

        _s(id="tss_fine_but_empty_claim", command="the track is empty",
           phrasings=["nothing is drawn"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_3R, [_panel("p1", L1, shown=185)], labels=(L1,)),
           thinking="No diagnostic; the state says 185 reads are shown. The track the user means may be a different one (genes, peaks, a signal track). Ask them to look and point at the likely candidates without inventing a fault.",
           summary="The reads are drawn; which track looks empty?",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The reads track has 185 reads here, so it isn't the one that's empty."},
               {"type": "explain", "anchor": "peaks-track",
                "text": "If it's the Peaks track, click Scan to find peaks in this view."},
               {"type": "explain", "anchor": "panel-subtracks",
                "text": "Other tracks can be shown or hidden from the panel's sub-track settings."},
           ]),

        _s(id="tss_clusters_reordered", command="why did my clusters change order?",
           phrasings=["the clusters keep moving around"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=300, clustered=True)], labels=(L1,)),
           thinking="State: clustered. Cluster order is recomputed when you sort or move; the lock keeps it. Point at the order lock.",
           summary="Lock the cluster order",
           actions=[
               {"type": "explain", "anchor": "sort-button",
                "text": "Sorting and navigating can reorder the clusters."},
               {"type": "explain", "anchor": "cluster-order-lock", "requires": "has_clusters",
                "text": "Lock the cluster order here to keep it fixed."},
           ]),

        _s(id="tss_spanning_off_but_few", command="why are the reads so short?",
           phrasings=["the reads don't cover the view"],
           context={"chrom": "2R", "start": 9_900_000, "end": 9_990_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           raw_state=_raw({"chrom": "2R", "start": 9_900_000, "end": 9_990_000},
                          [_panel("p1", L1, shown=500, spanning=0)], labels=(L1,)),
           thinking="State: 500 reads shown, none spans the 90 kb view. Fiber-seq molecules are ~10–20 kb, so at 90 kb each covers a fraction. Normal; zoom in or turn on spanning-only for full-length molecules.",
           summary="The molecules are shorter than the view",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Each molecule is shorter than this 90 kb view, so none reaches across."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "Zoom in to a few kb to see whole molecules side by side."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only then keeps just the reads that cover the whole view."},
           ]),

        _s(id="tss_reversed", command="why is everything backwards?",
           phrasings=["the coordinates run right to left"],
           context=V_DM6_2L,
           raw_state=_raw(V_DM6_2L, [_panel("p1", L1, shown=150), _panel("p2", L2, shown=90)]),
           thinking="No diagnostic covers orientation. The browser has a reverse-view toggle, often used for minus-strand genes. Point at it.",
           summary="The view may be reversed",
           actions=[
               {"type": "explain", "anchor": "reverse-view",
                "text": "The view can be flipped to read a minus-strand gene left to right."},
               {"type": "explain", "anchor": "reverse-view",
                "text": "Click Reverse view again to restore the normal orientation."},
           ]),

        _s(id="tss_colors_grey", command="why are the reads all grey?",
           phrasings=["no colours on the reads"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200)], labels=(L1,)),
           thinking="Layers are on and reads are shown, so footprints are drawn — the colours come from the labeling rules. Point at the Labeling panel.",
           summary="Colours come from the labeling rules",
           actions=[
               {"type": "explain", "anchor": "labeling-rules",
                "text": "Footprint colours come from labeling rules; with none matching, footprints are drawn in the default grey."},
               {"type": "explain", "anchor": "add-label-rule",
                "text": "Add a rule here (e.g. by size range) to colour them."},
           ]),

        _s(id="tss_slow_big_view", command="everything is slow",
           phrasings=["the browser is laggy", "it takes ages to redraw"],
           context={"chrom": "2R", "start": 9_910_000, "end": 9_990_000, "currentGenome": "dm6"},
           dataset_count=DS_THREE,
           raw_state=_raw({"chrom": "2R", "start": 9_910_000, "end": 9_990_000}, [
               _panel("p1", L1, shown=4200), _panel("p2", L2, shown=3100), _panel("p3", L3, shown=3800),
           ], labels=(L1, L2, L3)),
           thinking="State: three datasets, ~11,000 reads drawn across an 80 kb view. That's the load. Suggest sampling, a narrower view, or a lower read window.",
           summary="About 11,000 reads are drawn at once",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Three panels are drawing about 11,000 reads across 80 kb."},
               {"type": "explain", "anchor": "read-display-mode",
                "text": "Showing a sample instead of all reads is the quickest speed-up."},
               {"type": "explain", "anchor": "read-window-setting",
                "text": "A lower read window also keeps wide views light."},
           ]),

        _s(id="tss_slow_wide_window", command="it's slow when I zoom out",
           phrasings=["zooming out lags"],
           context={"chrom": "3R", "start": 1_000_000, "end": 1_450_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           raw_state=_raw({"chrom": "3R", "start": 1_000_000, "end": 1_450_000},
                          [_panel("p1", L1, shown=9000)], labels=(L1,), read_window=500_000),
           thinking="State: the read window is 500 kb, so zooming out to 450 kb still draws 9,000 reads. Suggest a smaller read window.",
           summary="The read window is set high (500 kb)",
           actions=[
               {"type": "explain", "anchor": "read-window-setting",
                "text": "Reads are drawn up to 500 kb, so this 450 kb view draws 9,000 of them."},
               {"type": "explain", "anchor": "read-window-setting",
                "text": "Lower \"Show reads up to\" (100 kb is the default) to show coverage when zoomed out."},
           ]),

        _s(id="tss_loading_raw", command="why is the second panel still empty?",
           phrasings=["one panel hasn't loaded"],
           context=V_DM6_2R,
           diagnostics=[still_loading(L2)],
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200), _panel("p2", L2, shown=0, working=0, loading=True)]),
           thinking="Only still_loading (info) for the DAF panel; state confirms loading:true. It's on its way; DAF BAMs parse more per read.",
           summary="The DAF panel is still loading",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The DAF panel is still loading; BAM reads with modification tags take a little longer."},
           ]),

        _s(id="tss_filter_active_small", command="why is one panel sparse?",
           phrasings=["the first panel has fewer reads"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=40, working=40, in_scope=45, filt=40),
                                     _panel("p2", L2, shown=160)]),
           thinking="No warning fired (the filter keeps most of the working set), but state shows filter:40 on the first panel. A filter is on; point at Clear filter.",
           summary="A filter is on the first panel",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "The first panel has a read filter keeping 40 reads."},
               {"type": "explain", "anchor": "clear-filter",
                "text": "Clear filter shows all of its reads again."},
           ]),

        _s(id="tss_active_branch", command="why do I only see a few clusters?",
           phrasings=["some clusters disappeared"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=90, working=90, clustered=True)], labels=(L1,),
                          branch=True),
           thinking="State: clustering.active_branch is true — they're inside a subcluster branch, which shows only that branch's reads. Point at the branch map.",
           summary="You're inside a subcluster branch",
           actions=[
               {"type": "explain", "anchor": "cluster-branches", "requires": "has_clusters",
                "text": "You're viewing a subcluster branch, which shows only its own clusters."},
               {"type": "explain", "anchor": "cluster-branches",
                "text": "Click the root in the branch map to see all clusters again."},
           ]),

        _s(id="tss_no_genes_gene_track_hidden", command="the genes are gone",
           phrasings=["I can't see the gene track anymore"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200), _panel("p2", L2, shown=140)]),
           thinking="No no_gtf diagnostic, so an annotation is loaded. The gene track is probably hidden in the panel's sub-tracks. Point there.",
           summary="The gene track is probably hidden",
           actions=[
               {"type": "explain", "anchor": "panel-subtracks",
                "text": "A gene annotation is loaded, so the gene track is likely hidden in this panel."},
               {"type": "explain", "anchor": "panel-subtracks",
                "text": "Open the sub-track settings and switch Genes back on."},
           ]),

        _s(id="tss_no_reference_seq_info", command="why no sequence?",
           phrasings=["the sequence row is missing"],
           context=V_DM6_2R,
           diagnostics=[no_reference(False)],
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200), _panel("p2", L2, shown=120)], genome=None),
           thinking="Info-level no_reference; state shows reference_loaded false. The sequence row needs a FASTA.",
           summary="No reference is loaded for the sequence row",
           actions=[
               {"type": "explain", "anchor": "load-fasta",
                "text": "No reference sequence is loaded, so the sequence row has nothing to draw."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome, or load a FASTA under Reference Files."},
           ]),

        _s(id="tss_panel_hidden_none", command="where's my third dataset?",
           phrasings=["I loaded three files but see two"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=210), _panel("p2", L2, shown=130)],
                          labels=(L1, L2, L3)),
           thinking="State lists three datasets but only two panels — the third has no panel (it was closed). Point at Loaded Datasets to show it again.",
           summary="The third dataset has no panel",
           actions=[
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "\"Embryo 5-8hr\" is loaded, but its panel was closed."},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "Show it again from Loaded Datasets here."},
           ]),

        _s(id="tss_clustered_not_colored", command="I clustered but nothing changed",
           phrasings=["clustering didn't do anything"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=280, clustered=True)], labels=(L1,)),
           thinking="State: clustered is true. Clustering worked; the result is the coloured bar left of the reads and the Clusters panel. Show them.",
           summary="Clustering worked; here's where the result is",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The reads are clustered: the coloured bar on their left shows each read's cluster."},
               {"type": "explain", "anchor": "clusters-overview", "requires": "has_clusters",
                "text": "The Clusters panel lists each cluster with its read count and profile."},
           ]),

        _s(id="tss_not_clustered_greyed", command="why is my data not clustered?",
           phrasings=["no clusters show"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=280, clustered=False)], labels=(L1,)),
           thinking="State: clustered false. Nothing has been clustered yet; walk them through it with try_its.",
           summary="Nothing is clustered yet",
           actions=[
               {"type": "explain", "anchor": "cluster-toolbar",
                "text": "The reads haven't been clustered yet."},
               {"type": "try_it", "anchor": "scan-peaks-button", "wait_for": "peaks_scanned", "skip_if": "has_peaks",
                "text": "Click Scan to find peaks."},
               {"type": "try_it", "anchor": "peaks-track", "wait_for": "peak_selected", "skip_if": "has_selected_peak",
                "text": "Click a peak to select it."},
               {"type": "try_it", "anchor": "cluster-button", "wait_for": "clustered",
                "text": "Now click Cluster."},
           ]),

        _s(id="tss_hg38_fine", command="why are no reads visible?",
           phrasings=["no reads show"],
           context=V_HG38_TP53, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_HG38_TP53, [_panel("p1", L1, shown=0, working=0, in_scope=0, overlapping=0)],
                          labels=(L1,), genome="hg38"),
           thinking="No diagnostics sent despite 0 reads — maybe the status hasn't updated. State says 0 overlapping reads. The honest read: no reads overlap this view; offer to jump to coverage.",
           summary="No reads overlap this view",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The browser reports no reads overlapping this view."},
               {"type": "go_to_top_locus"},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "That's the best-covered window; Go to reads cycles through more."},
           ]),

        _s(id="tss_two_ok_one_low", command="why does one dataset look thin?",
           phrasings=["the third panel has barely any reads"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=240), _panel("p2", L2, shown=150),
                                     _panel("p3", L3, shown=12)], labels=(L1, L2, L3)),
           thinking="State: third panel has 12 reads, unfiltered; others 150–240. It's lower sequencing depth there, not a setting.",
           summary="That dataset has lower coverage here",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "\"Embryo 5-8hr\" has 12 reads here and none is filtered; it's just shallower in this region."},
               {"type": "explain", "anchor": "reads-track",
                "text": "Shift+click reads in each panel to compare their lengths in Read Stats."},
           ]),

        _s(id="tss_relative_off", command="why are the coordinates weird numbers?",
           phrasings=["the axis shows negative numbers"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=200), _panel("p2", L2, shown=120)]),
           thinking="Negative axis numbers mean TSS-relative coordinates are on. Point at the toggle.",
           summary="TSS-relative coordinates are on",
           actions=[
               {"type": "explain", "anchor": "relative-coords",
                "text": "The axis is showing positions relative to a gene's TSS, so upstream is negative."},
               {"type": "explain", "anchor": "relative-coords",
                "text": "Switch it off here for genome coordinates."},
           ]),
    ]


    # ═════════════════════════════════════════════════════════════════════
    # 3. Other "stuck" questions
    # ═════════════════════════════════════════════════════════════════════

    def _q(**kw):
        kw.setdefault("category", "troubleshoot_stuck")
        return _r(**kw)


    STUCK_RECORDS: list[dict] = [
        # ── scan finds no peaks ───────────────────────────────────────────
        _q(id="st_scan_no_peaks", command="scan found no peaks",
           phrasings=["why doesn't Scan find anything", "no peaks were detected"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="Scan runs the enabled peak rules on the reads in view. No peaks usually means the rule thresholds are strict for this data, the view is very narrow or wide, or the rule's source doesn't exist in the dataset. Show the peak rules and settings, then let them rescan.",
           summary="Loosen the peak rules and scan again",
           actions=[
               {"type": "explain", "anchor": "scan-peaks-button",
                "text": "Scan runs the enabled peak rules on the reads in view."},
               {"type": "explain", "anchor": "peak-rules",
                "text": "If none are found, a rule's threshold may be too strict for this data; adjust it here."},
               {"type": "explain", "anchor": "peak-detection-settings",
                "text": "Minimum width and smoothing are in the sidebar's Peak Detection settings."},
               {"type": "try_it", "anchor": "scan-peaks-button", "wait_for": "peaks_scanned",
                "text": "Click Scan again after adjusting."},
           ]),

        _q(id="st_scan_no_peaks_zoom", command="why are there no peaks at this zoom?",
           phrasings=["peaks disappeared when I zoomed out"],
           context=V_WIDE_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "1.0 Mb")],
           thinking="Peaks are scanned from the reads in view, and zoomed_out_past_reads says no reads are loaded at 1.0 Mb. Zoom in to the read window, then scan.",
           summary="Zoom in so there are reads to scan",
           actions=[
               {"type": "explain", "anchor": "scan-peaks-button",
                "text": "Peaks are found from the reads in view, and at 1.0 Mb no reads are loaded."},
               _zoom_to(V_WIDE_2R, 100_000),
               {"type": "try_it", "anchor": "scan-peaks-button", "wait_for": "peaks_scanned",
                "text": "Now click Scan."},
           ]),

        _q(id="st_scan_no_peaks_daf", command="Scan finds nothing on my DAF data",
           phrasings=["no peaks on the DAF-seq dataset"],
           context=V_DM6_2R,
           thinking="DAF-seq calls accessibility from deamination; if the enabled rule reads a layer this dataset lacks, it finds nothing. Show the rules panel's Peaks tab so they can pick a rule suited to DAF.",
           summary="Pick a peak rule suited to DAF-seq",
           actions=[
               {"type": "explain", "anchor": "rules-peaks-tab",
                "text": "Each peak rule reads one signal; one built for another assay can find nothing on DAF-seq."},
               {"type": "explain", "anchor": "rules-peaks-tab",
                "text": "Enable an accessibility rule here for the DAF dataset."},
               {"type": "try_it", "anchor": "scan-peaks-button", "wait_for": "peaks_scanned",
                "text": "Then click Scan."},
           ]),

        # ── cluster does nothing ──────────────────────────────────────────
        _q(id="st_cluster_greyed", command="why is the Cluster button greyed out?",
           phrasings=["I can't click Cluster", "Cluster is disabled"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="Cluster needs selected peaks to build features from. Walk: scan if needed, select a peak, then Cluster — skipping what they already have.",
           summary="Cluster needs a selected peak",
           actions=[
               {"type": "explain", "anchor": "cluster-button",
                "text": "Cluster groups reads by their footprints at the selected peaks, so it needs a selected peak."},
               {"type": "try_it", "anchor": "scan-peaks-button", "wait_for": "peaks_scanned", "skip_if": "has_peaks",
                "text": "Click Scan to find peaks."},
               {"type": "try_it", "anchor": "peaks-track", "wait_for": "peak_selected", "skip_if": "has_selected_peak",
                "text": "Click a peak (Cmd/Ctrl+click for more)."},
               {"type": "try_it", "anchor": "cluster-button", "wait_for": "clustered",
                "text": "Now click Cluster."},
           ]),

        _q(id="st_cluster_nothing", command="I clicked Cluster and nothing happened",
           phrasings=["clustering does nothing"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           thinking="Likely no peaks selected, so there's nothing to cluster on. Check the peak step first; skip_if handles the case they do have one.",
           summary="Select a peak before clustering",
           actions=[
               {"type": "explain", "anchor": "peaks-track",
                "text": "Clustering uses the selected peaks; with none selected it has nothing to work on."},
               {"type": "try_it", "anchor": "peaks-track", "wait_for": "peak_selected", "skip_if": "has_selected_peak",
                "text": "Click a peak in the Peaks track."},
               {"type": "try_it", "anchor": "cluster-button", "wait_for": "clustered",
                "text": "Click Cluster again."},
               {"type": "explain", "anchor": "clusters-overview", "requires": "has_clusters",
                "text": "The clusters and their read counts appear here."},
           ]),

        _q(id="st_cluster_one_cluster", command="clustering only gives one cluster",
           phrasings=["all reads end up in the same cluster"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="One cluster: K may be low, the method may be combinatorial with little variation, or the selected peak isn't variable. Show the method and K controls and suggest more peaks.",
           summary="Raise K or select more variable peaks",
           actions=[
               {"type": "explain", "anchor": "cluster-method",
                "text": "K-means with a higher K usually separates reads best."},
               {"type": "explain", "anchor": "cluster-k",
                "text": "Set K here, a little higher than the groups you expect."},
               {"type": "explain", "anchor": "peaks-track",
                "text": "Selecting a peak where reads differ (some open, some closed) gives clusters something to split on."},
           ]),

        # ── genes not showing ─────────────────────────────────────────────
        _q(id="st_genes_names_differ", command="genes show on chr2R but my reads are on 2R",
           phrasings=["the chromosome names don't match"],
           context=V_DM6_2R,
           thinking="Different chromosome naming between annotation (chr2R) and data (2R). The browser matches aliases like chr2R/2R automatically; if the genome differs entirely, load the matching annotation.",
           summary="Chromosome names are matched automatically; check the genome",
           actions=[
               {"type": "explain", "anchor": "chrom-selector",
                "text": "The browser treats chr2R and 2R as the same chromosome, so genes and reads line up."},
               {"type": "explain", "anchor": "load-gtf",
                "text": "If genes still don't appear, the annotation may be for another genome; load the matching GTF here."},
           ]),

        _q(id="st_genes_wrong_genome", command="the genes are in the wrong places",
           phrasings=["genes don't line up with my reads"],
           context=V_HG38_MYC,
           thinking="Misplaced genes mean the annotation and the data use different assemblies (e.g. hg19 vs hg38). Point at the genome list and GTF loader.",
           summary="The annotation is probably from another assembly",
           actions=[
               {"type": "explain", "anchor": "genome-selector",
                "text": "Genes in the wrong place usually mean the annotation is for another assembly (e.g. hg19 vs hg38)."},
               {"type": "explain", "anchor": "load-gtf",
                "text": "Load the annotation for the assembly your reads were aligned to."},
           ]),

        _q(id="st_genes_no_gtf", command="there's no gene track",
           phrasings=["where are the genes"],
           context=V_DM6_2R,
           diagnostics=[no_gtf()],
           thinking="no_gtf says no annotation is loaded. Point at the loader; a genome from the list also brings one.",
           summary="No gene annotation is loaded",
           actions=[
               {"type": "explain", "anchor": "load-gtf",
                "text": "No gene annotation is loaded, so there's no gene track."},
               {"type": "explain", "anchor": "genome-selector",
                "text": "Pick your genome here to load its annotation, or load your own GTF above."},
           ]),

        # ── BAM won't load ────────────────────────────────────────────────
        _q(id="st_bam_wont_load", command="my BAM won't load",
           phrasings=["loading my file fails", "the BAM gives an error"],
           context=V_DM6_2R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="Common causes: wrong path, a file outside the allowed folders, or an unreadable index. A missing .bai is created automatically for local files. Walk the load options.",
           summary="Check the path and load again",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "Load File opens the picker; a missing .bai index is created automatically for local files."},
               {"type": "explain", "anchor": "load-by-path",
                "text": "Or paste the full path here; check it's spelled exactly and the file is readable."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Try loading it again."},
           ]),

        _q(id="st_bam_remote", command="how do I load a BAM from a URL? it doesn't work",
           phrasings=["the URL won't load"],
           context=V_DM6_2R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="Remote loading is in Data & Sessions → Load Remote URL; the server needs the index next to the file (.bai/.csi) and must allow range requests.",
           summary="Load it from Load Remote URL",
           actions=[
               {"type": "open_sidebar", "section": "file", "subsection": "file.remote"},
               {"type": "explain", "anchor": "load-remote-url",
                "text": "Paste the https:// or s3:// URL here; its .bai or .csi must sit next to it at the same URL."},
               {"type": "try_it", "anchor": "load-remote-url", "wait_for": "dataset_loaded",
                "text": "Load it."},
           ]),

        _q(id="st_bam_index", command="it says the index is missing",
           phrasings=["no .bai file"],
           context=V_DM6_2R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="Local BAMs get an index built automatically when the folder is writable; remote files need one uploaded next to them. Explain both.",
           summary="Local BAMs are indexed automatically",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "For a local BAM the browser builds the .bai index itself if the folder is writable."},
               {"type": "explain", "anchor": "load-remote-url",
                "text": "For a remote BAM, upload its .bai (or .csi) next to it; the browser can't create one remotely."},
           ]),

        # ── motifs wrong organism ─────────────────────────────────────────
        _q(id="st_motifs_organism", command="the motifs are for the wrong organism",
           phrasings=["JASPAR loaded human motifs for my fly data"],
           context=V_DM6_2R,
           thinking="Motif sets come from the track browser's hubs; pick the collection for the right taxon. Point at Open Tracks and Browse hubs.",
           summary="Pick the motif collection for your organism",
           actions=[
               {"type": "open_panel", "panel_type": "track-browser"},
               {"type": "explain", "anchor": "tracks-browse-hubs",
                "text": "Motif collections are listed by taxon here; pick the one for your organism."},
               {"type": "explain", "anchor": "panel-subtracks",
                "text": "Remove the old motif track from the panel's sub-tracks if you don't need it."},
           ]),

        _q(id="st_motifs_none", command="no motifs show up",
           phrasings=["the motif track is empty"],
           context=V_DM6_2L,
           diagnostics=[no_reference(False)],
           thinking="Motif scans need the reference sequence; no_reference (info) says none is loaded. Load one, then the motif track fills.",
           summary="Motif scans need a reference",
           actions=[
               {"type": "explain", "anchor": "genome-selector",
                "text": "Motif hits are found in the reference sequence, and no reference is loaded."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome (or load a FASTA)."},
           ]),

        # ── Footprints panel empty ────────────────────────────────────────
        _q(id="st_footprints_empty", command="the footprints panel is empty",
           phrasings=["nothing in the footprint analysis", "footprints panel shows nothing"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="The Footprints panel analyses a selected footprint; it's empty until one is Cmd/Ctrl+clicked. try_it footprint_selected, then explain what appears.",
           summary="Cmd/Ctrl+click a footprint to fill it",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The Footprints panel analyses the footprint you pick, so it starts empty."},
               {"type": "try_it", "anchor": "reads-track", "wait_for": "footprint_selected",
                "skip_if": "has_selected_footprint",
                "text": "Cmd/Ctrl+click any footprint in the reads."},
               {"type": "explain", "anchor": "selected-footprint", "requires": "has_selected_footprint",
                "text": "Its size range and position show here, with how many reads carry it."},
           ]),

        _q(id="st_footprints_click_nothing", command="clicking a footprint does nothing",
           phrasings=["I click the reads and nothing opens"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           thinking="A plain click doesn't select a footprint; Cmd/Ctrl+click does (Shift+click selects the read). Explain the modifiers and let them try.",
           summary="Use Cmd/Ctrl+click on a footprint",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "A plain click doesn't select; hold Cmd (Mac) or Ctrl and click a footprint."},
               {"type": "try_it", "anchor": "reads-track", "wait_for": "footprint_selected",
                "text": "Cmd/Ctrl+click a footprint now."},
               {"type": "explain", "anchor": "reads-track",
                "text": "Shift+click selects the whole read instead, for Read Stats."},
           ]),

        _q(id="st_footprints_saved_empty", command="the saved footprints tab is empty",
           phrasings=["I have no saved footprints"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="Saved tab is empty until a footprint is selected and saved. Chain: select (skip if selected), save (try_it footprint_saved), then the tab.",
           summary="Select a footprint and save it",
           actions=[
               {"type": "try_it", "anchor": "reads-track", "wait_for": "footprint_selected",
                "skip_if": "has_selected_footprint",
                "text": "Cmd/Ctrl+click a footprint in the reads."},
               {"type": "try_it", "anchor": "save-footprints", "wait_for": "footprint_saved",
                "requires": "has_selected_footprint",
                "text": "Click Save to add it as a saved footprint."},
               {"type": "explain", "anchor": "footprints-saved", "requires": "has_saved_footprints",
                "text": "Saved footprints appear here and are coloured on every read that carries one."},
           ]),

        # ── Read Stats empty ──────────────────────────────────────────────
        _q(id="st_read_stats_empty", command="read stats is empty",
           phrasings=["the read stats panel shows nothing"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="Read Stats summarises selected reads; it's empty until a read is Shift+clicked. try_it reads_selected, then the tabs.",
           summary="Shift+click reads to fill Read Stats",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "Read Stats describes the reads you select, so it starts empty."},
               {"type": "try_it", "anchor": "reads-track", "wait_for": "reads_selected", "skip_if": "has_selected_reads",
                "text": "Shift+click a read (Shift+drag selects several)."},
               {"type": "explain", "anchor": "read-stats-summary", "requires": "has_selected_reads",
                "text": "The summary shows their lengths, footprint counts and accessibility."},
               {"type": "explain", "anchor": "read-stats-table",
                "text": "The table lists each read; export it from here."},
           ]),

        _q(id="st_read_stats_how", command="how do I get stats for some reads? the panel is blank",
           phrasings=["read stats has no data"],
           context=V_DM6_3R,
           thinking="Same cause: no reads selected. Explain Shift+click and the cluster alternative.",
           summary="Select reads first",
           actions=[
               {"type": "try_it", "anchor": "reads-track", "wait_for": "reads_selected",
                "text": "Shift+click a read to select it."},
               {"type": "explain", "anchor": "read-stats-summary", "requires": "has_selected_reads",
                "text": "Read Stats now summarises the selection."},
           ]),

        # ── Co-accessibility odd ──────────────────────────────────────────
        _q(id="st_coacc_odd", command="the co-accessibility map looks weird",
           phrasings=["co-accessibility looks like noise"],
           context=V_DM6_2R,
           thinking="Co-accessibility compares accessibility between positions on the same molecules; it needs enough reads spanning both positions, so it looks noisy at low coverage or wide views. Open the panel and explain.",
           summary="Co-accessibility needs dense, spanning coverage",
           actions=[
               {"type": "open_panel", "panel_type": "co-accessibility"},
               {"type": "explain", "anchor": "coacc-matrix",
                "text": "Each cell compares two positions on the same molecules, so it needs many reads covering both."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "It reads best over a few kb at well-covered sites; wider views get noisy."},
               {"type": "explain", "anchor": "coacc-refresh",
                "text": "Refresh after moving to recompute."},
           ]),

        _q(id="st_coacc_empty", command="co-accessibility shows nothing",
           phrasings=["the co-accessibility panel is blank"],
           context=V_DM6_X, dataset_count=DS_FIBER_ONLY,
           diagnostics=[no_reads(L1)],
           thinking="no_reads_in_region: there are no reads here, so there's nothing to correlate. Move to coverage first.",
           summary="No reads here to compare",
           actions=[
               {"type": "explain", "anchor": "coacc-matrix",
                "text": "There are no reads in this region, so co-accessibility has nothing to compare."},
               {"type": "go_to_top_locus"},
               {"type": "explain", "anchor": "coacc-refresh",
                "text": "Refresh here once reads are in view."},
           ]),

        # ── Contact map blank ─────────────────────────────────────────────
        _q(id="st_contact_blank", command="the contact map is blank",
           phrasings=["the Contacts panel shows nothing"],
           context=V_DM6_2R,
           thinking="The contact map shows a loaded .mcool/.cool (or DAF-C) matrix; blank means none is loaded or the view is outside it. Open the panel and point at loading.",
           summary="Load a contact matrix first",
           actions=[
               {"type": "open_panel", "panel_type": "contact-map", "tab": "map"},
               {"type": "explain", "anchor": "contacts-map",
                "text": "The map draws a loaded contact matrix (.mcool / .cool); none is loaded yet."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Load the .mcool with Load File."},
           ]),

        _q(id="st_contact_resolution", command="the contact map is all grey",
           phrasings=["the matrix looks empty at this zoom"],
           context=V_WIDE_2R,
           thinking="A grey map at a wide view usually means the resolution is too fine for the region, or the region has few contacts. Zoom or change resolution in the map.",
           summary="Try a coarser resolution or zoom",
           actions=[
               {"type": "explain", "anchor": "contacts-map",
                "text": "At 1.0 Mb with a fine resolution, most cells have no contacts and look grey."},
               {"type": "explain", "anchor": "contacts-map",
                "text": "Pick a coarser resolution in the map settings, or zoom in."},
           ]),

        # ── Primers fail ──────────────────────────────────────────────────
        _q(id="st_primers_no_fasta", command="primer design fails",
           phrasings=["primers won't design", "Design primers errors"],
           context=V_DM6_2R,
           diagnostics=[no_reference(False)],
           thinking="no_reference (info): primers need the reference sequence. Point at the genome list, then the design button.",
           summary="Primers need a reference sequence",
           actions=[
               {"type": "explain", "anchor": "primers-design-button",
                "text": "Primer design reads the reference bases, and no reference is loaded."},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome or load a FASTA."},
               {"type": "try_it", "anchor": "primers-design-button", "wait_for": "primers_designed",
                "text": "Then click Design primers again."},
           ]),

        _q(id="st_primers_blast", command="it says no BLAST database",
           phrasings=["primer specificity check fails"],
           context=V_DM6_2R,
           thinking="The specificity check needs a BLAST database for the reference. It's configured in the Primers panel's Design tab; building one takes a minute.",
           summary="Set up the BLAST database in the Primers panel",
           actions=[
               {"type": "explain", "anchor": "primers-design-tab",
                "text": "The specificity check BLASTs primers against the genome, which needs a BLAST database."},
               {"type": "explain", "anchor": "primers-design-tab",
                "text": "Build or pick one for your reference in the Design tab's settings; it only needs building once."},
           ]),

        _q(id="st_primers_none_found", command="primer design found no primers",
           phrasings=["no primer pairs"],
           context=V_DM6_2R,
           thinking="No pairs means the target is too short/long for the product size, or the region is repetitive/GC-extreme. Point at the target (selected peak) and the design settings.",
           summary="Widen the target or relax the settings",
           actions=[
               {"type": "explain", "anchor": "peaks-track",
                "text": "Primers are designed around the selected peak; a very short or very long target can leave no valid pair."},
               {"type": "explain", "anchor": "primers-design-tab",
                "text": "Relax the product size or Tm range here and try again."},
           ]),

        # ── Session didn't restore ────────────────────────────────────────
        _q(id="st_session_partial", command="my session didn't restore everything",
           phrasings=["some things are missing after loading my session"],
           context=V_DM6_2R,
           thinking="Sessions store file paths; if a file moved, it can't be reopened. Unsaved analysis results (like designed primers) aren't stored. Point at Restore session and session settings.",
           summary="Moved files and unsaved results don't restore",
           actions=[
               {"type": "explain", "anchor": "restore-session",
                "text": "A session reopens files from their saved paths; any file that moved can't be restored."},
               {"type": "explain", "anchor": "session-settings",
                "text": "If a file moved, the session offers to relink it; point it at the new location."},
               {"type": "explain", "anchor": "save-session",
                "text": "Save again after a change so the next restore includes it."},
           ]),

        _q(id="st_session_lost", command="I lost my work after reloading",
           phrasings=["the page reloaded and everything is gone"],
           context=V_DM6_2R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="After a reload the workspace is empty (no_datasets). A crash-recovery banner or Restore session can bring it back.",
           summary="Restore your last session",
           actions=[
               {"type": "explain", "anchor": "restore-session",
                "text": "Restore session brings back your last saved (or autosaved) workspace."},
               {"type": "explain", "anchor": "save-session",
                "text": "Save a session whenever you want a point to come back to."},
           ]),

        # ── Slow ──────────────────────────────────────────────────────────
        _q(id="st_slow_general", command="the browser is really slow",
           phrasings=["why is it so laggy"],
           context=V_DM6_2R,
           thinking="Drawing cost scales with reads in view. The main levers: sample mode, a narrower view, the read window. Point at each.",
           summary="Draw fewer reads to speed it up",
           actions=[
               {"type": "explain", "anchor": "read-display-mode",
                "text": "Showing a sample of reads instead of all of them is the biggest speed-up."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "A narrower view loads and draws less."},
               {"type": "explain", "anchor": "read-window-setting",
                "text": "Lowering \"Show reads up to\" keeps wide views as coverage."},
           ]),

        _q(id="st_slow_big_bam", command="my big BAM takes forever to load",
           phrasings=["loading reads is slow"],
           context=V_HG38_MYC, dataset_count=DS_FIBER_ONLY,
           thinking="Large BAMs parse modification tags per read. BigBed footprint files are ~10x faster for browsing; also sample mode and narrow views help.",
           summary="Use BigBed for speed, and sample reads",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "BAMs are parsed read by read, which is slow for deep files."},
               {"type": "explain", "anchor": "load-dataset",
                "text": "A BigBed of the same footprints loads about ten times faster; load that for browsing."},
               {"type": "explain", "anchor": "read-display-mode",
                "text": "Meanwhile, show a sample of reads."},
           ]),

        # ── undo / broken ─────────────────────────────────────────────────
        _q(id="st_undo_broke", command="I clicked something and it messed everything up",
           phrasings=["I broke my view", "how do I go back"],
           context=V_DM6_2R,
           thinking="Most changes are undoable. Point at Undo and the history timeline.",
           summary="Undo it",
           actions=[
               {"type": "explain", "anchor": "undo",
                "text": "Undo (Cmd/Ctrl+Z) reverses the last change."},
               {"type": "try_it", "anchor": "undo", "wait_for": "undo_used",
                "text": "Click Undo."},
               {"type": "explain", "anchor": "history-timeline",
                "text": "The timeline jumps back to any earlier step."},
           ]),

        _q(id="st_undo_view", command="I lost the region I was looking at",
           phrasings=["how do I get back to where I was"],
           context=V_DM6_3R,
           thinking="The history timeline restores earlier views; back/forward navigation too. Point there.",
           summary="Go back through the history",
           actions=[
               {"type": "explain", "anchor": "history-timeline",
                "text": "The history timeline lists earlier steps, including where you were."},
               {"type": "explain", "anchor": "undo",
                "text": "Undo steps back one change at a time."},
           ]),

        _q(id="st_peaks_changed", command="my peaks changed when I moved",
           phrasings=["the selected peaks disappeared after navigating"],
           context=V_DM6_2R,
           thinking="Unlocked peaks are rescanned when the view moves. The lock keeps them.",
           summary="Lock the peaks",
           actions=[
               {"type": "explain", "anchor": "peaks-lock",
                "text": "Peaks are rescanned when you move, unless they're locked."},
               {"type": "explain", "anchor": "peaks-lock",
                "text": "Lock them here to keep the selection while you navigate."},
           ]),

        _q(id="st_clusters_lost", command="my clusters disappeared when I navigated",
           phrasings=["clusters reset after moving"],
           context=V_DM6_2R,
           thinking="Clusters belong to a region; moving far away clears them unless saved. Point at Snapshot / Saved.",
           summary="Save a clustering to keep it",
           actions=[
               {"type": "explain", "anchor": "cluster-toolbar",
                "text": "Clusters are computed for the peaks in view; moving away clears them."},
               {"type": "explain", "anchor": "clusters-saved", "requires": "has_clusters",
                "text": "Save a clustering here (Snapshot) to restore it when you come back."},
           ]),

        _q(id="st_tracks_empty", command="the track I added is empty",
           phrasings=["my BigWig track shows nothing"],
           context=V_DM6_2R,
           thinking="An added track is empty when it has no data here or its chromosome naming/assembly differs. Point at the tracks panel and the track's row.",
           summary="The track may not cover this region",
           actions=[
               {"type": "explain", "anchor": "open-tracks",
                "text": "An added track is empty where the file has no data, or when it's for another assembly."},
               {"type": "explain", "anchor": "tracks-add-file",
                "text": "Check it was built for this genome; you can add it again from here."},
           ]),
    ]


    # ═════════════════════════════════════════════════════════════════════
    # 4. Negative: diagnostics present, unrelated question
    # ═════════════════════════════════════════════════════════════════════

    def _n(**kw):
        kw.setdefault("category", "troubleshoot_negative")
        return _r(**kw)


    NEGATIVE_RECORDS: list[dict] = [
        _n(id="tn_k_with_filter", command="how do I change K?",
           phrasings=["where do I set the number of clusters"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_active(L1, 60, 300)],
           thinking="The question is about K. A filter warning is present but not blocking and unrelated; answer K only.",
           summary="K is in the cluster controls",
           actions=[
               {"type": "explain", "anchor": "cluster-controls-expand",
                "text": "Expand the Cluster controls here."},
               {"type": "explain", "anchor": "cluster-k",
                "text": "K sets how many clusters K-means makes."},
           ]),

        _n(id="tn_save_zoomed_out", command="how do I save my session?",
           phrasings=["how do I save my work"],
           context=V_WIDE_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "1.0 Mb")],
           thinking="Saving is unrelated to the zoom. Answer it; zoomed_out is blocking for reads, so one short aside at the end.",
           summary="Save from the top bar",
           actions=[
               {"type": "try_it", "anchor": "save-session", "wait_for": "session_saved",
                "text": "Click Save to download a session file with your datasets, view and settings."},
               {"type": "explain", "anchor": "restore-session",
                "text": "Restore session loads it back later."},
               {"type": "explain", "anchor": "zoom-out",
                "text": "Aside: at 1.0 Mb reads aren't drawn; zoom in below 100 kb to see them."},
           ]),

        _n(id="tn_colors_with_spanning", command="how do I colour reads by footprint size?",
           phrasings=["change the footprint colours"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[spanning_few(L1, 30, 200)],
           thinking="A colouring question; spanning-only is a warning, not related. Answer colouring only.",
           summary="Colours are set by labeling rules",
           actions=[
               {"type": "open_panel", "panel_type": "colormap", "tab": "rules"},
               {"type": "explain", "anchor": "labeling-rules",
                "text": "Labeling rules colour footprints by size range, layer or position."},
               {"type": "explain", "anchor": "add-label-rule",
                "text": "Add a rule with a size range and a colour here."},
           ]),

        _n(id="tn_primers_no_reads", command="how do I design primers?",
           phrasings=["where is primer design"],
           context=V_DM6_X, dataset_count=DS_FIBER_ONLY,
           diagnostics=[no_reads(L1)],
           thinking="Primer design works on the reference, not the reads, so no_reads doesn't block it. Answer the workflow; skip the reads aside since it doesn't affect primers.",
           summary="Select a peak or region, then Design primers",
           actions=[
               {"type": "open_panel", "panel_type": "primer-design", "tab": "design"},
               {"type": "explain", "anchor": "primers-design-tab",
                "text": "Primers are designed around the selected peak, or the view if none is selected."},
               {"type": "try_it", "anchor": "primers-design-button", "wait_for": "primers_designed",
                "text": "Click Design primers."},
               {"type": "explain", "anchor": "primers-order-tab",
                "text": "Save the pairs you like to the Order List for export."},
           ]),

        _n(id="tn_genome_with_filter_none", command="how do I switch genomes?",
           phrasings=["change the reference genome"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[filter_none(L1)],
           thinking="The question is the genome. filter_matches_none is blocking for reads but unrelated; answer, then a one-line aside.",
           summary="Pick another genome in the sidebar",
           actions=[
               {"type": "open_sidebar", "section": "genome", "subsection": "genome.online"},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick the genome here; its annotation loads with it."},
               {"type": "explain", "anchor": "clear-filter",
                "text": "Aside: a read filter currently hides every read; Clear filter shows them."},
           ]),

        _n(id="tn_what_is_fire_with_loading", command="what is a FIRE element?",
           phrasings=["what does FIRE mean"],
           context=V_DM6_2R,
           diagnostics=[still_loading(L1)],
           thinking="A concept question; the loading info is irrelevant. Answer the concept and show the layer.",
           summary="FIRE marks accessible regions on each molecule",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "FIRE elements are the accessible stretches called on each molecule, like single-molecule DNase hypersensitive sites."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Show or hide them with the FIRE layer toggle."},
           ]),

        _n(id="tn_export_with_collapsed", command="how do I export a figure?",
           phrasings=["make a PDF of this view"],
           context=V_DM6_2R, dataset_count=DS_THREE,
           diagnostics=[row_collapsed(L3, blocking=False)],
           thinking="Export question. A collapsed row (info) would be left out of the figure — worth one clause since it affects the export.",
           summary="Export from the top bar",
           actions=[
               {"type": "explain", "anchor": "export-figure",
                "text": "Export saves the current view as PNG, PDF or SVG."},
               {"type": "explain", "anchor": "layout-rows",
                "text": "A collapsed row isn't included; expand it first if you want it in the figure."},
           ]),

        _n(id="tn_tour_with_no_gtf", command="give me a tour",
           phrasings=["show me around"],
           context=V_DM6_2R,
           diagnostics=[no_gtf()],
           thinking="They want the tour. The no_gtf info doesn't matter; the tour uses its own demo.",
           summary="Start the guided tour",
           actions=[
               {"type": "explain", "anchor": "guided-tour",
                "text": "Click Tour; it walks through loading, peaks, clustering and the panels on a demo dataset."},
           ]),
    ]

    # ── More diagnostics variants ────────────────────────────────────
    DIAGNOSTIC_RECORDS += [
        _t(id="ts_still_loading_wide", command="the panel is blank after I zoomed",
           phrasings=["it went blank when I zoomed in"],
           context={"chrom": "2R", "start": 9_955_000, "end": 9_995_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           diagnostics=[still_loading(L1)],
           raw_state=_raw({"chrom": "2R", "start": 9_955_000, "end": 9_995_000},
                          [_panel("p1", L1, shown=0, working=0, loading=True)], labels=(L1,)),
           thinking="still_loading (info) only: after the zoom the new window's reads are loading. Nothing to fix.",
           summary="The new view is loading",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The reads for the new view are still loading; they'll draw in a moment."},
           ]),

        _t(id="ts_branch_empty_moved", command="the reads disappeared inside my subcluster after I moved",
           phrasings=["my branch is empty now"],
           context=V_DM6_2L, dataset_count=DS_FIBER_ONLY,
           diagnostics=[branch_empty(L1)],
           thinking="branch_scope_empty: the subcluster branch's reads were picked at the old locus, so none are here. Go back to the root branch.",
           summary="The branch's reads are from another locus",
           actions=[
               {"type": "explain", "anchor": "cluster-branches", "requires": "has_clusters",
                "text": "This subcluster branch was made at another locus, so none of its reads are here."},
               {"type": "explain", "anchor": "cluster-branches",
                "text": "Click the root in the branch map to see this region's reads."},
           ]),

        _t(id="ts_no_reference_hg", command="there are no chromosomes to pick",
           phrasings=["the chromosome dropdown is empty"],
           context=V_EMPTY, dataset_count=0,
           diagnostics=[no_reference(True), no_datasets()],
           thinking="no_reference is blocking: no genome, so no chromosome list. Open the reference section and let them pick one.",
           summary="Pick a genome to get chromosomes",
           actions=[
               {"type": "explain", "anchor": "chrom-selector",
                "text": "The chromosome list comes from the genome, and none is loaded."},
               {"type": "open_sidebar", "section": "genome", "subsection": "genome.online"},
               {"type": "try_it", "anchor": "genome-selector", "wait_for": "genome_loaded",
                "text": "Pick your genome (hg38, mm10, dm6, …) from the list."},
           ]),

        _t(id="ts_layers_after_toggle", command="I clicked something and the footprints vanished",
           phrasings=["the footprints disappeared suddenly"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[layers_hidden(True)],
           thinking="layers_hidden blocking — a layer toggle was switched off. Point at the layers (Undo also works).",
           summary="The footprint layers were switched off",
           actions=[
               {"type": "explain", "anchor": "layer-toggles",
                "text": "The footprint, nucleosome and TF layers are switched off."},
               {"type": "explain", "anchor": "layer-toggles",
                "text": "Switch them back on here, or press Undo."},
           ]),

        _t(id="ts_chrom_missing_mito", command="no reads on chrM",
           phrasings=["the mitochondrial genome is empty"],
           context={"chrom": "chrM", "start": 0, "end": 16_569, "currentGenome": "hg38"}, dataset_count=DS_FIBER_ONLY,
           diagnostics=[chrom_missing(L1, "chrM")],
           thinking="chrom_missing_in_dataset: the file has no chrM (often filtered out during alignment). Explain; nothing to change in the browser.",
           summary="The dataset has no mitochondrial reads",
           actions=[
               {"type": "explain", "anchor": "chrom-selector",
                "text": '"Embryo 2-4hr" has no reads on chrM; mitochondrial reads are often removed during alignment.'},
               {"type": "explain", "anchor": "chrom-selector",
                "text": "Pick a nuclear chromosome here to browse the reads."},
           ]),

        _t(id="ts_fetch_failed_moved", command="it worked yesterday, now no reads load",
           phrasings=["my data stopped showing up"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[fetch_failed(L1, "File not found")],
           thinking="fetch_failed with 'File not found': the file moved since it was loaded. Point at Loaded Datasets and loading it from its new place.",
           summary="The file has moved",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": 'The file for "Embryo 2-4hr" wasn\'t found where it was loaded from.'},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "Remove it here, then load it from its new location."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Load the file again with Load File."},
           ]),

        _t(id="ts_filter_none_linked", command="the linked panels both went empty",
           phrasings=["both copies lost their reads"],
           context=V_DM6_2R,
           diagnostics=[filter_none(L1), filter_none(L2)],
           thinking="filter_matches_none on both panels: one filter applied across linked panels matched nothing. Clear it once.",
           summary="The filter matches nothing in either panel",
           actions=[
               {"type": "explain", "anchor": "clear-filter",
                "text": "The read filter applies to both linked panels, and matches no reads in either."},
               {"type": "try_it", "anchor": "clear-filter", "wait_for": "filter_cleared",
                "text": "Click Clear filter."},
           ]),

        _t(id="ts_quality_all_tf", command="my TF footprints are all gone",
           phrasings=["no TF calls show"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[quality_all(L1)],
           thinking="quality_filter_hides_all blocking: every read is removed — often a strict TF quality cutoff. Point at the labeling quality tab and the toolbar cutoffs.",
           summary="The quality cutoff removes everything",
           actions=[
               {"type": "explain", "anchor": "quality-filters",
                "text": "The read quality settings remove every read in \"Embryo 2-4hr\"."},
               {"type": "explain", "anchor": "labeling-quality",
                "text": "Per-layer cutoffs (like a TF quality) live here; lower them."},
           ]),

        _t(id="ts_spanning_none_copy", command="the copy shows no reads",
           phrasings=["my second panel is empty"],
           context=V_DM6_2R,
           diagnostics=[spanning_none(L2, 88), at_other_locus(L2)],
           thinking="spanning_only_hides blocking in the copy (none of 88 span its own view), and the copy is at its own region. Spanning-only is global; turn it off or narrow the copy's region.",
           summary="Spanning-only hides the copy's reads",
           actions=[
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only is on, and none of the 88 reads in the copy's region spans its whole view."},
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": "Narrow the copy's region here, or turn Spanning only off."},
           ]),

        _t(id="ts_no_datasets_after_genome", command="I picked a genome but nothing shows",
           phrasings=["I loaded hg38 and the tracks are empty"],
           context=V_HG38_MYC, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="The genome is loaded; no_datasets is the blocking cause. The genome gives chromosomes and genes; reads come from a dataset.",
           summary="The genome is loaded; now load reads",
           actions=[
               {"type": "explain", "anchor": "load-dataset",
                "text": "The genome is loaded, but no dataset is, so there are no reads yet."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Load your BAM or BigBed with Load File."},
           ]),

        _t(id="ts_zoomed_out_two_panels", command="why can't I see any molecules?",
           phrasings=["where are the individual molecules"],
           context=V_WIDE_MYC, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "1.5 Mb")],
           thinking="zoomed_out_past_reads is blocking at 1.5 Mb. Zoom in to the read window myself; molecules are drawn below it.",
           summary="Zoomed out past the read window",
           actions=[
               {"type": "explain", "anchor": "zoom-out",
                "text": "At 1.5 Mb the view is past the 100 kb read window, so molecules are summarised as coverage."},
               _zoom_to(V_WIDE_MYC, 100_000),
               {"type": "explain", "anchor": "reads-track",
                "text": "Each row here is now one molecule."},
           ]),

        _t(id="ts_strand_empty_both_ok", command="the CT panel of my DAF data is empty",
           phrasings=["CT strand shows nothing"],
           context=V_DM6_2L,
           diagnostics=[strand_empty(L2, "CT")],
           thinking="strand_panel_empty for CT in the DAF dataset. Coverage by strand varies; offer the strand chip.",
           summary="No CT-strand reads here",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": 'The CT-strand panel of "Embryo 2.5-3hr DAF" has no CT reads in this region.'},
               {"type": "explain", "anchor": "strand-chip",
                "text": "Switch the chip to both strands, or look at the GA panel."},
           ]),
    ]

    # ── More raw-state cases ─────────────────────────────────────────
    STATE_RECORDS += [
        _s(id="tss_other_locus_expected", command="is my copy panel broken?",
           phrasings=["why is the copy somewhere else"],
           context=V_DM6_2R,
           diagnostics=[at_other_locus(L1)],
           raw_state=_raw(V_DM6_2R, [
               _panel("p1", L1, shown=220),
               _panel("p2", L1, shown=140, own_view={"chrom": "2R", "start": 9_990_000, "end": 9_993_000}),
           ]),
           thinking="Info only: the copy is at its own region (2R:9,990,000-9,993,000) with 140 reads. It works as designed.",
           summary="The copy is working; it shows its own region",
           actions=[
               {"type": "explain", "anchor": "panel-location-bar", "requires": "has_panel_copy",
                "text": "The copy isn't broken: it's unlinked and shows 2R:9,990,000-9,993,000, with 140 reads."},
               {"type": "explain", "anchor": "panel-link",
                "text": "Link it if you want it to follow the main view."},
           ]),

        _s(id="tss_reads_thin_rows", command="the reads are tiny",
           phrasings=["I can barely see the reads"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=1800)], labels=(L1,)),
           thinking="1,800 reads fill the panel, so each row is thin. Row height and sampling help.",
           summary="Many reads make thin rows",
           actions=[
               {"type": "explain", "anchor": "row-height",
                "text": "1,800 reads share the panel, so each row is thin; set a taller row height here."},
               {"type": "explain", "anchor": "read-display-mode",
                "text": "Or show a sample of reads so each gets more room."},
           ]),

        _s(id="tss_all_fine_filtered_none", command="why does it look different from before?",
           phrasings=["something changed"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [_panel("p1", L1, shown=210, clustered=True), _panel("p2", L2, shown=150)]),
           thinking="No diagnostics; state shows the first panel is clustered now — reads are grouped and ordered by cluster. Likely what changed; Undo if unwanted.",
           summary="The reads are now clustered",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The first panel is clustered, so its reads are grouped by cluster instead of by position."},
               {"type": "explain", "anchor": "undo",
                "text": "Undo returns to the previous view if you didn't mean to."},
           ]),

        _s(id="tss_wide_but_under_window", command="why is it so crowded?",
           phrasings=["too many reads on screen"],
           context={"chrom": "2R", "start": 9_910_000, "end": 9_995_000, "currentGenome": "dm6"},
           dataset_count=DS_FIBER_ONLY,
           raw_state=_raw({"chrom": "2R", "start": 9_910_000, "end": 9_995_000},
                          [_panel("p1", L1, shown=2600)], labels=(L1,)),
           thinking="85 kb view, 2,600 reads drawn. It's a lot of molecules; zoom in or sample.",
           summary="2,600 reads across 85 kb",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The panel draws 2,600 reads across 85 kb."},
               {"type": "explain", "anchor": "zoom-in",
                "text": "Zoom in to a few kb to see individual molecules clearly."},
           ]),

        _s(id="tss_daf_only_strand_ok", command="why is one strand panel smaller?",
           phrasings=["the GA panel has fewer reads"],
           context=V_DM6_2R,
           raw_state=_raw(V_DM6_2R, [
               _panel("p1", L1, shown=200),
               _panel("p2", L2, shown=120, strand="CT"),
               _panel("p3", L2, shown=35, strand="GA"),
           ]),
           thinking="State: CT 120, GA 35 — both loaded, just unequal strand coverage. Normal for DAF-seq; nothing hidden.",
           summary="The strands have unequal coverage here",
           actions=[
               {"type": "explain", "anchor": "strand-chip",
                "text": "The CT panel has 120 reads and the GA panel 35; strand coverage just differs here."},
               {"type": "explain", "anchor": "go-to-reads",
                "text": "Go to reads finds windows with more coverage if you want balanced strands."},
           ]),
    ]

    # ── More stuck questions ─────────────────────────────────────────
    STUCK_RECORDS += [
        _q(id="st_clusters_panel_empty", command="the clusters panel is empty",
           phrasings=["the Clusters panel shows nothing"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="The Clusters panel shows results after clustering; it's empty until the user clusters. Chain: scan (skip if peaks), select a peak (skip if selected), Cluster, then the panel.",
           summary="Cluster reads to fill the panel",
           actions=[
               {"type": "explain", "anchor": "cluster-toolbar",
                "text": "The Clusters panel shows a clustering's results, so it's empty until you cluster."},
               {"type": "try_it", "anchor": "scan-peaks-button", "wait_for": "peaks_scanned", "skip_if": "has_peaks",
                "text": "Click Scan to find peaks."},
               {"type": "try_it", "anchor": "peaks-track", "wait_for": "peak_selected", "skip_if": "has_selected_peak",
                "text": "Click a peak to select it."},
               {"type": "try_it", "anchor": "cluster-button", "wait_for": "clustered",
                "text": "Click Cluster."},
               {"type": "explain", "anchor": "clusters-overview", "requires": "has_clusters",
                "text": "Each cluster now appears here with its read count and profile."},
           ]),

        _q(id="st_vplot_empty", command="the V-plot is empty",
           phrasings=["no V-plot shows"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           thinking="The V-plot is per cluster, so it needs a clustering first. requires has_clusters.",
           summary="The V-plot needs clusters",
           actions=[
               {"type": "explain", "anchor": "cluster-button",
                "text": "The V-plot is drawn per cluster, so it needs a clustering first."},
               {"type": "try_it", "anchor": "cluster-button", "wait_for": "clustered", "skip_if": "has_clusters",
                "text": "Select a peak and click Cluster."},
               {"type": "explain", "anchor": "clusters-vplot", "requires": "has_clusters",
                "text": "Each cluster's V-plot shows footprint size against position."},
           ]),

        _q(id="st_transcription_empty", command="the transcription panel shows nothing",
           phrasings=["Pol II analysis is empty"],
           context=V_DM6_2R,
           thinking="The Transcription panel works on selected genes; it's empty with none. Ask them to click a gene.",
           summary="Select a gene first",
           actions=[
               {"type": "explain", "anchor": "reads-track",
                "text": "The Transcription panel analyses the selected genes, and none is selected."},
               {"type": "explain", "anchor": "search-bar",
                "text": "Click a gene in the gene track (or search it) to select it."},
               {"type": "explain", "anchor": "transcription-distribution", "requires": "has_selected_gene",
                "text": "Its paused, elongating and free states then appear here."},
           ]),

        _q(id="st_go_to_reads_nothing", command="Go to reads does nothing",
           phrasings=["the go to reads button doesn't move"],
           context=V_DM6_2R, dataset_count=0,
           diagnostics=[no_datasets()],
           thinking="Go to reads finds covered windows in the loaded data; with no dataset (blocking) there's nothing to find.",
           summary="Go to reads needs a loaded dataset",
           actions=[
               {"type": "explain", "anchor": "go-to-reads",
                "text": "Go to reads jumps to windows with reads, and no dataset is loaded."},
               {"type": "try_it", "anchor": "load-dataset", "wait_for": "dataset_loaded",
                "text": "Load a dataset first."},
           ]),

        _q(id="st_haplotype_blank", command="the haplotype comparison is blank",
           phrasings=["compare haplotypes shows nothing"],
           context=V_DM6_2R,
           thinking="Haplotype comparison needs two references or haplotype-tagged data; the form in Contacts > Compare sets it up. Open it and point at the form and reference pairs.",
           summary="Set up the comparison first",
           actions=[
               {"type": "open_panel", "panel_type": "contact-map", "tab": "compare"},
               {"type": "explain", "anchor": "haplotype-form",
                "text": "Pick the two haplotypes (or references) and the region to compare here."},
               {"type": "explain", "anchor": "reference-pairs",
                "text": "Two haplotype references are loaded as a pair here in the sidebar."},
           ]),

        _q(id="st_cant_find_clusters_panel", command="where did the clusters panel go?",
           phrasings=["I closed the clusters panel"],
           context=V_DM6_2R,
           thinking="Opening panels is allowed. Open it for them and note the details button.",
           summary="Reopen the Clusters panel",
           actions=[
               {"type": "open_panel", "panel_type": "cluster-detail", "tab": "overview"},
               {"type": "explain", "anchor": "analysis-strip",
                "text": "Analysis panels open from this strip; closing one keeps your clusters."},
           ]),

        _q(id="st_export_blank", command="my exported figure is blank",
           phrasings=["the PDF came out empty"],
           context=V_WIDE_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[zoomed_out(L1, "1.0 Mb")],
           thinking="The export draws what's on screen; zoomed_out_past_reads means only coverage is drawn at 1.0 Mb. Zoom in to the read window, then export.",
           summary="Zoom in before exporting",
           actions=[
               {"type": "explain", "anchor": "export-figure",
                "text": "The export draws the current view, and at 1.0 Mb only coverage is shown."},
               _zoom_to(V_WIDE_2R, 100_000),
               {"type": "explain", "anchor": "export-figure",
                "text": "Export again now that the reads are drawn."},
           ]),
    ]

    # ── More negatives ───────────────────────────────────────────────
    NEGATIVE_RECORDS += [
        _n(id="tn_haplotype_with_fetch_failed", command="how do I look at a haplotype?",
           phrasings=["compare two haplotypes"],
           context=V_DM6_2R,
           diagnostics=[fetch_failed(L2)],
           thinking="A how-to about haplotypes. The DAF fetch failure is blocking for that panel but unrelated; answer, then one short aside.",
           summary="Compare haplotypes in the Contacts panel",
           actions=[
               {"type": "explain", "anchor": "reference-pairs",
                "text": "Load both haplotype references as a pair here."},
               {"type": "open_panel", "panel_type": "contact-map", "tab": "compare"},
               {"type": "explain", "anchor": "haplotype-form",
                "text": "Pick the region and the two haplotypes to compare side by side."},
               {"type": "explain", "anchor": "loaded-datasets",
                "text": "Aside: \"Embryo 2.5-3hr DAF\" failed to load here; check its file under Loaded Datasets."},
           ]),

        _n(id="tn_what_is_spanning", command="what is a spanning read?",
           phrasings=["what does spanning mean"],
           context=V_DM6_2R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[spanning_few(L1, 50, 220)],
           thinking="A definition question; the spanning warning is related, so use it as the example.",
           summary="A read that covers the whole view",
           actions=[
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "A spanning read covers the whole view from edge to edge; here 50 of 220 do."},
               {"type": "explain", "anchor": "spanning-toggle",
                "text": "Spanning only shows just those, which is useful when comparing complete molecules."},
           ]),

        _n(id="tn_undo_with_quality", command="how do I undo?",
           phrasings=["undo my last change"],
           context=V_DM6_3R, dataset_count=DS_FIBER_ONLY,
           diagnostics=[quality_most(L1, 150, 260)],
           thinking="Undo question; the quality warning is unrelated and not blocking. Answer only.",
           summary="Undo and the history timeline",
           actions=[
               {"type": "explain", "anchor": "undo",
                "text": "Undo (Cmd/Ctrl+Z) reverses the last change; Redo brings it back."},
               {"type": "explain", "anchor": "history-timeline",
                "text": "The timeline jumps back to any earlier step."},
           ]),
    ]

    return {
        "diagnostics": DIAGNOSTIC_RECORDS,
        "state": STATE_RECORDS,
        "stuck": STUCK_RECORDS,
        "negative": NEGATIVE_RECORDS,
    }


_SECTIONS: dict[str, list[dict]] | None = None


def build_records() -> list[dict]:
    """Every troubleshooting record, in section order (built once)."""
    global _SECTIONS
    if _SECTIONS is None:
        _SECTIONS = _build()
    return [record for section in _SECTIONS.values() for record in section]


def sections() -> dict[str, list[dict]]:
    build_records()
    return dict(_SECTIONS)


def __getattr__(name: str):
    # `RECORDS` (and the per-section lists) as module attributes, built on first use.
    if name == "RECORDS":
        return build_records()
    names = {"DIAGNOSTIC_RECORDS": "diagnostics", "STATE_RECORDS": "state",
             "STUCK_RECORDS": "stuck", "NEGATIVE_RECORDS": "negative"}
    if name in names:
        return sections()[names[name]]
    raise AttributeError(name)
