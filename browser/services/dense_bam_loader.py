"""Legacy dense BAM DataFrame loading."""
from __future__ import annotations

import os
import traceback
from typing import Optional

import numpy as np
import pandas as pd

from models.domain import CigarCoordMapper
from services.bam_tags import (
    bam_legacy_frame,
    read_legacy_tags_are_molecular,
    MA_ALL_MOLECULAR,
    bam_ma_group_frame,
    legacy_starts_in_seq_frame,
    parse_ma_aq_tags_into_layers,
)
from services.diagnostics import env_flag_enabled, log_if_enabled
from services.sv_events import read_deletion_cuts, split_span
from utils.chrom import resolve_reference_name
from utils.validation import is_url

BAM_DIAGNOSTICS_ENV = "FIBERBROWSER_BAM_DIAGNOSTICS"


def bam_diagnostics_enabled() -> bool:
    """Return whether verbose BAM loader diagnostics should be printed."""
    return env_flag_enabled(BAM_DIAGNOSTICS_ENV)


def log_bam_diagnostic(message: str) -> None:
    """Print legacy BAM loader diagnostics only when explicitly enabled."""
    log_if_enabled(BAM_DIAGNOSTICS_ENV, message)


# MA/AQ layers holding the read's footprint calls (the ns/nl equivalent). The
# *_sr / consensus layers are alternative calls of the same footprints.
MA_FOOTPRINT_LAYERS = ("nuc", "tf", "fp_v2")


def _ma_reference_footprints(read, ref_start, ref_end, tags_are_molecular):
    """(footprints, msp_only) from a read's MA/AQ tags, in reference coordinates,
    or (None, False) when it has none. A read with only MSP calls gets its MSPs
    back with ``msp_only`` set, as legacy as/al do."""
    try:
        ma = read.get_tag("MA")
    except KeyError:
        # fibertools-rs v0.13+ writes the same spec as `Ma`, always molecular frame.
        try:
            ma = read.get_tag("Ma")
        except KeyError:
            return None, False
        tags_are_molecular = MA_ALL_MOLECULAR
    layers = parse_ma_aq_tags_into_layers(
        ma, None, CigarCoordMapper(read.cigartuples, ref_start), ref_start, ref_end,
        include_names=(*MA_FOOTPRINT_LAYERS, "msp"), include_qualities=False,
        read_length=read.query_length or 0, is_reverse=read.is_reverse,
        tags_are_molecular=tags_are_molecular,
    )
    def absolute(name):
        return [(ref_start + iv[0], ref_start + iv[1], iv[2]) for iv in (layers.get(name) or {}).get("intervals", [])]
    footprints = [fp for name in MA_FOOTPRINT_LAYERS for fp in absolute(name)]
    if footprints:
        return footprints, False
    msps = absolute("msp")
    if msps:
        return msps, True
    return None, False


