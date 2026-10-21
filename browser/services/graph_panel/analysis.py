"""Clustering on graph columns (DESIGN_GRAPH_PRIMARY §2.4–2.6, §3.4–3.5; graph primary G2/G4/G5).

One run clusters every canonical observation in view — a (dataset, path) of a graph host's members, or a linear
dataset on the target — once, on graph node columns, and the browser fans the labels out to every panel showing
that observation (pop-outs add no observations, so opening one never changes the fit).

- **Tiles** (``fetch_tiles``): fixed 10 kb target cells, each requested as a 14 kb interval with the target and one
  source path, cached by package revisions, target, source and cell.
- **Columns** (``services/graph_panel/columns.py``): node columns per region, every observation's blocks, the shared
  features and the carrier sets.
- **Rows** (``graph_window_rows``): a graph observation's rows on its path's own coordinates, decoded and composed as
  the graph reads are (one identity piece over the source contig, the map's haplotype on the piece, the map's molecule
  groups) but without display filtering, then prepared as the dataset's analysis cohort. Each row's ``analysis_id``
  records the graph piece as the primary placement, as the graph wire's ``aid`` does, so labels land on drawn rows; a
  linear row of the same record finds its label through its record key.
- **Stage 1** fits the shared features over every participating observation (``/api/cluster-regions``'s engine with
  graph-source windows). **Stage 2** (``refineWithinCarriers``, §2.6): for each carrier set in order, the carriers of
  each current cluster ``Ci`` are subclustered on the set's carrier-only features into ``Ci.0 … Ci.m−1``; non-carriers
  keep ``Ci``.
- **The durable model** (§3.5): each stage's model as fitted, its realised samples, widths, a geometry digest and the
  settings snapshot. ``assign`` rebuilds the geometry from the tiles, refuses a changed digest or snapshot ("settings
  or geometry changed: cluster again"), and assigns stage 1, then each refinement within carriers only.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import threading
import time
from collections import Counter, OrderedDict
from dataclasses import dataclass
from typing import Optional

from services.graph_panel import columns as gc

WINDOW_PAD_BP = 1_000
MAX_REGIONS = 32
_TILES: "OrderedDict[tuple, dict]" = OrderedDict()
_TILES_MAX = 512
_TILES_LOCK = threading.Lock()
_ROWS: "OrderedDict[tuple, tuple]" = OrderedDict()
_ROWS_MAX = 32
_ROWS_LOCK = threading.Lock()


class GraphRunError(ValueError):
    def __init__(self, message: str, code: str = "invalid_request", status: int = 422):
        super().__init__(message)
        self.code, self.status = code, status


@dataclass(frozen=True)
class GraphSource:
    """A graph-source window's rows: a lifted dataset's records on one package path's source contig."""
    dataset_id: str
    binding: str
    contig: str


# ── Tiles ───────────────────────────────────────────────────────────────────

def _tile_key(reg, target: str, source: Optional[str], cell: int) -> tuple:
    r = reg.revisions
    return (reg.id, r["package"], r["graph"], r["db"], r["maps"], target, source, cell)


async def fetch_tiles(reg, target: str, sources: list[Optional[str]], cells: list[int]) -> dict:
    """``{source: {cell: topology}}`` (source None: the target alone), one request per (path, cell), cached."""
    from services.graph_panel import service
    from services.graph_panel.pool import JobError
    tb = reg.binding(target)
    size = tb.get("size") if tb else None
    out: dict = {}
    for source in sources:
        got = out.setdefault(source, {})
        for cell in cells:
            key = _tile_key(reg, target, source, cell)
            with _TILES_LOCK:
                hit = _TILES.get(key)
                if hit is not None:
                    _TILES.move_to_end(key)
            if hit is None:
                a, b = gc.tile_interval(cell, size)
                request = {"target": target, "interval": {"start": a, "end": b},
                           "selected": [target] + ([source] if source and source != target else []),
                           "context_bp": 0, "snarls": "none"}
                rid = f"cols-{hashlib.sha1(repr(key).encode()).hexdigest()[:16]}"
                try:
                    frame = await service.pool().submit(reg, "query", {"request": request}, request_id=rid,
                                                        panel_id=rid, generation=0)
                except JobError as exc:
                    raise GraphRunError(f"The graph tile {a:,}–{b:,} could not be read: {exc}", "tile_failed", 502) from None
                hit = frame["result"]
                with _TILES_LOCK:
                    _TILES[key] = hit
                    while len(_TILES) > _TILES_MAX:
                        _TILES.popitem(last=False)
            got[cell] = hit
    return out


