"""UCSC external-track catalog helpers and caches."""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request


UCSC_CURATED_TRACKS = {
    "hg38": [
        {
            "id": "phyloP100way",
            "label": "Conservation (phyloP 100-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/phyloP100way/hg38.phyloP100way.bw",
            "category": "Conservation",
            "description": "Basewise conservation scores across 100 vertebrates",
        },
        {
            "id": "phastCons100way",
            "label": "Conservation (phastCons 100-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/phastCons100way/hg38.phastCons100way.bw",
            "category": "Conservation",
            "description": "Basewise conservation probability across 100 vertebrates",
        },
        {
            "id": "gc5Base",
            "label": "GC Percent (5bp)",
            "url": "https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw",
            "category": "Mappability",
            "description": "GC content in 5bp windows",
        },
        {
            "id": "jaspar2026",
            "label": "JASPAR 2026 TFBS",
            "url": "https://mencius.uio.no/JASPAR/JASPAR_TFBSs/2026/JASPAR2026_hg38.bb",
            "category": "Motifs",
            "description": "Predicted TF binding sites (~900 JASPAR CORE profiles)",
            "render_mode": "annotation",
        },
    ],
    "hg19": [
        {
            "id": "phyloP100way",
            "label": "Conservation (phyloP 100-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/hg19/phyloP100way/hg19.100way.phyloP100way.bw",
            "category": "Conservation",
            "description": "Basewise conservation scores across 100 vertebrates",
        },
        {
            "id": "phastCons100way",
            "label": "Conservation (phastCons 100-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/hg19/phastCons100way/hg19.100way.phastCons100way.bw",
            "category": "Conservation",
            "description": "Basewise conservation probability across 100 vertebrates",
        },
        {
            "id": "gc5Base",
            "label": "GC Percent (5bp)",
            "url": "https://hgdownload.soe.ucsc.edu/gbdb/hg19/bbi/gc5BaseBw/gc5Base.bw",
            "category": "Mappability",
            "description": "GC content in 5bp windows",
        },
    ],
    "mm39": [
        {
            "id": "phyloP35way",
            "label": "Conservation (phyloP 35-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/phyloP35way/mm39.phyloP35way.bw",
            "category": "Conservation",
            "description": "Basewise conservation scores across 35 mammals",
        },
        {
            "id": "phastCons35way",
            "label": "Conservation (phastCons 35-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/phastCons35way/mm39.phastCons35way.bw",
            "category": "Conservation",
            "description": "Basewise conservation probability across 35 mammals",
        },
        {
            "id": "jaspar2026",
            "label": "JASPAR 2026 TFBS",
            "url": "https://mencius.uio.no/JASPAR/JASPAR_TFBSs/2026/JASPAR2026_mm39.bb",
            "category": "Motifs",
            "description": "Predicted TF binding sites (~900 JASPAR CORE profiles)",
            "render_mode": "annotation",
        },
    ],
    "mm10": [
        {
            "id": "phyloP60way",
            "label": "Conservation (phyloP 60-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/mm10/phyloP60way/mm10.60way.phyloP60way.bw",
            "category": "Conservation",
            "description": "Basewise conservation scores across 60 vertebrates",
        },
        {
            "id": "phastCons60way",
            "label": "Conservation (phastCons 60-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/mm10/phastCons60way/mm10.60way.phastCons60way.bw",
            "category": "Conservation",
            "description": "Basewise conservation probability across 60 vertebrates",
        },
    ],
    "dm6": [
        {
            "id": "phyloP124way",
            "label": "Conservation (phyloP 124-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/dm6/phyloP124way/dm6.phyloP124way.bw",
            "category": "Conservation",
            "description": "Basewise conservation scores across 124 insects",
        },
        {
            "id": "phastCons124way",
            "label": "Conservation (phastCons 124-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/dm6/phastCons124way/dm6.phastCons124way.bw",
            "category": "Conservation",
            "description": "Basewise conservation probability across 124 insects",
        },
        {
            "id": "jaspar2026",
            "label": "JASPAR 2026 TFBS",
            "url": "https://mencius.uio.no/JASPAR/JASPAR_TFBSs/2026/JASPAR2026_dm6.bb",
            "category": "Motifs",
            "description": "Predicted TF binding sites (~900 JASPAR CORE profiles)",
            "render_mode": "annotation",
        },
    ],
    "sacCer3": [
        {
            "id": "phyloP7way",
            "label": "Conservation (phyloP 7-way)",
            "url": "https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/phyloP7way/sacCer3.phyloP7way.bw",
            "category": "Conservation",
            "description": "Basewise conservation scores across 7 yeast species",
        },
        {
            "id": "jaspar2026",
            "label": "JASPAR 2026 TFBS",
            "url": "https://mencius.uio.no/JASPAR/JASPAR_TFBSs/2026/JASPAR2026_sacCer3.bb",
            "category": "Motifs",
            "description": "Predicted TF binding sites (~900 JASPAR CORE profiles)",
            "render_mode": "annotation",
        },
    ],
}


