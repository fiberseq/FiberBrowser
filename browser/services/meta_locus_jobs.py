"""Meta-locus pools: built in the background as soon as a BED is loaded, with progress and Cancel.

A pool (services/meta_locus_pool) is identified by its spec: the BED's content hash, the datasets' file identities
and the pool rules. Starting the same spec again returns the running or finished pool. Each dataset's index comes
from the on-disk cache when present, else from a background enumeration that reports progress (sites, compressed
bytes, ETA) and stops between blocks on Cancel. While it builds, the entries found so far form a provisional pool:
blocks are read in a stable shuffled order, so a provisional working set is an unbiased sample of sites (marked
``provisional`` with the fraction built).

Working sets (``working_set``) are stateless: the client sends the seed and how far into each dataset's key order
it has taken (``cursor``); the answer carries the new cursor. "More reads" continues from the cursor, "Resample"
sends a new seed and an empty cursor, and a saved session restores both.
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from services import meta_locus_pool as mp

WORKING_DEFAULTS = {
    "seed": 1,
    "count": 2000,               # reads per request (the working set; "More reads" asks for its step)
    "max_count": 10_000,
    "max_topup_rounds": 8,       # rounds of replacing reads the read filters removed
    "overshoot": 0.1,            # extra ranks decoded per round, as a fraction (the expected filtered share)
    "count_unit": "observation", # observation: each (read, site) pair counts (owner); molecule: a read name once
    "include_methylation": False,
    "include_layers": True,
    "hide_terminal_gaps": True,  # the display's read filters, with the display's defaults
    "terminal_gap_threshold": 500,
    "min_footprints": 0,
    "min_fp_quality": 0,
    "include_duplicates": False,
}
MAX_POOLS = 8  # pools kept in memory (least recently used dropped; their caches stay on disk)
# All owners together (a lab server): past this a new pool is refused, never made by dropping another member's.
MAX_POOLS_TOTAL = 64


class PoolsFull(ValueError):
    """The server holds MAX_POOLS_TOTAL pools of other members; a new one is refused (nothing of theirs is dropped)."""

_lock = threading.RLock()
# View generations are unique for the process (a pool rebuilt under the same id never reuses one: read caches key on it).
_GENERATIONS = __import__("itertools").count(1)
# Keyed by (owner, pool id): on a lab server each member's workspace has pools of its own (``_owner``); off the
# lab profile the owner is always None, so one process-wide registry as before.
_pools: "dict[tuple, PoolState]" = {}


def _owner() -> Optional[str]:
    """Who this request's pools belong to: a lab member's workspace, else None (services.runtime.lab_owner_key)."""
    from services.runtime import lab_owner_key
    return lab_owner_key()


@dataclass
class PoolState:
    pool_id: str
    name: str
    spec: dict
    sites: mp.Sites
    order: list
    paths: dict
    chrom_map: dict
    cache_keys: dict
    indexes: dict = field(default_factory=dict)       # dataset -> complete DatasetIndex
    partial: dict = field(default_factory=dict)       # dataset -> entry store being filled (building)
    dataset_status: dict = field(default_factory=dict)
    status: str = "building"                          # building | ready | cancelled | error
    error: Optional[str] = None
    progress: mp.Progress = field(default_factory=mp.Progress)
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    used: float = field(default_factory=time.monotonic)
    _provisional: dict = field(default_factory=dict)  # dataset -> (rows seen, DatasetIndex)
    # The view: what the virtual contig meta:<pool> shows (services/working_sets reads it through meta_broad_reads).
    view_seed: int = 1
    view_count: int = 2000
    view_extra: list = field(default_factory=list)    # [(dataset, entry)] added by refill / find more (enriched)
    view_generation: int = field(default_factory=lambda: next(_GENERATIONS))
    _decoded: dict = field(default_factory=dict)      # (generation, dataset, options) -> rows (LRU)
    anchor_label: str = ""
    view_set: bool = False                            # a view was asked for (provisional or final): reads are shown
    owner: Optional[str] = None                       # _owner() of the request that started it

    def index_for(self, dataset_id: str) -> Optional[mp.DatasetIndex]:
        if dataset_id in self.indexes:
            return self.indexes[dataset_id]
        acc = self.partial.get(dataset_id)
        if acc is None or not len(acc):
            return None
        hit = self._provisional.get(dataset_id)
        if hit is None or hit[0] != len(acc):
            hit = (len(acc), acc.snapshot(complete=False))
            self._provisional[dataset_id] = hit
        return hit[1]

    def as_status(self) -> dict:
        p = self.progress.as_dict()
        cached_sites = sum(len(self.sites) for d in self.order if self.dataset_status.get(d) == "cached")
        if self.status == "ready":
            p["fraction"] = 1.0
            p["eta_s"] = 0.0
        return {"success": True, "pool_id": self.pool_id, "name": self.name, "status": self.status, "error": self.error,
                "progress": p, "datasets": {d: {"status": self.dataset_status.get(d), "entries": (len(self.indexes[d]) if d in self.indexes
                                                 else len(self.partial.get(d) or ()))} for d in self.order},
                "sites": len(self.sites), "flank_bp": self.sites.flank, "cached_sites": cached_sites,
                "provisional": self.status != "ready", "spec": {k: v for k, v in self.spec.items() if k != "regions"},
                "chrom": self.chrom, "width": 2 * self.sites.flank, "axis_offset": -self.sites.flank, "label": self.label,
                **({"view": view_payload(self)} if self.status == "ready" else {})}

    @property
    def chrom(self) -> str:
        return f"meta:{self.pool_id}"

    @property
    def label(self) -> str:
        flank = self.sites.flank
        size = f"{flank / 1000:g} kb" if flank >= 1000 else f"{flank} bp"
        anchor = self.anchor_label or {"centre": "centre", "start": "TSS", "end": "end"}.get(self.spec.get("anchor"), "anchor")
        return f"{self.name} · {anchor} ± {size}"


def _spec_from(body: dict, regions: list) -> dict:
    spec = {k: body.get(k, v) for k, v in mp.DEFAULTS.items()}
    spec["anchor"] = str(spec["anchor"])
    if spec["anchor"] not in ("centre", "start", "end"):
        raise ValueError("anchor must be centre, start or end")
    if spec["policy"] not in mp.POLICIES:
        raise ValueError("policy must be per_site or nearest")
    spec["policy"] = mp.POLICIES[spec["policy"]]
    for k in ("flank_bp", "min_overlap_bp", "block_max_gap_bp", "block_max_len_bp", "bam_threads", "max_entries"):
        spec[k] = int(spec[k])
    if not 1 <= spec["flank_bp"] <= mp.MAX_FLANK:
        raise ValueError(f"flank_bp must be 1..{mp.MAX_FLANK:,}")
    spec["regions_sha256"] = mp.regions_sha256(regions)
    if body.get("bed_path"):
        spec["bed_path"] = str(body["bed_path"])  # where the BED is (an uploaded one: its saved copy)
    spec["workers"] = int(body.get("workers") or 0)
    return spec


def _native_bam_paths(state, dataset_ids: list) -> dict:
    out = {}
    for d in dataset_ids:
        ds = (getattr(state, "datasets", None) or {}).get(d)
        if ds is None:
            raise KeyError(d)
        paths = [str(p) for p in (getattr(ds, "paths", None) or [])]
        if getattr(ds, "data_type", "bam") not in ("bam", None) or not paths or any("://" in p for p in paths):
            raise ValueError(f"A meta-locus needs local native BAM datasets ({d} is not one)")
        out[d] = paths
    return out


def start_pool(state, body: dict, regions: list, name: str = "") -> PoolState:
    """Start (or return) the pool of ``regions`` over ``body['dataset_ids']`` (default: every native BAM dataset)."""
    if not regions:
        raise ValueError("No regions")
    ids = [str(d) for d in (body.get("dataset_ids") or [])] or [d for d in (getattr(state, "dataset_order", None) or list(getattr(state, "datasets", {}) or {}))
                                                               if getattr(state.datasets[d], "data_type", "bam") == "bam"]
    if not ids:
        raise ValueError("No native BAM dataset is loaded")
    paths = _native_bam_paths(state, ids)
    spec = _spec_from(body, regions)
    chrom_map = dict(getattr(state, "chrom_map", None) or {})
    cache_keys = {d: mp.dataset_cache_key(paths[d], spec, chrom_map) for d in ids}
    pool_id = mp._digest({"keys": [cache_keys[d] for d in ids], "ids": ids, "block": [spec["block_max_gap_bp"], spec["block_max_len_bp"]]}, 16)
    owner = _owner()
    with _lock:
        hit = _pools.get((owner, pool_id))
        if hit is not None and hit.status in ("building", "ready"):
            hit.used = time.monotonic()
            return hit
        own = sum(1 for p in _pools.values() if p.owner == owner)
        if own < MAX_POOLS and len(_pools) >= MAX_POOLS_TOTAL:
            raise PoolsFull(f"The server already holds {len(_pools)} meta-locus pools; close one of yours or try "
                            "again later (other members' pools are not dropped to make room)")
        sites = mp.build_sites(regions, spec["anchor"], spec["flank_bp"])
        pool = PoolState(pool_id, name or "regions", spec, sites, ids, paths, chrom_map, cache_keys,
                         anchor_label=str(body.get("anchor_label") or ""), owner=owner)
        pool.view_seed = int(body.get("seed") or WORKING_DEFAULTS["seed"])
        pool.view_count = max(0, min(WORKING_DEFAULTS["max_count"], int(body.get("count") or WORKING_DEFAULTS["count"])))
        _pools[(owner, pool_id)] = pool
        _trim(owner)
    for d in ids:
        ix = mp.DatasetIndex.load(d, mp.cache_path(cache_keys[d]))
        if ix is not None:
            ix.cache_key = cache_keys[d]
            pool.indexes[d] = ix
            pool.dataset_status[d] = "cached"
        else:
            pool.dataset_status[d] = "queued"
    todo = [d for d in ids if d not in pool.indexes]
    if not todo:
        pool.status = "ready"
        _warm_keys(pool)
        return pool
    threading.Thread(target=_build, args=(pool, todo), name=f"meta-locus-{pool_id}", daemon=True).start()
    return pool


def probe_pool(state, body: dict, regions: list) -> dict:
    """Whether the pool of this spec is built already (in memory, or every dataset's index in the cache):
    the Open dialog's "cached: opens instantly"."""
    if not regions:
        return {"success": True, "cached": False}
    ids = [str(d) for d in (body.get("dataset_ids") or [])] or [d for d in (getattr(state, "dataset_order", None) or list(getattr(state, "datasets", {}) or {}))
                                                               if getattr(state.datasets[d], "data_type", "bam") == "bam"]
    if not ids:
        return {"success": True, "cached": False}
    paths = _native_bam_paths(state, ids)
    spec = _spec_from(body, regions)
    chrom_map = dict(getattr(state, "chrom_map", None) or {})
    cache_keys = {d: mp.dataset_cache_key(paths[d], spec, chrom_map) for d in ids}
    pool_id = mp._digest({"keys": [cache_keys[d] for d in ids], "ids": ids, "block": [spec["block_max_gap_bp"], spec["block_max_len_bp"]]}, 16)
    with _lock:
        hit = _pools.get((_owner(), pool_id))
    cached = (hit is not None and hit.status == "ready") or all(mp.cache_path(k).is_file() for k in cache_keys.values())
    return {"success": True, "cached": bool(cached), "pool_id": pool_id, "sites": len(regions)}


def _build(pool: PoolState, todo: list) -> None:
    def one(d):
        pool.dataset_status[d] = "building"

        def on_start(acc):
            pool.partial[d] = acc

        ix = mp.enumerate_dataset(d, pool.paths[d], pool.sites, pool.spec, chrom_map=pool.chrom_map, progress=pool.progress,
                                  on_start=on_start, cancelled=pool.cancel.is_set)
        try:
            ix.save(mp.cache_path(pool.cache_keys[d]))
            ix.cache_key = pool.cache_keys[d]
            mp.evict_cache(keep=tuple(mp.cache_path(k).name for k in pool.cache_keys.values()))
        except OSError:
            pass  # a cache that cannot be written only costs a rebuild
        pool.indexes[d] = ix
        pool.partial.pop(d, None)
        pool._provisional.pop(d, None)
        pool.dataset_status[d] = "done"

    workers = pool.spec.get("workers") or min(4, len(todo))
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            for f in [ex.submit(one, d) for d in todo]:
                f.result()
        pool.status = "ready"
        # The final pool replaces a provisional view: new reads under a new generation.
        pool.view_generation = next(_GENERATIONS)
        pool._decoded.clear()
        _warm_keys(pool)
    except mp.Cancelled:
        pool.status = "cancelled"
        for d in todo:
            if pool.dataset_status.get(d) != "done":
                pool.dataset_status[d] = "cancelled"
    except Exception as exc:  # noqa: BLE001 - reported on the pool's status
        pool.cancel.set()
        pool.status = "error"
        pool.error = str(exc)


def _warm_keys(pool: PoolState, seed: int = WORKING_DEFAULTS["seed"]) -> None:
    """Compute the default seed's keys in the background (about 1 us per entry), so the first working set of a
    large pool does not wait for them."""
    def run():
        try:
            from services.meta_locus_decode import warm_workers
            warm_workers()
        except Exception:  # noqa: BLE001 - decoding falls back to this process
            pass
        for ix in list(pool.indexes.values()):
            if pool.cancel.is_set():
                return
            ix.ranked(seed)  # keys (disk or computed) and the sampling order
    threading.Thread(target=run, name=f"meta-locus-keys-{pool.pool_id}", daemon=True).start()


def _trim(owner: Optional[str]) -> None:
    """Keep at most MAX_POOLS of ``owner``'s pools (least recently used dropped); other owners' are untouched."""
    while True:
        mine = [p for p in _pools.values() if p.owner == owner]
        if len(mine) <= MAX_POOLS:
            return
        idle = [p for p in mine if p.status != "building"] or mine
        victim = min(idle, key=lambda p: p.used)
        victim.cancel.set()
        _pools.pop((victim.owner, victim.pool_id), None)


def get_pool(pool_id: str) -> Optional[PoolState]:
    """This request's pool ``pool_id`` (another member's or workspace's: None)."""
    with _lock:
        pool = _pools.get((_owner(), pool_id))
    if pool is not None:
        pool.used = time.monotonic()
    return pool


def list_pools() -> list:
    owner = _owner()
    with _lock:
        return [p.as_status() for p in _pools.values() if p.owner == owner]


def cancel_pool(pool_id: str) -> Optional[PoolState]:
    pool = get_pool(pool_id)
    if pool is not None:
        pool.cancel.set()
    return pool


def drop_pool(pool_id: str) -> bool:
    with _lock:
        pool = _pools.pop((_owner(), pool_id), None)
    if pool is not None:
        pool.cancel.set()
    return pool is not None


# ----------------------------------------------------------------------------------------------------- working sets


def working_set(pool: PoolState, body: dict, state=None, cancelled=None) -> dict:
    """Reads of the next ``count`` ranks per the seed and cursor (see the module docstring), decoded by stored file
    position with the display's read filters; a filtered read is replaced from the next ranks (``max_topup_rounds``)."""
    from services.meta_locus_decode import decode_entries_parallel, virtualize_read

    opts = {k: body.get(k, v) for k, v in WORKING_DEFAULTS.items()}
    seed = int(opts["seed"])
    overshoot = max(0.0, float(opts["overshoot"]))
    count = max(0, min(int(opts["max_count"]), int(opts["count"])))
    cursor = {str(k): max(0, int(v)) for k, v in (body.get("cursor") or {}).items()}
    loader = dict(include_methylation=bool(opts["include_methylation"]), include_layers=bool(opts["include_layers"]),
                  requested_layers=body.get("requested_layers") or None, include_layer_qualities=bool(body.get("include_layer_qualities", True)),
                  hide_terminal_gaps=bool(opts["hide_terminal_gaps"]), terminal_gap_threshold=int(opts["terminal_gap_threshold"]),
                  min_footprints=int(opts["min_footprints"]), min_fp_quality=int(opts["min_fp_quality"]),
                  include_duplicates=bool(opts["include_duplicates"]),
                  short_terminal_footprint_bp=int(getattr(state, "short_terminal_footprint_bp", 0) or 0))
    decode_options = {k: body[k] for k in ("decode_workers", "parallel_min_reads", "batch_span_bp", "batch_reads") if k in body}
    if "decode_workers" in decode_options:
        decode_options["workers"] = int(decode_options.pop("decode_workers"))
    indexes = {d: ix for d in pool.order if (ix := pool.index_for(d)) is not None}
    provisional = any(not ix.complete for ix in indexes.values()) or len(indexes) < len(pool.order)
    sites = pool.sites
    reads: list = []
    # The uncalled rule (3.0.6; the request's, default hide): uncalled reads are not in the sampling order, so the
    # working set fills with called ones; "All reads, including uncalled" puts them back.
    hide = _hide_uncalled(body)
    loader["hide_uncalled"] = hide
    stats = {d: {"requested": 0, "returned": 0, "filtered": 0, "undecodable": 0, "pool": ix.n_entries(hide),
                 "pool_molecules": ix.n_molecules} for d, ix in indexes.items()}
    ranked = {d: ix.ranked(seed, hide) for d, ix in indexes.items()}
    sizes = {d: range(len(ranked[d])) for d in indexes}
    molecules = {d: set() for d in indexes}
    keys = {d: ix.keys(seed) for d, ix in indexes.items()}
    need = count
    rounds = 0
    while need > 0 and rounds <= int(opts["max_topup_rounds"]):
        rounds += 1
        ranges = mp.take_balanced(sizes, pool.order, seed, cursor, need)
        if not any(b > a for a, b in ranges.values()):
            break
        got_now = 0
        # Decode a few more ranks than needed (the read filters remove some) so most requests take one round;
        # reads are accepted in rank order and the cursor stops after the last one accepted, so the extras
        # decoded past it are taken again by the next request: no read is skipped or repeated.
        plan = {}
        for d, (a, b) in ranges.items():
            if b > a:
                extra = int(np.ceil((b - a) * overshoot)) + (4 if overshoot > 0 else 0)
                b2 = min(len(ranked[d]), b + extra)
                plan[d] = (a, b, b2, [int(e) for e in ranked[d][a:b2]])
        # The datasets decode at the same time (their chunks share the worker pool).
        results = {}

        def run(d):
            st: dict = {}
            decoded = decode_entries_parallel(pool.paths[d], indexes[d], sites, plan[d][3], loader_options=loader,
                                              chrom_map=pool.chrom_map, options=decode_options, stats=st, cancelled=cancelled)
            return decoded, st

        if len(plan) > 1:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(plan)) as ex:
                futures = {d: ex.submit(run, d) for d in plan}
                results = {d: f.result() for d, f in futures.items()}
        else:
            results = {d: run(d) for d in plan}
        for d in ranges:
            if d not in plan:
                continue
            a, b, b2, ents = plan[d]
            ix = indexes[d]
            share = b - a
            decoded, st = results[d]
            accepted = 0
            end = b2
            for rank, e in zip(range(a, b2), ents):
                if accepted >= share:
                    end = rank
                    break
                row = decoded.get(e)
                if row is None:
                    continue
                s = int(ix.site[e])
                m = int(ix.mol[e])
                shared = bool(ix.shared[e])
                row["meta"] = {"dataset": d, "rank": rank, "key": format(int(keys[d][m]), "016x"), "read_start": int(ix.start[m]),
                               "read_end": int(ix.end[m]), "shared": shared, **sites.provenance(s),
                               # the read's identity on the meta contig (its virtual coordinates are not a record's)
                               "identity": {"dataset": d, "name": ix.names[m], "site": s}}
                molecules[d].add(m)
                if shared:
                    row["source_id"] = row.get("id")
                    row["id"] = f"{row.get('id')}#site{s}"
                reads.append(virtualize_read(row, sites, s))
                accepted += 1
            consumed = end - a
            stats[d]["requested"] += consumed
            stats[d]["returned"] += accepted
            stats[d]["filtered"] += consumed - accepted  # removed by the read filters (or not found: undecodable)
            stats[d]["undecodable"] += int(st.get("undecodable", 0))
            got_now += accepted
            cursor[d] = end
        need -= got_now
    unit = str(opts["count_unit"])
    if unit not in ("observation", "molecule"):
        raise ValueError("count_unit must be observation or molecule")
    for d in indexes:
        # The unit is the (read, site) observation: a read overlapping two sites is an independent observation of
        # each (owner). count_unit "molecule" counts a read name once instead. Both are always reported.
        stats[d]["observations"] = stats[d]["returned"]
        stats[d]["molecules"] = len(molecules[d])
        stats[d]["pool_observations"] = stats[d]["pool"]
    exhausted = all(cursor.get(d, 0) >= len(ranked[d]) for d in indexes)
    total_key = "pool_observations" if unit == "observation" else "pool_molecules"
    # The same per-dataset payload shape as /api/reads/compact (a view of chrom meta:<pool> at -flank..+flank).
    by_dataset = {d: {"dataset_id": d, "reads": [r for r in reads if r["meta"]["dataset"] == d], "width": 2 * sites.flank,
                      "count": stats[d]["returned"], "display_count": stats[d]["returned"], "working_count": stats[d]["returned"],
                      "total": stats[d][total_key], "total_overlapping": stats[d][total_key],
                      "total_in_scope": stats[d][total_key], "count_unit": unit,
                      "sample_seed": seed} for d in indexes}
    return {"success": True, "pool_id": pool.pool_id, "seed": seed, "cursor": cursor, "reads": reads,
            "offset": -sites.flank, "width": 2 * sites.flank, "chrom": f"meta:{pool.pool_id}",
            "provisional": provisional, "pool_fraction": 1.0 if not provisional else pool.progress.as_dict()["fraction"],
            "exhausted": exhausted, "stats": stats, "returned": len(reads), "requested": count,
            "start": 0, "end": 2 * sites.flank, "axis_offset": -sites.flank, "count_unit": unit, "datasets": by_dataset}


