"""Inputs of a hub association run (DESIGN §7.10), gathered in the browser's frame for ``fiberhmm.assoc``.

Sources:

- **scan sets** (``hub:<16 hex>``): hits from the scan's hits table (a source-frame scan's hits lifted onto this genome,
  G1), per-molecule states from ``states.tsv.bgz`` (tables mode) or the annotated BAMs' MA state group (through
  ``services.scan.states``), marks from ``nuc/marks.tsv.bgz`` and molecule scalars from ``<module>/molecules``;
- **browser sets** sent by the hub (inline hits: SVs, peak rules, Differences, Find classes); ``var.sv`` hits get
  per-molecule carriage from the SV split (``sv_endpoint.sv_split_payload``: carrier 1, reference 0, not
  informative left out);
- **anchor sets** saved in the hub (positions, for M2 and M4);
- **loaded datasets**: decoded molecules (M2 phasing), haplotype tags.

Molecules. Every state, mark and scalar is keyed by its **browser dataset** (a scan dataset is translated through its
binding; an unbound one keeps ``scan:<scan id>:<dataset id>``) and its physical molecule (``mol:v1``: the scan's own
``molecule`` column, else ``fiberhmm.scan.identity.molecule_id`` of the read name). One token in two datasets is
two molecules (HUB §3.4). A molecule with no state row for a hit has no state there: nothing here ever writes a 0
that the scan or the SV split did not report, so a molecule on a path that lacks a hit's sequence ("absent", G1) is
left out, never counted as unbound.

Frames. Distances (M1 pairing, M4) are measured on this genome: a lifted hit (G1) uses its placement; a hit inside an
insertion (no placement, only a junction) is left out of M4 and counted, and pairs at its junction in M1 (flagged).
"""
from __future__ import annotations

import json
import math
import os
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

STATE_PAD = 2_000
MAX_HITS_PER_SET = 20_000
HAP_FETCH_PAD = 5_000


class AssocInputError(ValueError):
    """A request the data can't serve; the message is shown as is."""


# ------------------------------------------------------------------ scope
def merge_regions(regions: Iterable[Tuple[str, int, int]]) -> List[Tuple[str, int, int]]:
    by: Dict[str, List[List[int]]] = {}
    for c, a, b in sorted((str(c), int(a), int(b)) for c, a, b in regions if int(b) > int(a)):
        cur = by.setdefault(c, [])
        if cur and a <= cur[-1][1]:
            cur[-1][1] = max(cur[-1][1], b)
        else:
            cur.append([a, b])
    return [(c, a, b) for c, ivs in by.items() for a, b in ivs]


def canon_chrom(state, name: str) -> str:
    """A contig in the browser reference's naming (chr1 / 1 aliases), else as given."""
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(str(name))
    for c in getattr(state, 'chroms', None) or ():
        if str(c.name) == str(name):
            return str(name)
    for c in getattr(state, 'chroms', None) or ():
        if normalize_chrom_name(str(c.name)) == want:
            return str(c.name)
    return str(name)


def canon_regions(state, regions):
    return None if regions is None else merge_regions((canon_chrom(state, c), a, b) for c, a, b in regions)


def scan_regions(scan, rel: str, regions):
    """Windows in a scan table's own contig naming (FiberHMM's readers match names exactly)."""
    if regions is None:
        return None
    t = scan.tables.table(rel)
    if t is None:
        return list(regions)
    out = []
    for c, a, b in regions:
        name = t.contig(c)
        if name is not None:
            out.append((name, a, b))
    return out


def read_bed(path: str, limit: int = 200_000) -> List[Tuple[str, int, int]]:
    out = []
    with open(path) as fh:
        for line in fh:
            if not line.strip() or line.startswith(('#', 'track', 'browser')):
                continue
            parts = line.split()
            if len(parts) < 3:
                continue
            try:
                out.append((parts[0], int(parts[1]), int(parts[2])))
            except ValueError:
                continue
            if len(out) >= limit:
                break
    return out


def scope_regions(scope: dict) -> Optional[List[Tuple[str, int, int]]]:
    """The analysis windows: the view, a BED's intervals, anchors ± flank, or None (a scan's whole territory)."""
    kind = str(scope.get('kind') or 'view')
    if kind == 'view':
        chrom, s, e = str(scope.get('chrom') or ''), int(scope.get('start') or 0), int(scope.get('end') or 0)
        if not chrom or e <= s:
            raise AssocInputError('The view has no region')
        return [(chrom, s, e)]
    if kind == 'bed':
        path = str(scope.get('bed') or '')
        if not path or not os.path.isfile(os.path.expanduser(path)):
            raise AssocInputError(f'No BED file at {path or "(none given)"}')
        regions = merge_regions(read_bed(os.path.expanduser(path)))
        if not regions:
            raise AssocInputError('The BED file has no intervals')
        return regions
    if kind == 'anchors':
        flank = max(0, int(scope.get('flank') or 1000))
        pts = scope.get('anchors') or []
        regions = merge_regions((str(p[0]), max(0, int(p[1]) - flank), int(p[1]) + flank + 1) for p in pts if len(p) >= 2)
        if not regions:
            raise AssocInputError('The anchor set is empty')
        return regions
    if kind == 'scan':
        return None
    raise AssocInputError(f'Unknown scope {kind!r}')


def _inside(regions, chrom: str, start: int, end: int) -> bool:
    if regions is None:
        return True
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(chrom)
    for c, a, b in regions:
        if normalize_chrom_name(c) != want:
            continue
        if end <= start:
            if a <= start < b:
                return True
        elif start < b and a < end:
            return True
    return False


