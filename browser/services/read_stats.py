"""Selected-read statistics computation for the Read Stats analysis panel."""
from __future__ import annotations

from typing import Optional

import numpy as np

from services.bam_handles import get_bam_handle
# One uncalled-read rule for the read loaders and read stats (re-exported here).
from services.bam_tags import footprint_call_count, read_has_footprint_calls  # noqa: F401
from services.compact_read_loader import qcfail_metadata
from utils.chrom import resolve_reference_name
from services.analysis_query import AnalysisReadQuery
from services.diagnostics import log_if_enabled


READ_STATS_DIAGNOSTICS_ENV = "FIBERBROWSER_READ_STATS_DIAGNOSTICS"

# Most reads one request computes statistics for (a group such as "reads
# shown" or a cluster can hold thousands). Past it the first reads in the
# request's order are used and the response says ``truncated``.
MAX_READ_STATS_IDS = 5000



# Stats are for reads in view: load the view (a display entry covering it is still reused).
READ_STATS_PREFETCH_MULTIPLIER = 1

def _cap_scopes(scopes, cap: int):
    """Keep the first ``cap`` distinct read ids over all scopes, in order."""
    total = sum(len(dict.fromkeys(ids)) for *_, ids_by_ds in scopes for ids in (ids_by_ds or {}).values())
    if total <= cap:
        return scopes, total, False
    budget = cap
    capped = []
    for scope_query, scope_start, scope_end, ids_by_ds in scopes:
        kept = {}
        for ds, ids in (ids_by_ds or {}).items():
            if budget <= 0:
                break
            unique = list(dict.fromkeys(ids))[:budget]
            budget -= len(unique)
            if unique:
                kept[ds] = unique
        capped.append((scope_query, scope_start, scope_end, kept))
    return capped, total, True


def log_read_stats_diagnostic(message: str) -> None:
    """Print read-stats diagnostics only when explicitly enabled."""
    log_if_enabled(READ_STATS_DIAGNOSTICS_ENV, message)


def compute_read_stats(
    state,
    chrom: str,
    start: int,
    end: int,
    spanning: bool,
    request,
    query: AnalysisReadQuery | None = None,
) -> dict:
    """Compute per-read alignment and footprint statistics for selected reads."""
    query = query or AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        read_ids_by_dataset=request.read_ids_by_dataset,
        sample_seed=request.sample_seed,
        include_methylation=True,
        hide_uncalled=getattr(request, "hide_uncalled", None),
    )
    sample_seed = query.sample_seed
    # The main view's selection, then any selected in panels at another locus
    # (each looked up at its own region); one aggregate over all of them.
    scopes = [(query, start, end, query.read_ids_by_dataset)]
    for region in getattr(request, "extra_regions", None) or []:
        extra = AnalysisReadQuery.from_request(
            state,
            chrom=region.chrom,
            start=region.start,
            end=region.end,
            spanning=spanning,
            read_ids_by_dataset=region.read_ids_by_dataset,
            sample_seed=request.sample_seed,
            include_methylation=True,
            hide_uncalled=query.hide_uncalled,
        )
        scopes.append((extra, region.start, region.end, extra.read_ids_by_dataset))
    scopes, requested_total, truncated = _cap_scopes(scopes, MAX_READ_STATS_IDS)

    per_read = []
    all_fp_sizes = []
    all_acc_pcts = []
    all_lengths = []
    all_mapqs = []
    all_methyl_pcts = []
    strand_counts = {"+": 0, "-": 0}
    missing_read_ids_by_dataset = {}
    requested_count = 0
    dataset_ids = set()
    # Reads in the regions the read filters hid (whichever reads were selected).
    hidden = {"uncalled": 0, "min_footprints": 0}
    min_footprints = max(0, int(getattr(request, "min_footprints", 0) or 0))

    for scope_query, scope_start, scope_end, scope_ids in scopes:
        requested_count += sum(len(dict.fromkeys(ids)) for ids in (scope_ids or {}).values())
        dataset_ids.update(ds for ds, ids in (scope_ids or {}).items() if ids)
        _collect_scope(
            state, scope_query, scope_start, scope_end, scope_ids,
            per_read=per_read, all_fp_sizes=all_fp_sizes, all_acc_pcts=all_acc_pcts,
            all_lengths=all_lengths, all_mapqs=all_mapqs, all_methyl_pcts=all_methyl_pcts,
            strand_counts=strand_counts, missing_read_ids_by_dataset=missing_read_ids_by_dataset,
            include_qcfail=getattr(request, "include_qcfail", False),
            min_footprints=min_footprints, hidden=hidden,
        )

    aggregate = _build_aggregate(
        per_read=per_read,
        request=request,
        all_fp_sizes=all_fp_sizes,
        all_acc_pcts=all_acc_pcts,
        all_lengths=all_lengths,
        all_mapqs=all_mapqs,
        all_methyl_pcts=all_methyl_pcts,
        strand_counts=strand_counts,
    )
    aggregate["n_datasets"] = len(dataset_ids)
    # Which read filter hid what: "N uncalled hidden · M with < K footprints hidden".
    aggregate["hide_uncalled"] = bool(query.hide_uncalled)
    aggregate["n_hidden_uncalled"] = hidden["uncalled"] if query.hide_uncalled else 0
    aggregate["min_footprints"] = min_footprints
    aggregate["n_hidden_min_footprints"] = hidden["min_footprints"] if min_footprints > 0 else 0

    any_bam = any(
        state.get_dataset(ds_id) and state.get_dataset(ds_id).data_type == "bam"
        for ds_id in dataset_ids
    )

    return {
        "per_read": per_read,
        "aggregate": aggregate,
        "is_bam": any_bam,
        "requested_count": requested_count,
        "found_count": len(per_read),
        "missing_read_ids_by_dataset": missing_read_ids_by_dataset,
        "sample_seed": sample_seed,
        "truncated": truncated,
        "requested_total": requested_total,
        "max_reads": MAX_READ_STATS_IDS,
    }


