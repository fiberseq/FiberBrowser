"""Headless numbers for pooled loci (meta-locus) and any view: the metaprofile per bin and the Quantify card's table.

Both read the view as a headless figure does (services/figure: the session's or the browser's default settings, the
same panels, read filters and profile pools), then compute with the browser's own maths ported to Python:

- ``metaprofile``: the read track's curves (ReadTrack computeMetaprofileFromReads: layerChannelRead, accumulateChannels
  'touch' over 500 bins, finishChannels), per channel and group (all reads, each dataset, each cluster), per bin with
  the bin's relative position and the reads covering it;
- ``quantify``: Quantify a window (services/window_quant.py, the twin of features/windowQuant): measures x bounds x
  comparison with Wilson and bootstrap intervals and the same seeds, as the card computes them.

On a meta-locus each read-site pair is one unit; the window and bins are given in bp from the anchor.
"""
from __future__ import annotations

import math
from typing import Any, Optional

from services import window_quant as wq

DEFAULT_PROFILE_CHANNELS = None  # None: the default metaprofile's active layers

# A session's Quantify block (frontend.windowQuant, features/windowQuant/store.ts): what a headless quantify of that
# session takes from it when the call does not say otherwise. The drift tests (frontend .../headlessCoverage.test.ts,
# tests/test_headless_meta_locus_drift.py) fail when the browser saves a field that is in neither table.
WINDOW_QUANT_SESSION_HANDLED = {
    "window": "the saved window (relative to the anchor, or on the view's contig) when the call gives none",
    "spec": "the saved QuantSpec under the call's own fields",
}
WINDOW_QUANT_SESSION_NOT_COMPUTED = {
    "version": "the block's format number",
    "openIn": "where the card is open in the browser (cluster profiles or the track)",
    "axis": "the metaprofiles' x-axis display; a saved window keeps its own frame (relative or genomic)",
}
# QuantSpec fields (DEFAULT_QUANT_SPEC) that change the display only, not the table.
QUANT_SPEC_NOT_COMPUTED = {
    "chart": "bars or lines: display only",
    "view": "chart or table: display only",
    "sort": "the display order of groups and measures; the card's TSV keeps panel order, as here",
}


class NumbersError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _view_spec(state, body: dict):
    """(FigureSpec, MetaView | None) for a numbers request: its meta_locus (or a session on a meta view), the session's
    settings (else the defaults the notebook set), the figure's panels."""
    from services.figure.meta_locus import MetaLocusError, draw_whole_working_set, resolve as resolve_meta, session_region
    from services.figure.options import resolve as resolve_options
    from services.figure.spec import resolve_spec
    from services.figure_render import parse_region
    session = body.get("session")
    if isinstance(session, dict):
        # The session's datasets: loaded here when asked (load_session), else they must be loaded already.
        from types import SimpleNamespace
        from services.figure_render import FigureError, _session_source
        from services.runtime import get_public_mode
        if body.get("load_session") and get_public_mode():
            raise NumbersError("load_session is not available on a public server", 403)
        try:
            _session_source(SimpleNamespace(session=session, session_path=None, load_session=bool(body.get("load_session"))),
                            state, None)
        except FigureError as exc:
            raise NumbersError(str(exc), exc.status) from None
    try:
        meta = resolve_meta(state, body.get("meta_locus"), session if isinstance(session, dict) else None)
    except MetaLocusError as exc:
        raise NumbersError(str(exc), exc.status) from None
    try:
        return _view_spec_for(state, body, session, meta)
    except Exception:
        if meta is not None:
            meta.release()
        raise


def _view_spec_for(state, body: dict, session, meta):
    from services.figure.meta_locus import draw_whole_working_set, session_region
    from services.figure.options import resolve as resolve_options
    from services.figure.spec import resolve_spec
    from services.figure_render import parse_region
    if meta is not None and meta.session is not None:
        session = meta.session
    chrom = start = end = None
    if body.get("region"):
        chrom, start, end = parse_region(body["region"])
    elif meta is not None:
        chrom, start, end = session_region(meta, session) or meta.region((meta.spec or {}).get("window"))
    source = "session" if isinstance(session, dict) else (body.get("source") or "auto")
    spec = resolve_spec(state, chrom=chrom, start=start, end=end, source=source,
                        session=session if isinstance(session, dict) else None,
                        dataset_ids=body.get("dataset_ids") or (list(meta.pool.order) if meta is not None and meta.source != "session" and meta.spec.get("dataset_ids") else None),
                        options=resolve_options(None, session if isinstance(session, dict) else None))
    if meta is not None:
        spec.fe["_metaLocus"] = meta.axis()
        draw_whole_working_set(spec, meta, explicit_cap=False)
        spec.meta = meta.record()
    return spec, meta


