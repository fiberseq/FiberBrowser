"""Status, genome loading, sequence, and cache endpoints.

Extracted from server.py.
"""
from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Body, Depends, HTTPException

from state.dependencies import get_dafc_state, get_state
from services.genome_loading import load_genome_blocking
from services.circular_genome import MAX_USER_CIRCULAR_CHROM_SIZE, circular_chrom_size, circular_region_wraps, circular_view_segments
from services.plasmid_maps import PlasmidMap, parse_plasmid_map, plasmid_features_to_gtf_data
from services.supplemental_sequences import supplemental_sequence_for_chrom as _supplemental_sequence_for_chrom
from services.genome_registry import (
    GENOME_REGISTRY,
    get_default_initial_position,
    get_genome_cache_status,
    list_genomes,
)
from services.local_paths import normalize_local_path, path_access_error
from services.primer_config import primer_config_payload
from services.runtime import copilot_included, get_public_mode
from utils.chrom import normalize_chrom_name

router = APIRouter(tags=["genome"])


def _ensure_norm_chrom(transcripts):
    if transcripts is None or len(transcripts) == 0:
        return transcripts
    if "norm_chrom" not in transcripts.columns:
        transcripts = transcripts.copy()
        transcripts["norm_chrom"] = transcripts["chrom"].apply(normalize_chrom_name)
        return transcripts
    missing = transcripts["norm_chrom"].isna() if hasattr(transcripts["norm_chrom"], "isna") else []
    if getattr(missing, "any", lambda: False)():
        transcripts = transcripts.copy()
        transcripts.loc[missing, "norm_chrom"] = transcripts.loc[missing, "chrom"].apply(normalize_chrom_name)
    return transcripts


def _merge_gtf_data(existing, addition, contig: str | None = None):
    """Merge supplemental plasmid annotations into the active reference GTF.

    ``contig`` is the plasmid the addition annotates: its old rows are replaced
    even when the new map has no features at all.
    """
    if not addition and not contig:
        return existing
    addition = addition or {"transcripts": None, "exons": None}

    import pandas as pd

    existing = existing or {}
    # A plasmid's contig is annotated by its map alone: reloading a revised map
    # replaces that contig's rows (its feature IDs repeat, so appending would
    # mix the old features' exons into the new ones).
    added_tx = addition.get("transcripts") if isinstance(addition, dict) else None
    replaced = set()
    if added_tx is not None and len(added_tx) > 0 and "chrom" in pd.DataFrame(added_tx).columns:
        replaced = set(pd.DataFrame(added_tx)["chrom"].astype(str))
    if contig:
        replaced.add(str(contig))
    tx_parts = []
    exon_parts = []
    for payload in (existing, addition):
        transcripts = payload.get("transcripts") if isinstance(payload, dict) else None
        exons = payload.get("exons") if isinstance(payload, dict) else None
        if transcripts is not None:
            frame = pd.DataFrame(transcripts)
            if payload is existing and replaced and "chrom" in frame.columns:
                frame = frame[~frame["chrom"].astype(str).isin(replaced)]
            tx_parts.append(frame)
        if exons is not None:
            frame = pd.DataFrame(exons)
            if payload is existing and replaced and "chrom" in frame.columns:
                frame = frame[~frame["chrom"].astype(str).isin(replaced)]
            exon_parts.append(frame)

    transcripts = pd.concat(tx_parts, ignore_index=True) if tx_parts else pd.DataFrame()
    transcripts = _ensure_norm_chrom(transcripts)
    from services.gene_annotations import exon_table

    exons = exon_table(pd.concat(exon_parts, ignore_index=True) if exon_parts else None)

    tx_by_chrom = {}
    if len(transcripts) > 0 and "norm_chrom" in transcripts.columns:
        for norm_chrom, group in transcripts.groupby("norm_chrom"):
            tx_by_chrom[norm_chrom] = group

    merged = {**existing, **addition}
    merged["transcripts"] = transcripts
    merged["exons"] = exons
    merged["tx_by_chrom"] = tx_by_chrom
    return merged