def _collect_scope(
    state, query, start, end, read_ids_by_dataset, *, per_read, all_fp_sizes, all_acc_pcts,
    all_lengths, all_mapqs, all_methyl_pcts, strand_counts, missing_read_ids_by_dataset,
    include_qcfail=False, min_footprints=0, hidden=None,
):
    """Per-read stats for one region's selected reads, added to the accumulators."""
    chrom = query.chrom
    for dataset_id, read_ids in (read_ids_by_dataset or {}).items():
        if not read_ids:
            continue

        dataset = state.get_dataset(dataset_id)
        if not dataset:
            continue

        requested_ids = list(dict.fromkeys(read_ids))
        wanted = set(requested_ids)
        is_bam = dataset.data_type == "bam"

        # Scope the working set to the selected IDs so backend caps do not
        # sample selected reads out before per-read stats are computed.
        if is_bam and include_qcfail:
            # Opt-in reads are outside the default analysis cache. Use the same
            # direct read policy and quality gates as their displayed panel.
            from models.domain import WorkingSet
            from services.read_endpoint import compact_reads_payload_for_request
            payload = compact_reads_payload_for_request(
                state, chrom=chrom, start=start, end=end, dataset_id=dataset_id,
                spanning=query.spanning, max_reads=0, filter_ids=",".join(requested_ids),
                include_qcfail=True, include_methylation=True, include_layers=query.include_layers,
                layer_names=",".join(query.requested_layers) or None,
                include_layer_qualities=query.include_layer_qualities,
                infer_legacy_layers=query.infer_legacy_layers, legacy_nuc_min_size=query.legacy_nuc_min_size,
                min_footprints=query.min_footprints,
                hide_uncalled=query.hide_uncalled,
            )
            ws = WorkingSet(payload["reads"], payload["total_overlapping"], payload["total_spanning"],
                            chrom, start, end)
        else:
            ws = query.build_working_set(
                state,
                dataset_id,
                read_ids=requested_ids,
                include_methylation=True,
                # BAM: the selected reads in this region only, no 10x prefetch around
                # it (with methylation decoded that load took 5-72 s on deep data).
                # BigBed keeps the prefetch: its companion layers outside the view
                # count in the terminal-gap filter, so a narrower load can change it.
                broad_prefetch_multiplier=READ_STATS_PREFETCH_MULTIPLIER if is_bam else None,
            )

        if is_bam:
            from services.plasmid_reconcile import contig_links
            _collect_bam_read_stats(
                dataset=dataset,
                dataset_id=dataset_id,
                contig_links=contig_links(state, dataset_id=dataset_id),
                short_terminal_footprint_bp=_short_terminal_bp(state),
                include_qcfail=include_qcfail,
                hide_uncalled=query.hide_uncalled,
                spanning=query.spanning,
                min_footprints=min_footprints,
                hidden=hidden,
                wanted=wanted,
                read_ids=read_ids,
                ws=ws,
                chrom=chrom,
                start=start,
                end=end,
                per_read=per_read,
                all_fp_sizes=all_fp_sizes,
                all_acc_pcts=all_acc_pcts,
                all_lengths=all_lengths,
                all_mapqs=all_mapqs,
                all_methyl_pcts=all_methyl_pcts,
                strand_counts=strand_counts,
            )
        else:
            _collect_bigbed_read_stats(
                dataset_id=dataset_id,
                requested_ids=requested_ids,
                wanted=wanted,
                ws=ws,
                per_read=per_read,
                all_fp_sizes=all_fp_sizes,
                all_acc_pcts=all_acc_pcts,
                all_lengths=all_lengths,
                all_methyl_pcts=all_methyl_pcts,
            )

        if wanted:
            missing = missing_read_ids_by_dataset.setdefault(dataset_id, [])
            missing.extend(sorted(wanted - set(missing)))


