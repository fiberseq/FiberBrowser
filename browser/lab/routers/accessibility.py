"""Accessibility (preview) endpoints: NFR variants and element co-accessibility via FiberHMM (EXPERIMENTAL)."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from state.dependencies import get_state

router = APIRouter(tags=["accessibility"])


@router.get('/api/accessibility/schema')
async def accessibility_schema():
    from lab.services.accessibility_workflow import schema
    try:
        return await asyncio.to_thread(schema)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post('/api/accessibility/jobs')
async def start_accessibility(request: dict, state=Depends(get_state)):
    from lab.services.accessibility_workflow import submit
    try:
        return await asyncio.to_thread(submit, state, request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/accessibility/jobs')
async def accessibility_jobs(state=Depends(get_state)):
    from lab.services.accessibility_workflow import list_jobs
    return await asyncio.to_thread(list_jobs, state)


@router.get('/api/accessibility/jobs/{job_id}')
async def accessibility_job(job_id: str, state=Depends(get_state)):
    from lab.services.accessibility_workflow import get_job
    try:
        return await asyncio.to_thread(get_job, state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Accessibility run not found in this session') from error


@router.delete('/api/accessibility/jobs/{job_id}')
async def cancel_accessibility(job_id: str, state=Depends(get_state)):
    from lab.services.accessibility_workflow import cancel
    try:
        return await asyncio.to_thread(cancel, state, job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Accessibility run not found') from error


@router.get('/api/accessibility/jobs/{job_id}/groups')
async def accessibility_groups(job_id: str, nfr: str = Query(...), state=Depends(get_state)):
    from lab.services.accessibility_workflow import read_groups
    try:
        return await asyncio.to_thread(read_groups, state, job_id, nfr)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Accessibility run not found') from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/accessibility/jobs/{job_id}/reads')
async def accessibility_reads(job_id: str, element: str = Query(...), minimum: float = Query(0.5, ge=0, le=1),
                              state=Depends(get_state)):
    from lab.services.accessibility_workflow import element_reads
    try:
        return await asyncio.to_thread(element_reads, state, job_id, element, minimum)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Accessibility run not found') from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/accessibility/jobs/{job_id}/export/{name}')
async def accessibility_export(job_id: str, name: str, state=Depends(get_state)):
    from fastapi.responses import FileResponse
    from lab.services.accessibility_workflow import export_path
    try:
        path = await asyncio.to_thread(export_path, state, job_id, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Accessibility run not found') from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    media = 'application/gzip' if name.endswith('.gz') else 'application/json' if name.endswith('.json') else 'text/tab-separated-values'
    return FileResponse(path, media_type=media, filename=f'fiberhmm-nfr-{job_id[:8]}-{name}')


# ------------------------------------------------------------------ analysis views (round 2)
async def _call(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Accessibility run not found in this session') from error
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get('/api/accessibility/jobs/{job_id}/overview')
async def accessibility_overview(job_id: str, nfr: str = Query(...), state=Depends(get_state)):
    from lab.services.accessibility_analysis import overview
    return await _call(overview, state, job_id, nfr)


@router.post('/api/accessibility/jobs/{job_id}/split')
async def accessibility_split(job_id: str, request: dict, state=Depends(get_state)):
    """Split the run's reads for a pair ({a, b}) or a combination ({elements: [...]}) into groups for the read panel."""
    from lab.services.accessibility_analysis import split
    if not isinstance(request, dict):
        raise HTTPException(status_code=422, detail='Request must be an object')
    return await _call(split, state, job_id, request.get('a'), request.get('b'), request.get('elements'))


@router.get('/api/accessibility/jobs/{job_id}/variants/{variant_id}/members.tsv')
async def accessibility_members(job_id: str, variant_id: str, state=Depends(get_state)):
    from fastapi.responses import Response
    from lab.services.accessibility_analysis import membership_tsv
    text = await _call(membership_tsv, state, job_id, variant_id)
    name = f"fiberhmm-nfr-{job_id[:8]}-{variant_id.replace(':', '_')}-members.tsv"
    return Response(text, media_type='text/tab-separated-values', headers={'Content-Disposition': f'attachment; filename="{name}"'})