def _append_gtf_path(existing_path: str | None, path: str) -> str:
    if not existing_path:
        return path
    paths = [part for part in str(existing_path).split(os.pathsep) if part]
    if path not in paths:
        paths.append(path)
    return os.pathsep.join(paths)


def _parse_map(path: str) -> PlasmidMap:
    """Parse a plasmid map; one on a connected cluster is fetched whole first (maps are small)."""
    from services.remote_sources import is_browsable_ref
    if is_browsable_ref(path):
        from services.remote_sources.opening import local_copy
        return parse_plasmid_map(local_copy(path))
    return parse_plasmid_map(path)


def _path_key(path: str) -> str:
    from services.remote_sources import is_browsable_ref
    return path if is_browsable_ref(path) else os.path.abspath(path)


def _load_plasmid_into_state(state, plasmid: PlasmidMap, path: str) -> dict:
    """Publish a parsed plasmid map (sequence, metadata, features, genome id) under the state lock; the map is
    read and parsed by the caller, outside it."""
    # Datasets and the reference it lands in: the workspace's state lock, then (a panel view) its context's.
    from services.genome_loading import reference_write_lock
    with reference_write_lock(state):
        return _publish_plasmid(state, plasmid, path)


def _publish_plasmid(state, plasmid: PlasmidMap, path: str) -> dict:
    label = os.path.basename(path) or plasmid.name
    state.add_supplemental_plasmid_reference(
        plasmid.name,
        plasmid.sequence,
        source="plasmid_map",
        path=path,
        label=label,
        circular=plasmid.circular,
    )
    from services.plasmid_reconcile import sequence_md5
    metadata = dict(state.plasmid_metadata or {})
    # The map's own sequence (its origin): a BAM contig is matched against it.
    metadata[plasmid.name] = {**(metadata.get(plasmid.name) or {}), "map_md5": sequence_md5(plasmid.sequence), "frame_offset": 0}
    state.plasmid_metadata = metadata
    state.gtf_data = _merge_gtf_data(state.gtf_data, plasmid_features_to_gtf_data(plasmid), contig=plasmid.name)
    state.gtf_path = _append_gtf_path(getattr(state, "gtf_path", None), path)
    if not getattr(state, "current_genome", None):
        state.current_genome = "plasmids"
    return {
        "success": True,
        "name": plasmid.name,
        "path": path,
        "length": len(plasmid.sequence),
        "circular": plasmid.circular,
        "feature_count": len(plasmid.features),
        "warnings": getattr(plasmid, "warnings", []),
        "current_genome": getattr(state, "current_genome", None),
    }


def _sequence_response_from_string(
    sequence: str,
    *,
    chrom: str,
    start: int,
    end: int,
    circular: bool,
) -> dict:
    chrom_len = len(sequence)
    if circular and circular_region_wraps(start, end, chrom_len):
        pieces = [
            sequence[segment.ref_start:segment.ref_end]
            for segment in circular_view_segments(start, end, chrom_len)
        ]
        return {
            "sequence": "".join(pieces).upper(),
            "chrom": chrom,
            "start": start,
            "end": end,
            "circular": True,
        }

    clamped_start = max(0, start)
    clamped_end = min(end, chrom_len)
    if clamped_start >= clamped_end:
        return {"sequence": "", "chrom": chrom, "start": clamped_start, "end": clamped_end, "circular": bool(circular)}
    return {
        "sequence": sequence[clamped_start:clamped_end].upper(),
        "chrom": chrom,
        "start": clamped_start,
        "end": clamped_end,
        "circular": bool(circular),
    }


