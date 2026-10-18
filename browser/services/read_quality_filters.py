"""Per-layer compact-read quality filtering."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterable, Optional

# Filters for one request instead of the server's (a headless figure uses the
# ones saved with its view; the browser's own reads use the server's).
_request_filters: ContextVar[Optional[list]] = ContextVar("fiberbrowser_request_quality_filters", default=None)


def active_quality_filters(state) -> list:
    """The quality filters in force: this request's, else the server's."""
    override = _request_filters.get()
    if override is not None:
        return list(override)
    return list(getattr(state, "quality_filters", None) or [])


@contextmanager
def quality_filters_for_request(filters):
    """Use `filters` (backend form: layer, quality_name, min_value) for reads loaded inside."""
    token = _request_filters.set(list(filters or []))
    try:
        yield
    finally:
        _request_filters.reset(token)


def backend_quality_filters(colormap_filters) -> list:
    """The browser colormap's quality filters in the server's form (Browser.tsx sends the same)."""
    out = []
    for f in colormap_filters or []:
        if not isinstance(f, dict) or not f.get("enabled", True):
            continue
        try:
            value = float(f.get("minValue", 0) or 0)
        except (TypeError, ValueError):
            continue
        if value > 0 and f.get("qualityName"):
            out.append({"layer": f.get("layer") or "*", "quality_name": f["qualityName"], "min_value": value})
    return out


def _layer_matches(filter_layer: str, layer_name: str) -> bool:
    """Return True when a quality filter applies to a compact-read layer."""
    if filter_layer == '*' or filter_layer == layer_name:
        return True
    # User-facing FIRE maps to the internal MSP/as-al layer in legacy files
    # and BigBed companion tracks. Keep the alias symmetric for old sessions.
    return (filter_layer == 'fire' and layer_name == 'msp') or (
        filter_layer == 'msp' and layer_name == 'fire'
    )


def _placeholder_quality_array(layer_name: str, quality_name: str, values) -> bool:
    """Whether a declared quality vector is actually legacy missing-data padding.

    Older FIRE/MSP producers retain the ``aq`` column in BigBed/BAM output but
    fill the whole vector with 0 (or the historical neutral sentinel 128).
    Treat that exactly like an absent quality dimension: raw accessibility is
    still valid geometry and must not disappear under the default aq filter.
    """
    return (
        layer_name in {'fire', 'msp'}
        and quality_name == 'aq'
        and bool(values)
        and all(value in (None, 0, 128) for value in values)
    )


def apply_quality_filters(read: dict, quality_filters: Iterable[dict]) -> Optional[dict]:
    """Return a filtered compact read, or None when no intervals survive."""
    original_read = read
    layers = read.get('layers') or {}
    quality_filters = list(quality_filters or [])
    read = {**read}  # shallow copy so broad-cache reads are not mutated
    filtered_layers = {}

    if layers:
        for layer_name, layer in layers.items():
            applicable = [
                f for f in quality_filters
                if _layer_matches(f.get('layer', '*'), layer_name) and f.get('min_value', 0) > 0
            ]
            if not applicable:
                filtered_layers[layer_name] = layer
                continue

            quality_names = layer.get('quality_names') or []
            qualities = layer.get('qualities') or []
            intervals = layer['intervals']
            n = len(intervals)

            keep = [True] * n
            for filt in applicable:
                qname = filt.get('quality_name', '')
                min_val = filt['min_value']
                if qname not in quality_names or quality_names.index(qname) >= len(qualities):
                    if layer_name in {'fire', 'msp'} and qname == 'aq':
                        # FIRE has always supported unqualified raw
                        # accessibility. The shipped aq gate refines callers
                        # that provide real precision scores; it must remain a
                        # no-op for inferred/legacy MSP geometry without aq.
                        continue
                    # An explicitly targeted layer that does not carry the
                    # selected quality dimension cannot satisfy the filter.
                    # Fail closed instead of presenting a silently active,
                    # no-op filter. Wildcard filters remain compatibility
                    # filters and skip layers to which the dimension does not
                    # apply.
                    if filt.get('layer', '*') != '*':
                        keep = [False] * n
                    continue
                qi = quality_names.index(qname)
                q_arr = qualities[qi]
                if _placeholder_quality_array(layer_name, qname, q_arr):
                    continue
                for i in range(n):
                    # A short/malformed AQ track is missing evidence,
                    # not permission to retain the remaining interval.
                    if i >= len(q_arr) or q_arr[i] < min_val:
                        keep[i] = False

            if all(keep):
                filtered_layers[layer_name] = layer
            elif not any(keep):
                # Kept as an explicitly empty layer: every call failed the
                # gate. Dropping it would let analyses fall back to the
                # unfiltered primary intervals (loaders never emit empty
                # layers, so a present layer is authoritative).
                empty_layer = {
                    'intervals': [],
                    'qualities': [[] for _ in qualities] if qualities else None,
                    'quality_names': quality_names,
                }
                for meta_key in ('annotation_names', 'circular_ids', 'source_intervals'):
                    if layer.get(meta_key) is not None:
                        empty_layer[meta_key] = []
                filtered_layers[layer_name] = empty_layer
            else:
                new_intervals = [iv for i, iv in enumerate(intervals) if keep[i]]
                new_qualities = [
                    [q for i, q in enumerate(qarr) if i < n and keep[i]]
                    for qarr in qualities
                ] if qualities else []
                filtered_layer = {
                    'intervals': new_intervals,
                    'qualities': new_qualities if new_qualities else None,
                    'quality_names': quality_names,
                }
                for meta_key in ('annotation_names', 'circular_ids', 'source_intervals'):
                    meta_values = layer.get(meta_key)
                    if meta_values is not None:
                        filtered_layer[meta_key] = [
                            meta_values[i] if i < len(meta_values) else (
                                intervals[i] if meta_key == 'source_intervals' else ''
                            )
                            for i in range(n)
                            if keep[i]
                        ]
                filtered_layers[layer_name] = filtered_layer

        if filtered_layers:
            read['layers'] = filtered_layers
        elif 'layers' in read:
            del read['layers']

    fire_filters = [
        f for f in quality_filters
        if _layer_matches(f.get('layer', '*'), 'fire')
        and f.get('quality_name') == 'aq'
        and f.get('min_value', 0) > 0
    ]
    if fire_filters and read.get('fire'):
        fire_quality_values = [
            interval[2] for interval in read['fire']
            if len(interval) >= 3 and interval[2] is not None
        ]
        fire_quality_missing = bool(fire_quality_values) and all(
            value in (0, 128) for value in fire_quality_values
        )
        filtered_fire = []
        if fire_quality_missing:
            filtered_fire = list(read['fire'])
        else:
            for interval in read['fire']:
                # Missing aq means "unqualified accessibility"; keep it so older
                # files still display instead of being silently filtered away.
                if len(interval) < 3 or interval[2] is None:
                    filtered_fire.append(interval)
                    continue
                if all(interval[2] >= f['min_value'] for f in fire_filters):
                    filtered_fire.append(interval)
        read['fire'] = filtered_fire

    nuc_filters = [
        f for f in quality_filters
        if _layer_matches(f.get('layer', '*'), 'nuc') and f.get('min_value', 0) > 0
    ]
    if nuc_filters and 'qualities' in read and read['qualities']:
        nq_filter = next((f for f in nuc_filters if f.get('quality_name') == 'nq'), None)
        if nq_filter:
            min_nq = nq_filter['min_value']
            new_intervals = []
            new_qualities = []
            fp_idx = 0
            for iv in read['intervals']:
                if iv[2] > 0:
                    if fp_idx < len(read['qualities']) and read['qualities'][fp_idx] >= min_nq:
                        new_intervals.append(iv)
                        new_qualities.append(read['qualities'][fp_idx])
                    fp_idx += 1
                else:
                    new_intervals.append(iv)
            read['intervals'] = new_intervals
            read['qualities'] = new_qualities

    if not read.get('intervals'):
        return None

    if read.get("live_lift"):
        from services.lift.reads import realign_call_metadata
        return realign_call_metadata(original_read, read)
    return read


def _filter_keeps(layer_name: str, layer: dict, filt: dict) -> list[bool]:
    """Which intervals of one layer a single filter keeps (same rules as above)."""
    intervals = layer.get('intervals') or []
    n = len(intervals)
    qname = filt.get('quality_name', '')
    min_val = filt.get('min_value', 0)
    quality_names = layer.get('quality_names') or []
    qualities = layer.get('qualities') or []
    if qname not in quality_names or quality_names.index(qname) >= len(qualities):
        if layer_name in {'fire', 'msp'} and qname == 'aq':
            return [True] * n
        return [False] * n if filt.get('layer', '*') != '*' else [True] * n
    q_arr = qualities[quality_names.index(qname)]
    if _placeholder_quality_array(layer_name, qname, q_arr):
        return [True] * n
    return [i < len(q_arr) and q_arr[i] is not None and q_arr[i] >= min_val for i in range(n)]


def quality_filter_impact(reads: Iterable[dict], quality_filters: Iterable[dict]) -> list[dict]:
    """Per filter: calls it applies to in these reads and how many it keeps.

    Lets the UI say what a filter removes ("-14% of TF calls") instead of
    changing results silently.
    """
    filters = [f for f in (quality_filters or []) if f.get('min_value', 0) > 0]
    out = [{'total': 0, 'kept': 0, 'layers': set()} for _ in filters]
    for read in reads:
        for layer_name, layer in (read.get('layers') or {}).items():
            for index, filt in enumerate(filters):
                if not _layer_matches(filt.get('layer', '*'), layer_name):
                    continue
                keeps = _filter_keeps(layer_name, layer, filt)
                if not keeps:
                    continue
                out[index]['total'] += len(keeps)
                out[index]['kept'] += sum(keeps)
                out[index]['layers'].add(layer_name)
    return [
        {'layer': f.get('layer', '*'), 'quality_name': f.get('quality_name', ''), 'min_value': f.get('min_value', 0),
         'total': o['total'], 'kept': o['kept'], 'layers': sorted(o['layers'])}
        for f, o in zip(filters, out)
    ]


def available_quality_names(reads: Iterable[dict]) -> dict[str, list[str]]:
    """Quality dimensions each layer actually carries in these reads (real values only)."""
    found: dict[str, set[str]] = {}
    for read in reads:
        for layer_name, layer in (read.get('layers') or {}).items():
            names = layer.get('quality_names') or []
            qualities = layer.get('qualities') or []
            for index, name in enumerate(names):
                if index >= len(qualities) or not qualities[index]:
                    continue
                if _placeholder_quality_array(layer_name, name, qualities[index]):
                    continue
                found.setdefault(layer_name, set()).add(name)
    return {layer: sorted(names) for layer, names in found.items()}
