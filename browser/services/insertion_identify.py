"""Identify an insertion: what its consensus sequence is.

Two local searches, then an interpretation that the lens shows as a summary,
a hit table and a to-scale cartoon:

1. **Genome**: the consensus against the loaded reference (BLAST ``megablast``
   with DUST masking of low-complexity sequence; minimap2 ``asm20`` when
   BLAST+ is not installed). HSPs on the same contig and strand within 1 kb
   are joined into loci. From the loci: how many copies the genome has (a
   repeat family when several cover most of the insert), copies near the
   insertion site (a local duplication), and, for stretches that only a few
   loci explain, the genes and exons they land in ("gene fragment").
2. **Known TEs**: the consensus against the assembly's TE library
   (services/te_library.py; the first Identify sets it up as part of the job:
   the bundled fly set, or one download of public data such as Dfam's curated
   families; nothing about the user's data is sent), ``dc-megablast`` (minimap2
   fallback). Hits are chained per family and strand, placed in element
   coordinates, and called full length or truncated (5′/3′/internal).
   Dfam's split LTR families (``X_LTR`` + ``X_I``) are joined into one element.

With ``rmsk=True`` (the panel's default; its checkbox turns it off) the
reference copies are named from UCSC's RepeatMasker track: only the hit loci's
*reference coordinates* are sent to UCSC, never the user's sequence. Searching Dfam online
(``dfam_search``) sends the sequence and refuses unless ``opt_in`` is True.

Everything is reported in consensus coordinates (0-based, half-open), the
backend's insert consensus as built (the lens's "Reverse" is a view option).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from typing import Callable, Optional

from services import te_library
from services.external_tools import tool_path

ProgressFn = Callable[[str, float], None]

MAX_QUERY = 100_000
LOCUS_GAP = 1_000          # HSPs this close (same contig/strand) form one locus
COPY_QCOV = 0.5            # a locus covering this share of the insert is a copy of it
FAMILY_MIN_IDENTITY = 80.0  # a TE family is called only from hits at least this similar
# The verdict (docs/identify.md): what Identify offers is a *candidate*, never an identification.
#   candidate:  the best TE family (else a gene, a RepeatMasker family or a genome locus) has at least
#               VERDICT_MIN_IDENTITY % identity over at least VERDICT_MIN_QUERY_COVERAGE of the insert;
#   ambiguous:  another TE family (a different family, not a fragment of the same one) reaches at least
#               (1 - AMBIGUOUS_BITSCORE_FRACTION) of the best one's bitscore over largely the same bases
#               (AMBIGUOUS_MIN_OVERLAP of the shorter of the two);
#   no_match:   nothing reaches those minimums.
# browser/frontend/src/features/insertion/identifyModel.ts keeps the same values (older saved results).
VERDICT_MIN_IDENTITY = FAMILY_MIN_IDENTITY
VERDICT_MIN_QUERY_COVERAGE = 0.5
AMBIGUOUS_BITSCORE_FRACTION = 0.05
AMBIGUOUS_MIN_OVERLAP = 0.5
NEAR_SITE = 20_000         # a genome hit this close to the insertion is "at the site"
GENE_MAX_LOCI = 3          # gene overlaps only for stretches with at most this many loci
MIN_SEGMENT = 20
FULL_SLACK_FRAC = 0.02
FULL_SLACK_MIN = 50
SCHEMA = "fiberbrowser.insertion_identify/2"


class IdentifyError(RuntimeError):
    pass


class IdentifyAborted(IdentifyError):
    pass


# ---------------------------------------------------------------------------
# Tools


def blastn_available() -> bool:
    return tool_path("blastn") is not None


def minimap2_path() -> Optional[str]:
    return tool_path("minimap2")


def choose_engine(prefer: str = "auto") -> str:
    if prefer in ("auto", "blast") and blastn_available():
        return "blast"
    if prefer in ("auto", "minimap2") and minimap2_path():
        return "minimap2"
    if prefer == "blast" and minimap2_path() is None:
        raise IdentifyError(tools_missing_message())
    if prefer == "minimap2" and blastn_available():
        return "blast"
    raise IdentifyError(tools_missing_message())


def tools_missing_message() -> str:
    return ("Identifying an insertion needs BLAST+ (blastn, makeblastdb) or minimap2, and neither was found. "
            "Install one: 'brew install blast' or 'conda install -c bioconda blast' "
            "(or 'brew install minimap2'), then restart FiberBrowser.")


def tool_status(refresh: bool = False) -> dict:
    from services.external_tools import blast_summary, resolve
    blast = blast_summary(refresh=refresh)
    mm2 = resolve("minimap2", refresh=refresh)
    return {"blastn": blast["blastn"]["ok"], "makeblastdb": blast["makeblastdb"]["ok"], "minimap2": mm2.ok,
            "blast_label": blast["label"], "blast_version": blast["blastn"]["version"],
            "blast_path": blast["blastn"]["path"], "minimap2_version": mm2.version, "minimap2_path": mm2.path,
            "hint": blast["hint"]}


class _Runner:
    """Abort-aware subprocess runner for one identification job."""

    def __init__(self, abort: Optional[threading.Event] = None):
        self.abort = abort or threading.Event()
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

    def check(self) -> None:
        if self.abort.is_set():
            raise IdentifyAborted("Stopped")

    def run(self, cmd: list[str], *, stdout_path: Optional[str] = None, timeout: float = 3600) -> str:
        self.check()
        out = open(stdout_path, "wb") if stdout_path else subprocess.PIPE
        try:
            proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.PIPE)
            with self._lock:
                self._proc = proc
            try:
                stdout, stderr = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise IdentifyError(f"{os.path.basename(cmd[0])} took longer than {int(timeout)} s")
        finally:
            if stdout_path:
                out.close()
            with self._lock:
                self._proc = None
        self.check()
        if proc.returncode != 0:
            detail = (stderr or b"").decode("utf-8", "replace").strip()[-800:]
            raise IdentifyError(f"{os.path.basename(cmd[0])} failed: {detail or proc.returncode}")
        return (stdout or b"").decode("utf-8", "replace") if not stdout_path else ""

    def kill(self) -> None:
        self.abort.set()
        with self._lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass


# ---------------------------------------------------------------------------
# Hits

BLAST_FIELDS = "qseqid sseqid pident length qstart qend sstart send evalue bitscore slen qlen nident"


def parse_blast_tab(text: str) -> list[dict]:
    hits = []
    for line in text.splitlines():
        cols = line.rstrip("\n").split("\t")
        if len(cols) < 12 or line.startswith("#"):
            continue
        try:
            qs, qe, ss, se = int(cols[4]), int(cols[5]), int(cols[6]), int(cols[7])
            hits.append({
                "subject": cols[1], "identity": float(cols[2]), "length": int(cols[3]),
                "qstart": min(qs, qe) - 1, "qend": max(qs, qe),
                "sstart": min(ss, se) - 1, "send": max(ss, se),
                "strand": "+" if ss <= se else "-",
                "evalue": float(cols[8]), "bitscore": float(cols[9]), "slen": int(cols[10]),
            })
        except ValueError:
            continue
    return hits


def parse_paf(text: str) -> list[dict]:
    hits = []
    for line in text.splitlines():
        cols = line.split("\t")
        if len(cols) < 12:
            continue
        try:
            nmatch, alen = int(cols[9]), int(cols[10])
            hits.append({
                "subject": cols[5], "identity": round(100.0 * nmatch / max(1, alen), 3), "length": alen,
                "qstart": int(cols[2]), "qend": int(cols[3]), "sstart": int(cols[7]), "send": int(cols[8]),
                "strand": cols[4], "evalue": None, "bitscore": float(nmatch), "slen": int(cols[6]),
            })
        except ValueError:
            continue
    return hits


def _write_query(seq: str, directory: str) -> str:
    path = os.path.join(directory, "query.fa")
    with open(path, "w") as handle:
        handle.write(">insert\n")
        for i in range(0, len(seq), 80):
            handle.write(seq[i:i + 80] + "\n")
    return path


def run_blastn(seq: str, db: str, *, task: str, runner: _Runner, evalue: float, max_target_seqs: int,
               max_hsps: Optional[int] = None, perc_identity: Optional[float] = None) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="fb_identify_") as tmp:
        query = _write_query(seq, tmp)
        out = os.path.join(tmp, "hits.tsv")
        from services.primer_blast_runtime import blast_thread_count
        cmd = [tool_path("blastn") or "blastn", "-task", task, "-query", query, "-db", db, "-outfmt", f"6 {BLAST_FIELDS}",
               "-evalue", str(evalue), "-dust", "yes", "-max_target_seqs", str(max_target_seqs),
               "-num_threads", str(blast_thread_count()), "-out", out]
        if max_hsps:
            cmd += ["-max_hsps", str(max_hsps)]
        if perc_identity:
            cmd += ["-perc_identity", str(perc_identity)]
        runner.run(cmd)
        with open(out) as handle:
            return parse_blast_tab(handle.read())


def run_minimap2(seq: str, target: str, *, runner: _Runner, preset: str = "asm20", secondary: int = 1000) -> list[dict]:
    mm2 = minimap2_path()
    if not mm2:
        raise IdentifyError(tools_missing_message())
    with tempfile.TemporaryDirectory(prefix="fb_identify_") as tmp:
        query = _write_query(seq, tmp)
        out = os.path.join(tmp, "hits.paf")
        cmd = [mm2, "-c", "-x", preset, "--secondary=yes", "-N", str(secondary), "-p", "0.3",
               "-t", "4", target, query]
        runner.run(cmd, stdout_path=out)
        with open(out) as handle:
            return parse_paf(handle.read())


# ---------------------------------------------------------------------------
# Genome database / index (built on demand, the way primer design does)

_build_lock = threading.Lock()


def genome_blast_db(state, *, runner: Optional[_Runner] = None, progress: Optional[ProgressFn] = None,
                    build: bool = True) -> str:
    """The loaded genome's BLAST database: primer design's when it matches, else the
    default one beside the others (``~/.fiberhmm/blast/<genome>/<genome>``), built now if
    missing. Primer design's own configuration is left as it is."""
    from services.primer_config import (
        blast_db_exists, blast_db_source_matches, default_blast_db_prefix, genome_hints, prefix_matches_hints,
        record_blast_db_source,
    )
    fasta = getattr(state, "fasta_path", None)
    if not fasta or not os.path.isfile(fasta):
        raise IdentifyError("Load a reference genome first: the insertion is searched against it.")
    primer_db = getattr(state, "primer_blast_db", None)
    primer_fasta = getattr(state, "primer_fasta", None)
    if (primer_db and blast_db_exists(primer_db) and prefix_matches_hints(primer_db, genome_hints(state))
            and (not primer_fasta or os.path.abspath(primer_fasta) == os.path.abspath(fasta))
            and blast_db_source_matches(primer_db, fasta)):
        return primer_db
    prefix = default_blast_db_prefix(state, fasta)
    if blast_db_exists(prefix) and blast_db_source_matches(prefix, fasta):
        return prefix
    if not build:
        raise IdentifyError("No BLAST database for this genome yet.")
    if tool_path("makeblastdb") is None:
        raise IdentifyError("makeblastdb (BLAST+) is needed to index the genome. "
                            "Install BLAST+ ('brew install blast' or 'conda install -c bioconda blast').")
    with _build_lock:
        if blast_db_exists(prefix) and blast_db_source_matches(prefix, fasta):
            return prefix
        if progress:
            progress("Indexing the genome for BLAST (once; a few minutes for a large genome)", 0.1)
        os.makedirs(os.path.dirname(prefix), exist_ok=True)
        (runner or _Runner()).run([tool_path("makeblastdb") or "makeblastdb", "-in", fasta, "-dbtype", "nucl", "-parse_seqids", "-out", prefix],
                                  timeout=3600)
        if not blast_db_exists(prefix):
            raise IdentifyError(f"makeblastdb finished but wrote no database at {prefix}")
        record_blast_db_source(prefix, fasta)
    return prefix


