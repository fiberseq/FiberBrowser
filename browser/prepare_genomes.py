#!/usr/bin/env python3
"""Precache genome metadata and optionally download genome files for FiberHMM Browser.

Usage:
    python browser/prepare_genomes.py                          # cache metadata for all genomes
    python browser/prepare_genomes.py --genome hg38 dm6        # cache only specified genomes
    python browser/prepare_genomes.py --download               # also download FASTA/FAI/GTF
    python browser/prepare_genomes.py --download --genome dm6  # download only small genomes
    python browser/prepare_genomes.py --cache-dir browser/data # output to repo dir

Default cache output: ~/.fiberhmm/cache/
"""

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Registry data (duplicated from server.py for standalone use)
# ---------------------------------------------------------------------------

GENOME_REGISTRY = {
    'hg38': {
        'name': 'Human (GRCh38/hg38)',
        'fasta_url': 'https://igv.org/genomes/data/hg38/hg38.fa',
        'fai_url': 'https://igv.org/genomes/data/hg38/hg38.fa.fai',
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_46/gencode.v46.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE v46 Basic',
    },
    'hg19': {
        'name': 'Human (GRCh37/hg19)',
        'fasta_url': 'https://igv.org/genomes/data/hg19/hg19.fasta',
        'fai_url': 'https://igv.org/genomes/data/hg19/hg19.fasta.fai',
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_46/GRCh37_mapping/gencode.v46lift37.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE v46 lift37',
    },
    'mm39': {
        'name': 'Mouse (GRCm39/mm39)',
        'fasta_url': 'https://hgdownload.soe.ucsc.edu/goldenPath/mm39/bigZips/mm39.fa.gz',
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M35/gencode.vM35.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE vM35 Basic',
    },
    'mm10': {
        'name': 'Mouse (GRCm38/mm10)',
        'fasta_url': 'https://hgdownload.soe.ucsc.edu/goldenPath/mm10/bigZips/mm10.fa.gz',
        'gtf_url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M25/gencode.vM25.basic.annotation.gtf.gz',
        'gtf_label': 'GENCODE vM25 Basic',
    },
    'dm6': {
        'name': 'D. melanogaster (dm6)',
        'fasta_url': 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa',
        'fai_url': 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa.fai',
        'gtf_url': 'https://ftp.ensembl.org/pub/release-113/gtf/drosophila_melanogaster/Drosophila_melanogaster.BDGP6.46.113.gtf.gz',
        'gtf_label': 'Ensembl r113',
    },
    'sacCer3': {
        'name': 'S. cerevisiae (sacCer3)',
        'fasta_url': 'https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/sacCer3.fa.gz',
        'gtf_url': 'https://ftp.ensembl.org/pub/release-113/gtf/saccharomyces_cerevisiae/Saccharomyces_cerevisiae.R64-1-1.113.gtf.gz',
        'gtf_label': 'Ensembl r113',
    },
}

# JASPAR bigBed tracks per genome (only genomes that have JASPAR tracks)
JASPAR_TRACKS = {
    'hg38': {
        'label': 'JASPAR 2026 TFBS',
        'url': 'https://mencius.uio.no/JASPAR/JASPAR_familial_binding_sites/2026/hg38/JASPAR2026_hg38.bb',
    },
    'mm39': {
        'label': 'JASPAR 2026 TFBS',
        'url': 'https://mencius.uio.no/JASPAR/JASPAR_familial_binding_sites/2026/mm39/JASPAR2026_mm39.bb',
    },
    'dm6': {
        'label': 'JASPAR 2026 TFBS',
        'url': 'https://mencius.uio.no/JASPAR/JASPAR_familial_binding_sites/2026/dm6/JASPAR2026_dm6.bb',
    },
    'sacCer3': {
        'label': 'JASPAR 2026 TFBS',
        'url': 'https://mencius.uio.no/JASPAR/JASPAR_familial_binding_sites/2026/sacCer3/JASPAR2026_sacCer3.bb',
    },
}

_GENOME_TO_ENCODE = {'hg38': 'GRCh38', 'hg19': 'hg19', 'mm10': 'mm10', 'dm6': 'dm6'}


# ---------------------------------------------------------------------------
# Caching functions
# ---------------------------------------------------------------------------