def _collect_bam_read_stats(
    *,
    dataset,
    dataset_id: str,
    wanted: set,
    read_ids: list,
    ws,
    chrom: str,
    start: int,
    end: int,
    per_read: list,
    all_fp_sizes: list,
    all_acc_pcts: list,
    all_lengths: list,
    all_mapqs: list,
    all_methyl_pcts: list,
    strand_counts: dict,
    contig_links: dict | None = None,
    include_qcfail: bool = False,
    hide_uncalled: bool = False,
    spanning: bool = False,
    min_footprints: int = 0,
    hidden: dict | None = None,
    short_terminal_footprint_bp: int = 0,
) -> None:
    """Collect stats from BAM alignment records plus compact working-set intervals.

    A read whose calls are only in MA/Ma tags (current FiberHMM, fibertools
    ``Ma``) has a placeholder row in the working set (its calls sit in layers,
    which Read Stats may not have loaded): its footprints and gaps are read
    from the record's MA tag instead (``_ma_only_intervals``).

    ``hidden``: adds the region's reads (as the read track counts them: primary,
    not duplicate, QC-fail or signal-hidden, spanning when asked) that "Hide reads
    without footprint calls" (``uncalled``, with ``hide_uncalled``) and "Min
    footprints" (``min_footprints``: reads with fewer calls, uncalled ones too when
    they are shown) hid. An uncalled read is never reported as selected when hidden."""
    counted = set()
    for bam_path in dataset.paths:
        bam = get_bam_handle(bam_path)
        if bam is None:
            continue
        # The BAM's own name for the chromosome (chr1 vs 1), as the read
        # loaders resolve it; a BAM without it has none of these reads.
        references = getattr(bam, "references", None)
        bam_chrom = resolve_reference_name(chrom, references, links=contig_links) if references else chrom
        if bam_chrom is None:
            continue
        from services.signal_evidence import record_keeps_signal, record_signal, signal_header
        provenance = signal_header(getattr(bam, "header", None))
        from services.signal_counts import _legacy_frame
        legacy_frame = _legacy_frame(bam_path, bam) if getattr(bam, "header", None) is not None else None
        ma_frame, ma_contracts = _ma_header_context(bam)
        try:
            for read in bam.fetch(bam_chrom, start, end):
                # Only the primary alignment is the displayed read (the read
                # loaders skip the others); a secondary or supplementary record
                # sharing its name must not stand in for it.
                if (getattr(read, "is_unmapped", False) or getattr(read, "is_secondary", False)
                        or getattr(read, "is_supplementary", False)):
                    continue
                if getattr(read, "is_qcfail", False) and not include_qcfail:
                    continue
                if not record_keeps_signal(read, provenance):
                    continue
                called = read_has_footprint_calls(read)
                # A QC-fail read shown by choice is never hidden as uncalled (chimeras carry no calls).
                exempt = bool(getattr(read, "is_qcfail", False))
                if hidden is not None and read.query_name not in counted and not getattr(read, "is_duplicate", False) and (
                        not spanning or (read.reference_start <= start and (read.reference_end or 0) >= end)):
                    counted.add(read.query_name)
                    if not called and hide_uncalled and not exempt:
                        hidden["uncalled"] += 1
                    elif min_footprints > 0 and (not called or footprint_call_count(read, legacy_frame) < min_footprints):
                        # With uncalled reads shown, Min footprints hides them too (0 calls), as the loaders do.
                        hidden["min_footprints"] += 1
                if hide_uncalled and not called and not exempt:
                    # Hidden from the read track and every analysis: not a selected read.
                    wanted.discard(read.query_name)
                    continue
                if read.query_name not in wanted:
                    continue
                wanted.discard(read.query_name)

                mapq = read.mapping_quality
                strand = "-" if read.is_reverse else "+"
                read_length = read.query_length or 0
                aligned_span = read.reference_length or 0

                try:
                    nm = read.get_tag("NM")
                except (KeyError, ValueError):
                    nm = None

                ws_read = ws.read_by_id.get(read.query_name)
                ma_intervals = None
                if called and _calls_only_in_ma(read):
                    ma_intervals = _ma_only_intervals(
                        read, start, end, ma_frame, ma_contracts, short_terminal_footprint_bp)
                interval_stats = _summarize_intervals(
                    ma_intervals if ma_intervals is not None else (ws_read.get("intervals") if ws_read else []))

                methyl_count = None
                methyl_pct = None
                if ws_read:
                    methyl_marks = ws_read.get("methyl", [])
                    if methyl_marks is not None:
                        methyl_count = len(methyl_marks)
                        methyl_pct = (
                            methyl_count / interval_stats["total_span_bp"] * 100
                            if interval_stats["total_span_bp"] > 0
                            else 0.0
                        )

                # Every read's alignment bounds (the read table's ref_start /
                # ref_end); the CIGAR and read-relative positions only for one read.
                ref_start = read.reference_start
                ref_end = read.reference_end
                cigar_string = None
                cigar_ops = None
                fp_intervals_rel = None
                methyl_pos_rel = None
                if len(read_ids) == 1 and read.cigartuples:
                    cigar_string = read.cigarstring
                    cigar_ops = _summarize_cigar(read.cigartuples)

                    offset = start - ref_start
                    if ma_intervals is not None:
                        # Request-relative (start) to read-relative, as the working-set ones below.
                        fp_intervals_rel = [[iv[0] + offset, iv[1] + offset, iv[2]] for iv in ma_intervals]
                    elif ws_read and ws_read.get("intervals"):
                        fp_intervals_rel = [
                            [iv[0] + offset, iv[1] + offset, iv[2] if len(iv) > 2 else 0]
                            for iv in ws_read["intervals"]
                        ]
                    if ws_read and ws_read.get("methyl"):
                        methyl_pos_rel = [p + offset for p in ws_read["methyl"]]

                entry = {
                    **qcfail_metadata(read),
                    "read_id": read.query_name,
                    "dataset_id": dataset_id,
                    "signal": record_signal(read, provenance),
                    "mapq": mapq,
                    "strand": strand,
                    "read_length": read_length,
                    "aligned_span": aligned_span,
                    "nm": nm,
                    # A read the caller skipped has no footprint calls: these are unknown (None),
                    # not 0 footprints / 100% accessible. call_status says why the cells are empty.
                    "call_status": "called" if called else "not called",
                    "footprint_count": interval_stats["fp_count"] if called else None,
                    "nucleosome_count": interval_stats["nuc_count"] if called else None,
                    "subnuc_count": interval_stats["subnuc_count"] if called else None,
                    "avg_footprint_size": round(interval_stats["avg_fp_size"], 1) if called else None,
                    "median_footprint_size": round(interval_stats["median_fp_size"], 1) if called else None,
                    "accessibility_pct": round(interval_stats["acc_pct"], 1) if called else None,
                    "methyl_count": methyl_count,
                    "methyl_pct": round(methyl_pct, 1) if methyl_pct is not None else None,
                    "cigar_string": cigar_string,
                    "cigar_ops": cigar_ops,
                    "ref_start": ref_start,
                    "ref_end": ref_end,
                    "fp_intervals": fp_intervals_rel,
                    "methyl_pos": methyl_pos_rel,
                }
                per_read.append(entry)
                if called:
                    all_fp_sizes.extend(interval_stats["fp_sizes"])
                    all_acc_pcts.append(interval_stats["acc_pct"])
                all_lengths.append(read_length)
                all_mapqs.append(mapq)
                strand_counts[strand] += 1
                if methyl_pct is not None:
                    all_methyl_pcts.append(methyl_pct)
        except Exception as exc:
            log_read_stats_diagnostic(f"[read_stats] Error fetching from BAM {bam_path}: {exc}")