def clear_caches() -> None:
    with _TILES_LOCK:
        _TILES.clear()
    with _ROWS_LOCK:
        _ROWS.clear()


# ── Rows ────────────────────────────────────────────────────────────────────

def _loader_options(state) -> dict:
    from services.compact_read_loader import short_terminal_footprint_bp_for
    from services.graph_panel.reads import LOADER_OPTIONS
    return {**LOADER_OPTIONS, "ml_threshold": int(getattr(state, "ml_threshold", 125) or 125),
            "infer_legacy_layers": bool(getattr(state, "infer_legacy_layers", True)),
            "legacy_nuc_min_size": int(getattr(state, "legacy_nuc_min_size", 90) or 90),
            "short_terminal_footprint_bp": int(short_terminal_footprint_bp_for(state)), "min_footprints": 0}


def graph_window_rows(state, source: GraphSource, start: int, end: int, cache: Optional[dict] = None):
    """A graph-source window's analysis rows (relative to ``start``, clipped to ``[start, end)``) and its cohort
    description. Display filtering never applies; the dataset's cohort settings do (§2.6)."""
    from services.graph_panel.reads import (_Plan, _settings, contig_length, dataset_revision, source_haplotype)
    from services.lift.cohort import prepare_lift_cohort
    from services.lift.compose import lift_compact_reads
    from services.lift.live_lift import LoadBudget, decode_source_records, row_touches_region
    dataset = state.datasets.get(source.dataset_id)
    if dataset is None or getattr(dataset, "live_lift", None) is None:
        raise GraphRunError("A graph path's reads come from a lifted dataset that is no longer loaded")
    settings = _settings(dataset)
    options = _loader_options(state)
    key = (source, dataset_revision(dataset), int(start), int(end), json.dumps(settings.as_dict(), sort_keys=True),
           json.dumps(options, sort_keys=True, default=str))
    if cache is not None and key in cache:
        return cache[key]
    with _ROWS_LOCK:
        hit = _ROWS.get(key)
        if hit is not None:
            _ROWS.move_to_end(key)
    if hit is None:
        size = contig_length(dataset, source.contig)
        if size is None:
            raise GraphRunError(f"The dataset's BAM has no contig {source.contig}")
        a, b = max(0, int(start)), min(int(size), int(end))
        hap, _labels = source_haplotype(dataset, source.contig)
        plan = _Plan(source.contig, size, [(a, b)], hap or source.binding, (a, b))
        budget, counts = LoadBudget(), {}
        decoded = decode_source_records(list(dataset.paths), plan, loader_options=options, budget=budget,
                                        counts=counts, sampler=None,
                                        include_supplementary=settings.load_supplementaries)
        if budget.truncated:
            raise GraphRunError("This graph region holds too many reads to cluster at once: choose smaller regions",
                                "selection_limit", 413)
        rows = lift_compact_reads(decoded, plan, handle=None, region_start=a, region_end=b, settings=settings,
                                  key=f"graph:{source.binding}", dataset_id=dataset.id, counts=counts,
                                  loader_options=options,
                                  molecule_groups=settings.molecule_group_map(list(dataset.paths), dataset.id))
        rows = [r for r in rows if row_touches_region(r, b - a)]
        # The graph's one piece is the primary placement (as the graph wire's aid records it, reads.row_identity).
        rows = [{**r, "live_lift": {**r["live_lift"], "placement": "primary"}} for r in rows]
        cohort = prepare_lift_cohort(rows, "analysis", settings, None)
        hit = (cohort.rows, cohort.description)
        with _ROWS_LOCK:
            _ROWS[key] = hit
            while len(_ROWS) > _ROWS_MAX:
                _ROWS.popitem(last=False)
    # The active call-quality gates, as every working set applies them (review G4: native and graph observations of
    # the same evidence must give the same values); cached rows stay ungated.
    from services.read_quality_filters import active_quality_filters, apply_quality_filters
    gates = active_quality_filters(state)
    if gates:
        hit = ([g for r in hit[0] if (g := apply_quality_filters(r, gates)) is not None], hit[1])
    if cache is not None:
        cache[key] = hit
    return hit


