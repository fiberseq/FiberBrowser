"""GTF/GFF3 annotation loading helpers."""
from __future__ import annotations

import os
import json
import hashlib
import re
from urllib.parse import unquote

import pandas as pd

from utils.chrom import normalize_chrom_name


def _parse_gtf_attrs(attrs_str):
    """Parse GTF attribute string (key "value"; format)."""
    attrs = {}
    for item in attrs_str.split(";"):
        item = item.strip()
        if '"' in item:
            p = item.split('"')
            if len(p) >= 2:
                attrs[p[0].strip()] = p[1]
    return attrs


def _parse_gff3_attrs(attrs_str):
    """Parse GFF3 attribute string (key=value;key=value format)."""
    attrs = {}
    for item in attrs_str.split(";"):
        item = item.strip()
        if "=" in item:
            key, _, val = item.partition("=")
            attrs[key.strip()] = unquote(val.strip())
    return attrs


# Regex to detect tblastn-style Name fields:
#   (align_range)-ACCESSION-description-[organism]_start_end
_BLAST_NAME_RE = re.compile(
    r"^\([\d/\-]+\)-"  # (52-240/254)-
    r"([A-Z]{2}_[\d]+\.\d+|DF\d+\.\d+)-"  # NP_610955.1- or DF000001586.3-
    r"(.+?)(?:_\d+_\d+)?$"  # description_start_end
)
_CG_RE = re.compile(r"Dmel_(CG\d+)")
_ORGANISM_RE = re.compile(r"-?\[.*?\]")


def _clean_blast_name(raw_name: str) -> str:
    """Extract a clean, searchable gene name from a tblastn hit Name field."""
    m = _BLAST_NAME_RE.match(raw_name)
    if not m:
        return raw_name

    accession = m.group(1)
    desc = m.group(2)

    # Strip organism tag like [Drosophila-melanogaster]
    desc = _ORGANISM_RE.sub("", desc).strip("-").strip(",").strip()

    cg_match = _CG_RE.search(desc)
    is_te = accession.startswith("DF")

    if is_te:
        return desc.strip("-").strip()

    if cg_match:
        cg_name = cg_match.group(1)
        desc_lower = desc.lower()
        if "uncharacterized" in desc_lower:
            return cg_name

        clean = desc.replace("-", " ").strip()
        clean = re.sub(r",?\s*isoform\s+\w+$", "", clean)
        return clean

    clean = desc.replace("-", " ").strip()
    clean = re.sub(r",?\s*isoform\s+\w+$", "", clean)
    clean = re.sub(r"^MULTISPECIES:\s*", "", clean)
    return clean if clean else raw_name


def load_annotation_bed(path):
    """BED3/6/12 gene annotations; retain BED's zero-based half-open bounds."""
    from services.lab.paths import open_text
    transcripts, exons = [], []
    with open_text(path) as handle:  # a lab server: inside its data roots, by descriptor
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line or line.startswith(('#', 'track ', 'browser ')):
                continue
            fields = line.split('\t')
            try:
                chrom, start, end = fields[0], int(fields[1]), int(fields[2])
                if start < 0 or end <= start:
                    raise ValueError('expected nonnegative start < end')
                name = fields[3] if len(fields) > 3 and fields[3] != '.' else f'{chrom}:{start}-{end}'
                strand = fields[5] if len(fields) > 5 else '.'
                if strand not in ('+', '-', '.'):
                    raise ValueError('invalid strand')
                tid = f'bed:{line_number}:{name}'
                blocks = [(start, end)]
                if len(fields) >= 12:
                    count = int(fields[9]); sizes = [int(v) for v in fields[10].rstrip(',').split(',')]
                    offsets = [int(v) for v in fields[11].rstrip(',').split(',')]
                    if count < 1 or count != len(sizes) or count != len(offsets):
                        raise ValueError('BED12 block count mismatch')
                    blocks = [(start+offset, start+offset+size) for offset, size in zip(offsets, sizes)]
                    if any(a < start or b > end or b <= a for a,b in blocks) or any(blocks[i][0] < blocks[i-1][1] for i in range(1,len(blocks))):
                        raise ValueError('invalid or overlapping BED12 blocks')
                transcripts.append(dict(chrom=chrom, start=start, end=end, strand=strand,
                    transcript_id=tid, gene_name=name, biotype=None))
                exons.extend(dict(chrom=chrom,start=a,end=b,transcript_id=tid) for a,b in blocks)
            except (ValueError, IndexError) as error:
                raise ValueError(f'{path}: BED line {line_number}: {error}') from error
    tx = pd.DataFrame(transcripts, columns=['chrom','start','end','strand','transcript_id','gene_name','biotype'])
    tx['norm_chrom'] = tx['chrom'].map(normalize_chrom_name)
    return dict(transcripts=tx, exons=pd.DataFrame(exons,columns=['chrom','start','end','transcript_id']),
                tx_by_chrom={name:group for name,group in tx.groupby('norm_chrom')})


