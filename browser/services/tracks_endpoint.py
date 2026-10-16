"""Endpoint payload helpers for orthogonal track management."""
from __future__ import annotations

import os
import re
import time
import urllib.parse
from typing import Optional

import pyBigWig

from services.external_ucsc import _broken_url_cache
from services import motifs as motif_service
from services.local_paths import normalize_local_path, path_access_error
from services.orthogonal_tracks import parse_bed_file
from services.track_exports import build_multi_track_export, build_single_track_export, clamp_export_bins
from utils.validation import is_url


def _normalize_pwm_counts(counts: dict) -> dict[str, list[float]]:
    """Validate and normalize a raw A/C/G/T PWM/count dictionary."""
    if not isinstance(counts, dict):
        raise ValueError("PWM counts must be a dictionary with A/C/G/T arrays")
    normalized: dict[str, list[float]] = {}
    lengths = set()
    for base in "ACGT":
        values = counts.get(base)
        if not isinstance(values, list) or len(values) == 0:
            raise ValueError(f"PWM counts must include a non-empty {base} array")
        clean = [float(value) for value in values]
        normalized[base] = clean
        lengths.add(len(clean))
    if len(lengths) != 1:
        raise ValueError("PWM A/C/G/T arrays must all have the same length")
    return normalized


def _motif_track_response(track_index: int, track: dict) -> dict:
    return {
        "track_index": track_index,
        "path": track.get("path"),
        "label": track.get("label"),
        "motif_name": track.get("motif_name"),
        "motif_type": track.get("motif_type"),
        "motif_source": track.get("motif_source"),
        "threshold": track.get("threshold"),
    }


def _parse_filter_names(filter_names: Optional[str]) -> list[str]:
    if not filter_names:
        return []
    return [name.strip() for name in filter_names.split(",") if name.strip()]


def _same_filter_names(a: Optional[list[str]], b: Optional[list[str]]) -> bool:
    return sorted(a or []) == sorted(b or [])


def _default_render_mode_for_path(path: str) -> str:
    """Mirror the default render_mode add_track_for_request applies when the
    request omits it. Annotation by default for UCSC API, BED, and bigBed paths;
    signal for bigWig and other formats."""
    raw = path or ""
    if raw.startswith("ucsc://"):
        return "annotation"
    lower = raw.lower()
    if lower.endswith(".bed") or lower.endswith(".bed.gz"):
        return "annotation"
    if lower.endswith(".bb") or lower.endswith(".bigbed"):
        return "annotation"
    return "signal"


def _find_existing_track_index(
    state,
    *,
    path: str,
    filter_names: Optional[str] = None,
    category: Optional[str] = None,
    render_mode: Optional[str] = None,
) -> Optional[int]:
    requested_filters = _parse_filter_names(filter_names)
    requested_category = category or None
    # When the client omits render_mode, infer the format-derived default so a
    # bigWig add doesn't collide with an existing annotation entry at the same
    # path (and vice versa).
    effective_render_mode = render_mode or _default_render_mode_for_path(path)
    for idx, track in enumerate(state.orthogonal_tracks):
        if track.get("path") != path:
            continue
        if (track.get("category") or None) != requested_category:
            continue
        if track.get("render_mode", "signal") != effective_render_mode:
            continue
        if not _same_filter_names(track.get("filter_names"), requested_filters):
            continue
        return idx
    return None


def _track_list_entry(index: int, track: dict) -> dict:
    entry = {
        "index": index,
        "label": track["label"],
        "path": track["path"],
        "render_mode": track.get("render_mode", "signal"),
        "format": track.get("format", "bigWig"),
        "category": track.get("category"),
        # Lets the browser reuse a loaded track only for the same selection.
        "filter_names": list(track.get("filter_names") or []),
    }
    if track.get("format") == "custom_motif":
        entry["motif_type"] = track.get("motif_type")
        entry["motif_name"] = track.get("motif_name")
        entry["motif_source"] = track.get("motif_source")
    return entry


