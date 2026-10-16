"""Match loaded plasmid maps to the contigs of loaded BAMs by sequence.

A plasmid map (``L-HH.dna``) loads as a chromosome named after the map. The
reads of a BAM are on whatever contig the aligner's FASTA named, and that
FASTA may also be rotated (a different origin of the same circular sequence).
This module finds which BAM contig *is* a map's sequence and links the two,
so reads appear on the map without renaming anything:

* identity is checked by sequence, never by name alone: the ``@SQ M5``
  checksum, the reference FASTA the BAM was aligned to (``@SQ UR``, the
  aligner's ``@PG CL``, a ``@CO FIBERHMM-REFERENCE`` line or a path the user
  gives), or the reference bases the reads themselves carry (``MD`` tags);
* a rotated reference is handled by showing the map in the BAM's frame: the
  map's sequence and features are rotated to the BAM's origin (the first
  dataset linked to a map decides its frame; a later BAM in another frame gets
  its own copy of the map, named after its contig);
* the link is kept in the workspace's ``plasmid_metadata`` (dataset, its
  files, contig, the chromosome/frame it is shown on); readers of that
  dataset's files resolve the chromosome through ``contig_links`` (never a
  process-wide name alias: another workspace, dataset or frame is unaffected).

When nothing proves identity, the result says what differs (length,
sequence, orientation) and how to fix it; a same-length contig whose sequence
cannot be checked can be linked by the user (``confirm``).

Offsets: a BAM contig at offset ``o`` is the map rotated by ``o``:
``contig == map[o:] + map[:o]``, so BAM position ``p`` is map position
``(p + o) % L``. A plasmid chromosome in frame ``f`` shows ``map[f:] + map[:f]``.
"""
from __future__ import annotations

from services.genome_loading import publishes_reference, state_lock
import gzip
import hashlib
import os
import shlex
from dataclasses import dataclass, field
from typing import Iterable, Optional

from services.remote_sources import is_source_ref
from services.remote_sources.opening import local_copy, open_alignment_file, open_fasta
from utils.chrom import same_chrom

REFERENCE_CO_PREFIX = "FIBERHMM-REFERENCE:v1:"
FASTA_SUFFIXES = (".fa", ".fasta", ".fna", ".fas", ".fa.gz", ".fasta.gz", ".fna.gz")
# A FASTA without a .fai is parsed as text (never indexed: that would write
# next to the user's file); larger ones are skipped.
MAX_UNINDEXED_FASTA_BYTES = 64 * 1024 * 1024
# A BAM that looks like a plasmid run (few, short contigs) gets a message
# when none of its contigs is a loaded map; a genome BAM does not.
PLASMID_BAM_MAX_CONTIGS = 16
PLASMID_BAM_MAX_CONTIG_BP = 2_000_000
READ_EVIDENCE_MAX_READS = 60
READ_EVIDENCE_MIN_BP = 60
READ_EVIDENCE_MIN_AGREE = 3

_COMPLEMENT = str.maketrans("ACGTNRYKMSWBDHV", "TGCANYRMKSWVHDB")


def sequence_md5(sequence: str) -> str:
    """The SAM ``M5`` checksum: md5 of the uppercase sequence, no whitespace."""
    return hashlib.md5("".join(str(sequence).split()).upper().encode("ascii", "ignore")).hexdigest()


def rotate(sequence: str, offset: int) -> str:
    """``sequence`` starting at ``offset`` (a circular rotation)."""
    if not sequence:
        return sequence
    k = int(offset) % len(sequence)
    return sequence[k:] + sequence[:k]


def reverse_complement(sequence: str) -> str:
    return sequence.translate(_COMPLEMENT)[::-1]


def rotation_offset(map_seq: str, other: str) -> Optional[int]:
    """``o`` with ``other == rotate(map_seq, o)``; None when ``other`` is not a rotation."""
    if not map_seq or len(map_seq) != len(other):
        return None
    if map_seq == other:
        return 0
    index = (map_seq + map_seq).find(other)
    return index if 0 <= index < len(map_seq) else None


