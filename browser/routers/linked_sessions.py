"""Linked split-view session endpoints."""
from __future__ import annotations

import io
import time
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from models.domain import SendToLinkedRequest
from services.contact_rendering import render_linked_reads_image
from services.dafc_diagnostics import log_dafc_diagnostic
from services.dafc_reads import find_ligated_reads, query_reads_for_dafc
from services.linked_read_compact import linked_reads_compact_response
from services.split_view_modes import (
    MOLECULE_LINKED,
    normalize_split_view_mode,
    split_view_contact_mode,
    split_view_semantics,
    split_view_session_summary,
)
from state.dependencies import get_dafc_state, get_state

router = APIRouter(tags=["linked-sessions"])


@router.post("/api/linked/session/create")
async def create_linked_session(dafc_state=Depends(get_dafc_state)):
    """Create a new linked browser session."""
    session_id = str(uuid.uuid4())[:8]
    dafc_state.linked_sessions[session_id] = {
        'id': session_id,
        'created_at': time.time(),
        'regions': None,
        'reads': [],
        'read_order': [],
        'linked_reads': [],
        'x_segment_names': [],
        'y_segment_names': [],
        'contact_mode': None,
        'split_view_mode': 'unassigned',
        'split_view_semantics': split_view_semantics('unassigned'),
        'version': 0,
    }

    return {
        "success": True,
        "session_id": session_id,
        "session": split_view_session_summary(dafc_state.linked_sessions[session_id], session_id),
    }


@router.get("/api/linked/sessions")
async def list_linked_sessions(dafc_state=Depends(get_dafc_state)):
    """List all linked sessions."""
    sessions = []
    for sid, session in dafc_state.linked_sessions.items():
        sessions.append(split_view_session_summary(session, sid))
    return {"sessions": sessions}


@router.get("/api/linked/session/{session_id}")
async def get_linked_session(
    session_id: str,
    state=Depends(get_state),
    dafc_state=Depends(get_dafc_state),
):
    """Get linked session state for polling."""
    session = dafc_state.linked_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        'id': session['id'],
        'version': session['version'],
        'regions': session['regions'],
        'n_reads': len(session['reads']),
        'read_order': session['read_order'],
        'linked_reads': session.get('linked_reads', []),
        'x_segment_names': session.get('x_segment_names', []),
        'y_segment_names': session.get('y_segment_names', []),
        **split_view_session_summary(session, session_id),
    }


@router.post("/api/linked/session/{session_id}/send")
async def send_to_linked_session(
    session_id: str,
    request: SendToLinkedRequest,
    state=Depends(get_state),
    dafc_state=Depends(get_dafc_state),
):
    """Send linked reads to a browser session from a contact-map selection."""
    session = dafc_state.linked_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    split_view_mode = normalize_split_view_mode(request.split_view_mode, request.contact_mode)
    semantics = split_view_semantics(split_view_mode, request.contact_mode)
    contact_mode = split_view_contact_mode(split_view_mode, request.contact_mode)

    log_dafc_diagnostic(
        f"Send to linked session: contact_mode={contact_mode}, split_view_mode={split_view_mode}"
    )

    if split_view_mode != MOLECULE_LINKED:
        log_dafc_diagnostic(f"  {split_view_mode}: storing regions only (no linked reads)")
        ligated = []
        linked_reads = []
        x_segment_names = []
        y_segment_names = []
    else:
        ligated = find_ligated_reads(
            request.regions.chrom,
            request.regions.x_start, request.regions.x_end,
            request.regions.y_start, request.regions.y_end,
            state=state,
            dafc_state=dafc_state,
        )

        log_dafc_diagnostic(f"  DAF-C mode: Found {len(ligated)} ligated reads")

        if request.read_ids:
            id_set = set(request.read_ids)
            ligated = [r for r in ligated if r['read_id'] in id_set]

        linked_reads = []
        x_segment_names = []
        y_segment_names = []

        for r in ligated:
            x_segs = [seg['name'] for seg in r.get('x_segments', [])]
            y_segs = [seg['name'] for seg in r.get('y_segments', [])]
            linked_reads.append({
                'base_id': r['read_id'],
                'x_segments': x_segs,
                'y_segments': y_segs,
            })
            x_segment_names.extend(x_segs)
            y_segment_names.extend(y_segs)

        log_dafc_diagnostic(f"  Linked reads: {len(linked_reads)}")
        log_dafc_diagnostic(f"  X segments: {len(x_segment_names)}, Y segments: {len(y_segment_names)}")
        if linked_reads:
            log_dafc_diagnostic(f"  Sample: {linked_reads[0]}")

    session['regions'] = request.regions.model_dump()
    session['reads'] = ligated
    session['read_order'] = [r['read_id'] for r in ligated]
    session['linked_reads'] = linked_reads
    session['x_segment_names'] = x_segment_names
    session['y_segment_names'] = y_segment_names
    session['contact_mode'] = contact_mode
    session['split_view_mode'] = split_view_mode
    session['split_view_semantics'] = semantics
    session['version'] += 1

    return {
        'success': True,
        'n_reads': len(ligated),
        'version': session['version'],
        'contact_mode': contact_mode,
        'split_view_mode': split_view_mode,
        'split_view_semantics': semantics,
    }


