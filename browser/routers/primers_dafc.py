"""DAF-C / 3C primer design route."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from models.requests import DafcPrimerDesignRequest
from services.primer_dafc_endpoint import design_dafc_primers_payload
from state.dependencies import get_state

router = APIRouter(tags=["primers"])


@router.post("/api/design_dafc_primers")
def design_dafc_primers_endpoint(req: DafcPrimerDesignRequest, state=Depends(get_state)):
    """Design Tm-compatible primer pairs for two 3C loci."""
    return design_dafc_primers_payload(req, state)
