"""Live-lift rows in the display read paths (DESIGN_LIVE_LIFT.md §3.9, P2a).

- ``lifted_reads_for_region``: what ``_load_broad_reads`` (and with it the
  broad cache, working sets and the direct path) gets for a ``bam_livelift``
  dataset instead of the BAM loader's reads: lifted rows relative to the
  requested region, unfiltered (``live_lift.load_lifted_rows``).
- ``crop_live_lift``: ``live_lift`` geometry and its per-call lists cut to a
  viewport the way the broad-cache projection cuts intervals.
- ``filter_lift_hap``: a split panel's haplotype rule (``lift_hap``).
- ``lifted_coverage``: binned depth from lifted bodies, per haplotype, with
  the correspondence series that drives hatching (union of primary pieces).
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterable, Optional

# Loader options a lifted load takes from the display paths (the rest are fixed by live_lift).
_PASSED_OPTIONS = ("include_methylation", "ml_threshold", "include_layers", "requested_layers",
                   "include_layer_qualities", "infer_legacy_layers", "legacy_nuc_min_size", "min_footprints",
                   "short_terminal_footprint_bp", "hide_terminal_gaps", "terminal_gap_threshold",
                   "include_duplicates", "sv_min_len", "include_sv_seq", "min_fp_quality", "include_cigar",
                   "target_fasta", "include_mismatches", "detail_view", "insertion_ids")


def is_lifted(dataset) -> bool:
    return getattr(dataset, "data_type", None) == "bam_livelift" and getattr(dataset, "live_lift", None) is not None


def lift_identity(dataset) -> tuple:
    """What a lifted dataset's cached reads depend on beyond its files (map,
    haplotypes, settings: ``lift_key``); () for any other dataset."""
    config = getattr(dataset, "live_lift", None)
    if config is None:
        return ()
    try:
        return ("lift", config.key())
    except Exception:  # noqa: BLE001 - a map gone missing: no cache hit is better than a crash
        return ("lift", "unavailable")


def lifted_reads_for_region(dataset, chrom: str, start: int, end: int, options: Optional[dict] = None,
                            counts_out: Optional[dict] = None, *, sampler=None, bam_handle_getter=None,
                            primary_metadata=None) -> list:
    """Lifted rows of ``[start, end)`` on the main genome, relative to
    ``start`` and clipped to it, as the BAM loader returns them; every row (no
    spanning, id, strand, haplotype or cap filter)."""
    from services.lift.live_lift import LoadBudget, LiftRefused, load_lifted_rows

    config = dataset.live_lift
    handle = config.handle
    if chrom not in handle.map.targets:
        return []
    loader_options = {k: v for k, v in (options or {}).items() if k in _PASSED_OPTIONS and v is not None}
    loader_options["source_fasta"] = getattr(config, "source_fasta", None)
    budget = LoadBudget()
    load = load_lifted_rows(handle, list(dataset.paths), chrom, int(start), int(end), haplotypes=config.haplotypes,
                            settings=config.settings, dataset_id=dataset.id, loader_options=loader_options,
                            output_region=(int(start), int(end)), sampler=sampler, budget=budget,
                            bam_handle_getter=bam_handle_getter, primary_metadata=primary_metadata)
    if load.truncated:
        # Never publish or cache a partial cohort as though it were complete.
        limit = (f"{budget.max_bytes / (1024 * 1024):g} MB" if budget.bytes >= budget.max_bytes
                 else f"{budget.max_records:,} source records")
        raise LiftRefused(f"Live lift: this view holds more than {limit}; zoom in")
    if counts_out is not None:
        counts_out.update(load.counts)
    return load.rows


# ── Viewport crops ──────────────────────────────────────────────────────────

def enrich_display_insertions(state, payload, insertion_ids, options):
    """Attach requested blocks to response copies, keeping shared caches lean."""
    dataset = state.datasets.get(payload.get("dataset_id"))
    if not is_lifted(dataset) or not payload.get("reads"):
        return payload
    ids = set(insertion_ids.split(","))
    # Only IDs represented by visible rows can trigger additional decoding.
    ids &= {i for r in payload["reads"] for i in (r.get("live_lift") or {}).get("badge_ids", []) if i}
    if not ids:
        return payload
    chrom, start, end = options["chrom"], options["start"], options["end"]
    rows = lifted_reads_for_region(dataset, chrom, start, end,
                                  dict(options, insertion_ids=ids, include_cigar=False,
                                       requested_layers=options["layer_names"].split(",") if options.get("layer_names") else None))
    def key(row):
        ll = row.get("live_lift") or {}
        return ll.get("molecule"), ll.get("record")
    blocks = {}
    for r in rows:
        blocks.setdefault(key(r), {}).update(r["live_lift"]["insertions"])
    return {**payload, "reads": [{**r, "live_lift": {**r["live_lift"], "insertions": {
        i: b for i, b in blocks.get(key(r), {}).items() if i in r["live_lift"].get("badge_ids", [])}}}
                                if r.get("live_lift") else r for r in payload["reads"]]}


def scoped_sampling_info(info):
    """Estimate filtered lifted totals from the unsplit sample's measured share."""
    if not info:
        return info
    info = dict(info)
    for suffix in ("", "_spanning"):
        info["total" + suffix] = round(info["total" + suffix] * info["loaded" + suffix] / max(1, info["kept" + suffix]))
        info["kept" + suffix] = info["loaded" + suffix]
    info["estimated"] = True
    return info

