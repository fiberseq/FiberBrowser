"""The fiberhmm-scan directories open in a session: manifest, dataset bindings, feature sets.

``open_scan(state, path)`` reads ``manifest.json`` (schema ``fiberhmm.scan.v1``), checks the reference against
the browser's and binds each scan dataset to a loaded dataset by file content id (an input BAM, or an annotated
BAM the scan wrote):

- **bound**: per-molecule states join to that dataset's reads (by read name, or by record key for live-lift
  datasets);
- **stale**: a loaded dataset has a file of the same name, but its content differs from what was scanned;
- **unbound**: no loaded dataset matches ("scan of other files"): hits are listed read-only, with no join;
- a reference mismatch (a shared contig with another length, or no shared contig) refuses the scan.

Each module's feature types become hub feature sets (``sets``). A set's id is ``hub:<16 hex>`` over its type,
scan id and module settings, so it is stable across reopenings of the same scan.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

from .identity import safe_content_id
from .tables import TableSet

SCHEMA = 'fiberhmm.scan.v1'
_INIT_LOCK = threading.Lock()
TYPE_COUNT_ROW_LIMIT = 500_000     # per-type hit counts are read from the hits table up to this many rows


class ScanOpenError(ValueError):
    """A directory that cannot be opened as a scan (missing, not a scan, reference mismatch)."""


def _digest(value, n=16) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:n]


def set_id_of(type_id: str, scan_id: str, module: str, settings_hash: str) -> str:
    return 'hub:' + _digest([type_id, scan_id, module, settings_hash])


def _session(state):
    with _INIT_LOCK:
        if 'scan_registry' not in state.__dict__:
            state.scan_registry = {}
            state.scan_registry_lock = threading.RLock()
            state.scan_generation = 0
    return state.scan_registry, state.scan_registry_lock


def generation(state) -> int:
    """The workspace's scan generation: a session import moves it on, and a scan opened for an older one never
    registers."""
    _session(state)
    return int(state.__dict__.get('scan_generation', 0))


def new_generation(state) -> int:
    scans, lock = _session(state)
    with lock:
        state.scan_generation = int(state.__dict__.get('scan_generation', 0)) + 1
        scans.clear()
        return state.scan_generation


def _camel_type(decl: dict) -> dict:
    """A manifest feature type (snake_case) as the hub's FeatureTypeDecl (camelCase), with score roles."""
    type_id = decl.get('type_id', '')
    scores = [dict(name=s.get('name'), label=s.get('label') or s.get('name'), kind=s.get('kind', 'fraction'),
                   better=s.get('better', 'none'), perGroup=bool(s.get('per_group'))) for s in decl.get('scores') or []]
    names = {s['name'] for s in scores}
    roles = {}
    # Canonical score roles (DESIGN §5.5): prevalence = the share of molecules in state 1 (nuc segment patches: the
    # share of measured molecules in the segment class); strength = the module's strength score.
    for prevalence in ('prevalence', 'fraction'):
        if prevalence in names:
            roles['prevalence'] = prevalence
            break
    for strength in ('support_gain_nats', 'gain_nats', 'score', 'R_minus_null'):
        if strength in names:
            roles['strength'] = strength
            break
    return dict(typeId=type_id, module=decl.get('module', ''), label=decl.get('label') or type_id,
                plural=decl.get('plural') or decl.get('label') or type_id, provides=list(decl.get('provides') or []),
                anchor=decl.get('anchor', 'centre'), zeroWidth=bool(decl.get('zero_width')), scores=scores,
                stateRule=decl.get('state_rule') or '', transferableState=bool(decl.get('transferable_state')),
                roles=roles, columns=list(decl.get('columns') or []))