@router.get("/api/status")
async def get_status(state=Depends(get_state), dafc_state=Depends(get_dafc_state), initial_position: bool = True):
    """Get current data loading status"""
    gene_count = 0
    if state.gtf_data is not None and 'transcripts' in state.gtf_data:
        gene_count = int(len(state.gtf_data['transcripts']))
    
    # Calculate cache stats
    methylation_cache_entries = len(getattr(state, '_methylation_cache', {}))
    broad_cache_entries = len(getattr(state, '_broad_cache', {}))
    broad_cache_max = getattr(state, '_broad_cache_max', 50)
    
    # The main view opens on the reads of the datasets it shows on the loaded
    # genome. A dataset aligned to another assembly (the mismatch banner offers
    # it its own panel genome) or one that has its own panel genome doesn't
    # choose it: its best-covered locus is on another reference. Only when no
    # dataset fits the loaded genome does the view stay put (the banner says
    # what to load; services/genome_check.py).
    from services.genome_check import blocking_mismatch, main_genome_dataset_ids
    genome_mismatch = await asyncio.to_thread(blocking_mismatch, state) if state.datasets else None
    main_ids = await asyncio.to_thread(main_genome_dataset_ids, state) if state.datasets else None
    if not initial_position or (genome_mismatch and not main_ids):
        initial_position = None
    else:
        initial_position = await asyncio.to_thread(state.get_initial_position, 10000, main_ids) or get_default_initial_position(
            state.chroms if state.chroms else None,
            getattr(dafc_state, "chroms", None),
        )

    return {
        "datasets": len(state.datasets),
        "has_gtf": state.gtf_data is not None and len(state.gtf_data) > 0,
        "gene_count": gene_count,
        "track_count": len(state.orthogonal_tracks),
        "chroms": len(state.chroms),
        "overlays": len(getattr(state, 'modification_overlays', {})),
        "has_fasta": state.fasta is not None or bool(getattr(state, "plasmid_sequences", {})),
        "fasta_path": state.fasta_path,
        "fasta_error": getattr(state, 'fasta_error', None),
        "primers_enabled": True,
        "primer_config": primer_config_payload(state),
        "initial_position": initial_position,
        "genome_mismatch": genome_mismatch,
        "config": getattr(state, 'config', {'prefetch_multiplier': 10}),
        "cache": {
            "broad": f"{broad_cache_entries}/{broad_cache_max}",
            "methylation": methylation_cache_entries,
        },
        "current_genome": getattr(state, 'current_genome', None),
        "circular_chroms": getattr(state, "circular_chroms", {}),
        "plasmids": getattr(state, "plasmid_metadata", {}),
        "has_fire": state.fire_df is not None,
        "public_mode": get_public_mode(),
        # What this install includes (FiberBrowser.app leaves the Copilot out).
        "features": {"copilot": copilot_included()},
    }


@router.get("/api/sequence")
async def get_sequence(chrom: str, start: int, end: int,
    state=Depends(get_state)):
    """Get reference sequence for a genomic region."""
    requested_start = int(start)
    requested_end = int(end)
    # Safety cap: max 10kb per request
    if requested_end - requested_start > 10000:
        requested_end = requested_start + 10000

    supplemental = _supplemental_sequence_for_chrom(state, chrom)
    if supplemental is not None:
        ref_name, sequence = supplemental
        return _sequence_response_from_string(
            sequence,
            chrom=ref_name,
            start=requested_start,
            end=requested_end,
            circular=bool(circular_chrom_size(state, ref_name)),
        )

    if state.fasta is None:
        raise HTTPException(status_code=404, detail="No FASTA loaded")

    # The FASTA's own name for chrom (chr prefix, chrM/MT, roman numerals).
    from utils.chrom import resolve_reference_name

    ref_name = resolve_reference_name(chrom, state.fasta.references, getattr(state, "chrom_map", None))

    if ref_name is None:
        raise HTTPException(status_code=404, detail=f"Chromosome {chrom} not found in FASTA")

    chrom_len = state.fasta.get_reference_length(ref_name)
    circular_size = circular_chrom_size(state, chrom)
    if circular_size and circular_region_wraps(requested_start, requested_end, chrom_len):
        pieces = [
            state.fasta.fetch(ref_name, segment.ref_start, segment.ref_end).upper()
            for segment in circular_view_segments(requested_start, requested_end, chrom_len)
        ]
        return {
            "sequence": "".join(pieces),
            "chrom": chrom,
            "start": requested_start,
            "end": requested_end,
            "circular": True,
        }

    # Clamp to valid range for ordinary linear requests.
    start = max(0, requested_start)
    end = min(requested_end, chrom_len)

    if start >= end:
        return {"sequence": "", "chrom": chrom, "start": start, "end": end}

    sequence = state.fasta.fetch(ref_name, start, end).upper()
    return {"sequence": sequence, "chrom": chrom, "start": start, "end": end, "circular": False}