# ----------------------------------------------------------------------------------------------------- the view
#
# The virtual contig meta:<pool> is an ordinary contig for every reader: services/working_sets asks meta_broad_reads
# for a dataset's reads over [start, end) of it. The view is the working set (the lowest ``view_count`` keys under
# ``view_seed``, balanced over the datasets) plus the entries refill / find more added; the display's read filters
# apply when reads are decoded, as on any contig. Its generation is part of every read cache key (read_load_token).

DECODED_CACHE = 4


def pool_for_chrom(chrom: str) -> Optional[PoolState]:
    if not str(chrom).startswith("meta:"):
        return None
    with _lock:
        return _pools.get((_owner(), str(chrom)[5:]))


def meta_chrom_size(chrom: str) -> Optional[int]:
    pool = pool_for_chrom(chrom)
    return 2 * pool.sites.flank if pool is not None else None


def meta_load_token(chrom: str) -> tuple:
    pool = pool_for_chrom(chrom)
    return ("meta_locus", pool.pool_id if pool else str(chrom), pool.view_generation if pool else -1)


def _hide_uncalled(body: Optional[dict] = None) -> bool:
    """The uncalled rule for this request: an explicit ``hide_uncalled`` in the body, else the request's
    (services/signal_evidence; every client request carries it), default hide."""
    from services.signal_evidence import parse_hide_uncalled, request_hide_uncalled
    if body and body.get("hide_uncalled") is not None:
        parsed = parse_hide_uncalled(body.get("hide_uncalled"))
        if parsed is not None:
            return bool(parsed)
    return request_hide_uncalled()


