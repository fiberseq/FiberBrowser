"""Endpoint orchestration helpers for Jupyter browser-control routes."""
from __future__ import annotations

import os
from typing import Optional

from models.requests import (
    BrowserActionsRequest,
    GotoGeneRequest,
    GotoRequest,
    JupyterFilterRequest,
    JupyterBrowserSettingsRequest,
    JupyterBrowserSettingsSnapshotRequest,
    PushReadsReplaceRequest,
    PushReadsRequest,
    ReadOrderRequest,
    MotifSearchRequest,
    SequenceRegion,
    SequenceRequest,
    SyncPeaksRequest,
)
from services.analysis_query import AnalysisReadQuery
from services.layer_aliases import normalize_jupyter_settings
from services import motifs as motif_service
from services.jupyter_motifs import collect_motifs_to_search, search_motifs_in_regions
from services.jupyter_payloads import build_analysis_state
from services.jupyter_sequences import extract_sequence_regions, get_cached_fasta_dict, notebook_sequence_fasta
from services.query_params import resolve_dataset_id



def _circular_chrom_sizes(state) -> dict[str, int]:
    """Sizes of the circular contigs (sequence extraction and motif search read across their origin)."""
    sizes = {}
    for name, meta in (getattr(state, "circular_chroms", {}) or {}).items():
        size = meta.get("size") if isinstance(meta, dict) else None
        if size:
            sizes[str(name)] = int(size)
    return sizes

def get_current_region_payload(state) -> dict:
    default_chrom = state.chroms[0].name if state.chroms else "chr1"
    return {
        "chrom": getattr(state, "_current_chrom", default_chrom),
        "start": getattr(state, "_current_start", 0),
        "end": getattr(state, "_current_end", 10000),
    }


def goto_region_for_request(state, jupyter_state, req: GotoRequest) -> dict:
    jupyter_state.target_region = {
        "chrom": req.chrom,
        "start": req.start,
        "end": req.end,
    }
    state._current_chrom = req.chrom
    state._current_start = req.start
    state._current_end = req.end
    jupyter_state.version += 1
    return {"success": True, "region": jupyter_state.target_region}


def goto_gene_for_request(state, jupyter_state, req: GotoGeneRequest) -> dict:
    if state.gtf_data is None:
        return {"success": False, "error": "No GTF file loaded"}

    transcripts = state.gtf_data["transcripts"]
    matches = transcripts[transcripts["gene_name"].str.lower() == req.gene.lower()]
    if len(matches) == 0:
        matches = transcripts[transcripts["gene_name"].str.lower().str.contains(req.gene.lower())]
    if len(matches) == 0:
        return {"success": False, "error": f"Gene '{req.gene}' not found"}

    gene = matches.iloc[0]
    start = max(0, int(gene["start"]) - req.padding)
    end = int(gene["end"]) + req.padding

    jupyter_state.target_region = {
        "chrom": str(gene["chrom"]),
        "start": start,
        "end": end,
        "gene": str(gene["gene_name"]),
    }
    state._current_chrom = str(gene["chrom"])
    state._current_start = start
    state._current_end = end
    jupyter_state.version += 1
    return {"success": True, "region": jupyter_state.target_region}


def _resolve_browser_action_context(state, action: dict) -> dict:
    """Attach server-known context that the frontend cannot safely guess."""
    if action.get("type") != "cluster_peak_at_gene_tss":
        return action
    gene_name = action.get("gene") or action.get("gene_name")
    if not isinstance(gene_name, str) or not gene_name or not getattr(state, "gtf_data", None):
        return action
    transcripts = state.gtf_data.get("transcripts")
    if transcripts is None or transcripts.empty or "gene_name" not in transcripts.columns:
        return action
    matches = transcripts[transcripts["gene_name"].astype(str).str.lower() == gene_name.lower()]
    if matches.empty:
        return action
    row = matches.iloc[0]
    start = int(row["start"])
    end = int(row["end"])
    strand = str(row.get("strand", "+") or "+")
    tss = start if strand == "+" else end - 1  # ends are exclusive
    resolved = dict(action)
    resolved["gene"] = {
        "id": str(row.get("gene_id", row.get("gene_name", gene_name)) or gene_name),
        "name": str(row.get("gene_name", gene_name) or gene_name),
        "chrom": str(row["chrom"]),
        "start": min(start, end),
        "end": max(start, end),
        "strand": strand,
        "tss": int(tss),
    }
    resolved["gene_name"] = resolved["gene"]["name"]
    resolved["chrom"] = resolved["gene"]["chrom"]
    resolved["tss"] = int(tss)
    return resolved