def clip_geometry(ll: dict, offset: int, width: int) -> dict:
    """``live_lift`` body spans, connectors and badges shifted by ``-offset``
    and kept where they reach ``[0, width]``; connector-only hulls have no body."""
    out = dict(ll)
    segs = []
    for segment in ll.get("segments") or ():
        # Subtract connectors before clipping: a viewport wholly in a
        # target-only gap has no body. Keep the segment/connector encoding
        # intact when body is visible (the source chain still owns one segment).
        body = _body_spans({"segments": [segment], "connectors": ll.get("connectors")})
        if any(b > offset and a < offset + width for a, b in body):
            segs.append([max(segment[0] - offset, 0), min(segment[1] - offset, width), *segment[2:]])
    out["segments"] = segs
    cons = []
    for c0, c1 in ll.get("connectors") or ():
        a, b = c0 - offset, c1 - offset
        if b > 0 and a < width:
            cons.append([max(a, 0), min(b, width)])
    out["connectors"] = cons
    badges, ids = ll.get("badges") or [], ll.get("badge_ids") or []
    kept = [i for i, b in enumerate(badges) if 0 <= b[0] - offset <= width]
    out["badges"] = [[badges[i][0] - offset, *badges[i][1:]] for i in kept]
    out["badge_ids"] = [ids[i] if i < len(ids) else None for i in kept]
    out["insertions"] = {key: (dict(value, pos=value["pos"] - offset) if "pos" in value else dict(value))
                         for key, value in (ll.get("insertions") or {}).items() if key in out["badge_ids"]}
    return out


def keep_interval(interval, offset, width, call=None):
    """The shared live-lift crop rule: positive spans and identified insertion
    markers, including at a boundary. Native zero-width intervals stay hidden."""
    if len(interval) < 2:
        return False
    a, b = interval[0] - offset, interval[1] - offset
    return min(b, width) > max(a, 0) or (a == b and 0 <= a <= width and call is not None)


def _kept(intervals, offset, width, calls=()):
    """Indices the broad-cache projection keeps (working_sets._project_*_intervals)."""
    kept = []
    for i, iv in enumerate(intervals or ()):
        if keep_interval(iv, offset, width, calls[i] if i < len(calls) else None):
            kept.append(i)
    return kept


def crop_live_lift(read: dict, adjusted: dict, offset: int, width: int) -> None:
    """Put ``read``'s ``live_lift`` on the cropped ``adjusted`` row: geometry
    shifted and clipped; ``calls``/``call_parts`` cut to the intervals the
    projection kept (same rule), per group; groups the crop dropped go."""
    ll = read.get("live_lift")
    if not ll:
        return
    out = clip_geometry(ll, offset, width)
    groups = {"intervals": read.get("intervals"), "fire": read.get("fire")}
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            groups[f"layer:{name}"] = layer.get("intervals")
    present = {"intervals"} | ({"fire"} if adjusted.get("fire") else set()) | {
        f"layer:{n}" for n in (adjusted.get("layers") or {})}
    for field in ("calls", "call_parts"):
        src = ll.get(field) or {}
        cut = {}
        for group, values in src.items():
            if group not in present or values is None:
                continue
            idx = _kept(groups.get(group), offset, width, (ll.get("calls") or {}).get(group) or ())
            cut[group] = [values[i] if i < len(values) else None for i in idx]
            if group == "intervals" and not idx:
                # A synthesized neutral body/badge interval has no source call.
                cut[group] = [None] * len(adjusted.get("intervals") or ())
        out[field] = cut
    adjusted["live_lift"] = out


def geometry_intervals(read: dict) -> list:
    """A lifted row's body segments and badge points as intervals (the crop and
    the display index count them, so a row visible only through a terminal
    segment or badge survives)."""
    ll = read.get("live_lift")
    if not ll:
        return []
    out = [[a, b] for a, b in _body_spans(ll)]
    # Badges are visible on either viewport edge; straddle the point so
    # compact_read_bounds' half-open overlap test keeps the right edge too.
    out += [[max(0, b[0] - 1), b[0] + 1] for b in ll.get("badges") or ()]
    return out