@router.get('/api/accessibility/jobs/{job_id}/variants/{variant_id}/sequence')
async def accessibility_sequence(job_id: str, variant_id: str, flank: int = Query(300, ge=0, le=5000), state=Depends(get_state)):
    from lab.services.accessibility_analysis import variant_sequence
    return await _call(variant_sequence, state, job_id, variant_id, flank)


@router.post('/api/accessibility/jobs/{job_id}/variants/{variant_id}/prevalence')
async def accessibility_prevalence(job_id: str, variant_id: str, request: dict, state=Depends(get_state)):
    from lab.services.accessibility_analysis import variant_prevalence
    request = request if isinstance(request, dict) else {}
    return await _call(variant_prevalence, state, job_id, variant_id, request.get('groups'), request.get('bootstrap'))


MOTIF_OPTION_KEYS = ('mode', 'p', 'relative', 'background', 'strand', 'family_similarity', 'custom', 'pinned', 'motifs',
                     'flank', 'bg_flank', 'core_bp', 'min_reads')


def _motif_options(request):
    """The motif request body (services.motif_scoring.motif_options): mode ('p', default, or 'relative'), p (per-matrix
    p-value, default 1e-4) and relative (0.5-1), background ('local', 'genome' or 'uniform'), strand ('both', '+',
    '-'), family_similarity, custom ([{name, counts}]), pinned (always reported; omitted: the species' defaults),
    motifs (scan only these names), flank and bg_flank (bp), core_bp and min_reads (site occupancy)."""
    request = request if isinstance(request, dict) else {}
    out = {k: request[k] for k in MOTIF_OPTION_KEYS if request.get(k) is not None}
    if 'motifs' in out and not out['motifs']:
        out.pop('motifs')
    return out


@router.post('/api/accessibility/pooled')
async def accessibility_pooled(request: dict, state=Depends(get_state)):
    """Motif families x variant types pooled over every NFR of the given runs (job_ids), with the motif options."""
    from lab.services.accessibility_analysis import pooled_motifs
    request = request if isinstance(request, dict) else {}
    return await _call(pooled_motifs, state, request.get('job_ids'), **_motif_options(request))


@router.get('/api/accessibility/batches/{batch_id}')
async def accessibility_batch_status(batch_id: str):
    from lab.services.accessibility_analysis import get_batch
    return await _call(get_batch, batch_id)


@router.post('/api/accessibility/kmers')
async def accessibility_kmers(request: dict, state=Depends(get_state)):
    """De novo k-mers enriched in variant-specific openings, pooled over the runs (job_ids), with JASPAR matches."""
    from lab.services.accessibility_analysis import kmer_enrichment
    request = request if isinstance(request, dict) else {}
    return await _call(kmer_enrichment, state, request.get('job_ids'), request.get('k', 6), request.get('top', 40))


@router.post('/api/accessibility/jobs/{job_id}/batch')
async def accessibility_batch(job_id: str, request: dict, state=Depends(get_state)):
    """Find variants in many regions (e.g. the Regions catalogue) with this run's datasets and settings."""
    from lab.services.accessibility_analysis import submit_batch
    request = request if isinstance(request, dict) else {}
    return await _call(submit_batch, state, job_id, request.get('regions'))


@router.post('/api/accessibility/jobs/{job_id}/chipatlas')
async def accessibility_chipatlas(job_id: str, request: dict, state=Depends(get_state)):
    """Fetch ChIP-Atlas peaks of the given factors over the run's window (background; poll the returned id)."""
    from lab.services.accessibility_analysis import chipatlas_peaks
    request = request if isinstance(request, dict) else {}
    return await _call(chipatlas_peaks, state, job_id, request.get('factors'), request.get('max_per_factor'),
                       request.get('cell_type_classes'), request.get('cell_types'))


@router.get('/api/accessibility/jobs/{job_id}/chipatlas_experiments')
async def accessibility_chipatlas_experiments(job_id: str, factors: str = '', cell_type_classes: str = '', cell_types: str = '',
                                              state=Depends(get_state)):
    """ChIP-Atlas experiment selector for the run's assembly: cell type classes and cell types (with counts) over the
    factors (comma separated; none: every TF), and how many experiments the chosen classes / cell types match.
    Cell type names may hold commas: cell_types is a JSON list when it starts with '['."""
    import json as _json
    from lab.services.accessibility_analysis import chipatlas_experiments

    def names(text):
        text = (text or '').strip()
        if text.startswith('['):
            try:
                return [str(x) for x in _json.loads(text)]
            except ValueError:
                raise HTTPException(status_code=400, detail='cell types: a JSON list of names')
        return [x for x in text.split(',') if x.strip()]
    return await _call(chipatlas_experiments, state, job_id, names(factors), names(cell_type_classes), names(cell_types))


