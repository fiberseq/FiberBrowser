"""BAM tag diagnostics used for layer detection and troubleshooting."""
from __future__ import annotations

import os
import bisect
import hashlib
import random
import re
import traceback
from typing import Optional

from utils.chrom import get_chrom_variants
from utils.validation import is_url

# Cheap tag-name scan cap for the sparse-tag rescue pass (see diagnose_bam_tags).
# Large enough to reach the tagged minority in DAF recall BAMs where only the
# mapped full-length molecules carry FiberHMM tags, while bounding worst-case
# cost for files that genuinely have no fiber-seq tags.
SPARSE_TAG_SCAN_LIMIT = 8000
# BAMs on a cluster (ssh:// references) are read over the network: every
# sampled window is a seek and the sparse-tag rescue reads whole molecules, so
# their probe is smaller (a few MB instead of ~150 MB for an untagged
# long-read DAF BAM). Refresh capabilities re-probes the same way.
REMOTE_SAMPLE_LIMIT = 20
REMOTE_SPARSE_TAG_SCAN_LIMIT = 250
_MA_TYPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def _declared_ma_layers(header) -> set[str]:
    """Read producer-declared MA layer names from BAM header comments.

    FiberHMM writes ``@CO MA-TYPES:v1:...`` so sparse annotation classes do
    not have to be rediscovered by sampling reads. Read-level MA inspection
    remains the fallback for older BAMs without this declaration.
    """
    try:
        header_dict = header.to_dict() if hasattr(header, "to_dict") else dict(header or {})
    except Exception:
        return set()

    layers: set[str] = set()
    prefix = "MA-TYPES:v1:"
    for comment in header_dict.get("CO", []) or []:
        text = str(comment).strip()
        if not text.startswith(prefix):
            continue
        for raw_name in text[len(prefix):].split(","):
            name = raw_name.strip()
            if _MA_TYPE_RE.fullmatch(name):
                layers.add(name)
    return layers


def _read_identity(read) -> tuple:
    """Stable-ish identity for de-duping reads sampled from overlapping windows."""
    return (
        getattr(read, "query_name", None),
        getattr(read, "reference_name", None),
        getattr(read, "reference_start", None),
        getattr(read, "reference_end", None),
    )


def _chrom_infos(header, chroms_to_try: list[str]) -> list[tuple[str, int]]:
    length_by_name = {}
    try:
        sq_records = header.get("SQ", [])
    except AttributeError:
        try:
            sq_records = header["SQ"]
        except Exception:
            sq_records = []
    for record in sq_records:
        name = record.get("SN")
        length = record.get("LN")
        if name and isinstance(length, int) and length > 0:
            length_by_name[name] = length
    return [
        (chrom_name, length_by_name[chrom_name])
        for chrom_name in chroms_to_try
        if chrom_name in length_by_name
    ]


def _has_random_access(bam) -> bool:
    has_index = getattr(bam, "has_index", None)
    if not callable(has_index):
        return False
    try:
        return bool(has_index())
    except Exception:
        return False