_disk_cache: dict = {}
_disk_cache_loaded = False


def _load_disk_caches() -> None:
    """Load shipped and user-maintained precached external-track metadata."""
    global _disk_cache_loaded
    if _disk_cache_loaded:
        return

    dirs = [
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"),
        os.path.join(os.path.expanduser("~"), ".fiberhmm", "cache"),
    ]
    for cache_dir in dirs:
        if not os.path.isdir(cache_dir):
            continue
        for filename in os.listdir(cache_dir):
            if not filename.endswith(".json"):
                continue
            key = filename[:-5]
            try:
                with open(os.path.join(cache_dir, filename)) as fh:
                    _disk_cache[key] = json.load(fh)
            except Exception as exc:
                print(f"  Warning: corrupt cache file {filename}: {exc}")
    if _disk_cache:
        print(f"  Loaded {len(_disk_cache)} disk cache entries")
    _disk_cache_loaded = True


def get_disk_cache() -> dict:
    _load_disk_caches()
    return _disk_cache

_ucsc_track_cache: dict = {}
_UCSC_CACHE_TTL = 3600

_url_validation_cache: dict = {}
_URL_VALIDATION_TTL = 86400

_broken_url_cache: dict = {}
_BROKEN_URL_TTL = 86400

_UCSC_API_TRACK_TYPES = {"bed", "genePred", "psl", "rmsk", "narrowPeak", "bedGraph", "bed4", "bed6", "bed8", "bed9", "bed12"}
_UCSC_ANNOTATION_TYPES = {
    "bed",
    "genePred",
    "psl",
    "rmsk",
    "narrowPeak",
    "bigBed",
    "bigGenePred",
    "bigPsl",
    "bigBarChart",
    "bigLolly",
    "bigDbSnp",
    "bigInteract",
    "bed4",
    "bed6",
    "bed8",
    "bed9",
    "bed12",
}
_UCSC_SIGNAL_TYPES = {"bigWig", "wig", "bedGraph"}

_ucsc_getdata_cache: dict = {}
_UCSC_GETDATA_TTL = 600

_UCSC_GROUP_LABELS = {
    "compGeno": "Conservation & Alignment",
    "regulation": "Regulation",
    "genes": "Genes",
    "varRep": "Variation & Repeats",
    "map": "Mapping & Sequencing",
    "rna": "RNA",
    "expression": "Expression",
    "phenDis": "Phenotype & Disease",
    "neandertal": "Ancient DNA",
    "denisova": "Ancient DNA",
    "x": "Experimental",
    "allChain": "Chain & Net",
    "chainNet": "Chain & Net",
    "pubs": "Publications",
    "encodeReg": "ENCODE Regulation",
    "rep": "Repeats",
    "user": "Custom Tracks",
}


