"""What to draw: the browser's view, from a session, the open tab, or defaults.

Everything a track needs is in ``FigureSpec.fe``, the browser's serialized
frontend state (the same dict sessions and the live tab store: panels,
activeColormap, clusterAssignments, readSortOrder, peaksByRule,
compositeTracks, readRowHeight, ...), filled in with the browser's defaults
for anything missing. Tracks read it with the browser's own field names.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Optional

from services.figure.defaults import (
    apply_follow_active_layers, refresh_auto_source_colors, dataset_dict, default_metaprofile, default_sub_tracks, defaults,
)


@dataclass
class TrackSpec:
    type: str                 # 'axis', 'fire', 'reads', 'gene', 'sequence', 'composite-<id>', ...
    height: Optional[float]   # heightOverride from the browser, else None (track default)
    composite: Optional[dict] = None  # the CompositeTrack for composite-* tracks


@dataclass
class PanelSpec:
    id: str
    dataset_id: str
    state_key: str            # key for per-panel state (clusters, sort, filters)
    label: str
    color: str
    dataset: dict             # /api/datasets shape (available_layers, ...)
    tracks: list[TrackSpec]
    row: int = 0              # browser layout: panels in a row sit side by side
    column: Optional[int] = None         # panels sharing a column in a row stack vertically
    width_fraction: Optional[float] = None  # share of the row's width
    strand: Optional[str] = None           # DAF-seq panel showing one strand ('CT' / 'GA')
    # A panel with its own location (viewportOverride: a copy at another locus): (chrom, start, end).
    region: Optional[tuple] = None
    # Rows the panel has but does not show (minimized or removed): the SV and coverage rows,
    # drawn inside the reads here, stay out (fb-n11-tracks). A row it lacks shows (older saves).
    rows_off: set = field(default_factory=set)


@dataclass
class FigureSpec:
    chrom: str
    start: int
    end: int
    width: float              # page width in CSS px
    panels: list[PanelSpec]
    fe: dict                  # frontend state with defaults filled in
    source: str               # 'session' | 'current' | 'defaults'
    title: Optional[str] = None
    include_coords: bool = False
    read_row_height: Optional[float] = None   # px per read row (None: from the view)
    max_reads: Optional[int] = None            # reads drawn per panel (None: from the view)
    options: dict = field(default_factory=dict)  # scripted-figure options (services/figure/options.py)
    max_reads_by_panel: dict = field(default_factory=dict)  # panel id -> reads drawn (overrides max_reads)
    meta: Optional[dict] = None  # a meta-locus figure: the pool record (services/figure/meta_locus.py MetaView.record)

    def panel_max_reads(self, panel) -> Optional[int]:
        return self.max_reads_by_panel.get(panel.id, self.max_reads)

    def hidden(self) -> set:
        return set(self.options.get("hide_tracks") or ())


# Browser-equivalent names for the older /api/render ``tracks`` list.
LEGACY_TRACK_NAMES = {"axis": "axis", "peaks": "fire", "reads": "reads", "genes": "gene", "gene": "gene",
                      "sequence": "sequence", "meta": "composite", "consensus": "consensus"}


def _merge_defaults(fe: dict) -> dict:
    d = defaults()
    merged = copy.deepcopy(d["settings"])
    merged["activeColormap"] = copy.deepcopy(d["activeColormap"])
    for key, value in (fe or {}).items():
        if value is not None:
            merged[key] = value
    return merged


def resolve_frontend(state, source: str = "auto", session: Optional[dict] = None) -> tuple[dict, dict, str]:
    """(frontend state, viewport, source used). ``source``: auto|session|current|defaults."""
    if source in ("auto", "session") and session:
        return session.get("frontend") or {}, session.get("viewport") or {}, "session"
    if source == "session":
        raise ValueError("source='session' needs a session")
    live = getattr(state, "live_figure_state", None)
    if source in ("auto", "current") and live:
        return live.get("frontend_state") or {}, live.get("viewport") or {}, "current"
    if source == "current":
        raise ValueError("No browser view to render; open the browser or use source='defaults'")
    return {}, {}, "defaults"


def _dataset_order(state) -> list[str]:
    order = list(getattr(state, "dataset_order", []) or [])
    return order or list(getattr(state, "datasets", {}) or {})


def _panel_region(view) -> Optional[tuple]:
    if not isinstance(view, dict):
        return None
    try:
        chrom, start, end = str(view["chrom"]), int(view["start"]), int(view["end"])
    except (KeyError, TypeError, ValueError):
        return None
    return (chrom, start, end) if chrom and end > start >= 0 else None


def build_panels(state, fe: dict, dataset_ids: Optional[list[str]] = None,
                 track_types: Optional[list[str]] = None,
                 default_ids: Optional[list[str]] = None,
                 hidden: Optional[set] = None) -> list[PanelSpec]:
    """Dataset panels as the browser shows them (or its defaults when there is no view)."""
    datasets = {ds_id: dataset_dict(ds) for ds_id, ds in (getattr(state, "datasets", {}) or {}).items()}
    fe_datasets = {d.get("id"): d for d in fe.get("datasets") or [] if isinstance(d, dict)}
    composites = [c for c in fe.get("compositeTracks") or [] if isinstance(c, dict)]
    enabled_mod_types = fe.get("enabledModTypes") if isinstance(fe.get("enabledModTypes"), dict) else None
    if not composites:
        composites = [default_metaprofile(datasets.values(), enabled_mod_types)]
        fe["compositeTracks"] = composites
    else:
        # The default metaprofile follows the active layers, as in the browser. fe carries the result too: the
        # profile requests (tracks/composite.py) read fe["compositeTracks"], and must ask for what is drawn.
        composites = apply_follow_active_layers(composites, enabled_mod_types, datasets.values())
        # Default colours too, as the browser's cart takes them (a saved session's old colours).
        composites = refresh_auto_source_colors(composites, datasets.values())
        fe["compositeTracks"] = composites
    # Sources following a layer the user recoloured (services/figure/layer_colours.py) take its colour.
    from services.figure.layer_colours import follow_sources
    composites = follow_sources(composites, fe)
    fe["compositeTracks"] = composites
    by_id = {c.get("id"): c for c in composites}

    saved_fe = [p for p in fe.get("panels") or []
                if isinstance(p, dict) and (p.get("contentType") or "dataset") == "dataset"
                and p.get("datasetId") in datasets]
    panels_fe = [p for p in saved_fe if not p.get("collapsed")]
    # Defaults only when the view has no panels for loaded datasets: a view
    # whose dataset panels are all collapsed shows none.
    if not saved_fe:
        # No saved panels: a session's own datasets (in its order), else the server's.
        order = default_ids if default_ids is not None else _dataset_order(state)
        panels_fe = [{"id": ds_id, "datasetId": ds_id, "subTracks": default_sub_tracks(composites)}
                     for ds_id in order if ds_id in datasets]
    if dataset_ids:
        # Requested datasets in the requested order: the view's panel for each
        # where there is one, else a default panel.
        missing = [ds_id for ds_id in dataset_ids if ds_id not in datasets]
        if missing:
            raise ValueError("Datasets not loaded: " + ", ".join(missing))
        existing = {}
        for p in panels_fe:
            existing.setdefault(p.get("datasetId"), []).append(p)
        panels_fe = [p for ds_id in dataset_ids
                     for p in (existing.get(ds_id) or [{"id": ds_id, "datasetId": ds_id, "subTracks": default_sub_tracks(composites)}])]

    wanted_types = None
    if track_types:
        wanted_types = {LEGACY_TRACK_NAMES.get(t, t) for t in track_types}

    panels: list[PanelSpec] = []
    used_ids: set[str] = set()
    for p in panels_fe:
        ds_id = p["datasetId"]
        # Panel ids key per-panel caches: two panels of a dataset without ids
        # of their own (strand panels, a copy at another locus) must not share one.
        panel_id = str(p.get("id") or ds_id)
        if panel_id in used_ids:
            n = 2
            while f"{panel_id}#{n}" in used_ids:
                n += 1
            panel_id = f"{panel_id}#{n}"
        used_ids.add(panel_id)
        ds = {**datasets[ds_id], **{k: v for k, v in fe_datasets.get(ds_id, {}).items() if k in ("label", "color")}}
        tracks: list[TrackSpec] = []
        # Rows the figure leaves out (hide_tracks) count as hidden rows whether or not the panel lists them:
        # sessions saved before the SV and coverage rows were tracks of their own have no row to hide.
        rows_off: set[str] = set(hidden or ())
        for t in p.get("subTracks") or default_sub_tracks(composites):
            if isinstance(t, dict) and (not t.get("visible", True) or t.get("removed")):
                rows_off.add(str(t.get("type")))
            if not isinstance(t, dict) or not t.get("visible", True) or t.get("removed"):
                continue
            kind = str(t.get("type"))
            if hidden and (kind in hidden or (kind.startswith("composite-") and "composite" in hidden)):
                continue
            composite = None
            if kind.startswith("composite-"):
                composite = by_id.get(kind[len("composite-"):])
                if not composite or not composite.get("visible", True):
                    continue
            if wanted_types is not None:
                base = "composite" if kind.startswith("composite-") else kind
                if base not in wanted_types and kind not in wanted_types:
                    continue
            tracks.append(TrackSpec(kind, t.get("heightOverride"), composite))
        panels.append(PanelSpec(
            id=panel_id, dataset_id=ds_id, state_key=str(p.get("stateKey") or ds_id),
            label=str(ds.get("label") or ds_id), color=str(ds.get("color") or "#3b82f6"), dataset=ds, tracks=tracks,
            row=int(p["layoutRow"]) if p.get("layoutRow") is not None else (1 if p.get("layoutPosition") == "column" else 0),
            column=p.get("layoutColumn"), width_fraction=p.get("widthFraction"),
            strand=p.get("strand") if p.get("strand") in ("CT", "GA") else None,
            region=_panel_region(p.get("viewportOverride")),
            rows_off=rows_off,
        ))
    return panels


def resolve_spec(state, *, chrom: Optional[str] = None, start: Optional[int] = None, end: Optional[int] = None,
                 source: str = "auto", session: Optional[dict] = None, width: Optional[float] = None,
                 dataset_ids: Optional[list[str]] = None, tracks: Optional[list[str]] = None,
                 title: Optional[str] = None, include_coords: bool = False,
                 read_row_height: Optional[float] = None, max_reads: Optional[int] = None,
                 overrides: Optional[dict] = None, read_ids: Optional[list[str]] = None,
                 options: Optional[dict] = None) -> FigureSpec:
    fe_raw, viewport, used = resolve_frontend(state, source, session)
    fe = _merge_defaults(fe_raw)
    if used == "defaults":  # no tab, no session: what the notebook set (services/figure/notebook_settings.py)
        from services.figure.notebook_settings import apply as apply_notebook_settings
        apply_notebook_settings(fe, state)
    for key, value in (overrides or {}).items():
        if key == "_enableModTypes":  # turn layers on without dropping the rest
            fe["enabledModTypes"] = {**(fe.get("enabledModTypes") or {}), **value}
        else:
            fe[key] = value
    # Region: explicit, else the view's, else the last region the server served.
    view_region = (viewport.get("chrom") or fe_raw.get("chrom"), viewport.get("start", fe_raw.get("start")),
                   viewport.get("end", fe_raw.get("end")))
    chrom = chrom or viewport.get("chrom") or fe_raw.get("chrom") or getattr(state, "_current_chrom", None)
    start = start if start is not None else viewport.get("start", fe_raw.get("start", getattr(state, "_current_start", None)))
    end = end if end is not None else viewport.get("end", fe_raw.get("end", getattr(state, "_current_end", None)))
    if not chrom or start is None or end is None:
        raise ValueError("A region (chrom, start, end) is needed when there is no browser view or session")
    if int(end) <= int(start):
        raise ValueError(f"Invalid region: {start}-{end}")
    if view_region[0] and fe.get("peaksByRule") and (str(chrom), int(start), int(end)) != (
            str(view_region[0]), view_region[1], view_region[2]):
        # The view's peaks were scanned in the view: they keep its chromosome
        # (a peak without one counts as the drawn region's), and the figure's
        # own region is scanned as the browser would after navigating there.
        fe["peaksByRule"] = {
            rid: [{**p, "chrom": p.get("chrom") or view_region[0]} if isinstance(p, dict) else p for p in peaks]
            if isinstance(peaks, list) else peaks
            for rid, peaks in fe["peaksByRule"].items()
        }
        fe["_peaksFromAnotherView"] = True
    live = getattr(state, "live_figure_state", None) or {}
    layout = (live.get("layout") or {}) if used == "current" else {}
    session_ids = None
    if used == "session":
        session_ids = [d.get("id") for d in (session or {}).get("datasets") or []
                       if isinstance(d, dict) and d.get("id")] or None
    # The user's layer colours (the session's over the saved defaults), as the browser draws them.
    from services.figure.layer_colours import apply as apply_layer_colours
    apply_layer_colours(fe)
    options = dict(options or {})
    if "sv_marks" in (options.get("hide_tracks") or ()):
        fe["svDisplayEnabled"] = False  # the browser's SV display switch: strip and per-read marks
    panels = build_panels(state, fe, dataset_ids, tracks, default_ids=session_ids,
                          hidden=set(options.get("hide_tracks") or ()) or None)
    _drop_meta_hidden_rows(panels, str(chrom), fe)
    if not panels:
        if any(isinstance(p, dict) and p.get("collapsed") for p in fe.get("panels") or []):
            raise ValueError("Every dataset panel is collapsed; expand one or name dataset_ids to draw")
        raise ValueError("No datasets to draw")
    if read_ids is not None:
        # Only these reads, in every panel (like the browser's read filter); an
        # empty list is a selection matching no reads, not "all reads".
        fe["filteredReadIds"] = {**(fe.get("filteredReadIds") or {}), **{p.state_key: list(read_ids) for p in panels}}
    return FigureSpec(
        chrom=str(chrom), start=int(start), end=int(end),
        width=float(width or layout.get("width") or 1400), panels=panels, fe=fe, source=used,
        title=title, include_coords=include_coords, read_row_height=read_row_height, max_reads=max_reads,
        options=options, max_reads_by_panel=_max_reads_by_panel(panels, options.get("max_reads_by_dataset")),
    )


def _max_reads_by_panel(panels: list[PanelSpec], by: Optional[dict]) -> dict:
    """Per-dataset read caps -> {panel id: cap}; a key names a panel id, a dataset id or a dataset label."""
    if not by:
        return {}
    out, used = {}, set()
    for panel in panels:
        for key in (panel.id, panel.dataset_id, panel.label):
            if key in by:
                out[panel.id] = int(by[key])
                used.add(key)
                break
    unknown = sorted(set(by) - used)
    if unknown:
        raise ValueError("max_reads: no panel for " + ", ".join(unknown)
                         + " (use dataset ids, panel ids or labels: "
                         + ", ".join(sorted({p.dataset_id for p in panels})) + ")")
    return out


def _drop_meta_hidden_rows(panels: list[PanelSpec], chrom: str, fe: dict) -> None:
    """On a meta-locus contig, the rows that need a real genome position are left out (SubTrackDispatch with
    metaHiddenTrack): sequence, genes, primers, Micro-C, the SV row, capture, external and annotation composites.
    Metaprofile composites stay (computed from the reads)."""
    from services.figure.meta_locus import is_meta_chrom, meta_hidden_track
    default_id = "__default_metaprofile__"
    by_id = {c.get("id"): c for c in fe.get("compositeTracks") or [] if isinstance(c, dict)}

    def metaprofile_row(kind: str) -> bool:
        if not kind.startswith("composite-"):
            return False
        cid = kind[len("composite-"):]
        comp = by_id.get(cid)
        return cid == default_id or bool(comp and any(((s or {}).get("ref") or {}).get("kind") == "metaprofile"
                                                      for s in comp.get("sources") or []))

    for panel in panels:
        if not is_meta_chrom(panel.region[0] if panel.region else chrom):
            continue
        hidden = [t.type for t in panel.tracks if meta_hidden_track(t.type, metaprofile_row(t.type))]
        panel.tracks = [t for t in panel.tracks if t.type not in hidden]
        panel.rows_off |= set(hidden) | {"sv"}