def get_track_data_payload(state, track_idx: int, chrom: str, start: int, end: int, bins: int = 500) -> dict:
    if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
        return {"error": "Track not found", "values": []}

    track = state.orthogonal_tracks[track_idx]
    values = state.get_track_data(track_idx, chrom, start, end, bins)
    if values is None:
        return {
            "label": track["label"],
            "values": [],
            "render_mode": track.get("render_mode", "signal"),
        }

    return {
        "label": track["label"],
        "values": values,
        "render_mode": track.get("render_mode", "signal"),
    }


def get_track_annotations_payload(
    state,
    track_idx: int,
    chrom: str,
    start: int,
    end: int,
    filter_names: Optional[str] = None,
) -> dict:
    if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
        return {"error": "Track not found", "intervals": []}

    fn_list = None
    if filter_names:
        fn_list = [name.strip() for name in filter_names.split(",") if name.strip()]

    result = state.get_track_annotations(track_idx, chrom, start, end, filter_names=fn_list)
    if result is None:
        track = state.orthogonal_tracks[track_idx]
        return {
            "label": track["label"],
            "intervals": [],
            "track_type": track.get("track_type", ""),
        }
    return result


def get_tracks_batch_payload(state, body) -> dict:
    tracks_out = []
    annotation_filters = body.annotation_filters or {}
    for track_idx in body.track_indices:
        if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
            tracks_out.append({"index": track_idx, "error": "Track not found", "values": []})
            continue

        track = state.orthogonal_tracks[track_idx]
        render_mode = track.get("render_mode", "signal")
        if render_mode == "annotation":
            names = annotation_filters.get(track_idx) or annotation_filters.get(str(track_idx))
            result = state.get_track_annotations(
                track_idx,
                body.chrom,
                body.start,
                body.end,
                filter_names=names,
            )
            tracks_out.append({
                "index": track_idx,
                "label": (result or {}).get("label", track["label"]),
                "values": [],
                "intervals": (result or {}).get("intervals", []),
                "track_type": (result or {}).get("track_type", track.get("track_type", "")),
                "render_mode": "annotation",
            })
        else:
            values = state.get_track_data(track_idx, body.chrom, body.start, body.end, body.bins)
            tracks_out.append({
                "index": track_idx,
                "label": track["label"],
                "values": values if values is not None else [],
                "render_mode": render_mode,
            })
    return {"tracks": tracks_out}


def build_single_track_export_payload(
    state,
    *,
    track_idx: int,
    chrom: str,
    start: int,
    end: int,
    bins: int = 2000,
    format: str = "bedgraph",
) -> dict:
    if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
        return {"error": "Track not found", "status_code": 404}
    if end <= start:
        return {"error": "Invalid region", "status_code": 400}

    clamped_bins = clamp_export_bins(bins, end - start)
    track = state.orthogonal_tracks[track_idx]
    values = state.get_track_data(track_idx, chrom, start, end, clamped_bins)
    if values is None:
        values = [0.0] * clamped_bins

    export = build_single_track_export(
        chrom=chrom,
        start=start,
        end=end,
        bins=clamped_bins,
        values=values,
        label=track.get("label"),
        description=track.get("label"),
        format=format,
        fallback_label=f"track_{track_idx}",
    )
    return {"export": export}


def build_multi_track_export_payload(state, body) -> dict:
    if body.end <= body.start:
        return {"error": "Invalid region", "status_code": 400}

    bins = clamp_export_bins(body.bins, body.end - body.start)
    columns = []
    labels = []
    for index, track_idx in enumerate(body.track_indices):
        if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
            columns.append([0.0] * bins)
            labels.append(body.labels[index] if body.labels and index < len(body.labels) else f"track_{track_idx}")
            continue

        values = state.get_track_data(track_idx, body.chrom, body.start, body.end, bins)
        columns.append(values if values is not None else [0.0] * bins)
        track = state.orthogonal_tracks[track_idx]
        label = body.labels[index] if body.labels and index < len(body.labels) else track.get("label", f"track_{track_idx}")
        labels.append(label)

    export = build_multi_track_export(
        chrom=body.chrom,
        start=body.start,
        end=body.end,
        bins=bins,
        labels=labels,
        columns=columns,
    )
    return {"export": export}