def _anchor_offset(map_seq: str, other: str, k: int = 24) -> Optional[int]:
    """The rotation most k-mers of ``other`` agree on (for a near-identical sequence)."""
    length = len(other)
    if length < k or len(map_seq) < k:
        return None
    doubled = map_seq + map_seq
    votes: dict[int, int] = {}
    for i in range(0, length - k + 1, max(1, length // 32)):
        kmer = other[i:i + k]
        hit = doubled.find(kmer)
        if hit < 0 or doubled.find(kmer, hit + 1) not in (-1, hit + len(map_seq)):
            continue
        offset = (hit - i) % len(map_seq)
        votes[offset] = votes.get(offset, 0) + 1
    if not votes:
        return None
    offset, count = max(votes.items(), key=lambda item: item[1])
    return offset if count >= 2 else None


def describe_difference(map_name: str, map_seq: str, contig: str, other: str) -> dict:
    """How ``other`` (a BAM contig's reference) differs from the map: a problem dict."""
    L, M = len(map_seq), len(other)
    if L != M:
        return {
            "kind": "length",
            "message": (
                f"{contig} is {M:,} bp but map {map_name} is {L:,} bp: the BAM was aligned to a different "
                "sequence. Align the reads to the map (FiberHMM `fiberhmm-pipeline --map`, or "
                "`scripts/align_plasmid_reads.py`) or load the map that matches that reference."
            ),
        }
    rc = reverse_complement(other)
    rc_offset = rotation_offset(map_seq, rc)
    if rc_offset is not None:
        return {
            "kind": "reverse_complement",
            "message": (
                f"{contig} is the reverse complement of map {map_name}"
                + (f" (rotated by {rc_offset:,} bp)" if rc_offset else "")
                + ": reverse-complement the map in SnapGene (or align to the map as saved) so the strands agree."
            ),
        }
    offset = _anchor_offset(map_seq, other)
    if offset is not None:
        rotated = rotate(map_seq, offset)
        diffs = [i for i in range(M) if rotated[i] != other[i]]
        where = f"first at {contig}:{diffs[0] + 1:,}" if diffs else ""
        rotation = f", origin shifted by {offset:,} bp" if offset else ""
        return {
            "kind": "sequence",
            "offset": offset,
            "differences": len(diffs),
            "message": (
                f"{contig} and map {map_name} have the same length{rotation} but {len(diffs):,} base"
                f"{'' if len(diffs) == 1 else 's'} differ ({where}). The map is not the sequence the reads "
                "were aligned to: update the map to the sequenced plasmid, or link anyway."
            ),
        }
    return {
        "kind": "sequence",
        "message": (
            f"{contig} has the same length as map {map_name} ({L:,} bp) but a different sequence "
            "(not a rotation of it). Load the map of the plasmid these reads were aligned to."
        ),
    }


# ---------------------------------------------------------------------------
# BAM header evidence
# ---------------------------------------------------------------------------

def parse_reference_comments(header: dict) -> list[dict]:
    """``@CO FIBERHMM-REFERENCE:v1:`` declarations (``key=value`` pairs split on ``;``,
    values percent-decoded).

    ``fiberhmm-pipeline`` writes ``contig``, ``length``, ``md5`` (the contig's
    ``@SQ M5``), ``topology`` (``circular``/``linear``), ``source`` (the map or
    FASTA file name, next to the BAM), ``source_format`` and ``source_sha256``
    (of that file). The short form ``map=<file>;contig=<name>;circular=1;
    map_md5=<md5>`` is read too, as are ``offset`` (the contig is the map
    rotated by this many bp) and ``fasta`` (the alignment FASTA). Each entry is
    returned with the normalised keys ``map``, ``map_md5`` and ``circular``
    added; unknown keys are kept and malformed lines skipped.
    """
    from urllib.parse import unquote

    entries = []
    for comment in (header or {}).get("CO", []) or []:
        text = str(comment).strip()
        if not text.startswith(REFERENCE_CO_PREFIX):
            continue
        fields: dict[str, str] = {}
        for part in text[len(REFERENCE_CO_PREFIX):].split(";"):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            key = key.strip()
            if key:
                fields[key] = unquote(value.strip())
        if not fields.get("map") and fields.get("source") and fields.get("source_format", "") != "fasta":
            fields["map"] = fields["source"]
        if not fields.get("map_md5") and fields.get("md5"):
            fields["map_md5"] = fields["md5"]
        if "circular" not in fields and fields.get("topology"):
            fields["circular"] = "1" if fields["topology"].lower() == "circular" else "0"
        if fields.get("contig") or fields.get("map"):
            entries.append(fields)
    return entries


def _file_sha256(path: str) -> str:
    from services.lab.paths import open_read
    digest = hashlib.sha256()
    with open_read(path) as handle:  # a lab server: inside its data roots, by descriptor
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _resolve_near_ref(path: str, bam_ref: str) -> Optional[str]:
    """``resolve_near`` for a BAM on a connected cluster: a reference beside it (or the absolute path there)."""
    import posixpath
    from services.remote_sources import source_for_ref

    source = source_for_ref(bam_ref)
    prefix, _slash, bam_path = bam_ref.partition("://")[2].partition("/")
    base = f"{bam_ref.partition('://')[0]}://{prefix}"
    bam_dir = posixpath.dirname("/" + bam_path)
    candidates = []
    if path.startswith("/"):
        candidates.append(posixpath.normpath(path))
    candidates += [posixpath.normpath(posixpath.join(bam_dir, path)),
                   posixpath.join(bam_dir, posixpath.basename(path))]
    for candidate in candidates:
        ref = base + candidate
        try:
            info = source.stat(ref) if source is not None else None
        except Exception:
            info = None
        if info and info.get("type") == "file":
            return ref
    return None


def resolve_near(path: str, bam_path: str) -> Optional[str]:
    """``path`` as written, else relative to the BAM's folder, else its basename there."""
    if not path:
        return None
    if bam_path and is_source_ref(bam_path):
        return _resolve_near_ref(path, bam_path)
    path = os.path.expanduser(path)
    if path.startswith("file://"):
        path = path[len("file://"):]
    elif path.startswith("file:"):
        path = path[len("file:"):]
    bam_dir = os.path.dirname(os.path.abspath(bam_path)) if bam_path else ""
    candidates = [path] if os.path.isabs(path) else []
    if bam_dir:
        candidates += [os.path.join(bam_dir, path), os.path.join(bam_dir, os.path.basename(path))]
    if not os.path.isabs(path):
        candidates.append(os.path.abspath(path))
    from services.lab.paths import readable
    for candidate in candidates:
        # A lab server: a path from a BAM header or map line that resolves outside
        # its data roots is never used (skipped, like a missing file).
        if os.path.isfile(candidate) and readable(candidate):
            return os.path.abspath(candidate)
    return None


def _command_tokens(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def reference_fasta_candidates(header: dict, bam_path: str, contig: str | None = None) -> list[str]:
    """FASTA files the BAM says it was aligned to (existing files only)."""
    found: list[str] = []

    def add(raw: str | None) -> None:
        resolved = resolve_near(raw or "", bam_path)
        if resolved and resolved not in found:
            found.append(resolved)

    for sq in (header or {}).get("SQ", []) or []:
        if contig is None or sq.get("SN") == contig:
            if sq.get("UR"):
                add(str(sq["UR"]))
    for entry in parse_reference_comments(header):
        if entry.get("fasta"):
            add(entry["fasta"])
    for pg in (header or {}).get("PG", []) or []:
        command = str(pg.get("CL") or "")
        for token in _command_tokens(command):
            if token.lower().endswith(FASTA_SUFFIXES):
                add(token)
    return found


def _fai_lengths(fai_path: str) -> dict[str, int]:
    from services.lab.paths import open_read
    lengths = {}
    with open_read(fai_path, text=True) as handle:
        for line in handle:
            fields = line.split("\t")
            if len(fields) >= 2:
                try:
                    lengths[fields[0]] = int(fields[1])
                except ValueError:
                    continue
    return lengths


def fasta_contig_sequence(fasta_path: str, contig: str, expected_length: int | None = None) -> Optional[str]:
    """One contig's sequence from a FASTA, without writing an index next to it."""
    from services.lab.paths import enforcing, open_read, readable
    try:
        if not readable(fasta_path):
            return None  # a lab server: outside its data roots
        if os.path.isfile(fasta_path + ".fai"):
            lengths = _fai_lengths(fasta_path + ".fai")
            if contig not in lengths or (expected_length and lengths[contig] != expected_length):
                return None
            with open_fasta(fasta_path) as fasta:  # the FASTA and its indexes confined
                return fasta.fetch(contig).upper()
        if os.path.getsize(fasta_path) > MAX_UNINDEXED_FASTA_BYTES:
            return None
        gz = fasta_path.lower().endswith(".gz")
        parts: list[str] = []
        capturing = False
        if enforcing():
            import io
            raw = open_read(fasta_path)
            handle_cm = gzip.open(raw, "rt", encoding="utf-8", errors="replace") if gz \
                else io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
        else:
            handle_cm = (gzip.open if gz else open)(fasta_path, "rt", encoding="utf-8", errors="replace")
        with handle_cm as handle:
            for line in handle:
                if line.startswith(">"):
                    if capturing:
                        break
                    capturing = line[1:].strip().split()[0:1] == [contig]
                    continue
                if capturing:
                    parts.append(line.strip())
        if not capturing and not parts:
            return None
        sequence = "".join(parts).upper()
        if expected_length and len(sequence) != expected_length:
            return None
        return sequence or None
    except Exception:
        return None


def offset_from_reads(bam_path: str, contig: str, map_seq: str) -> dict:
    """The rotation of ``contig`` relative to ``map_seq``, from the reference bases of reads.

    Each read's ``MD`` tag gives the reference bases under its alignment
    (``get_reference_sequence``); where that stretch sits in the map gives the
    offset. Returns ``{"offset": o}`` when enough reads agree, else
    ``{"informative": n, "unplaced": m}`` (reads whose reference is not in the map).
    """
    import pysam

    L = len(map_seq)
    doubled = map_seq + map_seq
    votes: dict[int, int] = {}
    unplaced = 0
    checked = 0
    try:
        with open_alignment_file(bam_path, "rb") as bam:
            for read in bam.fetch(contig):
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                if not read.has_tag("MD"):
                    continue
                try:
                    ref = read.get_reference_sequence().upper()
                except Exception:
                    continue
                if len(ref) < READ_EVIDENCE_MIN_BP:
                    continue
                checked += 1
                hit = doubled.find(ref)
                if hit < 0:
                    unplaced += 1
                else:
                    second = doubled.find(ref, hit + 1)
                    if second < 0 or (second - hit) % L == 0:
                        offset = (hit - int(read.reference_start)) % L
                        votes[offset] = votes.get(offset, 0) + 1
                if checked >= READ_EVIDENCE_MAX_READS:
                    break
    except Exception:
        return {"informative": 0, "unplaced": 0}
    informative = sum(votes.values())
    if votes:
        offset, count = max(votes.items(), key=lambda item: item[1])
        if count >= min(READ_EVIDENCE_MIN_AGREE, informative) and count >= 0.9 * (informative + unplaced) and count >= 2:
            return {"offset": offset, "reads": count}
    return {"informative": informative, "unplaced": unplaced}


# ---------------------------------------------------------------------------
# Matching one BAM contig against one map
# ---------------------------------------------------------------------------

@dataclass
class ContigEvidence:
    """What a BAM says about one of its contigs."""
    bam_path: str
    contig: str
    length: int
    m5: Optional[str] = None
    header: dict = field(default_factory=dict)
    declared: list = field(default_factory=list)  # FIBERHMM-REFERENCE entries for this contig
    extra_fastas: list = field(default_factory=list)


def bam_contig_evidence(bam_path: str, extra_fastas: Iterable[str] = ()) -> list[ContigEvidence]:
    import pysam

    with open_alignment_file(bam_path, "rb", check_sq=False) as bam:
        header = bam.header.to_dict()
    declared = parse_reference_comments(header)
    out = []
    for sq in header.get("SQ", []) or []:
        name = str(sq.get("SN") or "")
        if not name:
            continue
        out.append(ContigEvidence(
            bam_path=bam_path,
            contig=name,
            length=int(sq.get("LN") or 0),
            m5=(str(sq["M5"]).lower() if sq.get("M5") else None),
            header=header,
            declared=[entry for entry in declared if entry.get("contig") == name],
            extra_fastas=list(extra_fastas),
        ))
    return out


def match_contig(map_name: str, map_seq: str, evidence: ContigEvidence, *, use_reads: bool = True,
                 map_path: str | None = None) -> dict:
    """Is ``evidence.contig`` the map's sequence? Returns one of

    * ``{"match": True, "offset": o, "method": ..., "verified": bool, "detail": ...}``
    * ``{"match": False, "problem": {...}}`` (with ``can_confirm`` when the user may link it)
    * ``{"match": None}`` (not a candidate: different length and name, nothing to say)
    """
    L = len(map_seq)
    map_md5 = sequence_md5(map_seq)
    contig = evidence.contig
    named_alike = same_chrom(contig, map_name)
    def names_this_map(entry: dict) -> bool:
        if map_path and entry.get("map"):
            resolved = resolve_near(entry["map"], evidence.bam_path)
            if resolved and _file_key(resolved) == _file_key(map_path):
                return True
        return os.path.splitext(os.path.basename(entry.get("map", "")))[0] == map_name

    declared = [entry for entry in evidence.declared
                if (entry.get("map_md5") or "").lower() == map_md5
                or (not entry.get("map_md5") and names_this_map(entry))]
    declared_other = [entry for entry in evidence.declared
                      if entry.get("map_md5") and entry.get("map_md5", "").lower() != map_md5
                      and names_this_map(entry)]

    if evidence.length != L:
        if named_alike or declared or declared_other:
            return {"match": False, "problem": {**describe_difference(map_name, map_seq, contig, "N" * evidence.length),
                                                "can_confirm": False}}
        return {"match": None}

    if evidence.m5 and evidence.m5 == map_md5:
        return {"match": True, "offset": 0, "method": "m5", "verified": True,
                "detail": "@SQ M5 checksum equals the map's sequence"}

    def contradicts_m5(offset: int) -> bool:
        """The BAM's own @SQ M5 says its contig is not the map rotated by ``offset``."""
        return bool(evidence.m5) and sequence_md5(rotate(map_seq, offset)) != evidence.m5

    def checksum_problem(offset: int, source: str) -> dict:
        # Contradictory evidence is never a verified link: the user may still link it,
        # warned that the BAM's own checksum disagrees.
        return {"match": False, "problem": {
            "kind": "checksum",
            "message": (f"{source} suggest {contig} is map {map_name}"
                        + (f" with its origin shifted by {offset:,} bp" if offset else "")
                        + f", but {contig}'s @SQ M5 checksum says it is a different sequence (a changed "
                        "reference, or differences outside the reads checked). Load the map of the sequence the "
                        "reads were aligned to; link anyway only if you know the checksum is wrong."),
            "can_confirm": True,
            "suggested_offset": offset,
        }}

    # The reference FASTA: the only full check, and it finds any rotation.
    fastas = list(evidence.extra_fastas) + reference_fasta_candidates(evidence.header, evidence.bam_path, contig)
    stale_fasta = None
    for fasta_path in dict.fromkeys(fastas):
        ref_seq = fasta_contig_sequence(fasta_path, contig, expected_length=L)
        if ref_seq is None:
            continue
        if evidence.m5 and sequence_md5(ref_seq) != evidence.m5:
            # Not the sequence the BAM was aligned to (replaced or edited since): no evidence.
            stale_fasta = stale_fasta or fasta_path
            continue
        offset = rotation_offset(map_seq, ref_seq)
        if offset is not None:
            detail = f"reference {os.path.basename(fasta_path)} is the map's sequence"
            if offset:
                detail += f", origin shifted by {offset:,} bp"
            return {"match": True, "offset": offset, "method": "reference", "verified": True,
                    "detail": detail, "fasta": fasta_path}
        problem = describe_difference(map_name, map_seq, contig, ref_seq)
        problem["can_confirm"] = problem.get("kind") == "sequence" and "offset" in problem
        if problem["can_confirm"]:
            problem["suggested_offset"] = problem["offset"]
        problem["fasta"] = fasta_path
        return {"match": False, "problem": problem}

    if declared_other:
        entry = declared_other[0]
        return {"match": False, "problem": {
            "kind": "map_checksum",
            "message": (f"{os.path.basename(evidence.bam_path)} was made with a different version of "
                        f"{entry.get('map')} (its checksum differs from the loaded map's). Load the map the "
                        "BAM was made from, or re-run the pipeline with this map."),
            "can_confirm": False,
        }}

    if use_reads:
        reads = offset_from_reads(evidence.bam_path, contig, map_seq)
        if "offset" in reads:
            offset = reads["offset"]
            if contradicts_m5(offset):
                # MD tags cover only the sampled reads; the checksum covers the whole contig.
                return checksum_problem(offset, f"The reference bases of {reads['reads']} reads (MD tags)")
            detail = f"reference bases of {reads['reads']} reads (MD tags) are in the map"
            if offset:
                detail += f", origin shifted by {offset:,} bp"
            return {"match": True, "offset": offset, "method": "reads", "verified": True, "detail": detail}
        if reads.get("unplaced", 0) >= READ_EVIDENCE_MIN_AGREE and reads.get("informative", 0) == 0:
            return {"match": False, "problem": {
                "kind": "sequence",
                "message": (f"{contig} has the same length as map {map_name} ({L:,} bp), but the reference "
                            "bases in its reads (MD tags) are not in the map: it is a different sequence."),
                "can_confirm": True,
                "suggested_offset": 0,
            }}

    if declared:
        entry = declared[0]
        try:
            offset = int(entry.get("offset") or 0) % L
        except ValueError:
            offset = 0
        if contradicts_m5(offset):
            return checksum_problem(offset, "The BAM's @CO FIBERHMM-REFERENCE line and map name")
        return {"match": True, "offset": offset, "method": "header", "verified": bool(entry.get("map_md5")),
                "detail": "declared by the BAM's @CO FIBERHMM-REFERENCE line"}

    if named_alike and not evidence.m5:
        # The old rule (reads join a map by contig name), kept when nothing can check it.
        return {"match": True, "offset": 0, "method": "name", "verified": False,
                "detail": "same name and length; sequence not checked (no M5, reference FASTA or MD tags)"}

    reason = ("its @SQ M5 checksum differs from the map's, so it is rotated or a different sequence"
              if evidence.m5 else "no M5 checksum, reference FASTA or MD tags to check its sequence")
    if stale_fasta:
        reason += (f" (reference {os.path.basename(stale_fasta)} was not used: its sequence does not match "
                   f"the BAM's @SQ M5, so it changed after the alignment)")
    return {"match": False, "problem": {
        "kind": "unverified",
        "message": (f"{contig} has the same length as map {map_name} ({L:,} bp), but {reason}. "
                    "Load the reference FASTA the reads were aligned to (it finds the rotation), or link it "
                    "anyway if it is the same plasmid with the same origin."),
        "can_confirm": True,
        "suggested_offset": 0,
    }}


# ---------------------------------------------------------------------------
# Applying links to a BrowserState
# ---------------------------------------------------------------------------

def _plasmid_maps(state) -> dict[str, dict]:
    return {name: meta for name, meta in (getattr(state, "plasmid_metadata", None) or {}).items()
            if (meta or {}).get("source") == "plasmid_map"}


def map_sequence(state, chrom: str) -> Optional[str]:
    """The map's own sequence (its origin), whatever frame the chromosome shows."""
    sequence = (getattr(state, "plasmid_sequences", None) or {}).get(chrom)
    if not sequence:
        return None
    frame = int(((getattr(state, "plasmid_metadata", None) or {}).get(chrom) or {}).get("frame_offset") or 0)
    return rotate(sequence, -frame) if frame else sequence


def _dataset_paths(dataset) -> list[str]:
    return [str(p) for p in (getattr(dataset, "paths", None) or [getattr(dataset, "path", "")]) if p]


def _local_bam_paths(dataset) -> list[str]:
    """BAMs whose header and reads can be read here: local files, and BAMs on a
    connected cluster (``ssh://`` references; other remote URLs are not read)."""
    return [p for p in _dataset_paths(dataset) if p.lower().endswith(".bam")
            and (is_source_ref(p) or ("://" not in p and os.path.isfile(p)))]


def _file_key(path) -> str:
    """How a dataset or map file is compared: a cluster reference (``ssh://``,
    ``s3://``) as written, a local path made absolute."""
    path = str(path)
    return path if "://" in path else os.path.abspath(path)


def _same_files(a: Iterable[str], b: Iterable[str]) -> bool:
    return [_file_key(p) for p in a] == [_file_key(p) for p in b]


def _live_links(state, chrom: str) -> list[dict]:
    """The links shown on ``chrom`` whose dataset is still loaded with the same files
    (an unloaded dataset, or an id reused for other files, drops its links)."""
    datasets = getattr(state, "datasets", {}) or {}
    meta = (getattr(state, "plasmid_metadata", None) or {}).get(chrom) or {}
    live = []
    for link in meta.get("links") or []:
        dataset = datasets.get(link.get("dataset_id"))
        if dataset is None:
            continue
        if link.get("paths") and not _same_files(link["paths"], _dataset_paths(dataset)):
            continue
        live.append(link)
    return live


def contig_links(state, *, dataset_id: str | None = None, path: str | None = None) -> dict[str, str]:
    """``{file contig: chromosome it is shown on}`` for one dataset (or one dataset file)
    in this workspace, for ``utils.chrom.resolve_reference_name(..., links=)``.

    Scoped to the workspace (``state``), the dataset and its files, and the frame
    (the chromosome a link targets is the map or its frame copy in that contig's
    frame): a contig name linked here means nothing for another dataset.
    """
    if state is None:
        return {}
    wanted = _file_key(path) if path else None
    out: dict[str, str] = {}
    for chrom in _plasmid_maps(state):
        for link in _live_links(state, chrom):
            if dataset_id is not None and link.get("dataset_id") != dataset_id:
                continue
            if wanted is not None and wanted not in {_file_key(p) for p in link.get("paths") or []}:
                continue
            if link.get("contig"):
                out.setdefault(str(link["contig"]), chrom)
    return out


def _rotated_features(state, chrom: str, delta: int, length: int, new_name: str):
    """The chromosome's feature rows as PlasmidFeatures, moved ``delta`` bp towards the origin."""
    from services.plasmid_maps import PlasmidFeature

    gtf = getattr(state, "gtf_data", None) or {}
    transcripts = gtf.get("transcripts") if isinstance(gtf, dict) else None
    features = []
    if transcripts is None or len(transcripts) == 0 or "chrom" not in transcripts:
        return features
    rows = transcripts[transcripts["chrom"].astype(str) == chrom]
    for _, row in rows.iterrows():
        start, end = int(row["start"]), int(row["end"])
        width = max(1, end - start)
        new_start = (start - delta) % length
        features.append(PlasmidFeature(
            name=str(row.get("gene_name") or row.get("biotype") or "feature"),
            start=new_start,
            end=new_start + width,
            strand=str(row.get("strand") or "+"),
            kind=str(row.get("biotype") or "feature"),
        ))
    return features


@publishes_reference
def _set_plasmid_frame(state, chrom: str, new_name: str, offset: int, *, parent: str | None = None) -> None:
    """Show map ``chrom`` in frame ``offset`` as chromosome ``new_name`` (the same one, or a copy)."""
    from routers.genome import _merge_gtf_data
    from services.plasmid_maps import PlasmidMap, plasmid_features_to_gtf_data

    meta = dict((getattr(state, "plasmid_metadata", None) or {}).get(chrom) or {})
    current = (getattr(state, "plasmid_sequences", None) or {}).get(chrom) or ""
    frame = int(meta.get("frame_offset") or 0)
    original = rotate(current, -frame)
    length = len(original)
    delta = (offset - frame) % length
    features = _rotated_features(state, chrom, delta, length, new_name)
    circular = bool(meta.get("circular", True))
    label = meta.get("label") or chrom
    state.add_supplemental_plasmid_reference(
        new_name,
        rotate(original, offset),
        source="plasmid_map",
        path=meta.get("path"),
        label=label if new_name == chrom else f"{label} ({new_name} origin)",
        circular=circular,
    )
    plasmid = PlasmidMap(name=new_name, sequence=rotate(original, offset), circular=circular, features=features)
    state.gtf_data = _merge_gtf_data(state.gtf_data, plasmid_features_to_gtf_data(plasmid), contig=new_name)
    metadata = dict(state.plasmid_metadata or {})
    entry = dict(metadata.get(new_name) or {})
    entry.update({
        "frame_offset": offset % length,
        "map_md5": meta.get("map_md5") or sequence_md5(original),
        "links": list(meta.get("links") or []) if new_name == chrom else [],
    })
    if parent or new_name != chrom:
        entry["map_chrom"] = parent or chrom
    metadata[new_name] = entry
    state.plasmid_metadata = metadata


def _frame_copy_name(state, map_chrom: str, contig: str) -> str:
    plasmids = getattr(state, "plasmid_metadata", None) or {}
    taken = {c.name for c in (getattr(state, "chroms", None) or [])}
    if getattr(state, "fasta", None) is None:
        # Without a FASTA, the chromosome list is the BAM's contigs: the copy replaces its entry.
        taken = set(plasmids)
    if contig not in taken or (plasmids.get(contig) or {}).get("map_chrom") == map_chrom:
        return contig
    base = f"{map_chrom}_{contig}"
    name, n = base, 2
    while name in taken and (plasmids.get(name) or {}).get("map_chrom") != map_chrom:
        name, n = f"{base}_{n}", n + 1
    return name


@publishes_reference
def _drop_bam_only_chrom(state, contig: str) -> None:
    """Without a FASTA, a BAM's contig is listed as a chromosome; once it is shown
    as a map, that duplicate goes (the map is where its reads are)."""
    if getattr(state, "fasta", None) is not None:
        return
    if contig in (getattr(state, "plasmid_sequences", None) or {}):
        return
    chroms = [c for c in (getattr(state, "chroms", None) or []) if c.name != contig]
    if len(chroms) == len(getattr(state, "chroms", None) or []):
        return
    from utils.chrom import build_chrom_map
    state.chroms = chroms
    state.chrom_map = build_chrom_map(chroms)


@publishes_reference
def apply_link(state, map_chrom: str, dataset_id: str, contig: str, offset: int, *,
               method: str, verified: bool, detail: str = "", expect_map_md5: str | None = None,
               expect_dataset=None) -> Optional[dict]:
    """Link a dataset's ``contig`` (the map rotated by ``offset``) to map ``map_chrom``.

    Returns the link (with ``chrom``: the chromosome its reads are shown on), or None when the evidence is stale:
    ``expect_map_md5`` (the map sequence it was matched against) or ``expect_dataset`` (the dataset object read)
    no longer what the state has.
    """
    if expect_map_md5 is not None and sequence_md5(map_sequence(state, map_chrom) or "") != expect_map_md5:
        return None
    if expect_dataset is not None and (getattr(state, "datasets", {}) or {}).get(dataset_id) is not expect_dataset:
        return None
    meta = (getattr(state, "plasmid_metadata", None) or {}).get(map_chrom) or {}
    length = int(meta.get("size") or len((state.plasmid_sequences or {}).get(map_chrom) or ""))
    offset = int(offset) % length if length else 0
    target = map_chrom
    frame = int(meta.get("frame_offset") or 0)
    if offset != frame:
        others = [link for link in _live_links(state, map_chrom) if link.get("dataset_id") != dataset_id]
        if not others:
            _set_plasmid_frame(state, map_chrom, map_chrom, offset)
        else:
            # Another dataset shows this map in its frame: this one gets a copy in its own.
            existing = [name for name, m in _plasmid_maps(state).items()
                        if m.get("map_chrom") == map_chrom and int(m.get("frame_offset") or 0) == offset]
            target = existing[0] if existing else _frame_copy_name(state, map_chrom, contig)
            if not existing:
                _set_plasmid_frame(state, map_chrom, target, offset, parent=map_chrom)
    dataset = (getattr(state, "datasets", {}) or {}).get(dataset_id)
    link = {
        "dataset_id": dataset_id,
        "dataset_label": getattr(dataset, "label", dataset_id) if dataset is not None else dataset_id,
        "paths": _dataset_paths(dataset) if dataset is not None else [],
        "contig": contig,
        "chrom": target,
        "map_chrom": map_chrom,
        "offset": offset,
        "method": method,
        "verified": bool(verified),
        "detail": detail,
    }
    metadata = dict(state.plasmid_metadata or {})
    entry = dict(metadata.get(target) or {})
    links = [l for l in entry.get("links") or [] if not (l.get("dataset_id") == dataset_id and l.get("contig") == contig)]
    links.append(link)
    entry["links"] = links
    metadata[target] = entry
    state.plasmid_metadata = metadata
    if contig != target:
        _drop_bam_only_chrom(state, contig)
    return link


def _linked(state, dataset_id: str, contig: str) -> Optional[dict]:
    for chrom in _plasmid_maps(state):
        for link in _live_links(state, chrom):
            if link.get("dataset_id") == dataset_id and link.get("contig") == contig:
                return link
    return None


def _looks_like_plasmid_bam(evidence: list[ContigEvidence]) -> bool:
    return 0 < len(evidence) <= PLASMID_BAM_MAX_CONTIGS and all(
        e.length <= PLASMID_BAM_MAX_CONTIG_BP for e in evidence)


def reconcile(state, *, dataset_ids: Iterable[str] | None = None, chroms: Iterable[str] | None = None,
              reference_fasta: str | None = None, report_unmatched: bool = False) -> dict:
    """Link loaded maps and datasets whose contigs are the maps' sequences.

    Returns ``{"links": [...], "problems": [...]}``; each dataset also keeps
    its part as ``dataset.plasmid_report`` (shown by ``to_dict``).
    """
    from services.runtime import get_public_mode

    report = {"links": [], "problems": []}
    if get_public_mode():
        return report
    maps = _plasmid_maps(state)
    if chroms is not None:
        wanted = set(chroms)
        maps = {name: meta for name, meta in maps.items() if name in wanted}
    # Frame copies are not matched on their own: their map is.
    maps = {name: meta for name, meta in maps.items() if not meta.get("map_chrom")}
    if not maps:
        return report
    datasets = getattr(state, "datasets", {}) or {}
    ids = list(dataset_ids) if dataset_ids is not None else list(getattr(state, "dataset_order", None) or datasets)
    extra = [reference_fasta] if reference_fasta else []
    for dataset_id in ids:
        dataset = datasets.get(dataset_id)
        if dataset is None:
            continue
        ds_links, ds_problems = [], []
        for bam_path in _local_bam_paths(dataset):
            try:
                evidence = bam_contig_evidence(bam_path, extra)
            except Exception as exc:
                ds_problems.append({"dataset_id": dataset_id, "kind": "unreadable",
                                    "message": f"Could not read {os.path.basename(bam_path)}: {exc}",
                                    "can_confirm": False})
                continue
            matched_any = False
            for map_chrom in maps:
                seq = map_sequence(state, map_chrom)
                if not seq:
                    continue
                seq_md5 = sequence_md5(seq)   # the map version this evidence is matched against
                for ev in evidence:
                    existing = _linked(state, dataset_id, ev.contig)
                    if existing and existing.get("map_chrom") == map_chrom:
                        matched_any = True
                        ds_links.append(existing)
                        continue
                    if existing:
                        continue
                    result = match_contig(map_chrom, seq, ev, map_path=maps[map_chrom].get("path"))
                    if result.get("match"):
                        # Published only if the map and the dataset are still the ones matched (re-checked
                        # under the lock in apply_link); a stale match is dropped.
                        link = apply_link(
                            state, map_chrom, dataset_id, ev.contig, result["offset"],
                            method=result["method"], verified=result["verified"], detail=result.get("detail", ""),
                            expect_map_md5=seq_md5, expect_dataset=dataset,
                        )
                        if link is not None:
                            matched_any = True
                            ds_links.append(link)
                    elif result.get("match") is False:
                        problem = dict(result["problem"])
                        if ev.contig == map_chrom:
                            problem["shown_by_name"] = True
                            problem["message"] = ("Its reads are shown on the map because the names match, but "
                                                  "the positions may not correspond: " + problem["message"])
                        ds_problems.append({**problem, "dataset_id": dataset_id,
                                            "dataset_label": getattr(dataset, "label", dataset_id),
                                            "contig": ev.contig, "contig_length": ev.length,
                                            "chrom": map_chrom, "map_length": len(seq)})
            if not matched_any and not ds_problems and (report_unmatched or _looks_like_plasmid_bam(evidence)):
                names = ", ".join(f"{e.contig} ({e.length:,} bp)" for e in evidence[:6])
                wanted_maps = ", ".join(f"{m} ({len(map_sequence(state, m) or ''):,} bp)" for m in maps)
                ds_problems.append({
                    "dataset_id": dataset_id,
                    "dataset_label": getattr(dataset, "label", dataset_id),
                    "kind": "length",
                    "can_confirm": False,
                    "message": (f"No contig of {os.path.basename(bam_path)} is a loaded plasmid map: its contigs "
                                f"are {names}; the maps are {wanted_maps}. The lengths differ, so the reads were "
                                "aligned to another sequence: align them to the map (FiberHMM `fiberhmm-pipeline "
                                "--map`, or `scripts/align_plasmid_reads.py`), or load the map of that reference."),
                })
        if ds_links or ds_problems:
            previous = getattr(dataset, "plasmid_report", None) or {}
            dataset.plasmid_report = {
                **previous,
                "links": ds_links,
                "problems": ds_problems,
            }
        report["links"].extend(ds_links)
        report["problems"].extend(ds_problems)
    return report


def autoload_declared_maps(state, dataset) -> list[dict]:
    """Load the plasmid maps a BAM's ``@CO FIBERHMM-REFERENCE`` lines name (if not loaded)."""
    from routers.genome import _load_plasmid_into_state
    from services.plasmid_maps import parse_plasmid_map
    from services.runtime import get_public_mode

    if get_public_mode():
        return []
    loaded = []
    known_md5 = {m.get("map_md5") for m in _plasmid_maps(state).values() if m.get("map_md5")}
    known_paths = {_file_key(m["path"]) for m in _plasmid_maps(state).values() if m.get("path")}
    for bam_path in _local_bam_paths(dataset):
        try:
            import pysam
            with open_alignment_file(bam_path, "rb", check_sq=False) as bam:
                header = bam.header.to_dict()
        except Exception:
            continue
        for entry in parse_reference_comments(header):
            md5 = (entry.get("map_md5") or "").lower()
            if md5 and md5 in known_md5:
                continue
            if not entry.get("map"):
                continue  # a FASTA reference (a genome contig): nothing to load
            path = resolve_near(entry.get("map", ""), bam_path)
            if not path:
                if entry.get("map"):
                    loaded.append({"success": False, "path": entry.get("map"),
                                   "error": f"Map {entry.get('map')} named in {os.path.basename(bam_path)} was not found "
                                            "(next to the BAM or at that path). Load it with Open plasmid dataset."})
                continue
            if _file_key(path) in known_paths:
                continue
            try:
                # A map beside a cluster BAM is fetched whole (maps are small).
                readable = local_copy(path) if is_source_ref(path) else path
            except Exception as exc:
                loaded.append({"success": False, "path": path, "error": str(exc)})
                continue
            sha256 = (entry.get("source_sha256") or "").lower()
            if sha256:
                try:
                    same_file = _file_sha256(readable) == sha256
                except OSError:
                    same_file = False
                if not same_file:
                    loaded.append({"success": False, "path": path,
                                   "error": f"{os.path.basename(path)} has changed since {os.path.basename(bam_path)} "
                                            "was made (its SHA-256 differs); not loaded."})
                    continue
            try:
                plasmid = parse_plasmid_map(readable)
            except Exception as exc:
                loaded.append({"success": False, "path": path, "error": str(exc)})
                continue
            if md5 and not sha256 and sequence_md5(plasmid.sequence) != md5:
                loaded.append({"success": False, "path": path,
                               "error": f"{os.path.basename(path)} has changed since {os.path.basename(bam_path)} "
                                        "was made (its sequence checksum differs); not loaded."})
                continue
            if entry.get("circular") in ("0", "false", "no"):
                plasmid.circular = False
            # Read and parsed above, outside the lock; published under it, if still wanted: the dataset is
            # still the one loaded under its id, and no newer load put this map in meanwhile.
            with state_lock(state):
                if (getattr(state, "datasets", {}) or {}).get(dataset.id) is not dataset:
                    return loaded
                maps_now = _plasmid_maps(state).values()
                if sequence_md5(plasmid.sequence) in {m.get("map_md5") for m in maps_now if m.get("map_md5")} \
                        or _file_key(path) in {_file_key(m["path"]) for m in maps_now if m.get("path")}:
                    continue
                result = _load_plasmid_into_state(state, plasmid, path)
            loaded.append(result)
            known_md5.add(sequence_md5(plasmid.sequence))
            known_paths.add(_file_key(path))
    return loaded


def after_dataset_added(state, dataset, *, reference_fasta: str | None = None) -> dict:
    """A BAM was loaded: load the maps it declares, then link it to the loaded maps."""
    try:
        maps_loaded = autoload_declared_maps(state, dataset)
        report = reconcile(state, dataset_ids=[dataset.id], reference_fasta=reference_fasta)
    except Exception as exc:  # never fail a dataset load over this
        return {"links": [], "problems": [{"kind": "error", "message": f"Plasmid check failed: {exc}",
                                           "can_confirm": False}]}
    if maps_loaded:
        report["maps_loaded"] = maps_loaded
        dataset.plasmid_report = {**(getattr(dataset, "plasmid_report", None) or {}), "maps_loaded": maps_loaded}
    return report


def links_payload(state, chrom: str | None = None) -> dict:
    """Links and outstanding problems, for one chromosome or all maps."""
    maps = _plasmid_maps(state)
    chroms = [chrom] if chrom else list(maps)
    links = []
    for name in chroms:
        links.extend(_live_links(state, name))
    problems = []
    names = set(chroms)
    for dataset_id in getattr(state, "dataset_order", None) or []:
        dataset = (getattr(state, "datasets", {}) or {}).get(dataset_id)
        for problem in (getattr(dataset, "plasmid_report", None) or {}).get("problems") or []:
            if chrom and problem.get("chrom") not in names | {None}:
                continue
            if problem.get("contig") and _linked(state, dataset_id, problem["contig"]):
                continue
            problems.append(problem)
    return {"links": links, "problems": problems}


def session_links(state) -> list[dict]:
    """The links a session keeps (dataset paths, contigs, offsets, how they were made)."""
    out = []
    for chrom, meta in _plasmid_maps(state).items():
        for link in _live_links(state, chrom):
            out.append({
                "map_chrom": link.get("map_chrom") or meta.get("map_chrom") or chrom,
                "map_path": meta.get("path"),
                "paths": link.get("paths") or [],
                "contig": link.get("contig"),
                "offset": int(link.get("offset") or 0),
                "method": link.get("method"),
                "verified": bool(link.get("verified")),
                "detail": link.get("detail") or "",
            })
    return out


def restore_session_links(state, saved: list[dict]) -> list[dict]:
    """Re-apply a session's links (in order, so frames come back the same), then link the rest."""
    restored = []
    maps = _plasmid_maps(state)
    by_path = {}
    for name, meta in maps.items():
        if meta.get("path") and not meta.get("map_chrom"):
            by_path.setdefault(_file_key(meta["path"]), name)
    datasets = getattr(state, "datasets", {}) or {}
    for item in saved or []:
        map_chrom = item.get("map_chrom")
        if map_chrom not in maps or maps[map_chrom].get("map_chrom"):
            map_chrom = by_path.get(_file_key(item.get("map_path") or "")) if item.get("map_path") else None
        if not map_chrom:
            continue
        paths = [_file_key(p) for p in item.get("paths") or []]
        dataset_id = next((ds_id for ds_id, ds in datasets.items()
                           if [_file_key(p) for p in _dataset_paths(ds)] == paths), None)
        if dataset_id is None or not item.get("contig"):
            continue
        restored.append(apply_link(state, map_chrom, dataset_id, item["contig"], int(item.get("offset") or 0),
                                   method=item.get("method") or "session", verified=bool(item.get("verified")),
                                   detail=item.get("detail") or ""))
    reconcile(state)
    return restored
