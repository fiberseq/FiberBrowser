"""Counts of alignment signal evidence, before display sampling and call filters."""
from __future__ import annotations

from services.bam_tags import footprint_call_summary
from services.signal_evidence import record_signal, signal_header, signal_keeps, signal_filter_key


def signal_counts(state, dataset_id, chrom, start, end, *, include_duplicates=False, include_qcfail=False, spanning=False,
                  min_footprints=0, extents_cap=0):
    """``uncalled``: shown reads without footprint calls; ``few_footprints``: shown called
    reads with fewer footprint calls than ``min_footprints``. ``uncalled_extents``: with
    ``extents_cap``, the uncalled reads' alignment extents, at most that many (None past
    it; never more are held); without it, none are built."""
    min_footprints = max(0, int(min_footprints or 0))
    extents_cap = max(0, int(extents_cap or 0))
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
    key = (dataset_identity(state, [dataset_id]), chrom, start, end, include_duplicates, include_qcfail,
           spanning, signal_filter_key(state), tuple(sorted(links.items())), min_footprints, extents_cap)
    cache = getattr(state, "_signal_counts_cache", None)
    if cache is None:
        cache = state._signal_counts_cache = ResultCache(max_entries=64)
    cached = cache.get(key, None)
    if cached is not None:
        return cached
    counts = dict(total=0, kept=0, hidden=0, background=0, detectable=0, unclassified=0,
                  unscored=0, unknown=0, structure_scored=0, duplicate_hidden=0, qcfail_hidden=0, chimera_hidden=0,
                  uncalled=0, few_footprints=0, uncalled_extents=[])
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
                    values = window.counts(lo, hi, include_duplicates=include_duplicates, include_qcfail=include_qcfail,
                        spanning=spanning, previous=windows[:index], min_footprints=min_footprints, extents_cap=extents_cap)
                    _add(counts, values, extents_cap)
                continue
        bam = get_bam_handle(path)
        if bam is None:
            continue
        header = signal_header(bam.header)
        if header:
            provenance.append(header)
        legacy_frame = _legacy_frame(path, bam)
        reference = resolve_reference_name(chrom, bam.references, links=links)
        if reference is None:
            continue
        for index, (lo, hi) in enumerate(windows):
            cached_window = find_signal_window(path, reference, lo, hi)
            if cached_window is not None and not (spanning and len(windows) != 1):
                # Circular views retain the scan path's physical-record
                # deduplication between reference segments.
                values = cached_window.counts(lo, hi, include_duplicates=include_duplicates, include_qcfail=include_qcfail,
                    spanning=spanning, previous=windows[:index], min_footprints=min_footprints, extents_cap=extents_cap)
                _add(counts, values, extents_cap)
                continue
            for read in bam.fetch(reference, lo, hi):
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                if spanning and (read.reference_start > start or read.reference_end < end):
                    continue
                if any(read.reference_start < b and read.reference_end > a for a, b in windows[:index]):
                    continue
                if read.is_duplicate and not include_duplicates:
                    counts["duplicate_hidden"] += 1
                if getattr(read, "is_qcfail", False) and not include_qcfail:
                    counts["qcfail_hidden"] += 1
                    counts["chimera_hidden"] += bool(read.has_tag("xc") and read.get_tag("xc") == "strand_swap")
                if (read.is_duplicate and not include_duplicates) or (getattr(read, "is_qcfail", False) and not include_qcfail):
                    continue
                evidence = record_signal(read, header)
                counts["total"] += 1
                counts[evidence["status"]] += 1
                keeps = signal_keeps(evidence)
                counts["kept" if keeps else "hidden"] += 1
                # Shown reads without footprint calls (bam_tags.read_has_footprint_calls).
                if keeps:
                    called, fp_calls = footprint_call_summary(read, legacy_frame)
                    # A QC-fail read shown by choice is never hidden as uncalled (chimeras carry no calls).
                    called = called or bool(getattr(read, "is_qcfail", False))
                    counts["uncalled"] += not called
                    if not called and extents_cap and counts["uncalled_extents"] is not None:
                        if len(counts["uncalled_extents"]) >= extents_cap:
                            counts["uncalled_extents"] = None  # past the cap: stop holding them
                        else:
                            counts["uncalled_extents"].append([read.reference_start, read.reference_end])
                    counts["few_footprints"] += bool(called and fp_calls < min_footprints)
                counts["structure_scored"] += evidence["structure"]["status"] != "unscored"
                if not counts["total"] & 255:
                    checkpoint()
    result = {**counts, "provenance": provenance, "scope": "alignments_before_call_filters"}
    cache.put(key, result)
    return result


def _add(counts, values, extents_cap):
    for name, value in values.items():
        if name == "uncalled_extents":
            have = counts.get(name)
            joined = None if have is None or value is None else have + value
            counts[name] = None if joined is not None and extents_cap and len(joined) > extents_cap else joined
        else:
            counts[name] += value


def _legacy_frame(path, bam):
    """The file's legacy-tag frame, as the read loader decides it (cached per file)."""
    try:
        from services.legacy_frame import bam_legacy_frame_for
        return bam_legacy_frame_for(path, bam.header)
    except Exception:
        return (False, False)


# Uncalled reads whose extents a payload carries for exact counts in a reused sub-view.
MAX_REUSE_EXTENTS = 20_000


def attach_signal_counts(payload, state, dataset_id, chrom, start, end, *, hide_uncalled=True, min_footprints=0, **options):
    """``signal_counts`` on a read payload, with the reads Min footprints hid from this view
    by reason: ``uncalled_hidden`` (no footprint calls: hidden at every threshold, unless
    "All reads, including uncalled") and ``min_footprints_hidden`` (fewer calls than
    ``min_footprints``; uncalled ones count here only when they are not hidden as uncalled)."""
    min_footprints = max(0, int(min_footprints or 0))
    # Extents only for what the client can reuse: views loaded without a threshold, uncalled hidden.
    want_extents = bool(hide_uncalled) and min_footprints == 0
    counts = signal_counts(state, dataset_id, chrom, start, end, min_footprints=min_footprints,
                           extents_cap=MAX_REUSE_EXTENTS if want_extents else 0, **options)
    if counts is not None:
        uncalled = int(counts.get("uncalled", 0))
        extents = counts.get("uncalled_extents")
        counts = {key: value for key, value in counts.items() if key != "uncalled_extents"}
        counts.update(uncalled_hidden=uncalled if hide_uncalled else 0, min_footprints=min_footprints,
                      min_footprints_hidden=int(counts.get("few_footprints", 0))
                      + (uncalled if (not hide_uncalled and min_footprints > 0) else 0))
        # Reads Min footprints hid are hidden at load time: a view inside this one can reuse
        # its reads (the client only reuses views loaded without a threshold). With the
        # uncalled ones' alignment extents it counts its own hidden reads exactly.
        reuse_extents = want_extents and extents is not None and 0 < len(extents) <= MAX_REUSE_EXTENTS
        if reuse_extents:
            counts["uncalled_extents"] = extents
        payload["signal_counts"] = counts
        # Hidden alignment extents are not in the client molecule cache. A
        # containing cohort cannot provide exact counts at another locus.
        if (counts["qcfail_hidden"] or counts["duplicate_hidden"]
                or (counts["uncalled_hidden"] and min_footprints == 0 and not reuse_extents)
                or counts["total"] != counts["unknown"] or any(signal_filter_key(state))):
            payload["_region_reuse_safe"] = False
    return payload