def _validate_url_head(url: str) -> bool:
    """Check if a URL is accessible via HEAD request. Results are cached."""
    now = time.time()
    if url in _broken_url_cache:
        if now - _broken_url_cache[url] < _BROKEN_URL_TTL:
            return False
        del _broken_url_cache[url]

    if url in _url_validation_cache:
        cached_time, valid = _url_validation_cache[url]
        if now - cached_time < _URL_VALIDATION_TTL:
            return valid

    try:
        req = urllib.request.Request(url, method="HEAD")
        req.add_header("User-Agent", "FiberHMM-Browser/1.0")
        with urllib.request.urlopen(req, timeout=5) as resp:
            valid = resp.status == 200
    except Exception:
        valid = False
    _url_validation_cache[url] = (now, valid)
    return valid


def _make_absolute_url(genome: str, url: str) -> str:
    if url.startswith("/"):
        return f"https://hgdownload.soe.ucsc.edu{url}"
    if not url.startswith("http"):
        return f"https://hgdownload.soe.ucsc.edu/gbdb/{genome}/{url}"
    return url


def _extract_ucsc_tracks(raw_tracks, genome: str) -> tuple[list[dict], list[dict]]:
    loadable_tracks: list[dict] = []
    all_tracks: list[dict] = []

    def _extract_tracks(obj, group: str = "", dict_key: str = "") -> None:
        if not isinstance(obj, dict):
            return

        track_type = obj.get("type", "")
        track_id = obj.get("track", obj.get("table", "")) or dict_key
        track_label = obj.get("shortLabel", obj.get("track", "")) or dict_key
        track_desc = obj.get("longLabel", "")
        track_group = obj.get("group", group)
        base_type = track_type.split()[0] if track_type else ""

        big_data_url = ""
        loadable = False
        render_mode = "signal"
        track_format = "bigWig"

        if track_type.startswith("bigWig"):
            big_data_url = obj.get("bigDataUrl", "")
            if big_data_url:
                big_data_url = _make_absolute_url(genome, big_data_url)
                loadable = True
                track_format = "bigWig"
        elif (track_type.startswith("wig ") or track_type == "wig") and not track_type.startswith("wigMaf"):
            if track_id:
                url_candidates = [
                    f"https://hgdownload.soe.ucsc.edu/goldenPath/{genome}/{track_id}/{genome}.{track_id}.bw",
                ]
                match = re.match(r"(phastCons|phyloP)(\d+way)", track_id)
                if match:
                    metric, nway = match.groups()
                    url_candidates.append(
                        f"https://hgdownload.soe.ucsc.edu/goldenPath/{genome}/{track_id}/{genome}.{nway}.{metric}.bw"
                    )
                for candidate in url_candidates:
                    if _validate_url_head(candidate):
                        big_data_url = candidate
                        loadable = True
                        break
            track_format = "bigWig"
        elif (
            track_type.startswith("bigBed")
            or track_type.startswith("bigGenePred")
            or track_type.startswith("bigPsl")
            or track_type.startswith("bigBarChart")
            or track_type.startswith("bigLolly")
            or track_type.startswith("bigDbSnp")
            or track_type.startswith("bigInteract")
        ):
            big_data_url = obj.get("bigDataUrl", "")
            if big_data_url:
                big_data_url = _make_absolute_url(genome, big_data_url)
                loadable = True
                track_format = "bigBed"
                if base_type in _UCSC_ANNOTATION_TYPES:
                    render_mode = "annotation"
        elif base_type in _UCSC_API_TRACK_TYPES and not track_type.startswith("wigMaf"):
            if track_id:
                big_data_url = f"ucsc://{genome}/{track_id}"
                loadable = True
                track_format = "ucsc_api"
                render_mode = "annotation" if base_type in _UCSC_ANNOTATION_TYPES else "signal"

        if track_id and track_label:
            track_info = {
                "id": track_id,
                "label": track_label,
                "description": track_desc,
                "url": big_data_url,
                "type": base_type,
                "category": track_group,
                "loadable": loadable,
                "render_mode": render_mode,
                "track_format": track_format,
            }
            all_tracks.append(track_info)
            if loadable:
                loadable_tracks.append(track_info)

        for key, val in obj.items():
            if isinstance(val, dict):
                _extract_tracks(val, group=obj.get("group", group), dict_key=key)

    _extract_tracks(raw_tracks)
    return loadable_tracks, all_tracks


