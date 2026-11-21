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

from .sizebytes import NUCSZ_NAMES, nucsz_bytes
from .store import STORE

LAYER_GROUPS = ('nucsz', 'nucseg', 'nucreg')
#: on-demand layers drawn only when a load names them (never part of an all-layer load): regularity patches
ON_DEMAND_GROUPS = ('nucpatch',)
#: a row's internal field: the dataset's random-packing reference median (log2) for its nucreg tiles (Cluster's
#: ``nuc.reg`` fill value and threshold, the ``nuc.reg.frac_above_ref`` metric); never sent to a client
NUCREG_REF_KEY = '_fiberbrowser_nucreg_ref'
#: CONTRACTS §11.3 quality names (the MA groups' header declarations); nucsz without the named-class byte FiberHMM
#: wrote before 3.2.0 (named classes were removed: ``sizebytes``)
QUALITY_NAMES = {
    'nucsz': list(NUCSZ_NAMES),
    'nucseg': ['code', 'posterior_or_llr10', 'q_hat_minus_100_or_count'],
    'nucreg': ['score', 'period'],
    'nucpatch': ['score', 'period', 'flags', 'geometry', 'root', 'patch'],
}
LAYER_META = {
    'nucsz': ('Nucleosome size classes', '#16a34a'),
    'nucseg': ('Nucleosome array segments', '#15803d'),
    'nucreg': ('Nucleosome regularity', '#2c8ca0'),
    'nucpatch': ('Regularity patches', '#c8323c'),
}


def injector(bam_path, region_start: int, region_end: int, *, include_layers: bool, requested_layers,
             include_qualities: bool, include_lift_meta: bool) -> Optional[Callable[[dict], None]]:
    """A function adding the store's nuc layers to a read row of this load (None: nothing to add)."""
    if not include_layers or not isinstance(bam_path, str) or '://' in bam_path:
        return None
    groups = [g for g in LAYER_GROUPS if requested_layers is None or g in requested_layers]
    # The molecule scalars (nucmol: Filter/Sort terms, cluster columns, Read Stats) ride on the row as internal
    # fields whenever the request loads layers.
    scalars = requested_layers is None or 'nucmol' in requested_layers
    # Regularity patches cost nothing unless a load names them (services/nuc/nucgeo.py).
    patches = requested_layers is not None and 'nucpatch' in requested_layers
    if not groups and not scalars and not patches:
        return None
    if not STORE.has_rows(bam_path):
        return None
    rows = STORE.rows_of(bam_path)
    r0, r1 = int(region_start), int(region_end)
    reg = None
    if 'nucreg' in groups:
        # Regularity tiles cost nothing unless asked for: a load naming the nucreg layer (the lane is shown, a
        # nuc.reg.* term) computes the tiles its rows lack; a load of every layer only uses cached tiles.
        from .regularity import digest8, path_params, reference_for_path
        explicit = requested_layers is not None and 'nucreg' in requested_layers
        reg_params = path_params(bam_path)
        if explicit and reference_for_path(bam_path, digest8(reg_params)) is None:
            # never computed on the read path: started in the background (single flight) for the file's dataset;
            # the lane uses its fallback scale until it is ready
            from .reference import request_background
            request_background(bam_path, digest8(reg_params))
        reg = (reg_params, digest8(reg_params), explicit, reference_for_path(bam_path, digest8(reg_params)))

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
        if patches:
            from .nucgeo import layer_payload as patch_payload, marks_for_row
            layers.pop('nucpatch', None)
            pg: list = []
            pm = marks_for_row(bam_path, str(sha), int(occ), out, compute=True, generation_out=pg) or ()
            payload = patch_payload(pm, r0, r1, include_qualities=include_qualities, include_calls=include_lift_meta)
            if payload is not None:
                payload['nuc_live'] = True
                from .nucgeo import label_key
                payload['lk'] = label_key(bam_path, str(sha), int(occ))     # its geometry labels (patch_labels)
                if pg:
                    payload['pg'] = pg[0]       # the patch generation the labels must match (patch_labels' pg)
                layers['nucpatch'] = payload
        if groups:
            # A receipt on the row: its nucleosome groups are the live outputs, an empty one included, so a scan's
            # overlay never brings older marks back (services/scan/overlay.py).
            read_data['nuc_live'] = True
        for g in groups:
            # Live outputs are the dataset's active configuration (the last Compute): they replace the record's own
            # group (an annotated BAM, possibly from other settings), and the scan overlay leaves them alone.
            layers.pop(g, None)
            marks, digest, names = out.groups.get(g) or (), '', None
            if g == 'nucreg':
                from .regularity import mark_ref_deltas, tiles_for_row, with_ref_deltas
                marks = tiles_for_row(bam_path, str(sha), int(occ), out, reg[0], compute=reg[2]) or ()
                digest = reg[1]
                # cut windows (ends 'truncated'): each tile's per-width reference shift rides as a third quality
                marks, names = with_ref_deltas(marks, mark_ref_deltas(bam_path, str(sha), int(occ), marks, reg[0],
                                                                      reg[3]))
            payload = layer_payload(g, marks, r0, r1, include_qualities=include_qualities,
                                    include_calls=include_lift_meta, quality_names=names)
            if payload is not None:
                payload['nuc_live'] = True
                if g == 'nucreg':
                    attach_regularity_scale(read_data, payload, bam_path, digest)
                    from .regularity import cached_reach
                    reach = cached_reach(bam_path, str(sha), int(occ), digest)
                    if reach is not None:
                        # the window grid's reach (beyond it: no window; inside it, a gap = too few calls)
                        payload['reach'] = [int(reach[0]) - r0, int(reach[1]) - r0]
                layers[g] = payload
        if scalars:
            from .scalars import SCALARS_KEY, scalars_from_values
            have = read_data.setdefault(SCALARS_KEY, {})
            have.update(scalars_from_values('nuc', {k: v for k, v in out.scalars.items()
                                                     if k not in ('calls_digest_hi', 'calls_digest_lo')}))
    return inject