EXON_COLUMNS = ["chrom", "start", "end", "transcript_id"]


def exon_table(exons=None):
    """Exon rows as a DataFrame that always has the exon columns.

    Gene-only GFF3s and transcript-only GTFs have no exon rows; an empty
    DataFrame without columns made every exon lookup raise KeyError.
    """
    df = exons if isinstance(exons, pd.DataFrame) else pd.DataFrame(exons if exons is not None else [])
    for column in EXON_COLUMNS:
        if column not in df.columns:
            df[column] = pd.Series(dtype="object" if column in ("chrom", "transcript_id") else "int64")
    return df


def load_gtf(gtf_path):
    """Load GTF or GFF3 annotation file.

    Coordinates are converted to the browser's 0-based half-open system (GTF
    and GFF are 1-based inclusive: start - 1, end unchanged), like BED.

    A JSON cache makes reloads fast: the first load parses the GTF (~15s for
    hg38) and writes it to FiberBrowser's own cache (annotation_cache_path),
    never next to the user's file (a synced, shared or read-only folder). A
    `.fbcache.json` companion written by older versions is still read. Old
    `.pkl` caches are never read: unpickling a file found next to an
    annotation could run arbitrary code.
    """
    if not gtf_path or not os.path.exists(gtf_path):
        return None
    from services.lab.paths import confine
    confine(gtf_path)  # a lab server's data roots

    if str(gtf_path).lower().endswith(('.bed', '.bed.gz', '.bed12', '.bed12.gz')):
        return load_annotation_bed(gtf_path)

    # Cache fast-path: reuse a cached parse if it's newer than the source (our own cache, then an older version's
    # companion next to the file).
    cache_path = annotation_cache_path(gtf_path)
    for candidate in (cache_path, gtf_path + ".fbcache.json"):
        try:
            if (
                os.path.exists(candidate)
                and os.path.getmtime(candidate) >= os.path.getmtime(gtf_path)
            ):
                cached = _read_annotation_cache(candidate)
                if cached is not None:
                    print(f"Loaded annotation from cache {candidate} ({len(cached['transcripts'])} transcripts)")
                    return cached
        except Exception as e:
            print(f"  GTF cache miss ({e}); reparsing {gtf_path}")

    print(f"Loading annotation from {gtf_path}...")
    transcripts, exons = [], []

    # Auto-detect gzip
    from services.lab.paths import open_text

    # Auto-detect format from first non-comment data line
    is_gff3 = None
    if gtf_path.lower().rstrip(".gz").endswith((".gff3", ".gff")):
        is_gff3 = True

    # For GFF3: track gene-level info to propagate to transcripts
    gff3_genes = {}  # gene ID -> {name, biotype, chrom, start, end, strand}

    with open_text(gtf_path) as f:  # a lab server: inside its data roots, by descriptor
        for line in f:
            if line.startswith("#"):
                if "##gff-version" in line:
                    is_gff3 = True
                continue
            parts = line.strip().split("\t")
            if len(parts) < 9:
                continue

            chrom, _, feature, start, end, _, strand, _, attrs_str = parts

            # Auto-detect format from first data line if still unknown
            if is_gff3 is None:
                is_gff3 = ("=" in attrs_str and '"' not in attrs_str)

            if is_gff3:
                attrs = _parse_gff3_attrs(attrs_str)

                # GFF3 uses ID/Parent hierarchy
                feat_id = attrs.get("ID", "")
                parent = attrs.get("Parent", "")

                if feature == "gene":
                    gff3_genes[feat_id] = {
                        "name": attrs.get("Name", attrs.get("gene_name", feat_id)),
                        "biotype": attrs.get(
                            "biotype",
                            attrs.get("gene_biotype", attrs.get("gene_type", "")),
                        ),
                        "chrom": chrom,
                        "start": int(start) - 1,
                        "end": int(end),
                        "strand": strand,
                    }
                elif feature in (
                    "transcript",
                    "mRNA",
                    "rRNA",
                    "tRNA",
                    "lnc_RNA",
                    "ncRNA",
                    "snRNA",
                    "snoRNA",
                    "miRNA",
                ):
                    gene_info = gff3_genes.get(parent, {})
                    gene_name = attrs.get(
                        "Name",
                        attrs.get("gene_name", gene_info.get("name", feat_id)),
                    )
                    biotype = attrs.get(
                        "biotype",
                        attrs.get("gene_biotype", gene_info.get("biotype", feature)),
                    )
                    transcripts.append(
                        {
                            "chrom": chrom,
                            "start": int(start) - 1,
                            "end": int(end),
                            "strand": strand,
                            "transcript_id": feat_id or attrs.get("transcript_id", ""),
                            "gene_name": gene_name,
                            "biotype": biotype,
                        }
                    )
                elif feature == "exon":
                    # Parent is the transcript ID in GFF3; an exon shared by
                    # several transcripts lists them all (Parent=t1,t2).
                    for transcript_id in [p for p in (parent or "").split(",") if p] or [""]:
                        exons.append(
                            {
                                "chrom": chrom,
                                "start": int(start) - 1,
                                "end": int(end),
                                "transcript_id": transcript_id,
                            }
                        )
                elif feature in (
                    "match",
                    "match_part",
                    "region",
                    "repeat_region",
                    "protein_match",
                    "cDNA_match",
                    "nucleotide_match",
                    "expressed_sequence_match",
                    "CDS",
                ):
                    # Generic features (e.g. tblastn hits, repeats) are single-exon transcripts.
                    raw_name = attrs.get("Name", attrs.get("gene_name", feat_id))
                    name = _clean_blast_name(raw_name)
                    biotype = attrs.get("description", feature)
                    transcript_id = feat_id or f"{chrom}:{start}-{end}"
                    transcripts.append(
                        {
                            "chrom": chrom,
                            "start": int(start) - 1,
                            "end": int(end),
                            "strand": strand,
                            "transcript_id": transcript_id,
                            "gene_name": name,
                            "biotype": biotype,
                        }
                    )
                    exons.append(
                        {
                            "chrom": chrom,
                            "start": int(start) - 1,
                            "end": int(end),
                            "transcript_id": transcript_id,
                        }
                    )
            else:
                # GTF format
                attrs = _parse_gtf_attrs(attrs_str)
                biotype = attrs.get(
                    "gene_biotype",
                    attrs.get("transcript_biotype", attrs.get("gene_type", "")),
                )

                if feature == "transcript":
                    transcripts.append(
                        {
                            "chrom": chrom,
                            "start": int(start) - 1,
                            "end": int(end),
                            "strand": strand,
                            "transcript_id": attrs.get("transcript_id", ""),
                            "gene_name": attrs.get("gene_name", attrs.get("gene_id", "")),
                            "biotype": biotype,
                        }
                    )
                elif feature == "exon":
                    exons.append(
                        {
                            "chrom": chrom,
                            "start": int(start) - 1,
                            "end": int(end),
                            "transcript_id": attrs.get("transcript_id", ""),
                        }
                    )

    # For GFF3 files with no explicit transcript features, synthesize from genes
    if is_gff3 and len(transcripts) == 0 and len(gff3_genes) > 0:
        for gid, g in gff3_genes.items():
            transcripts.append(
                {
                    "chrom": g["chrom"],
                    "start": g["start"],
                    "end": g["end"],
                    "strand": g["strand"],
                    "transcript_id": gid,
                    "gene_name": g["name"],
                    "biotype": g["biotype"],
                }
            )

    fmt = "GFF3" if is_gff3 else "GTF"
    print(f"Loaded {len(transcripts)} transcripts from {fmt} file")
    tx_df = pd.DataFrame(transcripts)
    if len(tx_df) > 0:
        tx_df["norm_chrom"] = tx_df["chrom"].apply(normalize_chrom_name)

    # Pre-compute chromosome index for fast per-chrom queries
    tx_by_chrom = {}
    if len(tx_df) > 0 and "norm_chrom" in tx_df.columns:
        for nc, grp in tx_df.groupby("norm_chrom"):
            tx_by_chrom[nc] = grp
    result = {
        "transcripts": tx_df,
        "exons": exon_table(exons),
        "tx_by_chrom": tx_by_chrom,
    }

    # Write the cache for fast future loads (FiberBrowser's own cache folder, not beside the user's file).
    try:
        from services.lab.paths import confine_sidecar
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        confine_sidecar(cache_path)  # a lab server: only into its own writable places
        _write_annotation_cache(cache_path, result)
        print(f"  Cached parsed annotation to {cache_path}")
    except Exception as e:
        print(f"  Warning: could not write annotation cache ({e})")

    return result