def _fetch_ucsc_tracks(genome: str) -> tuple[list[dict], list[dict]]:
    """Fetch and cache UCSC track data. Returns loadable and all tracks."""
    now = time.time()
    if genome in _ucsc_track_cache:
        cached_time, loadable_tracks, all_tracks = _ucsc_track_cache[genome]
        if now - cached_time < _UCSC_CACHE_TTL:
            return loadable_tracks, all_tracks

    disk_key = f"{genome}_ucsc_tracks"
    _load_disk_caches()
    if disk_key in _disk_cache:
        cached = _disk_cache[disk_key]
        loadable_tracks = cached.get("loadable", [])
        all_tracks = cached.get("all", [])
        _ucsc_track_cache[genome] = (now, loadable_tracks, all_tracks)
        return loadable_tracks, all_tracks

    api_url = f"https://api.genome.ucsc.edu/list/tracks?genome={urllib.parse.quote(genome)}"
    req = urllib.request.Request(api_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    loadable_tracks, all_tracks = _extract_ucsc_tracks(data.get(genome, data), genome)
    _ucsc_track_cache[genome] = (now, loadable_tracks, all_tracks)
    return loadable_tracks, all_tracks


def loaded_track_urls(state) -> set[str]:
    return {track["path"] for track in state.orthogonal_tracks}


def get_ucsc_curated_payload(genome: str, state) -> dict:
    loaded_urls = loaded_track_urls(state)
    tracks = [
        {
            **track,
            "loaded": track["url"] in loaded_urls,
            "render_mode": track.get("render_mode", "signal"),
        }
        for track in UCSC_CURATED_TRACKS.get(genome, [])
    ]
    return {"tracks": tracks, "genome": genome}


def search_ucsc_tracks_for_state(genome: str, query: str, state) -> dict:
    try:
        loadable_tracks, _ = _fetch_ucsc_tracks(genome)
    except Exception as exc:
        return {"tracks": [], "genome": genome, "error": f"Failed to query UCSC API: {exc}"}

    query_lower = query.lower().strip()
    if query_lower:
        filtered = [
            track for track in loadable_tracks
            if query_lower in track["label"].lower()
            or query_lower in track.get("description", "").lower()
            or query_lower in track.get("category", "").lower()
            or query_lower in track.get("id", "").lower()
        ]
    else:
        filtered = loadable_tracks

    loaded_urls = loaded_track_urls(state)
    tracks = [{**track, "loaded": track["url"] in loaded_urls} for track in filtered[:50]]
    return {"tracks": tracks, "genome": genome, "total": len(loadable_tracks)}


def browse_ucsc_tracks_for_state(genome: str, state) -> dict:
    try:
        loadable_tracks, all_tracks = _fetch_ucsc_tracks(genome)
    except Exception as exc:
        return {"groups": {}, "total": 0, "loadable_count": 0, "genome": genome, "error": str(exc)}

    loaded_urls = loaded_track_urls(state)
    groups: dict[str, list[dict]] = {}
    for track in all_tracks:
        raw_group = track.get("category", "") or "other"
        group_label = _UCSC_GROUP_LABELS.get(
            raw_group,
            raw_group.replace("_", " ").title() if raw_group else "Other",
        )
        groups.setdefault(group_label, []).append({
            **track,
            "loaded": track.get("url", "") in loaded_urls if track.get("loadable") else False,
        })

    sorted_groups = {}
    for key in sorted(groups.keys(), key=lambda k: -sum(1 for track in groups[k] if track.get("loadable"))):
        sorted_groups[key] = groups[key]

    return {
        "groups": sorted_groups,
        "total": len(all_tracks),
        "loadable_count": len(loadable_tracks),
        "genome": genome,
    }