def attach_regularity_scale(read_data: dict, payload: dict, bam_path, params_digest: str) -> None:
    """The lane's colour scale on a ``nucreg`` layer (``scale``: zero at the dataset's random-packing reference
    median, top at its observed 95th percentile) and the reference median as the row's internal field."""
    from .regularity import lane_scale, reference_for_path
    ref = reference_for_path(bam_path, params_digest) if params_digest and isinstance(bam_path, str) else None
    payload['scale'] = lane_scale(ref)
    payload['params_digest'] = params_digest
    if ref is not None and ref.get('median') is not None:
        read_data[NUCREG_REF_KEY] = float(ref['median'])


def lane_scale_for(path, params_digest: str) -> dict:
    from .regularity import lane_scale, reference_for_path
    return lane_scale(reference_for_path(path, params_digest) if params_digest and isinstance(path, str) else None)


def layer_payload(group: str, marks, region_start: int, region_end: int, *, include_qualities: bool = True,
                  include_calls: bool = False, quality_names=None) -> Optional[dict]:
    """One group's marks as a layer of a row relative to ``region_start``, clipped to the region, in reference order
    (as the MA parser orders a molecular-frame reverse record's intervals). ``quality_names``: the marks' quality
    names when they carry more than the group's own (a live nucreg layer's ``ref_delta``)."""
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
        quals.append(tuple(0 if b is None else b for b in nucsz_bytes(q)) if group == 'nucsz' else q)
        if include_calls:
            calls.append([f'{group}:{k}', int(ms), int(ms) + int(ml)])
    if not ivs:
        return None
    qnames = list(quality_names) if quality_names else QUALITY_NAMES[group]
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
        for g in LAYER_GROUPS + ON_DEMAND_GROUPS:
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


def flip_patch_flags(flags: int) -> int:
    """A ``nucpatch`` flags byte seen from the other strand: open start <-> open end (bits 0/1), snapped start <->
    snapped end (bits 2/3); bit 4 (low regularity) stays. FiberHMM writes the bits in molecular orientation; the
    lanes read them in reference orientation (start = genomic left)."""
    f = int(flags)
    return (f & ~0xF) | ((f & 1) << 1) | ((f & 2) >> 1) | ((f & 4) << 1) | ((f & 8) >> 1)
