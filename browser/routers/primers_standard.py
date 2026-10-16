"""Standard PCR primer design route."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from models.requests import PrimerDesignRequest
from services.primer_standard_endpoint import design_standard_primers_payload
from state.dependencies import get_state

router = APIRouter(tags=["primers"])


@router.post("/api/design_primers")
def design_primers_endpoint(req: PrimerDesignRequest, state=Depends(get_state)):
    """Design primers for a genomic region with progress tracking."""
    return design_standard_primers_payload(req, state)