def queue_browser_actions_for_request(state, jupyter_state, req: BrowserActionsRequest) -> dict:
    """Queue UI-equivalent browser actions for the active frontend to execute."""
    if not hasattr(jupyter_state, "pending_browser_actions"):
        jupyter_state.pending_browser_actions = []
    queued = []
    for index, action in enumerate(req.actions or []):
        if not isinstance(action, dict):
            continue
        action = _resolve_browser_action_context(state, action)
        queued.append({
            "id": action.get("id") or f"browser-action-{jupyter_state.version + 1}-{index}",
            "label": req.label,
            "action": action,
        })
    jupyter_state.pending_browser_actions.extend(queued)
    if queued:
        jupyter_state.version += 1
    return {"success": True, "queued": len(queued), "label": req.label}


def get_clusters_payload(state, dataset_id: Optional[str] = None) -> dict:
    resolved_id = resolve_dataset_id(state, dataset_id)
    dataset = state.get_dataset(resolved_id) if resolved_id else None
    if not dataset:
        return {"assignments": {}, "error": f"Dataset {resolved_id} not found"}

    assignments = getattr(dataset, "cluster_assignments", {})
    element_info = getattr(dataset, "cluster_element_info", None)
    peak_regions = getattr(dataset, "cluster_peak_regions", None)

    counts = {}
    for cluster in assignments.values():
        counts[cluster] = counts.get(cluster, 0) + 1

    result = {
        "assignments": assignments,
        "cluster_counts": counts,
        "n_reads": len(assignments),
        "n_clusters": len(counts),
        "dataset_id": resolved_id,
    }

    if element_info:
        result["n_elements"] = element_info.get("n_elements", 0)
        result["cluster_patterns"] = element_info.get("cluster_patterns", {})
        result["element_read_ids"] = element_info.get("element_read_ids", {})
        result["method"] = element_info.get("method", "unknown")
        if element_info.get("elements"):
            result["elements"] = element_info["elements"]

    if peak_regions:
        result["element_regions"] = peak_regions

    return result


def get_reads_payload(
    state,
    *,
    dataset_id: Optional[str] = None,
    chrom: Optional[str] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
    spanning: bool = True,
    min_footprints: int = 0,
    sample_seed: Optional[str] = None,
) -> dict:
    """Get compact reads for notebook analysis from the working set."""
    if chrom is None:
        chrom = getattr(state, "_current_chrom", state.chroms[0].name if state.chroms else "chr1")
    if start is None:
        start = getattr(state, "_current_start", 0)
    if end is None:
        end = getattr(state, "_current_end", 10000)

    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
        sample_seed=sample_seed,
        min_footprints=min_footprints,
    )
    if not query.dataset_ids:
        return {"reads": [], "error": "No datasets available"}

    resolved_id = query.dataset_ids[0]
    dataset = state.get_dataset(resolved_id) if resolved_id else None
    if not dataset:
        return {"reads": [], "error": f"Dataset {resolved_id} not found"}

    working_set = query.build_working_set(state, resolved_id)
    reads = working_set.reads
    for read in reads:
        read["chrom"] = query.chrom
        read["region_start"] = start
        read["region_end"] = end
        read["n_footprints"] = sum(1 for interval in read.get("intervals", []) if interval[2] > 0)
        read["footprint_bases"] = sum(
            interval[1] - interval[0]
            for interval in read.get("intervals", [])
            if interval[2] > 0
        )

    return {
        "reads": reads,
        "chrom": query.chrom,
        "start": start,
        "end": end,
        "count": len(reads),
        "total_spanning": working_set.total_spanning,
        "total_overlapping": working_set.total_overlapping,
        "working_count": len(working_set.reads),
        "dataset_id": resolved_id,
        "spanning": spanning,
        "min_footprints": min_footprints,
        "sample_seed": query.sample_seed,
    }