def update_track_filter_for_request(state, track_idx: int, body: dict) -> dict:
    if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
        return {"success": False, "message": "Track not found"}
    names = body.get("filter_names", None)
    if names is not None and len(names) == 0:
        names = None
    state.orthogonal_tracks[track_idx]["filter_names"] = names
    return {"success": True, "filter_names": names}


def get_tracks_payload(state) -> dict:
    return {
        "tracks": [
            _track_list_entry(index, track)
            for index, track in enumerate(state.orthogonal_tracks)
        ]
    }


def reorder_tracks_for_request(state, body: dict) -> dict:
    from_idx = body.get("from_index", -1)
    to_idx = body.get("to_index", -1)
    n_tracks = len(state.orthogonal_tracks)
    if from_idx < 0 or from_idx >= n_tracks or to_idx < 0 or to_idx >= n_tracks:
        return {"success": False, "message": "Invalid index"}

    track = state.orthogonal_tracks.pop(from_idx)
    state.orthogonal_tracks.insert(to_idx, track)
    return {"success": True, "message": "Tracks reordered"}


def remove_track_for_request(state, track_idx: int) -> dict:
    if track_idx < 0 or track_idx >= len(state.orthogonal_tracks):
        return {"success": False, "message": "Track not found"}

    removed = state.orthogonal_tracks.pop(track_idx)
    catalog_index = removed.get("_catalog_index")
    loaded = getattr(state, "_catalog_loaded_tracks", None)
    if catalog_index is not None and loaded is not None and not any(
        track.get("_catalog_index") == catalog_index for track in state.orthogonal_tracks
    ):
        # The catalog can load it again.
        loaded.discard(catalog_index)
    return {
        "success": True,
        "message": f"Removed track: {removed['label']}",
    }


def _held_url(path):
    """A pre-signed URL's display form -> the full URL this server holds (services/signed_urls.py);
    a pre-signed URL given in full is held so responses show its display form."""
    from services import signed_urls
    from services.session_links import shared_server
    # A shared (public or lab) server holds everyone's links in one process: a
    # display form is never turned back into someone's signed URL there.
    if not isinstance(path, str) or shared_server():
        return path
    if signed_urls.looks_signed(path):
        return signed_urls.register(path)
    return signed_urls.resolve(path)


