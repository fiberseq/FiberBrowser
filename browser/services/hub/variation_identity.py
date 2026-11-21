"""D12 identities. Exact allele identities and geometry identities never claim equivalence."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

KINDS = {'substitution': 'replacement', 'aligned_bubble': 'complex', 'no_correspondence': 'unresolved',
         'I': 'insertion', 'D': 'deletion', 'ins': 'insertion', 'del': 'deletion'}


def reference_sha8(state):
    path = getattr(state, 'fasta_path', None)
    if path and Path(path).is_file():
        stat = Path(path).stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        old = getattr(state, '_hub_reference_hash', None)
        if old and old[0] == key:
            return old[1]
        digest = hashlib.sha256()
        with open(path, 'rb') as handle:
            for block in iter(lambda: handle.read(1 << 20), b''):
                digest.update(block)
        sha = digest.hexdigest()[:8]
        state._hub_reference_hash = (key, sha)
        return sha
    # Without sequence, this namespace is explicitly index/geometry only.
    contigs = sorted((getattr(c, 'name', ''), getattr(c, 'size', 0)) for c in getattr(state, 'chroms', []))
    return hashlib.sha256(json.dumps(['reference-index', contigs]).encode()).hexdigest()[:8]


def variation_id(reference, chrom, start, end, kind, *, allele_id=None, geometry=None):
    kind = KINDS.get(kind, kind)
    if kind not in ('snv', 'mnv', 'insertion', 'deletion', 'replacement', 'inversion', 'complex', 'unresolved'):
        kind = 'unresolved'
    token = ('allele-' + hashlib.sha256(str(allele_id).encode()).hexdigest()[:24] if allele_id else
             'geometry-' + hashlib.sha256(json.dumps(geometry or {}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:24])
    return f'var:{reference[:8]}:{chrom}:{start}-{end}:{kind}:{token}'


def normalize_hit(state, hit):
    if not (hit.get('typeId', '').startswith('var.') or hit.get('typeId') == 'graph.bubble'):
        return hit
    h = dict(hit)
    detail = dict(h.get('detail') or {})
    old = h['hitId']
    kind = KINDS.get(detail.get('kind'), detail.get('kind')) or ('complex' if h['typeId'] == 'graph.bubble' else 'unresolved')
    exact = detail.get('alleleId')
    if old.startswith('var:'):
        return h
    geometry = detail.get('geometry')
    if geometry is None:
        lengths = sorted({int(a['bp']) for a in detail.get('alleles') or [] if a.get('bp') is not None})
        if not lengths:
            lengths = [int(detail.get('alt_bp', 0 if kind == 'deletion' else detail.get('length', h['end'] - h['start'])))]
        geometry = dict(ref_bp=h['end'] - h['start'], alt_bp=lengths)
    h['hitId'] = variation_id(reference_sha8(state), h['chrom'], h['start'], h['end'], kind, allele_id=exact,
                              geometry=geometry)
    h['idAliases'] = list(dict.fromkeys([old, *(h.get('idAliases') or []), *(detail.get('aliases') or [])]))
    h['detail'] = dict(detail, identity='exact' if exact else 'geometry', kind=kind)
    return h
