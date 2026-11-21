"""A browser dataset as nucleosome-module inputs.

- A native BAM dataset reads its own files, in the browser's reference coordinates.
- A live-lift dataset (``bam_livelift``) reads its **source** BAM files in the source assembly's coordinates:
  molecule-wide outputs are frame-free and follow each record through live lift and graph composition, as its
  calls do (feature hub DESIGN §4.3).

The read policy is the browser's (``services.scan.planning.read_policy``) resolved by FiberHMM, the policy a
feature-hub scan of the same dataset uses, so a calibration computed here equals that scan's.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, Optional, Tuple


class NucInputError(ValueError):
    """A dataset the nucleosome module cannot read."""


@dataclass(frozen=True)
class NucSource:
    browser_id: str
    label: str
    kind: str                       # 'native' | 'lifted'
    paths: Tuple[str, ...]          # real paths, in the dataset's file order (input_index)
    content_ids: Tuple[str, ...]
    chemistry: Optional[str]


def real(path) -> str:
    return os.path.realpath(os.path.expanduser(str(path)))


def nuc_source(state, dataset_id: str) -> NucSource:
    from utils.validation import is_url
    from services.scan.identity import content_id
    ds = (getattr(state, 'datasets', None) or {}).get(dataset_id)
    if ds is None:
        raise NucInputError(f'Dataset {dataset_id!r} is not loaded')
    label = getattr(ds, 'label', dataset_id)
    data_type = getattr(ds, 'data_type', None)
    if data_type == 'bam_livelift':
        if getattr(ds, 'live_lift', None) is None:
            raise NucInputError(f'{label}: its lift map is not open')
        kind = 'lifted'
    elif data_type == 'bam':
        kind = 'native'
    else:
        raise NucInputError(f'{label}: the nucleosome panel reads FiberHMM- or fibertools-called BAMs')
    paths = list(getattr(ds, 'paths', None) or [ds.path])
    if any(is_url(p) or str(p).startswith('ssh://') for p in paths):
        raise NucInputError(f'{label}: a remote BAM; the nucleosome panel reads local files')
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        raise NucInputError(f'{label}: file not found: {os.path.basename(missing[0])}')
    meta = getattr(ds, 'chemistry_metadata', None) or {}
    chemistry = getattr(ds, 'consensus_chemistry', None) if meta.get('source') == 'user-selection' else None
    return NucSource(dataset_id, label, kind, tuple(real(p) for p in paths),
                     tuple(content_id(p) for p in paths), chemistry)


def browser_read_policy(state, include_duplicates: bool = False, include_qcfail: bool = False,
                        hide_uncalled: Optional[bool] = None) -> dict:
    """The browser's read policy, resolved by FiberHMM (defaults filled), plus the browser's own
    ``filters['uncalled']`` ("Hide reads without footprint calls": 'exclude' by default, as the read track; the
    request's ``hide_uncalled`` when not given). FiberHMM's engines ignore that key; the browser's record loops
    apply it (``policy_passes`` / ``iter_policy_records``)."""
    from fiberhmm.scan.reads import resolve_read_policy
    from services.scan.planning import read_policy
    policy = resolve_read_policy(read_policy(state, include_duplicates=include_duplicates, include_qcfail=include_qcfail))
    if hide_uncalled is None:
        from services.signal_evidence import request_hide_uncalled
        hide_uncalled = request_hide_uncalled()
    policy['filters'] = {**policy['filters'], 'uncalled': 'exclude' if hide_uncalled else 'include'}
    return policy


def keeps_uncalled(read, filters) -> bool:
    """The browser's uncalled-read rule over a policy's filters (only 'exclude' filters)."""
    if (filters or {}).get('uncalled') != 'exclude':
        return True
    from services.bam_tags import read_has_footprint_calls
    return read_has_footprint_calls(read)


def policy_passes(read, filters) -> bool:
    """FiberHMM's read filters, then the browser's uncalled-read rule."""
    from fiberhmm.scan.reads import passes
    return passes(read, filters) and keeps_uncalled(read, filters)


def iter_policy_records(bam, chrom, start, end, filters):
    """FiberHMM's ``iter_records`` with the browser's uncalled-read rule on top."""
    from fiberhmm.scan.reads import iter_records
    for item in iter_records(bam, chrom, start, end, filters):
        if keeps_uncalled(item[0], filters):
            yield item


def reference_of(paths) -> Dict[str, int]:
    import pysam
    with pysam.AlignmentFile(paths[0], 'rb', check_sq=False) as bam:
        return {n: int(l) for n, l in zip(bam.references, bam.lengths)}


def datasets_using(state, path: str):
    """Browser dataset ids that read ``path`` (several can: the same BAM opened twice)."""
    want = real(path)
    out = []
    for ds_id, ds in (getattr(state, 'datasets', None) or {}).items():
        for p in getattr(ds, 'paths', None) or []:
            if isinstance(p, str) and '://' not in p and real(p) == want:
                out.append(ds_id)
                break
    return out