def add_track_for_request(
    state,
    *,
    path: str,
    label: Optional[str] = None,
    render_mode: Optional[str] = None,
    track_type: Optional[str] = None,
    ucsc_genome: Optional[str] = None,
    ucsc_track: Optional[str] = None,
    filter_names: Optional[str] = None,
    category: Optional[str] = None,
) -> dict:
    """Add an orthogonal bigWig, bigBed, BED, or UCSC API-backed track."""
    path = _held_url(path)
    original_path = path
    if path and not is_url(path) and not path.startswith("ucsc://"):
        path = normalize_local_path(path)

    existing_idx = _find_existing_track_index(
        state,
        path=path,
        filter_names=filter_names,
        category=category,
        render_mode=render_mode,
    )
    if existing_idx is not None:
        existing = state.orthogonal_tracks[existing_idx]
        return {
            "success": True,
            "message": f"Track already loaded: {existing['label']}",
            "track_index": existing_idx,
            "label": existing["label"],
            "render_mode": existing.get("render_mode", "signal"),
        }

    if path.startswith("ucsc://"):
        parts = path.replace("ucsc://", "").split("/", 1)
        if len(parts) != 2:
            return {"success": False, "message": "Invalid UCSC API path format"}
        genome = ucsc_genome or parts[0]
        track_name = ucsc_track or parts[1]
        track_label = label or track_name
        track_dict = {
            "path": path,
            "label": track_label,
            "format": "ucsc_api",
            "ucsc_genome": genome,
            "ucsc_track": track_name,
            "track_type": track_type or "bed",
            "render_mode": render_mode or "annotation",
        }
        # Stored like the other formats' filters: annotation fetches apply it,
        # and a repeat add with the same filter finds this track.
        requested_filters = _parse_filter_names(filter_names)
        if requested_filters:
            track_dict["filter_names"] = requested_filters
        if category:
            track_dict["category"] = category
        state.orthogonal_tracks.append(track_dict)
        return {
            "success": True,
            "message": f"Added track: {track_label} (UCSC API)",
            "track_index": len(state.orthogonal_tracks) - 1,
            "label": track_label,
            "render_mode": render_mode or "annotation",
        }

    if not is_url(path):
        # An online-only (cloud placeholder, or an iCloud stub in its place): say so
        # instead of an empty track or "not found".
        from services.cloud_placeholders import availability, unavailable_message
        if availability(path) == "cloud":
            return {"success": False, "message": unavailable_message(path)}

    if not is_url(path) and not os.path.isfile(path):
        return {
            "success": False,
            "message": path_access_error(path, original_path=original_path, expected="file") or f"File not found: {path}",
        }

    lower_path = path.lower()
    if not is_url(path) and (lower_path.endswith(".bed") or lower_path.endswith(".bed.gz")):
        try:
            bed_intervals = parse_bed_file(path)
            total = sum(len(intervals) for intervals in bed_intervals.values())
            basename = os.path.basename(path)
            for ext in (".bed.gz", ".bed"):
                if basename.lower().endswith(ext):
                    basename = basename[:-len(ext)]
                    break
            track_label = label or basename
            track_dict = {
                "path": path,
                "label": track_label,
                "format": "bed",
                "render_mode": render_mode or "annotation",
                "bed_intervals": bed_intervals,
            }
            if filter_names:
                track_dict["filter_names"] = [name.strip() for name in filter_names.split(",") if name.strip()]
            if category:
                track_dict["category"] = category
            state.orthogonal_tracks.append(track_dict)
            result = {
                "success": True,
                "message": f"Added track: {track_label} (BED, {total} intervals)",
                "track_index": len(state.orthogonal_tracks) - 1,
                "label": track_label,
                "render_mode": render_mode or "annotation",
            }
            # Added, but a BED for another assembly than the main genome says so (audit L11).
            return _with_reference_warning(state, result, os.path.basename(path), {
                chrom: {"weight": len(ivs), "ends": [iv["end"] for iv in ivs]}
                for chrom, ivs in bed_intervals.items()})
        except Exception as exc:
            return {"success": False, "message": f"Cannot parse BED file: {exc}"}

    track_format = "bigWig"
    if is_url(path) and path.startswith(("http://", "https://")):
        # A refused or missing file fails here: pyBigWig can wait forever on an
        # empty error reply (and holds the GIL meanwhile).
        from services.signed_urls import access_error_hint, probe_status
        status = probe_status(path)
        if status in (401, 403):
            _broken_url_cache[path] = time.time()
            return {"success": False, "message": access_error_hint(path) or f"Access denied (HTTP {status})",
                    "link_expired": True}
        if status == 404:
            _broken_url_cache[path] = time.time()
            return {"success": False, "message": f"Cannot read file: not found (HTTP 404)"}
    try:
        from services.remote_sources.opening import open_bigwig
        with open_bigwig(path) as bw:
            if bw is None:
                return {"success": False, "message": "Not a valid bigWig/bigBed file"}
            if bw.isBigBed():
                track_format = "bigBed"
            file_chroms = dict(bw.chroms() or {})
    except Exception as exc:
        if is_url(path):
            _broken_url_cache[path] = time.time()
            from services.signed_urls import access_error_hint
            hint = access_error_hint(path)
            if hint:
                return {"success": False, "message": hint, "link_expired": True}
        return {"success": False, "message": f"Cannot read file: {exc}"}

    basename = os.path.basename(urllib.parse.urlparse(path).path if is_url(path) else path)
    for ext in (".bw", ".bigwig", ".bigWig", ".bb", ".bigbed", ".bigBed"):
        basename = basename.replace(ext, "")
    track_label = label or basename
    rm = render_mode or ("annotation" if track_format == "bigBed" else "signal")

    track_dict = {
        "path": path,
        "label": track_label,
        "format": track_format,
        "render_mode": rm,
    }
    if filter_names:
        track_dict["filter_names"] = [name.strip() for name in filter_names.split(",") if name.strip()]
    if category:
        track_dict["category"] = category
    state.orthogonal_tracks.append(track_dict)

    result = {
        "success": True,
        "message": f"Added track: {track_label} ({track_format})",
        "track_index": len(state.orthogonal_tracks) - 1,
        "label": track_label,
        "render_mode": rm,
    }
    from services.supported_files import display_name
    return _with_reference_warning(state, result, display_name(path), {
        chrom: {"weight": int(size), "size": int(size)} for chrom, size in file_chroms.items()})