# ── Requests ────────────────────────────────────────────────────────────────

def _int(v, name):
    if not isinstance(v, int) or isinstance(v, bool):
        raise GraphRunError(f"{name} must be an integer")
    return v


def parse(state, reg, body: dict) -> dict:
    """Validate a graph cluster request against the registration and the loaded datasets."""
    from services.graph_panel.reads import read_bindings
    target = body.get("target")
    tb = reg.binding(str(target)) if isinstance(target, str) else None
    if tb is None or target not in {m.get("target") for m in reg.maps}:
        raise GraphRunError(f"unknown target binding {target!r}")
    regions = body.get("regions")
    if not isinstance(regions, list) or not regions or len(regions) > MAX_REGIONS:
        raise GraphRunError(f"regions must list 1–{MAX_REGIONS} target spans")
    parsed_regions = []
    for r in regions:
        if not isinstance(r, dict):
            raise GraphRunError("a region is {start, end, mode}")
        a, b = _int(r.get("start"), "region start"), _int(r.get("end"), "region end")
        if a < 0 or b <= a:
            raise GraphRunError("regions are half-open target spans with end > start")
        if b - a > gc.MAX_FEATURE_BP:
            raise GraphRunError(f"A graph region is at most {gc.MAX_FEATURE_BP:,} bp", "selection_limit", 413)
        parsed_regions.append({"start": a, "end": b, "mode": str(r.get("mode") or "accessibility")})
    ordered = sorted(parsed_regions, key=lambda r: (r["start"], r["end"]))
    if any(x["end"] > y["start"] for x, y in zip(ordered, ordered[1:])):
        raise GraphRunError("Graph regions must not overlap")
    obs = body.get("observations")
    if not isinstance(obs, list) or not obs:
        raise GraphRunError("observations must list the run's (dataset, path) observations")
    bound = {b["dataset_id"]: b for b in read_bindings(state, reg)}
    out_obs = []
    for o in obs:
        if not isinstance(o, dict) or not isinstance(o.get("id"), str) or not o["id"]:
            raise GraphRunError("an observation is {id, dataset_id, kind, ...}")
        ds = str(o.get("dataset_id") or "")
        if ds not in state.datasets:
            raise GraphRunError(f"dataset {ds!r} is not loaded", "unknown_dataset", 404)
        kind = o.get("kind")
        read_ids = o.get("read_ids")
        if read_ids is not None and (not isinstance(read_ids, list) or not all(isinstance(x, str) for x in read_ids)):
            raise GraphRunError("read_ids must list ids")
        strand = o.get("strand")
        if strand not in (None, "CT", "GA"):
            raise GraphRunError("strand must be CT or GA")
        if kind == "graph":
            binding = o.get("binding")
            paths = (bound.get(ds) or {}).get("paths") or {}
            if bound.get(ds, {}).get("kind") != "lifted" or binding not in paths:
                raise GraphRunError(f"dataset {ds!r} does not bind the package path {binding!r}")
            if binding not in {m.get("source") for m in reg.maps if m.get("target") == target}:
                raise GraphRunError(f"{binding!r} is not compared with the target {target!r} in this package")
            out_obs.append({"id": o["id"], "dataset_id": ds, "kind": "graph", "binding": binding,
                            "contig": paths[binding], "read_ids": read_ids, "strand": strand})
        elif kind == "linear":
            chrom = str(o.get("chrom") or "")
            if chrom != (tb.get("path") or {}).get("contig"):
                raise GraphRunError(f"A linear observation must be on the target contig "
                                    f"{(tb.get('path') or {}).get('contig')}, not {chrom!r}")
            out_obs.append({"id": o["id"], "dataset_id": ds, "kind": "linear", "binding": None, "chrom": chrom,
                            "genome": o.get("genome"), "lift_hap": o.get("lift_hap"), "read_ids": read_ids,
                            "strand": strand})
        else:
            raise GraphRunError("observation kind must be graph or linear")
    ids = [o["id"] for o in out_obs]
    if len(set(ids)) != len(ids):
        raise GraphRunError("observation ids must be distinct")
    options = body.get("options") or {}
    if not isinstance(options, dict):
        raise GraphRunError("options must be an object")
    if options.get("repeat_columns", "exclude") != "exclude":
        raise GraphRunError("repeat_columns: only exclude is available")
    carrier = options.get("carrier_features", "refine")
    if carrier not in ("refine", "drop"):
        raise GraphRunError("carrier_features must be refine or drop (masked fits are not available)")
    if options.get("coverage_rule", "require_all") != "require_all":
        raise GraphRunError("coverage_rule: only require_all is available")
    min_samples = options.get("carrier_min_samples", gc.DEFAULT_CARRIER_MIN_SAMPLES)
    if not isinstance(min_samples, int) or isinstance(min_samples, bool) or min_samples < 1:
        raise GraphRunError("carrier_min_samples must be a positive integer")
    # Canonical order: by observation id, so panel and lane permutations never change the fit.
    out_obs.sort(key=lambda o: o["id"])
    return {"target": target, "target_size": tb.get("size"), "regions": ordered, "observations": out_obs,
            "binding_order": [b["key"] for b in reg.bindings],
            # Every path compared with the target: insertion frames are canonical over the package, not the run.
            "compared": sorted({m.get("source") for m in reg.maps if m.get("target") == target and m.get("source")}),
            "options": {"repeat_columns": "exclude", "carrier_features": carrier, "coverage_rule": "require_all",
                        "insertions": options.get("insertions", "include") != "exclude",
                        "carrier_min_samples": min_samples}}


