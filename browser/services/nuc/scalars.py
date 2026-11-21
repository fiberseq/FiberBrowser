"""Per-molecule scalars: the scan modules' scalar groups as Filter/Sort terms, cluster columns and Read Stats columns.

A scalar group is one whole-molecule MA annotation of codec bytes (CONTRACTS §6.4): ``nucmol`` (nuc, §11.3; 27 bytes
in group version 2) and ``nfrmol`` (nfr; 4 bytes). A read row gets its scalars, keyed by metric id
(``'nuc.nrl'``, ``'nfr.openness'``...), under ``_fiberbrowser_scalars`` (an internal field, never sent to a client):

- from the live nucleosome store (exact values; ``services.nuc.layers``);
- from a tables-mode scan's ``<module>/molecules.tsv.bgz`` (exact values; the scan overlay);
- from an annotated BAM's own group: the compact-read loader parses it as a layer and ``scalar_groups_to_fields``
  decodes its bytes with the published codecs and drops the layer (a scalar group is never drawn). Before that,
  ``nuc_group_validator`` drops the record's nucleosome groups FiberHMM reads as stale or unsupported (their calls
  digest no longer matches the record's calls, or another group version), so no stale value or mark is exposed.

A missing value (a codec's missing byte, a molecule too short for a repeat length) is None: it never passes a
filter comparison and sorts last.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

SCALARS_KEY = '_fiberbrowser_scalars'
WITHOUT_CALLS_KEY = '_fiberbrowser_nuc_without_calls'

#: (name, nbytes, scale, offset, unit) in byte order: CONTRACTS §11.3 (nucmol, group version 2) and §6.4 (nfrmol)
NUCMOL_CODECS: Tuple[Tuple[str, int, float, float, str], ...] = (
    ('nrl', 1, 1.0, 100.0, 'bp'),
    ('regularity', 1, 0.008, -1.0, 'acf'),
    ('spectral_snr', 1, 0.5, 0.0, 'ratio'),
    ('gap_cv', 1, 0.008, 0.0, 'ratio'),
    ('lambda_acc', 2, 2e-5, 0.0, 'fraction'),
    ('rho_read', 2, 2e-5, 0.0, 'fraction'),
    ('n_dyads', 2, 1.0, 0.0, 'count'),
    ('n_short', 1, 1.0, 0.0, 'count'),
    ('n_mono', 2, 1.0, 0.0, 'count'),
    ('n_long', 1, 1.0, 0.0, 'count'),
    ('n_multi', 1, 1.0, 0.0, 'count'),
    ('n_cant_tell', 2, 1.0, 0.0, 'count'),
    ('reg_fraction', 1, 0.004, 0.0, 'fraction'),
    ('disordered_fraction', 1, 0.004, 0.0, 'fraction'),
    ('undetermined_fraction', 1, 0.004, 0.0, 'fraction'),
    ('undersized_fraction', 1, 0.004, 0.0, 'fraction'),
    ('n_missing', 1, 1.0, 0.0, 'count'),
    ('flags', 1, 1.0, 0.0, 'bits'),
    ('calls_digest_hi', 2, 1.0, 0.0, 'digest'),
    ('calls_digest_lo', 2, 1.0, 0.0, 'digest'),
)
NFRMOL_CODECS: Tuple[Tuple[str, int, float, float, str], ...] = (
    ('openness', 1, 0.004, 0.0, 'fraction'),
    ('n_nfr', 1, 1.0, 0.0, 'count'),
    ('longest_linker', 2, 1.0, 0.0, 'bp'),
)
GROUP_CODECS = {'nucmol': NUCMOL_CODECS, 'nfrmol': NFRMOL_CODECS}
GROUP_MODULE = {'nucmol': 'nuc', 'nfrmol': 'nfr'}
SCALAR_GROUPS = tuple(GROUP_CODECS)
#: nucmol flag bits (CONTRACTS §11.3)
NUC_FLAG_BITS = ('too_short_nrl', 'too_short_regularity', 'too_short_snr', 'too_short_segments', 'low_information')

LABELS = {
    'nuc.nrl': 'Repeat length (NRL)', 'nuc.regularity': 'Regularity S', 'nuc.spectral_snr': 'Spectral SNR',
    'nuc.gap_cv': 'Dyad gap CV', 'nuc.lambda_acc': 'Accessible marking rate λ', 'nuc.rho_read': 'Marks per site (read)',
    'nuc.n_dyads': 'Dyads', 'nuc.n_short': 'Short footprints', 'nuc.n_mono': 'Mono footprints',
    'nuc.n_long': 'Long footprints', 'nuc.n_multi': 'Multi footprints', 'nuc.n_cant_tell': "Can't-tell footprints",
    'nuc.reg_fraction': 'Regular fraction', 'nuc.disordered_fraction': 'Disordered fraction',
    'nuc.undetermined_fraction': 'Undetermined fraction', 'nuc.undersized_fraction': 'Undersized fraction',
    'nuc.n_missing': 'Missing nucleosomes', 'nfr.openness': 'Openness', 'nfr.n_nfr': 'NFRs (linkers ≥ 175 bp)',
    'nfr.longest_linker': 'Longest linker',
    'nuc.reg.median': 'Regularity score (median)', 'nuc.reg.max': 'Regularity score (max)',
    'nuc.reg.frac_above_ref': 'Regularity: share of tiles above random packing',
}
#: Molecule metrics derived from a row's ``nucreg`` tiles (the score bytes inside the loaded region), not from a
#: scalar group: (id, name, unit)
REGULARITY_METRICS: Tuple[Tuple[str, str, str], ...] = (
    ('nuc.reg.median', 'reg.median', 'log2'),
    ('nuc.reg.max', 'reg.max', 'log2'),
    ('nuc.reg.frac_above_ref', 'reg.frac_above_ref', 'fraction'),
)
_HIDDEN = {'flags', 'calls_digest_hi', 'calls_digest_lo'}


def metrics() -> List[dict]:
    """The molecule metrics a term can name: ``{id, group, module, name, label, unit}``."""
    out = []
    for group, codecs in GROUP_CODECS.items():
        module = GROUP_MODULE[group]
        for name, _nb, _sc, _off, unit in codecs:
            if name in _HIDDEN:
                continue
            mid = f'{module}.{name}'
            out.append(dict(id=mid, group=group, module=module, name=name, label=LABELS.get(mid, name), unit=unit))
    for mid, name, unit in REGULARITY_METRICS:
        out.append(dict(id=mid, group='nucreg', module='nuc', name=name, label=LABELS[mid], unit=unit))
    return out


METRIC_GROUP = {m['id']: m['group'] for m in metrics()}


def group_of(metric_id: Optional[str]) -> Optional[str]:
    return METRIC_GROUP.get(str(metric_id or ''))


def decode_bytes(group: str, qbytes: Sequence[int]) -> Dict[str, Optional[float]]:
    """Scalars of one group's bytes (CONTRACTS §6.4 codec: 1 byte, 255 missing; 2 bytes big-endian, 65535 missing);
    {} when the length is not the group's (another group version)."""
    codecs = GROUP_CODECS.get(group)
    if not codecs or len(qbytes) != sum(c[1] for c in codecs):
        return {}
    out: Dict[str, Optional[float]] = {}
    i = 0
    module = GROUP_MODULE[group]
    for name, nb, scale, offset, _unit in codecs:
        if nb == 1:
            q = int(qbytes[i])
            value = None if q == 255 else offset + scale * q
        else:
            q = 256 * int(qbytes[i]) + int(qbytes[i + 1])
            value = None if q == 65535 else offset + scale * q
        i += nb
        out[f'{module}.{name}'] = value
    return out