def _with_reference_warning(state, result: dict, name: str, contigs: dict) -> dict:
    """``result`` with a ``warning`` when the track's chromosomes are not the main genome's."""
    try:
        from services.panel_genomes import track_reference_warning
        warning = track_reference_warning(state, name, contigs)
    except Exception:
        warning = None  # a check, never a reason to fail the add
    if warning:
        result["warning"] = warning
    return result


def add_motif_sequence_track_for_request(state, req) -> dict:
    """Add a custom motif track from an IUPAC consensus sequence."""
    seq = req.sequence.strip().upper()
    if len(seq) < 3:
        return {"success": False, "message": "Sequence must be at least 3 characters"}
    if not re.match(r"^[ACGTRYSSWKMBDHVN]+$", seq):
        return {"success": False, "message": "Invalid characters. Use IUPAC DNA codes (A,C,G,T,R,Y,S,W,K,M,B,D,H,V,N)"}

    try:
        counts = motif_service.consensus_to_pwm(seq)
        pssm = motif_service.pwm_to_pssm(counts)
    except Exception as exc:
        return {"success": False, "message": f"Failed to build motif: {exc}"}

    track_label = req.label or seq
    track = {
        "path": f"motif://sequence/{seq}",
        "label": track_label,
        "format": "custom_motif",
        "render_mode": "annotation",
        "category": "motif",
        "motif_name": seq,
        "motif_type": "sequence",
        "counts": {base: [float(value) for value in counts[base]] for base in "ACGT"},
        "pssm": pssm,
        "threshold": req.threshold,
    }
    state.orthogonal_tracks.append(track)
    track_index = len(state.orthogonal_tracks) - 1
    return {
        "success": True,
        "track_index": track_index,
        "path": track["path"],
        "label": track_label,
        "motif_name": track["motif_name"],
        "motif_type": track["motif_type"],
        "message": f"Added motif track: {track_label}",
    }


def add_motif_pwm_track_for_request(state, req) -> dict:
    """Add a custom motif track from raw A/C/G/T PWM/count arrays."""
    name = (req.name or "").strip()
    if not name:
        return {"success": False, "message": "PWM motif name is required"}
    return _add_pwm_motif_track(
        state, name=name, counts=req.counts, label=req.label, threshold=req.threshold,
        path=f"motif://pwm/{urllib.parse.quote(name, safe='')}", source="custom PWM",
    )