def needed_tiles(spec: dict) -> tuple[list[Optional[str]], list[int]]:
    """Tiles of every path compared with the target when the run has a graph observation (canonical insertion
    frames read every package path, §2.3), else of the target alone."""
    graph = {o["binding"] for o in spec["observations"] if o["kind"] == "graph"}
    sources = sorted(graph | set(spec.get("compared") or ())) if graph else []
    cells = sorted({c for r in spec["regions"] for c in gc.cells_for(r["start"], r["end"])})
    return (sources or [None]), cells


# ── Geometry ────────────────────────────────────────────────────────────────

def build_geometry(spec: dict, tiles: dict):
    """Columns of every region and the run's stage plan, from the tile responses."""
    target = spec["target"]
    observations = [gc.Observation(o["id"], o["binding"]) for o in spec["observations"]]
    regions = []
    for i, r in enumerate(spec["regions"]):
        cells = gc.cells_for(r["start"], r["end"])
        all_results = [res for per in tiles.values() for c, res in per.items() if c in cells]
        target_occs = gc.merge_occurrences(all_results, target)
        path_occs, cell_results = {}, {}
        for source, per in tiles.items():
            if source is None:
                continue
            mine = [per[c] for c in cells if c in per]
            path_occs[source] = gc.merge_occurrences(mine, source)
            cell_results[source] = {c: per[c] for c in cells if c in per}
        regions.append(gc.region_columns(i, r["start"], r["end"], target, target_occs, observations, path_occs,
                                         cell_results, insertions=spec["options"]["insertions"],
                                         binding_order=spec.get("binding_order")))
    plan = gc.stage_plan(regions, [o.id for o in observations],
                         carrier_features=spec["options"]["carrier_features"],
                         carrier_min_samples=spec["options"]["carrier_min_samples"])
    return regions, plan


def _modes(spec, features):
    return [spec["regions"][f.region]["mode"] for f in features]