@router.post("/api/load_fasta")
async def load_fasta_endpoint(path: str,
    state=Depends(get_state)):
    """Load a FASTA file at runtime.

    Runs pysam I/O in a thread pool to avoid blocking the event loop.
    """
    original_path = path
    path = normalize_local_path(path)
    from services.genome_loading import reference_lock

    def set_error(message):
        with reference_lock(state):
            state.fasta_error = message
        return {"success": False, "error": message}

    def load():
        # The whole publication (sequence, collection reset, error, the answer's fields) under the lock.
        try:
            if not path.startswith(("http://", "https://")):
                access_error = path_access_error(path, original_path=original_path, expected="file")
                if access_error:
                    return set_error(access_error)
            with reference_lock(state):
                err = state._load_fasta(path)
                if err is None and state.fasta is not None:
                    state.reference_pairs = None
                    state.fasta_error = None
                    return {
                        "success": True,
                        "path": state.fasta_path,
                        "sequences": state.fasta.nreferences,
                        "inferred_genome": state.current_genome,
                    }
                state.fasta_error = err or "Failed to load FASTA"
                return {"success": False, "error": state.fasta_error}
        except Exception as e:
            return set_error(str(e))
    return await asyncio.to_thread(load)


@router.post("/api/load_plasmid")
async def load_plasmid_endpoint(path: str, state=Depends(get_state)):
    """Load a native plasmid map as a supplemental chromosome/reference."""
    original_path = path
    path = normalize_local_path(path)
    try:
        access_error = path_access_error(path, original_path=original_path, expected="file")
        if access_error:
            return {"success": False, "error": access_error}
        plasmid = await asyncio.to_thread(_parse_map, path)
        result = await asyncio.to_thread(_load_plasmid_into_state, state, plasmid, path)
        return {**result, **(await asyncio.to_thread(_reconcile_loaded_maps, state, [plasmid.name]))}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def _reconcile_loaded_maps(state, names) -> dict:
    """Link the datasets already loaded whose contigs are these maps' sequences."""
    from services.plasmid_reconcile import reconcile
    try:
        report = reconcile(state, chroms=names)
    except Exception as exc:
        return {"links": [], "problems": [{"kind": "error", "message": f"Plasmid check failed: {exc}", "can_confirm": False}]}
    return {"links": report["links"], "problems": report["problems"]}


@router.post("/api/load_plasmids")
async def load_plasmids_endpoint(paths: list[str] = Body(..., embed=True), state=Depends(get_state)):
    """Load multiple native plasmid maps as supplemental chromosomes."""
    loaded = []
    errors = []
    for raw_path in paths or []:
        original_path = raw_path
        path = normalize_local_path(raw_path)
        try:
            access_error = path_access_error(path, original_path=original_path, expected="file")
            if access_error:
                errors.append({"path": original_path, "error": access_error})
                continue
            plasmid = await asyncio.to_thread(_parse_map, path)
            loaded.append(await asyncio.to_thread(_load_plasmid_into_state, state, plasmid, path))
        except Exception as exc:
            errors.append({"path": original_path, "error": str(exc)})

    report = await asyncio.to_thread(_reconcile_loaded_maps, state, [item["name"] for item in loaded]) if loaded else {}
    return {
        "success": len(loaded) > 0 and not errors,
        "loaded": loaded,
        "errors": errors,
        "count": len(loaded),
        **report,
    }