def _index_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".fiberhmm", "minimap2_index")


def genome_minimap2_index(state, *, runner: _Runner, progress: Optional[ProgressFn] = None,
                          preset: str = "asm20") -> str:
    """A cached minimap2 index of the loaded genome (``~/.fiberhmm/minimap2_index``), keyed by
    the FASTA's path, size and modification time and the preset."""
    fasta = getattr(state, "fasta_path", None)
    if not fasta or not os.path.isfile(fasta):
        raise IdentifyError("Load a reference genome first: the insertion is searched against it.")
    st = os.stat(fasta)
    ident = {"reference": os.path.abspath(fasta), "size": st.st_size, "mtime_ns": st.st_mtime_ns, "preset": preset}
    digest = hashlib.sha256(json.dumps(ident, sort_keys=True).encode()).hexdigest()[:24]
    target = os.path.join(_index_dir(), f"fb-identify-{digest}.mmi")
    if os.path.isfile(target) and os.path.isfile(target + ".json"):
        return target
    mm2 = minimap2_path()
    if not mm2:
        raise IdentifyError(tools_missing_message())
    with _build_lock:
        if os.path.isfile(target) and os.path.isfile(target + ".json"):
            return target
        if progress:
            progress("Indexing the genome for minimap2 (once)", 0.1)
        os.makedirs(_index_dir(), exist_ok=True)
        tmp = f"{target}.tmp{os.getpid()}"
        try:
            runner.run([mm2, "-x", preset, "-d", tmp, fasta], timeout=7200)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        with open(target + ".json", "w") as handle:
            json.dump({**ident, "aligner": f"minimap2 ({mm2})"}, handle)
    return target


def annotation_signature(state) -> str:
    """The loaded gene annotation's identity (path, size, mtime), or 'none'."""
    if getattr(state, "gtf_data", None) is None:
        return "none"
    path = getattr(state, "gtf_path", None) or ""
    try:
        st = os.stat(path)
        return f"{os.path.abspath(path)}:{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        return f"{path}:{id(state.gtf_data)}"


def local_reference_fasta(state) -> Optional[str]:
    """The loaded reference as a local file: the FASTA itself, or a remote genome's cached
    download, which is what its open handle reads (``state.fasta.filename``; a panel genome's
    view, a paired-reference collection and a forked workspace carry their own handle).
    None for a cluster FASTA or no reference."""
    handle_file = getattr(getattr(state, "fasta", None), "filename", None)
    if isinstance(handle_file, bytes):
        handle_file = handle_file.decode(errors="replace")
    for path in (handle_file, getattr(state, "fasta_path", None)):
        if path and isinstance(path, str) and os.path.isfile(path):
            return path
    return None


def reference_id(state) -> str:
    """What a result depends on besides the consensus: the reference FASTA and annotation.
    The panel compares it with the current one to mark a result as stale."""
    fasta = getattr(state, "fasta_path", None) or ""
    try:
        st = os.stat(fasta)
        ref = f"{os.path.abspath(fasta)}:{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        ref = fasta
    text = f"{getattr(state, 'current_genome', None)}|{_identity(state)}|{ref}|{annotation_signature(state)}"
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class StateSnapshot:
    """The reference, annotation and primer-DB settings at request time: a job keeps
    searching what was loaded when it started, even if the user switches genome."""

    def __init__(self, state):
        self.current_genome = getattr(state, "current_genome", None)
        self.coordinate_genome = _coordinate_genome(state)
        # Searched as a local file (a downloaded genome's cached copy); the name shown stays the loaded one.
        self.fasta_path = local_reference_fasta(state) or getattr(state, "fasta_path", None)
        self.gtf_data = getattr(state, "gtf_data", None)
        self.gtf_path = getattr(state, "gtf_path", None)
        self.primer_blast_db = getattr(state, "primer_blast_db", None)
        self.primer_fasta = getattr(state, "primer_fasta", None)
        self.fasta = None  # flanks are read from fasta_path (a handle of its own)
        self.reference_id = reference_id(state)
        chrom_map = getattr(state, "translate_chrom", None)
        self._translate = chrom_map if callable(chrom_map) else (lambda c: c)

    def translate_chrom(self, chrom):
        try:
            return self._translate(chrom)
        except Exception:
            return chrom


def genome_signature(state, engine: str) -> str:
    fasta = getattr(state, "fasta_path", None) or ""
    try:
        st = os.stat(fasta)
        sig = f"{os.path.abspath(fasta)}:{st.st_size}:{st.st_mtime_ns}:{engine}"
    except OSError:
        sig = f"{fasta}:{engine}"
    return f"{sig}|{_identity(state)}|{annotation_signature(state)}"


# ---------------------------------------------------------------------------
# Interval helpers


def union_length(intervals) -> int:
    total, cur_s, cur_e = 0, None, None
    for s, e in sorted(intervals):
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        total += cur_e - cur_s
    return total


def merge_intervals(intervals, gap: int = 0) -> list[list[int]]:
    out: list[list[int]] = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def subtract(span: tuple[int, int], taken: list[list[int]]) -> list[list[int]]:
    pieces = [[span[0], span[1]]]
    for ts, te in taken:
        nxt = []
        for s, e in pieces:
            if te <= s or ts >= e:
                nxt.append([s, e])
                continue
            if s < ts:
                nxt.append([s, ts])
            if te < e:
                nxt.append([te, e])
        pieces = nxt
    return pieces


def query_to_subject(hit: dict, q: int) -> int:
    """A query position mapped through an HSP (linear; good to a few bases)."""
    qlen = max(1, hit["qend"] - hit["qstart"])
    frac = (q - hit["qstart"]) / qlen
    slen = hit["send"] - hit["sstart"]
    if hit["strand"] == "+":
        return int(round(hit["sstart"] + frac * slen))
    return int(round(hit["send"] - frac * slen))


def subject_to_query(hit: dict, s: int) -> int:
    slen = max(1, hit["send"] - hit["sstart"])
    frac = (s - hit["sstart"]) / slen
    qlen = hit["qend"] - hit["qstart"]
    if hit["strand"] == "+":
        return int(round(hit["qstart"] + frac * qlen))
    return int(round(hit["qend"] - frac * qlen))


# ---------------------------------------------------------------------------
# Genome interpretation


def build_loci(hits: list[dict], qlen: int, gap: int = LOCUS_GAP) -> list[dict]:
    """HSPs on one contig and strand within ``gap`` joined into loci, best first."""
    by_key: dict[tuple, list[dict]] = {}
    for h in hits:
        by_key.setdefault((h["subject"], h["strand"]), []).append(h)
    loci = []
    for (chrom, strand), group in by_key.items():
        group.sort(key=lambda h: h["sstart"])
        cur: list[dict] = []
        cur_end = None
        for h in group + [None]:
            # Joins the locus when close on the genome and matching another part of the
            # consensus (a second copy next door matches the same part: a locus of its own).
            if h is not None and cur and h["sstart"] <= cur_end + gap:
                hl = max(1, h["qend"] - h["qstart"])
                shared = sum(max(0, min(h["qend"], x["qend"]) - max(h["qstart"], x["qstart"])) for x in cur)
                if shared < 0.5 * hl:
                    cur.append(h)
                    cur_end = max(cur_end, h["send"])
                    continue
            elif h is not None and not cur:
                cur.append(h)
                cur_end = h["send"]
                continue
            if cur:
                aligned = sum(x["length"] for x in cur)
                loci.append({
                    "chrom": chrom, "strand": strand,
                    "start": min(x["sstart"] for x in cur), "end": max(x["send"] for x in cur),
                    "qstart": min(x["qstart"] for x in cur), "qend": max(x["qend"] for x in cur),
                    "qcov": round(union_length([(x["qstart"], x["qend"]) for x in cur]) / max(1, qlen), 4),
                    # The consensus bases the locus actually aligns (its bounding qstart/qend
                    # spans any unaligned middle).
                    "qivals": merge_intervals([(x["qstart"], x["qend"]) for x in cur]),
                    "identity": round(sum(x["identity"] * x["length"] for x in cur) / max(1, aligned), 2),
                    "evalue": min((x["evalue"] for x in cur if x["evalue"] is not None), default=None),
                    "bitscore": round(sum(x["bitscore"] for x in cur), 1),
                    "hsps": sorted(cur, key=lambda x: x["qstart"]),
                })
            cur = [h] if h is not None else []
            cur_end = h["send"] if h is not None else None
    loci.sort(key=lambda l: -l["bitscore"])
    return loci


def _same_chrom(a: str, b: str) -> bool:
    norm = lambda c: str(c).lower().removeprefix("chr")  # noqa: E731
    return norm(a) == norm(b)


def near_site(locus: dict, chrom: Optional[str], ref: Optional[int], window: int = NEAR_SITE) -> Optional[int]:
    """Distance from the insertion site, when the locus is on its contig within ``window``."""
    if chrom is None or ref is None or not _same_chrom(locus["chrom"], chrom):
        return None
    if locus["start"] <= ref <= locus["end"]:
        return 0
    dist = min(abs(locus["start"] - ref), abs(locus["end"] - ref))
    return dist if dist <= window else None