def _windows(spec, features, oids, read_ids=None):
    """RegionViewports of the observations (in order) over ``features``, and their graph sources."""
    from models.requests import FrameBlock, RegionViewport
    byid = {o["id"]: o for o in spec["observations"]}
    views, sources = [], {}
    for oid in oids:
        o = byid[oid]
        blocks = gc.feature_blocks(features, oid)
        if not blocks:
            continue
        lo = min(b["genomic"][0] for b in blocks)
        hi = max(b["genomic"][1] for b in blocks)
        start, end = max(0, lo - WINDOW_PAD_BP), hi + WINDOW_PAD_BP
        ids = read_ids.get(oid) if read_ids is not None else o.get("read_ids")
        common = dict(dataset_id=o["dataset_id"], result_key=oid, start=start, end=end, read_ids=ids,
                      strand=o.get("strand"), wraps_origin=False,
                      blocks=[FrameBlock(feature=b["feature"], frame=b["frame"], genomic=b["genomic"],
                                         reverse=b["reverse"]) for b in blocks])
        if o["kind"] == "graph":
            views.append(RegionViewport(chrom=o["contig"], **common))
            sources[oid] = GraphSource(o["dataset_id"], o["binding"], o["contig"])
        else:
            views.append(RegionViewport(chrom=o["chrom"], genome=o.get("genome"), lift_hap=o.get("lift_hap"), **common))
    return views, sources


def _request(spec, features, views, settings: dict):
    from models.requests import PeakRegion, RegionClusterRequest
    modes = settings.get("peak_modes") or _modes(spec, features)
    return RegionClusterRequest(
        viewports=views, peak_regions=[PeakRegion(start=0, end=f.length, mode=m) for f, m in zip(features, modes)],
        sample_positions=[list(f.samples) for f in features], method=settings["method"], k=settings["k"],
        max_reads=settings.get("max_reads"), sample_seed=settings.get("sample_seed"),
        subnucleosomal_threshold=settings["subnucleosomal_threshold"],
        accessibility_threshold=settings["accessibility_threshold"],
        cluster_feature_rules=settings.get("cluster_feature_rules") or [], resolution=settings.get("resolution", 1.0),
        balance_windows=settings.get("balance_windows", True), dataset_ids=sorted({v.dataset_id for v in views}),
        feature_geometry="crop")


def _settings_of(body: dict) -> dict:
    from services.cluster_assignment import check_cluster_method
    method = str(body.get("method") or "kmeans")
    check_cluster_method(method)
    k = body.get("k", 4)
    if not isinstance(k, int) or isinstance(k, bool) or not 1 <= k <= 50:
        raise GraphRunError("k must be 1–50")
    max_reads = body.get("max_reads")
    if max_reads is not None and (not isinstance(max_reads, int) or isinstance(max_reads, bool) or max_reads < 1):
        raise GraphRunError("max_reads must be a positive integer")
    return dict(method=method, k=k, max_reads=max_reads, sample_seed=body.get("sample_seed"),
                subnucleosomal_threshold=int(body.get("subnucleosomal_threshold", 90)),
                accessibility_threshold=float(body.get("accessibility_threshold", 0.5)),
                cluster_feature_rules=body.get("cluster_feature_rules") or [],
                resolution=float(body.get("resolution", 1.0)), balance_windows=bool(body.get("balance_windows", True)))


def observation_snapshot(state, spec) -> dict:
    """What determines an observation's rows and values besides the run's settings (§3.5, review G5): its dataset's
    files and lift identity (revision), its cohort settings (lifted) and the loader options. A durable model is only
    assigned while these are unchanged."""
    from services.graph_panel.reads import _settings, dataset_revision
    from services.read_quality_filters import active_quality_filters
    opts = {**_loader_options(state), "quality_filters": repr(active_quality_filters(state))}
    out = {}
    for o in spec["observations"]:
        ds = state.datasets.get(o["dataset_id"])
        lifted = ds is not None and getattr(ds, "live_lift", None) is not None
        out[o["id"]] = {"dataset_revision": dataset_revision(ds) if ds is not None else None,
                        "cohort": _settings(ds).as_dict() if lifted else None, "loader": opts}
    return out


def _digest(spec, features, oids, settings, observed=None, stage=None) -> str:
    """The stage's geometry, extraction settings, its observations' snapshots, run options, and which stage it is
    (stage, carrier set, parent and its model): a reconstruction must match it exactly, and a model never serves
    another stage or parent."""
    snap = {k: settings.get(k) for k in ("method", "subnucleosomal_threshold", "accessibility_threshold",
                                         "cluster_feature_rules", "k", "resolution", "balance_windows")}
    payload = [gc.geometry_digest(features, oids), snap, _modes(spec, features), spec["target"],
               {o: (observed or {}).get(o) for o in oids}, spec.get("options"), stage]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


