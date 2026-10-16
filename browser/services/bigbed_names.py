"""BigBed/JASPAR TF-name discovery helpers for track filtering."""
from __future__ import annotations

import asyncio

import pyBigWig


GENOME_TO_TAX_GROUP: dict[str, str] = {
    "hg38": "vertebrates",
    "hg19": "vertebrates",
    "mm39": "vertebrates",
    "mm10": "vertebrates",
    "dm6": "insects",
    "dm3": "insects",
    "sacCer3": "fungi",
    "sacCer2": "fungi",
    "ce11": "nematodes",
    "danRer11": "vertebrates",
    "rn7": "vertebrates",
    "rn6": "vertebrates",
    "galGal6": "vertebrates",
    "xenTro10": "vertebrates",
}

JASPAR_API_BASE = "https://jaspar.elixir.no/api/v1"

_bigbed_names_cache: dict[str, dict] = {}


async def fetch_jaspar_api_names(tax_group: str) -> dict | None:
    """Query JASPAR REST API for all CORE TF names in a taxonomic group."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            all_results = []
            page = 1
            while True:
                resp = await client.get(
                    f"{JASPAR_API_BASE}/matrix/",
                    params={
                        "format": "json",
                        "collection": "CORE",
                        "tax_group": tax_group,
                        "page_size": 1000,
                        "page": page,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                all_results.extend(data.get("results", []))
                if not data.get("next"):
                    break
                page += 1

            name_to_ma: dict[str, set[str]] = {}
            for entry in all_results:
                tf_name = entry.get("name", "")
                matrix_id = entry.get("matrix_id", "")
                if tf_name:
                    name_to_ma.setdefault(tf_name, set())
                    if matrix_id:
                        name_to_ma[tf_name].add(matrix_id)
            names_list = sorted(name_to_ma.keys())
            ma_map = {tf_name: sorted(mas) for tf_name, mas in name_to_ma.items()}
            return {"success": True, "names": names_list, "name_to_ma": ma_map}
    except Exception:
        return None


def fetch_bigbed_names_sync(url: str, sample_size: int) -> dict:
    """Blocking fallback that samples a BigBed for MA codes and TF names."""
    # Open first: pyBigWig.open can return None, and `with None` fails
    # before the validity check below could run.
    try:
        from services.remote_sources.opening import open_bigwig
        bw = open_bigwig(url)
    except Exception as exc:
        return {"success": False, "names": [], "error": f"Could not open bigBed: {exc}"}
    if bw is None:
        return {"success": False, "names": [], "error": "Not a valid bigBed file"}
    try:
        if not bw.isBigBed():
            return {"success": False, "names": [], "error": "Not a valid bigBed file"}
        chroms = bw.chroms()
        if not chroms:
            return {"success": False, "names": [], "error": "No chromosomes found"}

        per_chrom = min(sample_size, 500_000)
        sorted_chroms = sorted(chroms.items(), key=lambda item: item[1], reverse=True)[:3]
        ma_codes: set[str] = set()
        name_to_ma: dict[str, set[str]] = {}
        has_tf_names = False
        for chrom_name, chrom_size in sorted_chroms:
            end = min(per_chrom, chrom_size)
            entries = bw.entries(chrom_name, 0, end)
            if not entries:
                continue
            for _start, _end, rest in entries:
                if not rest:
                    continue
                fields = rest.split("\t")
                matrix_id = fields[0] if fields else ""
                if matrix_id:
                    ma_codes.add(matrix_id)
                if len(fields) > 3 and fields[3]:
                    has_tf_names = True
                    tf_name = fields[3]
                    name_to_ma.setdefault(tf_name, set()).add(matrix_id)

    finally:
        bw.close()

    if has_tf_names:
        names_list = sorted(name_to_ma.keys())
        ma_map = {tf_name: sorted(mas) for tf_name, mas in name_to_ma.items()}
        return {"success": True, "names": names_list, "name_to_ma": ma_map}
    return {"success": True, "names": sorted(ma_codes)}


async def get_bigbed_names_payload(
    *,
    url: str,
    genome: str | None = None,
    sample_size: int = 500_000,
    disk_cache: dict,
    memory_cache: dict | None = None,
    jaspar_fetcher=fetch_jaspar_api_names,
    bigbed_fetcher=fetch_bigbed_names_sync,
) -> dict:
    """Get unique TF names using JASPAR API first, BigBed sampling as fallback."""
    cache = memory_cache if memory_cache is not None else _bigbed_names_cache
    cache_key = genome or url
    if cache_key in cache:
        return {**cache[cache_key], "cached": True}

    for key, cached in disk_cache.items():
        if key.endswith("_jaspar_names") and isinstance(cached, dict) and cached.get("url") == url:
            result = {"success": True, "names": cached.get("names", [])}
            if "name_to_ma" in cached:
                result["name_to_ma"] = cached["name_to_ma"]
            cache[cache_key] = result
            return {**result, "cached": True}

    if genome:
        tax_group = GENOME_TO_TAX_GROUP.get(genome)
        if tax_group:
            api_result = await jaspar_fetcher(tax_group)
            if api_result and api_result.get("success"):
                cache[cache_key] = api_result
                disk_cache[f"{genome}_jaspar_names"] = {
                    "url": url,
                    "names": api_result["names"],
                    "name_to_ma": api_result.get("name_to_ma", {}),
                }
                return api_result

    try:
        result = await asyncio.to_thread(bigbed_fetcher, url, sample_size)
        if result.get("success"):
            cache[cache_key] = result
            if genome:
                cache_data = {"url": url, "names": result["names"]}
                if "name_to_ma" in result:
                    cache_data["name_to_ma"] = result["name_to_ma"]
                disk_cache[f"{genome}_jaspar_names"] = cache_data
        return result
    except Exception as exc:
        return {"success": False, "names": [], "error": str(exc)}