def _exon_rows(gtf_data, chrom: str, start: int, end: int):
    """(transcript rows, exon rows) of the annotation overlapping ``[start, end)``."""
    import pandas as pd

    from services.gene_annotations import exon_table
    from utils.chrom import normalize_chrom_name
    if not gtf_data or "transcripts" not in gtf_data:
        return None, None
    tx = gtf_data["transcripts"]
    target = normalize_chrom_name(chrom)
    by_chrom = gtf_data.get("tx_by_chrom") or {}
    chrom_tx = by_chrom.get(target)
    if chrom_tx is None:
        if "norm_chrom" in tx.columns:
            chrom_tx = tx[tx["norm_chrom"] == target]
        else:
            chrom_tx = tx[tx["chrom"].map(normalize_chrom_name) == target]
    hit_tx = chrom_tx[(chrom_tx["start"] < end) & (chrom_tx["end"] > start)]
    if hit_tx.empty:
        return hit_tx, pd.DataFrame()
    exons = exon_table(gtf_data.get("exons"))
    ids = set(hit_tx["transcript_id"].astype(str))
    ex = exons[exons["transcript_id"].astype(str).isin(ids)]
    return hit_tx, ex


JUNCTION_SLACK = 15


def _near(x: int, points: list[int], slack: int = JUNCTION_SLACK) -> bool:
    return any(abs(x - p) <= slack for p in points)


def gene_overlaps(hsps: list[dict], gtf_data, max_genes: int = 6) -> list[dict]:
    """Genes and exons that a set of genome HSPs overlap, in consensus coordinates.

    Per gene: the transcript the hits cover most, its exons (numbered 5′→3′ on the gene's
    strand), the consensus bases matching them, identity, the gene's orientation along the
    consensus, and whether the hits join exons across their introns (a spliced copy: a
    retrocopy / cDNA). An annotation without exon rows gives only a gene-body overlap
    (``region: 'gene'``): no exon is invented."""
    if not gtf_data or not hsps:
        return []
    genes: dict[str, dict] = {}
    for h in hsps:
        tx, ex = _exon_rows(gtf_data, h["subject"], h["sstart"], h["send"])
        if tx is None or tx.empty:
            continue
        for _, row in tx.iterrows():
            tid = str(row.get("transcript_id", ""))
            gname = str(row.get("gene_name") or tid)
            strand = str(row.get("strand") or "+")
            t_start, t_end = int(row["start"]), int(row["end"])
            t_ex = ex[ex["transcript_id"].astype(str) == tid] if not ex.empty else ex
            spans = sorted((int(r["start"]), int(r["end"])) for _, r in t_ex.iterrows()) if len(t_ex) else []
            order = list(range(len(spans)))
            if strand == "-":
                order = order[::-1]
            number = {spans[i]: n + 1 for n, i in enumerate(order)}
            exon_hits, q_ranges, exonic = [], [], 0
            for s_, e_ in spans:
                lo, hi = max(s_, h["sstart"]), min(e_, h["send"])
                if hi <= lo:
                    continue
                exonic += hi - lo
                q0, q1 = sorted((subject_to_query(h, lo), subject_to_query(h, hi)))
                exon_hits.append(number[(s_, e_)])
                q_ranges.append([q0, q1])
            body = max(0, min(h["send"], t_end) - max(h["sstart"], t_start))
            if not spans and body:
                q0, q1 = sorted((subject_to_query(h, max(h["sstart"], t_start)), subject_to_query(h, min(h["send"], t_end))))
                q_ranges.append([q0, q1])
            g = genes.setdefault(gname, {"gene": gname, "transcripts": {}, "chrom": h["subject"]})
            t = g["transcripts"].setdefault(tid, {"transcript": tid, "strand": strand, "n_exons": len(spans),
                                                  "annotated": bool(spans), "spans": spans,
                                                  "exons": set(), "q": [], "exonic": 0, "hsps": [], "body": 0,
                                                  "intronic": 0, "start": t_start, "end": t_end})
            t["exons"].update(exon_hits)
            t["q"].extend(q_ranges)
            t["exonic"] += exonic
            t["body"] += body
            if spans:
                t["intronic"] += max(0, body - exonic)
            t["hsps"].append(h)
    out = []
    for g in genes.values():
        best = max(g["transcripts"].values(), key=lambda t: (t["exonic"], t["body"], -t["intronic"]))
        if best["body"] == 0:
            continue
        hsps_t = sorted(best["hsps"], key=lambda x: x["qstart"])
        # Orientation along the consensus: the transcript's strand composed with the alignment's.
        weight = {"+": 0, "-": 0}
        for x in hsps_t:
            weight["+" if x["strand"] == best["strand"] else "-"] += x["length"]
        orientation = "+" if weight["+"] >= weight["-"] else "-"
        # Spliced: consecutive hits, in order on one strand, whose genome gap is an intron
        # (much longer than the consensus gap) ending and starting at annotated exon
        # boundaries, with little intron kept.
        spliced = False
        if best["annotated"] and len(best["exons"]) >= 2 and best["intronic"] <= 0.1 * best["exonic"] + 20:
            ends = [e for _, e in best["spans"]]
            starts = [s_ for s_, _ in best["spans"]]
            for a, b in zip(hsps_t, hsps_t[1:]):
                if a["strand"] != b["strand"]:
                    continue
                q_gap = b["qstart"] - a["qend"]
                if a["strand"] == "+":
                    s_gap = b["sstart"] - a["send"]
                    junction = _near(a["send"], ends) and _near(b["sstart"], starts)
                else:
                    s_gap = a["sstart"] - b["send"]
                    junction = _near(a["sstart"], starts) and _near(b["send"], ends)
                if s_gap - q_gap > 50 and junction:
                    spliced = True
        aligned = sum(x["length"] for x in hsps_t)
        q = merge_intervals(best["q"]) if best["q"] else merge_intervals([(x["qstart"], x["qend"]) for x in hsps_t])
        if not best["annotated"]:
            region = "gene"
        elif best["exonic"] and best["exonic"] >= best["intronic"]:
            region = "exon"
        else:
            region = "intron"
        out.append({
            "gene": g["gene"], "transcript": best["transcript"], "strand": best["strand"],
            "orientation": orientation, "chrom": g["chrom"],
            "gene_start": best["start"], "gene_end": best["end"],
            "exons": sorted(best["exons"]), "n_exons": best["n_exons"],
            "exonic_bp": best["exonic"], "intronic_bp": best["intronic"], "body_bp": best["body"],
            "query": q, "identity": round(sum(x["identity"] * x["length"] for x in hsps_t) / max(1, aligned), 2),
            "spliced": spliced, "region": region,
        })
    out.sort(key=lambda g: -(g["exonic_bp"] * 2 + g["intronic_bp"] + g["body_bp"] * (g["region"] == "gene")))
    return out[:max_genes]


# ---------------------------------------------------------------------------
# TE interpretation

_LTR_SPLIT = re.compile(r"^(?P<base>.+?)(?P<part>[_-]LTR|_I-int|[_-]int|[_-]I)$", re.IGNORECASE)


def te_base_name(name: str) -> tuple[str, Optional[str]]:
    """``Roo_LTR`` -> (``Roo``, ``LTR``); ``Roo_I`` -> (``Roo``, ``I``); ``roo`` -> (``roo``, None)."""
    m = _LTR_SPLIT.match(name)
    if not m:
        return name, None
    part = m.group("part").lstrip("_-").upper()
    return m.group("base"), ("LTR" if part == "LTR" else "I")


def _full_slack(length: int) -> int:
    return max(FULL_SLACK_MIN, int(FULL_SLACK_FRAC * length))


def _component_length(info: Optional[dict], base: str, part: str, observed: int) -> int:
    """A Dfam LTR/internal component's full length from the library (else what the hits show)."""
    for name, meta in ((info or {}).get("families") or {}).items():
        b, p = te_base_name(name)
        if b == base and p == part and meta.get("length"):
            return int(meta["length"])
    return observed


def _overlap(a0: int, a1: int, b0: int, b1: int) -> int:
    return max(0, min(a1, b1) - max(a0, b0))


def _compatible(chain: list[dict], item: dict, strand: str) -> bool:
    """Whether a hit continues a chain collinearly: in order along the consensus and the
    element (reversed on the − strand), overlapping neither much."""
    for m in chain:
        qo = _overlap(item["qstart"], item["qend"], m["qstart"], m["qend"])
        eo = _overlap(item["estart"], item["eend"], m["estart"], m["eend"])
        short = max(1, min(item["qend"] - item["qstart"], m["qend"] - m["qstart"]))
        # Adjacent HSPs of one alignment can overlap at their junction (by up to half the
        # shorter); a hit matching the same bases again (the element's other LTR) overlaps fully.
        if qo > max(50, 0.5 * short) or eo > max(50, 0.5 * short):
            return False
        after_q = item["qstart"] >= m["qstart"]
        after_e = item["estart"] >= m["estart"]
        if (after_q == after_e) != (strand == "+"):
            return False
    return True


def _chains(items: list[dict], strand: str) -> list[list[dict]]:
    """Collinear chains (one per element copy), strongest first. A leftover hit whose
    consensus bases a stronger chain already explains (an LTR matching the element's other
    LTR, a second weaker alignment) is dropped."""
    remaining = sorted(items, key=lambda h: -h["bitscore"])
    chains: list[list[dict]] = []
    while remaining:
        seed = remaining.pop(0)
        explained = merge_intervals([(m["qstart"], m["qend"]) for c in chains for m in c])
        if union_length(subtract((seed["qstart"], seed["qend"]), explained)) < 0.5 * (seed["qend"] - seed["qstart"]):
            continue
        chain = [seed]
        for item in list(remaining):
            if _compatible(chain, item, strand):
                chain.append(item)
                remaining.remove(item)
        chains.append(sorted(chain, key=lambda h: h["qstart"]))
    return chains