class OpenScan:
    """One open scan directory."""

    def __init__(self, path: Path, manifest: dict, source: str, label: str):
        self.path = path
        self.manifest = manifest
        self.scan_id = str(manifest.get('scan_id') or _digest([str(path)]))
        self.source = source                     # 'opened' | 'cache'
        self.label = label
        self.tables = TableSet(path, (manifest.get('outputs') or {}).get('tables') or {})
        self.opened_at = time.time()
        self.bindings: Dict[str, dict] = {}
        self.type_counts: Dict[str, Optional[int]] = {}
        self.manifest_digest = _digest(manifest, 32)
        self.frame: Optional[dict] = None          # set when the scan is in another assembly than the browser's
        self.reference_note: Optional[str] = None

    # ---- what the scan is
    @property
    def annotate(self) -> bool:
        return bool((self.manifest.get('outputs') or {}).get('annotate'))

    def module(self, name: str) -> dict:
        return (self.manifest.get('modules') or {}).get(name) or {}

    def type_decl(self, module: str, type_id: str) -> Optional[dict]:
        for decl in self.module(module).get('feature_types') or []:
            if decl.get('type_id') == type_id:
                return decl
        return None

    def set_id(self, type_id: str, module: str) -> str:
        """A set's id: over the scan id for opened scans; over the directory for the browser's cache, whose scan id
        changes as it grows (another chromosome), so a selection keeps naming its sets."""
        key = f'cache:{self.path}' if self.source == 'cache' else self.scan_id
        return set_id_of(type_id, key, module, self.module(module).get('settings_hash', ''))

    def dataset_of_browser(self, browser_id: str) -> Optional[str]:
        found = self.datasets_of_browser(browser_id)
        return found[0] if found else None

    def datasets_of_browser(self, browser_id: str) -> List[str]:
        """Every scan dataset bound to a browser dataset (several when one loaded dataset holds their files)."""
        return [sid for sid, b in self.bindings.items() if b.get('dataset') == browser_id and b.get('status') == 'bound']

    def count_types(self) -> None:
        """Rows per hit type of each module's hits table (small tables read whole; larger: module totals only)."""
        tables = (self.manifest.get('outputs') or {}).get('tables') or {}
        for name in self.manifest.get('modules') or {}:
            rel = f'{name}/hits.tsv.bgz'
            rows = (tables.get(rel) or {}).get('rows')
            decls = [d.get('type_id') for d in self.module(name).get('feature_types') or []]
            if not self.tables.has(rel):
                for t in decls:
                    self.type_counts[t] = 0
                continue
            if rows is not None and rows > TYPE_COUNT_ROW_LIMIT:
                for t in decls:
                    self.type_counts[t] = None
                continue
            counts = {t: 0 for t in decls}
            t = self.tables.table(rel)
            if t is not None:
                for row in t.rows():
                    counts[row.get('type', '')] = counts.get(row.get('type', ''), 0) + 1
            self.type_counts.update(counts)

    # ---- dataset binding
    def bind(self, state) -> None:
        """Bind each scan dataset to one loaded dataset by content id: every input file of the scan dataset (or every
        annotated BAM written for it) must be a file of that loaded dataset. ``files`` maps each scan input index to
        the loaded file that holds it (its records are the ones the states name)."""
        loaded = _loaded_files(state)
        annotated = (self.manifest.get('outputs') or {}).get('annotated') or []
        out = {}
        for ds in self.manifest.get('datasets') or []:
            sid = ds.get('dataset_id')
            inputs = [(int(f.get('input_index', i)), f.get('content_id'), f.get('name') or '') for i, f in enumerate(ds.get('files') or [])]
            ann = [(int(a.get('input_index', 0)), a.get('content_id'), os.path.basename(a.get('path') or ''))
                   for a in annotated if a.get('dataset_id') == sid]
            best = None
            partial = None
            for ds_id, files in loaded.items():
                by_cid = {cid: path for path, cid in files if cid}
                for via, wanted in (('input', inputs), ('annotated', ann)):
                    if not wanted:
                        continue
                    hits = {idx: by_cid[cid] for idx, cid, _n in wanted if cid in by_cid}
                    if len(hits) == len(wanted):
                        best = best or (ds_id, via, hits)
                    elif hits:
                        partial = partial or ds_id
            if best:
                ds_id, via, files = best
                out[sid] = dict(dataset=ds_id, status='bound', via=via, files={str(k): v for k, v in files.items()})
                continue
            if partial:
                out[sid] = dict(dataset=partial, status='partial', via=None,
                                note='only some of its files are in a loaded dataset: open all of them as one dataset')
                continue
            names = {os.path.basename(path): ds_id for ds_id, files in loaded.items() for path, _cid in files}
            stale = next((names[n] for _i, _c, n in inputs if n in names), None)
            if stale:
                out[sid] = dict(dataset=stale, status='stale', via=None,
                                note='the loaded BAM differs from the one scanned (content changed): re-scan')
            else:
                out[sid] = dict(dataset=None, status='unbound', via=None,
                                note='scan of other files: hits only, no per-read join')
        self.bindings = out

    # ---- hub feature sets
    def sets(self, state=None) -> List[dict]:
        names = _dataset_labels(state) if state is not None else {}
        m = self.manifest
        units = m.get('units') or {}
        status_block = m.get('status') or {}
        partial = bool(status_block.get('units_failed')) or int(status_block.get('seams_open') or 0) > 0
        out = []
        for module, block in sorted((m.get('modules') or {}).items()):
            for decl in block.get('feature_types') or []:
                type_id = decl.get('type_id')
                if 'hit' not in (decl.get('provides') or []):
                    continue
                groups = [dict(id='all', kind='all', label='All')]
                datasets = []
                notes = []
                for ds in m.get('datasets') or []:
                    sid = ds['dataset_id']
                    b = self.bindings.get(sid) or {}
                    bid = b.get('dataset') if b.get('status') == 'bound' else None
                    if bid:
                        datasets.append(bid)
                    label = names.get(bid) if bid else None
                    groups.append(dict(id=sid, datasetId=bid, kind='dataset', label=label or sid,
                                       scanDataset=sid, binding=b.get('status', 'unbound')))
                    if b.get('status') in ('stale', 'unbound', 'partial') and b.get('note') not in notes:
                        notes.append(b['note'])
                stale = any((self.bindings.get(ds['dataset_id']) or {}).get('status') == 'stale'
                            for ds in m.get('datasets') or [])
                producer = 'browser-scan' if self.source == 'cache' else 'fiberhmm-scan'
                unit_text = (f"{units.get('unit_bp', 0) // 1000}/{units.get('stride_bp', 0) // 1000} kb grid"
                             if units.get('mode') == 'grid' else 'BED units')
                summary = (f"{'browser scan' if self.source == 'cache' else 'fiberhmm-scan'} "
                           f"{(m.get('fiberhmm') or {}).get('version', '')} · {module} {block.get('version', '')}"
                           f" · {unit_text} · settings {block.get('settings_hash', '')[:8]}")
                out.append(dict(
                    setId=self.set_id(type_id, module),
                    typeId=type_id, type=_camel_type(decl),
                    provenance=dict(producer=producer, scanId=self.scan_id, module=module,
                                    moduleVersion=block.get('version'), settingsHash=block.get('settings_hash'),
                                    fiberhmmVersion=(m.get('fiberhmm') or {}).get('version'),
                                    inputs=[f.get('content_id') for d in m.get('datasets') or [] for f in d.get('files') or []],
                                    units=units.get('mode', 'grid'), summary=summary,
                                    experimental=bool(block.get('experimental'))),
                    frame=dict(self.frame or m.get('frame') or {'kind': 'linear'}),
                    datasets=datasets, groups=groups,
                    coverage=dict(territory='units', ref=self.scan_id),
                    count=self.type_counts.get(type_id),
                    status='stale' if stale else ('partial' if partial else 'complete'),
                    note='; '.join(notes + ([self.reference_note] if self.reference_note else [])) or None,
                    source=dict(kind='scan', scanId=self.scan_id, module=module),
                ))
        return out

    def info(self, state=None) -> dict:
        m = self.manifest
        return dict(
            scanId=self.scan_id, path=str(self.path), label=self.label, source=self.source,
            manifestDigest=self.manifest_digest, schema=m.get('schema'),
            fiberhmm=(m.get('fiberhmm') or {}).get('version'), frame=self.frame or m.get('frame'),
            referenceNote=self.reference_note,
            units={k: (m.get('units') or {}).get(k) for k in ('mode', 'unit_bp', 'stride_bp', 'grid_offset', 'contigs',
                                                             'regions', 'bed', 'count')},
            modules={n: dict(version=b.get('version'), settingsHash=b.get('settings_hash'),
                             experimental=bool(b.get('experimental')))
                     for n, b in (m.get('modules') or {}).items()},
            annotate=self.annotate,
            annotated=[dict(datasetId=a.get('dataset_id'), path=str(self.path / a['path']), source=a.get('source'),
                            records=a.get('records'), scope=a.get('scope'))
                       for a in (m.get('outputs') or {}).get('annotated') or [] if a.get('path')],
            datasets=[dict(scanDataset=d.get('dataset_id'), ordinal=d.get('ordinal'), chemistry=d.get('chemistry'),
                           files=[f.get('name') for f in d.get('files') or []],
                           **{k: v for k, v in (self.bindings.get(d.get('dataset_id')) or {}).items() if k != 'files'})
                      for d in m.get('datasets') or []],
            status=m.get('status'), readPolicy=m.get('read_policy'),
            sets=self.sets(state),
        )