def cache_jaspar_names(genome_id, cache_dir):
    """Extract all unique TF names from a JASPAR bigBed file."""
    if genome_id not in JASPAR_TRACKS:
        print(f"  [{genome_id}] No JASPAR track available, skipping.")
        return None

    try:
        import pyBigWig
    except ImportError:
        print(f"  [{genome_id}] pyBigWig not installed, skipping JASPAR names.")
        return None

    track_info = JASPAR_TRACKS[genome_id]
    url = track_info['url']
    print(f"  [{genome_id}] Extracting JASPAR names from {url}...")
    t0 = time.time()

    bw = None
    try:
        bw = pyBigWig.open(url)
        if bw is None or not bw.isBigBed():
            print(f"  [{genome_id}] Not a valid bigBed file, skipping.")
            return None

        chroms = bw.chroms()
        if not chroms:
            print(f"  [{genome_id}] No chromosomes found, skipping.")
            return None

        names = set()
        # Sample top 3 largest chromosomes — covers nearly all unique TF names
        # while being much faster than iterating the entire genome remotely
        sorted_chroms = sorted(chroms.items(), key=lambda x: x[1], reverse=True)
        sample_chroms = sorted_chroms[:3]
        for chrom_name, chrom_size in sample_chroms:
            try:
                print(f"    Scanning {chrom_name} ({chrom_size:,} bp)...")
                entries = bw.entries(chrom_name, 0, chrom_size)
                if entries:
                    for _, _, rest in entries:
                        if rest:
                            name = rest.split('\t')[0]
                            if name:
                                names.add(name)
            except Exception:
                continue

        elapsed = time.time() - t0
        sorted_names = sorted(names)
        data = {
            'names': sorted_names,
            'count': len(sorted_names),
            'url': url,
            'generated': time.strftime('%Y-%m-%d'),
        }

        out_path = os.path.join(cache_dir, f'{genome_id}_jaspar_names.json')
        with open(out_path, 'w') as f:
            json.dump(data, f, indent=1)

        size_kb = os.path.getsize(out_path) / 1024
        print(f"  [{genome_id}] JASPAR names: {len(sorted_names)} TFs found ({elapsed:.1f}s, {size_kb:.0f}KB)")
        return data

    except Exception as e:
        print(f"  [{genome_id}] Error extracting JASPAR names: {e}")
        return None
    finally:
        if bw is not None:
            bw.close()