def _collect_bigbed_read_stats(
    *,
    dataset_id: str,
    requested_ids: list,
    wanted: set,
    ws,
    per_read: list,
    all_fp_sizes: list,
    all_acc_pcts: list,
    all_lengths: list,
    all_methyl_pcts: list,
) -> None:
    """Collect stats for compact BigBed reads."""
    for rid in requested_ids:
        ws_read = ws.read_by_id.get(rid)
        if not ws_read:
            continue
        wanted.discard(rid)

        interval_stats = _summarize_intervals(ws_read.get("intervals", []))

        methyl_count = None
        methyl_pct = None
        methyl_marks = ws_read.get("methyl", [])
        if methyl_marks:
            methyl_count = len(methyl_marks)
            methyl_pct = (
                methyl_count / interval_stats["total_span_bp"] * 100
                if interval_stats["total_span_bp"] > 0
                else 0.0
            )

        intervals = ws_read.get("intervals", [])
        if intervals:
            span_start = min(iv[0] for iv in intervals)
            span_end = max(iv[1] for iv in intervals)
            est_length = span_end - span_start
        else:
            est_length = 0

        entry = {
            "read_id": rid,
            "dataset_id": dataset_id,
            "mapq": None,
            "strand": None,
            "read_length": est_length,
            "aligned_span": est_length,
            "nm": None,
            "footprint_count": interval_stats["fp_count"],
            "nucleosome_count": interval_stats["nuc_count"],
            "subnuc_count": interval_stats["subnuc_count"],
            "avg_footprint_size": round(interval_stats["avg_fp_size"], 1),
            "median_footprint_size": round(interval_stats["median_fp_size"], 1),
            "accessibility_pct": round(interval_stats["acc_pct"], 1),
            "methyl_count": methyl_count,
            "methyl_pct": round(methyl_pct, 1) if methyl_pct is not None else None,
        }
        per_read.append(entry)
        all_fp_sizes.extend(interval_stats["fp_sizes"])
        all_acc_pcts.append(interval_stats["acc_pct"])
        all_lengths.append(est_length)
        if methyl_pct is not None:
            all_methyl_pcts.append(methyl_pct)