def _loaded_files(state) -> Dict[str, list]:
    """Browser dataset id -> [(path, content id)] of its local files."""
    from utils.validation import is_url
    out: Dict[str, list] = {}
    for ds_id, ds in (getattr(state, 'datasets', None) or {}).items():
        files = []
        for p in getattr(ds, 'paths', None) or []:
            if not isinstance(p, str) or is_url(p) or not os.path.isfile(p):
                continue
            files.append((p, safe_content_id(p)))
        out[ds_id] = files
    return out


def _dataset_labels(state) -> Dict[str, str]:
    return {ds_id: getattr(ds, 'label', ds_id) for ds_id, ds in (getattr(state, 'datasets', None) or {}).items()}


def _reference_problem(state, manifest: dict) -> Optional[str]:
    """Why the scan's reference does not match the browser's (None when it does, or when no reference is loaded)."""
    from utils.chrom import normalize_chrom_name
    chroms = getattr(state, 'chroms', None) or []
    if not chroms:
        return None
    ours = {normalize_chrom_name(str(c.name)): int(c.size) for c in chroms}
    theirs = [(str(n), int(l)) for n, l in (manifest.get('reference') or {}).get('contigs') or []]
    if not theirs:
        return 'the manifest lists no reference contigs'
    shared = 0
    for name, length in theirs:
        mine = ours.get(normalize_chrom_name(name))
        if mine is None:
            continue
        if mine != length:
            return f'{name} is {length:,} bp in the scan and {mine:,} bp in this reference'
        shared += 1
    if not shared:
        return 'no contig of the scan is in this reference'
    return None