def _validate_url_head(url):
    """Check if a URL is accessible via HEAD request."""
    try:
        req = urllib.request.Request(url, method='HEAD')
        req.add_header('User-Agent', 'FiberHMM-Browser/1.0')
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def cache_ucsc_tracks(genome_id, cache_dir):
    """Fetch and cache UCSC track list with loadability info."""
    print(f"  [{genome_id}] Fetching UCSC tracks...")
    t0 = time.time()

    api_url = f"https://api.genome.ucsc.edu/list/tracks?genome={urllib.parse.quote(genome_id)}"
    try:
        req = urllib.request.Request(api_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [{genome_id}] Error fetching UCSC tracks: {e}")
        return None

    loadable_tracks = []
    all_tracks = []
    raw_tracks = data.get(genome_id, data)

    _UCSC_API_TRACK_TYPES = {'bed', 'genePred', 'psl', 'rmsk', 'narrowPeak', 'bedGraph',
                              'bed4', 'bed6', 'bed8', 'bed9', 'bed12'}
    _UCSC_ANNOTATION_TYPES = {'bed', 'genePred', 'psl', 'rmsk', 'narrowPeak', 'bigBed',
                               'bigGenePred', 'bigPsl', 'bigBarChart', 'bigLolly',
                               'bigDbSnp', 'bigInteract', 'bed4', 'bed6', 'bed8', 'bed9', 'bed12'}

    def _make_absolute_url(url):
        if url.startswith('/'):
            return f"https://hgdownload.soe.ucsc.edu{url}"
        elif not url.startswith('http'):
            return f"https://hgdownload.soe.ucsc.edu/gbdb/{genome_id}/{url}"
        return url

    def _extract_tracks(obj, group="", dict_key=""):
        if isinstance(obj, dict):
            track_type = obj.get('type', '')
            track_id = obj.get('track', obj.get('table', '')) or dict_key
            track_label = obj.get('shortLabel', obj.get('track', '')) or dict_key
            track_desc = obj.get('longLabel', '')
            track_group = obj.get('group', group)
            base_type = track_type.split()[0] if track_type else ''

            big_data_url = ''
            loadable = False
            render_mode = 'signal'
            track_format = 'bigWig'

            if track_type.startswith('bigWig'):
                big_data_url = obj.get('bigDataUrl', '')
                if big_data_url:
                    big_data_url = _make_absolute_url(big_data_url)
                    loadable = True
                    track_format = 'bigWig'
            elif (track_type.startswith('wig ') or track_type == 'wig') and not track_type.startswith('wigMaf'):
                if track_id:
                    import re
                    url_candidates = [
                        f"https://hgdownload.soe.ucsc.edu/goldenPath/{genome_id}/{track_id}/{genome_id}.{track_id}.bw",
                    ]
                    m = re.match(r'(phastCons|phyloP)(\d+way)', track_id)
                    if m:
                        metric, nway = m.groups()
                        url_candidates.append(
                            f"https://hgdownload.soe.ucsc.edu/goldenPath/{genome_id}/{track_id}/{genome_id}.{nway}.{metric}.bw"
                        )
                    validated_url = None
                    for candidate in url_candidates:
                        if _validate_url_head(candidate):
                            validated_url = candidate
                            break
                    if validated_url:
                        big_data_url = validated_url
                        loadable = True
                    track_format = 'bigWig'
            elif any(track_type.startswith(t) for t in ('bigBed', 'bigGenePred', 'bigPsl', 'bigBarChart', 'bigLolly', 'bigDbSnp', 'bigInteract')):
                big_data_url = obj.get('bigDataUrl', '')
                if big_data_url:
                    big_data_url = _make_absolute_url(big_data_url)
                    loadable = True
                    track_format = 'bigBed'
                    if base_type in _UCSC_ANNOTATION_TYPES:
                        render_mode = 'annotation'
            elif base_type in _UCSC_API_TRACK_TYPES and not track_type.startswith('wigMaf'):
                if track_id:
                    big_data_url = f"ucsc://{genome_id}/{track_id}"
                    loadable = True
                    track_format = 'ucsc_api'
                    render_mode = 'annotation' if base_type in _UCSC_ANNOTATION_TYPES else 'signal'

            if track_id and track_label:
                track_info = {
                    'id': track_id,
                    'label': track_label,
                    'description': track_desc,
                    'url': big_data_url,
                    'type': base_type,
                    'category': track_group,
                    'loadable': loadable,
                    'render_mode': render_mode,
                    'track_format': track_format,
                }
                all_tracks.append(track_info)
                if loadable:
                    loadable_tracks.append(track_info)

            for key, val in obj.items():
                if isinstance(val, dict):
                    _extract_tracks(val, group=obj.get('group', group), dict_key=key)

    _extract_tracks(raw_tracks)

    elapsed = time.time() - t0
    result = {
        'loadable': loadable_tracks,
        'all': all_tracks,
        'loadable_count': len(loadable_tracks),
        'total_count': len(all_tracks),
        'generated': time.strftime('%Y-%m-%d'),
    }

    out_path = os.path.join(cache_dir, f'{genome_id}_ucsc_tracks.json')
    with open(out_path, 'w') as f:
        json.dump(result, f, indent=1)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"  [{genome_id}] UCSC tracks: {len(all_tracks)} tracks ({len(loadable_tracks)} loadable) ({elapsed:.1f}s, {size_kb:.0f}KB)")
    return result


def cache_encode_facets(genome_id, cache_dir):
    """Fetch and cache ENCODE facets for a genome."""
    assembly = _GENOME_TO_ENCODE.get(genome_id)
    if not assembly:
        return None

    print(f"  [{genome_id}] Fetching ENCODE facets...")
    t0 = time.time()

    try:
        api_url = (
            f"https://www.encodeproject.org/search/?type=File&file_format=bigWig"
            f"&assembly={urllib.parse.quote(assembly)}&status=released"
            f"&format=json&limit=0"
        )
        req = urllib.request.Request(api_url, headers={
            "Accept": "application/json",
            "User-Agent": "FiberHMM-Browser/1.0"
        })
        raw = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())

        facets = raw.get('facets', [])
        result = {
            'supported': True,
            'genome': genome_id,
            'assays': [],
            'targets': [],
            'biosamples': [],
            'generated': time.strftime('%Y-%m-%d'),
        }
        for f in facets:
            field = f.get('field', '')
            terms = [{'key': t['key'], 'count': t['doc_count']}
                     for t in f.get('terms', []) if t.get('doc_count', 0) > 0]
            if field == 'assay_title':
                result['assays'] = terms
            elif field == 'target.label':
                result['targets'] = terms[:100]
            elif field == 'biosample_ontology.term_name':
                result['biosamples'] = terms[:100]

        elapsed = time.time() - t0

        out_path = os.path.join(cache_dir, f'{genome_id}_encode_facets.json')
        with open(out_path, 'w') as f:
            json.dump(result, f, indent=1)

        size_kb = os.path.getsize(out_path) / 1024
        print(f"  [{genome_id}] ENCODE facets: {len(result['assays'])} assays, "
              f"{len(result['targets'])} targets ({elapsed:.1f}s, {size_kb:.0f}KB)")
        return result

    except Exception as e:
        print(f"  [{genome_id}] Error fetching ENCODE facets: {e}")
        return None