def scalars_from_values(module: str, values: Dict[str, Optional[float]]) -> Dict[str, Optional[float]]:
    """Exact values by scalar name (the live store, a molecules table) as metric ids."""
    return {f'{module}.{k}': (None if v is None else float(v)) for k, v in values.items()}


def scalar_groups_to_fields(read_data: dict) -> None:
    """Decode a row's scalar-group layers (an annotated BAM's nucmol / nfrmol) into ``_fiberbrowser_scalars`` and
    drop the layers. Values already there (exact ones) win."""
    layers = read_data.get('layers')
    if not layers:
        return
    for group in SCALAR_GROUPS:
        layer = layers.get(group)
        if layer is None:
            continue
        layers.pop(group, None)
        tracks = layer.get('qualities') or []
        if not tracks or not all(len(t) for t in tracks):
            continue
        decoded = decode_bytes(group, [int(t[0]) for t in tracks])
        if decoded:
            have = read_data.setdefault(SCALARS_KEY, {})
            for k, v in decoded.items():
                have.setdefault(k, v)


NUC_MA_GROUPS = frozenset({'nucsz', 'nucseg', 'nucmol', 'nucreg', 'nucpatch'})
_HEADER_CONTEXTS: Dict[int, tuple] = {}


def nuc_header_context(header):
    """Parse contracts and call frames once per shared BAM header."""
    cached = _HEADER_CONTEXTS.get(id(header))
    if cached is not None and cached[0] is header:
        return cached[1:]
    from fiberhmm.io.scan_ma import scan_contracts
    from fiberhmm.nuc.records import FrameContext
    contracts, context = scan_contracts(header), FrameContext(header)
    if len(_HEADER_CONTEXTS) > 32:
        _HEADER_CONTEXTS.clear()
    _HEADER_CONTEXTS[id(header)] = (header, contracts, context)
    return contracts, context