# ── Runs ────────────────────────────────────────────────────────────────────

def _label_key(label) -> tuple:
    return tuple(int(x) for x in str(label).split("."))


def _model_hash(model) -> str:
    return hashlib.sha256(json.dumps(model, sort_keys=True, default=str).encode()).hexdigest()


def _echoes(out) -> dict:
    """Rows the engine echoed (a folded molecule fitted on another path): ``{(obs, aid): winning obs}``."""
    return {(oid, aid): src for oid, res in out["results"].items() for aid, src in (res.get("echoed") or {}).items()}


def _refine(state, spec, plan, labels, settings, observed, cache, sets_from, echoes, fitted=None):
    """Stage 2 (§2.6 refineWithinCarriers): for each carrier set in order, each current cluster's carriers are
    subclustered on the set's features (fit), or assigned with that (set, parent)'s model (``fitted``: the run's
    stages). Echoed rows (a folded molecule fitted on another path) never enter; non-carriers keep their labels.
    Returns ``(stages, refinements, every label seen)``."""
    from services.correspondence_clustering import run as engine
    stages, refinements, seen = [], [], set()
    by_key = {(st.get("set"), str(st.get("parent"))): st for st in (fitted or ())}
    for z, cs in enumerate(plan.carrier_sets):
        if z < sets_from:
            continue
        carriers = [c for c in cs["carriers"] if c in labels]
        parents = sorted({lab for c in carriers for lab in labels[c].values()}, key=_label_key)
        for parent in parents:
            st = by_key.get((z, parent)) if fitted is not None else None
            if fitted is not None:
                if st is None:
                    continue   # no refinement of this parent was fitted: its rows keep the parent label
                allowed = list(st.get("carriers") or [])
                if not set(allowed) <= set(cs["carriers"]):
                    raise GraphRunError("settings or geometry changed: cluster again", "stale_model", 409)
                if st.get("digest") != _digest(spec, cs["features"], allowed, settings, observed,
                                               [2, z, parent, _model_hash(st.get("model"))]):
                    raise GraphRunError("settings or geometry changed: cluster again", "stale_model", 409)
                pool = allowed
            else:
                pool = carriers
            ids = {c: sorted(aid for aid, lab in labels.get(c, {}).items() if lab == parent and (c, aid) not in echoes)
                   for c in pool}
            ids = {c: v for c, v in ids.items() if v}
            if fitted is None and sum(len(v) for v in ids.values()) < 2:
                continue
            if not ids:
                continue
            views2, sources2 = _windows(spec, cs["features"], sorted(ids), read_ids=ids)
            if not views2:
                continue
            req2 = _request(spec, cs["features"], views2, settings)
            try:
                out2 = engine(state, req2, sources=sources2, row_cache=cache,
                              **({"model": st.get("model") or {}} if st is not None else {}))
            except ValueError as exc:
                if fitted is not None:
                    raise GraphRunError(str(exc), "stale_model", 409) from None
                refinements.append({"set": z, "parent": parent, "skipped": str(exc)})
                continue
            subs = {(oid, aid): int(sub) for oid, res in out2["results"].items() for aid, sub in res["assignments"].items()
                    if aid in labels.get(oid, {}) and int(sub) >= 0}
            model = out2.get("model") or {}
            if fitted is None and (len(subs) < 2 or not model.get("peak_widths")
                                   or not (model.get("centroids") or model.get("cluster_patterns"))):
                # Fewer than two covering rows (or no model): nothing to refine; they keep the parent label.
                refinements.append({"set": z, "parent": parent, "skipped": "fewer than two rows cover the features"})
                continue
            for (oid, aid), sub in subs.items():
                labels[oid][aid] = f"{parent}.{sub}"
                seen.add(f"{parent}.{sub}")
            if fitted is None:
                stages.append({"stage": 2, "set": z, "parent": parent, "carriers": sorted(ids),
                               "features": [f.public() for f in cs["features"]],
                               "samples": [list(f.samples) for f in cs["features"]], "model": model,
                               "digest": _digest(spec, cs["features"], sorted(ids), settings, observed,
                                                 [2, z, parent, _model_hash(model)])})
                refinements.append({"set": z, "parent": parent, "rows": len(subs)})
    # A folded molecule echoed onto another path takes its winning row's final label.
    for (oid, aid), src in echoes.items():
        if aid in labels.get(src, {}) and oid in labels:
            labels[oid][aid] = labels[src][aid]
    return stages, refinements, seen


