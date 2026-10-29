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
}
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


NUC_MA_GROUPS = frozenset({'nucsz', 'nucseg', 'nucmol'})
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


def drop_stale_nuc_groups(read_data: dict, record) -> None:
    """Drop the row's nucleosome group layers (``nucsz``, ``nucseg``, ``nucmol``) that are not current for the
    record: stale (the calls digest in the group no longer matches the record's calls), unsupported (another group
    version in the header contract, a ``nucmol`` of another length), or unverifiable. Each group is judged on its
    own (FiberHMM's groups are self-contained), with FiberHMM's own rule; one read per record, only when a row has a
    nucleosome group."""
    layers = read_data.get('layers')
    present = [g for g in NUC_MA_GROUPS if g in layers] if layers else ()
    if not present:
        return
    groups = record_nuc_groups(record) or {}
    for g in present:
        info = groups.get(g)
        if info is None or info.get('stale') or info.get('unsupported'):
            layers.pop(g, None)


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


def metric_value(read: dict, metric_id: Optional[str]) -> Optional[float]:
    """One scalar of a row, or None (missing, or the row has no such group)."""
    if not metric_id:
        return None
    value = (read.get(SCALARS_KEY) or {}).get(metric_id)
    if value is None and metric_id not in (read.get(SCALARS_KEY) or {}):
        value = molecule_scalars(read).get(metric_id)
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None
