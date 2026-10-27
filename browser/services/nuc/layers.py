"""Nucleosome outputs as read layers, attached where the compact-read loader builds each record's row.

``build_compact_reads_from_bam`` is the one place every read payload starts from: native views, live lift's source
decode (``services/lift/live_lift.decode_source_records``) and the graph panel's per-record decode. A record whose
outputs are in the store gets ``nucsz`` and ``nucseg`` layers there, in the shape ``parse_ma_aq_tags_into_layers``
gives an annotated BAM's MA groups (region-relative reference intervals with the mark's molecular length, quality
tracks, AN names, and on live-lift decodes ``_fiberbrowser_calls`` with molecular spans), so live lift and graph
composition project them like any MA group. A record that carries the groups itself (an annotated BAM) keeps its
own.

``nucmol`` (one whole-molecule interval of scalar bytes) is never a drawn layer: its values ride on the row as
internal scalars (``services.nuc.scalars``) for Filter/Sort terms, cluster columns and Read Stats.
"""
from __future__ import annotations

from typing import Callable, Optional

from .store import STORE

LAYER_GROUPS = ('nucsz', 'nucseg')
#: CONTRACTS §11.3 quality names (the MA groups' header declarations)
QUALITY_NAMES = {
    'nucsz': ['coarse', 'named', 'posterior', 'z'],
    'nucseg': ['code', 'posterior_or_llr10', 'q_hat_minus_100_or_count'],
}
LAYER_META = {
    'nucsz': ('Nucleosome size classes', '#16a34a'),
    'nucseg': ('Nucleosome array segments', '#15803d'),
}


def injector(bam_path, region_start: int, region_end: int, *, include_layers: bool, requested_layers,
             include_qualities: bool, include_lift_meta: bool) -> Optional[Callable[[dict], None]]:
    """A function adding the store's nuc layers to a read row of this load (None: nothing to add)."""
    if not include_layers or not isinstance(bam_path, str) or '://' in bam_path or not STORE.has_rows(bam_path):
        return None
    groups = [g for g in LAYER_GROUPS if requested_layers is None or g in requested_layers]
    # The molecule scalars (nucmol: Filter/Sort terms, cluster columns, Read Stats) ride on the row as internal
    # fields whenever the request loads layers.
    scalars = requested_layers is None or 'nucmol' in requested_layers
    if not groups and not scalars:
        return None
    rows = STORE.rows_of(bam_path)
    r0, r1 = int(region_start), int(region_end)

    def inject(read_data: dict) -> None:
        sha, occ = read_data.get('record_sha256'), read_data.get('alignment_occurrence')
        if sha is None or occ is None:
            return
        out = rows.get((str(sha), int(occ)))
        if out is None:
            return
        layers = read_data.get('layers')
        if layers is None:
            layers = read_data['layers'] = {}
        for g in groups:
            # Live outputs are the dataset's active configuration (the last Compute): they replace the record's own
            # group (an annotated BAM, possibly from other settings), and the scan overlay leaves them alone.
            layers.pop(g, None)
            payload = layer_payload(g, out.groups.get(g) or (), r0, r1, include_qualities=include_qualities,
                                    include_calls=include_lift_meta)
            if payload is not None:
                payload['nuc_live'] = True
                layers[g] = payload
        if scalars:
            from .scalars import SCALARS_KEY, scalars_from_values
            have = read_data.setdefault(SCALARS_KEY, {})
            have.update(scalars_from_values('nuc', {k: v for k, v in out.scalars.items()
                                                     if k not in ('calls_digest_hi', 'calls_digest_lo')}))
    return inject


def layer_payload(group: str, marks, region_start: int, region_end: int, *, include_qualities: bool = True,
                  include_calls: bool = False) -> Optional[dict]:
    """One group's marks as a layer of a row relative to ``region_start``, clipped to the region, in reference order
    (as the MA parser orders a molecular-frame reverse record's intervals)."""
    ivs, names, quals, calls = [], [], [], []
    order = sorted(range(len(marks)), key=lambda i: (marks[i][2], marks[i][3], marks[i][0], marks[i][1]))
    for k in order:
        ms, ml, a, b, q, name = marks[k]
        b = max(int(b), int(a) + 1)       # a zero-width mark (inside an insertion) is drawn as its base
        lo, hi = max(int(a), region_start), min(b, region_end)
        if hi <= lo:
            continue
        ivs.append([lo - region_start, hi - region_start, int(ml)])
        names.append(str(name))
        quals.append(q)
        if include_calls:
            calls.append([f'{group}:{k}', int(ms), int(ms) + int(ml)])
    if not ivs:
        return None
    qnames = QUALITY_NAMES[group]
    payload = {
        'intervals': ivs,
        'qualities': [[int(q[i]) if i < len(q) else 0 for q in quals] for i in range(len(qnames))] if include_qualities else None,
        'quality_names': list(qnames) if include_qualities else [],
        'annotation_names': names,
        'circular_ids': names,
    }
    if include_calls:
        payload['_fiberbrowser_calls'] = calls
    return payload


def declare_layers(state, dataset_ids) -> None:
    """Declare the nuc layers on datasets whose files have outputs (``available_layers`` + ``derived_layers`` kind
    ``nuc-live``), and drop the declaration from datasets whose files have none."""
    for ds_id, ds in (getattr(state, 'datasets', None) or {}).items():
        if dataset_ids is not None and ds_id not in dataset_ids:
            continue
        derived = getattr(ds, 'derived_layers', None)
        available = getattr(ds, 'available_layers', None)
        if derived is None or available is None:
            continue
        has = any(STORE.has_rows(p) for p in getattr(ds, 'paths', None) or () if isinstance(p, str) and '://' not in p)
        for g in LAYER_GROUPS:
            meta = derived.get(g)
            ours = isinstance(meta, dict) and meta.get('kind') == 'nuc-live'
            if has:
                if available.get(g) and not ours and meta is None:
                    continue      # the dataset's own MA group (annotated BAM)
                if isinstance(meta, dict) and meta.get('kind') == 'scan-overlay':
                    continue      # a bound tables-mode scan already declares it
                label, colour = LAYER_META[g]
                available[g] = True
                derived[g] = dict(id=g, label=label, color=colour, kind='nuc-live', source_layer='nuc')
            elif ours:
                derived.pop(g, None)
                available.pop(g, None)
