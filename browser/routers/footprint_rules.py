"""Portable Footprint Analysis rule endpoints."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from models.requests import FootprintRuleLoadRequest, FootprintRuleSaveRequest
from services.footprint_rules import load_footprint_rule_file, save_footprint_rule_file
from state.dependencies import get_state


router = APIRouter(tags=["footprint"])


@router.post("/api/footprint/rules/save")
async def save_footprint_rules(
    request: FootprintRuleSaveRequest = None,
    state=Depends(get_state),
):
    """Save Footprint Analysis cart entries as portable rule JSON."""
    if request is None:
        return {"success": False, "error": "No request body"}
    if not request.output_dir:
        return {"success": False, "error": "Choose an output folder for the footprint rule file"}
    if not request.groups:
        return {"success": False, "error": "No cart rules to save"}

    def _do_save():
        context = {
            "chrom": request.chrom,
            "start": request.start,
            "end": request.end,
            "spanning": request.spanning,
            "dataset_ids": request.dataset_ids,
            "sample_seed": request.sample_seed,
            "genome": getattr(state, "current_genome", None),
        }
        try:
            result = save_footprint_rule_file(
                groups=request.groups,
                output_dir=request.output_dir,
                bundle_name=request.bundle_name,
                context=context,
            )
            return {"success": True, **result}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    return await asyncio.to_thread(_do_save)


@router.post("/api/footprint/rules/load")
async def load_footprint_rules(request: FootprintRuleLoadRequest = None):
    """Load portable cart rules from JSON, including legacy fiberlayers manifests."""
    if request is None:
        return {"success": False, "error": "No request body"}

    def _do_load():
        try:
            result = load_footprint_rule_file(request.path)
            return {"success": True, **result}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    return await asyncio.to_thread(_do_load)
