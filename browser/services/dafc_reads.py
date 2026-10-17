"""DAF-C read querying and linked-read helpers."""
from __future__ import annotations

from services.bigbed_bounds import bigbed_entries_in_bounds
import os
from collections import defaultdict
from typing import Dict, List

import numpy as np
import pyBigWig

from models.domain import CigarCoordMapper, ContactMode
from services.sv_events import read_deletion_cuts, split_span
from services.bam_tags import (
    bam_consensus_contracts, bam_legacy_frame, bam_ma_group_frame, legacy_starts_in_seq_frame,
    read_legacy_tags_are_molecular,
)
from services.compact_read_loader import _read_ma_tags, ma_footprint_query_spans
from services.graph_lift import is_lift_duplicate, is_unrepaired_lift, lift_duplicate_records
from services.dafc_diagnostics import DAFC_DIAGNOSTICS_ENV, log_dafc_diagnostic
from state.dependencies import get_dafc_state, get_state
from utils.chrom import get_chrom_variants
from utils.validation import is_url


def log_dafc_read_diagnostic(message: str) -> None:
    """Print DAF-C read-query diagnostics only when explicitly enabled."""
    log_dafc_diagnostic(message)


def get_base_read_id(name: str) -> str:
    """Extract base read ID by removing a numeric ligated-segment suffix."""
    parts = name.rsplit('_', 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0]
    return name


def query_bigbed_for_dafc(bb, chrom: str, start: int, end: int) -> List[Dict]:
    """Query BigBed file for DAF-C entries with full BED12 parsing."""
    if bb is None:
        return []

    available = bb.chroms() or {}
    matching_chrom = None
    for variant in get_chrom_variants(chrom):
        if variant in available:
            matching_chrom = variant
            break
    if matching_chrom is None:
        return []

    try:
        entries = bigbed_entries_in_bounds(bb, matching_chrom, start, end)
        if entries is None:
            return []
    except Exception as e:
        log_dafc_read_diagnostic(f"Error querying BigBed: {e}")
        return []

    reads = []
    for entry in entries:
        fields = entry[2].split('\t')
        reads.append({
            'chrom': matching_chrom,
            'start': entry[0],
            'end': entry[1],
            'name': fields[0] if len(fields) > 0 else '',
            'score': fields[1] if len(fields) > 1 else '0',
            'strand': fields[2] if len(fields) > 2 else '+',
            'blockCount': int(fields[6]) if len(fields) > 6 and fields[6].isdigit() else 0,
            'blockSizes': fields[7] if len(fields) > 7 else '',
            'blockStarts': fields[8] if len(fields) > 8 else '',
            # Block columns present: an empty list means "no footprints", not "unknown".
            'footprintsCalled': len(fields) > 8,
        })
    return reads


def _ma_has_nuc_group(ma) -> bool:
    """Whether an MA/Ma tag has a ``nuc`` group (nucleosomes were called, maybe none)."""
    for part in str(ma or '').split(';')[1:]:
        head = part.partition(':')[0]
        if head.startswith('nuc') and head[3:4] in ('+', '-', '.'):
            return True
    return False