def _loaded_map_chrom(state, path: str) -> str | None:
    for name, meta in (getattr(state, "plasmid_metadata", None) or {}).items():
        if (meta or {}).get("source") == "plasmid_map" and not meta.get("map_chrom") and meta.get("path") \
                and _path_key(meta["path"]) == _path_key(path):
            return name
    return None


def _dataset_with_paths(state, paths: list[str]) -> str | None:
    from services.remote_sources import is_source_ref
    wanted = [_path_key(p) for p in paths]
    for dataset_id in getattr(state, "dataset_order", None) or []:
        dataset = state.datasets.get(dataset_id)
        if dataset is None:
            continue
        own = dataset.paths or [dataset.path]
        if getattr(dataset, "is_remote", False) and not all(is_source_ref(p) for p in own):
            continue
        if [_path_key(p) for p in own] == wanted:
            return dataset_id
    return None


def _open_plasmid_dataset(state, map_path: str, bam_paths: list[str], reference_fasta: str | None) -> dict:
    from models.requests import AddDatasetRequest
    from services.dataset_endpoint import add_dataset_for_request
    from services.plasmid_reconcile import links_payload, reconcile

    map_chrom = _loaded_map_chrom(state, map_path)
    plasmid_result = None
    if map_chrom is None:
        plasmid = _parse_map(map_path)
        plasmid_result = _load_plasmid_into_state(state, plasmid, map_path)
        map_chrom = plasmid.name
    dataset_ids, datasets, errors = [], [], []
    for bam_path in bam_paths:
        existing = _dataset_with_paths(state, [bam_path])
        if existing is None:
            added = add_dataset_for_request(state, AddDatasetRequest(path=bam_path))
            if not added.get("success"):
                errors.append({"path": bam_path, "error": added.get("error") or "could not load"})
                continue
            existing = added["dataset"]["id"]
        dataset_ids.append(existing)
    report = reconcile(state, chroms=[map_chrom], dataset_ids=dataset_ids,
                       reference_fasta=reference_fasta, report_unmatched=True)
    for dataset_id in dataset_ids:
        datasets.append(state.datasets[dataset_id].to_dict())
    meta = state.plasmid_metadata.get(map_chrom) or {}
    links = [link for link in links_payload(state)["links"] if link.get("dataset_id") in dataset_ids
             and link.get("map_chrom") == map_chrom]
    return {
        "success": bool(dataset_ids) or not bam_paths,
        "plasmid": plasmid_result or {
            "success": True, "name": map_chrom, "path": map_path, "length": meta.get("size"),
            "circular": meta.get("circular", True), "already_loaded": True,
        },
        # Where to look: the chromosome the first linked dataset's reads are on.
        "chrom": links[0]["chrom"] if links else map_chrom,
        "datasets": datasets,
        "links": links,
        "problems": report["problems"],
        "errors": errors,
        "current_genome": getattr(state, "current_genome", None),
    }


@router.post("/api/plasmid/open")
async def open_plasmid_dataset_endpoint(
    map_path: str = Body(..., embed=True),
    bam_paths: list[str] = Body(default_factory=list, embed=True),
    reference_fasta: str | None = Body(None, embed=True),
    state=Depends(get_state),
):
    """Open a plasmid map with the BAM(s) aligned to it: the map is loaded, the
    BAMs are added, and each BAM contig that is the map's sequence (renamed or
    rotated) is linked to it. ``problems`` says what differs for the rest."""
    original = map_path
    map_path = normalize_local_path(map_path)
    access_error = path_access_error(map_path, original_path=original, expected="file")
    if access_error:
        return {"success": False, "error": access_error}
    if reference_fasta:
        original_fasta = reference_fasta
        reference_fasta = normalize_local_path(reference_fasta)
        fasta_error = path_access_error(reference_fasta, original_path=original_fasta, expected="file")
        if fasta_error:
            return {"success": False, "error": fasta_error}
    paths = []
    for raw in bam_paths or []:
        path = normalize_local_path(raw)
        error = path_access_error(path, original_path=raw, expected="file")
        if error:
            return {"success": False, "error": error}
        paths.append(path)
    try:
        return await asyncio.to_thread(_open_plasmid_dataset, state, map_path, paths, reference_fasta)
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/api/plasmid/confirm")
async def confirm_plasmid_link_endpoint(
    chrom: str = Body(..., embed=True),
    dataset_id: str = Body(..., embed=True),
    contig: str = Body(..., embed=True),
    offset: int = Body(0, embed=True),
    state=Depends(get_state),
):
    """Link a BAM contig to a map when its sequence could not be checked (the user says it is that plasmid)."""
    # In a worker: the link is published under the state lock (services/genome_loading).
    return await asyncio.to_thread(_confirm_plasmid_link, state, chrom, dataset_id, contig, offset)


