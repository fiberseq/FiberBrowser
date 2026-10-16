"""Aggregate primer routes split by workflow."""
from __future__ import annotations

from fastapi import APIRouter

from routers.primers_4c import router as fourc_router
from routers.primers_config import router as config_router
from routers.primers_dafc import router as dafc_router
from routers.primers_standard import router as standard_router
from services.primer_candidates import blast_and_build_pairs, fast_find_primers
from services.primer_filters import subsample_pair_indices as _subsample_pair_indices

router = APIRouter(tags=["primers"])
router.include_router(config_router)
router.include_router(standard_router)
router.include_router(dafc_router)
router.include_router(fourc_router)
