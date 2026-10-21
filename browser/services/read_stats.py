"""Selected-read statistics computation for the Read Stats analysis panel."""
from __future__ import annotations

from typing import Optional

import numpy as np

from services.bam_handles import get_bam_handle
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
        capability="read_stats",
        lift_hap_by_dataset=getattr(request, "lift_hap_by_dataset", None),
    )
    from services.lift.capability import require_for_ids
    require_for_ids(state, query.dataset_ids, "read_stats")
    if query.read_ids_by_dataset:
        require_for_ids(state, query.read_ids_by_dataset.keys(), "read_stats")
    sample_seed = query.sample_seed
    # The main view's selection, then any selected in panels at another locus
    # (each looked up at its own region); one aggregate over all of them.
    scopes = [(query, start, end, query.read_ids_by_dataset)]
    for region in getattr(request, "extra_regions", None) or []:
        if region.read_ids_by_dataset:
            require_for_ids(state, region.read_ids_by_dataset.keys(), "read_stats")
        extra = AnalysisReadQuery.from_request(
            state,
            chrom=region.chrom,
            start=region.start,
            end=region.end,
            spanning=spanning,
            read_ids_by_dataset=region.read_ids_by_dataset,
            sample_seed=request.sample_seed,
            include_methylation=True,
            capability="read_stats",
            lift_hap_by_dataset=getattr(request, "lift_hap_by_dataset", None),
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

    for scope_query, scope_start, scope_end, scope_ids in scopes:
        requested_count += sum(len(dict.fromkeys(ids)) for ids in (scope_ids or {}).values())
        dataset_ids.update(ds for ds, ids in (scope_ids or {}).items() if ids)
        _collect_scope(
            state, scope_query, scope_start, scope_end, scope_ids,
            per_read=per_read, all_fp_sizes=all_fp_sizes, all_acc_pcts=all_acc_pcts,
            all_lengths=all_lengths, all_mapqs=all_mapqs, all_methyl_pcts=all_methyl_pcts,
            strand_counts=strand_counts, missing_read_ids_by_dataset=missing_read_ids_by_dataset,
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

    any_bam = any(
        state.get_dataset(ds_id) and state.get_dataset(ds_id).data_type in ("bam", "bam_livelift")
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
        is_lifted = dataset.data_type == "bam_livelift"

        # Scope the working set to the selected IDs so backend caps do not
        # sample selected reads out before per-read stats are computed.
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

        if is_lifted:
            _collect_lifted_read_stats(
                dataset=dataset, dataset_id=dataset_id, requested_ids=requested_ids, wanted=wanted, ws=ws,
                per_read=per_read, all_fp_sizes=all_fp_sizes, all_acc_pcts=all_acc_pcts, all_lengths=all_lengths,
                all_mapqs=all_mapqs, all_methyl_pcts=all_methyl_pcts, strand_counts=strand_counts,
            )
        elif is_bam:
            from services.plasmid_reconcile import contig_links
            _collect_bam_read_stats(
                dataset=dataset,
                dataset_id=dataset_id,
                contig_links=contig_links(state, dataset_id=dataset_id),
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
) -> None:
    """Collect stats from BAM alignment records plus compact working-set intervals."""
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
        from services.graph_lift import lift_hidden_predicate
        lift_hidden = lift_hidden_predicate(getattr(bam, "header", None))
        try:
            for read in bam.fetch(bam_chrom, start, end):
                # Only the primary alignment is the displayed read (the read
                # loaders skip the others); a secondary or supplementary record
                # sharing its name must not stand in for it.
                if (getattr(read, "is_unmapped", False) or getattr(read, "is_secondary", False)
                        or getattr(read, "is_supplementary", False)):
                    continue
                if lift_hidden is not None and lift_hidden(read):
                    continue
                if not record_keeps_signal(read, provenance):
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
                interval_stats = _summarize_intervals(ws_read.get("intervals") if ws_read else [])

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
                    if ws_read and ws_read.get("intervals"):
                        fp_intervals_rel = [
                            [iv[0] + offset, iv[1] + offset, iv[2] if len(iv) > 2 else 0]
                            for iv in ws_read["intervals"]
                        ]
                    if ws_read and ws_read.get("methyl"):
                        methyl_pos_rel = [p + offset for p in ws_read["methyl"]]

                entry = {
                    "read_id": read.query_name,
                    "dataset_id": dataset_id,
                    "signal": record_signal(read, provenance),
                    "mapq": mapq,
                    "strand": strand,
                    "read_length": read_length,
                    "aligned_span": aligned_span,
                    "nm": nm,
                    "footprint_count": interval_stats["fp_count"],
                    "nucleosome_count": interval_stats["nuc_count"],
                    "subnuc_count": interval_stats["subnuc_count"],
                    "avg_footprint_size": round(interval_stats["avg_fp_size"], 1),
                    "median_footprint_size": round(interval_stats["median_fp_size"], 1),
                    "accessibility_pct": round(interval_stats["acc_pct"], 1),
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
                all_fp_sizes.extend(interval_stats["fp_sizes"])
                all_acc_pcts.append(interval_stats["acc_pct"])
                all_lengths.append(read_length)
                all_mapqs.append(mapq)
                strand_counts[strand] += 1
                if methyl_pct is not None:
                    all_methyl_pcts.append(methyl_pct)
        except Exception as exc:
            log_read_stats_diagnostic(f"[read_stats] Error fetching from BAM {bam_path}: {exc}")


def _lift_row_rank(row) -> tuple:
    """A lifted record's displayed row first: primary record, primary placement, lowest row index."""
    ll = row.get("live_lift") or {}
    return (bool((ll.get("source") or {}).get("supplementary")), bool(ll.get("alt")), int(ll.get("row_index", 0) or 0),
            str(ll.get("record", "")))


def _lifted_source_record(dataset, row, handles: dict):
    """The source BAM record a lifted row was composed from (its own assembly), or None."""
    ll = row.get("live_lift") or {}
    src = ll.get("source") or {}
    contig, s0, s1 = src.get("contig"), src.get("start"), src.get("end")
    if contig is None or s0 is None or s1 is None:
        return None, None
    supp = bool(src.get("supplementary"))
    paths = list(getattr(dataset, "paths", None) or ())
    # The row's own library (Codex review: another BAM can hold the same QNAME at the same start).
    lib = ll.get("library")
    if isinstance(lib, int) and 0 <= lib < len(paths):
        paths = [paths[lib]]
    # The record's digest and occurrence (compact_read_loader._bam_projection_identity), when the row carries them.
    digest, occurrence = None, 0
    rec_id = str(ll.get("record") or "")
    if ":" in rec_id and len(rec_id.split(":", 1)[0]) == 64:
        digest, occ = rec_id.split(":", 1)
        occurrence = int(occ) if occ.isdigit() else 0
    for bam_path in paths:
        if bam_path not in handles:
            bam = get_bam_handle(bam_path)
            from services.signal_evidence import signal_header
            handles[bam_path] = (bam, signal_header(getattr(bam, "header", None)) if bam is not None else None)
        bam, provenance = handles[bam_path]
        if bam is None or contig not in (getattr(bam, "references", None) or ()):
            continue
        try:
            seen = 0
            for rec in bam.fetch(contig, int(s0), int(s1)):
                if (rec.query_name == row["id"] and rec.reference_start == int(s0) and rec.reference_end == int(s1)
                        and not rec.is_unmapped and not rec.is_secondary and bool(rec.is_supplementary) == supp):
                    if digest is not None:
                        import hashlib
                        if hashlib.sha256(rec.to_string().encode("utf-8")).hexdigest() != digest:
                            continue
                        if seen < occurrence:
                            seen += 1
                            continue
                    return rec, provenance
        except (ValueError, OSError) as exc:
            log_read_stats_diagnostic(f"[read_stats] Error fetching lifted source {contig}:{s0}-{s1}: {exc}")
    return None, None


def _collect_lifted_read_stats(
    *, dataset, dataset_id: str, requested_ids: list, wanted: set, ws, per_read: list, all_fp_sizes: list,
    all_acc_pcts: list, all_lengths: list, all_mapqs: list, all_methyl_pcts: list, strand_counts: dict,
) -> None:
    """Stats for lifted reads (graph features): footprints, accessibility and marks from the lifted rows on target
    coordinates (every row of the record), alignment fields (MAPQ, NM, length, CIGAR, bounds) from the record's own
    source BAM record, whose bounds are on the sample's assembly (``ref_contig``, ``coordinates: "source"``)."""
    from services.read_selection import base_read_id, read_id_keys
    by_key: dict = {}
    for row in ws.reads:
        for key in read_id_keys(row):
            by_key.setdefault(key, []).append(row)
    handles: dict = {}
    for rid in requested_ids:
        rows = by_key.get(rid) or by_key.get(base_read_id(rid))
        if not rows:
            # A graph row's identity (placement "primary"): its record's rows (graph features).
            from services.read_selection import _graph_identity_record_key
            rk = _graph_identity_record_key(rid)
            rows = by_key.get(rk) if rk else None
        if not rows:
            continue
        row = min(rows, key=_lift_row_rank)
        ll = row.get("live_lift") or {}
        record = (ll.get("molecule"), ll.get("record"))
        same = [r for r in rows if ((r.get("live_lift") or {}).get("molecule"), (r.get("live_lift") or {}).get("record")) == record]
        intervals = sorted((iv for r in same for iv in (r.get("intervals") or [])), key=lambda iv: (iv[0], iv[1]))
        marks = [m for r in same for m in (r.get("methyl") or [])]
        wanted.discard(rid)
        interval_stats = _summarize_intervals(intervals)
        methyl_count = len(marks) if any(r.get("methyl") is not None for r in same) else None
        methyl_pct = (methyl_count / interval_stats["total_span_bp"] * 100 if interval_stats["total_span_bp"] > 0 else 0.0
                      ) if methyl_count is not None else None
        rec, provenance = _lifted_source_record(dataset, row, handles)
        src = ll.get("source") or {}
        orientation = src.get("orientation")
        strand = orientation if orientation in ("+", "-") else ("-" if rec is not None and rec.is_reverse else "+")
        nm = None
        if rec is not None:
            try:
                nm = rec.get_tag("NM")
            except (KeyError, ValueError):
                nm = None
        signal = None
        if rec is not None:
            from services.signal_evidence import record_signal
            signal = record_signal(rec, provenance)
        read_length = (rec.query_length or rec.infer_read_length() or 0) if rec is not None else 0
        aligned_span = (rec.reference_length or 0) if rec is not None else int(src.get("end", 0)) - int(src.get("start", 0))
        mapq = rec.mapping_quality if rec is not None else None
        single = len(requested_ids) == 1 and rec is not None and rec.cigartuples
        per_read.append({
            "read_id": rid,
            "dataset_id": dataset_id,
            "signal": signal,
            "mapq": mapq,
            "strand": strand,
            "read_length": read_length,
            "aligned_span": aligned_span,
            "nm": nm,
            "footprint_count": interval_stats["fp_count"],
            "nucleosome_count": interval_stats["nuc_count"],
            "subnuc_count": interval_stats["subnuc_count"],
            "avg_footprint_size": round(interval_stats["avg_fp_size"], 1),
            "median_footprint_size": round(interval_stats["median_fp_size"], 1),
            "accessibility_pct": round(interval_stats["acc_pct"], 1),
            "methyl_count": methyl_count,
            "methyl_pct": round(methyl_pct, 1) if methyl_pct is not None else None,
            "cigar_string": rec.cigarstring if single else None,
            "cigar_ops": _summarize_cigar(rec.cigartuples) if single else None,
            "ref_start": rec.reference_start if rec is not None else src.get("start"),
            "ref_end": rec.reference_end if rec is not None else src.get("end"),
            "ref_contig": src.get("contig"),
            "coordinates": "source",
            "lifted": True,
            # Read-relative positions are on the source record; lifted rows are drawn on target coordinates.
            "fp_intervals": None,
            "methyl_pos": None,
        })
        all_fp_sizes.extend(interval_stats["fp_sizes"])
        all_acc_pcts.append(interval_stats["acc_pct"])
        all_lengths.append(read_length)
        if mapq is not None:
            all_mapqs.append(mapq)
        strand_counts[strand] = strand_counts.get(strand, 0) + 1
        if methyl_pct is not None:
            all_methyl_pcts.append(methyl_pct)


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

    aggregate["mean_accessibility_pct"] = round(float(np.mean(all_acc_pcts)), 1) if all_acc_pcts else 0.0
    aggregate["mean_footprint_count"] = round(float(np.mean([r["footprint_count"] for r in per_read])), 1)
    aggregate["mean_footprint_size"] = round(float(np.mean(all_fp_sizes)), 1) if all_fp_sizes else 0.0
    aggregate["mean_read_length"] = round(float(np.mean(all_lengths)), 1) if all_lengths else 0.0
    aggregate["mean_mapq"] = round(float(np.mean(all_mapqs)), 1) if all_mapqs else None
    aggregate["median_footprint_size"] = round(float(np.median(all_fp_sizes)), 1) if all_fp_sizes else 0.0
    aggregate["mean_methyl_pct"] = round(float(np.mean(all_methyl_pcts)), 1) if all_methyl_pcts else None

    aggregate["hist_accessibility"] = _build_histogram(all_acc_pcts, 0, 100, 10)
    aggregate["hist_fp_size"] = _build_histogram(all_fp_sizes, 0, max(all_fp_sizes) + 10 if all_fp_sizes else 300, 20)
    fp_counts = [r["footprint_count"] for r in per_read]
    aggregate["hist_fp_count"] = _build_histogram(fp_counts, 0, max(fp_counts) + 1, None)
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