def _sample_index_offset_reads(bam, bam_path: str, chrom_infos: list[tuple[str, int]], limit: int,
                               seen_read_keys: set[tuple]) -> list:
    """Reads at fixed-seed record starts from the BAM's own index (local .bai only).

    A random window inside a deep region of long reads costs a fetch that decodes
    every read starting before the window and ending before it (half a second per
    window of a 3,000x capture of 70 kb reads); the linear index's offsets are
    record starts where reads are, read directly."""
    if limit <= 0 or not chrom_infos or not isinstance(bam_path, str):
        return []
    from services.bam_index_profile import bam_index
    refs = bam_index(bam_path)
    if not refs:
        return []
    candidates: list[tuple[int, int]] = []
    for name, _length in chrom_infos:
        try:
            tid = bam.get_tid(name)
        except Exception:
            continue
        idx = refs[tid] if 0 <= tid < len(refs) else None
        if idx is None:
            continue
        candidates.extend((tid, v) for v in sorted({v for v in idx.linear if v}))
    if not candidates:
        return []
    seed = int(hashlib.sha256("|".join(f"{n}:{l}" for n, l in chrom_infos).encode("utf-8")).hexdigest()[:16], 16)
    rng = random.Random(seed)
    picks = rng.sample(candidates, min(len(candidates), max(25, limit * 3)))
    reads: list = []
    candidate_seen = set(seen_read_keys)
    from contextlib import nullcontext
    with bam.lease() if hasattr(bam, "lease") else nullcontext(bam) as reader:
        for tid, voff in picks:
            if len(reads) >= limit:
                break
            try:
                reader.seek(voff)
                taken = 0
                for k, read in enumerate(reader):
                    if k >= 4 or taken >= 2 or read.reference_id != tid:
                        break
                    if read.is_unmapped or read.is_secondary:
                        continue
                    key = _read_identity(read)
                    if key in candidate_seen:
                        continue
                    candidate_seen.add(key)
                    reads.append(read)
                    taken += 1
                    if len(reads) >= limit:
                        break
            except Exception:
                continue
    return reads


def _sample_random_window_reads(
    bam,
    chrom_infos: list[tuple[str, int]],
    limit: int,
    seen_read_keys: set[tuple],
    window_size: int = 100_000,
) -> list:
    """Deterministically sample reads from random genomic windows.

    BAMs are usually coordinate sorted, so inspecting the first N alignments can
    mis-detect layers if the file prefix is low-quality, untagged, or from odd
    contigs. Random access cannot sample "read rows" directly; instead we sample
    fixed-seed genomic windows weighted by reference length and take a few reads
    per window.
    """
    if limit <= 0 or not chrom_infos:
        return []

    seed_payload = "|".join(f"{name}:{length}" for name, length in chrom_infos)
    seed = int(hashlib.sha256(seed_payload.encode("utf-8")).hexdigest()[:16], 16)
    rng = random.Random(seed)

    cumulative_lengths = []
    cumulative_ends = []
    running = 0
    for name, length in chrom_infos:
        running += length
        cumulative_lengths.append((running, name, length))
        cumulative_ends.append(running)
    if running <= 0:
        return []

    reads = []
    candidate_seen = set(seen_read_keys)
    max_windows = max(25, limit * 6)
    max_reads_per_window = 2

    for _ in range(max_windows):
        if len(reads) >= limit:
            break
        pick = rng.randrange(running)
        idx = bisect.bisect_right(cumulative_ends, pick)
        if idx >= len(cumulative_lengths):
            idx = len(cumulative_lengths) - 1
        _, chrom_name, chrom_len = cumulative_lengths[idx]
        span = min(window_size, chrom_len)
        if span <= 0:
            continue
        start = rng.randrange(0, max(1, chrom_len - span + 1))
        end = min(chrom_len, start + span)

        try:
            iterator = bam.fetch(chrom_name, start, end)
        except Exception:
            continue

        reads_from_window = 0
        for read in iterator:
            if read.is_unmapped or read.is_secondary:
                continue
            key = _read_identity(read)
            if key in candidate_seen:
                continue
            candidate_seen.add(key)
            reads.append(read)
            reads_from_window += 1
            if len(reads) >= limit or reads_from_window >= max_reads_per_window:
                break

    return reads


