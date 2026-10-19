"""SNPs and SNP combinations in a view (the Variants panel)."""
from __future__ import annotations

import asyncio
import threading

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from services.variants_endpoint import VariantsCancelled, VariantsRequestError, alleles_payload, snps_payload
from state.dependencies import get_state
from utils.request_body import json_object_body
from utils.responses import ORJSONResponse

router = APIRouter(tags=["reads"])


async def _run(request: Request, fn, state, body: dict):
    """``fn`` in a worker thread, cancelled when the client goes away (a new view, Cancel, a closed tab)."""
    gone = threading.Event()

    async def _watch():
        from services.client_disconnect import wait_for_disconnect
        try:
            await wait_for_disconnect(request)
        except Exception:
            return
        gone.set()

    watcher = asyncio.create_task(_watch())
    from services.background_work import cancel_scope, Cancelled
    from services.reconstruction_budget import ResourceResult
    def compute():
        with cancel_scope(gone):
            return fn(state, body, gone.is_set)
    try:
        payload = await asyncio.to_thread(compute)
    except VariantsRequestError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)
    except (VariantsCancelled, Cancelled):
        return JSONResponse({"detail": "cancelled"}, status_code=499)
    except ResourceResult as exc:
        return ORJSONResponse({**exc.payload(), 'detail': f'{exc.status}: {exc.reason}'}, status_code=413)
    finally:
        gone.set()
        watcher.cancel()
    return ORJSONResponse(payload)


@router.post("/api/variants/snps")
async def post_variant_snps(request: Request, state=Depends(get_state)):
    """SNPs (and small indels) in a view: allele counts, minor-allele fraction, strands, DAF-safe calls."""
    body = await json_object_body(request)
    return await _run(request, snps_payload, state, body)


@router.post("/api/variants/alleles")
async def post_variant_alleles(request: Request, state=Depends(get_state)):
    """The view's reads grouped by allele at one SNP, by allele combination at several, or by HP tag."""
    body = await json_object_body(request)
    return await _run(request, alleles_payload, state, body)


@router.post("/api/variants/svs")
async def post_variant_svs(request: Request, state=Depends(get_state)):
    """SV clusters (deletions and insertions) in a view."""
    from services.variants_endpoint import svs_payload
    body = await json_object_body(request)
    return await _run(request, svs_payload, state, body)


@router.post("/api/variants/sv_linkage")
async def post_variant_sv_linkage(request: Request, state=Depends(get_state)):
    """An SV's carriers vs reference reads at each SNP of the view (which alleles travel with it)."""
    from services.variants_endpoint import sv_linkage_payload
    body = await json_object_body(request)
    return await _run(request, sv_linkage_payload, state, body)