# ------------------------------------------------------------------ molecules
class Molecules:
    """Physical molecules of an analysis: (browser dataset, mol:v1) -> index, with read names, haplotype and channel."""

    def __init__(self):
        self.index: Dict[Tuple[str, str], int] = {}
        self.dataset: List[str] = []
        self.token: List[str] = []
        self.qnames: List[set] = []
        self.hap: Dict[int, set] = {}
        self.channel: Dict[int, str] = {}

    def add(self, dataset: str, token: str, qname: str = '') -> int:
        key = (dataset, token)
        i = self.index.get(key)
        if i is None:
            i = self.index[key] = len(self.dataset)
            self.dataset.append(dataset)
            self.token.append(token)
            self.qnames.append(set())
        if qname:
            self.qnames[i].add(qname)
        return i

    def get(self, dataset: str, token: str) -> Optional[int]:
        return self.index.get((dataset, token))

    @property
    def n(self) -> int:
        return len(self.dataset)

    def ids(self) -> np.ndarray:
        out = np.empty(self.n, dtype=object)
        for (ds, tok), i in self.index.items():
            out[i] = f'{ds}|{tok}'
        return out

    def note_hap(self, i: int, hap) -> None:
        self.hap.setdefault(i, set()).add(hap)

    def hap_of(self, i: int):
        """A molecule's haplotype label, or None (unphased: no label, or records that disagree; D14)."""
        seen = self.hap.get(i, set())
        if not seen or any(h in (None, '', 0, '0') for h in seen) or len(seen) != 1:
            return None
        return next(iter(seen))


def molecule_token(qname: str, scan_token: str = '') -> str:
    if scan_token:
        return scan_token
    from fiberhmm.scan.identity import molecule_id
    return molecule_id([qname]) or f'name:{qname}'


def qname_of_key(key: str) -> str:
    """A states key's read name: the name itself (native), or a record key's name (``lift-record:v1 [...]``)."""
    s = str(key)
    for prefix in ('lift-record:v1 ', 'lift-cohort:v1 '):
        if s.startswith(prefix):
            try:
                parts = json.loads(s[len(prefix):])
            except ValueError:
                return s
            if isinstance(parts, list) and len(parts) >= 2 and isinstance(parts[1], str):
                return parts[1]
    return s


# ------------------------------------------------------------------ hits
@dataclass
class HitTable:
    """One feature set's hits in the analysis frame and (when it has states) its per-molecule state rows."""
    type_id: str
    label: str
    hits: List[dict] = field(default_factory=list)
    rows: List[Tuple[int, int, int]] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)
    has_states: bool = False
    footprint_like: bool = False
    territory: Optional[List[Tuple[str, int, int]]] = None
    territory_note: str = ''
    scan: object = None
    module: str = ''

    def bump(self, key: str, n: int = 1) -> None:
        self.counts[key] = self.counts.get(key, 0) + n

    def feature_states(self):
        from fiberhmm.assoc.cooccur import FeatureStates
        h = self.hits
        rows = self.rows or [(0, 0, 0)][:0]
        return FeatureStates(self.type_id, [x['hitId'] for x in h], [x['chrom'] for x in h], [x['start'] for x in h],
                             [x['end'] for x in h], [x['anchor'] for x in h],
                             [r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows],
                             footprint_like=self.footprint_like)

    def hitset(self, hits: Optional[List[dict]] = None):
        from fiberhmm.assoc.overlap import HitSet
        h = self.hits if hits is None else hits
        return HitSet(np.array([x['chrom'] for x in h], dtype=str), np.array([x['start'] for x in h], np.int64),
                      np.array([max(x['start'], x['end']) for x in h], np.int64),
                      np.array([x.get('strand') or '.' for x in h], dtype=str),
                      np.array([x['hitId'] for x in h], dtype=object))

    def summary(self) -> dict:
        return dict(type=self.type_id, label=self.label, hits=len(self.hits), stateRows=len(self.rows),
                    counts=dict(self.counts), notes=list(self.notes), hasStates=self.has_states,
                    territoryNote=self.territory_note or None)


def _analysis_place(h: dict) -> Optional[dict]:
    """A hit's place on this genome: itself (linear), its lifted placement, or its insertion junction (flagged)."""
    if h.get('frame', {}).get('kind') != 'source' and not h.get('lift'):
        return dict(chrom=h['chrom'], start=int(h['start']), end=int(h['end']), anchor=int(h['anchor']), insertion=False)
    t = h.get('target')
    if not t:
        return None
    return dict(chrom=t['chrom'], start=int(t['start']), end=int(t['end']), anchor=int(t.get('anchor', t['start'])),
                insertion=bool(t.get('insertion')))


def resolve_scan_set(state, set_id: str):
    from services.scan.registry import ensure_bound, find_set
    ensure_bound(state)
    found = find_set(state, set_id)
    if found is None:
        raise AssocInputError('The scan of this feature set is not open in this session: open it in the Feature hub')
    return found


def _whole_scan_regions(scan) -> List[Tuple[str, int, int]]:
    lengths = {str(c): int(n) for c, n in (scan.manifest.get('reference') or {}).get('contigs') or []}
    contigs = []
    t = scan.tables.table('units.tsv.bgz')
    if t is not None:
        for u in t.rows():
            if u.get('status') == 'done' and u['chrom'] not in contigs:
                contigs.append(u['chrom'])
    return [(c, 0, lengths.get(c, 1 << 31)) for c in contigs]