def te_calls(hits: list[dict], info: Optional[dict], qlen: int, min_identity: float = FAMILY_MIN_IDENTITY) -> list[dict]:
    """TE family calls from library hits: one per collinear chain (element copy), best first."""
    fams: dict[tuple, list[dict]] = {}
    for h in hits:
        name, major, minor = te_library.split_class(h["subject"])
        base, part = te_base_name(name)
        h = {**h, "family": name, "base": base, "part": part, "class": major, "subclass": minor}
        fams.setdefault((base, h["strand"]), []).append(h)
    calls = []
    for (base, strand), group in fams.items():
        good = [h for h in group if h["identity"] >= min_identity]
        related = not good
        pool = good or group
        top = max(pool, key=lambda h: h["bitscore"])
        cls, sub = top["class"], top["subclass"]
        parts = {h["part"] for h in pool}
        features: list[dict] = []
        if parts == {"LTR"}:
            # Only the LTR matches: a solo LTR (or the LTR part of an element), on its own frame.
            elen = _component_length(info, base, "LTR", max(h["slen"] for h in pool))
            family = f"{base} (LTR)"
            items = [{**h, "estart": h["sstart"], "eend": h["send"]} for h in pool]
            features = [{"type": "LTR", "label": "LTR", "start": 0, "end": elen}]
        elif parts & {"LTR", "I"}:
            # Dfam LTR + internal: one element LTR | I | LTR, the components' full lengths from
            # the library, so a missing LTR or internal part stays missing.
            ltr_len = _component_length(info, base, "LTR", max((h["slen"] for h in pool if h["part"] == "LTR"), default=0))
            int_len = _component_length(info, base, "I", max((h["slen"] for h in pool if h["part"] == "I"), default=0))
            elen = int_len + 2 * ltr_len
            internal = [h for h in pool if h["part"] == "I"]
            best_i = max(internal, key=lambda h: h["bitscore"]) if internal else None
            mid_q = (best_i["qstart"] + best_i["qend"]) / 2 if best_i else qlen / 2
            items = []
            for h in pool:
                if h["part"] == "I":
                    off = ltr_len
                elif h["part"] == "LTR":
                    q_mid = (h["qstart"] + h["qend"]) / 2
                    five = (q_mid < mid_q) if strand == "+" else (q_mid > mid_q)
                    off = 0 if five else ltr_len + int_len
                else:
                    continue
                items.append({**h, "estart": h["sstart"] + off, "eend": h["send"] + off})
            family = base
            if ltr_len:
                features = [{"type": "LTR", "label": "5′ LTR", "start": 0, "end": ltr_len},
                            {"type": "LTR", "label": "3′ LTR", "start": ltr_len + int_len, "end": elen}]
        else:
            family = top["family"]
            elen = top["slen"]
            items = [{**h, "estart": h["sstart"], "eend": h["send"]} for h in pool if h["family"] == family]
            features = list(te_library.family_meta(info, family).get("features") or [])
        for chain in _chains(items, strand):
            e_ivals = [(h["estart"], h["eend"]) for h in chain]
            q_ivals = [(h["qstart"], h["qend"]) for h in chain]
            e_lo, e_hi = min(a for a, _ in e_ivals), max(b for _, b in e_ivals)
            coverage = union_length(e_ivals) / max(1, elen)
            slack = _full_slack(elen)
            five_missing, three_missing = e_lo, max(0, elen - e_hi)
            if five_missing <= slack and three_missing <= slack:
                completeness = "full length" if coverage >= 0.8 else "internally deleted"
            elif five_missing > slack and three_missing <= slack:
                completeness = "5′-truncated"
            elif three_missing > slack and five_missing <= slack:
                completeness = "3′-truncated"
            else:
                completeness = "internal fragment"
            aligned = sum(h["length"] for h in chain)
            identity = sum(h["identity"] * h["length"] for h in chain) / max(1, aligned)
            calls.append({
                "family": family, "class": cls, "subclass": sub,
                "class_label": f"{cls}/{sub}" if sub else cls,
                "strand": strand, "identity": round(identity, 2),
                "query": merge_intervals(q_ivals, gap=30),
                "qstart": min(a for a, _ in q_ivals), "qend": max(b for _, b in q_ivals),
                "element_length": elen, "element_start": e_lo, "element_end": e_hi,
                "element_coverage": round(coverage, 4),
                "query_coverage": round(union_length(q_ivals) / max(1, qlen), 4),
                "completeness": completeness, "five_missing": five_missing, "three_missing": three_missing,
                "bitscore": round(sum(h["bitscore"] for h in chain), 1),
                "evalue": min((h["evalue"] for h in chain if h["evalue"] is not None), default=None),
                "related": related,
                "features": features,
                "hsps": [{"qstart": h["qstart"], "qend": h["qend"], "estart": h["estart"], "eend": h["eend"],
                          "identity": h["identity"], "evalue": h["evalue"], "bitscore": h["bitscore"],
                          "family": h["family"]} for h in chain],
                "description": te_library.family_meta(info, top["family"]).get("description", ""),
            })
    calls.sort(key=lambda c: (c["related"], -c["bitscore"]))
    return calls


def map_features(call: dict) -> list[dict]:
    """The element's features (LTRs, ORFs) placed on the consensus through every HSP of the
    call's collinear chain that covers them."""
    out = []
    for f in call.get("features") or []:
        qs, covered = [], []
        for h in call["hsps"]:
            lo, hi = max(f["start"], h["estart"]), min(f["end"], h["eend"])
            if hi <= lo:
                continue
            hit = {"qstart": h["qstart"], "qend": h["qend"], "sstart": h["estart"], "send": h["eend"],
                   "strand": call["strand"]}
            qs += [subject_to_query(hit, lo), subject_to_query(hit, hi)]
            covered.append((lo, hi))
        if not qs:
            continue
        q0, q1 = min(qs), max(qs)
        if q1 - q0 < 10:
            continue
        out.append({"type": f["type"], "label": f["label"], "qstart": q0, "qend": q1,
                    "partial": union_length(covered) < (f["end"] - f["start"]) - 20})
    return out


_POLY_A = re.compile(r"A{4,}(?:[CGT]?A{3,})*")


def poly_a(seq: str, call: dict, min_run: int = 8, reach: int = 30) -> Optional[dict]:
    """An A-rich tail at the element's 3′ end (T-rich before it on the − strand): a run of
    at least ``min_run`` A (single mismatches allowed) starting within ``reach`` bases of
    where the alignment ends (aligners often stop a few bases short)."""
    seq = seq.upper()
    if call["strand"] == "+":
        lo, hi = max(0, call["qend"] - reach), min(len(seq), call["qend"] + reach)
        text, base = seq[lo:hi + 60], lo
    else:
        rc = seq[::-1].translate(str.maketrans("ACGT", "TGCA"))
        end_rc = len(seq) - call["qstart"]
        lo, hi = max(0, end_rc - reach), min(len(seq), end_rc + reach)
        text, base = rc[lo:hi + 60], lo
    for m in _POLY_A.finditer(text):
        if m.start() > hi - base:
            break
        if m.end() - m.start() >= min_run:
            s0, s1 = base + m.start(), base + m.end()
            if call["strand"] == "+":
                return {"qstart": s0, "qend": s1}
            return {"qstart": len(seq) - s1, "qend": len(seq) - s0}
    return None


def target_site_duplication(seq: str, left: str, right: str, max_len: int = 30) -> Optional[dict]:
    """The longest k in 2..max_len where the insert starts with the reference just right of the
    site (``right[:k]``) or ends with the reference just left of it (``left[-k:]``): the
    duplicated target site, whichever side the aligner placed it on."""
    seq, left, right = seq.upper(), left.upper(), right.upper()
    best = None
    for k in range(2, min(max_len, len(seq), max(len(left), len(right))) + 1):
        if len(right) >= k and seq[:k] == right[:k]:
            best = {"length": k, "seq": seq[:k], "side": "start", "qstart": 0, "qend": k}
        if len(left) >= k and seq[-k:] == left[-k:]:
            if best is None or best["length"] < k:
                best = {"length": k, "seq": seq[-k:], "side": "end", "qstart": len(seq) - k, "qend": len(seq)}
    if best is None:
        return None
    best["confident"] = best["length"] >= 4
    return best


# ---------------------------------------------------------------------------
# rmsk (UCSC), an opt-in naming step: coordinates only

_rmsk_cache: dict[tuple, list[dict]] = {}