def _legacy_reference_footprints(read, ns_tag, nl_tag, reads_with_tags, legacy_molecular):
    """A read's legacy ns/nl (or as/al) footprints in reference coordinates; None if unreadable."""
    if reads_with_tags == 1 and bam_diagnostics_enabled():
        log_bam_diagnostic(f"  First read tag info: ns type={type(ns_tag).__name__}, nl type={type(nl_tag).__name__}")
        if hasattr(ns_tag, 'dtype'):
            log_bam_diagnostic(f"  Tag dtype: ns={ns_tag.dtype}")
        try:
            sample = ns_tag[:3] if len(ns_tag) > 3 else ns_tag
            log_bam_diagnostic(f"  Sample ns values: {list(sample)}")
        except Exception:
            log_bam_diagnostic(f"  Raw ns value: {ns_tag}")

    if isinstance(ns_tag, np.ndarray):
        fp_starts_query = ns_tag.tolist()
        fp_lengths = nl_tag.tolist() if isinstance(nl_tag, np.ndarray) else list(nl_tag)
    elif isinstance(ns_tag, str):
        fp_starts_query = [int(x) for x in ns_tag.split(',') if x]
        fp_lengths = [int(x) for x in nl_tag.split(',') if x]
    elif isinstance(ns_tag, (list, tuple)):
        fp_starts_query = list(ns_tag)
        fp_lengths = list(nl_tag)
    else:
        try:
            fp_starts_query = list(ns_tag)
            fp_lengths = list(nl_tag)
        except Exception:
            return None

    if len(fp_starts_query) != len(fp_lengths):
        return None
    fp_starts_query = legacy_starts_in_seq_frame(fp_starts_query, fp_lengths, read, legacy_molecular)

    coord_mapper = CigarCoordMapper(read.cigartuples, read.reference_start)
    # Split at SV-sized deletions, as the read track's loader does (services/sv_events.py).
    cuts = read_deletion_cuts(read, mapper=coord_mapper)

    footprints = []
    for fp_start, fp_len in zip(fp_starts_query, fp_lengths):
        if int(fp_len) <= 0:
            continue
        # Both ends through the CIGAR, as the read track maps them;
        # a footprint starting in a soft clip keeps its aligned part.
        fp_ref_start, fp_ref_end = coord_mapper.footprint_to_ref(int(fp_start), int(fp_start) + int(fp_len) - 1)
        if fp_ref_start is None or fp_ref_end is None:
            continue
        if fp_ref_end > fp_ref_start:
            for piece_start, piece_end in split_span(fp_ref_start, fp_ref_end, cuts):
                footprints.append((piece_start, piece_end, fp_len))
    return footprints