def view_cursor(pool: PoolState, hide: Optional[bool] = None) -> dict:
    """Each dataset's share of the view's count (balanced), in its sampling order under the uncalled rule."""
    hide = _hide_uncalled() if hide is None else hide
    sizes = {d: range(ix.n_entries(hide)) for d in pool.order if (ix := pool.index_for(d)) is not None}
    return {d: b for d, (_a, b) in mp.take_balanced(sizes, pool.order, pool.view_seed, {}, pool.view_count).items()}


def view_entries(pool: PoolState, dataset_id: str, hide: Optional[bool] = None) -> list:
    """The view's entries of a dataset: its share of the count in the sampling order (uncalled reads left out under
    the rule), then the refilled / found ones."""
    ix = pool.index_for(dataset_id)
    if ix is None:
        return []
    hide = _hide_uncalled() if hide is None else hide
    n = view_cursor(pool, hide).get(dataset_id, 0)
    ents = [int(e) for e in ix.ranked(pool.view_seed, hide)[:n]]
    seen = set(ents)
    for d, e in pool.view_extra:
        if d == dataset_id and e not in seen:
            ents.append(e)
            seen.add(e)
    return ents


def view_payload(pool: PoolState) -> dict:
    indexes = {d: ix for d in pool.order if (ix := pool.index_for(d)) is not None}
    extra = []
    for d, e in pool.view_extra:
        ix = indexes.get(d)
        if ix is not None:
            extra.append([d, ix.names[int(ix.mol[e])], int(ix.site[e])])
    hide = _hide_uncalled()
    pool_obs = {d: ix.n_entries(hide) for d, ix in indexes.items()}
    return {"chrom": pool.chrom, "width": 2 * pool.sites.flank, "axis_offset": -pool.sites.flank, "seed": pool.view_seed,
            "count": pool.view_count, "cursor": view_cursor(pool, hide), "pool_observations": pool_obs, "hide_uncalled": hide,
            "pool_total": sum(pool_obs.values()), "extra_entries": extra, "extra_count": len(extra),
            "enriched": bool(extra), "generation": pool.view_generation, "label": pool.label,
            "provisional": pool.status != "ready"}


