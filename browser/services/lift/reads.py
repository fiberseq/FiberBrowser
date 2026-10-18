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

from typing import Iterable, Optional

# Loader options a lifted load takes from the display paths (the rest are fixed by live_lift).
_PASSED_OPTIONS = ("include_methylation", "ml_threshold", "include_layers", "requested_layers",
                   "include_layer_qualities", "infer_legacy_layers", "legacy_nuc_min_size", "min_footprints",
                   "short_terminal_footprint_bp", "hide_terminal_gaps", "terminal_gap_threshold",
                   "include_duplicates", "sv_min_len", "include_sv_seq", "min_fp_quality")


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
                            counts_out: Optional[dict] = None) -> list:
    """Lifted rows of ``[start, end)`` on the main genome, relative to
    ``start`` and clipped to it, as the BAM loader returns them; every row (no
    spanning, id, strand, haplotype or cap filter)."""
    from services.lift.live_lift import load_lifted_rows

    config = dataset.live_lift
    handle = config.handle
    if chrom not in handle.map.targets:
        return []
    loader_options = {k: v for k, v in (options or {}).items() if k in _PASSED_OPTIONS and v is not None}
    load = load_lifted_rows(handle, list(dataset.paths), chrom, int(start), int(end), haplotypes=config.haplotypes,
                            settings=config.settings, dataset_id=dataset.id, loader_options=loader_options,
                            output_region=(int(start), int(end)))
    if counts_out is not None:
        counts_out.update(load.counts)
    return load.rows


# ── Viewport crops ──────────────────────────────────────────────────────────

def clip_geometry(ll: dict, offset: int, width: int) -> dict:
    """``live_lift`` segments, connectors and badges shifted by ``-offset``
    and kept where they reach ``[0, width]``."""
    out = dict(ll)
    segs = []
    for s0, s1, *rest in ll.get("segments") or ():
        a, b = s0 - offset, s1 - offset
        if b > 0 and a < width:
            segs.append([max(a, 0), min(b, width), *rest])
    out["segments"] = segs
    cons = []
    for c0, c1 in ll.get("connectors") or ():
        a, b = c0 - offset, c1 - offset
        if b > 0 and a < width:
            cons.append([max(a, 0), min(b, width)])
    out["connectors"] = cons
    out["badges"] = [[b[0] - offset, *b[1:]] for b in ll.get("badges") or () if 0 <= b[0] - offset <= width]
    return out


def _kept(intervals, offset, width):
    """Indices the broad-cache projection keeps (working_sets._project_*_intervals)."""
    kept = []
    for i, iv in enumerate(intervals or ()):
        if len(iv) < 2:
            continue
        a, b = iv[0] - offset, iv[1] - offset
        if min(b, width) > max(a, 0):
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
            idx = _kept(groups.get(group), offset, width)
            cut[group] = [values[i] if i < len(values) else None for i in idx]
        out[field] = cut
    adjusted["live_lift"] = out


def geometry_intervals(read: dict) -> list:
    """A lifted row's body segments and badge points as intervals (the crop and
    the display index count them, so a row visible only through a terminal
    segment or badge survives)."""
    ll = read.get("live_lift")
    if not ll:
        return []
    out = [[s[0], s[1]] for s in ll.get("segments") or ()]
    out += [[b[0], b[0] + 1] for b in ll.get("badges") or ()]
    return out


# ── Haplotype panels ────────────────────────────────────────────────────────

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


# ── Coverage ────────────────────────────────────────────────────────────────

def lifted_coverage(dataset, chrom: str, start: int, end: int, bins: int, *, lift_hap: Optional[str] = None,
                    include_duplicates: bool = False) -> dict:
    """Binned coverage over ``[start, end)`` from lifted rows, as the read
    coverage track counts reads: each row once per bin its body (segments
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
                   "include_duplicates": include_duplicates}
        for row in lifted_reads_for_region(dataset, chrom, start, end, options):
            ll = row.get("live_lift") or {}
            label = ll.get("hap_label")
            if ll.get("alt") or label not in counts:
                continue
            touched = set()
            for a, b in _body_spans(ll):
                i0 = max(0, int(np.searchsorted(edges, a + start, side="right")) - 1)
                i1 = min(bins - 1, int(np.searchsorted(edges, b + start, side="left")) - 1)
                touched.update(range(i0, i1 + 1))
            for i in touched:
                counts[label][i] += 1
    pooled = sum(counts.values()) if counts else np.zeros(bins)
    mode = config.settings.pooled_depth
    if mode == "correspondence_normalised" and corr:
        n = sum((c >= 0.5).astype(float) for c in corr.values())
        pooled = np.where(n > 0, pooled / np.maximum(n, 1), pooled)

    def depth(values, c):
        return [None if cc <= 0 else round(float(v), 3) for v, cc in zip(values, c)]

    pooled_list = [round(float(v), 3) for v in pooled]
    return {
        "coverage": pooled_list,
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