def push_reads_for_request(jupyter_state, req: PushReadsRequest) -> dict:
    # The first unused ID: counting entries would reuse one after "_pushed"
    # is cleared and overwrite that earlier dataset's reads.
    n = len(jupyter_state.custom_reads)
    while f"jupyter_{n}" in jupyter_state.custom_reads:
        n += 1
    dataset_id = f"jupyter_{n}"
    jupyter_state.custom_reads[dataset_id] = req.reads
    jupyter_state.version += 1
    return {"success": True, "dataset_id": dataset_id, "count": len(req.reads), "label": req.label}


def push_reads_replace_for_request(jupyter_state, req: PushReadsReplaceRequest) -> dict:
    jupyter_state.custom_reads["_pushed"] = req.reads
    jupyter_state.version += 1
    return {"success": True, "count": len(req.reads), "label": req.label}


def clear_pushed_reads(jupyter_state) -> dict:
    jupyter_state.custom_reads.pop("_pushed", None)
    jupyter_state.version += 1
    return {"success": True}


def get_read_order_payload(state, jupyter_state, dataset_id: Optional[str] = None) -> dict:
    resolved_id = resolve_dataset_id(state, dataset_id)
    return {
        "read_ids": jupyter_state.read_order.get(resolved_id, []),
        "dataset_id": resolved_id,
    }


def set_read_order_for_request(state, jupyter_state, req: ReadOrderRequest) -> dict:
    resolved_id = resolve_dataset_id(state, req.dataset_id)
    if not resolved_id:
        return {"success": False, "error": "No dataset loaded"}

    jupyter_state.read_order[resolved_id] = req.read_ids
    jupyter_state.version += 1
    return {"success": True, "dataset_id": resolved_id, "count": len(req.read_ids)}


def clear_read_order(state, jupyter_state, dataset_id: Optional[str] = None) -> dict:
    if dataset_id:
        resolved_id = resolve_dataset_id(state, dataset_id)
        jupyter_state.read_order.pop(resolved_id, None)
    else:
        jupyter_state.read_order.clear()
    jupyter_state.version += 1
    return {"success": True}


def get_browser_order_payload(state, jupyter_state, dataset_id: Optional[str] = None) -> dict:
    resolved_id = resolve_dataset_id(state, dataset_id)
    order = getattr(jupyter_state, "browser_read_order", {})
    return {
        "read_ids": order.get(resolved_id, []),
        "dataset_id": resolved_id,
    }


def sync_browser_order_for_request(state, jupyter_state, req: ReadOrderRequest) -> dict:
    resolved_id = resolve_dataset_id(state, req.dataset_id)
    if not resolved_id:
        return {"success": False, "error": "No dataset loaded"}

    if not hasattr(jupyter_state, "browser_read_order"):
        jupyter_state.browser_read_order = {}
    jupyter_state.browser_read_order[resolved_id] = req.read_ids
    return {"success": True, "dataset_id": resolved_id, "count": len(req.read_ids)}


def get_read_filter_payload(state, jupyter_state, dataset_id: Optional[str] = None) -> dict:
    resolved_id = resolve_dataset_id(state, dataset_id)
    return {
        "read_ids": jupyter_state.read_filter.get(resolved_id, []),
        "dataset_id": resolved_id,
        "active": resolved_id in jupyter_state.read_filter,
    }


def set_read_filter_for_request(state, jupyter_state, req: JupyterFilterRequest) -> dict:
    resolved_id = resolve_dataset_id(state, req.dataset_id)
    if not resolved_id:
        return {"success": False, "error": "No dataset loaded"}

    jupyter_state.read_filter[resolved_id] = req.read_ids
    jupyter_state.version += 1
    return {"success": True, "dataset_id": resolved_id, "count": len(req.read_ids)}


