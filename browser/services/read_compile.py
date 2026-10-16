"""Compile reads from multiple genomic regions into a normalized coordinate space."""
from __future__ import annotations

from typing import Sequence

from services.read_metrics import DEFAULT_SAMPLE_SEED, normalize_sample_seed
from services.analysis_query import AnalysisReadQuery


def _map_coord(value: int, scale: float, offset: float) -> int:
    return int(value * scale + offset) if scale != 1.0 else int(value) + int(offset)


def _map_positions(values, scale: float, offset: float, target_width: int) -> list[int]:
    return [
        mapped
        for value in (values or [])
        for mapped in [_map_coord(value, scale, offset)]
        if 0 <= mapped < target_width
    ]


def _compile_read(read: dict, region_idx: int, dataset_id: str, scale: float, offset: float,
                  target_width: int) -> dict:
    new_intervals = [
        [_map_coord(iv[0], scale, offset), _map_coord(iv[1], scale, offset), iv[2]]
        for iv in read.get("intervals", [])
    ]

    compiled = {
        "id": f"r{region_idx}_{dataset_id}_{read['id']}",
        "intervals": new_intervals,
        "_region_idx": region_idx,
        "_dataset_id": dataset_id,
        "_original_id": read["id"],
    }

    for field in (
        "methyl",
        "methyl_m6a",
        "methyl_m5c",
        "possible_deam_ct",
        "possible_deam_ga",
    ):
        mapped_positions = _map_positions(read.get(field), scale, offset, target_width)
        if mapped_positions:
            compiled[field] = mapped_positions

    deam = read.get("deam")
    if deam:
        compiled["deam"] = [
            [mapped, int(event[1]) if len(event) > 1 else 0]
            for event in deam
            if event
            for mapped in [_map_coord(event[0], scale, offset)]
            if 0 <= mapped < target_width
        ]

    fire = read.get("fire")
    if fire:
        compiled["fire"] = [
            [_map_coord(f[0], scale, offset), _map_coord(f[1], scale, offset), f[2]]
            for f in fire
        ]

    if "qualities" in read:
        compiled["qualities"] = read["qualities"]

    layers = read.get("layers")
    if layers:
        new_layers = {}
        for layer_name, layer in layers.items():
            # Preserve aligned metadata such as annotation_names: strand-rescue
            # action labels (_R/_H) remain meaningful after coordinate remap.
            new_layer = dict(layer)
            new_layer["intervals"] = [
                [_map_coord(iv[0], scale, offset), _map_coord(iv[1], scale, offset), iv[2]]
                for iv in layer.get("intervals", [])
            ]
            new_layers[layer_name] = new_layer
        compiled["layers"] = new_layers

    return compiled


def compile_reads_from_regions(
    state,
    regions: Sequence,
    dataset_ids: Sequence[str] | None = None,
    spanning: bool = True,
    max_reads_per_region: int = 200,
    anchor: str = "center",
    target_width: int | None = None,
    sample_seed: str = DEFAULT_SAMPLE_SEED,
    include_deam_opportunities: bool = False,
) -> dict:
    """Build normalized compact reads plus region metadata for compile APIs."""
    if not regions:
        return {"success": False, "message": "No regions provided"}

    sample_seed = normalize_sample_seed(sample_seed)
    first_region = regions[0]
    first_query = AnalysisReadQuery.from_request(
        state,
        chrom=first_region.chrom,
        start=int(first_region.start),
        end=int(first_region.end),
        spanning=spanning,
        dataset_ids=dataset_ids,
        sample_seed=sample_seed,
    )
    dataset_ids = first_query.dataset_ids
    sample_seed = first_query.sample_seed
    if not dataset_ids:
        return {"success": False, "message": "No datasets loaded"}

    requested_layers = None
    if include_deam_opportunities:
        requested_layer_names = {"deam_opportunity"}
        for dataset_id in dataset_ids:
            dataset = (
                state.get_dataset(dataset_id)
                if hasattr(state, "get_dataset")
                else getattr(state, "datasets", {}).get(dataset_id)
            )
            requested_layer_names.update(
                name
                for name, present in (getattr(dataset, "available_layers", {}) or {}).items()
                if present
            )
        requested_layers = sorted(requested_layer_names)

    region_widths = [region.end - region.start for region in regions]
    target_width = int(target_width or max(region_widths))

    all_compiled_reads = []
    region_meta = []
    read_count_by_region = []

    for region_idx, region in enumerate(regions):
        region_start, region_end = int(region.start), int(region.end)
        region_width = region_end - region_start
        query = AnalysisReadQuery.from_request(
            state,
            chrom=region.chrom,
            start=region_start,
            end=region_end,
            spanning=spanning,
            dataset_ids=dataset_ids,
            sample_seed=sample_seed,
            requested_layers=requested_layers,
        )

        if region_width <= 0:
            read_count_by_region.append(0)
            continue

        scale = target_width / region_width if region_width != target_width else 1.0
        # A scaled region already spans the whole target width; anchoring it
        # as well would push it past the edge (and drop the marks there).
        if scale != 1.0:
            offset = 0
        elif anchor == "center":
            offset = target_width / 2 - region_width / 2
        elif anchor == "end":
            offset = target_width - region_width
        else:
            offset = 0

        region_reads = []
        for dataset_id in dataset_ids:
            working_set = query.build_working_set(state, dataset_id)
            for read in working_set.reads:
                region_reads.append(
                    _compile_read(read, region_idx, dataset_id, scale, offset, target_width)
                )

        if max_reads_per_region > 0 and len(region_reads) > max_reads_per_region:
            step = len(region_reads) / max_reads_per_region
            region_reads = [
                region_reads[int(i * step)]
                for i in range(max_reads_per_region)
            ]

        all_compiled_reads.extend(region_reads)
        read_count_by_region.append(len(region_reads))
        region_meta.append({
            "index": region_idx,
            "chrom": region.chrom,
            "start": region.start,
            "end": region.end,
            "label": region.label or f"{region.chrom}:{region.start}-{region.end}",
            "n_reads": len(region_reads),
            "offset": offset,
            "scale": scale,
        })

    return {
        "success": True,
        "reads": all_compiled_reads,
        "n_reads": len(all_compiled_reads),
        "n_regions": len(regions),
        "target_width": target_width,
        "regions": region_meta,
        "read_counts": read_count_by_region,
        "sample_seed": sample_seed,
    }