def query_bam_for_dafc(bam_path: str, chrom: str, start: int, end: int) -> List[Dict]:
    """Query BAM file for DAF-C entries, returning all reads overlapping region."""
    import pysam

    if not bam_path:
        return []
    if not is_url(bam_path) and not os.path.exists(bam_path):
        return []

    reads = []
    try:
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(bam_path, "rb") as bam:  # a lab server: confined on every reopen
            actual_chrom = chrom
            if chrom not in bam.references:
                for variant in get_chrom_variants(chrom):
                    if variant in bam.references:
                        actual_chrom = variant
                        break
                if actual_chrom not in bam.references:
                    return []
            # Molecular-frame legacy tags are flipped on reverse reads, as the
            # compact loader does; detected once per file.
            try:
                legacy_frame = bam_legacy_frame(bam.header)
            except Exception:
                legacy_frame = (False, False)
            # FiberHMM 3.0 MA / fibertools Ma nucleosomes (no ns/nl), with the
            # header's per-group frame, as the read track reads them.
            try:
                ma_frame = bam_ma_group_frame(bam.header)
                family_contracts = bam_consensus_contracts(bam.header)
            except Exception:
                ma_frame, family_contracts = False, {}
            # An unrepaired graph lift: each molecule once (services/graph_lift.py).
            lift_drop = (lift_duplicate_records(bam.fetch(actual_chrom, start, end))
                         if is_unrepaired_lift(bam.header) else set())

            for read in bam.fetch(actual_chrom, start, end):
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                if lift_drop and is_lift_duplicate(read, lift_drop):
                    continue

                ref_start = read.reference_start

                block_starts = ''
                block_sizes = ''
                block_count = 0
                footprints_called = False

                try:
                    seq_spans = None
                    if read.has_tag('ns') and read.has_tag('nl'):
                        ns_tag = read.get_tag('ns')
                        nl_tag = read.get_tag('nl')
                        if hasattr(ns_tag, 'tolist'):
                            ns_list = ns_tag.tolist()
                            nl_list = nl_tag.tolist()
                        else:
                            ns_list = list(ns_tag)
                            nl_list = list(nl_tag)
                        footprints_called = True
                        if len(ns_list) > 0 and len(ns_list) == len(nl_list):
                            seq_starts = legacy_starts_in_seq_frame(ns_list, nl_list, read, read_legacy_tags_are_molecular(read, legacy_frame))
                            seq_spans = list(zip(seq_starts, nl_list))
                    else:
                        ma_tags = _read_ma_tags(read, ma_frame)
                        if ma_tags is not None and _ma_has_nuc_group(ma_tags[0]):
                            footprints_called = True
                            seq_spans = [(q_start, q_end - q_start) for name, q_start, q_end in ma_footprint_query_spans(
                                ma_tags, read_length=read.query_length or 0, is_reverse=read.is_reverse,
                                family_contracts=family_contracts) if name == 'nuc']

                    if seq_spans:
                        mapper = CigarCoordMapper(read.cigartuples, ref_start)
                        # Footprints spanning an SV-sized deletion are split at it,
                        # as the read track's loader splits them (services/sv_events.py).
                        cuts = read_deletion_cuts(read, mapper=mapper)
                        blocks = []
                        for ns, nl in seq_spans:
                            if int(nl) <= 0:
                                continue
                            # Both ends through the CIGAR: the block's
                            # reference length, across indels.
                            fp_ref_start, fp_ref_end = mapper.footprint_to_ref(int(ns), int(ns) + int(nl) - 1)
                            if fp_ref_start is None or fp_ref_end is None or fp_ref_end <= fp_ref_start:
                                continue
                            for piece_start, piece_end in split_span(fp_ref_start, fp_ref_end, cuts):
                                rel_start = piece_start - ref_start
                                if rel_start >= 0:
                                    blocks.append((rel_start, piece_end - piece_start))
                        # BED blocks ascend (a flipped reverse read's come reversed).
                        blocks.sort()
                        ref_block_starts = [b[0] for b in blocks]
                        ref_block_sizes = [b[1] for b in blocks]

                        if ref_block_starts:
                            block_starts = ','.join(str(s) for s in ref_block_starts)
                            block_sizes = ','.join(str(s) for s in ref_block_sizes)
                            block_count = len(ref_block_starts)
                except KeyError:
                    pass

                reads.append({
                    'chrom': chrom,
                    'start': ref_start,
                    'end': read.reference_end,
                    'name': read.query_name,
                    'score': '0',
                    'strand': '-' if read.is_reverse else '+',
                    'blockCount': block_count,
                    'blockSizes': block_sizes,
                    'blockStarts': block_starts,
                    'footprintsCalled': footprints_called,
                })
    except Exception as e:
        log_dafc_read_diagnostic(f"Error querying BAM for DAF-C: {e}")

    return reads


def query_reads_for_dafc(chrom: str, start: int, end: int, state=None, dafc_state=None) -> List[Dict]:
    """Query reads from the best available source for DAF-C linked-read views."""
    if state is None:
        state = get_state()
    if dafc_state is None:
        dafc_state = get_dafc_state()

    if dafc_state.bb is not None:
        return query_bigbed_for_dafc(dafc_state.bb, chrom, start, end)

    if state is not None and state.datasets:
        first_dataset_id = state.first_dataset_id() if hasattr(state, "first_dataset_id") else (
            state.dataset_order[0] if state.dataset_order else None
        )
        primary_dataset = state.datasets.get(first_dataset_id) if first_dataset_id else None

        if primary_dataset:
            if primary_dataset.data_type == 'bam':
                all_results = []
                for bam_path in primary_dataset.paths:
                    results = query_bam_for_dafc(bam_path, chrom, start, end)
                    all_results.extend(results)
                return all_results
            if primary_dataset.data_type == 'bigbed':
                # A merged dataset: molecules from every file, as for BAMs.
                all_results = []
                for path in primary_dataset.paths:
                    try:
                        from services.remote_sources.opening import open_bigwig
                        with open_bigwig(path) as bb:  # a lab server: confined on every reopen
                            all_results.extend(query_bigbed_for_dafc(bb, chrom, start, end))
                    except Exception as e:
                        log_dafc_read_diagnostic(f"Error querying BigBed from dataset: {e}")
                return all_results

    return []


