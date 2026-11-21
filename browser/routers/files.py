"""Gene search, file picker, BAM diagnostics, folder loading endpoints.

Extracted from server.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Query, Depends, Request

from state.dependencies import get_state
from services.file_picker import pick_file_payload, pick_folder_payload
from services.files_endpoint import (
    diagnose_bam_payload,
    load_folder_for_request,
    search_gene_payload,
)

router = APIRouter(tags=["files"])


@router.get("/api/gene_search")
async def search_gene(query: str = Query(...), chrom: str = Query(None),
    state=Depends(get_state)):
    return search_gene_payload(state, query, chrom)


# Sync handlers: a native dialog blocks for as long as it is open, which must
# not freeze the event loop (and every other request) meanwhile.
@router.get("/api/pick_folder")
def pick_folder(prompt: str = Query("Select Fiber-seq BigBed Folder")):
    """Open native file picker dialog to select a folder"""
    return pick_folder_payload(prompt)


@router.get("/api/pick_file")
def pick_file(file_type: str = Query("gtf"), overlay_type: str = Query(None), multiple: bool = Query(False)):
    """Open native file picker dialog to select a file (or multiple files if multiple=True)"""
    return pick_file_payload(file_type, overlay_type, multiple)


@router.get("/api/files/list")
def list_server_directory(path: str = Query(None, description="Directory to list; default: home")):
    """List a server directory for the in-page file browser.

    Used when the browser is not on the server's machine (so a native dialog
    would open on the wrong screen) or no native dialog is available.
    """
    from services.file_picker import list_directory_payload

    return list_directory_payload(path)


@router.get("/api/diagnose_bam")
async def diagnose_bam_endpoint(
    bam_path: str = Query(None, description="Path to BAM file to diagnose"),
    dataset_idx: int = Query(0, description="Dataset index to diagnose (if bam_path not provided)"),
    chrom: str = Query(None, description="Chromosome to sample reads from"),
    limit: int = Query(10, description="Number of reads to check"),
    state=Depends(get_state)):
    """
    Diagnose a BAM file to check what Fiber-seq tags are present.
    
    This helps debug loading issues by showing:
    - What tags are present in the BAM file
    - Whether required Fiber-seq tags (ns/nl, as/al, MM/ML) exist
    - Example values for each tag
    """
    return diagnose_bam_payload(
        state,
        bam_path=bam_path,
        dataset_idx=dataset_idx,
        chrom=chrom,
        limit=limit,
    )


@router.post("/api/load_folder")
async def load_folder(path: str = Query(...),
    state=Depends(get_state)):
    """Load a BigBed folder as a new dataset"""
    try:
        import asyncio
        # In a worker: registering the dataset waits for the state lock (services/genome_loading).
        return await asyncio.to_thread(load_folder_for_request, state, path)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "message": str(e)}


# Plots: BED region sets read by path (several BEDs as groups; no native dialog). Not on a --public server (the
# public-mode guard's allowlist leaves it out).
BED_REGION_CAP = 200_000


def _bed_number(v: str):
    try:
        x = float(v)
    except ValueError:
        return None
    return x if x == x and x not in (float("inf"), float("-inf")) else None


def parse_bed_regions(text: str, cap: int = BED_REGION_CAP) -> dict:
    """BED text as regions [chrom, start, end, strand, name]; header, comment and malformed lines skipped.

    ``columns``: per region, BED columns 5 on as numbers (None: not a number), for sorting by score or another column.
    """
    regions: list[list] = []
    columns: list[list] = []
    skipped = 0
    total = 0
    for line in text.splitlines():
        if not line.strip() or line.startswith(("#", "track", "browser")):
            continue
        cols = line.rstrip("\n").split("\t")
        if len(cols) < 3:
            cols = line.split()
        try:
            chrom, start, end = cols[0], int(cols[1]), int(cols[2])
        except (ValueError, IndexError):
            skipped += 1
            continue
        if end <= start or start < 0:
            skipped += 1
            continue
        total += 1
        if len(regions) >= cap:
            continue
        name = cols[3] if len(cols) > 3 and cols[3] not in (".", "") else ""
        strand = cols[5] if len(cols) > 5 and cols[5] in ("+", "-") else "."
        regions.append([chrom, start, end, strand, name])
        columns.append([_bed_number(c) for c in cols[4:30]])
    return {"regions": regions, "columns": columns, "total": total, "skipped": skipped, "capped": total > len(regions)}


def read_bed_text(path: str) -> tuple[str, str]:
    """(text, path as named) of a server-side BED file (gzip allowed).

    On a lab server, in a member's or visitor's request, the path is normalised exactly as the request guard
    normalised it (``lab_paths.check``: stripped, decoded, links resolved) and opened by the confined descriptor
    walk, so the file read is the file the guard allowed (a ``sample.bed `` link with a trailing space no longer
    reaches outside the roots). Elsewhere: the path as given, opened as before.
    """
    import gzip
    import io
    import os
    from services.lab import paths as lab_paths

    shown = full = os.path.expanduser(str(path))
    if lab_paths.enforcing():
        shown = shown.strip()
        full = lab_paths.check(shown)
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail=f"No BED file at {path}")
    if os.path.getsize(full) > 512 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="BED file too large (over 512 MB)")
    try:
        with lab_paths.open_read(full) as raw:
            if shown.endswith(".gz"):
                with gzip.open(raw, "rt", encoding="utf-8", errors="replace") as fh:
                    return fh.read(), shown
            return io.TextIOWrapper(raw, encoding="utf-8", errors="replace").read(), shown
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Could not read {path}: {exc}") from exc


@router.post("/api/plots/bed_regions")
def bed_regions(path: str = Body(..., embed=True)):
    """Read a BED file on the server for a Plots region set (gzip allowed)."""
    import os

    text, full = read_bed_text(path)
    out = parse_bed_regions(text)
    out["name"] = os.path.basename(full).removesuffix(".gz").removesuffix(".bed")
    out["path"] = path
    return out


@router.post("/api/plots/region_reads")
async def plots_region_reads(request: Request, body: dict = Body(...), state=Depends(get_state)):
    """Reads of many regions (Plots BED region sets): subsampled and capped here, engine-ready per region and dataset.

    Body: sets [{id, regions: [[chrom, start, end, strand, name]...]}], dataset_ids, source, anchor (centre | start |
    end), mode (point | scale), flank_bp, scale_flank_bp, subsample (all | random | equal), n, seed, max_regions,
    reads_per_region, occluders (bool), sample_seed, job_offset / job_limit (a chunk of the chosen regions). Answer: regions [{set, index, offset, reads: {dataset: [[start, end,
    [source a, b, ...], [marks], [nucleosome a, b, ...]], ...]}}] (relative to offset, the window start; nucleosomes that are the first k source numbers come as the number k) and per-set counts. A client that goes away stops it.
    """
    from starlette.concurrency import run_in_threadpool
    from services.analysis_query import AnalysisReadQuery
    from bisect import bisect_left
    from services.plots_regions import clip_flat, clip_read, cut_by_fetch, engine_read, footprint_intervals, region_blocks, relative_flat, relative_row, region_window, sample_reads, source_layers, subsample_regions, whole_in_window

    sets = [s for s in (body.get("sets") or []) if isinstance(s, dict)]
    source = str(body.get("source") or "all_footprints")
    anchor, mode = str(body.get("anchor") or "centre"), str(body.get("mode") or "point")
    flank, scale_flank = int(body.get("flank_bp") or 1000), int(body.get("scale_flank_bp") or 0)
    per_region = max(1, min(5000, int(body.get("reads_per_region") or 50)))
    occluders = bool(body.get("occluders"))
    # Every footprint (Nuc + TF) of each read as a last row element: the state at the anchor (conditioning).
    with_footprints = bool(body.get("footprints"))
    # Size histograms: the source footprints overlapping each window whole (not clipped), with their sizes, as two
    # more row elements (the footprints or None, then the sizes). Blocks are read footprint_pad_bp wider, so a
    # footprint shorter than that is not cut by the working set's span either.
    whole = bool(body.get("whole_footprints"))
    pad = max(0, min(50_000, int(body.get("footprint_pad_bp") or 0))) if whole else 0
    # The plot's sampling seed (every sampler here follows services/stable_sample).
    plot_seed = int(body.get("seed") if body.get("seed") is not None else 1)
    chosen = subsample_regions(sets, str(body.get("subsample") or "random"), int(body.get("n") or 200),
                               plot_seed, int(body.get("max_regions") or 2000))
    jobs = [(si, ri) for si, idx in enumerate(chosen) for ri in idx]
    # A client reads a large set in chunks (job_offset, job_limit over the chosen regions, in set and BED order) to
    # show progress and cancel between them; the subsample is the same in every chunk (seeded).
    jobs_total = len(jobs)
    j0 = max(0, int(body.get("job_offset") or 0))
    jl = body.get("job_limit")
    jobs = jobs[j0:j0 + max(0, int(jl))] if jl is not None else jobs[j0:]
    if not jobs:
        return {"success": True, "regions": [], "jobs_total": jobs_total,
                "sets": [{"id": s.get("id"), "total": len(s.get("regions") or []), "read": len(chosen[i])} for i, s in enumerate(sets)]}
    first = sets[jobs[0][0]]["regions"][jobs[0][1]]
    layers = sorted(set(source_layers(source) + (["nuc"] if occluders else []) + (["nuc", "tf"] if with_footprints else [])))
    query = AnalysisReadQuery.from_request(
        state, chrom=str(first[0]), start=int(first[1]), end=int(first[2]), dataset_ids=body.get("dataset_ids") or None,
        sample_seed=body.get("sample_seed"), include_methylation=source == "m6a", include_layers=bool(layers),
        requested_layers=layers or None, include_layer_qualities=False,
    )
    seed = query.sample_seed

    windows = [region_window(sets[si]["regions"][ri], anchor, mode, flank, scale_flank) for si, ri in jobs]
    blocks = region_blocks(windows)

    def read_block(block):
        # Read each dataset once over the block and convert its reads once (sorted by start).
        chrom, bstart, bend, _members = block
        per_ds = {}
        fetched = {}
        for ds in query.dataset_ids:
            ws = query.build_working_set(state, ds, chrom=chrom, start=max(0, bstart - pad), end=bend + pad)
            # (Where the loader clipped: the working set's own span when it says, within the asked one.)
            fetched[ds] = (max(max(0, bstart - pad), int(getattr(ws, "start", 0) or 0)),
                           min(bend + pad, int(getattr(ws, "end", None) or bend + pad)))
            rows = []
            for r in ws.reads:
                sizes = [] if whole else None
                row = engine_read(r, ws.start, source, occluders, sizes)
                if row:
                    fps = [footprint_intervals(r, ws.start)] if with_footprints else ([None] if whole else [])
                    rows.append(row + [str(r.get("id"))] + fps + ([sizes] if whole else []))
            kept = sorted(rows, key=lambda row: (row[0], row[5]))
            per_ds[ds] = (kept, [row[0] for row in kept], fetched[ds])
        return per_ds

    def answer_windows(per_ds, members):
        # Each window's overlapping reads, a stable seeded sample per region, clipped to the window.
        out = []
        for j in members:
            si, ri = jobs[j]
            _, ws_, we_ = windows[j]
            by_ds = {}
            for ds, (rows, starts, (lo, hi)) in per_ds.items():
                hits = [row for row in rows[:bisect_left(starts, we_)] if row[1] > ws_]
                hits = sample_reads(hits, per_region, plot_seed, ds)
                # Coordinates relative to the window's start (shorter answers); "offset" puts them back; the read name last.
                rows_out = []
                for h in hits:
                    c = clip_read(h, ws_, we_)
                    if not c:
                        continue
                    fps = [relative_flat(clip_flat(h[6], ws_, we_), ws_)] if with_footprints else ([None] if whole else [])
                    if whole:
                        src, sizes = whole_in_window(h[2], h[7], ws_, we_)
                        # Footprints the fetch may have cut (reaching its edges) last, by index: their bounds are not whole.
                        cut = cut_by_fetch(src, lo, hi)
                        rows_out.append(relative_row([c[0], c[1], src, c[3], c[4]], ws_) + [h[5]] + fps + [sizes] + ([cut] if cut else []))
                    else:
                        rows_out.append(relative_row(c, ws_) + [h[5]] + fps)
                by_ds[ds] = rows_out
            out.append((j, {"set": sets[si].get("id"), "index": ri, "offset": ws_, "reads": by_ds}))
        return out

    # A client that goes away stops the work between blocks and between chunks of windows inside a block.
    chunk = max(1, int(body.get("chunk_windows") or 200))
    answered = []

    def cancelled():
        return {"success": False, "cancelled": True, "jobs_total": jobs_total, "regions": [r for _, r in sorted(answered, key=lambda x: x[0])]}

    for block in blocks:
        if await request.is_disconnected():
            return cancelled()
        per_ds = await run_in_threadpool(read_block, block)
        members = block[3]
        for k in range(0, len(members), chunk):
            if k and await request.is_disconnected():
                return cancelled()
            answered.extend(await run_in_threadpool(answer_windows, per_ds, members[k:k + chunk]))
    results = [r for _, r in sorted(answered, key=lambda x: x[0])]
    counts = [{"id": s.get("id"), "total": len(s.get("regions") or []), "read": len(chosen[i])} for i, s in enumerate(sets)]
    return {"success": True, "regions": results, "sets": counts, "sample_seed": seed, "seed": plot_seed, "jobs_total": jobs_total}


@router.post("/api/plots/differential")
async def plots_differential(request: Request, body: dict = Body(...), state=Depends(get_state)):
    """Differential features (services/differential_run.py): a per-read test per feature between groups A and B,
    Fisher / chi-squared or CMH over density bins and replicates, effect sizes with 95% intervals, BH q. A client that
    goes away stops it between batches of features."""
    import asyncio
    import threading
    from starlette.concurrency import run_in_threadpool
    from services.differential_run import Cancelled, run_differential

    gone = threading.Event()

    async def watch():
        while not gone.is_set():
            if await request.is_disconnected():
                gone.set()
                return
            await asyncio.sleep(0.25)

    watcher = asyncio.create_task(watch())
    try:
        return await run_in_threadpool(run_differential, state, body, gone.is_set)
    except Cancelled:
        return {"success": False, "cancelled": True, "rows": []}
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        gone.set()
        watcher.cancel()


_RANDOM_PLANS: dict = {}


@router.post("/api/plots/random_reads")
async def plots_random_reads(request: Request, body: dict = Body(...), state=Depends(get_state)):
    """N random reads of each dataset's whole BAM (services/plots_random_reads; seeded, stable), in chunks.

    phase "scan": job_offset / job_limit over the (dataset, contig, segment) jobs -> candidates per job (name, key as a
    decimal string, start) with the contig's share; jobs_total. phase "reads": groups [{dataset, contig, names, starts}]
    -> engine rows per group (absolute; the read name last). Stops between jobs when the client goes away."""
    from starlette.concurrency import run_in_threadpool
    from services.analysis_query import AnalysisReadQuery
    from services.plots_random_reads import plan, read_rows, scan_segment
    from services.signal_evidence import request_hide_uncalled

    datasets = [str(d) for d in (body.get("dataset_ids") or [])] or list(getattr(state, "datasets", {}) or {})
    n = max(1, min(1_000_000, int(body.get("n") or 10_000)))
    seed = int(body.get("seed") if body.get("seed") is not None else 1)
    include_qcfail = bool(body.get("include_qcfail"))
    paths = {}
    for ds in datasets:
        d = (getattr(state, "datasets", None) or {}).get(ds)
        if d is None or getattr(d, "data_type", "bam") not in ("bam", None) or not getattr(d, "paths", None):
            raise HTTPException(status_code=422, detail=f"Random reads need a native BAM dataset ({ds})")
        paths[ds] = list(d.paths)
    phase = str(body.get("phase") or "scan")
    if phase == "scan":
        key = (tuple(sorted((ds, tuple(p)) for ds, p in paths.items())), n)
        jobs = _RANDOM_PLANS.get(key)
        if jobs is None:
            jobs = await run_in_threadpool(plan, paths, n)
            _RANDOM_PLANS[key] = jobs
        j0 = max(0, int(body.get("job_offset") or 0))
        jl = max(1, int(body.get("job_limit") or 4))
        out = []
        for job in jobs[j0:j0 + jl]:
            if await request.is_disconnected():
                return {"success": False, "cancelled": True, "jobs_total": len(jobs), "seed": seed}
            cands = await run_in_threadpool(scan_segment, paths[job["dataset"]], job["dataset"], job["contig"], job["start"], job["end"], job["frac"], seed, include_qcfail,
                                            request_hide_uncalled())
            out.append(dict(dataset=job["dataset"], contig=job["contig"], share=job["share"], mapped=job["mapped"],
                            candidates=[[name, str(k), start] for name, k, start in cands]))
        return {"success": True, "jobs_total": len(jobs), "jobs": out, "seed": seed, "n": n}
    if phase == "reads":
        source = str(body.get("source") or "all_footprints")
        occluders = bool(body.get("occluders"))
        from services.plots_regions import source_layers
        layers = sorted(set(source_layers(source) + (["nuc"] if occluders else [])))
        groups = [g for g in (body.get("groups") or []) if isinstance(g, dict) and g.get("names")]
        if not groups:
            return {"success": True, "groups": [], "seed": seed}
        first = groups[0]
        query = AnalysisReadQuery.from_request(
            state, chrom=str(first["contig"]), start=0, end=1, dataset_ids=datasets or None, sample_seed=body.get("sample_seed"),
            include_methylation=source == "m6a", include_layers=bool(layers), requested_layers=layers or None, include_layer_qualities=False)
        out = []
        for g in groups:
            if await request.is_disconnected():
                return {"success": False, "cancelled": True, "groups": out, "seed": seed}
            rows = await run_in_threadpool(read_rows, state, query, str(g["dataset"]), str(g["contig"]), [str(x) for x in g["names"]],
                                           [int(x) for x in (g.get("starts") or [0])], source, occluders)
            out.append(dict(dataset=g["dataset"], contig=g["contig"], reads=rows))
        return {"success": True, "groups": out, "seed": seed}
    raise HTTPException(status_code=422, detail="phase must be scan or reads")


@router.post("/api/plots/bed_sizes")
async def plots_bed_sizes(request: Request, body: dict = Body(...), state=Depends(get_state)):
    """Size enrichment / V-plot pooled over BED anchors (services/plots_bed_sizes), in chunks of regions.

    Body as region_reads (sets, anchor, flank_bp, subsample, n, seed, max_regions, reads_per_region, job_offset /
    job_limit) plus layer, size_min, size_max, size_bin, pos_bin, mode, occlusion (off | centre), pooled, and for the
    plot's Random N reads key_max {dataset: decimal key} (from phase "names"). Phases: "names" (the read names and
    keys the counting would use), "count" (raw counts per set|dataset; the client adds the chunks), "finish" (the
    pooled raw counts finished: normalization, sigma_size_bp, sigma_pos_bp, row_min_footprints), "bootstrap" (the box
    mean's interval per group, every region at once: box {size_from, size_to, pos_from, pos_to}, resamples,
    boot_seed, unit regions | reads, and the finish parameters; services/box_bootstrap)."""
    from starlette.concurrency import run_in_threadpool
    from services.analysis_query import AnalysisReadQuery
    from services.plots_bed_sizes import count_windows, finish
    from services.plots_regions import region_blocks, region_window, subsample_regions

    phase = str(body.get("phase") or "count")
    size_min, size_max = int(body.get("size_min") or 10), int(body.get("size_max") or 300)
    size_bin, pos_bin = max(1, int(body.get("size_bin") or 10)), max(1, int(body.get("pos_bin") or 10))
    if phase == "finish":
        groups = [g for g in (body.get("groups") or []) if isinstance(g, dict) and g.get("matrix") is not None]
        return {"success": True, "groups": await run_in_threadpool(finish, groups, normalization=str(body.get("normalization") or "row"),
                                                                   sigma_size_bp=float(body.get("sigma_size_bp") or 0), sigma_pos_bp=float(body.get("sigma_pos_bp") or 0),
                                                                   size_bin=size_bin, pos_bin=pos_bin, row_min_footprints=int(body.get("row_min_footprints") or 0))}
    sets = [s for s in (body.get("sets") or []) if isinstance(s, dict)]
    flank = max(1, int(body.get("flank_bp") or 1000))
    plot_seed = int(body.get("seed") if body.get("seed") is not None else 1)
    chosen = subsample_regions(sets, str(body.get("subsample") or "random"), int(body.get("n") or 200), plot_seed, int(body.get("max_regions") or 2000))
    jobs_all = [(si, ri) for si, idx in enumerate(chosen) for ri in idx]
    j0 = max(0, int(body.get("job_offset") or 0))
    jl = body.get("job_limit")
    jobs = jobs_all[j0:j0 + max(0, int(jl))] if jl is not None else jobs_all[j0:]
    counts = [{"id": s.get("id"), "total": len(s.get("regions") or []), "read": len(chosen[i])} for i, s in enumerate(sets)]
    if not jobs:
        return {"success": True, "jobs_total": len(jobs_all), "groups": {}, "names": {}, "sets": counts, "seed": plot_seed}
    layer = body.get("layer") or None
    occlusion = str(body.get("occlusion") or "off")
    first = sets[jobs[0][0]]["regions"][jobs[0][1]]
    layers = None if not layer else (["nuc", "tf"] if layer == "all_footprints" else [layer])
    if occlusion == "centre":
        layers = sorted(set((layers or []) + ["nuc"]))
    query = AnalysisReadQuery.from_request(state, chrom=str(first[0]), start=int(first[1]), end=int(first[2]), dataset_ids=body.get("dataset_ids") or None,
                                           sample_seed=body.get("sample_seed"), include_methylation=False, include_layers=bool(layers),
                                           requested_layers=layers, include_layer_qualities=False)
    windows = [region_window(sets[si]["regions"][ri], str(body.get("anchor") or "centre"), "point", flank, 0) for si, ri in jobs]
    n_size, n_pos = (size_max - size_min) // size_bin, (2 * flank) // pos_bin
    if n_size <= 0 or n_pos <= 0:
        raise HTTPException(status_code=422, detail="Invalid bin parameters")
    key_max = {str(k): int(v) for k, v in (body.get("key_max") or {}).items()}
    kw = dict(dataset_ids=query.dataset_ids, layer=layer, size_min=size_min, size_bin=size_bin, n_size=n_size, pos_bin=pos_bin, n_pos=n_pos,
              mode=str(body.get("mode") or "midpoint"), per_region=int(body.get("reads_per_region") or 50), seed=plot_seed, key_max=key_max,
              occlusion=occlusion, pooled=bool(body.get("pooled")))
    merged: dict = {}
    names: dict = {}
    units: "dict | None" = {} if phase == "bootstrap" else None
    unit_kind = "reads" if str(body.get("unit") or "regions") == "reads" else "regions"
    for block in region_blocks(windows):
        if await request.is_disconnected():
            return {"success": False, "cancelled": True, "jobs_total": len(jobs_all), "seed": plot_seed}
        part = await run_in_threadpool(lambda b=block: count_windows(state, query, jobs, windows, b[3], sets, block=b, names_only=phase == "names",
                                                                     units=units, unit_kind=unit_kind, **kw))
        if phase == "names":
            for ds, rows in part.items():
                names.setdefault(ds, {}).update({n: k for n, k in rows})
            continue
        import numpy as _np
        for k, g in part.items():
            if k not in merged:
                merged[k] = g
            else:
                m = merged[k]
                m["matrix"] = (_np.asarray(m["matrix"]) + _np.asarray(g["matrix"])).round(6).tolist()
                m["row"] = (_np.asarray(m["row"]) + _np.asarray(g["row"])).tolist()
                m["col"] = (_np.asarray(m["col"]) + _np.asarray(g["col"])).tolist()
                m["n_reads"] += g["n_reads"]
    if phase == "names":
        return {"success": True, "jobs_total": len(jobs_all), "names": {ds: [[n, k] for n, k in d.items()] for ds, d in names.items()}, "sets": counts, "seed": plot_seed}
    if phase == "bootstrap":
        from services.box_bootstrap import box_bootstrap, box_indices
        from services.vplot_matrix import VPLOT_NORMALIZATIONS, sigma_bins
        bx = body.get("box") or {}
        box = box_indices(size_min, size_bin, n_size, -flank, pos_bin, n_pos, float(bx.get("size_from") or 0), float(bx.get("size_to") or 1e9),
                          None if bx.get("pos_from") is None else float(bx["pos_from"]), None if bx.get("pos_to") is None else float(bx["pos_to"]))
        norm = str(body.get("normalization") or "row")
        finish_kw = dict(normalization=norm if norm in VPLOT_NORMALIZATIONS else "row", log=False,
                         sigma_bins_size=sigma_bins(float(body.get("sigma_size_bp") or 0), size_bin), sigma_bins_pos=sigma_bins(float(body.get("sigma_pos_bp") or 0), pos_bin),
                         row_min_footprints=int(body.get("row_min_footprints") or 0))
        resamples = max(50, min(10000, int(body.get("resamples") or 1000)))
        boot_seed = int(body.get("boot_seed") if body.get("boot_seed") is not None else plot_seed)
        out = {}
        for k, uc in (units or {}).items():
            lo, hi, n = await run_in_threadpool(box_bootstrap, uc, seed=boot_seed, resamples=resamples, finish_kw=finish_kw, box=box,
                                                transform=str(bx.get("transform") or "none"))
            out[k] = {"lo": lo, "hi": hi, "units": n}
        return {"success": True, "jobs_total": len(jobs_all), "intervals": out, "unit": unit_kind, "resamples": resamples, "boot_seed": boot_seed, "seed": plot_seed}
    return {"success": True, "jobs_total": len(jobs_all), "groups": merged, "sets": counts, "seed": plot_seed,
            "size_min": size_min, "size_max": size_max, "size_bin": size_bin, "pos_bin": pos_bin, "start": -flank}