def scan_set_hits(state, set_id: str, regions, *, label: str = '') -> HitTable:
    """A scan set's hits in the analysis windows (``regions``; None = every done unit of the scan)."""
    from services.scan.serve import hits_for_view
    scan, module, type_id = resolve_scan_set(state, set_id)
    decl = scan.type_decl(module, type_id) or {}
    table = HitTable(type_id, label or decl.get('plural') or type_id, scan=scan, module=module,
                     has_states='state' in (decl.get('provides') or []), footprint_like=module in ('fp', 'nuc'))
    source = (scan.frame or {}).get('kind') == 'source'
    if source and regions is None:
        raise AssocInputError(f'{table.label}: an assembly scan (another reference) is placed on this genome per '
                              'view; choose the view, a BED or an anchor set as the scope')
    windows = regions if regions is not None else _whole_scan_regions(scan)
    seen = set()
    for chrom, s, e in windows:
        if source:
            from services.scan.projection import source_hits_for_view
            res = source_hits_for_view(state, scan, module, chrom, s, e, type_id=type_id, limit=MAX_HITS_PER_SET)
            if res.get('note'):
                table.notes.append(res['note'])
        else:
            res = hits_for_view(scan, module, chrom, s, e, type_id=type_id, limit=MAX_HITS_PER_SET)
        if res.get('truncated'):
            table.notes.append(f'more than {MAX_HITS_PER_SET:,} hits in {chrom}:{s:,}-{e:,}: the first ones were used')
        for h in res['hits']:
            if h['hitId'] in seen:
                continue
            seen.add(h['hitId'])
            place = _analysis_place(h)
            if place is None:
                table.bump('unplaced')
                continue
            if place['insertion']:
                table.bump('in_insertion')
            hit = dict(hitId=h['hitId'], chrom=canon_chrom(state, place['chrom']), start=place['start'], end=place['end'],
                       anchor=place['anchor'], strand=h.get('targetStrand') or h.get('strand'), label=h.get('label') or '',
                       insertion=place['insertion'], columns=h.get('columns') or {},
                       src=dict(chrom=h['chrom'], start=int(h['start']), end=int(h['end'])),
                       hap=(h.get('frame') or {}).get('hapLabel') or (h.get('frame') or {}).get('hap'),
                       lift=(h.get('lift') or {}).get('status'))
            table.hits.append(hit)
    if table.counts.get('unplaced'):
        table.notes.append(f"{table.counts['unplaced']} hits have no place on this genome (unmapped): left out")
    return table


def _bindings(scan, datasets: Optional[Sequence[str]]):
    """scan dataset id -> [browser dataset id] of the bound datasets. Unbound scan datasets ("scan of other files")
    take no part in per-molecule analyses: their molecules' covariates and labels aren't joined to anything."""
    out: Dict[str, List[str]] = {}
    for sid, bid, _via, _files in scan.bound_pairs():
        if datasets and bid not in datasets:
            continue
        out.setdefault(sid, [])
        if bid not in out[sid]:
            out[sid].append(bid)
    return out


def scan_set_states(state, table: HitTable, set_id: str, mols: Molecules, datasets: Optional[Sequence[str]] = None) -> None:
    """Per-molecule states of a scan set's hits (rows appended to ``table``)."""
    scan, module = table.scan, table.module
    if not table.has_states:
        raise AssocInputError(f'{table.label} have no per-molecule states')
    binds = _bindings(scan, datasets)
    if not binds:
        raise AssocInputError(f'{table.label}: no loaded dataset is bound to its scan, so it has no molecules here')
    rel = f'{module}/states.tsv.bgz'
    if scan.tables.has(rel):
        for i, h in enumerate(table.hits):
            src = h['src']
            rows = [r for r in scan.tables.fetch(rel, src['chrom'], max(0, src['start'] - STATE_PAD),
                                                 max(src['end'], src['start'] + 1) + STATE_PAD)
                    if r.get('hit_id') == h['hitId']]
            for r in rows:
                st = str(r.get('state'))
                if st not in ('1', '0'):
                    table.bump('not_evaluated')
                    continue
                for bid in binds.get(r.get('dataset_id'), ()):
                    m = mols.add(bid, molecule_token(r.get('qname', ''), r.get('molecule') or ''), r.get('qname', ''))
                    table.rows.append((i, m, 1 if st == '1' else 0))
                    if r.get('channel'):
                        mols.channel[m] = str(r['channel'])
                    if h.get('hap'):
                        mols.note_hap(m, h['hap'])
        return
    # Annotated scans: the MA state group on the annotated BAMs, read per hit (services.scan.states).
    from services.scan.states import hub_feature_states
    allowed = {b for bs in binds.values() for b in bs}
    for i, h in enumerate(table.hits):
        try:
            states, _ds, _label, _span = hub_feature_states(state, set_id, dict(id=h['hitId'], dataset_id=None))
        except ValueError as error:
            table.notes.append(str(error))
            continue
        for (bid, key), st in states.items():
            if bid not in allowed:
                continue
            if st not in ('1', '0'):
                table.bump('not_evaluated')
                continue
            q = qname_of_key(key)
            m = mols.add(bid, molecule_token(q), q)
            table.rows.append((i, m, 1 if st == '1' else 0))
            if h.get('hap'):
                mols.note_hap(m, h['hap'])


