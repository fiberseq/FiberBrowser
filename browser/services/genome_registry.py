"""Curated online genome metadata used by the browser registry."""
from __future__ import annotations

import os


# FASTA URLs are from IGV genome configs and UCSC bigZips. UCSC serves
# many assemblies as .fa.gz only; the server downloader decompresses these
# into plain .fa files before indexing.
GENOME_REGISTRY = {
    'hg38': {
        'name': 'Human (GRCh38/hg38)',
        'fasta_urls': [
            'https://igv.org/genomes/data/hg38/hg38.fa',
            'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.fa',
        ],
        'fai_urls': [
            'https://igv.org/genomes/data/hg38/hg38.fa.fai',
        ],
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_46/gencode.v46.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE v46 Basic',
    },
    'hg19': {
        'name': 'Human (GRCh37/hg19)',
        'fasta_urls': [
            'https://igv.org/genomes/data/hg19/hg19.fasta',
            'https://hgdownload.soe.ucsc.edu/goldenPath/hg19/bigZips/hg19.fa',
        ],
        'fai_urls': [
            'https://igv.org/genomes/data/hg19/hg19.fasta.fai',
        ],
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_46/GRCh37_mapping/gencode.v46lift37.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE v46 lift37',
    },
    'mm39': {
        'name': 'Mouse (GRCm39/mm39)',
        'fasta_urls': [
            'https://hgdownload.soe.ucsc.edu/goldenPath/mm39/bigZips/mm39.fa.gz',
        ],
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M35/gencode.vM35.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE vM35 Basic',
    },
    'mm10': {
        'name': 'Mouse (GRCm38/mm10)',
        'fasta_urls': [
            'https://hgdownload.soe.ucsc.edu/goldenPath/mm10/bigZips/mm10.fa.gz',
        ],
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M25/gencode.vM25.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE vM25 Basic',
    },
    'dm6': {
        'name': 'D. melanogaster (dm6)',
        'fasta_urls': [
            'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa',
            'https://hgdownload.soe.ucsc.edu/goldenPath/dm6/bigZips/dm6.fa',
        ],
        'fai_urls': [
            'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa.fai',
        ],
        'gtf_url': 'https://ftp.ensembl.org/pub/release-113/gtf/drosophila_melanogaster/Drosophila_melanogaster.BDGP6.46.113.gtf.gz',
        'gtf_label': 'Ensembl r113',
    },
    'sacCer3': {
        'name': 'S. cerevisiae (sacCer3)',
        'fasta_urls': [
            'https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/sacCer3.fa.gz',
        ],
        'gtf_url': 'https://ftp.ensembl.org/pub/release-113/gtf/saccharomyces_cerevisiae/Saccharomyces_cerevisiae.R64-1-1.113.gtf.gz',
        'gtf_label': 'Ensembl r113',
    },
}


def list_genomes(registry: dict | None = None) -> list[dict]:
    """Return public genome metadata for selector endpoints."""
    registry = GENOME_REGISTRY if registry is None else registry
    return [
        {
            "id": genome_id,
            "name": info["name"],
            "gtf_label": info.get("gtf_label", ""),
        }
        for genome_id, info in registry.items()
    ]


def get_default_initial_position(
    chroms: list | tuple | None,
    fallback_chroms: list | tuple | None = None,
    *,
    window: int = 10000,
) -> dict | None:
    """Return a stable fallback viewport from available chromosome metadata."""
    available_chroms = chroms if chroms else fallback_chroms
    if not available_chroms:
        return None

    first_chrom = available_chroms[0]
    chrom_size = getattr(first_chrom, "size", getattr(first_chrom, "length", 1000000))
    center = min(int(chrom_size) // 2, 500000)
    return {
        "chrom": first_chrom.name,
        "start": max(0, center - window // 2),
        "end": center + window // 2,
        "gene_name": "",
    }


def get_genome_cache_status(
    *,
    registry: dict | None = None,
    disk_cache=None,
    genome_dir: str | None = None,
    cache_dir: str | None = None,
) -> dict:
    """Return cached metadata/file status for each registered genome."""
    registry = GENOME_REGISTRY if registry is None else registry
    disk_cache = disk_cache or {}
    genome_dir = genome_dir or os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")
    cache_dir = cache_dir or os.path.join(os.path.expanduser("~"), ".fiberhmm", "cache")

    status = {}
    for genome_id, info in registry.items():
        fasta_urls = list(info.get("fasta_urls") or [])
        fasta_url = info.get("fasta_url")
        if fasta_url and fasta_url not in fasta_urls:
            fasta_urls.insert(0, fasta_url)
        fasta_basename = os.path.basename(fasta_urls[0].split("?")[0]) if fasta_urls else None
        if fasta_basename and fasta_basename.endswith(".gz"):
            fasta_basename = fasta_basename[:-3]
        status[genome_id] = {
            "jaspar_names": f"{genome_id}_jaspar_names" in disk_cache,
            "ucsc_tracks": f"{genome_id}_ucsc_tracks" in disk_cache,
            "encode_facets": f"{genome_id}_encode_facets" in disk_cache,
            "fasta": bool(fasta_basename and os.path.exists(os.path.join(genome_dir, fasta_basename))),
            "gtf": os.path.exists(os.path.join(genome_dir, f"{genome_id}.gtf")),
        }

    return {"cache_dir": cache_dir, "genome_dir": genome_dir, "genomes": status}
