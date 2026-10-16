"""4C inverse-PCR primer design route."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from models.requests import FourCPrimerDesignRequest
from services.primer_4c_endpoint import design_4c_primers_payload
from state.dependencies import get_state

router = APIRouter(tags=["primers"])


@router.post("/api/design_4c_primers")
def design_4c_primers_endpoint(req: FourCPrimerDesignRequest, state=Depends(get_state)):
    """Design outward-facing inverse PCR primers for a 4C viewpoint."""
    return design_4c_primers_payload(req, state)