@router.get("/api/linked/reads/image")
async def get_linked_reads_image(
    session_id: str,
    region: str = Query(..., pattern="^(x|y)$"),
    max_width: int = Query(2000),
    row_height: int = Query(3),
    dafc_state=Depends(get_dafc_state),
):
    """Get a molecule-linked read image for X or Y with matched row ordering."""
    session = dafc_state.linked_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    split_view_mode = normalize_split_view_mode(session.get('split_view_mode'), session.get('contact_mode'))
    if split_view_mode != MOLECULE_LINKED:
        raise HTTPException(
            status_code=400,
            detail="Linked read image rendering requires molecule_linked mode; use compact reads or /api/render for independent split panes",
        )

    if not session['regions'] or not session['reads']:
        raise HTTPException(status_code=404, detail="No linked reads in session")

    regions = session['regions']
    if region == 'x':
        region_start = regions['x_start']
        region_end = regions['x_end']
    else:
        region_start = regions['y_start']
        region_end = regions['y_end']

    img = render_linked_reads_image(
        session['reads'],
        region,
        region_start,
        region_end,
        max_width,
        row_height,
    )

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)

    return Response(content=buf.read(), media_type="image/png")


@router.get("/api/linked/reads/data")
async def get_linked_reads_data(session_id: str, dafc_state=Depends(get_dafc_state)):
    """Get linked reads data for a session."""
    session = dafc_state.linked_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        **split_view_session_summary(session, session_id),
        'regions': session['regions'],
        'reads': session['reads'],
        'read_order': session['read_order'],
        'n_reads': len(session['reads']),
        'version': session['version'],
    }


@router.get("/api/linked/reads/compact")
async def get_linked_reads_compact(
    session_id: str,
    region: str = Query(..., pattern="^(x|y)$"),
    max_reads: int = Query(500),
    sort_by: str = Query('x'),
    hide_terminal_gaps: bool = Query(True, description="Hide leading/trailing gaps in reads"),
    terminal_gap_threshold: int = Query(
        500,
        description="Max terminal gap size (bp). Reads with larger terminal gaps are filtered out. 0 = no filtering.",
    ),
    sample_seed: Optional[str] = Query(None, description="Seed for reproducible linked-read sampling"),
    pin_ids: Optional[str] = Query(None, description="Comma-separated read IDs the sample keeps (a read gone to by name)"),
    state=Depends(get_state),
    dafc_state=Depends(get_dafc_state),
):
    """Get compact reads for one split-view region."""
    from services.read_pins import parse_pin_ids, pinned_reads
    t0 = time.time()

    session = dafc_state.linked_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    from services.background_work import interactive_read
    with interactive_read(), pinned_reads(parse_pin_ids(pin_ids if isinstance(pin_ids, str) else None)):
        result = linked_reads_compact_response(
            session_id,
            session,
            region,
            max_reads,
            sort_by,
            sample_seed,
            query_reads_for_dafc,
            state=state,
            dafc_state=dafc_state,
            hide_terminal_gaps=hide_terminal_gaps,
            terminal_gap_threshold=terminal_gap_threshold,
            log_fn=log_dafc_diagnostic,
        )
    elapsed = time.time() - t0
    result["server_elapsed_ms"] = round(elapsed * 1000, 1)
    log_dafc_diagnostic(f"Linked compact ({region}): {result.get('count', 0)} reads in {elapsed:.3f}s")
    return result


@router.delete("/api/linked/session/{session_id}")
async def delete_linked_session(session_id: str, dafc_state=Depends(get_dafc_state)):
    """Delete a linked session."""
    if session_id in dafc_state.linked_sessions:
        del dafc_state.linked_sessions[session_id]
        return {"success": True}
    raise HTTPException(status_code=404, detail="Session not found")