def inline_hits(ref: dict, regions, *, label: str = '') -> HitTable:
    """A browser set's hits sent by the hub (this genome's coordinates; a lifted hit's placement)."""
    table = HitTable(str(ref.get('typeId') or ''), label or str(ref.get('label') or ref.get('typeId') or 'hits'))
    for h in ref.get('hits') or []:
        try:
            target = h.get('target')
            if (h.get('frame') or {}).get('kind') == 'source':
                if not target:
                    table.bump('unplaced')
                    continue
                chrom, s, e = str(target['chrom']), int(target['start']), int(target['end'])
                anchor = int(target.get('anchor', s))
                insertion = bool(target.get('insertion'))
            else:
                chrom, s, e = str(h['chrom']), int(h['start']), int(h['end'])
                anchor = int(h.get('anchor', s))
                insertion = False
        except (KeyError, TypeError, ValueError):
            table.bump('malformed')
            continue
        if not _inside(regions, chrom, s, max(e, s)):
            table.bump('outside_scope')
            continue
        if insertion:
            table.bump('in_insertion')
        table.hits.append(dict(hitId=str(h.get('hitId') or f'{chrom}:{s}-{e}'), chrom=chrom, start=s, end=max(s, e),
                               anchor=anchor, strand=h.get('strand') if h.get('strand') in ('+', '-') else None,
                               label=str(h.get('label') or ''), insertion=insertion, columns=h.get('values') or {},
                               src=dict(chrom=chrom, start=s, end=max(s, e)), legacyRefs=h.get('legacyRefs') or [],
                               detail=h.get('detail') or {}, hubHit=h.get('hubHit')))
    if table.counts.get('unplaced'):
        table.notes.append(f"{table.counts['unplaced']} hits have no place on this genome: left out")
    # Where the browser computed the set (the view it was in): its absence means absence only there.
    cov = [(str(c[0]), int(c[1]), int(c[2])) for c in ref.get('coverage') or [] if isinstance(c, (list, tuple)) and len(c) >= 3]
    if cov:
        cov = merge_regions(cov)
        table.territory = cov if regions is None else _intersect_regions(cov, regions)
        table.territory_note = 'where the browser computed the set (the view it was listed in)'
    return table


def _intersect_regions(a, b):
    from utils.chrom import normalize_chrom_name
    out = []
    for c1, s1, e1 in a:
        for c2, s2, e2 in b:
            if normalize_chrom_name(c1) == normalize_chrom_name(c2) and min(e1, e2) > max(s1, s2):
                out.append((c1, max(s1, s2), min(e1, e2)))
    return merge_regions(out)


def anchor_hits(ref: dict, regions) -> HitTable:
    table = HitTable('anchors', str(ref.get('label') or 'Anchors'))
    for i, p in enumerate(ref.get('anchors') or []):
        try:
            chrom, pos = str(p['chrom']), int(p['pos'])
        except (KeyError, TypeError, ValueError):
            table.bump('malformed')
            continue
        if p.get('frame') and not p.get('source') and (p.get('frame') or {}).get('kind') == 'source':
            table.bump('unplaced')
            continue
        s = int(p.get('start', pos)) if p.get('start') is not None else pos
        e = int(p.get('end', pos + 1)) if p.get('end') is not None else pos + 1
        if not _inside(regions, chrom, s, max(e, s + 1)):
            table.bump('outside_scope')
            continue
        table.hits.append(dict(hitId=str(p.get('hitId') or f'anchor:{chrom}:{pos}:{i}'), chrom=chrom, start=s, end=max(s, e),
                               anchor=pos, strand=p.get('strand') if p.get('strand') in ('+', '-') else None,
                               label=str(p.get('label') or ''), insertion=bool(p.get('insertion')), columns={},
                               src=dict(chrom=chrom, start=s, end=max(s, e))))
    return table


# ------------------------------------------------------------------ SV carriage (var.sv states)
def _sv_of(hit: dict):
    parts = str(hit['hitId']).split(':')
    if len(parts) >= 5 and parts[0] == 'sv' and parts[-3] in ('I', 'D'):
        try:
            return parts[-3], int(parts[-2]), int(parts[-1])
        except ValueError:
            return None
    return None


def sv_states(state, table: HitTable, mols: Molecules, datasets: Sequence[str], *, include_duplicates: bool = False) -> None:
    """Carriage of each SV hit in each dataset's reads (the SV split: carrier 1, reference 0, not informative left
    out). The classification window is the SV ± 10 kb (reads must span the SV's flanks to be informative)."""
    from services.sv_endpoint import sv_split_payload
    table.has_states = True
    for i, h in enumerate(table.hits):
        sv = _sv_of(h)
        if sv is None:
            table.bump('not_an_sv')
            continue
        t, ref, length = sv
        refs = [r for r in h.get('legacyRefs') or [] if isinstance(r, dict)]
        hit_datasets = [r.get('datasetId') for r in refs if r.get('datasetId')] or list(datasets)
        for ds in hit_datasets:
            if datasets and ds not in datasets:
                continue
            end = ref + (length if t == 'D' else 0)
            try:
                payload = sv_split_payload(state, dataset_id=ds, chrom=h['chrom'], start=max(0, ref - 10_000),
                                           end=end + 10_000, t=t, ref=ref, length=length,
                                           include_duplicates=include_duplicates)
            except Exception as error:   # noqa: BLE001 - one dataset's failure is reported, the rest continue
                table.notes.append(f'{ds}: {error}')
                continue
            for qname, allele in (payload.get('assignments') or {}).items():
                if allele == 2:
                    table.bump('not_informative')
                    continue
                m = mols.add(ds, molecule_token(qname), qname)
                table.rows.append((i, m, 1 if allele == 0 else 0))


# ------------------------------------------------------------------ molecule covariates, haplotypes, labels
def _scans_for(state, datasets: Iterable[str]):
    """Open table-mode scans bound to any of ``datasets``: (scan, {scan dataset id: [browser ids]})."""
    from services.scan.registry import list_scans
    want = set(datasets)
    for scan in list_scans(state):
        binds = {}
        for sid, bid, _via, _files in scan.bound_pairs():
            if bid in want:
                binds.setdefault(sid, []).append(bid)
        if binds:
            yield scan, binds