def _short_terminal_bp(state) -> int:
    """The read-end footprint cutoff the workspace's reads are loaded with (0 = keep all)."""
    try:
        from services.compact_read_loader import short_terminal_footprint_bp_for
        return int(short_terminal_footprint_bp_for(state))
    except Exception:
        return 0


def _ma_header_context(bam):
    """A BAM's MA group frame and consensus contracts, as the compact loader reads them."""
    from services.bam_tags import bam_consensus_contracts, bam_ma_group_frame
    header = getattr(bam, "header", None)
    if header is None:
        return None, None
    try:
        return bam_ma_group_frame(header), bam_consensus_contracts(header)
    except Exception:
        return None, None


def _calls_only_in_ma(read) -> bool:
    """A record with no legacy ns/nl or as/al array pair (its calls, if any, are MA/Ma)."""
    from services.bam_tags import interval_tag_pair
    for start_tag, length_tag in (("ns", "nl"), ("as", "al")):
        try:
            if interval_tag_pair(read, start_tag, length_tag)[0] is not None:
                return False
        except (KeyError, ValueError, TypeError):
            continue
    return True


def _ma_only_intervals(read, start: int, end: int, ma_frame, contracts, short_terminal_bp: int = 0):
    """Footprints and gaps of an MA-only called read inside ``[start, end)``, as
    request-relative ``[start, end, size]`` (size > 0: a footprint's length; <= 0:
    a gap), or None when the record's MA tag can't be read.

    The calls are the MA nuc/tf/fp_v2 groups, parsed and placed as the read loaders
    place them (``ma_footprint_query_spans``, the aligned-base CIGAR projection of
    ``parse_ma_aq_tags_into_layers``, the same read-end stub drop), and walked into
    footprints and gaps as legacy ns/nl reads are (terminal gaps hidden). A called
    read with no footprint call in MA (MSP only) is one accessible span."""
    from models.domain import CigarCoordMapper
    from services.compact_read_loader import (
        _read_ma_tags, ma_footprint_query_spans, short_terminal_spans, walk_read_intervals,
    )
    try:
        ma_tags = _read_ma_tags(read, ma_frame)
        if ma_tags is None:
            return None
        read_length = read.query_length or 0
        spans = ma_footprint_query_spans(
            ma_tags, read_length=read_length, is_reverse=read.is_reverse, family_contracts=contracts)
        drop = short_terminal_spans(None, None, spans, short_terminal_bp, read_length=read_length) if spans else set()
        ref_start, ref_end = int(read.reference_start), int(read.reference_end or read.reference_start)
        mapper = CigarCoordMapper(read.cigartuples, ref_start)
        blocks = []
        for _name, q_start, q_end in spans:
            if (q_start, q_end) in drop:
                continue
            r_start, r_end = mapper.aligned_query_interval_to_ref(q_start, q_end - 1)
            if r_start is None or r_end is None or r_end <= r_start:
                continue
            blocks.append((int(r_start), int(r_end), int(q_end - q_start)))
        if not blocks:
            lo, hi = max(ref_start, start), min(ref_end, end)
            return [[lo - start, hi - start, 0]] if hi > lo else []
        blocks.sort()
        return [[int(a - start), int(b - start), int(size)]
                for a, b, size, _i in walk_read_intervals(blocks, ref_start, ref_end, start, end, True)]
    except Exception as exc:
        log_read_stats_diagnostic(f"[read_stats] MA footprints unreadable for {getattr(read, 'query_name', '?')}: {exc}")
        return None