def read_manifest(path) -> dict:
    p = Path(path).expanduser()
    mf = p / 'manifest.json'
    if not p.is_dir():
        raise ScanOpenError(f'Not a folder: {p}')
    if not mf.is_file():
        raise ScanOpenError('No manifest.json in this folder: give a finished fiberhmm-scan output directory')
    if _inside(p, 'manifest.json') is None:
        raise ScanOpenError('manifest.json is outside the scan directory (a link out of it)')
    try:
        manifest = json.loads(mf.read_text())
    except ValueError as error:
        raise ScanOpenError(f'manifest.json is not valid JSON ({error})') from None
    if manifest.get('schema') != SCHEMA:
        raise ScanOpenError(f'Schema {manifest.get("schema")!r}: this build reads {SCHEMA}')
    return manifest


def _inside(root: Path, rel: str) -> Optional[Path]:
    """``root / rel`` when it stays inside ``root`` after resolving symlinks (and passes a lab server's read roots),
    else None. Manifest paths are relative; an absolute path, ``..`` or an outward symlink is refused."""
    if not isinstance(rel, str) or not rel or os.path.isabs(rel):
        return None
    p = (root / rel)
    try:
        resolved = p.resolve()
        resolved.relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    try:
        from services.lab.paths import PathDenied, confine
        confine(str(resolved))
    except ImportError:   # pragma: no cover - the lab helpers ship with the browser
        pass
    except PathDenied:
        return None
    return p


def validate(path: Path, manifest: dict) -> List[str]:
    """Every listed table exists inside the scan directory with an index; annotated BAMs likewise."""
    from .tables import index_path
    problems = []
    for rel in sorted((manifest.get('outputs') or {}).get('tables') or {}):
        p = _inside(path, rel)
        if p is None:
            problems.append(f'{rel} is outside the scan directory')
        elif not p.is_file():
            problems.append(f'missing table {rel}')
        elif index_path(p) is None or _inside(path, str(index_path(p).relative_to(path))) is None:
            problems.append(f'missing index of {rel}')
    for a in (manifest.get('outputs') or {}).get('annotated') or []:
        rel = a.get('path') or ''
        p = _inside(path, rel)
        if p is None:
            problems.append(f'{rel} is outside the scan directory')
        elif not p.is_file():
            problems.append(f'missing annotated BAM {rel}')
        elif not any(_inside(path, rel + ext) and (path / (rel + ext)).is_file() for ext in ('.csi', '.bai')):
            problems.append(f'missing index of {rel}')
    return problems


