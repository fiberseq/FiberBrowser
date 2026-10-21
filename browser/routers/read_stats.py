"""Read stats endpoint for selected-read alignment and footprint statistics."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query

from models.requests import ReadStatsRequest
from services.read_stats import compute_read_stats
from services.analysis_query import AnalysisReadQuery
from state.dependencies import get_state

router = APIRouter(tags=["read_stats"])


@router.post("/api/reads/stats")
async def get_read_stats(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    request: ReadStatsRequest = None,
    state=Depends(get_state),
):
    """Compute per-read alignment and footprint statistics for selected reads."""
    # Loads the working set (BAM reads) and walks every read: it stalled every
    # other request for 5-72 s on deep data when it ran on the event loop.
    return await asyncio.to_thread(_read_stats, chrom=chrom, start=start, end=end,
                                   spanning=spanning, request=request, state=state)


def _read_stats(*, chrom, start, end, spanning, request, state):
    request = request or ReadStatsRequest(read_ids_by_dataset={})
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        read_ids_by_dataset=request.read_ids_by_dataset,
        sample_seed=request.sample_seed,
        capability="read_stats",
        lift_hap_by_dataset=request.lift_hap_by_dataset,
    )
    request.read_ids_by_dataset = query.read_ids_by_dataset
    return compute_read_stats(
        state=state,
        chrom=query.chrom,
        start=start,
        end=end,
        spanning=spanning,
        request=request,
        query=query,
    )


@router.post("/api/reads/export_bam")
def export_read_subset_bam(payload: dict, state=Depends(get_state)):  # sync: BAM I/O in the threadpool
    """A BAM of the named reads' records in a region (Export data > Reads > BAM subset).

    Body: ``dataset_id``, ``chrom``, ``start``, ``end``, ``read_ids``. Returns
    the BAM as a download (coordinate-sorted; index it with ``samtools index``).
    """
    import os
    import tempfile
    from fastapi.responses import FileResponse, JSONResponse
    from starlette.background import BackgroundTask
    from services.read_bam_subset import SubsetError, write_read_subset_bam
    from services.runtime import get_public_mode
    from utils.responses import content_disposition

    if get_public_mode():
        return JSONResponse({"success": False, "error": "BAM export is disabled in public mode"}, status_code=403)
    payload = payload if isinstance(payload, dict) else {}
    dataset_id = state.resolve_dataset_id(payload.get("dataset_id"))
    read_ids = payload.get("read_ids") or []
    try:
        chrom = str(payload["chrom"])
        start, end = int(payload["start"]), int(payload["end"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"success": False, "error": "chrom, start and end are required"}, status_code=400)
    if not isinstance(read_ids, list):
        return JSONResponse({"success": False, "error": "read_ids must be a list"}, status_code=400)
    from services.plasmid_reconcile import contig_links
    fd, out_path = tempfile.mkstemp(prefix="fiberbrowser-subset-", suffix=".bam")
    os.close(fd)
    try:
        result = write_read_subset_bam(state, dataset_id, chrom, start, end, read_ids, out_path,
                                       contig_links=contig_links(state, dataset_id=dataset_id))
    except SubsetError as exc:
        os.unlink(out_path)
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    except Exception as exc:
        os.unlink(out_path)
        return JSONResponse({"success": False, "error": f"Could not write the BAM: {exc}"}, status_code=500)
    if result["reads"] == 0:
        os.unlink(out_path)
        return JSONResponse({"success": False, "error": "None of these reads align in this region"}, status_code=404)
    dataset = state.get_dataset(dataset_id)
    stem = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in (dataset.label or dataset_id))
    filename = f"{stem}_{chrom}_{start}-{end}_{result['reads']}reads.bam"
    return FileResponse(out_path, media_type="application/octet-stream",
                        headers={"Content-Disposition": content_disposition(filename),
                                 "X-FiberBrowser-Reads": str(result["reads"]),
                                 "X-FiberBrowser-Missing": str(len(result["missing"]))},
                        background=BackgroundTask(os.unlink, out_path))