def _contexts(state, spec, keys: Optional[list] = None, view: Optional[dict] = None):
    """A track context per key, for its panel that shows ``view`` (the chart scope's), else its first panel."""
    from services.figure.data import DataCache
    from services.figure.tracks import TrackContext
    from services.panel_scope import panel_for
    data = DataCache(state, spec)
    wanted = {}
    if view is not None and keys is not None:
        for k in keys:
            hit = panel_for(_scope_fe(spec), _loaded(spec), k, view["_view"], (spec.chrom, spec.start, spec.end), _drawn_ids(spec))
            if hit is not None:
                wanted[k] = str(hit.get("id"))
    seen, out = set(), []
    for panel in spec.panels:
        if panel.state_key in seen or (keys is not None and panel.state_key not in keys):
            continue
        # The key's panel showing the scope's view, never another panel of it at another locus.
        if view is not None and keys is not None and panel.id != wanted.get(panel.state_key):
            continue
        seen.add(panel.state_key)
        out.append(TrackContext(state, spec, panel, data, spec.width))
    return out


def _panel_pool(ctx) -> Optional[dict]:
    """The panel's profile pool (utils/profileReadPool as ReadTrack sets it), or None when the browser draws the
    server's metaprofile here (canUseServerMetaprofile: ReadTrack clears the pool and Quantify reads a fresh sample)."""
    from services.figure.tracks.reads import _display
    view = _display(ctx)
    if view.get("use_server_meta") or view.get("zoomed_out"):
        return None
    plan = view.get("plan") or {}
    return {"reads": list(view.get("pool") or []), "chrom": ctx.chrom, "start": ctx.start, "end": ctx.end,
            "resolution": wq.RESOLUTION, "layers": list(plan.get("layers") or []), "marks": bool(plan.get("methylation"))}


def _canonical(key: str) -> str:
    return {"footprint": "nuc", "mod": "m6a", "msp": "fire"}.get(key, key)


def layer_entries(spec) -> list[dict]:
    """getMetaprofileSourceEntries of the datasets in view (services/figure/defaults.py's port): every layer a
    metaprofile can show, native, custom and derived, with the browser's labels, in its order."""
    from services.figure.defaults import metaprofile_source_entries
    # Live-lifted datasets are left out of Plots and Quantify (usePlotTargets), so their layers are not offered.
    return metaprofile_source_entries([p.dataset for p in spec.panels if _data_type(p.dataset) != "bam_livelift"])


def _data_type(ds) -> Optional[str]:
    """A dataset's data_type, from a figure panel's dataset dict or a Dataset object."""
    return ds.get("data_type") if isinstance(ds, dict) else getattr(ds, "data_type", None)


def available_layers(state, spec) -> list[str]:
    """The layer measures' keys (layerMeasures, sources.ts), in the browser's order."""
    return [e["key"] for e in layer_entries(spec)]


def active_layer_keys(state, spec) -> list[str]:
    """activeLayerMeasureIds: the layers the default metaprofile shows (defaultMetaprofileToggles), as layer keys."""
    comp = next((c for c in spec.fe.get("compositeTracks") or [] if isinstance(c, dict)
                 and c.get("id") == "__default_metaprofile__"), None)
    on = set()
    if comp is not None:
        for src in comp.get("sources") or []:
            ref = src.get("ref") or {}
            if ref.get("kind") == "metaprofile" and src.get("visible", True):
                on.add(_canonical(str(ref.get("ruleId"))))
    return [k for k in available_layers(state, spec) if _canonical(k) in on]


def _loaded(spec) -> list[str]:
    return list(dict.fromkeys(p.dataset_id for p in spec.panels))


def _scope_fe(spec) -> dict:
    """The frontend state the panel scope reads, with the figure's own default panels added (a dataset the call named
    that the saved view has no panel for is drawn with a default panel, and is read like one)."""
    fe = spec.fe
    saved = [p for p in fe.get("panels") or [] if isinstance(p, dict)]
    if not saved:
        return fe
    ids = {str(p.get("id")) for p in saved}
    extra = [{"id": p.id, "datasetId": p.dataset_id, "stateKey": p.state_key, "contentType": "dataset"}
             for p in spec.panels if p.id not in ids]
    return {**fe, "panels": saved + extra} if extra else fe


def _drawn_ids(spec) -> set:
    """The panels the headless engine draws (collapsed ones and panels of datasets not loaded are not among them):
    the scope is taken over these, so every scoped key has a panel to read."""
    return {p.id for p in spec.panels}


LIFTED_LEFT_OUT_NOTE = "Live-lifted datasets aren't plotted or quantified yet"   # usePlotTargets.ts, the same words