def load_reads_from_bam(
    bam_path,
    chrom,
    start,
    end,
    spanning_only=True,
    chrom_map: Optional[dict] = None,
    contig_links: Optional[dict] = None,
):
    """
    Load BAM reads into the legacy signed-footprint DataFrame format.

    This supports older image/read endpoints that still consume dense DataFrames.
    Newer interactive paths should prefer compact-read loading.
    """
    import pysam

    remote = is_url(bam_path)
    if not remote:
        if not os.path.exists(bam_path):
            log_bam_diagnostic(f"BAM file not found: {bam_path}")
            return pd.DataFrame()

        # A BAI (either naming) or a CSI index, as pysam and the compact loader accept.
        from services.bam_handles import local_bam_index_exists
        if not local_bam_index_exists(bam_path):
            log_bam_diagnostic(f"BAM index not found for: {bam_path}")
            return pd.DataFrame()

    region_width = end - start
    reads_data = []
    reads_without_tags = 0
    reads_with_tags = 0

    try:
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(bam_path, "rb") as bam:
            # Checked against this BAM's own names: the session's map follows
            # the FASTA, which may name the chromosome differently.
            actual_chrom = resolve_reference_name(chrom, bam.references, chrom_map, links=contig_links)
            if actual_chrom is None:
                return pd.DataFrame()
            # Legacy tags in the molecular frame (fibertools, marked FiberHMM)
            # are flipped on reverse reads, as the compact loader does.
            try:
                legacy_frame = bam_legacy_frame(bam.header)
            except Exception:
                legacy_frame = (False, False)
            ma_molecular = bam_ma_group_frame(bam.header)

            from services.background_work import checkpoint
            from services.signal_evidence import signal_header, record_keeps_signal
            signal_provenance = signal_header(bam.header)
            records_seen = 0
            for read in bam.fetch(actual_chrom, start, end):
                records_seen += 1
                if not records_seen & 255:
                    checkpoint()  # a background job whose client went away stops here
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue

                if not record_keeps_signal(read, signal_provenance):
                    continue
                ref_start = read.reference_start
                ref_end = read.reference_end

                if spanning_only and (ref_start > start or ref_end < end):
                    continue

                ns_tag = None
                nl_tag = None
                msp_only = False

                try:
                    ns_tag = read.get_tag('ns')
                    nl_tag = read.get_tag('nl')
                except KeyError:
                    pass

                if ns_tag is None:
                    try:
                        ns_tag = read.get_tag('as')
                        nl_tag = read.get_tag('al')
                        # as/al are accessible MSPs, not footprints: the
                        # footprints are the stretches between them.
                        msp_only = True
                    except KeyError:
                        pass

                # No legacy tags: the footprints may be in MA/AQ layers.
                ma_footprints = None
                if ns_tag is None:
                    ma_footprints, msp_only = _ma_reference_footprints(read, ref_start, ref_end, ma_molecular)

                if ns_tag is None and ma_footprints is None:
                    reads_without_tags += 1
                    rd_start = max(ref_start, start)
                    rd_end = min(ref_end, end)
                    if rd_end > rd_start:
                        rd_row = np.zeros(region_width, dtype=np.int32)  # signed sizes exceed int16 (a 40-kb gap)
                        gap_size = rd_end - rd_start
                        rd_row[rd_start - start:rd_end - start] = -gap_size
                        reads_data.append({
                            'read_id': read.query_name,
                            'data': rd_row,
                        })
                    continue

                reads_with_tags += 1

                if ma_footprints is not None:
                    footprints = ma_footprints
                else:
                    footprints = _legacy_reference_footprints(
                        read, ns_tag, nl_tag, reads_with_tags, read_legacy_tags_are_molecular(read, legacy_frame))
                    if footprints is None:
                        continue

                # No footprints (empty tags): the whole covered span is accessible,
                # which the gap fill below writes; dropping the read would bias
                # accessibility down.
                footprints.sort(key=lambda interval: interval[0])
                if msp_only:
                    # MSP-only read: MSPs are the gaps, the rest of the read
                    # is protected (nucleosome-occupied between linkers).
                    protected = []
                    pos = ref_start
                    for msp_start, msp_end, _ in footprints:
                        if msp_start > pos:
                            protected.append((pos, msp_start, msp_start - pos))
                        pos = max(pos, msp_end)
                    if ref_end > pos:
                        protected.append((pos, ref_end, ref_end - pos))
                    footprints = protected

                rd_row = np.zeros(region_width, dtype=np.int32)  # signed sizes exceed int16 (a 40-kb gap)

                prev_pos = max(ref_start, start)
                for fp_start, fp_end, fp_size in footprints:
                    if fp_end <= start or fp_start >= end:
                        continue

                    fp_start_cl = max(fp_start, start)
                    fp_end_cl = min(fp_end, end)

                    if fp_start_cl > prev_pos >= start:
                        gap_size = fp_start_cl - prev_pos
                        rd_row[prev_pos - start:fp_start_cl - start] = -gap_size

                    rd_row[fp_start_cl - start:fp_end_cl - start] = fp_size
                    prev_pos = fp_end_cl

                read_end_cl = min(ref_end, end)
                if prev_pos < read_end_cl:
                    gap_size = read_end_cl - prev_pos
                    rd_row[prev_pos - start:read_end_cl - start] = -gap_size

                reads_data.append({
                    'read_id': read.query_name,
                    'data': rd_row,
                })

    except Exception as exc:
        log_bam_diagnostic(f"Error reading BAM file {bam_path}: {exc}")
        if bam_diagnostics_enabled():
            traceback.print_exc()
        return pd.DataFrame()

    if reads_without_tags > 0 and bam_diagnostics_enabled():
        log_bam_diagnostic(f"BAM loading stats for {chrom}:{start}-{end}:")
        log_bam_diagnostic(f"  Reads with tags: {reads_with_tags}, without tags (raw): {reads_without_tags}")

    if not reads_data:
        return pd.DataFrame()

    df = pd.DataFrame(
        [read['data'] for read in reads_data],
        columns=np.arange(start, end),
    )
    df['read_id'] = [read['read_id'] for read in reads_data]

    return df