def find_ligated_reads(
    chrom: str,
    x_start: int,
    x_end: int,
    y_start: int,
    y_end: int,
    state=None,
    dafc_state=None,
) -> List[Dict]:
    """Find reads with segments in both X and Y contact regions."""
    x_entries = query_reads_for_dafc(chrom, x_start, x_end, state=state, dafc_state=dafc_state)
    y_entries = query_reads_for_dafc(chrom, y_start, y_end, state=state, dafc_state=dafc_state)

    x_by_id = defaultdict(list)
    for entry in x_entries:
        base_id = get_base_read_id(entry['name'])
        x_by_id[base_id].append(entry)

    y_by_id = defaultdict(list)
    for entry in y_entries:
        base_id = get_base_read_id(entry['name'])
        y_by_id[base_id].append(entry)

    ligated = []
    for read_id in x_by_id:
        if read_id in y_by_id:
            ligated.append({
                'read_id': read_id,
                'x_segments': x_by_id[read_id],
                'y_segments': y_by_id[read_id],
            })

    return ligated


def detect_contact_mode(x_entries: List[Dict], y_entries: List[Dict], threshold: float = 0.1) -> ContactMode:
    """Detect DAF-C vs Micro-C mode by checking shared base read IDs."""
    x_base_ids = {get_base_read_id(entry['name']) for entry in x_entries}
    y_base_ids = {get_base_read_id(entry['name']) for entry in y_entries}

    shared = x_base_ids & y_base_ids
    total = len(x_base_ids | y_base_ids)

    if total == 0:
        return ContactMode.MICROC

    shared_ratio = len(shared) / total
    return ContactMode.DAFC if shared_ratio > threshold else ContactMode.MICROC


def build_read_footprint_array(segments: List[Dict], region_start: int, region_end: int) -> np.ndarray:
    """Build a signed footprint array for a read's segments in a region."""
    region_len = region_end - region_start

    if not segments:
        return np.zeros(region_len, dtype=np.int32)

    all_start = min(s['start'] for s in segments)
    all_end = max(s['end'] for s in segments)
    read_len = all_end - all_start

    # int32: signed sizes exceed int16 (a 40-kb gap is -40000).
    read_array = np.zeros(read_len, dtype=np.int32)

    for seg in segments:
        seg_start = seg['start']
        block_sizes_str = seg.get('blockSizes', '')
        block_starts_str = seg.get('blockStarts', '')

        if not block_sizes_str or not block_starts_str:
            if seg.get('footprintsCalled'):
                # Footprints were called and there are none: the whole
                # segment is one accessible gap.
                seg_offset = seg_start - all_start
                seg_len = seg['end'] - seg_start
                gap_start = max(0, seg_offset)
                gap_end = min(read_len, seg_offset + seg_len)
                if gap_end > gap_start:
                    read_array[gap_start:gap_end] = -seg_len
            continue

        try:
            block_sizes = [int(x) for x in block_sizes_str.rstrip(',').split(',') if x]
            block_starts = [int(x) for x in block_starts_str.rstrip(',').split(',') if x]
        except ValueError:
            continue

        seg_offset = seg_start - all_start
        prev_end = 0

        for bs, bstart in zip(block_sizes, block_starts):
            if bstart > prev_end:
                gap_size = bstart - prev_end
                gap_start = seg_offset + prev_end
                gap_end = seg_offset + bstart
                if gap_end <= read_len and gap_start >= 0:
                    read_array[gap_start:gap_end] = -gap_size

            fp_start = seg_offset + bstart
            fp_end = seg_offset + bstart + bs
            if fp_end <= read_len and fp_start >= 0:
                read_array[fp_start:fp_end] = bs

            prev_end = bstart + bs

        seg_len = seg['end'] - seg_start
        if prev_end < seg_len:
            gap_size = seg_len - prev_end
            gap_start = seg_offset + prev_end
            gap_end = seg_offset + seg_len
            if gap_end <= read_len and gap_start >= 0:
                read_array[gap_start:gap_end] = -gap_size

    slice_start = region_start - all_start
    slice_end = region_end - all_start

    output = np.zeros(region_len, dtype=np.int32)

    read_in_region_start = max(0, -slice_start)
    read_in_region_end = min(region_len, read_len - slice_start)
    read_slice_start = max(0, slice_start)
    read_slice_end = min(read_len, slice_end)

    if read_slice_end > read_slice_start:
        output[read_in_region_start:read_in_region_end] = read_array[read_slice_start:read_slice_end]

    return output