def _key_datasets(spec) -> dict:
    """State key -> dataset id, over the saved panels and the figure's own."""
    out = {}
    for p in _scope_fe(spec).get("panels") or []:
        if isinstance(p, dict) and p.get("datasetId"):
            out.setdefault(str(p.get("stateKey") or p["datasetId"]), str(p["datasetId"]))
    for p in spec.panels:
        out.setdefault(str(p.state_key or p.dataset_id), str(p.dataset_id))
    return out


def _is_lifted(state, dataset_id: str) -> bool:
    ds = (getattr(state, "datasets", None) or {}).get(dataset_id)
    return _data_type(ds) == "bam_livelift"


def _all_target_keys(spec, state=None) -> list[str]:
    """useFocusedReadIds' targetStateKeys (services/panel_scope.py). The selection and its link groups are expanded
    over every loaded dataset's saved panels (a folded graph member that is not drawn still links a visible panel
    into the target, as in the browser); only then are the keys restricted to the panels drawn here."""
    from services.panel_scope import target_state_keys
    loaded = list(dict.fromkeys(list(getattr(state, "dataset_order", None) or (getattr(state, "datasets", None) or {}))
                                + _loaded(spec)))
    return target_state_keys(_scope_fe(spec), loaded, _drawn_ids(spec))


def _target_keys(spec, state=None) -> list[str]:
    """The keys the numbers read: the target keys without live-lifted datasets (usePlotTargets leaves them out of
    Plots and Quantify, and says so: ``_lifted_left_out``)."""
    ds_of = _key_datasets(spec)
    return [k for k in _all_target_keys(spec, state) if not _is_lifted(state, ds_of.get(k, k))]


def _lifted_left_out(spec, state=None, allowed: Optional[list] = None) -> list[str]:
    """Labels of the live-lifted datasets the target would include, left out (as usePlotTargets' liftedLeftOut): over
    every saved panel (a collapsed or folded lifted panel is named too, not dropped silently), limited to the datasets
    the call asked for (``allowed``)."""
    from services.panel_scope import target_state_keys
    loaded = list(dict.fromkeys(list(getattr(state, "dataset_order", None) or (getattr(state, "datasets", None) or {}))
                                + _loaded(spec)))
    ds_of, out = _key_datasets(spec), []
    # The selection and its link groups are resolved over every loaded panel first; only then is the call's
    # dataset restriction applied (a restriction to the lifted dataset itself still names it).
    for k in target_state_keys(_scope_fe(spec), loaded):
        d = ds_of.get(k, k)
        if allowed and d not in set(allowed):
            continue
        if _is_lifted(state, d):
            ds = (getattr(state, "datasets", None) or {}).get(d)
            label = getattr(ds, "label", None) or d
            if label not in out:
                out.append(label)
    return out


def _refuse_all_lifted(spec, state, keys: list, allowed: Optional[list]) -> None:
    """Nothing left to read because every target dataset is live-lifted: say so (the browser's card names them)."""
    if not keys:
        lifted = _lifted_left_out(spec, state, allowed)
        if lifted:
            raise NumbersError(_lifted_note(lifted))


def _lifted_note(labels: list[str]) -> str:
    return f"{LIFTED_LEFT_OUT_NOTE}: left out {', '.join(labels)}." if labels else ""


def _left_out(state, spec, keys: list[str], allowed: Optional[list] = None) -> list[str]:
    """Keys the browser's card would read at this view that headless numbers cannot: their panels are not drawn here
    (collapsed, or folded into a graph host). Said in the answer and the TSV header. ``allowed``: the datasets the
    call asked for (others are not left out, they were not asked for)."""
    from services.panel_scope import chart_scope, target_state_keys
    loaded = list(getattr(state, "dataset_order", None) or (getattr(state, "datasets", None) or {}))
    if allowed:
        loaded = [d for d in loaded if d in set(allowed)]
    try:
        fe = _scope_fe(spec)
        _view, every = chart_scope(fe, loaded, target_state_keys(fe, loaded), (spec.chrom, spec.start, spec.end))
    except Exception:
        return []
    ds_of = _key_datasets(spec)   # live-lifted datasets are reported on their own (_lifted_left_out)
    return [k for k in every if k not in keys and not _is_lifted(state, ds_of.get(k, k))]


def _allowed(body: dict, meta) -> Optional[list]:
    """The datasets a numbers call is limited to (its dataset_ids, or a pool spec's datasets), else None."""
    if body.get("dataset_ids"):
        return list(body["dataset_ids"])
    if meta is not None and meta.source != "session" and meta.spec.get("dataset_ids"):
        return list(meta.pool.order)
    return None


def _scope(spec, keys: list[str]):
    """clusterChartScope (services/panel_scope.py): (view dict with its reference, the keys showing it)."""
    from services.panel_scope import chart_scope
    view, scoped = chart_scope(_scope_fe(spec), _loaded(spec), keys, (spec.chrom, spec.start, spec.end), _drawn_ids(spec))
    return {"chrom": view.chrom, "start": view.start, "end": view.end, "genome": view.genome, "_view": view}, scoped