def annotation_cache_path(gtf_path: str) -> str:
    """FiberBrowser's cache of a parsed annotation: ~/.fiberhmm/cache/annotations/<name>.<path hash>.fbcache.json.

    Keyed by the file's absolute path, so two files with one name don't share a cache; freshness is checked against
    the file's modification time when it is read."""
    key = hashlib.sha256(os.path.abspath(str(gtf_path)).encode("utf-8")).hexdigest()[:24]
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(str(gtf_path)))[:60]
    return os.path.join(os.path.expanduser("~"), ".fiberhmm", "cache", "annotations", f"{name}.{key}.fbcache.json")


# Bumped when parsing changes (v2: 0-based starts), so older caches are reparsed.
_ANNOTATION_CACHE_VERSION = 3  # 3: GFF3 exons with several Parents


def _write_annotation_cache(path, result) -> None:
    """Column lists as plain JSON: only data, nothing executable."""
    def columns(df):
        return {col: df[col].tolist() for col in df.columns}
    payload = {
        "version": _ANNOTATION_CACHE_VERSION,
        "transcripts": columns(result["transcripts"]),
        "exons": columns(result["exons"]),
    }
    # A fresh temporary file (never an existing name, which could be a link to
    # somewhere else), created exclusively in the cache's own folder.
    import secrets
    tmp = f"{path}.{secrets.token_hex(6)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o666)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_annotation_cache(path):
    from services.lab.paths import open_read
    with open_read(path) as f:  # a lab server: a regular file inside its data roots, by descriptor
        payload = json.loads(f.read().decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != _ANNOTATION_CACHE_VERSION:
        return None
    tx_df = pd.DataFrame(payload.get("transcripts") or {})
    ex_df = exon_table(pd.DataFrame(payload.get("exons") or {}))
    tx_by_chrom = {}
    if len(tx_df) > 0 and "norm_chrom" in tx_df.columns:
        for nc, grp in tx_df.groupby("norm_chrom"):
            tx_by_chrom[nc] = grp
    return {"transcripts": tx_df, "exons": ex_df, "tx_by_chrom": tx_by_chrom}


def get_gene_region_records(gtf_data, chrom, start, end) -> list[dict]:
    """Return protein-coding/mRNA transcript records overlapping a region."""
    records: list[dict] = []
    if not gtf_data or "transcripts" not in gtf_data:
        return records

    norm_target = normalize_chrom_name(chrom)
    tx_by_chrom = gtf_data.get("tx_by_chrom")
    if tx_by_chrom and norm_target in tx_by_chrom:
        chrom_tx = tx_by_chrom[norm_target]
    else:
        tx_df = gtf_data["transcripts"]
        if "norm_chrom" in tx_df.columns:
            chrom_tx = tx_df[tx_df["norm_chrom"] == norm_target]
        else:
            chrom_tx = tx_df[tx_df["chrom"].apply(lambda c: normalize_chrom_name(c)) == norm_target]

    chrom_genes = chrom_tx[
        chrom_tx["biotype"].isin(["protein_coding", "mRNA"]) | chrom_tx["biotype"].isna()
    ]
    for _, row in chrom_genes.iterrows():
        g_start, g_end = int(row["start"]), int(row["end"])
        if g_end > start and g_start < end:
            records.append({
                "id": str(row.get("transcript_id", "")),
                "name": str(row.get("gene_name", "")),
                "start": g_start,
                "end": g_end,
            })

    return records