def _resolve_extra(pool: PoolState, extra_entries) -> list:
    """[[dataset, read name, site]] -> [(dataset, entry)] (a saved session's refill / find-more reads)."""
    out = []
    for item in extra_entries or []:
        try:
            d, name, site = str(item[0]), str(item[1]), int(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        ix = pool.index_for(d)
        if ix is None:
            continue
        lookup = getattr(ix, "_entry_lookup", None)
        if lookup is None:
            lookup = {(ix.names[int(m)], int(si)): i for i, (m, si) in enumerate(zip(ix.mol.tolist(), ix.site.tolist()))}
            ix._entry_lookup = lookup
        e = lookup.get((name, site))
        if e is not None:
            out.append((d, int(e)))
    return out


def set_view(pool: PoolState, body: dict) -> dict:
    """seed / count / more (add to count) / resample (new seed: the old one + 1, or ``seed``) / clear_extra /
    extra_entries (restore). Returns the view; its generation changes when what it shows changes."""
    before = (pool.view_seed, pool.view_count, tuple(pool.view_extra))
    if body.get("resample"):
        pool.view_seed = int(body["seed"]) if body.get("seed") is not None else pool.view_seed + 1
        pool.view_extra = []
    elif body.get("seed") is not None:
        pool.view_seed = int(body["seed"])
    if body.get("count") is not None:
        pool.view_count = int(body["count"])
    if body.get("more"):
        pool.view_count += int(body["more"])
    pool.view_count = max(0, min(int(body.get("max_count") or 200_000), pool.view_count))
    if body.get("clear_extra"):
        pool.view_extra = []
    if body.get("extra_entries") is not None:
        pool.view_extra = _resolve_extra(pool, body["extra_entries"])
    first = not pool.view_set
    pool.view_set = True
    if first or (pool.view_seed, pool.view_count, tuple(pool.view_extra)) != before:
        pool.view_generation = next(_GENERATIONS)
        pool._decoded.clear()
    return view_payload(pool)


def _options_key(options: dict) -> tuple:
    def freeze(v):
        if isinstance(v, (list, tuple)):
            return tuple(freeze(x) for x in v)
        if isinstance(v, dict):
            return tuple(sorted((k, freeze(x)) for k, x in v.items()))
        return v
    return freeze(options)


def _decode_view(pool: PoolState, dataset_id: str, loader_options: dict) -> list:
    """The view's reads of a dataset on the whole virtual contig [0, 2*flank), decoded with these options (cached per
    view generation and options). Reads the read filters remove (terminal gaps, duplicates, quality, uncalled) are
    replaced from the next ranks of the sampling order, so the view shows its count when the pool allows; uncalled
    reads are not even decoded under the rule (they are not in the order)."""
    from services.meta_locus_decode import decode_entries_parallel
    from services.signal_evidence import signal_filter_key
    hide = bool(loader_options.get("hide_uncalled", _hide_uncalled()))
    # The request's signal filters decide which reads decode (the loader drops the ones they hide): part of the key.
    key = (pool.view_generation, dataset_id, hide, signal_filter_key(), _options_key(loader_options))
    hit = pool._decoded.get(key)
    if hit is not None:
        return hit
    ix = pool.index_for(dataset_id)
    rows = []
    if ix is not None:
        target = view_cursor(pool, hide).get(dataset_id, 0)
        ranked = ix.ranked(pool.view_seed, hide)
        keys = ix.keys(pool.view_seed)
        extra = [e for d, e in pool.view_extra if d == dataset_id]
        extra_set = set(extra)
        accepted: list = []
        pos = 0
        rounds = 0
        need = target
        while need > 0 and pos < len(ranked) and rounds <= WORKING_DEFAULTS["max_topup_rounds"]:
            rounds += 1
            take = need if rounds == 1 else need + int(np.ceil(need * WORKING_DEFAULTS["overshoot"])) + 4
            ents = [int(e) for e in ranked[pos:pos + take] if int(e) not in extra_set]
            pos += take
            decoded = decode_entries_parallel(pool.paths[dataset_id], ix, pool.sites, ents, loader_options=loader_options,
                                              chrom_map=pool.chrom_map)
            for e in ents:
                if need <= 0:
                    break
                row = decoded.get(e)
                if row is not None:
                    accepted.append((e, row))
                    need -= 1
        if extra:
            decoded = decode_entries_parallel(pool.paths[dataset_id], ix, pool.sites, extra, loader_options=loader_options,
                                              chrom_map=pool.chrom_map)
            accepted.extend((e, decoded[e]) for e in extra if e in decoded)
        for rank, (e, row) in enumerate(accepted):
            rows.append(_with_meta(pool, ix, dataset_id, e, row, keys, rank, added=e in extra_set))
    while len(pool._decoded) >= DECODED_CACHE:
        pool._decoded.pop(next(iter(pool._decoded)))
    pool._decoded[key] = rows
    return rows


def _with_meta(pool, ix, dataset_id, e, row, keys, rank, added=False):
    from services.meta_locus_decode import virtualize_read
    s = int(ix.site[e])
    m = int(ix.mol[e])
    shared = bool(ix.shared[e])
    row["meta"] = {"dataset": dataset_id, "rank": rank, "key": format(int(keys[m]), "016x"), "read_start": int(ix.start[m]),
                   "read_end": int(ix.end[m]), "shared": shared, "added": bool(added), **pool.sites.provenance(s),
                   "identity": {"dataset": dataset_id, "name": ix.names[m], "site": s}}
    if shared:
        row["source_id"] = row.get("id")
        row["id"] = f"{row.get('id')}#site{s}"
    return virtualize_read(row, pool.sites, s)


def meta_broad_reads(dataset_id: str, chrom: str, start: int, end: int, loader_options: dict) -> list:
    """services/working_sets' loader for the virtual contig: the view's reads of ``dataset_id`` over [start, end),
    relative to ``start`` like any broad load."""
    from services.meta_locus_decode import clip_compact_read
    pool = pool_for_chrom(chrom)
    if pool is None or dataset_id not in pool.order:
        return []
    if not pool.view_set and pool.status != "ready":
        return []  # still building and no provisional view asked for: an empty contig (the panels say "building")
    opts = {k: v for k, v in loader_options.items() if k not in ("spanning_only",)}
    rows = _decode_view(pool, dataset_id, opts)
    out = []
    width = int(end) - int(start)
    for row in rows:
        clipped = clip_compact_read(row, -int(start), width) if start or end < 2 * pool.sites.flank else dict(row)
        if clipped is not None:
            clipped["meta"] = row["meta"]
            out.append(clipped)
    return out


def meta_coverage(state, chrom: str, start: int, end: int, bins: int, dataset_id=None, include_duplicates=False) -> dict:
    """/api/coverage on a meta-locus contig: read depth of the view (aligned blocks on the virtual contig), binned."""
    pool = pool_for_chrom(chrom)
    bins = max(1, int(bins))
    cov = np.zeros(bins, np.int64)
    if pool is None or end <= start:
        return {"coverage": cov.tolist(), "max": 0}
    ids = [dataset_id] if dataset_id else list(pool.order)
    opts = dict(include_methylation=False, include_layers=False, include_layer_qualities=False,
                include_duplicates=bool(include_duplicates))
    width = end - start
    edges = start + (np.arange(bins + 1) * width) // bins
    for d in ids:
        if d not in pool.order:
            continue
        for row in _decode_view(pool, d, opts):
            for a, b in row.get("aligned_blocks") or []:
                lo, hi = max(int(a), start), min(int(b), end)
                if hi <= lo:
                    continue
                i0 = int(np.searchsorted(edges, lo, side="right")) - 1
                i1 = int(np.searchsorted(edges, hi - 1, side="right")) - 1
                cov[max(0, i0):min(bins, i1 + 1)] += 1
    return {"coverage": cov.tolist(), "max": int(cov.max()) if bins else 0}


def meta_reads_dataframe(chrom: str, start: int, end: int, spanning: bool, dataset_id):
    """Dataset.get_reads' table for a meta-locus contig: one row per view read, a column per base of [start, end)
    holding the footprint size there (positive), the gap size (negative) inside the read, 0 outside it; read_id."""
    import pandas as pd
    pool = pool_for_chrom(chrom)
    if pool is None or dataset_id not in pool.order or end <= start:
        return pd.DataFrame()
    rows = _decode_view(pool, dataset_id, dict(include_methylation=False, include_layers=False, include_layer_qualities=False))
    width = end - start
    data, ids = [], []
    for row in rows:
        ivs = row.get("intervals") or []
        if not ivs:
            continue
        lo, hi = min(int(iv[0]) for iv in ivs), max(int(iv[1]) for iv in ivs)
        if spanning and (lo > start or hi < end):
            continue
        if hi <= start or lo >= end:
            continue
        line = np.zeros(width, np.float32)
        for iv in ivs:
            a, b = max(int(iv[0]), start) - start, min(int(iv[1]), end) - start
            if b > a:
                size = iv[2] if len(iv) > 2 and iv[2] is not None else 0
                line[a:b] = size if size != 0 else -1
        data.append(line)
        ids.append(str(row.get("id")))
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(np.vstack(data), columns=list(range(start, end)))
    df.insert(0, "read_id", ids)
    return df
