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
            hide_uncalled=query.hide_uncalled,
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
    # Reads in the regions the read filters hid (whichever reads were selected), by reason, in the read track's
    # order: QC-fail, duplicate, uncalled, Min footprints; "quality": selected reads the quality filters left no
    # intervals (the read track drops those rows too).
    hidden = {"qcfail": 0, "duplicate": 0, "uncalled": 0, "min_footprints": 0, "quality": 0}
    min_footprints = max(0, int(getattr(request, "min_footprints", 0) or 0))
    include_qcfail = bool(getattr(request, "include_qcfail", False))
    include_duplicates = bool(getattr(request, "include_duplicates", False))
    min_fp_quality = max(0, int(getattr(request, "min_fp_quality", 0) or 0))
    from services.read_quality_filters import active_quality_filters
    quality_filters = [f for f in active_quality_filters(state) if (f.get("min_value") or 0) > 0]
    quality_impact = _QualityImpact(quality_filters)

    for scope_query, scope_start, scope_end, scope_ids in scopes:
        requested_count += sum(len(dict.fromkeys(ids)) for ids in (scope_ids or {}).values())
        dataset_ids.update(ds for ds, ids in (scope_ids or {}).items() if ids)
        _collect_scope(
            state, scope_query, scope_start, scope_end, scope_ids,
            per_read=per_read, all_fp_sizes=all_fp_sizes, all_acc_pcts=all_acc_pcts,
            all_lengths=all_lengths, all_mapqs=all_mapqs, all_methyl_pcts=all_methyl_pcts,
            strand_counts=strand_counts, missing_read_ids_by_dataset=missing_read_ids_by_dataset,
            include_qcfail=include_qcfail, include_duplicates=include_duplicates, min_fp_quality=min_fp_quality,
            quality_filters=quality_filters, quality_impact=quality_impact,
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
    # The read policy and quality gates, as the read track applies them, and what each removed.
    aggregate["include_qcfail"] = include_qcfail
    aggregate["n_hidden_qcfail"] = 0 if include_qcfail else hidden["qcfail"]
    aggregate["include_duplicates"] = include_duplicates
    aggregate["n_hidden_duplicate"] = 0 if include_duplicates else hidden["duplicate"]
    aggregate["min_fp_quality"] = min_fp_quality
    aggregate["n_hidden_quality"] = hidden["quality"]
    aggregate["quality_filters"] = quality_impact.summary()

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
    include_qcfail=False, min_footprints=0, hidden=None, include_duplicates=False, min_fp_quality=0,
    quality_filters=None, quality_impact=None,
):
    """Per-read stats for one region's selected reads, added to the accumulators.

    BAM and BigBed reads are loaded without the colour-rule quality filters and gated here
    (``_QualityGate``), so the stats count the calls the read track shows and the summary can say
    what each filter removed. Lifted rows come from the working set, filtered as it is."""
    from services.read_quality_filters import quality_filters_for_request
    quality_filters = list(quality_filters or [])
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
        if (is_bam or is_lifted) and (include_qcfail or include_duplicates or min_fp_quality > 0):
            # Opt-in reads and the footprint-quality gate are outside the default analysis cache. Use the same
            # direct read policy as their displayed panel (BAM: the quality filters are applied below; lifted rows
            # keep the loader's quality filters, as their working set does). A lifted load is scoped by QNAME and
            # to the query's haplotype and strand, as query.build_working_set scopes it.
            from models.domain import WorkingSet
            from services.read_endpoint import compact_reads_payload_for_request
            if is_lifted:
                from services.lift.cohort import raw_qnames, using_lift_cohort
                filter_ids = ",".join(sorted(raw_qnames(requested_ids, dataset)))
                scope = using_lift_cohort(query.purpose, query.lift_hap_by_dataset.get(dataset_id),
                                          query.strand_by_dataset.get(dataset_id))
            else:
                filter_ids = ",".join(requested_ids)
                scope = quality_filters_for_request([])
            with scope:
                payload = compact_reads_payload_for_request(
                    state, chrom=chrom, start=start, end=end, dataset_id=dataset_id,
                    spanning=query.spanning, max_reads=0, filter_ids=filter_ids,
                    include_qcfail=include_qcfail, include_duplicates=include_duplicates,
                    min_fp_quality=min_fp_quality,
                    include_methylation=True, include_layers=query.include_layers,
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
                # Unfiltered for BAM and BigBed: the quality gate below applies the filters.
                quality_filters=None if is_lifted else [],
                # BAM: the selected reads in this region only, no 10x prefetch around
                # it (with methylation decoded that load took 5-72 s on deep data).
                # BigBed keeps the prefetch: its companion layers outside the view
                # count in the terminal-gap filter, so a narrower load can change it.
                broad_prefetch_multiplier=READ_STATS_PREFETCH_MULTIPLIER if is_bam else None,
            )
        gate = None if is_lifted else _QualityGate(ws, quality_filters, wanted, quality_impact)

        if is_lifted:
            _collect_lifted_read_stats(
                dataset=dataset, dataset_id=dataset_id, requested_ids=requested_ids, wanted=wanted, ws=ws,
                per_read=per_read, all_fp_sizes=all_fp_sizes, all_acc_pcts=all_acc_pcts, all_lengths=all_lengths,
                all_mapqs=all_mapqs, all_methyl_pcts=all_methyl_pcts, strand_counts=strand_counts,
            )
        elif is_bam and str(chrom).startswith("meta:"):
            # A meta-locus contig names no BAM reference: each selected row is a (read, site) observation, resolved
            # through its own provenance to the real record at its real locus.
            from services.plasmid_reconcile import contig_links
            _collect_meta_read_stats(
                dataset=dataset,
                dataset_id=dataset_id,
                contig_links=contig_links(state, dataset_id=dataset_id),
                short_terminal_footprint_bp=_short_terminal_bp(state),
                include_qcfail=include_qcfail,
                hide_uncalled=query.hide_uncalled,
                requested_ids=requested_ids,
                wanted=wanted,
                ws=ws,
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
        elif is_bam:
            from services.plasmid_reconcile import contig_links
            _collect_bam_read_stats(
                dataset=dataset,
                dataset_id=dataset_id,
                contig_links=contig_links(state, dataset_id=dataset_id),
                short_terminal_footprint_bp=_short_terminal_bp(state),
                include_qcfail=include_qcfail,
                include_duplicates=include_duplicates,
                gate=gate,
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
                gate=gate,
                hidden=hidden,
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


def _meta_real_view(meta: dict, start: int, end: int):
    """The real span [a, b) of the view [start, end) of a meta-locus contig at a row's site (minus-strand sites
    mirrored), from its provenance: the window's logical origin (unclamped) and its end."""
    window = meta.get("window") or [None, None]
    we = window[1]
    origin = meta.get("origin", window[0])
    if origin is None or we is None:
        return None
    if meta.get("strand") == "-":
        return int(we) - int(end), int(we) - int(start)
    return int(origin) + int(start), int(origin) + int(end)


def _collect_meta_read_stats(*, dataset, dataset_id, requested_ids, wanted, ws, start, end, per_read, all_fp_sizes,
                             all_acc_pcts, all_lengths, all_mapqs, all_methyl_pcts, strand_counts, contig_links=None,
                             include_qcfail=False, hide_uncalled=False, short_terminal_footprint_bp=0) -> None:
    """Read Stats on a meta-locus contig (``meta:<pool>``): one entry per selected (read, site) observation, under
    the row's own id. Each row's provenance (``meta``: read name, real chromosome, site window and strand) finds the
    real BAM record; its footprints are the row's (the view's [start, end) at that site, minus-strand sites flipped
    back to real orientation), so the alignment columns are the record's and the footprint columns the view's. The
    rows are grouped by site: one fetch over the view's real span there for all of that site's reads (a read joins
    a site once, so names are unique within one)."""
    from types import SimpleNamespace
    from services.meta_locus_decode import mirror_compact_read
    width = int(end) - int(start)
    single = len(requested_ids) == 1
    by_site: dict = {}
    for rid in requested_ids:
        row = ws.read_by_id.get(rid)
        meta = (row or {}).get("meta") or {}
        name = (meta.get("identity") or {}).get("name")
        real_chrom = (meta.get("real") or {}).get("chrom") or meta.get("chrom")
        span = _meta_real_view(meta, start, end)
        if not name or not real_chrom or span is None:
            continue
        adapted = mirror_compact_read(row, width) if meta.get("strand") == "-" else row
        group = by_site.setdefault((meta.get("site"), real_chrom, span), {"rows": {}, "ids": {}, "meta": meta})
        group["rows"][name] = adapted
        group["ids"][name] = rid
    for (_site, real_chrom, span), group in by_site.items():
        found = set(group["rows"])
        before = len(per_read)
        _collect_bam_read_stats(
            dataset=dataset, dataset_id=dataset_id, wanted=found, read_ids=list(group["rows"]) if single else list(requested_ids),
            ws=SimpleNamespace(read_by_id=group["rows"]), chrom=real_chrom, start=span[0], end=span[1],
            per_read=per_read, all_fp_sizes=all_fp_sizes, all_acc_pcts=all_acc_pcts, all_lengths=all_lengths,
            all_mapqs=all_mapqs, all_methyl_pcts=all_methyl_pcts, strand_counts=strand_counts,
            contig_links=contig_links, include_qcfail=include_qcfail, hide_uncalled=hide_uncalled,
            short_terminal_footprint_bp=short_terminal_footprint_bp,
        )
        site_meta = {k: group["meta"].get(k) for k in ("site", "site_name", "chrom", "window", "strand", "anchor") if k in group["meta"]}
        for entry in per_read[before:]:
            rid = group["ids"].get(entry["read_id"])
            if rid is not None:
                entry["read_id"] = rid
                entry["meta"] = dict(site_meta)
                wanted.discard(rid)
        for name, rid in group["ids"].items():
            if name not in found:
                wanted.discard(rid)  # found (an entry above) or hidden as uncalled under the rule: not missing


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
    include_duplicates: bool = False,
    gate: "_QualityGate | None" = None,
) -> None:
    """Collect stats from BAM alignment records plus compact working-set intervals.

    A read whose calls are only in MA/Ma tags (current FiberHMM, fibertools
    ``Ma``) has a placeholder row in the working set (its calls sit in layers,
    which Read Stats may not have loaded): its footprints and gaps are read
    from the record's MA tag instead (``_ma_only_intervals``).

    The read track's read policy: QC-fail and duplicate records are hidden unless shown
    (``include_qcfail``, ``include_duplicates``; counted in ``hidden``), and ``gate`` applies the
    colour-rule quality filters to whichever intervals are summarised (``_QualityGate``).

    ``hidden``: adds the region's reads (as the read track counts them: primary,
    not duplicate, QC-fail or signal-hidden, spanning when asked) that "Hide reads
    without footprint calls" (``uncalled``, with ``hide_uncalled``) and "Min
    footprints" (``min_footprints``: reads with fewer calls, uncalled ones too when
    they are shown) hid. A read either filter hides is never reported as selected: it is
    left out of the listing and the distributions, as the read track leaves it out."""
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
        from services.graph_lift import lift_hidden_predicate
        lift_hidden = lift_hidden_predicate(getattr(bam, "header", None))
        try:
            # A meta-locus site near the contig start has a logical start below 0: only the fetch is clamped
            # (pysam refuses a negative start); offsets below stay relative to the logical start.
            for read in bam.fetch(bam_chrom, max(0, start), end):
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
                in_scope = not spanning or (read.reference_start <= start and (read.reference_end or 0) >= end)
                # QC-fail, then duplicate: hidden unless their toggles show them (the read track's order).
                policy = ("qcfail" if getattr(read, "is_qcfail", False) and not include_qcfail else
                          "duplicate" if getattr(read, "is_duplicate", False) and not include_duplicates else None)
                if policy is not None:
                    if hidden is not None and read.query_name not in counted and in_scope:
                        counted.add(read.query_name)
                        hidden[policy] += 1
                    wanted.discard(read.query_name)   # hidden from the read track: not a selected read
                    continue
                called = read_has_footprint_calls(read)
                # A QC-fail read shown by choice is never hidden as uncalled (chimeras carry no calls).
                exempt = bool(getattr(read, "is_qcfail", False))
                hidden_uncalled = hide_uncalled and not called and not exempt
                # With uncalled reads shown, Min footprints hides them too (0 calls), as the loaders do.
                fails_min = (not hidden_uncalled and min_footprints > 0
                             and (not called or footprint_call_count(read, legacy_frame) < min_footprints))
                if hidden is not None and read.query_name not in counted and in_scope:
                    counted.add(read.query_name)
                    if hidden_uncalled:
                        hidden["uncalled"] += 1
                    elif fails_min:
                        hidden["min_footprints"] += 1
                if hidden_uncalled or fails_min:
                    # Hidden from the read track and every analysis (owner, 20 Nov 2026: Min footprints too): not a
                    # selected read, so neither listed nor in the distributions; counted as hidden above.
                    wanted.discard(read.query_name)
                    continue
                if read.query_name not in wanted:
                    continue
                wanted.discard(read.query_name)
                if gate is not None and gate.dropped(read.query_name):
                    # The quality filters left this read no intervals: the read track drops its row.
                    if hidden is not None:
                        hidden["quality"] += 1
                    continue

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
                fp_source = ma_intervals if ma_intervals is not None else (ws_read.get("intervals") if ws_read else [])
                if gate is not None:
                    fp_source = gate.intervals(read.query_name, fp_source)
                interval_stats = _summarize_intervals(fp_source)

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
                    if fp_source:
                        fp_intervals_rel = [
                            [iv[0] + offset, iv[1] + offset, iv[2] if len(iv) > 2 else 0]
                            for iv in fp_source
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
                    **nucleosome_columns(ws_read),
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


# Read Stats' nucleosome columns (NUC §7.1 item 5): the molecule's nucmol scalars, None when it has none.
NUC_COLUMNS = ('nrl', 'regularity', 'gap_cv', 'lambda_acc', 'n_short', 'n_mono', 'n_multi', 'n_cant_tell',
               'reg_fraction', 'disordered_fraction', 'undetermined_fraction', 'n_missing')


def nucleosome_columns(read) -> dict:
    """The nucleosome columns of a working-set row (its molecule scalars: services/nuc/scalars.py)."""
    if not read:
        return {name: None for name in NUC_COLUMNS}
    from services.nuc.scalars import molecule_scalars
    values = molecule_scalars(read)
    out = {}
    for name in NUC_COLUMNS:
        v = values.get(f'nuc.{name}')
        out[name] = None if v is None else (round(float(v), 4) if isinstance(v, float) else v)
    return out


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
            **nucleosome_columns(row),
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
    gate: "_QualityGate | None" = None,
    hidden: dict | None = None,
) -> None:
    """Collect stats for compact BigBed reads (``gate``: the colour-rule quality filters)."""
    for rid in requested_ids:
        ws_read = ws.read_by_id.get(rid)
        if not ws_read:
            continue
        wanted.discard(rid)
        if gate is not None and gate.dropped(rid):
            if hidden is not None:
                hidden["quality"] += 1
            continue

        fp_source = ws_read.get("intervals", [])
        if gate is not None:
            fp_source = gate.intervals(rid, fp_source)
        interval_stats = _summarize_intervals(fp_source)

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

        intervals = fp_source
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


def _filter_label(f: dict) -> str:
    layer = f.get("layer") or "*"
    value = f.get("min_value", 0)
    value = int(value) if float(value).is_integer() else value
    return f"{f.get('quality_name', '')} \u2265 {value}" + ("" if layer == "*" else f" ({layer})")


class _QualityImpact:
    """Per colour-rule quality filter, over the selected reads: calls it applies to and calls it kept
    (``read_quality_filters.quality_filter_impact``), for "nq >= 100 (nuc): 12 of 40 calls removed"."""

    def __init__(self, filters):
        self.filters = list(filters or [])
        self.total = [0] * len(self.filters)
        self.kept = [0] * len(self.filters)

    def add(self, reads):
        if not self.filters or not reads:
            return
        from services.read_quality_filters import quality_filter_impact
        for index, part in enumerate(quality_filter_impact(reads, self.filters)):
            self.total[index] += part["total"]
            self.kept[index] += part["kept"]

    def summary(self) -> list:
        return [{"layer": f.get("layer") or "*", "quality_name": f.get("quality_name", ""),
                 "min_value": f.get("min_value", 0), "label": _filter_label(f),
                 "calls": total, "removed": total - kept}
                for f, total, kept in zip(self.filters, self.total, self.kept)]


def _removed_call_spans(read: dict, filtered: dict) -> set:
    """The footprint calls (start, end) the filters removed from a row: from its primary footprints, and
    from its footprint layers (a call in either is gone from what the read track draws)."""
    from services.read_metrics import get_layer_intervals

    def primary(row):
        return {(iv[0], iv[1]) for iv in row.get("intervals") or () if len(iv) > 2 and iv[2] > 0}

    def layered(row):
        return {(iv[0], iv[1]) for iv in get_layer_intervals(row, "all_fp") or () if len(iv) >= 2}

    return (primary(read) - primary(filtered)) | (layered(read) - layered(filtered))


class _QualityGate:
    """The colour-rule quality filters on Read Stats' (unfiltered) working-set rows, as the read track
    applies them (``read_quality_filters.apply_quality_filters``).

    ``dropped(id)``: the filters left the row no intervals (the read track drops it).
    ``intervals(id, intervals)``: the footprint intervals to summarise with every call the filters
    removed (from the primary intervals or any footprint layer) turned into accessible span. Applied to
    whichever interval list is summarised (the row's primary intervals; a read's MA-tag intervals), so
    the counts are the calls the read track shows."""

    def __init__(self, ws, filters, wanted, impact: "_QualityImpact | None" = None):
        self.filters = list(filters or [])
        self._removed: dict = {}
        self._dropped: set = set()
        if not self.filters:
            return
        from services.read_quality_filters import apply_quality_filters
        selected = []
        for read in getattr(ws, "reads", None) or ():
            rid = read.get("id")
            if rid not in wanted:
                continue
            selected.append(read)
            filtered = apply_quality_filters(read, self.filters)
            if filtered is None:
                self._dropped.add(rid)
                continue
            removed = _removed_call_spans(read, filtered)
            if removed:
                self._removed[rid] = removed
        if impact is not None:
            impact.add(selected)

    def dropped(self, read_id) -> bool:
        return read_id in self._dropped

    def intervals(self, read_id, intervals):
        removed = self._removed.get(read_id)
        if not removed or not intervals:
            return intervals
        out = []
        for iv in intervals:
            if len(iv) > 2 and iv[2] > 0 and (iv[0], iv[1]) in removed:
                out.append([iv[0], iv[1], -(iv[1] - iv[0])])   # no longer a call: accessible span
            else:
                out.append(iv)
        return out


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

    # No called read in scope (or no footprint): the means are unknown (None, shown as NA), not 0.
    aggregate["mean_accessibility_pct"] = round(float(np.mean(all_acc_pcts)), 1) if all_acc_pcts else None
    called_counts = [r["footprint_count"] for r in per_read if r.get("footprint_count") is not None]
    aggregate["n_not_called"] = len(per_read) - len(called_counts)
    aggregate["mean_footprint_count"] = round(float(np.mean(called_counts)), 1) if called_counts else None
    aggregate["mean_footprint_size"] = round(float(np.mean(all_fp_sizes)), 1) if all_fp_sizes else None
    aggregate["mean_read_length"] = round(float(np.mean(all_lengths)), 1) if all_lengths else 0.0
    aggregate["mean_mapq"] = round(float(np.mean(all_mapqs)), 1) if all_mapqs else None
    aggregate["median_footprint_size"] = round(float(np.median(all_fp_sizes)), 1) if all_fp_sizes else None
    aggregate["mean_methyl_pct"] = round(float(np.mean(all_methyl_pcts)), 1) if all_methyl_pcts else None

    aggregate["hist_accessibility"] = _build_histogram(all_acc_pcts, 0, 100, 10) if all_acc_pcts else None
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