def clear_read_filter(state, jupyter_state, dataset_id: Optional[str] = None) -> dict:
    if dataset_id:
        resolved_id = resolve_dataset_id(state, dataset_id)
        jupyter_state.read_filter.pop(resolved_id, None)
    else:
        jupyter_state.read_filter.clear()
    jupyter_state.version += 1
    return {"success": True}


def get_selection_payload(state, jupyter_state, dataset_id: Optional[str] = None) -> dict:
    resolved_id = resolve_dataset_id(state, dataset_id)
    command_selection = getattr(jupyter_state, "selected_read_ids_by_dataset", {})
    synced_selection = jupyter_state.browser_settings.get("selected_read_ids", {})

    if resolved_id:
        if resolved_id in command_selection:
            read_ids = command_selection.get(resolved_id) or []
        elif resolved_id in synced_selection:
            read_ids = synced_selection.get(resolved_id) or []
        else:
            read_ids = []
        return {
            "read_ids": read_ids,
            "dataset_id": resolved_id,
            "read_ids_by_dataset": {resolved_id: read_ids} if read_ids else {},
        }

    read_ids_by_dataset = command_selection or synced_selection or {}
    read_ids = jupyter_state.selected_reads
    if not read_ids and read_ids_by_dataset:
        read_ids = next(iter(read_ids_by_dataset.values()), [])
    return {"read_ids": read_ids, "read_ids_by_dataset": read_ids_by_dataset}


def set_selection(state, jupyter_state, read_ids: list[str], dataset_id: Optional[str] = None) -> dict:
    resolved_id = resolve_dataset_id(state, dataset_id)
    jupyter_state.selected_reads = read_ids
    if resolved_id:
        if not hasattr(jupyter_state, "selected_read_ids_by_dataset"):
            jupyter_state.selected_read_ids_by_dataset = {}
        jupyter_state.selected_read_ids_by_dataset[resolved_id] = read_ids
    jupyter_state.selection_delivered = False
    jupyter_state.version += 1
    return {"success": True, "dataset_id": resolved_id, "count": len(read_ids)}


def request_refresh(jupyter_state) -> dict:
    jupyter_state.refresh_requested = True
    jupyter_state.version += 1
    return {"success": True}


def get_custom_reads_payload(jupyter_state, dataset_id: str) -> dict:
    reads = jupyter_state.custom_reads.get(dataset_id, [])
    return {"reads": reads, "count": len(reads)}


def clear_all_jupyter_state(jupyter_state) -> dict:
    jupyter_state.clear_all()
    return {"success": True}


def get_peaks_payload(jupyter_state, *, selected_only: bool = False) -> dict:
    peaks = jupyter_state.peaks
    if selected_only:
        peaks = [peak for peak in peaks if peak.get("isSelected", False)]

    return {
        "peaks": peaks,
        "count": len(peaks),
        "chrom": peaks[0].get("chrom") if peaks else None,
    }


def sync_peaks_for_request(jupyter_state, req: SyncPeaksRequest) -> dict:
    jupyter_state.peaks = [{**peak, "chrom": req.chrom} for peak in req.peaks]
    jupyter_state.version += 1
    return {"success": True, "count": len(req.peaks)}


