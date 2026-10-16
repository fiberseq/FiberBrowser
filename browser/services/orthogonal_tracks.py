"""Orthogonal signal track loading and viewport query helpers."""
from __future__ import annotations

from services.bigbed_bounds import bigbed_entries_in_bounds
import json
import math
import os
import time
import urllib.parse
import urllib.request
from threading import Lock
from typing import Callable, Iterable, Optional

import numpy as np
import pyBigWig

from services.diagnostics import log_if_enabled
from utils.chrom import get_chrom_variants

TRACK_DIAGNOSTICS_ENV = "FIBERBROWSER_TRACK_DIAGNOSTICS"
QuerySegment = tuple[int, int, int]
CUSTOM_MOTIF_MAX_SCAN_BP = 2_000_000
CUSTOM_MOTIF_CACHE_TILE_BP = 250_000
CUSTOM_MOTIF_CACHE_MAX_ENTRIES = 256

CustomMotifIntervalRow = tuple[int, int, str, str, int]
from services.byte_cache import shared_cache
_custom_motif_annotation_cache = shared_cache('tracks')
_custom_motif_annotation_cache_lock = Lock()


def clear_custom_motif_annotation_cache() -> None:
    """Clear cached custom motif scan results.

    Tests call this directly. Runtime callers normally do not need to clear the
    cache because keys include the motif path, threshold, and PWM/count
    signature, and the cache is bounded.
    """
    with _custom_motif_annotation_cache_lock:
        _custom_motif_annotation_cache.clear()


def _custom_motif_signature(track: dict) -> tuple:
    counts = track.get("counts")
    if isinstance(counts, dict):
        signature = []
        for base in "ACGT":
            values = counts.get(base, [])
            try:
                signature.append(tuple(round(float(value), 6) for value in values))
            except (TypeError, ValueError):
                signature.append(())
        return tuple(signature)
    return (track.get("path"), track.get("motif_name"), track.get("motif_type"))


def _custom_motif_length(track: dict) -> int:
    """Motif width in bp (from its counts, or a sequence motif's name), for scan padding."""
    counts = track.get("counts")
    if isinstance(counts, dict):
        lengths = [len(v) for v in counts.values() if hasattr(v, "__len__")]
        if lengths:
            return max(lengths)
    pssm = track.get("pssm")
    length = getattr(pssm, "length", None)
    if isinstance(length, int) and length > 0:
        return length
    path = str(track.get("path") or "")
    if path.startswith("motif://sequence/"):
        return len(path.rsplit("/", 1)[-1])
    return 64