def _first_stage(plan):
    """Stage 1's features and observations: the shared features over every participant; a run with no shared
    feature (§2.6 item 4) fits its first carrier set's carriers on that set's features instead (the other
    observations carry none of them: "not a carrier", unlabelled)."""
    if plan.shared:
        return plan.shared, plan.participants, 0
    if not plan.carrier_sets:
        raise GraphRunError("The regions have no position the paths carry: choose regions on the graph's shared sequence")
    cs = plan.carrier_sets[0]
    return cs["features"], list(cs["carriers"]), 1


def run(state, reg, body: dict, tiles: dict, spec: Optional[dict] = None) -> dict:
    """Fit a graph run (stage 1, then refinements within carriers) and return per-observation labels, the staged
    model and the columns report."""
    from services.correspondence_clustering import run as engine
    t0 = time.perf_counter()
    spec = spec or parse(state, reg, body)
    settings = _settings_of(body)
    regions, plan = build_geometry(spec, tiles)
    observed = observation_snapshot(state, spec)
    t_cols = time.perf_counter()
    cache: dict = {}
    first, oids, sets_from = _first_stage(plan)
    views, sources = _windows(spec, first, oids)
    req = _request(spec, first, views, settings)
    out1 = engine(state, req, sources=sources, row_cache=cache)
    stage1 = {oid: {aid: str(label) for aid, label in res["assignments"].items()} for oid, res in out1["results"].items()}
    labels = copy.deepcopy(stage1)
    model1 = out1.get("model")
    stages = [{"stage": 1, "observations": oids, "features": [f.public() for f in first],
               "samples": [list(f.samples) for f in first], "model": model1,
               "digest": _digest(spec, first, oids, settings, observed, [1, 0 if sets_from else None, None, _model_hash(model1)]),
               **({"set": 0} if sets_from else {})}]
    refinements, seen = [], set()
    if plan.carrier_sets and spec["options"]["carrier_features"] == "refine":
        more, refinements, seen = _refine(state, spec, plan, labels, settings, observed, cache, sets_from, _echoes(out1))
        stages.extend(more)
    # Integer ids: stage-1 labels keep theirs; refined labels follow in order, named C<parent>.<j>.
    # (Every label the stage-1 model can give, used or not, keeps its id; every intermediate refined label too.)
    model_ids = {int(k) for k in ((model1 or {}).get("centroids") or {})} | {int(k) for k in ((model1 or {}).get("cluster_patterns") or {})}
    base_ids = sorted({int(lab) for per in stage1.values() for lab in per.values()} | model_ids)
    nxt = (max(base_ids) + 1) if base_ids else 0
    label_ids, names = {}, {}
    every = ({lab for per in labels.values() for lab in per.values()} | {lab for per in stage1.values() for lab in per.values()}
             | seen | {str(i) for i in base_ids})
    for lab in sorted(every, key=_label_key):
        if "." not in lab:
            label_ids[lab] = int(lab)
        else:
            label_ids[lab] = nxt
            names[nxt] = "C" + lab
            nxt += 1
    results = {}
    for o in spec["observations"]:
        oid = o["id"]
        r1 = out1["results"].get(oid)
        if r1 is None:
            results[oid] = {"assignments": {}, "left_out": plan.left_out.get(oid) or "no reads cover the regions"}
            continue
        final = {aid: label_ids[lab] for aid, lab in labels.get(oid, {}).items()}
        results[oid] = {**{k: v for k, v in r1.items() if k != "assignments"}, "assignments": final,
                        "stage1": {aid: int(lab) for aid, lab in stage1.get(oid, {}).items()},
                        "cluster_counts": dict(Counter(final.values()))}
    report = {"regions": [{"start": r["start"], "end": r["end"], "mode": r["mode"]} for r in spec["regions"]],
              "shared": [f.public() for f in plan.shared],
              "carrier_sets": [{"carriers": cs["carriers"], "features": [f.public() for f in cs["features"]]}
                               for cs in plan.carrier_sets],
              "left_out": plan.left_out, "refinements": refinements, **plan.report}
    return {"results": results, "label_ids": label_ids, "names": {str(k): v for k, v in names.items()},
            "stages": stages, "columns": report, "observations": [o["id"] for o in spec["observations"]],
            "window_separation_nmi": out1.get("window_separation_nmi"), "joint_cohort": out1.get("joint_cohort"),
            "matched": out1.get("matched"), "settings": settings, "sample_seed": out1.get("sample_seed"),
            "revisions": dict(reg.revisions), "target": spec["target"], "options": spec["options"],
            "timings": {"columns_ms": round((t_cols - t0) * 1000, 1),
                        "total_ms": round((time.perf_counter() - t0) * 1000, 1)}}