def _panels(spec, keys: Optional[list] = None) -> list[dict]:
    """usePlotTargets' panelOf for the scoped keys (all figure panels when ``keys`` is None)."""
    seen, out = set(), []
    for p in spec.panels:
        if p.state_key in seen or (keys is not None and p.state_key not in keys):
            continue
        seen.add(p.state_key)
        out.append({"key": p.state_key, "datasetId": p.dataset_id, "label": p.label, "datasetLabel": p.label, "color": p.color})
    if keys is not None:
        out.sort(key=lambda q: keys.index(q["key"]))
    return out


def _clusters(spec, panels: list[dict]) -> tuple[list, list, dict]:
    """(clustered panels, visible clusters, assignments): usePlotTargets + scopedClusters on the session's clusters."""
    fe = spec.fe
    assignments = {k: dict(v) for k, v in (fe.get("clusterAssignments") or {}).items() if isinstance(v, dict)}
    clustered = [p["key"] for p in panels if assignments.get(p["key"])]
    if not clustered:
        return [], [], assignments
    _view, scoped = _scope(spec, clustered)
    cps = [p for p in panels if p["key"] in scoped]
    if not cps:
        return [], [], assignments
    keys = [p["key"] for p in cps]
    present = set()
    for k in keys:
        present |= set(assignments[k].values())
    preferred = list((fe.get("clusterOrder") or {}).get(keys[0]) or [])
    order = [c for i, c in enumerate(preferred) if c in present and preferred.index(c) == i]
    order += sorted(c for c in present if c not in preferred)
    focus = (fe.get("clusterFocus") or {}).get(keys[0])
    if focus:
        order = [c for c in order if c in set(focus)]
    return cps, [{"cluster": c, "color": None} for c in order], assignments


def _bounds(qspec: dict, window: Optional[list], view: dict, meta, relative: bool) -> dict:
    """effectiveBounds (spec.ts) with the meta-locus anchor (the site at x = flank, '+')."""
    whole = {"from": wq._js_round(view["start"]), "to": wq._js_round(view["end"])}
    if qspec["bounds"] in ("sites", "region"):
        return {**whole, "kind": qspec["bounds"], "windowMissing": False}
    if window:
        a, b = int(window[0]), int(window[1])
        if relative:
            if meta is None:
                raise NumbersError("A relative window ([from, to] bp from the anchor) needs a meta-locus; give "
                                   "window_genomic for a genomic window")
            a, b = a + meta.flank, b + meta.flank
        lo, hi = max(whole["from"], min(a, b)), min(whole["to"], max(a, b))
        if hi > lo:
            return {"from": lo, "to": hi, "kind": "window", "windowMissing": False}
    return {**whole, "kind": "region", "windowMissing": True}


def _fresh_reads(state, view: dict, dataset_ids: list, layers: list, marks: bool, cap: int, seed: int) -> list:
    """compactReads (sources.ts): the browser's fresh seeded sample per dataset (on the view's reference)."""
    from services.read_endpoint import compact_reads_payload_for_request
    from services.panel_genomes import genome_view
    # panel_genome=<key>, as the route does it: the state as that reference's view.
    st = genome_view(state, view.get("genome")) if view.get("genome") else state
    out = []
    for ds in dataset_ids:
        kwargs = dict(chrom=view["chrom"], start=wq._js_round(view["start"]), end=wq._js_round(view["end"]),
                      dataset_id=ds, max_reads=int(cap), include_layers=True, include_layer_qualities=False,
                      hide_terminal_gaps=False, sample_seed=str(seed))
        if layers:
            kwargs["layer_names"] = ",".join(layers)
        if marks:
            kwargs["include_methylation"] = True
        payload = compact_reads_payload_for_request(st, **kwargs)
        out.append((ds, list(payload.get("reads") or [])))
    return out


def _saved_quant(body: dict) -> dict:
    """The session's Quantify block (frontend.windowQuant), {} without one."""
    session = body.get("session")
    fe = session.get("frontend") if isinstance(session, dict) and isinstance(session.get("frontend"), dict) else {}
    saved = fe.get("windowQuant")
    return saved if isinstance(saved, dict) else {}


def quant_inputs(state, body: dict) -> dict:
    """Everything the engine needs, built as the browser builds it (also the golden fixture's input)."""
    saved = _saved_quant(body)
    raw = dict(saved.get("spec") or {}) if isinstance(saved.get("spec"), dict) else {}
    raw.update({wq.SNAKE.get(k, k): v for k, v in (body.get("spec") or {}).items()})
    qspec = wq.normalize_spec(raw)
    spec, meta = _view_spec(state, body)
    from services.figure.compose import view_filters
    try:
        with view_filters(spec, state):  # the view's saved quality and signal filters, as figures read it
            return _quant_inputs(state, body, qspec, saved, spec, meta)
    finally:
        if meta is not None:
            meta.release()