def queue_browser_settings_update(jupyter_state, req: JupyterBrowserSettingsRequest) -> dict:
    fields_set = getattr(req, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(req, "__fields_set__", set())
    updates = normalize_jupyter_settings({field: getattr(req, field) for field in fields_set})
    if not updates:
        return {"success": True, "updated": []}

    # Merged into what the frontend hasn't picked up yet (later values win), so
    # two settings calls between polls both apply. Opening and closing panels
    # are operations, not values: they queue in order in panel_ops.
    updated = sorted(updates.keys())
    pending = dict(getattr(jupyter_state, "pending_settings_update", None) or {})
    ops = list(pending.get("panel_ops") or [])
    for key, verb in (("close_panel", "close"), ("open_panel", "open")):
        panel = updates.pop(key, None)
        if panel:
            ops.append([verb, panel])
    if ops:
        pending["panel_ops"] = ops
    jupyter_state.pending_settings_update = {**pending, **updates}
    jupyter_state.version += 1
    return {"success": True, "updated": updated}


def get_browser_settings_payload(jupyter_state) -> dict:
    return {"settings": jupyter_state.browser_settings}


def get_session_manifest_payload(jupyter_state) -> dict:
    return {"manifest": jupyter_state.browser_settings.get("session_manifest", {})}


def get_analysis_state_payload(jupyter_state) -> dict:
    return build_analysis_state(jupyter_state.browser_settings)


def sync_browser_settings_for_request(jupyter_state, req: JupyterBrowserSettingsSnapshotRequest) -> dict:
    dump = getattr(req, "model_dump", None)
    raw_settings = dump(exclude_unset=True) if dump else req.dict(exclude_unset=True)
    settings = normalize_jupyter_settings(raw_settings)
    jupyter_state.browser_settings.update(settings)
    # Once the browser has received the notebook's selection, what it reports
    # is the current selection: the command stops shadowing it (in
    # get_selection) and stops being sent back to the browser on later polls.
    if "selected_read_ids" in settings and getattr(jupyter_state, "selection_delivered", False):
        jupyter_state.selected_read_ids_by_dataset = {}
        jupyter_state.selected_reads = []
        jupyter_state.selection_delivered = False
    return {"success": True, "settings": jupyter_state.browser_settings}


def get_sequences_for_request(state, req: SequenceRequest) -> dict:
    fasta = notebook_sequence_fasta(state)
    if not fasta:
        return {
            "success": False,
            "error": "FASTA file not configured. Use set_fasta() or configure via primer panel.",
            "sequences": [],
        }

    try:
        fa = get_cached_fasta_dict(state, path=fasta)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to load FASTA: {str(exc)}",
            "sequences": [],
        }

    circular_chrom_sizes = _circular_chrom_sizes(state)

    results = extract_sequence_regions(
        req.regions,
        fa,
        extend=req.extend,
        strand=req.strand,
        reverse_complement=motif_service.reverse_complement,
        circular_chrom_sizes=circular_chrom_sizes,
    )

    return {
        "success": True,
        "sequences": results,
        "count": len(results),
        "strand": req.strand,
        "extend": req.extend,
    }


def search_motifs_for_request(state, jupyter_state, req: MotifSearchRequest) -> dict:
    regions = req.regions
    if regions is None:
        if not jupyter_state.peaks:
            return {
                "success": False,
                "error": "No regions provided and no peaks synced from browser",
                "hits": [],
            }
        regions = [
            SequenceRegion(
                chrom=peak["chrom"],
                start=peak["start"],
                end=peak["end"],
                name=f"{peak['chrom']}:{peak['start']}-{peak['end']}",
            )
            for peak in jupyter_state.peaks
        ]

    if not regions:
        return {"success": True, "hits": [], "count": 0}

    fasta = notebook_sequence_fasta(state)
    if not fasta:
        return {
            "success": False,
            "error": "FASTA file not configured. Use client.set_fasta(path) first.",
            "hits": [],
        }

    try:
        fa = get_cached_fasta_dict(state, path=fasta)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to load FASTA: {str(exc)}",
            "hits": [],
        }

    motifs_to_search, error_response = collect_motifs_to_search(req, jupyter_state.custom_motifs)
    if error_response:
        return error_response

    all_hits = search_motifs_in_regions(
        regions,
        fa,
        motifs_to_search,
        extend=req.extend,
        threshold=req.threshold,
        both_strands=req.both_strands,
        circular_chrom_sizes=_circular_chrom_sizes(state),
    )

    return {
        "success": True,
        "hits": all_hits,
        "count": len(all_hits),
        "motifs_searched": len(motifs_to_search),
        "regions_searched": len(regions),
    }