def _summarize_intervals(intervals: list) -> dict:
    fp_count = 0
    nuc_count = 0
    subnuc_count = 0
    fp_sizes = []
    total_gap_bp = 0
    total_span_bp = 0

    for iv in intervals or []:
        sz = iv[2] if len(iv) > 2 else 0
        span = iv[1] - iv[0]
        if sz > 0:
            fp_count += 1
            fp_sizes.append(sz)
            if sz >= 90:
                nuc_count += 1
            else:
                subnuc_count += 1
        else:
            total_gap_bp += span
        total_span_bp += span

    avg_fp_size = float(np.mean(fp_sizes)) if fp_sizes else 0.0
    median_fp_size = float(np.median(fp_sizes)) if fp_sizes else 0.0
    acc_pct = (total_gap_bp / total_span_bp * 100) if total_span_bp > 0 else 0.0

    return {
        "fp_count": fp_count,
        "nuc_count": nuc_count,
        "subnuc_count": subnuc_count,
        "fp_sizes": fp_sizes,
        "total_span_bp": total_span_bp,
        "avg_fp_size": avg_fp_size,
        "median_fp_size": median_fp_size,
        "acc_pct": acc_pct,
    }


def _build_aggregate(
    *,
    per_read: list,
    request,
    all_fp_sizes: list,
    all_acc_pcts: list,
    all_lengths: list,
    all_mapqs: list,
    all_methyl_pcts: list,
    strand_counts: dict,
) -> dict:
    aggregate = {
        "n_reads": len(per_read),
        "n_datasets": len(request.read_ids_by_dataset) if request else 0,
        "strand_counts": strand_counts,
    }

    if not per_read:
        return aggregate

    # No called read in scope: the footprint and accessibility means are unknown (None), not 0.
    aggregate["mean_accessibility_pct"] = round(float(np.mean(all_acc_pcts)), 1) if all_acc_pcts else None
    called_counts = [r["footprint_count"] for r in per_read if r.get("footprint_count") is not None]
    aggregate["n_not_called"] = len(per_read) - len(called_counts)
    aggregate["mean_footprint_count"] = round(float(np.mean(called_counts)), 1) if called_counts else None
    aggregate["mean_footprint_size"] = round(float(np.mean(all_fp_sizes)), 1) if all_fp_sizes else None
    aggregate["mean_read_length"] = round(float(np.mean(all_lengths)), 1) if all_lengths else 0.0
    aggregate["mean_mapq"] = round(float(np.mean(all_mapqs)), 1) if all_mapqs else None
    aggregate["median_footprint_size"] = round(float(np.median(all_fp_sizes)), 1) if all_fp_sizes else None
    aggregate["mean_methyl_pct"] = round(float(np.mean(all_methyl_pcts)), 1) if all_methyl_pcts else None

    aggregate["hist_accessibility"] = _build_histogram(all_acc_pcts, 0, 100, 10)
    aggregate["hist_fp_size"] = _build_histogram(all_fp_sizes, 0, max(all_fp_sizes) + 10 if all_fp_sizes else 300, 20)
    fp_counts = called_counts
    aggregate["hist_fp_count"] = _build_histogram(fp_counts, 0, max(fp_counts) + 1, None) if fp_counts else None
    aggregate["hist_read_length"] = _build_histogram(all_lengths, 0, max(all_lengths) + 100 if all_lengths else 10000, None)
    aggregate["hist_mapq"] = _build_histogram(all_mapqs, 0, 60, 5) if all_mapqs else None
    aggregate["hist_methyl_pct"] = _build_histogram(all_methyl_pcts, 0, 100, 10) if all_methyl_pcts else None
    return aggregate