def _quant_inputs(state, body, qspec, saved, spec, meta) -> dict:
    if meta is not None and meta.session is not None:
        saved = _saved_quant({"session": meta.session})  # its window's contig renamed to the pool's
    view, keys = _scope(spec, _target_keys(spec, state))
    _refuse_all_lifted(spec, state, keys, _allowed(body, meta))
    if body.get("window") is None and body.get("window_genomic") is None and isinstance(saved.get("window"), dict):
        w = saved["window"]
        if w.get("relative"):
            if meta is None:
                raise NumbersError("The session's Quantify window is relative to a gene anchor, which is resolved in "
                                   "the browser; pass window_genomic=[start, end] for this view")
            body = {**body, "window": [int(w["from"]), int(w["to"])]}
        elif w.get("chrom") == view["chrom"]:
            body = {**body, "window_genomic": [int(w["from"]), int(w["to"])]}
    panels = _panels(spec, keys)
    cps, visible, assignments = _clusters(spec, panels)
    comparison = qspec["comparison"]
    if not cps and comparison in ("clusters", "clusters-datasets"):
        comparison = "datasets"  # useWindowQuant: clusterless views compare datasets ("per dataset")
    if comparison == "pools" and meta is None:
        raise NumbersError("comparison 'pools' needs a meta-locus (meta_locus or a session on a meta-locus view)")
    if qspec["bounds"] == "sites" and meta is None:
        raise NumbersError("bounds 'sites' needs a meta-locus (meta_locus or a session on a meta-locus view)")
    relative = body.get("window") is not None
    window = body.get("window") if relative else body.get("window_genomic")
    bounds = _bounds(qspec, window, view, meta, relative)
    ids = list(qspec["measures"])
    if not ids:
        ids = [f"layer:{_canonical(k)}" for k in active_layer_keys(state, spec)]
    wq.check_measures(ids)
    entries = layer_entries(spec)
    avail = {_canonical(e["key"]) for e in entries}
    has_tf = "tf" in avail
    labels = {_canonical(e["key"]): e["label"] for e in entries}
    layer_keys = [i[len("layer:"):] for i in ids if i.startswith("layer:")]
    missing = [k for k in layer_keys if _canonical(k) not in avail]
    if missing:
        raise NumbersError(f"No {', '.join(missing)} layer in these datasets (available: {', '.join(sorted(avail)) or 'none'})")
    y_base = (((spec.fe.get("clusterViewSettings") or {}).get("yScale") or {}).get("baseline")) or "region"
    view_bins = qspec["value"] == "enrichment" and wq.baseline_for("fraction", True, qspec["baseline"], y_base) in ("flank", "dataset")
    pools = []
    for ctx in _contexts(state, spec, keys, view):
        pools.append({"key": ctx.panel.state_key, "datasetId": ctx.panel.dataset_id, "pool": _panel_pool(ctx)})
    fresh = marks = []
    # loadLayers: the fresh sample whenever the panels' pools cannot answer (none, another view, a layer or marks
    # they did not fetch), exactly the cases pool_layer_data refuses.
    need_fetch = qspec["readSource"] == "fetch" or not wq.pools_usable(layer_keys, pools, view)
    datasets = list(dict.fromkeys(p["datasetId"] for p in panels))
    if layer_keys and need_fetch:
        ivl = [k for k in layer_keys if not wq.is_mark_layer(k)]
        layers = list(dict.fromkeys(x for k in ivl for x in wq.source_layers(k)))
        fresh = _fresh_reads(state, view, datasets, layers, False, qspec["readCap"], qspec["seed"]) if ivl else []
        marks = _fresh_reads(state, view, datasets, [], True, qspec["readCap"], qspec["seed"]) if len(ivl) < len(layer_keys) else []
    size_reads = (_fresh_reads(state, view, datasets, wq.source_layers(wq.ALL_FOOTPRINTS), False, qspec["readCap"], qspec["seed"])
                  if wq.SIZE_BAND_MEASURE in ids else [])
    left_out = _left_out(state, spec, keys, _allowed(body, meta))
    lifted = _lifted_left_out(spec, state, _allowed(body, meta))
    view = {k: v for k, v in view.items() if k in ("chrom", "start", "end")}
    return {"spec": qspec, "view": view, "bounds": bounds, "left_out": left_out, "lifted_left_out": lifted, "measures": ids, "has_tf": has_tf, "panels": panels,
            "cluster_panels": cps, "visible": visible, "assignments": assignments, "comparison": comparison,
            "y_baseline": y_base, "view_bins": view_bins, "pools": pools, "fresh": fresh, "marks": marks,
            "size_reads": size_reads, "meta": spec.meta, "_metaview": meta, "labels": labels}


