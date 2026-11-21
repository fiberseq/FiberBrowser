"""Find classes on a meta-locus: fiberhmm-consensus's pooled oriented-BED mode (CL-CR) over the working set.

FiberHMM already pools oriented BED6 windows of equal width into one analysis (``fiberhmm-consensus --bed ...
--pool-loci``; ``fiberhmm.inference.consensus.regions.pool_payloads``): each window's evidence is put in the
window's own orientation (local 0 = BED start on +, BED end on -, base i mirrored to end-1-i) and every unit keeps
its genomic window (``genomic_provenance``). A meta-locus's windows are exactly that frame: ``[a - f, a + f)`` on
plus-strand sites, ``[a - f + 1, a + f + 1)`` on minus-strand sites, so the pooled frame [0, 2f) is the virtual
contig itself.

Here a run on ``meta:<pool>``: one window per site of the view (``max_sites`` at most, in site order), the window's
payload loaded with the ordinary loader and kept to the view's reads at that site, the payloads pooled with
``pool_payloads`` and run as any job (``consensus_workflow.submit`` with a payload loader). The result displays on
the virtual contig (``meta_index``: the run's records in the pooled frame, matched to the view's rows by read name
and site) and, through the existing projection, at every real site.

FiberHMM's pooled mode keeps **one locus view per physical molecule** (``ownership``: a read in several windows is
analysed at one of them, the others are listed as ``excluded_repeated_views``). The meta-locus counts each
(read, site) pair as an observation; a per-pair option in ``pool_payloads`` is what FiberHMM would need for that.
Until then a shared read's other rows carry no class records (they are "not in the run").
"""
from __future__ import annotations

from copy import deepcopy

CONSENSUS_DEFAULTS = {"max_sites": 300}


def _windows(pool, entries_by_ds: dict, max_sites: int) -> list:
    sites = sorted({int(pool.index_for(d).site[e]) for d, ents in entries_by_ds.items() for e in ents})
    if len(sites) > max_sites:
        sites = sites[:max_sites]
    out = []
    for s in sites:
        out.append(dict(chrom=pool.sites.chrom[s], start=int(pool.sites.win_start[s]), end=int(pool.sites.win_end[s]),
                        name=f"s{s}", strand="-" if bool(pool.sites.minus[s]) else "+", site=s))
    return out


def _keep_reads(payload, wanted_by_ds: dict):
    body = deepcopy(dict(payload))
    for source in body.get("strata", []):
        names = wanted_by_ds.get(source.get("dataset_id"), set())
        source["units"] = [u for u in source.get("units", []) if str(u.get("read_name")) in names]
    return body


def make_loader(state, pool, max_sites: int):
    from services import meta_locus_jobs as mj
    entries = {d: mj.view_entries(pool, d) for d in pool.order}
    windows = _windows(pool, entries, max_sites)
    by_site: dict = {}
    for d, ents in entries.items():
        ix = pool.index_for(d)
        for e in ents:
            by_site.setdefault(int(ix.site[e]), {}).setdefault(d, set()).add(ix.names[int(ix.mol[e])])

    def load(state_, request, options, progress):
        from fiberhmm.inference.consensus.regions import pool_payloads
        from services.consensus_workflow import load_payload
        if not windows:
            raise ValueError("The meta-locus view has no reads")
        payloads = []
        for i, w in enumerate(windows):
            if callable(progress):
                try:
                    progress("loading", f"Loading site {i + 1} of {len(windows)}")
                except TypeError:
                    pass
            req = {**request, "chrom": w["chrom"], "start": w["start"], "end": w["end"]}
            req.pop("region_windows", None)
            payload = load_payload(state_, req, options, progress)
            payloads.append(_keep_reads(payload, by_site.get(w["site"], {})))
        rows = [{k: w[k] for k in ("chrom", "start", "end", "name", "strand")} for w in windows]
        return pool_payloads(payloads, rows)

    return load, windows


def submit(state, request: dict) -> dict:
    """POST /api/footprint/consensus/jobs with chrom meta:<pool>: the pooled oriented-BED run of the view."""
    from services import meta_locus_jobs as mj
    from services.consensus_workflow import submit as start
    pool = mj.pool_for_chrom(request.get("chrom"))
    if pool is None or pool.status != "ready":
        raise ValueError("The meta-locus is not open (or still building)")
    max_sites = int((request.get("meta_locus") or {}).get("max_sites") or CONSENSUS_DEFAULTS["max_sites"])
    loader, windows = make_loader(state, pool, max_sites)
    width = 2 * pool.sites.flank
    rows = [{k: w[k] for k in ("chrom", "start", "end", "name", "strand")} for w in windows]
    ids = [d for d in (request.get("dataset_ids") or pool.order) if d in pool.order]
    req = {**request, "dataset_ids": ids, "chrom": "oriented_BED", "start": 0, "end": width, "region_windows": rows,
           "region_source": "meta_locus", "meta_pool": pool.pool_id, "meta_view_generation": pool.view_generation,
           "meta_sites": len(windows)}
    return start(state, req, payload_loader=loader)


def meta_index(job, dataset_id: str, pool):
    """The run's records in the pooled frame (= the virtual contig), matched to the view's rows by read name and
    site: the index apply_overlays uses on meta:<pool>. Cached on the job."""
    cache = job.setdefault("_meta_index", {})
    if dataset_id in cache:
        return cache[dataset_id]
    from services.consensus_workflow import NATIVE_CR_MODE, _cr_mode, _legacy_index, _native_index
    result = job["result"]
    indexes, _layers = (_native_index(result) if _cr_mode(result) == NATIVE_CR_MODE else _legacy_index(result))
    src = indexes.get(dataset_id)
    ds = result["datasets"].get(dataset_id)
    if src is None or ds is None:
        cache[dataset_id] = None
        return None
    ix = pool.index_for(dataset_id)
    lookup = {}
    if ix is not None:
        for e, (m, s) in enumerate(zip(ix.mol.tolist(), ix.site.tolist())):
            lookup[(ix.names[m], s)] = e
    chrom = pool.chrom
    window = dict(chrom=chrom, start=0, end=2 * pool.sites.flank)
    dest = dict(per_unit={}, unit_windows={}, unit_sources={}, by_name={}, projection_members={}, layers=list(src.get("layers", [])))
    for unit in ds["units"]:
        uid = unit["unit_id"]
        w = (unit.get("genomic_provenance") or {}).get("window") or {}
        name = str(unit.get("read_name") or "")
        try:
            site = int(str(w.get("name", ""))[1:])
        except ValueError:
            continue
        e = lookup.get((name, site))
        if e is None:
            continue
        row_id = f"{name}#site{site}" if bool(ix.shared[e]) else name
        dest["per_unit"][uid] = deepcopy(src["per_unit"].get(uid, {}))
        dest["unit_windows"][uid] = window
        dest["unit_sources"][uid] = dataset_id
        dest["by_name"].setdefault(row_id, []).append(uid)
        dest["projection_members"].setdefault(row_id, []).append(dict(unit_id=uid, chrom=chrom, identity={}))
    cache[dataset_id] = dest
    return dest


def job_for_meta(job, chrom) -> bool:
    return bool(job) and str(chrom).startswith("meta:") and job.get("request", {}).get("meta_pool") == str(chrom)[5:]