def fetch_rmsk(genome: str, chrom: str, start: int, end: int, *, opener=None, timeout: float = 15) -> Optional[list[dict]]:
    key = (genome, chrom, start, end)
    if key in _rmsk_cache:
        return _rmsk_cache[key]
    opener = opener or urllib.request.urlopen
    url = ("https://api.genome.ucsc.edu/getData/track?"
           + urllib.parse.urlencode({"genome": genome, "track": "rmsk", "chrom": chrom, "start": start, "end": end}))
    try:
        with opener(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    items = raw.get("rmsk", [])
    if isinstance(items, dict):
        items = items.get(chrom, [])
    out = []
    for item in items if isinstance(items, list) else []:
        try:
            out.append({"start": int(item["genoStart"]), "end": int(item["genoEnd"]), "name": str(item.get("repName", "")),
                        "class": str(item.get("repClass", "")), "family": str(item.get("repFamily", "")),
                        "strand": str(item.get("strand", ""))})
        except (KeyError, TypeError, ValueError):
            continue
    _rmsk_cache[key] = out
    return out


def rmsk_name(intervals: list[dict], start: int, end: int) -> Optional[dict]:
    """The RepeatMasker family covering most of ``[start, end)`` (LTR/internal parts joined)."""
    cover: dict[tuple, int] = {}
    for iv in intervals:
        ov = min(end, iv["end"]) - max(start, iv["start"])
        if ov <= 0 or iv["class"] in ("Simple_repeat", "Low_complexity"):
            continue
        base = te_base_name(iv["name"])[0]
        key = (base, iv["class"], iv["family"])
        cover[key] = cover.get(key, 0) + ov
    if not cover:
        return None
    (name, cls, fam), bp = max(cover.items(), key=lambda kv: kv[1])
    return {"name": name, "class": cls, "family": fam, "class_label": f"{cls}/{fam}" if fam and fam != cls else cls,
            "fraction": round(bp / max(1, end - start), 3)}


# ---------------------------------------------------------------------------
# Segments: the consensus tiled by its best explanations (table + cartoon)

_PRIORITY = {"te": 0, "polyA": 1, "gene": 2, "local": 3, "repeat": 4, "genomic": 5}


def tile_segments(seq: str, *, te: list[dict], genes: list[dict], stretches: list[dict], tsd: Optional[dict]) -> list[dict]:
    qlen = len(seq)
    cands = []
    for c in te:
        if c["related"]:
            continue
        for q0, q1 in c["query"]:
            cands.append({"kind": "te", "qstart": q0, "qend": q1, "score": c["bitscore"], "ref": c})
        pa = poly_a(seq, c)
        if pa:  # the element's own tail, before any genome copy (they carry tails too)
            cands.append({"kind": "polyA", "qstart": pa["qstart"], "qend": pa["qend"], "score": 0, "ref": None})
    for g in genes:
        for q0, q1 in g["query"]:
            cands.append({"kind": "gene", "qstart": q0, "qend": q1, "score": g["exonic_bp"] + g["intronic_bp"] + g.get("body_bp", 0),
                          "ref": g})
    for s in stretches:
        cands.append({"kind": s["kind"], "qstart": s["qstart"], "qend": s["qend"], "score": s.get("bitscore", 0), "ref": s})
    cands.sort(key=lambda c: (_PRIORITY[c["kind"]], -c["score"]))
    taken: list[list[int]] = []
    segments = []
    for c in cands:
        for s, e in subtract((c["qstart"], c["qend"]), taken):
            if e - s < (6 if c["kind"] == "polyA" else MIN_SEGMENT):
                continue
            segments.append({"kind": c["kind"], "qstart": s, "qend": e, "ref": c["ref"]})
            taken = merge_intervals(taken + [[s, e]])
    if tsd and tsd.get("confident"):
        # The duplicated target site is flank, not element: trim what overlaps it.
        trimmed = []
        for seg in segments:
            for s, e in subtract((seg["qstart"], seg["qend"]), [[tsd["qstart"], tsd["qend"]]]):
                if e - s >= MIN_SEGMENT or (e - s > 0 and seg["qend"] - seg["qstart"] < MIN_SEGMENT):
                    trimmed.append({**seg, "qstart": s, "qend": e})
        segments = trimmed
        taken = merge_intervals([[seg["qstart"], seg["qend"]] for seg in segments] + [[tsd["qstart"], tsd["qend"]]])
        segments.append({"kind": "tsd", "qstart": tsd["qstart"], "qend": tsd["qend"], "ref": None})
    for s, e in subtract((0, qlen), taken):
        if e - s >= 5:  # a few unmatched bases at an alignment edge are not a segment
            segments.append({"kind": "unknown", "qstart": s, "qend": e, "ref": None})
    segments.sort(key=lambda s: s["qstart"])
    return segments


def _describe_segment(seg: dict) -> dict:
    ref = seg.pop("ref", None)
    kind = seg["kind"]
    if kind == "te":
        seg.update({"label": ref["family"], "class": ref["class"], "class_label": ref["class_label"],
                    "strand": ref["strand"], "identity": ref["identity"], "completeness": ref["completeness"]})
    elif kind == "gene":
        exons = ref["exons"]
        ex = (f"exon {exons[0]}" if len(exons) == 1 else f"exons {exons[0]}–{exons[-1]}") if exons else "intron"
        if ref["region"] == "gene":
            ex = "gene body (no exon annotation)"
        seg.update({"label": f"{ref['gene']} {ex}", "gene": ref["gene"], "identity": ref["identity"],
                    "strand": ref.get("orientation", ref["strand"]), "spliced": ref["spliced"]})
    elif kind in ("local", "repeat", "genomic"):
        seg.update({"label": ref.get("label", kind), "identity": ref.get("identity"), "strand": ref.get("strand"),
                    "copies": ref.get("copies"), "class": ref.get("class")})
    elif kind == "tsd":
        seg["label"] = "TSD"
    elif kind == "polyA":
        seg["label"] = "poly(A)"
    else:
        seg["label"] = "no match"
    return seg


# ---------------------------------------------------------------------------
# The whole identification


def _stretches_from_loci(loci: list[dict], qlen: int, *, chrom, ref, rmsk_names: dict) -> tuple[list[dict], list[dict]]:
    """Genome-only explanations: local duplications, repeat families (several loci) and
    unique genomic matches, per consensus stretch."""
    stretches = []
    if not loci:
        return stretches, []
    cover_counts = []
    local = [l for l in loci if l.get("near_site") is not None]
    for l in local[:3]:
        for a, b in l.get("qivals") or [[l["qstart"], l["qend"]]]:
            stretches.append({"kind": "local", "qstart": a, "qend": b, "bitscore": l["bitscore"],
                              "identity": l["identity"], "strand": l["strand"],
                              "label": f"local copy {l['near_site']:,} bp from the site" if l["near_site"] else "copy at the site"})
    # Stretches: runs of the consensus by how many loci cover each base (none / a few / a
    # repeat's many), runs shorter than MIN_SEGMENT absorbed into the run before them.
    depth = [0] * (qlen + 1)
    for l in loci:
        for a, b in l.get("qivals") or [[l["qstart"], l["qend"]]]:
            depth[max(0, a)] += 1
            depth[min(qlen, b)] -= 1
    runs: list[list] = []
    cur = 0
    for i in range(qlen):
        cur += depth[i]
        kind = "none" if cur == 0 else ("repeat" if cur > GENE_MAX_LOCI else "few")
        if runs and runs[-1][3] == kind:
            runs[-1][1] = i + 1
            runs[-1][2] = max(runs[-1][2], cur)
        else:
            runs.append([i, i + 1, cur, kind])
    merged: list[list] = []
    for run in runs:
        if merged and (run[1] - run[0] < MIN_SEGMENT or merged[-1][3] == run[3]):
            merged[-1][1] = run[1]
            merged[-1][2] = max(merged[-1][2], run[2])
        else:
            merged.append(run)
    # A short first run joins the next one.
    if len(merged) > 1 and merged[0][1] - merged[0][0] < MIN_SEGMENT:
        merged[1][0] = merged[0][0]
        merged.pop(0)
    for a, b, n, kind in merged:
        if kind == "none":
            continue
        covering = [l for l in loci if any(x < b and y > a for x, y in l.get("qivals") or [[l["qstart"], l["qend"]]])]
        best = covering[0] if covering else None
        name = None
        for l in covering[:5]:
            name = rmsk_names.get(_locus_key(l))
            if name:
                break
        n = sum(1 for l in covering
                if sum(_overlap(a, b, x, y) for x, y in l.get("qivals") or [[l["qstart"], l["qend"]]]) >= 0.5 * (b - a)) or n
        if kind == "repeat":
            label = f"{name['name']} ({name['class_label']}) by RepeatMasker" if name else "repeat (no family named)"
            stretches.append({"kind": "repeat", "qstart": a, "qend": b, "copies": n, "label": label,
                              "identity": best["identity"] if best else None,
                              "class": name["class"] if name else None, "bitscore": sum(l["bitscore"] for l in covering[:20])})
        else:
            label = f"{best['chrom']}:{best['start'] + 1:,}" if best else "genomic"
            if name:
                label += f" ({name['name']}, {name['class_label']})"
            stretches.append({"kind": "genomic", "qstart": a, "qend": b, "copies": n, "label": label,
                              "identity": best["identity"] if best else None, "strand": best["strand"] if best else None,
                              "bitscore": best["bitscore"] if best else 0})
        cover_counts.append({"qstart": a, "qend": b, "loci": n})
    return stretches, cover_counts


def _locus_key(locus: dict) -> str:
    return f"{locus['chrom']}:{locus['start']}-{locus['end']}:{locus['strand']}"


def _family_key(call: dict) -> str:
    """A TE call's family, the same for its LTR-only and whole-element calls ("roo (LTR)" and "roo")."""
    return re.sub(r"\s*\(LTR\)$", "", str(call.get("family") or "")).strip().lower()


def _query_overlap(a: dict, b: dict) -> float:
    """The share of the shorter call's insert bases the other call covers too."""
    ia = [tuple(iv) for iv in a.get("query") or [(a["qstart"], a["qend"])]]
    ib = [tuple(iv) for iv in b.get("query") or [(b["qstart"], b["qend"])]]
    shared = sum(max(0, min(x1, y1) - max(x0, y0)) for x0, x1 in ia for y0, y1 in ib)
    shorter = min(union_length(ia), union_length(ib))
    return shared / shorter if shorter > 0 else 0.0


def _confident(identity: Optional[float], qcov: Optional[float]) -> bool:
    return (identity or 0) >= VERDICT_MIN_IDENTITY and (qcov or 0) >= VERDICT_MIN_QUERY_COVERAGE


def _rmsk_candidate(loci: list) -> Optional[dict]:
    """RepeatMasker's most frequent name among the qualifying loci that carry one (with the best such locus)."""
    named = [l for l in loci if l.get("rmsk") and l["rmsk"].get("name")]
    if not named:
        return None
    votes: dict[str, int] = {}
    for l in named:
        votes[l["rmsk"]["name"]] = votes.get(l["rmsk"]["name"], 0) + 1
    name = max(votes, key=lambda n: (votes[n], -next(i for i, l in enumerate(named) if l["rmsk"]["name"] == n)))
    best = next(l for l in named if l["rmsk"]["name"] == name)
    return {"name": name, "class_label": best["rmsk"].get("class_label") or "", "loci": votes[name], "locus": best}


def verdict(result: dict) -> dict:
    """How sure the result is (module constants above): ``status`` candidate / ambiguous / no_match, the source of
    the best candidate (te, gene, repeatmasker, genome), the candidates' names, a reason and the thresholds used.
    The best candidate is the best-ranked one that passes the minimums (a higher-scoring one that doesn't is not it);
    ambiguity is among the ones that pass."""
    thresholds = {"min_identity": VERDICT_MIN_IDENTITY, "min_query_coverage": VERDICT_MIN_QUERY_COVERAGE,
                  "ambiguous_bitscore_fraction": AMBIGUOUS_BITSCORE_FRACTION,
                  "ambiguous_min_overlap": AMBIGUOUS_MIN_OVERLAP}
    out = {"thresholds": thresholds}
    te = [c for c in result["te"]["calls"] if not c["related"]]
    qualifying = [c for c in te if _confident(c["identity"], c["query_coverage"])]
    if qualifying:
        top = qualifying[0]
        rivals = []
        for c in qualifying[1:]:
            if _family_key(c) == _family_key(top) or any(_family_key(c) == _family_key(r) for r in rivals):
                continue
            if c["bitscore"] >= (1 - AMBIGUOUS_BITSCORE_FRACTION) * top["bitscore"] and _query_overlap(top, c) >= AMBIGUOUS_MIN_OVERLAP:
                rivals.append(c)
        if rivals:
            names = [top["family"], *(c["family"] for c in rivals)]
            return {**out, "status": "ambiguous", "source": "te", "candidates": names,
                    "reason": f"{len(names)} TE families score within {AMBIGUOUS_BITSCORE_FRACTION:.0%} of each other "
                              "over the same bases"}
        return {**out, "status": "candidate", "source": "te", "candidates": [top["family"]],
                "reason": f"{top['identity']:.1f}% identity over {top['query_coverage']:.0%} of the insert"}
    genome = result["genome"]
    for g in genome.get("genes") or []:
        if g.get("region") != "exon":
            continue
        covered = union_length([tuple(iv) for iv in g.get("query") or []]) / max(1, result["length"])
        if _confident(g.get("identity"), covered):
            return {**out, "status": "candidate", "source": "gene", "candidates": [g["gene"]],
                    "reason": f"exonic match at {g['identity']:.1f}% identity over {covered:.0%} of the insert"}
    loci = [l for l in genome.get("loci") or [] if _confident(l.get("identity"), l.get("qcov"))]
    rm = _rmsk_candidate(loci)
    if rm:
        return {**out, "status": "candidate", "source": "repeatmasker", "candidates": [rm["name"]],
                "reason": f"RepeatMasker's name for {rm['loci']:,} genome cop{'y' if rm['loci'] == 1 else 'ies'} that pass "
                          "the minimums"}
    if loci:
        best = loci[0]
        return {**out, "status": "candidate", "source": "genome", "candidates": [f"{best['chrom']}:{best['start'] + 1:,}"],
                "reason": f"{best['identity']:.1f}% identity over {best['qcov']:.0%} of the insert"}
    top = te[0] if te else None
    if top is not None:
        reason = (f"the closest library family, {top['family']}, has {top['identity']:.1f}% identity over "
                  f"{top['query_coverage']:.0%} of the insert")
    elif result["te"]["calls"]:
        c = result["te"]["calls"][0]
        reason = f"the closest library family, {c['family']}, is below {VERDICT_MIN_IDENTITY:.0f}% identity"
    elif genome.get("loci"):
        l = genome["loci"][0]
        reason = f"the best genome match has {l['identity']:.1f}% identity over {l['qcov']:.0%} of the insert"
    else:
        reason = "no match in the genome" + (" or the TE library" if result["te"]["library"] else "")
    return {**out, "status": "no_match", "source": None, "candidates": [],
            "reason": f"{reason} (a candidate needs ≥ {VERDICT_MIN_IDENTITY:.0f}% identity over "
                      f"≥ {VERDICT_MIN_QUERY_COVERAGE:.0%} of the insert)"}


def summarise(result: dict) -> str:
    """One line: the best candidate for what the insertion is (the one ``verdict`` chose), or that there is none."""
    v = result.get("verdict") or verdict(result)
    if v["status"] == "no_match":
        weak = result["te"]["calls"] or result["genome"].get("loci")
        return f"No confident match: {v['reason']}" if weak else f"No confident match: {_describe(result)}"
    if v["status"] == "ambiguous":
        te = [c for c in result["te"]["calls"] if not c["related"]]
        named = [next(c for c in te if c["family"] == name) for name in v["candidates"] if any(c["family"] == name for c in te)]
        alts = " or ".join(f"{c['family']} ({c['class_label']}, {c['identity']:.1f}%)" for c in named)
        return f"Ambiguous: {alts}; scores within {AMBIGUOUS_BITSCORE_FRACTION:.0%} over the same bases"
    return f"Best candidate: {_describe(result, v)}"


def _describe(result: dict, v: Optional[dict] = None) -> str:
    """What the best match says the insertion is: the verdict's candidate when given (its source and name), else the
    best match of any kind."""
    qlen = result["length"]
    te = [c for c in result["te"]["calls"] if not c["related"]]
    source = v.get("source") if v else None
    name = (v.get("candidates") or [None])[0] if v else None
    if source == "te":
        te = [c for c in te if c["family"] == name][:1] + [c for c in te if c["family"] != name]
    if te and source in (None, "te"):
        top = te[0]
        parts = [f"{top['family']} ({top['class_label']})", f"{top['identity']:.1f}% identity", top["completeness"],
                 f"{'−' if top['strand'] == '-' else '+'} strand"]
        if top["query_coverage"] < 0.9:
            parts.append(f"{top['query_coverage'] * 100:.0f}% of the insert")
        line = ", ".join(parts)
        others = [c for c in te[1:] if c["query_coverage"] >= 0.1]
        if others:
            line += " + " + ", ".join(f"{c['family']} ({c['class_label']})" for c in others[:2])
        genes = [g for g in result["genome"]["genes"] if g["region"] == "exon"]
        if genes:
            line += f"; also matches {genes[0]['gene']}"
        return line
    genes = [g for g in result["genome"]["genes"] if g["region"] == "exon"]
    if source == "gene":
        genes = [g for g in genes if g["gene"] == name][:1]
    if genes and source in (None, "gene"):
        g = genes[0]
        q = g["query"]
        ex = f"exon {g['exons'][0]}" if len(g["exons"]) == 1 else f"exons {g['exons'][0]}–{g['exons'][-1]}"
        kind = "spliced copy (retrocopy/cDNA) of" if g["spliced"] else "gene fragment:"
        return (f"{kind} {g['gene']} {ex}, bases {q[0][0] + 1:,}–{q[-1][1]:,} at {g['identity']:.1f}%")
    copies = result["genome"]["copies"]
    if source == "repeatmasker":
        rm = _rmsk_candidate([l for l in result["genome"]["loci"] if _confident(l.get("identity"), l.get("qcov"))])
        if rm:
            return (f"{rm['name']} ({rm['class_label']}) by RepeatMasker on {rm['loci']:,} reference cop"
                    f"{'y' if rm['loci'] == 1 else 'ies'} at {rm['locus']['identity']:.1f}% identity; {copies:,} copies in the genome")
    if source == "genome":
        best = next((l for l in result["genome"]["loci"] if _confident(l.get("identity"), l.get("qcov"))), None)
        if best and best.get("near_site") is not None:
            return f"a local duplication: matches the reference {best['near_site']:,} bp from the site"
        if best and copies > GENE_MAX_LOCI:
            return f"a repeat: {copies:,} copies in the genome (no library family; download a TE library to name it)"
        if best:
            return (f"matches {best['chrom']}:{best['start'] + 1:,}–{best['end']:,} at {best['identity']:.1f}% "
                    f"({best['qcov'] * 100:.0f}% of the insert)")
    rm = result["genome"].get("rmsk_family")
    if rm:
        return f"{rm['name']} ({rm['class_label']}) by RepeatMasker on the reference copies; {copies:,} copies in the genome"
    if copies > GENE_MAX_LOCI:
        return f"a repeat: {copies:,} copies in the genome (no library family; download a TE library to name it)"
    local = [l for l in result["genome"]["loci"] if l.get("near_site") is not None]
    if local:
        return f"a local duplication: matches the reference {local[0]['near_site']:,} bp from the site"
    if result["genome"]["loci"]:
        l = result["genome"]["loci"][0]
        return f"matches {l['chrom']}:{l['start'] + 1:,}–{l['end']:,} at {l['identity']:.1f}% ({l['qcov'] * 100:.0f}% of the insert)"
    return f"novel sequence: no match in the genome{' or the TE library' if result['te']['library'] else ''} ({qlen:,} bp)"


def report_text(result: dict) -> str:
    lines = [f"Insertion {result.get('chrom') or ''}:{(result.get('ref') or 0) + 1:,} "
             f"+{result['length']:,} bp (consensus sha256 {result['seq_sha256'][:12]})",
             f"Summary: {result['summary']}"]
    v = result.get("verdict")
    if v:
        t = v["thresholds"]
        lines.append(f"Verdict: {v['status'].replace('_', ' ')} ({v['reason']}); a candidate needs >= {t['min_identity']:.0f}% "
                     f"identity over >= {t['min_query_coverage']:.0%} of the insert; ambiguous: another family within "
                     f"{t['ambiguous_bitscore_fraction']:.0%} of the best bitscore over the same bases")
    if result.get("tool"):
        lines.append(f"Search: {result['tool']['label']}")
    lines.append("")
    lib = result["te"].get("library")
    lines.append(f"Known TEs ({lib['label']}, {lib['licence']}):" if lib else "Known TEs: no TE library downloaded")
    for c in result["te"]["calls"][:10]:
        tag = " [related, <80% identity]" if c["related"] else ""
        lines.append(f"  {c['family']} ({c['class_label']}) {c['strand']} {c['identity']:.1f}% identity, "
                     f"element {c['element_start'] + 1:,}–{c['element_end']:,} of {c['element_length']:,} "
                     f"({c['element_coverage'] * 100:.0f}%), {c['completeness']}, "
                     f"insert {c['qstart'] + 1:,}–{c['qend']:,}{tag}")
    g = result["genome"]
    lines += ["", f"Genome ({result['engine']}): {g['n_loci']:,} loci, {g['copies']:,} covering ≥50% of the insert"
              + (" (capped)" if g.get("capped") else "")]
    for l in g["loci"][:15]:
        rm = l.get("rmsk")
        lines.append(f"  {l['chrom']}:{l['start'] + 1:,}–{l['end']:,} ({l['strand']}) {l['identity']:.1f}% "
                     f"cov {l['qcov'] * 100:.0f}%" + (f" e={l['evalue']:.1e}" if l.get("evalue") is not None else "")
                     + (f" near site ({l['near_site']:,} bp)" if l.get("near_site") is not None else "")
                     + (f" rmsk {rm['name']} ({rm['class_label']})" if rm else ""))
    for gene in g["genes"]:
        ex = ", ".join(map(str, gene["exons"])) or "–"
        q = "; ".join(f"{a + 1:,}–{b:,}" for a, b in gene["query"])
        lines.append(f"  gene {gene['gene']} ({gene['transcript']}) {gene['region']}, exons {ex} of {gene['n_exons']}: "
                     f"insert bases {q} at {gene['identity']:.1f}%" + (", spliced (retrocopy)" if gene["spliced"] else ""))
    if result.get("tsd"):
        t = result["tsd"]
        lines.append(f"\nTarget-site duplication: {t['seq']} ({t['length']} bp){'' if t['confident'] else ' (too short to be sure)'}")
    lines += ["", "Segments:"]
    for s in result["segments"]:
        lines.append(f"  {s['qstart'] + 1:,}–{s['qend']:,} {s['label']}")
    return "\n".join(lines)


def identify(seq: str, state=None, *, chrom: Optional[str] = None, ref: Optional[int] = None,
             genome: Optional[str] = None, library_id: Optional[str] = None, engine: str = "auto",
             rmsk: bool = False, genome_db: Optional[str] = None, genome_target: Optional[str] = None,
             gtf_data=None, fetch_flanks: Optional[Callable[[int], tuple[str, str]]] = None,
             runner: Optional[_Runner] = None, progress: Optional[ProgressFn] = None,
             rmsk_opener=None, coordinate_genome: Optional[str] = None) -> dict:
    """Identify ``seq`` (an insertion consensus). ``state``: the browser state (genome, FASTA,
    annotation); tests pass ``genome_db``/``genome_target``, ``gtf_data`` and ``fetch_flanks``.
    ``genome``: the species (TE library); ``coordinate_genome``: the assembly whose coordinates the
    reference's are (UCSC rmsk), never a genome merely declared for a custom FASTA."""
    runner = runner or _Runner()
    progress = progress or (lambda message, fraction: None)
    seq = re.sub(r"\s+", "", seq or "").upper()
    if not seq:
        raise IdentifyError("No consensus to identify.")
    if len(seq) > MAX_QUERY:
        raise IdentifyError(f"The consensus is longer than {MAX_QUERY:,} bp.")
    if re.search(r"[^ACGTNRYKMSWBDHV]", seq):
        raise IdentifyError("The consensus has characters that are not bases.")
    qlen = len(seq)
    engine = choose_engine(engine)
    genome = genome or (_reference_genome(state) if state is not None else None)
    if coordinate_genome is None:
        coordinate_genome = _coordinate_genome(state) if state is not None else genome
    started = time.perf_counter()

    # 1. Known TEs (the library, local)
    info = te_library.active_library(genome, library_id) if (library_id or genome) else None
    te_hits: list[dict] = []
    if info is not None:
        progress(f"Searching {info['label']}", 0.15)
        lib_db = te_library.ensure_library_blast_db(info) if engine == "blast" else None
        if lib_db:
            te_hits = run_blastn(seq, lib_db, task="dc-megablast", runner=runner, evalue=1e-10, max_target_seqs=50)
        else:
            te_hits = run_minimap2(seq, info["fasta"], runner=runner, preset="asm20", secondary=50)
    calls = te_calls(te_hits, info, qlen)

    # 2. Genome
    progress("Searching the genome", 0.35)
    capped = False
    if engine == "blast":
        db = genome_db or genome_blast_db(state, runner=runner, progress=progress)
        hits = run_blastn(seq, db, task="megablast", runner=runner, evalue=1e-10, max_target_seqs=5000,
                          max_hsps=2000, perc_identity=80)
        per_subject: dict[str, int] = {}
        for h in hits:
            per_subject[h["subject"]] = per_subject.get(h["subject"], 0) + 1
        capped = any(n >= 2000 for n in per_subject.values())
    else:
        target = genome_target or genome_minimap2_index(state, runner=runner, progress=progress)
        hits = run_minimap2(seq, target, runner=runner, preset="asm20", secondary=1000)
        capped = len(hits) >= 1000
    runner.check()
    progress("Interpreting the hits", 0.7)
    loci = build_loci(hits, qlen)
    for l in loci:
        d = near_site(l, chrom, ref)
        l["near_site"] = d
    copies = sum(1 for l in loci if l["qcov"] >= COPY_QCOV)

    # 3. rmsk names for the best loci (opt-in; coordinates only)
    rmsk_names: dict[str, dict] = {}
    rmsk_family = None
    rmsk_status = "off"
    if rmsk and not coordinate_genome:
        rmsk_status = "unavailable"   # no verified coordinate assembly (a custom FASTA): nothing to look up
    if rmsk and coordinate_genome:
        progress("Naming reference copies (UCSC RepeatMasker)", 0.75)
        rmsk_status = "ok"
        picked = loci[:6] + [l for l in loci[6:] if l["near_site"] is not None][:2]
        votes: dict[tuple, int] = {}
        for l in picked:
            runner.check()
            intervals = fetch_rmsk(coordinate_genome, l["chrom"], l["start"], l["end"], opener=rmsk_opener)
            if intervals is None:
                rmsk_status = "unavailable"
                break
            name = rmsk_name(intervals, l["start"], l["end"])
            if name:
                l["rmsk"] = name
                rmsk_names[_locus_key(l)] = name
                if l["qcov"] >= COPY_QCOV:
                    key = (name["name"], name["class_label"], name["class"])
                    votes[key] = votes.get(key, 0) + 1
        if votes:
            (n, cl, c), _ = max(votes.items(), key=lambda kv: kv[1])
            rmsk_family = {"name": n, "class_label": cl, "class": c, "loci": votes[(n, cl, c)]}

    # 4. Genes, for stretches that few loci explain and no TE covers
    gtf = gtf_data if gtf_data is not None else (getattr(state, "gtf_data", None) if state is not None else None)
    te_cover = merge_intervals([iv for c in calls if not c["related"] for iv in c["query"]])
    stretches, cover = _stretches_from_loci(loci, qlen, chrom=chrom, ref=ref, rmsk_names=rmsk_names)
    few_blocks = [(s["qstart"], s["qend"]) for s in stretches if s["kind"] == "genomic"]
    gene_hsps = []
    for l in loci:
        if l["near_site"] is not None and l["near_site"] == 0 and l["qcov"] < 0.05:
            continue
        for h in l["hsps"]:
            uncovered = union_length(subtract((h["qstart"], h["qend"]), te_cover))
            in_few = any(min(h["qend"], b) - max(h["qstart"], a) > 0.5 * (h["qend"] - h["qstart"]) for a, b in few_blocks)
            if in_few and uncovered >= 0.5 * (h["qend"] - h["qstart"]):
                gene_hsps.append(h)
    genes = gene_overlaps(gene_hsps, gtf) if gtf is not None else []

    # 5. TSD and segments
    tsd = None
    if fetch_flanks is None and state is not None and chrom is not None and ref is not None:
        fetch_flanks = _state_flank_fetcher(state, chrom, ref)
    if fetch_flanks is not None:
        try:
            left, right = fetch_flanks(40)
            tsd = target_site_duplication(seq, left, right)
        except Exception:
            tsd = None
    segments = [_describe_segment(s) for s in tile_segments(seq, te=calls, genes=genes, stretches=stretches, tsd=tsd)]
    for c in calls:
        c["mapped_features"] = map_features(c) if not c["related"] else []
        pa = poly_a(seq, c) if not c["related"] else None
        c["poly_a"] = pa

    result = {
        "schema": SCHEMA, "length": qlen, "seq_sha256": hashlib.sha256(seq.encode()).hexdigest(),
        "chrom": chrom, "ref": ref, "genome": None, "engine": "BLAST+ megablast / dc-megablast" if engine == "blast"
        else "minimap2 asm20",
        "masking": "DUST low-complexity masking (BLAST)" if engine == "blast" else "minimap2 default (no low-complexity masking)",
        "te": {
            "library": {k: info[k] for k in ("id", "label", "source", "licence", "licence_url", "citation", "version",
                                             "homepage") if k in info} if info else None,
            "calls": calls[:20],
        },
        "tsd": tsd,
        "segments": segments,
        "seconds": None,
    }
    result["genome"] = {
        "assembly": genome, "loci": [_slim_locus(l) for l in loci[:200]], "n_loci": len(loci), "copies": copies,
        "capped": capped, "genes": genes, "rmsk": rmsk_status, "rmsk_family": rmsk_family, "cover": cover,
    }
    result["genome"]["reference_copies"] = reference_copies(result["genome"])
    # Which program produced this result (shown with it, whatever is installed later).
    from services.external_tools import resolve
    used = resolve("blastn" if engine == "blast" else "minimap2")
    result["tool"] = {"name": used.name, "version": used.version, "path": used.path,
                      "label": f"{'BLAST+' if engine == 'blast' else 'minimap2'} {used.version or ''} ({used.path})".replace("  ", " ")}
    result["verdict"] = verdict(result)
    result["summary"] = summarise(result)
    result["report"] = report_text(result)
    result["seconds"] = round(time.perf_counter() - started, 2)
    progress("Done", 1.0)
    return result


# "Open the reference copies": at most this many, the insert's best genome copies.
REFERENCE_COPIES_MAX = 16


def reference_copies(genome: Optional[dict], n: int = REFERENCE_COPIES_MAX) -> list:
    """The insert's best copies in the reference genome, for opening as panels beside its carriers: loci
    covering at least COPY_QCOV of the insert, not at the insertion site itself (``near_site``), one per
    place (overlapping loci: the best-scoring one), best first (bitscore, then identity). Each is
    ``{chrom, start, end, strand, identity, qcov, rmsk?}`` (0-based, end exclusive)."""
    loci = list((genome or {}).get("loci") or [])
    picked: list = []
    for l in sorted(loci, key=lambda x: (-float(x.get("bitscore") or 0), -float(x.get("identity") or 0))):
        if float(l.get("qcov") or 0) < COPY_QCOV or l.get("near_site") is not None:
            continue
        if any(p["chrom"] == l["chrom"] and p["start"] < l["end"] and l["start"] < p["end"] for p in picked):
            continue
        picked.append({k: l[k] for k in ("chrom", "start", "end", "strand", "identity", "qcov") if k in l}
                      | ({"rmsk": l["rmsk"]} if l.get("rmsk") else {}))
        if len(picked) >= max(0, int(n)):
            break
    return picked


def _slim_locus(l: dict) -> dict:
    out = {k: l[k] for k in ("chrom", "strand", "start", "end", "qstart", "qend", "qcov", "identity", "evalue",
                              "bitscore", "near_site") if k in l}
    if l.get("rmsk"):
        out["rmsk"] = l["rmsk"]
    out["n_hsps"] = len(l["hsps"])
    return out


def _state_flank_fetcher(state, chrom: str, ref: int):
    fasta = getattr(state, "fasta", None)
    if fasta is None and getattr(state, "fasta_path", None):
        try:
            from services.fasta_handles import get_fasta_handle
            fasta = get_fasta_handle(state.fasta_path)
        except Exception:
            fasta = None
    if fasta is None:
        return None

    def fetch(n: int) -> tuple[str, str]:
        from services.primer_reference import resolve_chrom
        name = resolve_chrom(state.translate_chrom(chrom) if hasattr(state, "translate_chrom") else chrom,
                             set(fasta.references)) or chrom
        size = fasta.get_reference_length(name)
        left = fasta.fetch(name, max(0, ref - n), ref)
        right = fasta.fetch(name, ref, min(size, ref + n))
        return left, right
    return fetch


# ---------------------------------------------------------------------------
# Dfam online search: sends the sequence, so only with an explicit opt-in


class OptInRequired(IdentifyError):
    pass


def dfam_search(seq: str, *, organism: str, opt_in: bool, opener=None, runner: Optional[_Runner] = None,
                progress: Optional[ProgressFn] = None, poll_seconds: float = 5.0, max_wait: float = 300.0) -> dict:
    """Search the consensus on dfam.org (nhmmer against Dfam's curated models).

    This sends the user's sequence to dfam.org, so it refuses unless ``opt_in`` is
    exactly True (the user clicked "Send to Dfam" for this query)."""
    if opt_in is not True:
        raise OptInRequired("Searching Dfam online sends the sequence to dfam.org: it needs your explicit opt-in.")
    seq = re.sub(r"\s+", "", seq or "").upper()
    if not seq or len(seq) > MAX_QUERY:
        raise IdentifyError("No sequence, or longer than 100 kb.")
    opener = opener or urllib.request.urlopen
    runner = runner or _Runner()
    progress = progress or (lambda m, f: None)
    data = urllib.parse.urlencode({"sequence": f">insertion\n{seq}", "organism": organism,
                                   "cutoff": "curated"}).encode()
    progress("Sending the consensus to Dfam", 0.1)
    with opener(urllib.request.Request("https://dfam.org/api/searches", data=data), timeout=60) as resp:
        submitted = json.loads(resp.read().decode("utf-8"))
    search_id = submitted.get("id")
    if not search_id or not re.fullmatch(r"[A-Za-z0-9-]+", str(search_id)):
        raise IdentifyError(f"Dfam did not accept the search: {submitted}")
    waited = 0.0
    while waited <= max_wait:
        runner.check()
        with opener(urllib.request.Request(f"https://dfam.org/api/searches/{search_id}"), timeout=60) as resp:
            status = getattr(resp, "status", 200)
            body = json.loads(resp.read().decode("utf-8"))
        if status == 200 and "results" in body:
            hits = []
            for res in body.get("results") or []:
                for h in res.get("hits") or []:
                    hits.append({"family": h.get("query"), "accession": h.get("accession"), "type": h.get("type"),
                                 "description": h.get("description"), "evalue": h.get("e_value"),
                                 "bitscore": h.get("bit_score"), "strand": h.get("strand"),
                                 "qstart": h.get("seq_start"), "qend": h.get("seq_end"),
                                 "model_start": h.get("model_start"), "model_end": h.get("model_end"),
                                 "model_length": h.get("mod_length")})
            return {"search_id": search_id, "hits": hits, "url": f"https://www.dfam.org/search/results/{search_id}",
                    "parameters": body.get("searchParameters")}
        progress(f"Dfam: {body.get('message') or body.get('status') or 'waiting'}", 0.5)
        time.sleep(poll_seconds)
        waited += poll_seconds
    raise IdentifyError("Dfam did not finish within 5 minutes; try again later.")


# ---------------------------------------------------------------------------
# Background jobs and the result cache


_jobs_lock = threading.Lock()
_jobs: "OrderedDict[str, dict]" = OrderedDict()
_results: "OrderedDict[str, dict]" = OrderedDict()
_RESULT_CACHE = 64
_JOB_KEEP = 64


def cache_dir() -> str:
    env = os.environ.get("FIBERBROWSER_IDENTIFY_CACHE_DIR")
    return os.path.expanduser(env) if env else os.path.join(os.path.expanduser("~"), ".fiberhmm", "insertion_identify")


def result_key(seq: str, *, chrom, ref, length, genome_sig: str, library: Optional[dict], engine: str, rmsk: bool) -> str:
    lib = f"{library['id']}:{library.get('sha256')}" if library else "none"
    text = json.dumps([hashlib.sha256(seq.upper().encode()).hexdigest(), chrom, ref, length, genome_sig, lib, engine,
                       bool(rmsk), SCHEMA])
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def cached_result(key: str) -> Optional[dict]:
    with _jobs_lock:
        if key in _results:
            _results.move_to_end(key)
            return _results[key]
    path = os.path.join(cache_dir(), f"{key}.json")
    try:
        with open(path) as handle:
            result = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(result, dict) or result.get("schema") != SCHEMA:
        return None
    _remember(key, result)
    return result


def _remember(key: str, result: dict) -> None:
    with _jobs_lock:
        _results[key] = result
        _results.move_to_end(key)
        while len(_results) > _RESULT_CACHE:
            _results.popitem(last=False)


def _persist(key: str, result: dict) -> None:
    try:
        os.makedirs(cache_dir(), exist_ok=True)
        tmp = os.path.join(cache_dir(), f".{key}.{os.getpid()}.tmp")
        with open(tmp, "w") as handle:
            json.dump(result, handle)
        os.replace(tmp, os.path.join(cache_dir(), f"{key}.json"))
    except OSError:
        pass


def job_view(job: dict) -> dict:
    return {k: job.get(k) for k in ("job_id", "key", "kind", "status", "message", "progress", "error", "result",
                                     "started", "finished")}


def start_job(kind: str, key: str, fn: Callable[[_Runner, ProgressFn], dict], *, persist: bool = True,
              cache_key: Optional[Callable[[], Optional[str]]] = None) -> dict:
    """Run ``fn`` in a background thread (one job per key at a time). A finished result is
    cached under ``key``, or under ``cache_key()`` when given (None: not cached), and only
    when it finished before any Cancel."""
    with _jobs_lock:
        for job in _jobs.values():
            if job["key"] == key and job["status"] in ("queued", "running"):
                return job_view(job)
        job_id = uuid.uuid4().hex[:16]
        runner = _Runner()
        job = {"job_id": job_id, "key": key, "kind": kind, "status": "running", "message": "Starting",
               "progress": 0.0, "error": None, "result": None, "started": time.time(), "finished": None,
               "_runner": runner}
        _jobs[job_id] = job
        while len(_jobs) > _JOB_KEEP:
            oldest = next(iter(_jobs))
            if _jobs[oldest]["status"] in ("queued", "running"):
                break
            _jobs.popitem(last=False)

    def progress(message: str, fraction: float) -> None:
        job["message"] = message
        job["progress"] = max(job["progress"] or 0.0, min(1.0, float(fraction)))

    def work() -> None:
        try:
            result = fn(runner, progress)
            # Cancel and completion decided under one lock: a cancelled job never publishes.
            with _jobs_lock:
                if runner.abort.is_set():
                    raise IdentifyAborted("Stopped")
                job.update(result=result, status="done", message="Done", progress=1.0)
            store_key = (cache_key() if cache_key is not None else key) if persist else None
            if store_key:
                _remember(store_key, result)
                _persist(store_key, result)
        except IdentifyAborted:
            job.update(status="cancelled", message="Stopped")
        except IdentifyError as exc:
            job.update(status="error", error=str(exc), message=str(exc))
        except Exception as exc:  # pragma: no cover - reported to the user
            job.update(status="error", error=f"{type(exc).__name__}: {exc}", message="Failed")
        finally:
            job["finished"] = time.time()

    threading.Thread(target=work, name=f"identify-{job_id}", daemon=True).start()
    return job_view(job)


def get_job(job_id: str) -> Optional[dict]:
    with _jobs_lock:
        job = _jobs.get(job_id)
    return job_view(job) if job else None


def cancel_job(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job["status"] not in ("queued", "running"):
            return False
        job["_runner"].abort.set()
    job["_runner"].kill()
    return True


def identify_request(state, *, seq: str, chrom: Optional[str], ref: Optional[int], length: Optional[int],
                     library_id: Optional[str] = None, engine: str = "auto", rmsk: bool = False,
                     force: bool = False) -> dict:
    """Start (or return the cached result of) an identification for the route."""
    seq = re.sub(r"\s+", "", seq or "").upper()
    if not seq:
        return {"success": False, "error": "No consensus to identify."}
    try:
        chosen = choose_engine(engine)
    except IdentifyError as exc:
        return {"success": False, "error": str(exc), "missing_tools": True, "tools": tool_status()}
    genome = _reference_genome(state)
    if not getattr(state, "fasta_path", None):
        return {"success": False, "error": "Load a reference genome first: the insertion is searched against it."}
    # One decision: the installed library, else the recommended one, which the job sets up
    # first (no prompt). (A second lookup could see a library another job just installed
    # and fall back to a no-library key.)
    offered = te_library.libraries_for_genome(genome)
    info = te_library.active_library(genome, library_id)
    pending = offered[0] if info is None and offered else None
    genome_sig = genome_signature(state, chosen)

    def key_for(library: Optional[dict]) -> str:
        return result_key(seq, chrom=chrom, ref=ref, length=length, genome_sig=genome_sig,
                          library=library, engine=chosen, rmsk=rmsk)

    key = key_for(info if pending is None else {"id": pending["id"], "sha256": "pending"})
    if not force and pending is None:
        cached = cached_result(key)
        if cached is not None:
            return {"success": True, "key": key, "status": "done", "result": cached, "cached": True}

    snapshot = StateSnapshot(state)

    filed: dict = {"key": None}  # where fn's result is cached when a library was set up

    def fn(runner, progress):
        lib_id = info["id"] if info else None
        note = None
        if pending is not None:
            try:
                lib_id = te_library.ensure_library(pending["id"], progress=progress, abort=runner.abort)["id"]
            except te_library.LibraryAborted:
                raise IdentifyAborted("Stopped")
            except Exception as exc:  # offline, Dfam down...: identify without it, try again next time
                runner.check()
                note = (f"The {pending['short']} could not be set up ({exc}); TE families are not named. "
                        "Identify tries again next time.")
        result = identify(seq, snapshot, chrom=chrom, ref=ref, genome=genome, library_id=lib_id,
                          engine=chosen, rmsk=rmsk, runner=runner, progress=progress,
                          coordinate_genome=snapshot.coordinate_genome)
        result["reference_id"] = snapshot.reference_id
        result["rmsk_requested"] = bool(rmsk)
        if note:
            result["library_note"] = note
        if pending is not None and note is None:
            # Filed under the key the next request computes (the library's real checksum).
            filed["key"] = key_for(te_library.installed_info(lib_id))
        return result

    # With a library still to set up, the result is cached under its real key, and not at
    # all when setting the library up failed (so the next Identify tries again).
    job = start_job("identify", key, fn, cache_key=(lambda: filed["key"]) if pending is not None else None)
    return {"success": True, **job}


def dfam_request(state, *, seq: str, opt_in: bool, organism: Optional[str] = None) -> dict:
    if opt_in is not True:
        return {"success": False, "error": "Searching Dfam online sends the sequence to dfam.org; it needs your explicit opt-in.",
                "opt_in_required": True}
    genome = _reference_genome(state)
    species = organism or (te_library.DFAM_TAXA.get(str(genome or ""), (None, None))[1])
    if not species:
        return {"success": False, "error": "Pick the organism to search Dfam for (the loaded genome is not one Dfam knows by name)."}
    seq = re.sub(r"\s+", "", seq or "").upper()
    key = "dfam:" + hashlib.sha256(f"{seq}|{species}".encode()).hexdigest()[:32]

    def fn(runner, progress):
        return dfam_search(seq, organism=species, opt_in=True, runner=runner, progress=progress)

    return {"success": True, **start_job("dfam", key, fn, persist=False)}


def _reference_genome(state):
    """The genome the reference belongs to: loaded, inherited by an expanded insert, or declared for a FASTA."""
    from services.motifs import reference_genome
    return reference_genome(state)


def _coordinate_genome(state):
    """A verified coordinate assembly (services/motifs.coordinate_genome); a snapshot carries its own."""
    if hasattr(state, "coordinate_genome") and not callable(getattr(state, "coordinate_genome")):
        return state.coordinate_genome
    from services.motifs import coordinate_genome
    return coordinate_genome(state)


def _identity(state) -> str:
    """The reference's genome identity (species, coordinate assembly, declaration revision)."""
    try:
        from services.motifs import genome_identity_key
        return genome_identity_key(state)
    except Exception:  # noqa: BLE001 - a stand-in state in tests
        return ""