def compute_from_inputs(inp: dict) -> dict:
    """The engine on quant_inputs (shared by the endpoint and the golden test)."""
    qspec, view, bounds = inp["spec"], inp["view"], inp["bounds"]
    defs = {}
    for mid in inp["measures"]:
        defs[mid] = wq.size_band_measure() if mid == wq.SIZE_BAND_MEASURE else wq.layer_measure(
            mid[len("layer:"):], inp["has_tf"], (inp.get("labels") or {}).get(_canonical(mid[len("layer:"):])))
    data: dict = {}
    layer_defs = [defs[m] for m in inp["measures"] if m.startswith("layer:")]
    keys = [m["id"][len("layer:"):] for m in layer_defs]
    if keys:
        pooled = None
        if qspec["readSource"] == "panel":
            pooled = wq.pool_layer_data(keys, inp["pools"], view, bounds, qspec["flankFraction"], qspec["layerUnits"],
                                        inp["view_bins"])
        if pooled is None:
            pooled = wq.fetch_layer_data(layer_defs, inp["fresh"], inp["marks"], view, bounds, qspec["flankFraction"])
        data.update(pooled)
    if wq.SIZE_BAND_MEASURE in inp["measures"]:
        data.update(wq.size_band_data(inp["size_reads"], view, bounds, qspec["flankFraction"], [qspec["sizeFrom"], qspec["sizeTo"]]))
    spec_eff = {**qspec, "comparison": inp["comparison"]}
    groups = wq.build_groups(inp["comparison"], inp["panels"], inp["cluster_panels"], inp["visible"])
    if not groups:
        raise NumbersError("No groups to compare (no dataset panel shows this view)")
    result = wq.compute_quant(spec_eff, [(defs[m], data.get(m) or {}) for m in inp["measures"]], groups,
                              inp["assignments"], bounds["to"] - bounds["from"],
                              qspec["bootSeed"] if qspec["bootSeed"] is not None else qspec["seed"], inp["y_baseline"])
    sampled = {}
    for d in data.values():
        for ds, s in (d.get("sampled") or {}).items():
            sampled[ds] = {"used": max(sampled.get(ds, {}).get("used", 0), s["used"])}
    read_source = "panel" if any(d.get("readSource") == "panel" for d in data.values()) else (
        "fetch" if any(d.get("readSource") == "fetch" for d in data.values()) else None)
    bin_bp = next((d["binned"]["binBp"] for d in data.values() if d.get("binned")), None)
    return {"result": result, "sampled": sampled, "readSource": read_source, "binBp": bin_bp}


def _header(inp: dict, out: dict) -> list[str]:
    b, mv = inp["bounds"], inp.get("_metaview")
    if mv is not None:
        where = f"{mv.pool.label}, {b['from'] - mv.flank:+d} to {b['to'] - mv.flank:+d} bp from the {mv.anchor} anchor"
    else:
        where = f"{inp['view']['chrom']}:{b['from']:,}-{b['to']:,}"
    res = out["result"]
    methods = {m["method"] for m in res["measures"]}
    used = sorted({m.get("resamplesUsed", res["resamples"]) for m in res["measures"] if m["method"] == "bootstrap"})
    parts = []
    if "wilson" in methods:
        parts.append("Wilson 95% for shares of reads")
    if "bootstrap" in methods:
        parts.append(f"bootstrap 95% ({'/'.join(str(u) for u in used)} Poisson resamples of reads, seed {res['seed']})"
                     + (f"; fewer than the {res['resamples']} asked for a wide window in curve units"
                        if used and used[0] < res["resamples"] else ""))
    lines = [f"Quantify a window (FiberBrowser headless): {where} ({b['to'] - b['from']} bp; bounds {b['kind']}"
             + ("; no window set, the whole view" if b.get("windowMissing") else "") + f"); comparison {inp['comparison']}",
             "intervals: " + ("; ".join(parts) if parts else "none"),
             f"layers: {'curve units (the profile curve bins and its mean over the window)' if out['readSource'] == 'panel' and inp['spec']['layerUnits'] == 'curve' else 'exact bp'}"
             f"; reads: {out['readSource'] or 'none'}; used per dataset: "
             + ", ".join(f"{k} {v['used']}" for k, v in out["sampled"].items())]
    if inp.get("left_out"):
        lines.append("left out (their panels are not drawn headlessly: collapsed or folded into a graph): "
                     + ", ".join(inp["left_out"]))
    if inp.get("lifted_left_out"):
        lines.append(_lifted_note(inp["lifted_left_out"]))
    if mv is not None:
        r = inp["meta"]
        lines.append(f"meta-locus: {r['sites']} sites, {r['read_site_pairs']} read-site pairs; working set seed "
                     f"{r['seed']}, count {r['count']}; unit: read-site pair; BED sha256 {r['bed_sha256']}; spec {r['spec_hash']}")
    return lines


