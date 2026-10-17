"""Counts of alignment signal evidence, before display sampling and call filters."""
from __future__ import annotations

from services.signal_evidence import record_signal, signal_header, signal_keeps, signal_filter_key


def signal_counts(state, dataset_id, chrom, start, end, *, include_duplicates=False, spanning=False):
    from services.background_work import dataset_identity, checkpoint, ResultCache
    from services.bam_handles import get_bam_handle
    from services.plasmid_reconcile import contig_links
    from services.read_bam_subset import _query_windows
    from utils.chrom import resolve_reference_name

    dataset = state.get_dataset(dataset_id)
    if dataset is None or dataset.data_type != "bam":
        return None
    if not getattr(dataset, "paths", None):
        return None
    links = contig_links(state, dataset_id=dataset_id)
    key = (dataset_identity(state, [dataset_id]), chrom, start, end, include_duplicates,
           spanning, signal_filter_key(state), tuple(sorted(links.items())))
    cache = getattr(state, "_signal_counts_cache", None)
    if cache is None:
        cache = state._signal_counts_cache = ResultCache(max_entries=64)
    cached = cache.get(key, None)
    if cached is not None:
        return cached
    counts = dict(total=0, kept=0, hidden=0, background=0, detectable=0, unclassified=0,
                  unscored=0, unknown=0, structure_scored=0)
    windows = _query_windows(state, chrom, start, end)
    provenance = []
    for path in dataset.paths:
        from services.signal_windows import find_signal_source, find_signal_window
        source = find_signal_source(path)
        if source is not None and not (spanning and len(windows) != 1):
            reference = resolve_reference_name(chrom, source["references"], links=links)
            cached_windows = [find_signal_window(path, reference, lo, hi) for lo, hi in windows]
            if reference is not None and all(window is not None for window in cached_windows):
                if source["header"]:
                    provenance.append(source["header"])
                for index, ((lo, hi), window) in enumerate(zip(windows, cached_windows)):
                    values = window.counts(lo, hi, include_duplicates=include_duplicates,
                        spanning=spanning, previous=windows[:index])
                    for name, value in values.items():
                        counts[name] += value
                continue
        bam = get_bam_handle(path)
        if bam is None:
            continue
        header = signal_header(bam.header)
        if header:
            provenance.append(header)
        from services.graph_lift import lift_hidden_predicate
        lift_hidden = lift_hidden_predicate(bam.header)
        reference = resolve_reference_name(chrom, bam.references, links=links)
        if reference is None:
            continue
        for index, (lo, hi) in enumerate(windows):
            cached_window = find_signal_window(path, reference, lo, hi)
            if cached_window is not None and not (spanning and len(windows) != 1):
                # Circular views retain the scan path's physical-record
                # deduplication between reference segments.
                values = cached_window.counts(lo, hi, include_duplicates=include_duplicates,
                    spanning=spanning, previous=windows[:index])
                for name, value in values.items():
                    counts[name] += value
                continue
            for read in bam.fetch(reference, lo, hi):
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                if lift_hidden is not None and lift_hidden(read):
                    continue
                if read.is_duplicate and not include_duplicates:
                    continue
                if spanning and (read.reference_start > start or read.reference_end < end):
                    continue
                if any(read.reference_start < b and read.reference_end > a for a, b in windows[:index]):
                    continue
                evidence = record_signal(read, header)
                counts["total"] += 1
                counts[evidence["status"]] += 1
                counts["kept" if signal_keeps(evidence) else "hidden"] += 1
                counts["structure_scored"] += evidence["structure"]["status"] != "unscored"
                if not counts["total"] & 255:
                    checkpoint()
    result = {**counts, "provenance": provenance, "scope": "alignments_before_call_filters"}
    cache.put(key, result)
    return result


def attach_signal_counts(payload, state, dataset_id, chrom, start, end, **options):
    counts = signal_counts(state, dataset_id, chrom, start, end, **options)
    if counts is not None:
        payload["signal_counts"] = counts
        # Hidden alignment extents are not in the client molecule cache. A
        # containing cohort cannot provide exact counts at another locus.
        if counts["total"] != counts["unknown"] or any(signal_filter_key(state)):
            payload["_region_reuse_safe"] = False
    return payload