def record_nuc_groups(record) -> Optional[dict]:
    """Read current nuc groups using cached public contracts and decode context."""
    try:
        from fiberhmm.nuc.tags import read_nuc_groups
        contracts, context = nuc_header_context(record.header)
        return read_nuc_groups(record, contracts=contracts, context=context)
    except Exception:
        return None


def has_non_array_tag_pair(record) -> bool:
    """Whether the record has both tags of an ns/nl or as/al pair but not as arrays (a string or a scalar): not
    calls by the array-pair rule, and not decodable by FiberHMM's legacy reader."""
    from services.bam_tags import interval_tag_pair
    try:
        return any(record.has_tag(a) and record.has_tag(b) and interval_tag_pair(record, a, b)[0] is None
                   for a, b in (('ns', 'nl'), ('as', 'al')))
    except Exception:
        return False


def without_non_array_tag_pairs(record):
    """A copy of the record without any ns/nl or as/al pair that is not an array pair (string or scalar), so
    FiberHMM's legacy reader never iterates one; valid array pairs and every other tag are kept. The record itself
    is returned unchanged when it has no such pair."""
    if not has_non_array_tag_pair(record):
        return record
    import pysam
    from services.bam_tags import interval_tag_pair
    copy = pysam.AlignedSegment.from_dict(record.to_dict(), record.header)
    for a, b in (('ns', 'nl'), ('as', 'al')):
        if record.has_tag(a) and record.has_tag(b) and interval_tag_pair(record, a, b)[0] is None:
            copy.set_tag(a, None)
            copy.set_tag(b, None)
    return copy


def record_without_calls(record) -> bool:
    """Whether FiberHMM would reach ``no_calls``, without decoding evidence or computing outputs.

    Match decode_record's MA/Ma precedence and legacy fallback, including TF-only/MSP-only calls.
    Earlier decode failures (no sequence, secondary) keep their existing classification.
    """
    if record.is_secondary or not record.query_length:
        return False
    try:
        from fiberhmm.io.ma_tags import annotation_tags, parse_ma_tag
        tags = annotation_tags(record)
        if tags is not None:
            parsed = parse_ma_tag(str(tags[0]))
            if any(t[0] in ('nuc', 'msp', 'tf') and t[3] for t in parsed['raw_types']):
                return False
        # The reader's array-pair rule (bam_tags.interval_tag_pair): a scalar ns:i (Dorado's signal sample
        # count) or a string pair is no call.
        from services.bam_tags import interval_tag_pair
        for a, b in (('ns', 'nl'), ('as', 'al')):
            starts, lengths = interval_tag_pair(record, a, b)
            if starts is not None and len(starts) and len(lengths):
                return False
        return True
    except Exception:
        # Malformed annotations are a decode error, not evidence that calls are absent.
        return False