_CIGAR_OP_NAMES = {0: "M", 1: "I", 2: "D", 3: "N", 4: "S", 5: "H", 7: "=", 8: "X"}


def _summarize_cigar(cigartuples: list) -> list:
    """Convert cigartuples to a list of {op, len} dicts for frontend rendering."""
    return [
        {"op": _CIGAR_OP_NAMES.get(op_code, "?"), "len": length}
        for op_code, length in cigartuples
    ]


def _build_histogram(values: list, lo: float, hi: float, bin_size: Optional[float]) -> list:
    """Build histogram bins from a list of numeric values."""
    if not values:
        return []
    if bin_size is None:
        rng = hi - lo
        if rng <= 0:
            return [{"lo": lo, "hi": hi, "count": len(values), "label": f"{lo:.0f}"}]
        bin_size = max(1, rng / 10)
        mag = 10 ** int(np.floor(np.log10(bin_size)))
        bin_size = max(1, round(bin_size / mag) * mag)
    edges = np.arange(lo, hi + bin_size, bin_size)
    counts, _ = np.histogram(values, bins=edges)
    return [
        {
            "lo": round(float(edges[i]), 1),
            "hi": round(float(edges[i + 1]), 1),
            "count": int(counts[i]),
            "label": f"{int(edges[i])}" if bin_size >= 1 else f"{edges[i]:.1f}",
        }
        for i in range(len(counts))
    ]