@router.get('/api/accessibility/chipatlas/{task_id}')
async def accessibility_chipatlas_status(task_id: str):
    from lab.services.chipatlas_peaks import status
    return await _call(status, task_id)


@router.get('/api/accessibility/chipatlas_metadata')
async def accessibility_chipatlas_metadata():
    """Whether ChIP-Atlas' experiment list (about 340 MB) is downloaded, and the download's progress."""
    from lab.services.chipatlas_peaks import metadata_status
    from services.external_chipatlas import get_chipatlas_status_payload
    return dict(metadata_status(), progress=get_chipatlas_status_payload())


@router.post('/api/accessibility/chipatlas_metadata')
async def accessibility_chipatlas_metadata_download():
    """Download ChIP-Atlas' experiment list (about 340 MB, once; the app's ChIP-Atlas cache) in the background."""
    import threading
    from services import external_chipatlas as E
    if not E.chipatlas_loading:
        threading.Thread(target=E.load_chipatlas_metadata_sync, daemon=True).start()
    return dict(started=True)


@router.post('/api/accessibility/jobs/{job_id}/classes')
async def accessibility_class_run(job_id: str, state=Depends(get_state)):
    """Run Find classes on this run's window (or report the compatible run that exists): the footprint layer of the
    motif sites."""
    from lab.services.accessibility_analysis import submit_class_run
    return await _call(submit_class_run, state, job_id)


@router.get('/api/accessibility/jobs/{job_id}/class-status')
async def accessibility_class_status(job_id: str, state=Depends(get_state)):
    """The footprint classes the run can use: joined by the run, joined after it (pair tests need a new run), or none."""
    from lab.services.accessibility_analysis import class_status
    return await _call(class_status, state, job_id)


@router.post('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/motifs/profile')
async def accessibility_nfr_motif_profile(job_id: str, nfr_id: str, request: dict, state=Depends(get_state)):
    """Motif-centred meta-profile of one family: P(open) and P(footprinted | open) per variant around its sites,
    pooled over this NFR ('nfr') or every NFR of the run ('run')."""
    from lab.services.accessibility_analysis import nfr_motif_profile
    request = request if isinstance(request, dict) else {}
    return await _call(nfr_motif_profile, state, job_id, nfr_id, request.get('family'), request.get('scope') or 'nfr',
                       request.get('half'), **_motif_options(request))


@router.post('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/motifs/sizes')
async def accessibility_nfr_site_sizes(job_id: str, nfr_id: str, request: dict, state=Depends(get_state)):
    """NFR size at motif sites ({sites: [[start, end], ...], core_bp, min_reads}): the size of the opening covering
    each site core per read, by variant, with the test between variants."""
    from lab.services.accessibility_analysis import nfr_site_sizes
    request = request if isinstance(request, dict) else {}
    return await _call(nfr_site_sizes, state, job_id, nfr_id, request.get('sites'), request.get('core_bp'), request.get('min_reads'))


@router.post('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/motifs')
async def accessibility_nfr_motifs(job_id: str, nfr_id: str, request: dict, state=Depends(get_state)):
    from lab.services.accessibility_analysis import nfr_motifs
    options = _motif_options(request)
    return await _call(nfr_motifs, state, job_id, nfr_id, **options)


@router.post('/api/accessibility/jobs/{job_id}/variants/{variant_id}/motifs')
async def accessibility_motifs(job_id: str, variant_id: str, request: dict, state=Depends(get_state)):
    from lab.services.accessibility_analysis import variant_motifs
    options = _motif_options(request)
    return await _call(variant_motifs, state, job_id, variant_id, **options)


@router.get('/api/accessibility/jobs/{job_id}/variants/{variant_id}/{view}')
async def accessibility_variant_view(job_id: str, variant_id: str, view: str, state=Depends(get_state)):
    """shape (size, edges, boundary nucleosomes), vplots (centre and coverage V-plots), phasing."""
    from lab.services.accessibility_analysis import variant_view
    return await _call(variant_view, state, job_id, variant_id, view)