def molecule_scalars(state, mols: Molecules, module: str, columns: Sequence[str], regions,
                     source_windows: Optional[Sequence[Tuple[str, int, int]]] = None) -> Dict[str, np.ndarray]:
    """Per-molecule scalars (median over a molecule's records) from every open scan's ``<module>/molecules`` table;
    NaN where none has the molecule. An assembly (source-frame) scan's tables are in its own coordinates: they are
    read over ``source_windows`` (the analysed hits' source spans), never over this genome's windows."""
    out = {c: np.full(mols.n, np.nan) for c in columns}
    acc: Dict[Tuple[str, int], List[float]] = {}
    rel = f'{module}/molecules.tsv.bgz'
    for scan, binds in _scans_for(state, set(mols.dataset)):
        if not scan.tables.has(rel):
            continue
        if (scan.frame or {}).get('kind') == 'source':
            windows = list(source_windows or [])
        else:
            windows = regions if regions is not None else _whole_scan_regions(scan)
        seen = set()
        for chrom, s, e in windows:
            for r in scan.tables.fetch(rel, chrom, s, e):
                key = (r.get('dataset_id'), r.get('record'), r.get('input_index'))
                if key in seen:
                    continue
                seen.add(key)
                for bid in binds.get(r.get('dataset_id'), ()):
                    i = mols.get(bid, molecule_token(r.get('qname', ''), r.get('molecule') or ''))
                    if i is None:
                        continue
                    for c in columns:
                        v = r.get(c, '')
                        if v not in ('', None):
                            try:
                                acc.setdefault((c, i), []).append(float(v))
                            except ValueError:
                                pass
    for (c, i), vals in acc.items():
        out[c][i] = float(np.median(vals))
    return out


def source_windows_of(*tables: 'HitTable', pad: int = 5_000) -> List[Tuple[str, int, int]]:
    """The source-coordinate spans (± pad) of assembly-scan hits (their molecules' covariates are read there)."""
    return merge_regions((h['src']['chrom'], max(0, h['src']['start'] - pad), h['src']['end'] + pad)
                         for t in tables if t.scan is not None and (t.scan.frame or {}).get('kind') == 'source'
                         for h in t.hits)


def native_haplotypes(state, mols: Molecules, regions, tag: str = 'HP') -> int:
    """HP tags of native datasets' molecules, read from their BAMs over the analysis windows (records that disagree,
    or have no tag, leave the molecule unphased). Returns the number of molecules given a haplotype."""
    import pysam
    by_ds: Dict[str, Dict[str, List[int]]] = {}
    for i, ds in enumerate(mols.dataset):
        d = (getattr(state, 'datasets', None) or {}).get(ds)
        if d is None or getattr(d, 'data_type', None) == 'bam_livelift':
            continue
        for q in mols.qnames[i]:
            by_ds.setdefault(ds, {}).setdefault(q, []).append(i)
    phased = 0
    for ds, wanted in by_ds.items():
        d = state.datasets[ds]
        paths = [p for p in (getattr(d, 'paths', None) or [getattr(d, 'path', None)]) if p and os.path.isfile(str(p))]
        windows = merge_regions((c, max(0, a - HAP_FETCH_PAD), b + HAP_FETCH_PAD) for c, a, b in (regions or []))
        for path in paths:
            with pysam.AlignmentFile(str(path), 'rb') as bam:
                from services.nuc.live import bam_chrom
                its = []
                if windows:
                    for c, a, b in windows:
                        name = bam_chrom(bam.references, c)
                        if name is not None:
                            its.append(bam.fetch(name, a, b))
                else:
                    its.append(bam.fetch(until_eof=True))
                for it in its:
                    for r in it:
                        for i in wanted.get(r.query_name, ()):
                            v = r.get_tag(tag) if r.has_tag(tag) else None
                            mols.note_hap(i, f'HP{v}' if v not in (None, 0, '0') else None)
    for i in range(mols.n):
        if mols.hap_of(i) is not None:
            phased += 1
    return phased


def cluster_labels(mols: Molecules, labels: dict) -> np.ndarray:
    """Per-molecule cluster labels from the hub's request ({dataset: {read id: label}}); a molecule whose reads carry
    different labels gets none."""
    out = np.empty(mols.n, dtype=object)
    found: Dict[int, set] = {}
    for ds, by_read in (labels or {}).items():
        if not isinstance(by_read, dict):
            continue
        for read_id, lab in by_read.items():
            q = qname_of_key(read_id)
            i = mols.get(str(ds), molecule_token(q))
            if i is not None and lab not in (None, ''):
                found.setdefault(i, set()).add(str(lab))
    for i in range(mols.n):
        v = found.get(i, set())
        out[i] = next(iter(v)) if len(v) == 1 else None
    return out


def display_names(state, ids) -> Dict[str, str]:
    """Dataset id -> its label for display; labels two datasets share get the id added (groups are keyed by id)."""
    labels = {ds_id: getattr(ds, 'label', ds_id) for ds_id, ds in (getattr(state, 'datasets', None) or {}).items()}
    out = {i: labels.get(i, i) for i in ids}
    counts = Counter(out.values())
    return {i: (f'{v} ({i})' if counts[v] > 1 else v) for i, v in out.items()}


def group_values(state, mols: Molecules, group: Optional[dict], regions) -> Tuple[Optional[np.ndarray], str, dict]:
    """(labels per molecule, group_kind, info) for the request's group, or (None, 'label', {})."""
    if not group or not group.get('kind') or group.get('kind') == 'none':
        return None, 'label', {}
    kind = group['kind']
    if kind == 'dataset':
        # keyed by dataset id (labels need not be unique); `names` shows them
        return (np.array(list(mols.dataset), dtype=object), 'label',
                dict(kind='dataset', names=display_names(state, sorted(set(mols.dataset)))))
    if kind == 'haplotype':
        phased = native_haplotypes(state, mols, regions)
        vals = np.array([mols.hap_of(i) for i in range(mols.n)], dtype=object)
        return vals, 'haplotype', dict(kind='haplotype', phased=int(sum(v is not None for v in vals)),
                                       unphased=int(sum(v is None for v in vals)), fromTags=phased)
    if kind == 'cluster':
        vals = cluster_labels(mols, group.get('labels') or {})
        return vals, 'label', dict(kind='cluster', labelled=int(sum(v is not None for v in vals)))
    raise AssocInputError(f'Unknown group {kind!r}')