def drop_stale_nuc_groups(read_data: dict, record, bam_path=None) -> None:
    """Drop the row's nucleosome group layers (``nucsz``, ``nucseg``, ``nucmol``, ``nucreg``, ``nucpatch``) that are not current for the
    record: stale (the calls digest in the group no longer matches the record's calls), unsupported (another group
    version in the header contract, a ``nucmol`` of another length), or unverifiable. Each group is judged on its
    own (FiberHMM's groups are self-contained), with FiberHMM's own rule. A requested nucleosome input also
    records call absence when there are no groups, so zero-count rules and clustering exclude it."""
    if record_without_calls(record):
        # No nucleosome categories or scalars may leak in from annotations or an overlay.
        read_data['nuc_live'] = True
        read_data[WITHOUT_CALLS_KEY] = True
        layers = read_data.get('layers') or {}
        for group in NUC_MA_GROUPS:
            layers.pop(group, None)
        have = read_data.get(SCALARS_KEY) or {}
        for key in list(have):
            if key.startswith('nuc.'):
                have.pop(key)
        return
    layers = read_data.get('layers')
    present = [g for g in NUC_MA_GROUPS if g in layers] if layers else ()
    if not present:
        return
    groups = record_nuc_groups(record) or {}
    for g in present:
        info = groups.get(g)
        if info is None or info.get('stale') or info.get('unsupported'):
            layers.pop(g, None)
        elif g == 'nucreg':
            # Tiles of whatever regularity parameters the annotation used (their digest rides on the layer); the
            # lane's scale is the dataset's reference for those parameters when one was computed here.
            from .layers import attach_regularity_scale
            attach_regularity_scale(read_data, layers[g], bam_path, str(info.get('params_digest') or ''))


def molecule_scalars(read: dict) -> Dict[str, Optional[float]]:
    """A row's molecule scalars by metric id (empty when it has none)."""
    out = dict(read.get(SCALARS_KEY) or {})
    layers = read.get('layers') or {}
    for group in SCALAR_GROUPS:       # a row built before the loader decoded groups (cached elsewhere)
        layer = layers.get(group)
        if layer and not any(k.startswith(GROUP_MODULE[group] + '.') for k in out):
            tracks = layer.get('qualities') or []
            if tracks and all(len(t) for t in tracks):
                out.update(decode_bytes(group, [int(t[0]) for t in tracks]))
    return out


def regularity_value(read: dict, metric_id: str) -> Optional[float]:
    """A ``nuc.reg.*`` metric from the row's ``nucreg`` tiles (those in the loaded region): the median or maximum
    score (log2), or the share of tiles above the dataset's random-packing reference median (None without one)."""
    layer = (read.get('layers') or {}).get('nucreg') or {}
    tracks = layer.get('qualities') or []
    if not tracks or not tracks[0]:
        return None
    from fiberhmm.nuc.regularity import SCORE_LO, SCORE_SPAN
    scores = sorted(SCORE_LO + SCORE_SPAN * (int(q) - 1) / 254.0 for q in tracks[0] if int(q) > 0)
    if not scores:
        return None
    if metric_id == 'nuc.reg.max':
        return scores[-1]
    if metric_id == 'nuc.reg.median':
        n = len(scores)
        return scores[n // 2] if n % 2 else 0.5 * (scores[n // 2 - 1] + scores[n // 2])
    if metric_id == 'nuc.reg.frac_above_ref':
        from .layers import NUCREG_REF_KEY
        ref = read.get(NUCREG_REF_KEY)
        scale = layer.get('scale') or {}
        if ref is None and scale.get('reference'):
            ref = scale.get('zero')
        if ref is None:
            return None
        return sum(1 for s in scores if s > float(ref)) / len(scores)
    return None


def metric_value(read: dict, metric_id: Optional[str]) -> Optional[float]:
    """One scalar of a row, or None (missing, or the row has no such group)."""
    if not metric_id:
        return None
    if metric_id.startswith('nuc.reg.'):
        return regularity_value(read, metric_id)
    value = (read.get(SCALARS_KEY) or {}).get(metric_id)
    if value is None and metric_id not in (read.get(SCALARS_KEY) or {}):
        value = molecule_scalars(read).get(metric_id)
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None