def _confirm_plasmid_link(state, chrom, dataset_id, contig, offset):
    from services.plasmid_reconcile import apply_link, links_payload

    meta = (state.plasmid_metadata or {}).get(chrom) or {}
    if meta.get("source") != "plasmid_map":
        return {"success": False, "error": f"{chrom} is not a loaded plasmid map"}
    map_chrom = meta.get("map_chrom") or chrom
    dataset = state.datasets.get(dataset_id)
    if dataset is None:
        return {"success": False, "error": f"Dataset not found: {dataset_id}"}
    lengths = {}
    try:
        from services.remote_sources.opening import open_alignment_file
        for path in dataset.paths or [dataset.path]:
            with open_alignment_file(path, "rb", check_sq=False) as bam:
                lengths.update(zip(bam.references, bam.lengths))
    except Exception as exc:
        return {"success": False, "error": f"Could not read {dataset_id}: {exc}"}
    size = int((state.plasmid_metadata.get(map_chrom) or {}).get("size") or 0)
    if contig not in lengths:
        return {"success": False, "error": f"{dataset_id} has no contig {contig}"}
    if int(lengths[contig]) != size:
        return {"success": False, "error": f"{contig} is {int(lengths[contig]):,} bp and {map_chrom} is {size:,} bp: they cannot be the same plasmid"}
    link = apply_link(state, map_chrom, dataset_id, contig, offset, method="confirmed", verified=False,
                      detail="linked by you (same length; sequence not checked)")
    return {"success": True, "link": link, **links_payload(state, link["chrom"])}


@router.get("/api/plasmid/links")
async def plasmid_links_endpoint(chrom: str | None = None, state=Depends(get_state)):
    """Which datasets' contigs are linked to the plasmid maps (and the problems found)."""
    from services.plasmid_reconcile import links_payload
    return links_payload(state, chrom)


@router.post("/api/circular_chrom")
async def set_circular_chrom_endpoint(
    chrom: str,
    circular: bool = True,
    state=Depends(get_state),
):
    """Mark or unmark a loaded chromosome as circular."""
    from services.genome_loading import publishes_reference

    @publishes_reference
    def mark(state):
        try:
            size = state._chrom_size_for(chrom)
            if not size:
                return {"success": False, "error": f"Chromosome not found: {chrom}"}
            if circular:
                if size > MAX_USER_CIRCULAR_CHROM_SIZE:
                    return {
                        "success": False,
                        "error": f"Manual circular mode is limited to chromosomes <= {MAX_USER_CIRCULAR_CHROM_SIZE:,} bp",
                    }
                state.set_circular_chrom(chrom, source="user", size=size)
            else:
                translated = state.translate_chrom(chrom) if hasattr(state, "translate_chrom") else chrom
                state.circular_chroms = {
                    key: meta for key, meta in (state.circular_chroms or {}).items()
                    if key not in {chrom, translated}
                }
                state.refresh_circular_chrom_flags()
            return {"success": True, "chrom": chrom, "circular": circular, "size": size}
        except Exception as exc:
            return {"success": False, "error": str(exc)}
    return await asyncio.to_thread(mark, state)


@router.get("/api/genomes")
async def get_genomes():
    """Get list of available online genomes."""
    return {"genomes": list_genomes()}