def molecule_table(state, mols: Molecules, regions, *, density: str = 'rho_read', labels: Optional[Dict[str, np.ndarray]] = None,
                   source_windows: Optional[Sequence[Tuple[str, int, int]]] = None):
    """``fiberhmm.assoc.MoleculeTable`` with openness (nfr scans), mark density (nuc scans) and channel where the open
    scans have them; ``None`` where none does (said in ``info``)."""
    from fiberhmm.assoc.cooccur import MoleculeTable
    op = molecule_scalars(state, mols, 'nfr', ['openness'], regions, source_windows)['openness']
    dens = molecule_scalars(state, mols, 'nuc', [density], regions, source_windows)[density]
    ch = np.array([mols.channel.get(i, 'pooled') for i in range(mols.n)], dtype=object) if mols.channel else None
    info = dict(openness=int(np.isfinite(op).sum()), density=int(np.isfinite(dens).sum()), densityName=density,
                channel=bool(mols.channel), molecules=mols.n)
    return MoleculeTable(mols.ids(), channel=ch, openness=op if np.isfinite(op).any() else None,
                         density=dens if np.isfinite(dens).any() else None, labels=dict(labels or {})), info


# ------------------------------------------------------------------ territory (M4)
def scan_territory(state, table: HitTable, regions, datasets: Optional[Sequence[str]] = None) -> Tuple[List[Tuple[str, int, int]], str]:
    """Where a set's absence means absence: callable runs within done zones, lifted for assembly scans and clipped
    to the analysis windows. A browser set covers only its windows."""
    scan = table.scan
    if scan is not None:
        from fiberhmm.assoc.scanio import territory
        from fiberhmm.scan.reader import ScanDir
        if (scan.frame or {}).get('kind') == 'source':
            from services.scan.projection import lifted_datasets
            from services.scan.lift import LiftUnavailable, lift_intervals
            # Read callable runs in their own frame, including the done-unit restriction. Clip only after lifting.
            source = territory(ScanDir(scan.path), datasets=datasets or None)
            lifted = []
            ids = lifted_datasets(state, scan)
            if not ids:
                raise AssocInputError(f'{table.label}: no live-lift dataset is loaded to lift its callable territory')
            for did in ids:
                config = state.datasets[did].live_lift
                if getattr(config.handle, 'plain_chain', False):
                    raise AssocInputError('Callable territory requires a graphlift sidecar for liftbed')
                try:
                    # No bridging target gaps: a target insertion is not callable source sequence. Keep all splits.
                    parts = lift_intervals(config.handle.path, source, split_gap=0)
                except LiftUnavailable as error:
                    raise AssocInputError(str(error)) from error
                lifted.extend((canon_chrom(state, c), a, b) for part in parts for c, a, b in (part.parts or []) if b > a)
            merged = merge_regions(lifted)
            return (merged if regions is None else _intersect_regions(merged, regions),
                    'callable runs within done units lifted onto this genome with liftbed (all mapped pieces)')
        here = scan_regions(scan, 'callable.tsv.bgz', regions)
        if here is not None and not here:
            return [], 'the scope\'s contigs aren\'t in the scan: no territory'
        terr = territory(ScanDir(scan.path), datasets=datasets or None, regions=here)
        return ([(canon_chrom(state, c), int(a), int(b)) for c, a, b in terr],
                'callable runs of every scanned dataset within done units')
    if regions is None:
        raise AssocInputError(f'{table.label}: a browser set covers only what is in view; choose the view, a BED or an anchor set')
    return list(regions), 'the windows (a browser set is computed for what is in view)'


def intersect(*territories) -> List[Tuple[str, int, int]]:
    from fiberhmm.assoc.overlap import intersect_territories
    return [(str(c), int(a), int(b)) for c, a, b in intersect_territories(*territories)]


# ------------------------------------------------------------------ marks (M3)
NUC_MARK_TYPES = ('nuc.seg.regular', 'nuc.seg.disordered', 'nuc.seg.low_information', 'nuc.seg.undetermined',
                  'nuc.event.undersized', 'nuc.event.missing')


def nuc_scans(state, datasets: Optional[Sequence[str]] = None):
    """Open scans with a ``nuc/marks`` table, bound (to ``datasets`` when given)."""
    from services.scan.registry import ensure_bound, list_scans
    ensure_bound(state)
    out = []
    for scan in list_scans(state):
        if not scan.tables.has('nuc/marks.tsv.bgz') or (scan.frame or {}).get('kind') == 'source':
            continue
        binds = _bindings(scan, datasets)
        if any(not b.startswith('scan:') for bs in binds.values() for b in bs):
            out.append((scan, binds))
    return out


class _DatasetMappedScan:
    """A scan reader whose dataset labels refer to the A scan's bound inputs."""
    def __init__(self, scan, mapping):
        self.scan, self.mapping, self.manifest = scan, mapping, scan.manifest

    def has(self, rel):
        return self.scan.has(rel)

    def table(self, rel):
        table, mapping = self.scan.table(rel), self.mapping
        class Table:
            def translate(self, rows):
                for row in rows:
                    if 'dataset_id' not in row:
                        yield row
                    else:
                        for dataset in mapping.get(row['dataset_id'], ()):
                            yield dict(row, dataset_id=dataset)

            def rows(self):
                return self.translate(table.rows())

            def fetch(self, chrom, start, end):
                return self.translate(table.fetch(chrom, start, end))
        return Table()