@router.get('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/classes')
async def accessibility_nfr_classes(job_id: str, nfr_id: str, state=Depends(get_state)):
    """Footprint classes inside the NFR, with open and member-given-open per variant."""
    from lab.services.accessibility_analysis import nfr_classes
    return await _call(nfr_classes, state, job_id, nfr_id)


@router.get('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/cooccupancy')
async def accessibility_nfr_cooccupancy(job_id: str, nfr_id: str, state=Depends(get_state)):
    """Pairs of footprint classes footprinted together on molecules, within each variant (MH over channels)."""
    from lab.services.accessibility_analysis import class_cooccupancy
    return await _call(class_cooccupancy, state, job_id, nfr_id)


@router.get('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/conservation')
async def accessibility_nfr_conservation(job_id: str, nfr_id: str, flank: int = Query(300, ge=0, le=5000), state=Depends(get_state)):
    """Per-base phyloP over the NFR's window (the assembly's UCSC track, read remotely)."""
    from lab.services.accessibility_analysis import nfr_conservation
    return await _call(nfr_conservation, state, job_id, nfr_id, flank)


@router.get('/api/accessibility/jobs/{job_id}/classes/{class_id}')
async def accessibility_class_variants(job_id: str, class_id: str, state=Depends(get_state)):
    """The NFR variants a footprint class sits in, with open and member-given-open per variant."""
    from lab.services.accessibility_analysis import class_variants
    return await _call(class_variants, state, job_id, class_id)


@router.get('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/members.tsv')
async def accessibility_nfr_members(job_id: str, nfr_id: str, state=Depends(get_state)):
    from fastapi.responses import Response
    from lab.services.accessibility_analysis import nfr_membership_tsv
    text = await _call(nfr_membership_tsv, state, job_id, nfr_id)
    name = f"fiberhmm-nfr-{job_id[:8]}-{nfr_id}-members.tsv"
    return Response(text, media_type='text/tab-separated-values', headers={'Content-Disposition': f'attachment; filename="{name}"'})


@router.get('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/sequence')
async def accessibility_nfr_sequence(job_id: str, nfr_id: str, flank: int = Query(300, ge=0, le=5000), state=Depends(get_state)):
    from lab.services.accessibility_analysis import nfr_sequence
    return await _call(nfr_sequence, state, job_id, nfr_id, flank)


@router.post('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/prevalence')
async def accessibility_nfr_prevalence(job_id: str, nfr_id: str, request: dict, state=Depends(get_state)):
    from lab.services.accessibility_analysis import nfr_prevalence
    request = request if isinstance(request, dict) else {}
    return await _call(nfr_prevalence, state, job_id, nfr_id, request.get('groups'), request.get('bootstrap'))


@router.get('/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/{view}')
async def accessibility_nfr_view(job_id: str, nfr_id: str, view: str, step: Optional[int] = Query(None), size_step: Optional[int] = Query(None),
                                 pad: Optional[int] = Query(None), state=Depends(get_state)):
    """Every variant of the NFR in one figure: shape, vplots (step / size_step: position and size bins, pad: flank bp),
    phasing."""
    from lab.services.accessibility_analysis import nfr_view
    return await _call(nfr_view, state, job_id, nfr_id, view, step, size_step, pad)


@router.post('/api/accessibility/jobs/{job_id}/transfer')
async def accessibility_transfer(job_id: str, request: dict, state=Depends(get_state)):
    """Quantify one NFR's frozen variants on other open datasets at the run's locus (a small job; poll it)."""
    from lab.services.accessibility_analysis import submit_transfer
    request = request if isinstance(request, dict) else {}
    return await _call(submit_transfer, state, job_id, request.get('dataset_ids'), request.get('nfr'), request.get('chemistry_overrides'))


@router.get('/api/accessibility/transfers/{transfer_id}')
async def accessibility_transfer_status(transfer_id: str, state=Depends(get_state)):
    from lab.services.accessibility_analysis import get_transfer
    try:
        return await asyncio.to_thread(get_transfer, state, transfer_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Quantification not found') from error


@router.delete('/api/accessibility/transfers/{transfer_id}')
async def accessibility_transfer_cancel(transfer_id: str, state=Depends(get_state)):
    from lab.services.accessibility_analysis import cancel_transfer
    try:
        return await asyncio.to_thread(cancel_transfer, state, transfer_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail='Quantification not found') from error