def quantify(state, body: dict) -> dict:
    """/api/meta_locus/quantify: the Quantify card's table (and TSV) for a meta-locus or a session's view."""
    inp = quant_inputs(state, body)
    out = compute_from_inputs(inp)
    header = _header(inp, out)
    result = out["result"]
    return {"success": True, "result": _json(result), "tsv": wq.quant_tsv(result, header), "header": header,
            "bounds": inp["bounds"], "comparison": inp["comparison"], "read_source": out["readSource"],
            "bin_bp": out["binBp"], "sampled": out["sampled"], "measures": inp["measures"], "left_out": inp["left_out"],
            "lifted_left_out": inp.get("lifted_left_out") or [], "spec": inp["spec"], "meta_locus": inp["meta"]}


def _json(v):
    import numpy as np
    if isinstance(v, dict):
        return {k: _json(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json(x) for x in v]
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


# ------------------------------------------------------------------------------------------------ metaprofile export

def metaprofile(state, body: dict) -> dict:
    """/api/meta_locus/profile: per-bin metaprofile values per channel and group (all, per dataset, per cluster), from
    the panels' profile pools (the curves the browser draws: 'touch' bins over the view's 500-bin grid)."""
    spec, meta = _view_spec(state, body)
    from services.figure.compose import view_filters
    try:
        with view_filters(spec, state):  # the view's saved quality and signal filters, as figures read it
            return _metaprofile(state, body, spec, meta)
    finally:
        if meta is not None:
            meta.release()


def _server_profile(ctx, dataset_id: str, keys: list) -> tuple[dict, Optional[int]]:
    """The server's metaprofile of a panel, as the browser draws it where it can (composite.dataset_profile: the same
    request with the panel's read filter / cluster cohort and strand), and the reads it was computed from."""
    from services.figure.tracks.reads import panel_cohort_ids
    cohort = panel_cohort_ids(ctx)
    if cohort is not None and not cohort:
        return {}, 0
    strand = ctx.panel.strand
    payload = ctx.data.compact_reads(dataset_id, layer_names=keys, include_metaprofile=True, metaprofile_layers=keys,
                                     filter_ids=cohort, strand=strand, include_methylation=bool(strand), region=ctx.region)
    layers = dict(((payload or {}).get("metaprofile") or {}).get("layers") or {})
    meta = (payload or {}).get("metaprofile") or {}
    n = (payload or {}).get("metaprofile_read_count", meta.get("metaprofile_read_count"))
    if not layers.get("nuc") and meta.get("nucleosome_profile"):
        layers["nuc"] = meta["nucleosome_profile"]
    for a, b in (("footprint", "nuc"), ("nuc", "footprint"), ("m6a", "mod"), ("fire", "msp")):
        if not layers.get(a) and layers.get(b):
            layers[a] = layers[b]
    return layers, (int(n) if isinstance(n, (int, float)) else None)


def _metaprofile(state, body: dict, spec, meta) -> dict:
    from services.profile_engine import accumulate_channels
    channels = body.get("channels")
    if isinstance(channels, str):
        channels = [c for c in channels.replace(",", " ").split() if c]
    view_r, keys_scoped = _scope(spec, _target_keys(spec, state))
    _refuse_all_lifted(spec, state, keys_scoped, _allowed(body, meta))
    keys = [_canonical(c) for c in (channels or active_layer_keys(state, spec) or available_layers(state, spec))]
    avail = {_canonical(k) for k in available_layers(state, spec)}
    unknown = [k for k in keys if k not in avail]
    if unknown:
        raise NumbersError(f"No {', '.join(unknown)} layer in these datasets (available: {', '.join(sorted(avail))})")
    left_out = _left_out(state, spec, keys_scoped, _allowed(body, meta))
    lifted = _lifted_left_out(spec, state, _allowed(body, meta))
    width = view_r["end"] - view_r["start"]
    res = int(body.get("bins") or wq.RESOLUTION)
    panels = _panels(spec, keys_scoped)
    cps, visible, assignments = _clusters(spec, panels)
    reads_by_panel, server = {}, {}
    from services.figure.tracks.reads import _display
    for ctx in _contexts(state, spec, keys_scoped, view_r):
        view = _display(ctx)
        reads_by_panel[ctx.panel.state_key] = (ctx.panel.dataset_id, list(view.get("pool") or []))
        if view.get("use_server_meta"):
            # canUseServerMetaprofile: the browser (and the figure) draw the server's profile here, not one from reads;
            # it has the server's own resolution, so another bin count is refused rather than computed from other reads.
            if body.get("bins") and res != wq.RESOLUTION:
                raise NumbersError("bins: this view's curve is the server's metaprofile (one dataset, unclustered), "
                                   "drawn at its own resolution; leave bins at the default")
            server[ctx.panel.state_key] = _server_profile(ctx, ctx.panel.dataset_id, keys)
    groups = [("all", None, None)]
    groups += [(f"dataset:{p['datasetId']}", p["key"], None) for p in panels]
    for p in cps:
        for c in visible:
            groups.append((f"cluster:{c['cluster']}" + (f"|{p['datasetId']}" if len(cps) > 1 else ""), p["key"], c["cluster"]))
    zero = meta.flank if meta is not None else 0
    bin_bp = width / res
    rows, curves = [], {}
    for gid, key, cluster in groups:
        own = [k for k in reads_by_panel if key is None or k == key]
        if own and all(k in server for k in own) and len(own) == 1 and cluster is None:
            layers, n_server = server[own[0]]
            # The server's profile has min(500, view width) bins: its own grid, kept as it is.
            n_bins = max((len(layers.get(k) or []) for k in keys), default=0) or min(res, max(1, width))
            g_bp = width / n_bins
            curves[gid] = {"n_reads": n_server, "coverage": None, "source": "server metaprofile", "bins": n_bins,
                           "bin_bp": g_bp,
                           "channels": {k: [float(v) for v in (layers.get(k) or [0.0] * n_bins)] for k in keys}}
            for k in keys:
                for i in range(n_bins):
                    rows.append([gid, k, i, view_r["start"] + i * g_bp - zero, view_r["start"] + (i + 1) * g_bp - zero,
                                 curves[gid]["channels"][k][i], "NA"])
            continue
        reads = []
        for k, (ds, rs) in reads_by_panel.items():
            if key is not None and k != key:
                continue
            for r in rs:
                if cluster is not None:
                    a = assignments.get(k) or {}
                    c = a.get(r.get("analysis_id") or r["id"])
                    if c != cluster:
                        continue
                reads.append(wq.layer_channel_read(r))
        acc = accumulate_channels(reads, res, width, "touch")
        fin = wq.finish_channels(acc)
        cov = acc["coverage"]
        curves[gid] = {"n_reads": len(reads), "coverage": [float(x) for x in cov], "source": "profile reads",
                       "bins": res, "bin_bp": bin_bp, "channels": {}}
        for k in keys:
            name = None
            for cand in ((f"layer:{k}",) if k not in ("nuc", "fire", "m6a") else
                         {"nuc": ("layer:nuc", "layer:footprint"), "fire": ("layer:fire", "fire"), "m6a": ("layer:m6a", "mod")}[k]):
                if cand in fin:
                    name = cand
                    break
            vals = fin.get(name) if name else None
            curves[gid]["channels"][k] = [float(v) for v in vals] if vals is not None else [0.0] * res
            for i in range(res):
                rows.append([gid, k, i, view_r["start"] + i * bin_bp - zero, view_r["start"] + (i + 1) * bin_bp - zero,
                             curves[gid]["channels"][k][i], float(cov[i])])
    # The grids actually exported: the requested one, or the server profile's own (min(500, width) bins).
    grids = {(c.get("bins", res), c.get("bin_bp", bin_bp)) for c in curves.values()}
    if len(grids) == 1:
        res, bin_bp = next(iter(grids))
    else:
        res = bin_bp = None  # groups differ: each group's own "bins" / "bin_bp" say it
    head = ["group", "channel", "bin", "rel_start" if meta is not None else "start", "rel_end" if meta is not None else "end",
            "value", "reads_covering"]
    spacing = f"bins of {bin_bp:g} bp" if bin_bp else "bins per group (see each group's bin_bp)"
    tsv = ["# " + (f"metaprofile of {meta.pool.label}; {spacing} from the anchor; working set seed "
                   f"{meta.view.view_seed}, count {meta.view.view_count}; unit: read-site pair"
                   if meta is not None else f"metaprofile of {view_r['chrom']}:{view_r['start']:,}-{view_r['end']:,}; "
                   f"{spacing}") + (f"; left out (not drawn headlessly): {', '.join(left_out)}" if left_out else "")
           + (f"; {_lifted_note(lifted)}" if lifted else ""),
           "\t".join(head)]
    tsv += ["\t".join(str(round(x, 6)) if isinstance(x, float) else str(x) for x in row) for row in rows]
    return {"success": True, "channels": keys, "bins": res, "bin_bp": bin_bp, "axis_zero": zero,
            "view": {"chrom": view_r["chrom"], "start": view_r["start"], "end": view_r["end"], "genome": view_r["genome"]},
            "groups": curves, "left_out": left_out, "lifted_left_out": lifted,
            "tsv": "\n".join(tsv), "meta_locus": spec.meta}