def add_motif_jaspar_tracks_for_request(state, req) -> dict:
    """Add JASPAR matrices by ID as ordinary PWM motif tracks (offline, any genome)."""
    if not motif_service.check_pyjaspar():
        return {"success": False, "message": "JASPAR search needs the pyjaspar package: pip install pyjaspar"}
    tracks, missing = [], []
    for matrix_id in req.matrix_ids:
        entry = motif_service.jaspar_matrix(matrix_id)
        if entry is None:
            missing.append(matrix_id)
            continue
        result = _add_pwm_motif_track(
            state, name=entry["name"], counts=entry["counts"], threshold=req.threshold,
            label=f"{entry['name']} ({entry['matrix_id']})",
            path=f"motif://jaspar/{urllib.parse.quote(entry['matrix_id'], safe='')}",
            source=f"JASPAR2024 {entry['matrix_id']}",
        )
        if not result.get("success"):
            return result
        tracks.append(result)
    if not tracks:
        return {"success": False, "message": f"Unknown JASPAR matrix: {', '.join(missing)}"}
    message = f"Added {len(tracks)} JASPAR motif track{'s' if len(tracks) != 1 else ''}"
    if missing:
        message += f"; not found: {', '.join(missing)}"
    return {"success": True, "tracks": tracks, "message": message}


def _add_pwm_motif_track(state, *, name, counts, label, threshold, path, source) -> dict:
    try:
        counts = _normalize_pwm_counts(counts)
        pssm = motif_service.pwm_to_pssm(counts)
    except Exception as exc:
        return {"success": False, "message": f"Invalid PWM: {exc}"}

    track_label = label or name
    track = {
        "path": path,
        "label": track_label,
        "format": "custom_motif",
        "render_mode": "annotation",
        "category": "motif",
        "motif_name": name,
        "motif_type": "pwm",
        "motif_source": source,
        "counts": counts,
        "pssm": pssm,
        "threshold": threshold,
    }
    state.orthogonal_tracks.append(track)
    track_index = len(state.orthogonal_tracks) - 1
    return {
        "success": True,
        "track_index": track_index,
        "path": track["path"],
        "label": track_label,
        "motif_name": track["motif_name"],
        "motif_type": track["motif_type"],
        "motif_source": track["motif_source"],
        "message": f"Added PWM motif track: {track_label}",
    }


def add_motif_file_tracks_for_request(state, req) -> dict:
    """Add motif tracks from a motif database file."""
    file_path = req.file_path
    if not os.path.isfile(file_path):
        return {"success": False, "message": f"File not found: {file_path}"}

    fmt = req.format or "auto"
    if fmt == "auto":
        lower = file_path.lower()
        if lower.endswith(".meme"):
            fmt = "meme"
        elif lower.endswith(".homer") or lower.endswith(".motif"):
            fmt = "homer"
        else:
            fmt = "jaspar"

    try:
        if fmt == "meme":
            motifs = motif_service.parse_meme_file(file_path)
        elif fmt == "homer":
            motifs = motif_service.parse_homer_file(file_path)
        else:
            motifs = motif_service.parse_jaspar_file(file_path)
    except Exception as exc:
        return {"success": False, "message": f"Failed to parse motif file: {exc}"}

    if not motifs:
        return {"success": False, "message": "No motifs found in file"}

    basename = os.path.basename(file_path)
    loaded = []
    tracks = []
    for name, data in motifs.items():
        counts = data["counts"]
        if not all(base in counts for base in "ACGT"):
            continue
        try:
            pssm = motif_service.pwm_to_pssm(counts)
        except Exception as exc:
            print(f"  Warning: PSSM conversion failed for motif {name}: {exc}")
            continue
        track = {
            "path": f"motif://file/{basename}/{name}",
            "label": f"{name} ({basename})",
            "format": "custom_motif",
            "render_mode": "annotation",
            "category": "motif",
            "motif_name": name,
            "motif_type": "file",
            "motif_source": basename,
            "counts": {base: [float(value) for value in counts[base]] for base in "ACGT"},
            "pssm": pssm,
            "threshold": req.threshold,
        }
        state.orthogonal_tracks.append(track)
        track_index = len(state.orthogonal_tracks) - 1
        loaded.append(name)
        tracks.append(_motif_track_response(track_index, track))

    if not loaded:
        return {"success": False, "message": f"No usable motifs found in {basename}"}

    return {
        "success": True,
        "loaded": loaded,
        "tracks": tracks,
        "count": len(loaded),
        "message": f"Loaded {len(loaded)} motifs from {basename}",
    }