@router.post("/api/load_genome")
async def load_genome(genome_id: str, state=Depends(get_state)):
    """Load an online genome (remote FASTA + cached GTF download).

    Runs blocking I/O (pysam, downloads, GTF parsing) in a thread pool
    to avoid freezing the event loop.
    """
    if genome_id not in GENOME_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown genome: {genome_id}")
    from services.runtime import current_sandbox_id, get_public_mode
    if current_sandbox_id() is not None:
        # A tour tab owns its reference (copy-on-write): the demo's genome may load.
        from services.demo_data import demo_genomes
        if genome_id not in demo_genomes() | {getattr(state, 'current_genome', None)}:
            raise HTTPException(status_code=403, detail="A tour tab can only load the demos' genome")
    elif get_public_mode():
        # The genome is shared by every visitor: only the catalog's may load.
        from services.catalog_endpoint import catalog_genome
        if genome_id != catalog_genome() and genome_id != getattr(state, 'current_genome', None):
            raise HTTPException(status_code=403, detail="Only the catalog's genome can be loaded on a public server")
        if genome_id == getattr(state, 'current_genome', None) and getattr(state, 'fasta', None) is not None:
            return {"success": True, "genome": genome_id, "message": "Genome already loaded"}

    from services.runtime import allow_shared_writes

    def load():
        with allow_shared_writes():
            result = load_genome_blocking(state, genome_id, GENOME_REGISTRY[genome_id])
        if result.get("success"):
            # Datasets given this genome as their own now fit the main one: the
            # second copy goes (services/panel_genomes.py).
            from services.panel_genomes import release_main_genome
            release_main_genome(state)
        return result
    return await asyncio.to_thread(load)


@router.get("/api/genome/check")
def genome_check_endpoint(state=Depends(get_state)):
    """Whether each loaded dataset fits the loaded genome, and the registry
    genome its header points to (services/genome_check.py). Report only: on a
    public server ``can_load_genomes`` is false and nothing is offered."""
    from services.genome_check import genome_check
    return genome_check(state)


@router.get("/api/cache/status")
async def get_cache_status():
    """Return what metadata and genome files are cached for each genome."""
    from services.external_ucsc import _disk_cache
    return get_genome_cache_status(disk_cache=_disk_cache)


@router.get("/api/reference_pairs")
def reference_pairs_endpoint(state=Depends(get_state)):
    pairs = getattr(state, 'reference_pairs', None)
    if not pairs and getattr(state, 'fasta_path', None):
        pairs = [dict(fasta=state.fasta_path, annotation=getattr(state, 'gtf_path', None))]
    return {"pairs": pairs or []}


@router.post("/api/reference_pairs")
def load_reference_pairs_endpoint(pairs: list[dict[str, str | None]] = Body(...), state=Depends(get_state)):
    from services.genome_loading import reference_lock
    from services.reference_collection import load_reference_pairs
    try:
        with reference_lock(state):
            return load_reference_pairs(state, pairs)
    except Exception as error:
        return {"success": False, "error": str(error)}


# ---------------------------------------------------------------------------
# A dataset on another assembly, with its own reference (services/panel_genomes.py)
# ---------------------------------------------------------------------------

def _refuse_panel_genomes() -> None:
    """Loading a reference is local work: never on a public server or in a tour tab."""
    from services.runtime import current_sandbox_id, get_public_mode
    if get_public_mode() or current_sandbox_id() is not None:
        raise HTTPException(status_code=403, detail="Loading a reference for one dataset isn't available here")


@router.get("/api/panel_genomes")
def panel_genomes_endpoint(state=Depends(get_state)):
    """The references loaded besides the main genome, and which datasets use them."""
    from services.panel_genomes import payload
    return payload(state)