def download_genome_files(genome_id, genome_info, genome_dir):
    """Download the FASTA and GTF files for a genome, and index the FASTA locally."""
    os.makedirs(genome_dir, exist_ok=True)

    fasta_url = genome_info.get('fasta_url')
    basename = os.path.basename(fasta_url.split('?')[0]) if fasta_url else f'{genome_id}.fa'
    if basename.endswith('.gz'):
        basename = basename[:-3]

    local_fa = os.path.join(genome_dir, basename)
    local_fai = local_fa + '.fai'

    # The index is not downloaded: it is built from the FASTA below (a mirror's index can describe another file).

    # Download FASTA (large)
    if fasta_url and not os.path.exists(local_fa):
        print(f"  [{genome_id}] Downloading FASTA: {fasta_url}")
        print(f"  [{genome_id}] (this may take a while for large genomes)")
        try:
            def _progress(block_num, block_size, total_size):
                downloaded = block_num * block_size
                if total_size > 0:
                    pct = min(100, downloaded * 100 // total_size)
                    mb = downloaded / (1024 * 1024)
                    total_mb = total_size / (1024 * 1024)
                    if block_num % 500 == 0:
                        print(f"    {mb:.0f}/{total_mb:.0f} MB ({pct}%)")
                elif block_num % 2000 == 0:
                    mb = downloaded / (1024 * 1024)
                    print(f"    {mb:.0f} MB downloaded...")

            download_tmp = local_fa + '.download.tmp'
            _http_fetch(fasta_url, download_tmp, _progress)
            if fasta_url.split('?')[0].endswith('.gz'):
                print(f"  [{genome_id}] Decompressing FASTA...")
                with gzip.open(download_tmp, 'rb') as src, open(local_fa + '.tmp', 'wb') as dst:
                    shutil.copyfileobj(src, dst)
                os.remove(download_tmp)
            else:
                os.rename(download_tmp, local_fa + '.tmp')
            os.rename(local_fa + '.tmp', local_fa)
            size_mb = os.path.getsize(local_fa) / (1024 * 1024)
            print(f"  [{genome_id}] FASTA saved: {local_fa} ({size_mb:.0f} MB)")
        except Exception as e:
            print(f"  [{genome_id}] Error downloading FASTA: {e}")
            if os.path.exists(local_fa + '.tmp'):
                os.remove(local_fa + '.tmp')
            if os.path.exists(local_fa + '.download.tmp'):
                os.remove(local_fa + '.download.tmp')
    elif os.path.exists(local_fa):
        size_mb = os.path.getsize(local_fa) / (1024 * 1024)
        print(f"  [{genome_id}] FASTA already cached: {local_fa} ({size_mb:.0f} MB)")

    # The index must describe this FASTA record by record (a mirror's index can belong to another file); a
    # missing or mismatched one is rebuilt from the FASTA, and a FASTA left without a matching index fails.
    index_problem = None
    if os.path.exists(local_fa):
        from state.browser_state import ReferenceIndexError, ensure_verified_index
        try:
            ensure_verified_index(local_fa)
            print(f"  [{genome_id}] FAI matches: {local_fai}")
        except ReferenceIndexError as exc:
            index_problem = f"{genome_id}: no index that matches {local_fa} ({exc})"
            print(f"  [{genome_id}] ERROR: {index_problem}")

    # Download GTF
    gtf_url = genome_info.get('gtf_url')
    gtf_path = os.path.join(genome_dir, f'{genome_id}.gtf')

    if gtf_url and not os.path.exists(gtf_path):
        print(f"  [{genome_id}] Downloading GTF: {gtf_url}")
        try:
            tmp_path = gtf_path + '.tmp'
            if gtf_url.endswith('.gz'):
                gz_path = tmp_path + '.gz'
                _http_fetch(gtf_url, gz_path)
                print(f"  [{genome_id}] Decompressing GTF...")
                with gzip.open(gz_path, 'rb') as f_in:
                    with open(tmp_path, 'wb') as f_out:
                        shutil.copyfileobj(f_in, f_out)
                os.remove(gz_path)
            else:
                _http_fetch(gtf_url, tmp_path)

            os.rename(tmp_path, gtf_path)
            size_mb = os.path.getsize(gtf_path) / (1024 * 1024)
            print(f"  [{genome_id}] GTF saved: {gtf_path} ({size_mb:.0f} MB)")
        except Exception as e:
            print(f"  [{genome_id}] Error downloading GTF: {e}")
            for p in [gtf_path + '.tmp', gtf_path + '.tmp.gz']:
                if os.path.exists(p):
                    os.remove(p)
    elif os.path.exists(gtf_path):
        size_mb = os.path.getsize(gtf_path) / (1024 * 1024)
        print(f"  [{genome_id}] GTF already cached: {gtf_path} ({size_mb:.0f} MB)")

    if index_problem:
        raise RuntimeError(index_problem)


def cache_metadata(genome_id, cache_dir, include_jaspar=False):
    """Cache all metadata for a single genome."""
    print(f"\n[{genome_id}] Caching metadata...")
    os.makedirs(cache_dir, exist_ok=True)

    if include_jaspar:
        cache_jaspar_names(genome_id, cache_dir)
    cache_ucsc_tracks(genome_id, cache_dir)
    cache_encode_facets(genome_id, cache_dir)

    print(f"[{genome_id}] Done.")


def main():
    parser = argparse.ArgumentParser(
        description='Precache genome metadata and optionally download genome files for FiberHMM Browser.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('--genome', nargs='+', metavar='ID',
                        help='Specific genome IDs to cache (e.g. hg38 dm6). Default: all standard genomes.')
    parser.add_argument('--all', action='store_true',
                        help='Cache all standard genomes (default behavior).')
    parser.add_argument('--download', action='store_true',
                        help='Also download FASTA/FAI/GTF genome files.')
    parser.add_argument('--jaspar', action='store_true',
                        help='Also extract JASPAR bigBed names (slow, requires pyBigWig).')
    parser.add_argument('--cache-dir', default=os.path.join(os.path.expanduser('~'), '.fiberhmm', 'cache'),
                        help='Output directory for cache files (default: ~/.fiberhmm/cache/).')

    args = parser.parse_args()
    genomes = args.genome or list(GENOME_REGISTRY.keys())
    genome_dir = os.path.join(os.path.expanduser('~'), '.fiberhmm', 'genomes')

    # Validate genome IDs
    invalid = [g for g in genomes if g not in GENOME_REGISTRY]
    if invalid:
        print(f"Error: Unknown genome(s): {', '.join(invalid)}")
        print(f"Available: {', '.join(GENOME_REGISTRY.keys())}")
        sys.exit(1)

    print(f"Preparing cache for {len(genomes)} genome(s): {', '.join(genomes)}")
    print(f"Cache directory: {args.cache_dir}")
    if args.download:
        print(f"Genome files directory: {genome_dir}")

    failures = []
    for gid in genomes:
        cache_metadata(gid, args.cache_dir, include_jaspar=args.jaspar)
        if args.download:
            try:
                download_genome_files(gid, GENOME_REGISTRY[gid], genome_dir)
            except RuntimeError as exc:
                failures.append(str(exc))

    # Summary
    print(f"\nCache saved to {args.cache_dir}/")
    if os.path.isdir(args.cache_dir):
        for f in sorted(os.listdir(args.cache_dir)):
            if f.endswith('.json'):
                size_kb = os.path.getsize(os.path.join(args.cache_dir, f)) / 1024
                print(f"  {f} ({size_kb:.0f}KB)")

    if failures:
        print("\nFailed:")
        for failure in failures:
            print(f"  {failure}")
        sys.exit(1)
    print("\nDone.")


def _http_fetch(*args, **kwargs):
    """A download with finite deadlines (services/http_download.fetch; tests replace it there)."""
    from services import http_download
    return http_download.fetch(*args, **kwargs)


if __name__ == '__main__':
    main()