# ── Haplotype panels ────────────────────────────────────────────────────────

# A display request's haplotype rule (``lift_hap``), set around the working-set
# build so the display filter runs on the unfiltered broad rows *before* the
# working-set cap and its sampling (§3.8 ``prepare_lift_cohort(purpose='display')``).
_display_hap: ContextVar = ContextVar("live_lift_display_hap", default=None)
_display_sampling: ContextVar = ContextVar("live_lift_display_sampling", default=False)


@contextmanager
def lift_display_hap(hap: Optional[str], *, sample=None):
    token = _display_hap.set(hap or None)
    sampling_token = _display_sampling.set(_display_sampling.get() if sample is None else bool(sample))
    try:
        yield
    finally:
        _display_hap.reset(token)
        _display_sampling.reset(sampling_token)


def display_sampling(dataset) -> bool:
    """Explicit sampling is allowed only inside a lifted display request;
    analyses and full-working-set loads retain their unsampled contract."""
    return is_lifted(dataset) and _display_sampling.get()


def display_row_filter(dataset):
    """For a lifted dataset, the predicate a working set applies to broad rows
    before its spanning/id filters and caps (haplotype of the current display
    request, supplementary/alternative display settings); None otherwise."""
    if not is_lifted(dataset):
        return None
    hap = _display_hap.get()
    return lambda read: bool(filter_lift_display([read], dataset, hap))


def display_key(dataset) -> Optional[tuple]:
    """What a lifted working set's cache key adds for the display filter (the
    settings are already in ``lift_key``)."""
    return ("lift_hap", _display_hap.get()) if is_lifted(dataset) else None


def filter_lift_hap(reads: Iterable[dict], hap: Optional[str]) -> list:
    """Rows of one haplotype (label or key) for a split panel's rule; reads
    without ``live_lift`` (a native dataset in a batch) are left alone."""
    if not hap:
        return list(reads)
    want = str(hap).upper()
    out = []
    for read in reads:
        ll = read.get("live_lift")
        if ll is None or str(ll.get("hap_label", "")).upper() == want or str(ll.get("hap", "")).upper() == want:
            out.append(read)
    return out


def filter_lift_display(reads: Iterable[dict], dataset, hap: Optional[str] = None) -> list:
    """The rows a lifted panel draws (§2.5: each path filters the flagged rows
    with its own setting): its haplotype (``hap``), supplementary rows unless
    ``supplementary_display='hide'``, alternative placements only with
    ``alternatives``."""
    config = getattr(dataset, "live_lift", None)
    if config is not None:
        from services.lift.cohort import prepare_lift_cohort
        return prepare_lift_cohort(reads, "display", config.settings, hap).rows
    rows = filter_lift_hap(reads, hap)
    if config is None:
        return rows
    hide_supp = config.settings.supplementary_display == "hide"
    show_alt = bool(config.settings.alternatives)
    out = []
    for read in rows:
        ll = read.get("live_lift")
        if ll is not None:
            if hide_supp and (ll.get("source") or {}).get("supplementary"):
                continue
            if ll.get("alt") and not show_alt:
                continue
        out.append(read)
    return out


# ── Coverage ────────────────────────────────────────────────────────────────