@router.post("/api/panel_genomes/attach")
def attach_panel_genome_endpoint(
    dataset_ids: list[str] = Body(..., embed=True),
    genome_id: str | None = Body(None, embed=True),
    fasta_path: str | None = Body(None, embed=True),
    gtf_path: str | None = Body(None, embed=True),
    contigs: bool = Body(False, embed=True),
    span: int = Body(10_000, embed=True),
    state=Depends(get_state),
):
    """Give these datasets a reference of their own (a registry genome, a FASTA
    and annotation, or their own contigs). The genome is loaded once and shared
    by every dataset on it; the main genome is unchanged. Returns the reference
    and each dataset's best-covered window on it (where its panel opens)."""
    _refuse_panel_genomes()
    from services.panel_genomes import attach, is_view
    if is_view(state):
        raise HTTPException(status_code=400, detail="panel_genome does not apply here")
    paths = {}
    for name, raw in (("fasta_path", fasta_path), ("gtf_path", gtf_path)):
        if not raw:
            continue
        path = normalize_local_path(raw)
        error = path_access_error(path, original_path=raw, expected="file")
        if error:
            return {"success": False, "error": error}
        paths[name] = path
    if genome_id and genome_id not in GENOME_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown genome: {genome_id}")
    try:
        return attach(state, list(dataset_ids or []), genome_id=genome_id, contigs=bool(contigs),
                      span=span, **paths)
    except KeyError as exc:
        return {"success": False, "error": str(exc.args[0] if exc.args else exc)}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/api/panel_genomes/detach")
def detach_panel_genome_endpoint(dataset_ids: list[str] = Body(..., embed=True), state=Depends(get_state)):
    """These datasets use the main genome again (a reference no dataset uses is closed)."""
    from services.panel_genomes import detach
    return detach(state, list(dataset_ids or []))


@router.get("/api/reference/genome_declarations")
def genome_declarations_endpoint(state=Depends(get_state)):
    """Every genome declared for a FASTA in this session (the page's autosave keeps them)."""
    from services import motifs as motif_service
    return {"declarations": motif_service.list_declarations(state),
            "revision": motif_service.declaration_revision(state)}


@router.post("/api/reference/genome_declarations")
def restore_genome_declarations_endpoint(declarations: list[dict] = Body(..., embed=True), state=Depends(get_state)):
    """Put back declarations saved with the page's session (Reopen / Restore): saved ones are set, none cleared."""
    from services import motifs as motif_service
    if get_public_mode():
        raise HTTPException(status_code=403, detail="Not available on a public server")
    known = set(motif_service.GENOME_TO_JASPAR_SPECIES) | set(GENOME_REGISTRY)
    valid = [d for d in declarations or [] if isinstance(d, dict) and d.get("genome") in known and d.get("fasta_path")]
    changed = motif_service.restore_declarations(state, valid)
    return {"success": True, "changed": changed, "declarations": motif_service.list_declarations(state),
            "revision": motif_service.declaration_revision(state)}


@router.post("/api/reference/declare_genome")
def declare_genome_endpoint(genome: str | None = Body(None, embed=True), state=Depends(get_state)):
    """Say which genome a custom FASTA's sequence comes from (an insert, a construct, a contig), so
    genome-keyed features (JASPAR motif species, TE library) use it; its coordinates stay its own and
    nothing is mapped onto it. With ``panel_genome=<key>``, a panel's reference; ``genome: null`` clears it."""
    from services import motifs as motif_service
    if get_public_mode():
        raise HTTPException(status_code=403, detail="Not available on a public server")
    genome = (genome or "").strip() or None
    if genome and genome not in motif_service.GENOME_TO_JASPAR_SPECIES and genome not in GENOME_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown genome: {genome}")
    fasta_path = motif_service.declare_genome(state, genome)
    if fasta_path is None:
        return {"success": False, "error": "Load a FASTA first: a genome is declared for a FASTA's sequences."}
    species, inferred = motif_service.jaspar_genome(state)
    taxid = motif_service.GENOME_TO_JASPAR_SPECIES.get(species or "")
    return {"success": True, "genome": genome, "fasta_path": fasta_path,
            "revision": motif_service.declaration_revision(state),
            "jaspar_species": {"genome": species, "taxid": taxid, "inferred": inferred,
                               "name": motif_service.JASPAR_SPECIES_NAMES.get(taxid)} if taxid else None}