def diagnose_bam_tags(
    bam_path: str,
    chrom: Optional[str] = None,
    limit: int = 10,
    tag_scan_limit: int = SPARSE_TAG_SCAN_LIMIT,
) -> dict:
    """
    Inspect a small BAM sample and report available Fiber-seq/DAF-seq tags.

    The result feeds dataset layer detection and the `/api/diagnose_bam`
    endpoint. Keep this function lightweight: it should only sample enough
    reads to establish capabilities, not scan the whole file.
    """
    import pysam

    if not is_url(bam_path) and not os.path.exists(bam_path):
        return {"error": f"BAM file not found: {bam_path}"}
    from services.remote_sources import is_source_ref
    if is_source_ref(bam_path):
        limit = min(limit, REMOTE_SAMPLE_LIMIT)
        tag_scan_limit = min(tag_scan_limit, REMOTE_SPARSE_TAG_SCAN_LIMIT)

    try:
        tag_counts = {}
        tag_examples = {}
        reads_checked = 0

        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(bam_path, "rb") as bam:
            chroms = [ref["SN"] for ref in bam.header["SQ"]]
            if chrom:
                chroms_to_try = []
                for candidate in [chrom, *get_chrom_variants(chrom)]:
                    if candidate not in chroms_to_try:
                        chroms_to_try.append(candidate)
            else:
                chroms_to_try = chroms

            has_iupac_ry = False
            # Sampled reads with an st:Z strand tag, and those whose SEQ R/Y
            # marks say the other strand (services/read_strand.py).
            st_reads = 0
            st_conflicts = 0
            has_m6a_mm = False
            has_m5c_mm = False
            daf_mismatches = 0
            other_mismatches = 0
            # Producer declarations make sparse layers (notably per-read
            # ddda_mcg spans) visible even when no tagged molecule happens to
            # fall in the small diagnostic sample.
            declared_ma_layer_types = _declared_ma_layers(bam.header)
            from services.circular_genome import header_circular_contigs
            circular_contigs = header_circular_contigs(bam.header)
            from services.bam_tags import legacy_tag_frame_report
            legacy_tag_frame = legacy_tag_frame_report(bam.header)
            from services.graph_lift import lift_summary
            from services.read_strand import record_strand_fields
            graph_lift = lift_summary(bam.header)
            ma_layer_types: set[str] = set(declared_ma_layer_types)
            # Annotation types actually seen in MA/Ma tags (not just declared in the header).
            observed_ma_types: set[str] = set()
            # Types present in a read's MA/Ma tag, even with no intervals (a call that found none).
            present_ma_types: set[str] = set()
            has_circular_annotations = False
            seen_read_keys: set[tuple] = set()

            def _scan_tags(read) -> None:
                """Cheap tag-name scan (no per-base sequence analysis)."""
                nonlocal has_m6a_mm, has_m5c_mm, has_circular_annotations
                for tag, value in read.get_tags():
                    if tag not in tag_counts:
                        tag_counts[tag] = 0
                        val_str = str(value)
                        tag_examples[tag] = val_str[:100] + "..." if len(val_str) > 100 else val_str
                    tag_counts[tag] += 1

                    if tag in ("MM", "Mm") and isinstance(value, str):
                        if not has_m6a_mm and ("A+a" in value or "A-a" in value):
                            has_m6a_mm = True
                        if not has_m5c_mm and ("C+m" in value or "C-m" in value):
                            has_m5c_mm = True

                    # `Ma`: the same annotation spec as written by fibertools-rs v0.13+.
                    if tag in ("MA", "Ma") and isinstance(value, str):
                        for part in value.split(";")[1:]:
                            if ":" not in part:
                                continue
                            sig = part.split(":", 1)[0]
                            for separator in ("+", "-", "."):
                                idx = sig.find(separator)
                                if idx > 0:
                                    ma_layer_types.add(sig[:idx])
                                    present_ma_types.add(sig[:idx])
                                    if part.split(":", 1)[1].strip():
                                        observed_ma_types.add(sig[:idx])
                                    break
                    if tag in ("AN", "An") and isinstance(value, str):
                        names = [name for name in value.split(",") if name and name != "."]
                        has_circular_annotations = has_circular_annotations or len(names) != len(set(names))

            def _have_fiber_tags() -> bool:
                """True once a discriminating FiberHMM/fiber-seq tag is seen."""
                return (
                    ("ns" in tag_counts and "nl" in tag_counts)
                    or ("as" in tag_counts and "al" in tag_counts)
                    or bool(ma_layer_types)
                    or "MM" in tag_counts
                )

            def inspect_read(read) -> None:
                nonlocal reads_checked
                nonlocal has_iupac_ry
                nonlocal daf_mismatches, other_mismatches
                nonlocal st_reads, st_conflicts

                if reads_checked >= limit:
                    return
                if read.is_unmapped or read.is_secondary:
                    return
                key = _read_identity(read)
                if key in seen_read_keys:
                    return
                seen_read_keys.add(key)

                _scan_tags(read)

                if not has_iupac_ry and read.query_sequence:
                    seq = read.query_sequence.upper()
                    if "R" in seq or "Y" in seq:
                        has_iupac_ry = True

                strand_fields = record_strand_fields(read)
                if strand_fields.get("strand") in ("CT", "GA"):
                    st_reads += 1
                    st_conflicts += bool(strand_fields.get("strand_conflict"))

                try:
                    if read.has_tag("MD") and read.query_sequence:
                        pairs = read.get_aligned_pairs(with_seq=True)
                        qs = read.query_sequence
                        for qp, _rp, rb in pairs[:500]:
                            if qp is None or rb is None:
                                continue
                            ref_base = rb.upper()
                            read_base = qs[qp].upper() if qp < len(qs) else None
                            if read_base is None or read_base == ref_base:
                                continue
                            if (
                                (ref_base == "C" and read_base == "T")
                                or (ref_base == "G" and read_base == "A")
                            ):
                                daf_mismatches += 1
                            else:
                                other_mismatches += 1
                except Exception:
                    pass

                reads_checked += 1

            chrom_infos = _chrom_infos(bam.header, chroms_to_try)
            if _has_random_access(bam) and chrom_infos:
                for read in _sample_index_offset_reads(bam, bam_path, chrom_infos, limit, seen_read_keys):
                    inspect_read(read)
                    if reads_checked >= limit:
                        break
            if reads_checked < limit and _has_random_access(bam) and chrom_infos:
                for read in _sample_random_window_reads(
                    bam,
                    chrom_infos,
                    limit,
                    seen_read_keys,
                ):
                    inspect_read(read)
                    if reads_checked >= limit:
                        break

            # Fallback/fill path for unindexed, remote-without-random-access, or
            # sparse BAMs where random genomic windows did not yield enough reads.
            for try_chrom in chroms_to_try:
                if reads_checked >= limit:
                    break
                try:
                    for read in bam.fetch(try_chrom):
                        inspect_read(read)
                        if reads_checked >= limit:
                            break
                except ValueError:
                    continue

            # Sparse-tag rescue: when only a small fraction of reads carry
            # FiberHMM tags (e.g. DAF recall BAMs where just the mapped
            # full-length molecules are tagged), the small analysis sample can
            # miss them entirely. Cheaply scan more reads by tag name only,
            # stopping the moment a discriminating tag appears. This skips the
            # expensive MD/sequence analysis, so it stays fast even at the cap.
            if not _have_fiber_tags():
                scanned = 0
                for try_chrom in chroms_to_try:
                    if _have_fiber_tags() or scanned >= tag_scan_limit:
                        break
                    try:
                        for read in bam.fetch(try_chrom):
                            if read.is_unmapped or read.is_secondary:
                                continue
                            key = _read_identity(read)
                            if key in seen_read_keys:
                                continue
                            seen_read_keys.add(key)
                            _scan_tags(read)
                            scanned += 1
                            if _have_fiber_tags() or scanned >= tag_scan_limit:
                                break
                    except ValueError:
                        continue

            total_mismatches = daf_mismatches + other_mismatches
            has_daf_mismatches = (
                daf_mismatches >= 10
                and total_mismatches > 0
                and daf_mismatches / total_mismatches > 0.5
            )

        fiberseq_tags = {
            "ns": "nucleosome starts",
            "nl": "nucleosome lengths",
            "as": "FIRE/accessibility starts",
            "al": "FIRE/accessibility lengths",
            "aq": "FIRE quality scores",
            "nq": "nucleosome quality scores",
            "MM": "m6A/CpG modification positions",
            "ML": "modification likelihoods",
        }

        # An MA/Ma nuc./msp. type carries what the legacy arrays (and their
        # nq/aq qualities) would; fibertools >= 0.13 writes only Ma/Aq. A type
        # present with no intervals is a call that found none: still covered.
        covered_by_ma = set()
        if "nuc" in present_ma_types:
            covered_by_ma.update(("ns", "nl", "nq"))
        if "msp" in present_ma_types or "fire" in present_ma_types:
            covered_by_ma.update(("as", "al", "aq"))

        missing_tags = []
        present_tags = []
        for tag, desc in fiberseq_tags.items():
            if tag in tag_counts:
                present_tags.append(f"{tag} ({desc})")
            elif tag not in covered_by_ma:
                missing_tags.append(f"{tag} ({desc})")

        return {
            "bam_path": bam_path,
            "chromosomes": chroms[:10],
            "reads_checked": reads_checked,
            "sampled_reads": reads_checked,
            "all_tags": {
                tag: {"count": count, "example": tag_examples.get(tag)}
                for tag, count in sorted(tag_counts.items())
            },
            "fiberseq_present": present_tags,
            "fiberseq_missing": missing_tags,
            "has_nucleosomes": "ns" in tag_counts and "nl" in tag_counts,
            "has_msps": "as" in tag_counts and "al" in tag_counts,
            # Nucleosomes/MSPs carried only in an MA/Ma tag (current fibertools
            # `ft add-nucleosomes`/`predict-m6a` write no ns/nl, only
            # Ma:Z:<len>;nuc.:...;msp.:...). has_nucleosomes/has_msps stay the
            # legacy ns/nl, as/al signals (they drive the `footprint` layer).
            "has_ma_nucleosomes": "nuc" in observed_ma_types,
            "has_ma_msps": "msp" in observed_ma_types,
            "has_fire": (
                ("aq" in tag_counts and "as" in tag_counts and "al" in tag_counts)
                or "fire" in observed_ma_types
            ),
            "has_m6a": has_m6a_mm or (("MM" in tag_counts) and not has_m5c_mm and not has_m6a_mm),
            "has_m5c": has_m5c_mm,
            "has_deam": has_iupac_ry or has_daf_mismatches,
            "has_iupac_ry": has_iupac_ry,
            "has_daf_mismatches": has_daf_mismatches,
            # fiberhmm-merge/-pair consensus reads write their per-strand
            # coverage as deam+/deam-; they are offered as the deam_ct and
            # deam_ga layers (bam_tags.DEAM_STRAND_LAYERS).
            "ma_layers": sorted(ma_layer_types | ({"deam_ct", "deam_ga"} if "deam" in ma_layer_types else set())),
            "declared_ma_layers": sorted(declared_ma_layer_types),
            "has_circular_annotations": has_circular_annotations,
            # Frame of the legacy ns/nl/as/al tags and how it was decided
            # (docs/reference/footprint-tag-frame.md).
            "legacy_tag_frame": legacy_tag_frame,
            # @SQ TP:circular contigs (the SAM circular representation).
            "circular_contigs": circular_contigs,
            # Sampled reads whose st:Z tag and SEQ R/Y marks name different DAF strands.
            "st_strand_reads": st_reads,
            "st_strand_conflicts": st_conflicts,
            # A pangenome-graph lift (services/graph_lift.lift_summary), or None.
            "graph_lift": graph_lift,
        }
    except Exception as exc:
        return {"error": str(exc), "traceback": traceback.format_exc()}