def rate_data(state, a_type: str, b_kind: str, regions, datasets: Optional[Sequence[str]] = None, *, b_ref=None):
    """``RateData`` for M3 from every bound nuc scan's marks (the first scan holding a molecule keeps it), with
    datasets translated to browser datasets. ``b_kind``: 'tf' (TF footprint centres from the nuc calls) or a state type
    in the same scan."""
    from fiberhmm.assoc.rate import RateData
    from fiberhmm.assoc import scanio as S
    from fiberhmm.scan.reader import ScanDir
    if a_type not in NUC_MARK_TYPES:
        raise AssocInputError(f'A must be a nucleosome mark type ({", ".join(NUC_MARK_TYPES)})')
    scans = nuc_scans(state, datasets)
    if not scans:
        raise AssocInputError('M3 needs a nucleosome scan in table mode (nuc/marks) of a loaded dataset: run Scan… '
                              'with the nuc module, or open such a scan')
    b_source = None
    if b_ref and b_ref.get('kind') == 'scan':
        b_source, _module, resolved_type = resolve_scan_set(state, str(b_ref.get('setId') or ''))
        if resolved_type != b_kind or (b_source.frame or {}).get('kind') == 'source':
            raise AssocInputError('B must be a state set in the same coordinate frame as A')
    # One nucleosome scan per dataset: two scans of one dataset (two caches, or a cache and an opened scan) would each
    # hold part of a molecule's geometry, and merging compressed coordinates isn't possible here.
    owner: Dict[str, str] = {}
    for scan, binds in scans:
        for bs in binds.values():
            for b in bs:
                if b.startswith('scan:'):
                    continue
                if b in owner and owner[b] != scan.scan_id:
                    raise AssocInputError(f'Several open nucleosome scans hold {getattr(state.datasets.get(b), "label", b)}: '
                                          'close all but one in the Feature hub, so each molecule is read from one scan')
                owner[b] = scan.scan_id
    parts, used = [], []
    mols = Molecules()
    for scan, binds in scans:
        here = scan_regions(scan, 'nuc/marks.tsv.bgz', regions)
        if here is not None and not here:
            continue            # the scope's contigs aren't in this scan (an empty list would mean "everything")
        try:
            kwargs = {}
            if b_source is not None:
                b_binds = _bindings(b_source, datasets)
                mapping = {sid: sorted({a_sid for a_sid, a_bs in binds.items() if set(a_bs) & set(bs)})
                           for sid, bs in b_binds.items()}
                shared = {sid for ids in mapping.values() for sid in ids}
                if not shared:
                    continue
                binds = {sid: bs for sid, bs in binds.items() if sid in shared}
                b_ids = [sid for sid, mapped in mapping.items() if mapped]
                territory, _note = scan_territory(state, HitTable(b_kind, b_kind, scan=b_source), regions, b_ids)
                here = scan_regions(scan, 'nuc/marks.tsv.bgz', territory)
                if not here:
                    continue
                kwargs['b_scan'] = _DatasetMappedScan(ScanDir(b_source.path), mapping)
            d = S.rate_data_from_marks(ScanDir(scan.path), a_type, b_kind, here, **kwargs)
        except S.ScanInputError as error:
            raise AssocInputError(str(error)) from None
        d.chrom = np.array([canon_chrom(state, c) for c in d.chrom], dtype=object)
        keep, ds_out = [], []
        for k in range(d.n):
            # every browser dataset bound to the scan dataset has its own molecules (HUB 3.4)
            for b in binds.get(d.labels['dataset'][k], ()):
                if not b.startswith('scan:'):
                    keep.append(k)
                    ds_out.append(b)
        if not keep:
            continue
        sub = d.subset(np.array(keep, dtype=np.int64))
        sub.labels['dataset'] = np.array(ds_out, dtype=object)
        for k in range(sub.n):
            qs = sub.labels['qname'][k]
            qs = (qs,) if isinstance(qs, str) else tuple(qs)
            m = mols.add(ds_out[k], str(sub.labels['molecule'][k]), qs[0] if qs else '')
            for q in qs[1:]:
                mols.qnames[m].add(q)
        parts.append(sub)
        used.append(scan.label)
    if not parts:
        raise AssocInputError('No molecule has measured nucleosome marks in the shared scan territory')
    merged = parts[0] if len(parts) == 1 else RateData(
        np.concatenate([p.length for p in parts]), sum((p.intervals for p in parts), []), sum((p.points for p in parts), []),
        np.concatenate([p.chrom for p in parts]), np.concatenate([p.midpoint for p in parts]),
        np.array([f'{ds}|{m}' for p in parts for ds, m in zip(p.labels['dataset'], p.labels['molecule'])], dtype=object),
        {'dataset': np.concatenate([p.labels['dataset'] for p in parts]),
         'molecule': np.concatenate([p.labels['molecule'] for p in parts]),
         'qname': np.array([q for p in parts for q in p.labels['qname']] + [], dtype=object)},
        sum(((p.junctions or [np.zeros(0, np.int64)] * p.n) for p in parts), []))
    if len(parts) == 1:
        merged.molecule_ids = np.array([f'{ds}|{m}' for ds, m in zip(merged.labels['dataset'], merged.labels['molecule'])],
                                       dtype=object)
    order = [mols.get(ds, str(m)) for ds, m in zip(merged.labels['dataset'], merged.labels['molecule'])]
    return merged, mols, order, used