def _custom_motif_cache_window(start: int, end: int, chrom_length: Optional[int]) -> tuple[int, int]:
    width = max(1, end - start)
    tile_bp = max(CUSTOM_MOTIF_CACHE_TILE_BP, width)
    cache_start = (max(0, start) // tile_bp) * tile_bp
    cache_end = ((max(end, cache_start + 1) + tile_bp - 1) // tile_bp) * tile_bp
    if chrom_length is not None:
        cache_end = min(cache_end, chrom_length)
    if cache_end <= cache_start or cache_end - cache_start > CUSTOM_MOTIF_MAX_SCAN_BP:
        cache_start = max(0, start)
        cache_end = end if chrom_length is None else min(end, chrom_length)
    return cache_start, max(cache_start, cache_end)


def _custom_motif_interval_to_row(interval: dict) -> CustomMotifIntervalRow:
    return (
        int(interval.get("start", 0)),
        int(interval.get("end", 0)),
        str(interval.get("name", "")),
        str(interval.get("strand", "")),
        int(interval.get("score", 0)),
    )


def _custom_motif_row_to_interval(row: CustomMotifIntervalRow) -> dict:
    start, end, name, strand, score = row
    return {
        "start": start,
        "end": end,
        "name": name,
        "strand": strand,
        "score": score,
    }


def _reference_identity(fasta) -> object:
    """Which reference a FASTA handle reads: its file (with size and mtime), else the handle."""
    handles = getattr(fasta, "handles", None)
    if handles:
        # A collection of paired references: all its files identify it.
        return ("collection", tuple(_reference_identity(handle) for handle in handles))
    filename = getattr(fasta, "filename", None)
    if isinstance(filename, bytes):
        filename = filename.decode(errors="replace")
    if filename:
        try:
            st = os.stat(filename)
            return (str(filename), st.st_size, st.st_mtime_ns)
        except OSError:
            return str(filename)
    return ("references", tuple(getattr(fasta, "references", ()) or ()))


def _get_custom_motif_cache(key: tuple) -> Optional[tuple[CustomMotifIntervalRow, ...]]:
    with _custom_motif_annotation_cache_lock:
        cached = _custom_motif_annotation_cache.get(key)
        if cached is None:
            return None
        _custom_motif_annotation_cache.move_to_end(key)
        return cached


def _set_custom_motif_cache(key: tuple, intervals: list[dict]) -> None:
    rows = tuple(_custom_motif_interval_to_row(interval) for interval in intervals)
    with _custom_motif_annotation_cache_lock:
        _custom_motif_annotation_cache[key] = rows
        _custom_motif_annotation_cache.move_to_end(key)


def parse_bed_file(path: str) -> dict[str, list[dict]]:
    """Parse a plain BED file into chrom -> interval dicts."""
    from services.lab.paths import open_text
    intervals: dict[str, list[dict]] = {}
    with open_text(path) as handle:  # a lab server: inside its data roots, by descriptor
        for line in handle:
            if line.startswith("#") or line.startswith("track") or line.startswith("browser"):
                continue
            parts = line.strip().split("\t")
            if len(parts) < 3:
                continue
            chrom = parts[0]
            try:
                start, end = int(parts[1]), int(parts[2])
            except ValueError:
                continue
            interval = {"start": start, "end": end}
            if len(parts) > 3:
                interval["name"] = parts[3]
            if len(parts) > 4:
                try:
                    interval["score"] = int(parts[4])
                except ValueError:
                    pass
            if len(parts) > 5 and parts[5] in ("+", "-"):
                interval["strand"] = parts[5]
            intervals.setdefault(chrom, []).append(interval)
    return intervals


def load_orthogonal_tracks(tracks_file):
    """Load orthogonal track definitions from file.

    File format: one bigWig path per line, optionally with label:
    /path/to/track1.bw
    /path/to/track2.bw Label Name
    """
    if not tracks_file or not os.path.exists(tracks_file):
        return []

    log_if_enabled(TRACK_DIAGNOSTICS_ENV, f"Loading orthogonal tracks from {tracks_file}...")
    tracks = []

    with open(tracks_file, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split(None, 1)
            path = parts[0]
            label = (
                parts[1]
                if len(parts) > 1
                else os.path.basename(path).replace(".bw", "").replace(".bigWig", "")
            )

            if os.path.exists(path):
                tracks.append({"path": path, "label": label})
            else:
                log_if_enabled(TRACK_DIAGNOSTICS_ENV, f"  Warning: Track file not found: {path}")

    log_if_enabled(TRACK_DIAGNOSTICS_ENV, f"  Loaded {len(tracks)} tracks")
    return tracks


def _query_segments_or_default(start: int, end: int, query_segments: Optional[Iterable[QuerySegment]]) -> list[QuerySegment]:
    return list(query_segments) if query_segments is not None else [(start, end, 0)]


def _add_binned_interval(
    values: list[float],
    *,
    target_start: int,
    target_end: int,
    interval_start: int,
    interval_end: int,
) -> None:
    bins = len(values)
    if bins <= 0 or target_end <= target_start or interval_end <= interval_start:
        return
    bin_size = (target_end - target_start) / bins
    s = max(interval_start, target_start) - target_start
    e = min(interval_end, target_end) - target_start
    if e <= s:
        return
    # Half-open: the interval ends in the bin holding e - 1 (an interval ending
    # exactly on a bin boundary doesn't touch the next bin).
    b0 = max(0, int(s / bin_size))
    b1 = min(int(math.ceil(e / bin_size)), bins)
    for b in range(b0, b1):
        values[b] += 1.0


def _add_weighted_interval(
    weighted: list[float],
    covered: list[float],
    value: float,
    *,
    target_start: int,
    target_end: int,
    interval_start: int,
    interval_end: int,
) -> None:
    """Add value x overlapping bases (and the bases) to every bin the interval touches."""
    bins = len(weighted)
    if bins <= 0 or target_end <= target_start or interval_end <= interval_start:
        return
    bin_size = (target_end - target_start) / bins
    s = max(interval_start, target_start) - target_start
    e = min(interval_end, target_end) - target_start
    if e <= s:
        return
    b0 = max(0, int(s / bin_size))
    b1 = min(int(math.ceil(e / bin_size)), bins)
    for b in range(b0, b1):
        overlap = min(e, (b + 1) * bin_size) - max(s, b * bin_size)
        if overlap > 0:
            weighted[b] += value * overlap
            covered[b] += overlap


def _accumulate_resampled_signal(
    target: list[float],
    source_values: list[float],
    *,
    source_start: int,
    source_end: int,
    target_start: int,
    target_end: int,
) -> None:
    if not target or not source_values or source_end <= source_start or target_end <= target_start:
        return
    target_bin = (target_end - target_start) / len(target)
    source_bin = (source_end - source_start) / len(source_values)
    cleaned = [float(v or 0.0) for v in source_values]
    for i in range(len(target)):
        bin_start = target_start + i * target_bin
        bin_end = target_start + (i + 1) * target_bin
        overlap_start = max(bin_start, source_start)
        overlap_end = min(bin_end, source_end)
        if overlap_end <= overlap_start:
            continue
        s_idx = max(0, int((overlap_start - source_start) / source_bin))
        e_idx = min(len(cleaned), int(np.ceil((overlap_end - source_start) / source_bin)))
        if e_idx <= s_idx:
            e_idx = min(len(cleaned), s_idx + 1)
        value = sum(cleaned[s_idx:e_idx]) / max(1, e_idx - s_idx)
        target[i] += value * ((overlap_end - overlap_start) / target_bin)


def bin_bed_intervals(
    track: dict,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    query_segments: Optional[Iterable[QuerySegment]] = None,
) -> list[float]:
    """Bin in-memory BED intervals into coverage-like signal values."""
    bed_data = track.get("bed_intervals", {})
    chrom_ivs = bed_data.get(chrom, [])
    if not chrom_ivs:
        for variant in get_chrom_variants(chrom):
            if variant in bed_data:
                chrom_ivs = bed_data[variant]
                break

    values = [0.0] * bins
    for query_start, query_end, coord_shift in _query_segments_or_default(start, end, query_segments):
        for iv in chrom_ivs:
            if iv["end"] <= query_start or iv["start"] >= query_end:
                continue
            _add_binned_interval(
                values,
                target_start=start,
                target_end=end,
                interval_start=max(iv["start"], query_start) + coord_shift,
                interval_end=min(iv["end"], query_end) + coord_shift,
            )
    return values


def _matching_chrom_from_handle(handle, chrom: str) -> Optional[str]:
    chroms = handle.chroms()
    if chrom in chroms:
        return chrom
    for variant in get_chrom_variants(chrom):
        if variant in chroms:
            return variant
    return None


def get_track_data(
    track: dict,
    chrom: str,
    start: int,
    end: int,
    bins: int = 500,
    *,
    ucsc_signal_getter: Optional[Callable[..., Optional[list[float]]]] = None,
    query_segments: Optional[Iterable[QuerySegment]] = None,
) -> Optional[list[float]]:
    """Get binned signal data from one orthogonal track."""
    track_format = track.get("format", "bigWig")

    if track_format == "ucsc_api":
        if ucsc_signal_getter is None:
            return None
        if query_segments is None:
            return ucsc_signal_getter(track, chrom, start, end, bins)
        return ucsc_signal_getter(track, chrom, start, end, bins, query_segments=query_segments)

    if track_format == "custom_motif":
        return [0.0] * bins

    if track_format == "bed":
        return bin_bed_intervals(track, chrom, start, end, bins, query_segments=query_segments)

    try:
        from services.bigbed_handles import get_bigwig_handle

        bw = get_bigwig_handle(track["path"])
        if bw is None:
            return None
        matching_chrom = _matching_chrom_from_handle(bw, chrom)
        if matching_chrom is None:
            return None

        if track_format == "bigBed" or bw.isBigBed():
            values = [0.0] * bins
            for query_start, query_end, coord_shift in _query_segments_or_default(start, end, query_segments):
                entries = bigbed_entries_in_bounds(bw, matching_chrom, query_start, query_end)
                if entries:
                    for e_start, e_end, _rest in entries:
                        _add_binned_interval(
                            values,
                            target_start=start,
                            target_end=end,
                            interval_start=max(e_start, query_start) + coord_shift,
                            interval_end=min(e_end, query_end) + coord_shift,
                        )
            return values

        if query_segments is not None:
            values = [0.0] * bins
            for query_start, query_end, coord_shift in _query_segments_or_default(start, end, query_segments):
                logical_start = query_start + coord_shift
                logical_end = query_end + coord_shift
                segment_bins = max(1, int(np.ceil((logical_end - logical_start) / max(end - start, 1) * bins)))
                segment_values = bw.stats(matching_chrom, query_start, query_end, nBins=segment_bins, type="mean")
                _accumulate_resampled_signal(
                    values,
                    [v if v is not None else 0.0 for v in segment_values],
                    source_start=logical_start,
                    source_end=logical_end,
                    target_start=start,
                    target_end=end,
                )
            return values

        values = bw.stats(matching_chrom, start, end, nBins=bins, type="mean")
        return [v if v is not None else 0.0 for v in values]
    except Exception as e:
        print(f"Error reading track {track['label']}: {e}")
        return None


def get_ucsc_api_signal(
    track: dict,
    chrom: str,
    start: int,
    end: int,
    bins: int = 500,
    *,
    interval_fetcher: Callable[[dict, str, int, int], Optional[list[dict]]],
    query_segments: Optional[Iterable[QuerySegment]] = None,
) -> Optional[list[float]]:
    """Fetch UCSC getData intervals and convert them to binned signal.

    Intervals with a value (bedGraph/wiggle) give each bin the mean value over
    its covered bases, as bigWig stats do; plain intervals are counted.
    """
    values = [0.0] * bins
    weighted = [0.0] * bins
    covered = [0.0] * bins
    has_values = False
    for query_start, query_end, coord_shift in _query_segments_or_default(start, end, query_segments):
        intervals = interval_fetcher(track, chrom, query_start, query_end)
        if intervals is None:
            return None
        for iv in intervals:
            interval_start = max(iv["start"], query_start) + coord_shift
            interval_end = min(iv["end"], query_end) + coord_shift
            if "value" in iv:
                has_values = True
                _add_weighted_interval(
                    weighted, covered, iv["value"],
                    target_start=start, target_end=end,
                    interval_start=interval_start, interval_end=interval_end,
                )
                continue
            _add_binned_interval(
                values,
                target_start=start,
                target_end=end,
                interval_start=interval_start,
                interval_end=interval_end,
            )
    if has_values:
        for b in range(bins):
            if covered[b] > 0:
                values[b] += weighted[b] / covered[b]
    return values


def fetch_ucsc_api_intervals(
    track: dict,
    chrom: str,
    start: int,
    end: int,
    *,
    cache: dict,
    ttl: int,
) -> Optional[list[dict]]:
    """Fetch intervals from the UCSC getData REST API with caller-owned cache."""
    genome = track.get("ucsc_genome", "")
    ucsc_track = track.get("ucsc_track", "")
    if not genome or not ucsc_track:
        return None

    cache_key = f"{genome}:{ucsc_track}:{chrom}:{start}:{end}"
    now = time.time()
    if cache_key in cache:
        cached_time, data = cache[cache_key]
        if now - cached_time < ttl:
            return data

    try:
        api_url = (
            f"https://api.genome.ucsc.edu/getData/track?"
            f"genome={urllib.parse.quote(genome)}"
            f"&track={urllib.parse.quote(ucsc_track)}"
            f"&chrom={urllib.parse.quote(chrom)}"
            f"&start={start}&end={end}"
        )
        req = urllib.request.Request(api_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = json.loads(resp.read().decode())

        intervals = []
        track_data = raw.get(ucsc_track, raw.get(chrom, []))
        if isinstance(track_data, dict):
            track_data = track_data.get(chrom, [])
        if isinstance(track_data, list):
            for item in track_data:
                if not isinstance(item, dict):
                    continue
                iv = normalize_ucsc_interval(item, track.get("track_type", "bed"))
                if iv:
                    intervals.append(iv)

        cache[cache_key] = (now, intervals)
        return intervals
    except Exception as e:
        print(f"Error fetching UCSC API data for {ucsc_track}: {e}")
        return None


def normalize_ucsc_interval(item: dict, track_type: str = "bed") -> Optional[dict]:
    """Normalize UCSC REST field names to {start, end, name, strand, score, blocks}."""
    _ = track_type
    iv = {}
    if "chromStart" in item:
        iv["start"] = item["chromStart"]
        iv["end"] = item["chromEnd"]
    elif "txStart" in item:
        iv["start"] = item["txStart"]
        iv["end"] = item["txEnd"]
    elif "genoStart" in item:
        iv["start"] = item["genoStart"]
        iv["end"] = item["genoEnd"]
    elif "tStart" in item:
        iv["start"] = item["tStart"]
        iv["end"] = item["tEnd"]
    else:
        return None

    if "name2" in item:
        iv["name"] = item["name2"]
    elif "repName" in item:
        iv["name"] = f"{item['repName']} ({item.get('repClass', '')})"
    elif "name" in item:
        iv["name"] = item["name"]

    iv["strand"] = item.get("strand", "")

    if "score" in item:
        iv["score"] = item["score"]

    # bedGraph / wiggle signal: the interval's value (not just its presence).
    for key in ("dataValue", "value"):
        if key in item:
            try:
                value = float(item[key])
            except (TypeError, ValueError):
                break
            if math.isfinite(value):
                iv["value"] = value
            break

    if "exonStarts" in item and "exonEnds" in item:
        ex_starts = item["exonStarts"]
        ex_ends = item["exonEnds"]
        if isinstance(ex_starts, str):
            ex_starts = [int(x) for x in ex_starts.strip(",").split(",") if x]
        if isinstance(ex_ends, str):
            ex_ends = [int(x) for x in ex_ends.strip(",").split(",") if x]
        blocks = []
        for es, ee in zip(ex_starts, ex_ends):
            blocks.append({"start": es, "size": ee - es})
        iv["blocks"] = blocks
        if "cdsStart" in item and "cdsEnd" in item:
            iv["cdsStart"] = item["cdsStart"]
            iv["cdsEnd"] = item["cdsEnd"]

    return iv


def _filter_intervals_by_names(intervals: list[dict], filter_names) -> list[dict]:
    if not filter_names or not intervals:
        return intervals
    filter_lower = {n.lower() for n in filter_names}
    return [
        iv for iv in intervals
        if iv.get("name", "").lower() in filter_lower
        or iv.get("tf_name", "").lower() in filter_lower
    ]


def get_track_annotations(
    track: dict,
    chrom: str,
    start: int,
    end: int,
    *,
    filter_names=None,
    ucsc_interval_fetcher: Optional[Callable[[dict, str, int, int], Optional[list[dict]]]] = None,
    fasta=None,
    motif_scanner: Optional[Callable[[str, object, float], list[dict]]] = None,
) -> Optional[dict]:
    """Get annotation intervals for one orthogonal track."""
    track_format = track.get("format", "bigWig")
    active_filter = filter_names or track.get("filter_names")

    if track_format == "ucsc_api":
        if ucsc_interval_fetcher is None:
            return None
        intervals = ucsc_interval_fetcher(track, chrom, start, end)
        intervals = _filter_intervals_by_names(intervals or [], active_filter)
        return {
            "label": track["label"],
            "intervals": intervals,
            "track_type": track.get("track_type", "bed"),
        }

    if track_format == "bed":
        bed_data = track.get("bed_intervals", {})
        chrom_ivs = bed_data.get(chrom, [])
        if not chrom_ivs:
            for variant in get_chrom_variants(chrom):
                if variant in bed_data:
                    chrom_ivs = bed_data[variant]
                    break
        intervals = [iv for iv in chrom_ivs if iv["start"] < end and iv["end"] > start]
        intervals = _filter_intervals_by_names(intervals, active_filter)
        return {
            "label": track["label"],
            "intervals": intervals,
            "track_type": "bed",
        }

    if track_format == "custom_motif":
        if fasta is None:
            return {
                "label": track["label"],
                "intervals": [],
                "track_type": "custom_motif",
                "message": "No reference FASTA loaded",
            }
        if end - start > CUSTOM_MOTIF_MAX_SCAN_BP:
            return {
                "label": track["label"],
                "intervals": [],
                "track_type": "custom_motif",
                "message": "Zoom in below 2 MB to see motif hits",
            }

        from utils.chrom import resolve_reference_name

        # The FASTA's own name (chr prefix, chrM/MT, roman numerals).
        fasta_chrom = resolve_reference_name(chrom, fasta.references)
        if fasta_chrom is None:
            return {"label": track["label"], "intervals": [], "track_type": "custom_motif"}

        try:
            chrom_length = None
            if hasattr(fasta, "get_reference_length"):
                try:
                    chrom_length = int(fasta.get_reference_length(fasta_chrom))
                except Exception:
                    chrom_length = None
            cache_start, cache_end = _custom_motif_cache_window(start, end, chrom_length)
            pssm = track["pssm"]
            threshold = float(track.get("threshold", 0.85))
            cache_key = (
                track.get("path"),
                track.get("label"),
                _custom_motif_signature(track),
                # The reference: another genome with the same chromosome name
                # must not get this one's hits.
                _reference_identity(fasta),
                chrom_length,
                fasta_chrom,
                cache_start,
                cache_end,
                threshold,
            )
            interval_rows = _get_custom_motif_cache(cache_key)
            if interval_rows is None:
                # Scan past the tile edges by a motif length, so a hit straddling
                # two tiles is found whichever tile the view falls in.
                pad = _custom_motif_length(track)
                scan_start = max(0, cache_start - pad)
                scan_end = cache_end + pad if chrom_length is None else min(chrom_length, cache_end + pad)
                seq = fasta.fetch(fasta_chrom, scan_start, scan_end).upper()
                hits = motif_scanner(seq, pssm, threshold) if motif_scanner else []
                intervals = []
                for h in hits:
                    hit_start, hit_end = scan_start + h["start"], scan_start + h["end"]
                    if hit_end <= cache_start or hit_start >= cache_end:
                        continue  # wholly outside this tile: another tile's
                    intervals.append({
                        "start": hit_start,
                        "end": hit_end,
                        "name": track.get("motif_name", track["label"]),
                        "strand": h.get("strand", ""),
                        "score": int(h.get("rel_score", 0) * 1000),
                    })
                _set_custom_motif_cache(cache_key, intervals)
                interval_rows = tuple(_custom_motif_interval_to_row(iv) for iv in intervals)
            visible_intervals = [
                _custom_motif_row_to_interval(row)
                for row in interval_rows
                if row[0] < end and row[1] > start
            ]
            return {
                "label": track["label"],
                "intervals": visible_intervals,
                "track_type": "custom_motif",
            }
        except Exception as e:
            print(f"Error scanning custom_motif {track['label']}: {e}")
            return {"label": track["label"], "intervals": [], "track_type": "custom_motif"}

    if track_format == "bigBed":
        try:
            from services.bigbed_handles import get_bigwig_handle

            bw = get_bigwig_handle(track["path"])
            if bw is None:
                return {"label": track["label"], "intervals": [], "track_type": "bigBed"}
            matching_chrom = _matching_chrom_from_handle(bw, chrom)
            if matching_chrom is None:
                return {"label": track["label"], "intervals": [], "track_type": "bigBed"}

            entries = bigbed_entries_in_bounds(bw, matching_chrom, start, end)
            intervals = []
            if entries:
                for e_start, e_end, rest in entries:
                    fields = rest.split("\t") if rest else []
                    iv = {"start": e_start, "end": e_end}
                    if len(fields) > 0:
                        iv["name"] = fields[0]
                    if len(fields) > 3:
                        iv["tf_name"] = fields[3]
                    if len(fields) > 2:
                        iv["strand"] = fields[2] if fields[2] in ("+", "-") else ""
                    if len(fields) > 1:
                        try:
                            iv["score"] = int(fields[1])
                        except (ValueError, IndexError):
                            pass
                    intervals.append(iv)
            intervals = _filter_intervals_by_names(intervals, active_filter)
            return {
                "label": track["label"],
                "intervals": intervals,
                "track_type": "bigBed",
            }
        except Exception as e:
            print(f"Error reading bigBed annotations {track['label']}: {e}")
            return {"label": track["label"], "intervals": [], "track_type": "bigBed"}

    return None