def assign(state, reg, body: dict, tiles: dict, spec: Optional[dict] = None) -> dict:
    """Dynamic assignment with a run's staged model (§3.5): the persisted geometry (rebuilt from the tiles and
    checked against each stage's digest), the run's settings snapshot, stage 1 on the shared features, then each
    refinement on its carrier set's features for the carriers of its parent cluster only."""
    from services.correspondence_clustering import run as engine
    spec = spec or parse(state, reg, body)
    run_def = body.get("run")
    if not isinstance(run_def, dict) or not isinstance(run_def.get("stages"), list) or not run_def["stages"]:
        raise GraphRunError("run must carry the staged model")
    if run_def.get("revisions") != dict(reg.revisions):
        raise GraphRunError("settings or geometry changed: cluster again (the graph package changed)", "stale_model", 409)
    settings = run_def.get("settings")
    if not isinstance(settings, dict):
        raise GraphRunError("run.settings is missing")
    # Every eligible row is assigned (no sample cap): rows the fit's cap left out get labels too.
    settings = {**_settings_of(settings), "max_reads": None}
    regions, plan = build_geometry(spec, tiles)
    observed = observation_snapshot(state, spec)
    cache: dict = {}
    s1 = run_def["stages"][0]
    first, oids, sets_from = _first_stage(plan)
    if s1.get("digest") != _digest(spec, first, oids, settings, observed,
                                   [1, 0 if sets_from else None, None, _model_hash(s1.get("model"))]) \
            or s1.get("observations") != oids:
        raise GraphRunError("settings or geometry changed: cluster again", "stale_model", 409)
    views, sources = _windows(spec, first, oids)
    out1 = engine(state, _request(spec, first, views, settings), sources=sources, row_cache=cache,
                  model=s1.get("model") or {})
    labels = {oid: {aid: str(label) for aid, label in res["assignments"].items()} for oid, res in out1["results"].items()}
    _refine(state, spec, plan, labels, settings, observed, cache, sets_from, _echoes(out1),
            fitted=[st for st in run_def["stages"][1:] if isinstance(st, dict)])
    table = {str(k): int(v) for k, v in (run_def.get("label_ids") or {}).items()}
    results = {}
    for o in spec["observations"]:
        per = labels.get(o["id"], {})
        # A refined label the fit never produced cannot be named: the read keeps its parent cluster.
        results[o["id"]] = {"assignments": {aid: table.get(lab, table.get(lab.rsplit(".", 1)[0], -1) if "." in lab else int(lab))
                                            for aid, lab in per.items()}}
    return {"results": results, "observations": [o["id"] for o in spec["observations"]]}


async def handle(state, reg, body: dict, *, mode: str = "fit") -> dict:
    """The route's work: tiles on the event loop (the helper pool), the fit or assignment in a worker thread."""
    spec = parse(state, reg, body)
    sources, cells = needed_tiles(spec)
    started = time.perf_counter()
    tiles = await fetch_tiles(reg, spec["target"], sources, cells)
    tiles_ms = round((time.perf_counter() - started) * 1000, 1)
    fn = run if mode == "fit" else assign
    out = await asyncio.to_thread(fn, state, reg, body, tiles, spec)
    out.setdefault("timings", {})["tiles_ms"] = tiles_ms
    return out