def open_scan(state, path, *, source: str = 'opened', label: Optional[str] = None,
              generation: Optional[int] = None) -> OpenScan:
    """Open (or re-read) a scan directory in this session.

    The reference: a scan bound to a loaded dataset was made on that dataset's own file, so its reference is the
    file's. When it differs from the browser's reference (a scan of a live-lift dataset's source BAM, in its own
    assembly), the scan's frame is ``source``: its per-read states join the lifted rows by record key, and its hits
    stay in source coordinates until they are lifted (G1). An unbound scan must match the browser's reference."""
    p = Path(path).expanduser().resolve()
    manifest = read_manifest(p)
    problems = validate(p, manifest)
    if problems:
        raise ScanOpenError('The scan directory is incomplete: ' + '; '.join(problems[:4]))
    scan = OpenScan(p, manifest, source, label or p.name)
    scan.bind(state)
    problem = _reference_problem(state, manifest)
    bound = [b for b in scan.bindings.values() if b.get('status') == 'bound']
    if problem and not bound:
        raise ScanOpenError(f'Reference mismatch: {problem}. This scan was made on another reference')
    scan.reference_note = None
    if problem:
        lifted = [b['dataset'] for b in bound
                  if getattr((getattr(state, 'datasets', None) or {}).get(b['dataset']), 'data_type', None) == 'bam_livelift']
        contigs = (manifest.get('reference') or {}).get('contigs') or []
        scan.frame = dict(kind='source', assembly=(manifest.get('reference') or {}).get('contigs_sha256', '')[:12],
                          liftedDatasets=lifted, firstContig=str(contigs[0][0]) if contigs else '')
        scan.reference_note = ('scanned in the source assembly of ' + (', '.join(lifted) if lifted else 'its BAM')
                               + ': per-read states join; hits stay in source coordinates (lifting hits: G1)')
    scan.count_types()
    scans, lock = _session(state)
    with lock:
        if generation is not None and generation != int(state.__dict__.get('scan_generation', 0)):
            raise ScanOpenError('Another session was opened meanwhile: this scan belongs to the previous one')
        # One registration per directory: a browser cache that grew (another chromosome) has a new scan id.
        # The replaced reader is not closed here: a request may be reading it; its files close when it is dropped.
        for key in [k for k, v in scans.items() if v.path == p]:
            scans.pop(key)
        old = scans.get(scan.scan_id)
        if old is not None and old.path != p:
            # The same scan key in two directories (computed live and opened from disk): both stay, under distinct ids.
            scan.scan_id = scan.scan_id + (':cache' if source == 'cache' else ':' + _digest([str(p)], 8))
        scans[scan.scan_id] = scan
    _refresh_layers(state)
    return scan


def _refresh_layers(state) -> None:
    from .overlay import refresh_dataset_layers
    try:
        refresh_dataset_layers(state)
    except Exception:   # pragma: no cover - layers are a display convenience; never fail an open on them
        pass


def get_scan(state, scan_id: str) -> OpenScan:
    scans, lock = _session(state)
    with lock:
        scan = scans.get(scan_id)
    if scan is None:
        raise KeyError(scan_id)
    return scan


def list_scans(state) -> List[OpenScan]:
    scans, lock = _session(state)
    with lock:
        return sorted(scans.values(), key=lambda s: s.opened_at)


def close_scan(state, scan_id: str) -> bool:
    scans, lock = _session(state)
    with lock:
        scan = scans.pop(scan_id, None)
    if scan is not None:
        # Not closed explicitly: a request may still be reading it (its files close when it is dropped).
        _refresh_layers(state)
    return scan is not None


def rebind_all(state) -> None:
    """Datasets were added or removed: bind every open scan again."""
    for scan in list_scans(state):
        scan.bind(state)
    _refresh_layers(state)


def find_set(state, set_id: str):
    """(scan, module, type id) of a hub set id, else None."""
    for scan in list_scans(state):
        for module, block in (scan.manifest.get('modules') or {}).items():
            for decl in block.get('feature_types') or []:
                if scan.set_id(decl.get('type_id'), module) == set_id:
                    return scan, module, decl.get('type_id')
    return None
