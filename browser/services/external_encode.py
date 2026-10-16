"""ENCODE external-track lookup helpers."""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request


GENOME_TO_ENCODE = {"hg38": "GRCh38", "hg19": "hg19", "mm10": "mm10", "dm6": "dm6"}
_encode_facet_cache: dict = {}
_encode_search_cache: dict = {}
_ENCODE_SEMAPHORE = None


def _get_encode_semaphore():
    global _ENCODE_SEMAPHORE
    if _ENCODE_SEMAPHORE is None:
        _ENCODE_SEMAPHORE = asyncio.Semaphore(5)
    return _ENCODE_SEMAPHORE


async def get_encode_facets_for_genome(genome: str, disk_cache: dict) -> dict:
    """Get available ENCODE facets for a browser genome id."""
    assembly = GENOME_TO_ENCODE.get(genome)
    if not assembly:
        return {"supported": False, "genome": genome}

    cache_key = genome
    now = time.time()
    if cache_key in _encode_facet_cache:
        cached_time, data = _encode_facet_cache[cache_key]
        if now - cached_time < 86400:
            return data

    disk_key = f"{genome}_encode_facets"
    if disk_key in disk_cache:
        cached = disk_cache[disk_key]
        _encode_facet_cache[cache_key] = (now, cached)
        return cached

    try:
        api_url = (
            f"https://www.encodeproject.org/search/?type=File&file_format=bigWig"
            f"&assembly={urllib.parse.quote(assembly)}&status=released"
            f"&format=json&limit=0"
        )
        req = urllib.request.Request(api_url, headers={
            "Accept": "application/json",
            "User-Agent": "FiberHMM-Browser/1.0",
        })
        async with _get_encode_semaphore():
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(
                None,
                lambda: json.loads(urllib.request.urlopen(req, timeout=20).read().decode()),
            )

        facets = raw.get("facets", [])
        result = {"supported": True, "genome": genome, "assays": [], "targets": [], "biosamples": []}
        for facet in facets:
            field = facet.get("field", "")
            terms = [
                {"key": term["key"], "count": term["doc_count"]}
                for term in facet.get("terms", [])
                if term.get("doc_count", 0) > 0
            ]
            if field == "assay_title":
                result["assays"] = terms
            elif field == "target.label":
                result["targets"] = terms[:100]
            elif field == "biosample_ontology.term_name":
                result["biosamples"] = terms[:100]

        _encode_facet_cache[cache_key] = (now, result)
        return result
    except Exception as exc:
        return {
            "supported": True,
            "genome": genome,
            "error": str(exc),
            "assays": [],
            "targets": [],
            "biosamples": [],
        }


async def search_encode_tracks(
    *,
    genome: str,
    assay: str = "",
    target: str = "",
    biosample: str = "",
    query: str = "",
    limit: int = 25,
) -> dict:
    """Search ENCODE for bigWig files matching filters."""
    assembly = GENOME_TO_ENCODE.get(genome)
    if not assembly:
        return {"supported": False, "genome": genome, "tracks": []}

    cache_key = f"{genome}:{assay}:{target}:{biosample}:{query}:{limit}"
    now = time.time()
    if cache_key in _encode_search_cache:
        cached_time, data = _encode_search_cache[cache_key]
        if now - cached_time < 3600:
            return data

    try:
        params = [
            "type=File",
            "file_format=bigWig",
            f"assembly={urllib.parse.quote(assembly)}",
            "status=released",
            "format=json",
            f"limit={limit}",
            "field=href&field=output_type&field=biological_replicates&field=file_size"
            "&field=dataset.@id&field=dataset.assay_title&field=dataset.target.label"
            "&field=dataset.biosample_ontology.term_name&field=dataset.description",
        ]
        if assay:
            params.append(f"assay_title={urllib.parse.quote(assay)}")
        if target:
            params.append(f"target.label={urllib.parse.quote(target)}")
        if biosample:
            params.append(f"biosample_ontology.term_name={urllib.parse.quote(biosample)}")
        if query:
            params.append(f"searchTerm={urllib.parse.quote(query)}")

        api_url = f"https://www.encodeproject.org/search/?{'&'.join(params)}"
        req = urllib.request.Request(api_url, headers={
            "Accept": "application/json",
            "User-Agent": "FiberHMM-Browser/1.0",
        })
        async with _get_encode_semaphore():
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(
                None,
                lambda: json.loads(urllib.request.urlopen(req, timeout=20).read().decode()),
            )

        tracks = []
        for item in raw.get("@graph", []):
            href = item.get("href", "")
            if not href:
                continue
            url = f"https://www.encodeproject.org{href}" if href.startswith("/") else href
            dataset = item.get("dataset", "")
            output_type = item.get("output_type", "")
            file_size = item.get("file_size", 0)

            dataset_obj = dataset if isinstance(dataset, dict) else {}
            ds_assay = dataset_obj.get("assay_title", "")
            ds_target_obj = dataset_obj.get("target", {})
            ds_target = ds_target_obj.get("label", "") if isinstance(ds_target_obj, dict) else ""
            ds_biosample_obj = dataset_obj.get("biosample_ontology", {})
            ds_biosample = ds_biosample_obj.get("term_name", "") if isinstance(ds_biosample_obj, dict) else ""
            accession = ""
            ds_id = dataset_obj.get("@id", "") if isinstance(dataset_obj, dict) else (
                dataset if isinstance(dataset, str) else ""
            )
            if isinstance(ds_id, str) and ds_id:
                id_parts = ds_id.strip("/").split("/")
                accession = id_parts[-1] if id_parts else ""

            final_target = ds_target or target
            final_assay = ds_assay or assay
            final_biosample = ds_biosample or biosample

            label_parts = []
            if final_target:
                label_parts.append(final_target)
            if final_biosample:
                label_parts.append(final_biosample)
            if output_type:
                label_parts.append(output_type)
            elif final_assay:
                label_parts.append(final_assay)
            if accession:
                label_parts.append(accession)
            label = " · ".join(label_parts) if label_parts else os.path.basename(href)

            tracks.append({
                "url": url,
                "label": label,
                "output_type": output_type,
                "dataset": accession,
                "file_size": file_size,
            })

        result = {"supported": True, "genome": genome, "tracks": tracks, "total": raw.get("total", len(tracks))}
        _encode_search_cache[cache_key] = (now, result)
        return result
    except Exception as exc:
        return {"supported": True, "genome": genome, "tracks": [], "error": str(exc)}