def lifted_coverage(dataset, chrom: str, start: int, end: int, bins: int, *, lift_hap: Optional[str] = None,
                    include_duplicates: bool = False, correspondence_only: bool = False,
                    rows=None, rows_start: Optional[int] = None) -> dict:
    """Binned coverage over ``[start, end)`` from lifted rows, as the read
    coverage track counts molecules: each molecule once per bin its body (segments
    minus connectors) touches; alternative rows never count. Per haplotype and
    pooled, with ``correspondence``: per bin, the fraction of bases a primary
    piece of that haplotype covers (pooled: of any selected haplotype; the
    union of pieces, never above 1). It drives hatching: a bin without
    correspondence has no depth to show (``depth`` None there), not zero
    coverage. ``pooled_depth='correspondence_normalised'`` divides pooled
    counts by the haplotypes with correspondence >= 0.5 in the bin."""
    import numpy as np

    from services.lift.live_lift import lift_key, select_pieces

    config = dataset.live_lift
    handle = config.handle
    bins = max(1, int(bins))
    edges = np.linspace(int(start), int(end), bins + 1)
    labels = config.labels()
    want = str(lift_hap).upper() if lift_hap else None
    haps = [h for h in config.haplotypes if want is None or h.upper() == want or labels.get(h, "").upper() == want]
    counts = {labels[h]: np.zeros(bins) for h in haps}
    pooled_counts = np.zeros(bins)
    corr = {labels[h]: np.zeros(bins) for h in haps}
    pooled_corr = np.zeros(bins)
    if chrom in handle.map.targets and haps:
        key = lift_key(handle, config.haplotypes, config.settings)
        sel = select_pieces(handle, chrom, start, end, haplotypes=haps, settings=config.settings, key=key)
        all_spans = []
        for hap in haps:
            merged = _merge((max(p.t_start, start), min(p.t_end, end)) for p in sel.pieces
                            if p.primary and p.hap == hap and p.t_end > start and p.t_start < end)
            _add_spans(corr[labels[hap]], edges, merged)
            corr[labels[hap]] /= np.diff(edges)
            all_spans += merged
        _add_spans(pooled_corr, edges, _merge(all_spans))
        pooled_corr /= np.diff(edges)
        options = {"include_methylation": False, "include_layers": False, "hide_terminal_gaps": False,
                   "include_duplicates": include_duplicates, "insertion_ids": []}
        if rows is None and not correspondence_only:
            rows = lifted_reads_for_region(dataset, chrom, start, end, options)
        origin = start if rows_start is None else rows_start
        molecules = {}
        for row in (() if correspondence_only else filter_lift_display(rows or (), dataset, lift_hap)):
            ll = row.get("live_lift") or {}
            label = ll.get("hap_label")
            if ll.get("alt") or label not in counts:
                continue
            # Overlapping placements/supplementaries of one molecule are one
            # observation, even when they were projected into separate rows.
            molecule = ll.get("molecule") or ll.get("row") or row.get("id")
            touched = molecules.setdefault((label, molecule), set())
            for a, b in _body_spans(ll):
                i0 = max(0, int(np.searchsorted(edges, a + origin, side="right")) - 1)
                i1 = min(bins - 1, int(np.searchsorted(edges, b + origin, side="left")) - 1)
                touched.update(range(i0, i1 + 1))
        for (label, _molecule), touched in molecules.items():
            for i in touched:
                counts[label][i] += 1
        pooled_molecules = {}
        for (_label, molecule), touched in molecules.items():
            pooled_molecules.setdefault(molecule, set()).update(touched)
        for touched in pooled_molecules.values():
            for i in touched:
                pooled_counts[i] += 1
    pooled = pooled_counts
    mode = config.settings.pooled_depth
    if mode == "correspondence_normalised" and corr:
        n = sum((c >= 0.5).astype(float) for c in corr.values())
        pooled = np.where(n > 0, pooled / np.maximum(n, 1), pooled)

    def depth(values, c):
        if correspondence_only:
            return None
        return [None if cc <= 0 else round(float(v), 3) for v, cc in zip(values, c)]

    pooled_list = [round(float(v), 3) for v in pooled]
    return {
        "coverage": None if correspondence_only else pooled_list,
        "max": max(pooled_list) if pooled_list else 0,
        "live_lift": {
            "haplotypes": {label: {"depth": depth(counts[label], corr[label]),
                                   "correspondence": [round(float(c), 4) for c in corr[label]]} for label in counts},
            "pooled": {"depth": depth(pooled, pooled_corr),
                       "correspondence": [round(float(c), 4) for c in pooled_corr], "mode": mode},
            "hatching": bool(config.settings.coverage_hatching),
        },
    }


def _merge(spans):
    merged = []
    for a, b in sorted(spans):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def _body_spans(ll: dict) -> list:
    out = []
    cons = sorted(ll.get("connectors") or ())
    for s0, s1, *_rest in ll.get("segments") or ():
        pos = s0
        for c0, c1 in cons:
            if c1 <= s0 or c0 >= s1:
                continue
            if c0 > pos:
                out.append((pos, c0))
            pos = max(pos, c1)
        if s1 > pos:
            out.append((pos, s1))
    return out


def body_spans_view(ll: dict, start: int, end: int) -> bool:
    """Spanning requires continuous body, never a connector's empty envelope.
    Badges are point cuts, so touching bodies rejoin without losing a base."""
    return any(a <= start and b >= end for a, b in _merge(_body_spans(ll)))


def _add_spans(acc, edges, spans):
    """Add each span's overlap (bp) with every bin to ``acc``."""
    import numpy as np
    for a, b in spans:
        if b <= a:
            continue
        i0 = max(0, int(np.searchsorted(edges, a, side="right")) - 1)
        i1 = min(len(acc) - 1, int(np.searchsorted(edges, b, side="left")) - 1)
        for i in range(i0, i1 + 1):
            lo, hi = max(a, edges[i]), min(b, edges[i + 1])
            if hi > lo:
                acc[i] += hi - lo