# ------------------------------------------------------------------ decoded molecules (M2 phasing)
def decoded_molecules(state, datasets: Sequence[str], regions, *, max_records: int = 20_000, cancel=None, include_duplicates=False):
    """FiberHMM ``NucMolecule``s of native datasets over the windows (primary records), with each dataset's
    nucleosome calibration (the nucleosome panel's: an open scan's, the cache's, or computed now)."""
    from fiberhmm.nuc.records import DecodeContext, decode_record
    from fiberhmm.scan.reads import iter_records
    from services.nuc.engine import nuc_params, resolve_settings
    from services.nuc.inputs import NucInputError, browser_read_policy, nuc_source
    from services.nuc.live import bam_chrom
    import pysam
    policy = browser_read_policy(state, include_duplicates=include_duplicates)
    params = nuc_params(resolve_settings(None)[0])
    out: Dict[str, Tuple[list, object]] = {}
    for ds in datasets:
        if cancel is not None and cancel():
            from .assoc import Cancelled
            raise Cancelled()
        d = (getattr(state, 'datasets', None) or {}).get(ds)
        if d is None:
            continue
        if getattr(d, 'data_type', None) == 'bam_livelift':
            raise AssocInputError(f'{getattr(d, "label", ds)}: phasing at anchors runs on native datasets for now '
                                  '(a live-lift dataset decodes in its own assembly)')
        try:
            source = nuc_source(state, ds)
        except NucInputError as error:
            raise AssocInputError(str(error)) from None
        cal = calibration_for(state, source, cancel=cancel, policy=policy)
        with_headers = []
        for path in source.paths:
            with pysam.AlignmentFile(path, 'rb') as bam:
                with_headers.append(bam.header)
        mols = []
        for input_index, path in enumerate(source.paths):
            # the browser's read policy (duplicates, MAPQ and the other filters), as the calibration's population;
            # primary records (molecule-wide outputs come from one record per molecule)
            with pysam.AlignmentFile(path, 'rb') as bam:
                ctx = DecodeContext(bam.header, params)
                refs = list(bam.references)
                for c, a, b in regions:
                    name = bam_chrom(refs, c)
                    if name is None:
                        continue
                    for read, _sha, _occ in iter_records(bam, name, int(a), int(b), policy['filters']):
                        if cancel is not None and cancel():
                            from .assoc import Cancelled
                            raise Cancelled()
                        if read.is_supplementary or read.is_secondary:
                            continue
                        m, _reason = decode_record(read, ctx)
                        if m is None:
                            continue
                        m.meta = dict(m.meta or {}, dataset=ds, input_index=input_index, record=read, headers=with_headers)
                        m.chrom = canon_chrom(state, c)   # one contig naming (anchors use it; BAMs may say chr1 or 1)
                        mols.append(m)
                        if len(mols) >= max_records:
                            break
        # one record per molecule name (a molecule fetched by two windows once)
        uniq, seen = [], set()
        for m in mols:
            key = (m.name, m.chrom, m.ref_start)
            if key in seen:
                continue
            seen.add(key)
            uniq.append(m)
        out[ds] = (uniq, cal)
    return out


def calibration_for(state, source, cancel=None, policy=None):
    """The dataset's nucleosome calibration (NucCalibration), as the nucleosome panel finds or computes it."""
    from services.nuc.calibration import compute_calibration, find_calibration
    from services.nuc.engine import module_version, resolve_settings
    from services.nuc.inputs import browser_read_policy
    settings, settings_hash = resolve_settings(None)
    version = module_version()
    policy = policy or browser_read_policy(state)
    from services.nuc.jobs import active_config
    active = active_config(state, source.browser_id)
    if active is not None and active.settings.get('params') == settings.get('params') and \
            active.policy.get('filters') == policy.get('filters') and \
            set(source.paths) <= set(active.calibrations) and \
            len({ref.digest for ref in active.calibrations.values()}) == 1:
        return active.calibration.calibration
    found = find_calibration(state, source, settings_hash, version, policy.get('filters') or {})
    if found:
        ref = next(iter(found.values()))
        return ref.calibration
    from types import SimpleNamespace
    ref = compute_calibration(source, settings, settings_hash, version, policy,
                              cancel=SimpleNamespace(is_set=cancel) if cancel is not None else None)
    return ref.calibration


def jsonable(value):
    """A result as plain JSON: numpy scalars and arrays to Python, NaN/inf to None."""
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, set):
        return sorted(jsonable(v) for v in value)
    if value is None or isinstance(value, (str, int, bool)):
        return value
    return str(value)


def browser_set_states(state, table, mols, datasets):
    """Use the same provider states as Filter/Split, retaining the record's molecule provenance."""
    from services.feature_states import feature_states
    import json
    table.has_states = True
    for i, h in enumerate(table.hits):
        hit = h.get('hubHit')
        if not hit:
            raise AssocInputError('Browser hit is missing its state descriptor')
        if datasets:
            hit = dict(hit, datasets=[d for d in hit.get('datasets', []) if d in datasets])
        refs = hit.get('legacyRefs') if not hit.get('stateSpec') else None
        features = [dict(kind=r['kind'], source=r['source'], id=r['id'], dataset_id=r.get('datasetId')) for r in refs] if refs else [
            dict(kind=table.type_id.replace('.', '-'), source=hit['setId'], id=hit['hitId'], hub_hit=hit)]
        result = feature_states(state, features)
        for ds, rows in result['by_dataset'].items():
            for key, pattern in rows.items():
                called = {s for s in pattern if s in ('1', '0')}
                if len(called) != 1:
                    continue
                parts = json.loads(key[len('lift-record:v1 '):]) if key.startswith('lift-record:v1 ') else None
                q = qname_of_key(key)
                token = parts[0] if parts else molecule_token(q)
                m = mols.add(ds, token, q)
                table.rows.append((i, m, int(next(iter(called)))))
