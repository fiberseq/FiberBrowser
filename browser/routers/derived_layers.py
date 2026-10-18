"""Materialized derived-layer bundle endpoints."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from models.requests import DerivedLayerExportRequest, DerivedLayerLoadRequest
from services.analysis_query import AnalysisReadQuery
from services.dataset_registration import invalidate_dataset_caches, register_derived_layer_file
from services.derived_layer_export import materialize_derived_layer_bundles
from services.derived_layers import resolve_derived_layer_payload_path
from services.query_params import resolve_dataset_ids
from state.dependencies import get_state


router = APIRouter(tags=["footprint"])


@router.post("/api/footprint/derived_layers/load")
async def load_derived_layers(
    request: DerivedLayerLoadRequest = None,
    state=Depends(get_state),
):
    """Attach a saved `.fiberlayers` bundle to matching loaded datasets."""
    if request is None:
        return {"success": False, "error": "No request body"}
    dataset_ids = resolve_dataset_ids(state, dataset_ids=request.dataset_ids)
    from services.lift.capability import require_for_ids
    require_for_ids(state, dataset_ids, "consensus")

    def _do_load():
        bundle_path, error = resolve_derived_layer_payload_path(request.path)
        if error or not bundle_path:
            return {"success": False, "error": error or "Could not resolve derived-layer bundle"}

        if not dataset_ids:
            return {"success": False, "error": "No loaded datasets to attach derived layers to"}

        attached = []
        warnings = []
        for dataset_id in dataset_ids:
            dataset = state.datasets.get(dataset_id)
            if dataset is None:
                continue
            layer_ids = register_derived_layer_file(dataset, bundle_path, primary_path=dataset.path)
            if layer_ids:
                invalidate_dataset_caches(state, dataset_id)
                attached.append({
                    "dataset_id": dataset_id,
                    "layer_ids": layer_ids,
                })
            else:
                warnings.append(
                    f"{dataset.label}: bundle source did not match this dataset, or no classes were found"
                )

        datasets = [
            state.datasets[dataset_id].to_dict()
            for dataset_id in state.dataset_order
            if dataset_id in state.datasets
        ]
        if not attached:
            return {
                "success": False,
                "error": "No loaded dataset matched the derived-layer bundle source",
                "datasets": datasets,
                "attached": [],
                "warnings": warnings or None,
            }
        return {
            "success": True,
            "bundle_path": bundle_path,
            "attached": attached,
            "datasets": datasets,
            "warnings": warnings or None,
        }

    return await asyncio.to_thread(_do_load)


@router.post("/api/footprint/derived_layers/export")
async def export_derived_layers(
    chrom: str,
    region_start: int,
    region_end: int,
    spanning: bool = False,
    request: DerivedLayerExportRequest = None,
    state=Depends(get_state),
):
    """Materialize Footprint Analysis cart entries as reloadable layer bundles."""
    if request is None:
        return {"success": False, "error": "No request body"}

    def _do_export():
        if not request.output_dir:
            return {"success": False, "error": "Choose an output folder for the derived-layer bundle"}

        groups = list(request.groups or [])
        if not request.include_disabled:
            groups = [group for group in groups if group.get("enabled", True)]
        if not groups:
            return {"success": False, "error": "No enabled cart entries to export"}

        query = AnalysisReadQuery.from_request(
            state,
            chrom=chrom,
            start=region_start,
            end=region_end,
            spanning=spanning,
            dataset_ids=request.dataset_ids,
            read_ids_by_dataset=request.read_ids_by_dataset,
            max_reads=request.max_reads,
            sample_seed=request.sample_seed,
            include_methylation=False,
            include_layers=True,
        )
        try:
            results = materialize_derived_layer_bundles(
                state=state,
                query=query,
                groups=groups,
                output_dir=request.output_dir,
                bundle_name=request.bundle_name,
                genome=getattr(state, "current_genome", None),
            )
            for result in results:
                if result.bigbed_path:
                    dataset = state.datasets.get(result.dataset_id)
                    if dataset is not None:
                        register_derived_layer_file(dataset, result.bigbed_path, primary_path=dataset.path)
                        invalidate_dataset_caches(state, result.dataset_id)
            datasets = [
                state.datasets[dataset_id].to_dict()
                for dataset_id in state.dataset_order
                if dataset_id in state.datasets
            ]
            warnings = [warning for result in results for warning in result.warnings]
            matched_results = [result for result in results if result.n_rows > 0]
            return {
                "success": bool(matched_results),
                "bundles": [result.to_dict() for result in results],
                "datasets": datasets,
                "warnings": warnings or None,
                "error": None if matched_results else "No intervals matched the enabled cart entries",
            }
        except Exception as exc:
            import traceback
            traceback.print_exc()
            return {"success": False, "error": str(exc)}

    return await asyncio.to_thread(_do_export)
