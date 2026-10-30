"""Session-local, disk-backed hub index. Only the requested page crosses the wire.

Scan tables are streamed once per manifest/binding revision. SQLite owns sorting,
filtering and counting; no genome-sized Python list or browser hit array is needed.
"""
from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import tempfile
import threading
from collections import defaultdict

from services.scan.registry import list_scans, generation, ensure_bound
from services.scan.serve import format_hits
from services.scan.tables import iter_rows

_INIT = threading.Lock()


def number(v):
    try:
        n = float(v)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def regions_for_scope(state, scope):
    from services.hub.assoc_inputs import scope_regions, merge_regions
    kind = scope.get('kind', 'view')
    if kind in ('genome', 'scan'):
        return None
    if kind == 'genes':
        from services.files_endpoint import search_gene_payload
        rows = []
        for gene in scope.get('genes') or []:
            hit = search_gene_payload(state, str(gene))
            if not hit.get('found'):
                raise ValueError(f'Gene not in the loaded annotation: {gene}')
            flank = max(0, int(scope.get('flank', 5000)))
            rows.append((hit['chrom'], max(0, int(hit['tss']) - flank), int(hit['tss']) + flank + 1))
        if not rows:
            raise ValueError('Choose at least one gene')
        return merge_regions(rows)
    if kind == 'anchors':
        flank = max(0, int(scope.get('flank', 1000)))
        rows = merge_regions((str(p[0]), max(0, int(p[1]) - flank), int(p[1]) + flank + 1) for p in scope.get('anchors') or [] if len(p) >= 2)
        if not rows:
            raise ValueError('The anchor set is empty')
        return rows
    if kind == 'regions':
        rows = merge_regions(scope.get('regions') or [])
        if not rows:
            raise ValueError('Choose at least one region')
        return rows
    return scope_regions(scope)


def _chrom(chrom):
    from utils.chrom import normalize_chrom_name
    return normalize_chrom_name(chrom)


def _dump(v):
    return json.dumps(v, separators=(',', ':'), allow_nan=False)


class HubIndex:
    def __init__(self, epoch):
        self.epoch = epoch
        self.directory = tempfile.TemporaryDirectory(prefix='hub-index-')
        self.db = sqlite3.connect(self.directory.name + '/hits.sqlite', check_same_thread=False)
        self.lock = threading.RLock()
        self.revisions = {}
        self.db.executescript('''
            PRAGMA journal_mode=OFF;
            CREATE TABLE hits (source TEXT, set_id TEXT, hit_id TEXT, type_id TEXT,
                chrom TEXT, start INTEGER, end INTEGER, label TEXT,
                prevalence REAL, strength REAL, q REAL, payload TEXT,
                PRIMARY KEY(set_id, hit_id));
            CREATE INDEX locus ON hits(chrom,start,end);
            CREATE INDEX prev ON hits(prevalence);
            CREATE INDEX strength ON hits(strength);
            CREATE INDEX q ON hits(q);
            CREATE TABLE vals (hit_id TEXT, payload TEXT);
            CREATE INDEX val_hit ON vals(hit_id);
        ''')

    def close(self):
        self.db.close()
        self.directory.cleanup()

    def insert(self, source, set_id, hit):
        scores = hit.get('scores') or {}
        values = hit.get('values') or hit.get('columns') or {}
        def role(name):
            cells = [number(g.get(name, {}).get('v')) for g in values.values()]
            cells = [v for v in cells if v is not None]
            return number(scores.get(name)) if not cells else (min(cells) if name == 'q' else max(cells))
        span = hit.get('target') or hit
        self.db.execute('INSERT OR REPLACE INTO hits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                        (source, set_id, hit['hitId'], hit['typeId'], _chrom(span['chrom']), span['start'], span['end'],
                         hit.get('label', ''), role('prevalence'), role('strength') if role('strength') is not None else number(hit.get('score')),
                         role('q'), _dump(hit)))

    def scan(self, state, scan):
        revision = _dump([scan.manifest_digest, scan.bindings, scan.frame])
        if self.revisions.get(scan.scan_id) == revision:
            return
        self.db.execute('DELETE FROM hits WHERE source=?', (scan.scan_id,))
        sets = {s['typeId']: s for s in scan.sets(state)}
        for module in scan.manifest.get('modules') or {}:
            rel = f'{module}/hits.tsv.bgz'
            if not scan.tables.has(rel):
                continue
            self.db.execute('DELETE FROM vals')
            vr = f'{module}/values.tsv.bgz'
            if scan.tables.has(vr):
                self.db.executemany('INSERT INTO vals VALUES (?,?)',
                                    ((v['hit_id'], _dump(v)) for v in iter_rows(scan.path / vr)))
            batch = []
            def flush():
                values = defaultdict(list)
                marks = ','.join('?' for _ in batch)
                for fid, payload in self.db.execute(f'SELECT hit_id,payload FROM vals WHERE hit_id IN ({marks})',
                                                    [r['hit_id'] for r in batch]):
                    values[fid].append(json.loads(payload))
                normalized = format_hits(scan, module, batch, values)
                if (scan.frame or {}).get('kind') == 'source':
                    from services.scan.projection import lifted_datasets, _annotate
                    from services.scan.lift import lift_hits
                    ds_ids = lifted_datasets(state, scan)
                    if ds_ids:
                        ds_id = ds_ids[0]
                        config = state.datasets[ds_id].live_lift
                        lift_rows = [dict(chrom=h['chrom'], start=h['start'], end=h['end']) for h in normalized]
                        lift_rows += [dict(chrom=h['chrom'], start=h['anchor'], end=h['anchor'] + 1) for h in normalized]
                        lifts = lift_hits(config, lift_rows)
                        labels = dict(getattr(config.handle, 'haplotype_labels', {}) or {})
                        n = len(normalized)
                        normalized = [_annotate(h, ds_id, config.handle, labels, lifts.get(i), lifts.get(n+i),
                            getattr(lifts.get(i), 'chrom', None) or getattr(lifts.get(i), 'junction_chrom', None) or h['chrom'],
                            scan_datasets=tuple(scan.bindings)) for i, h in enumerate(normalized)]
                for h in normalized:
                    decl = sets.get(h['typeId'])
                    if decl:
                        h['setId'] = decl['setId']
                        mapped = {}
                        for col, roles in h['columns'].items():
                            base, sep, hap = col.partition(':')
                            binding = scan.bindings.get(base) or {}
                            key = 'all' if col == 'all' else ('ds:' + binding['dataset'] if binding.get('status') == 'bound' else f'scan:{scan.scan_id}:{col}')
                            mapped[key + (':' + hap if sep and col != 'all' else '')] = roles
                        h['values'] = mapped
                        h['scores'] = {**{k: number(v) for k, v in h['module'].items()},
                                       **{k: v.get('v') for k, v in h['columns'].get('all', {}).items()}}
                        for group in h.get('raw', {}).values():
                            for name, cell in group.items():
                                value = number(cell.get('v'))
                                if value is not None and h['scores'].get(name) is None:
                                    h['scores'][name] = value
                        if h['scores'].get('q') is None:
                            qs = [number(v.get('value')) for vs in values.get(h['hitId'], []) for v in [vs] if v.get('value_name') in ('q', 'q_value')]
                            qs = [q for q in qs if q is not None]
                            if qs:
                                h['scores']['q'] = min(qs)
                        self.insert(scan.scan_id, decl['setId'], h)
                batch.clear()
            for row in iter_rows(scan.path / rel):
                batch.append(row)
                if len(batch) == 500:
                    flush()
            if batch:
                flush()
        self.db.execute('DELETE FROM vals')
        self.revisions[scan.scan_id] = revision
        self.db.commit()

    def providers(self, state, sets):
        from .variation_identity import normalize_hit
        active = set()
        for s in sets:
            sid = s['setId']
            active.add(sid)
            hits = s.get('source', {}).get('hits', [])
            revision = hashlib.sha256(_dump(hits).encode()).hexdigest()
            if self.revisions.get(sid) == revision:
                continue
            self.db.execute('DELETE FROM hits WHERE source=?', (sid,))
            canonical = {}
            for hit in hits:
                h = normalize_hit(state, hit)
                old = canonical.get(h['hitId'])
                if old:
                    h = dict(h, values={**old.get('values', {}), **h.get('values', {})},
                             idAliases=list(dict.fromkeys([*old.get('idAliases', []), *h.get('idAliases', [])])))
                canonical[h['hitId']] = h
            for h in canonical.values():
                self.insert(sid, sid, h)
            self.revisions[sid] = revision
        for key in list(self.revisions):
            if key.startswith('browser:') and key not in active:
                self.db.execute('DELETE FROM hits WHERE source=?', (key,))
                del self.revisions[key]
        self.db.commit()

    def page(self, request, regions):
        where, args = [], []
        scope = request.get('scope') or {}
        if scope.get('kind') in ('genome', 'scan'):
            where.append("source NOT LIKE 'browser:%'")
        if scope.get('kind') == 'scan':
            where.append('source=?')
            args.append(scope.get('scanId', ''))
        hidden = request.get('hiddenSets') or []
        if hidden:
            where.append('set_id NOT IN (' + ','.join('?' for _ in hidden) + ')')
            args.extend(hidden)
        if request.get('typeFilter'):
            where.append('type_id=?')
            args.append(request['typeFilter'])
        if regions is not None:
            # A temporary indexed interval table avoids SQLite's expression-depth limit for large BEDs.
            self.db.execute('CREATE TEMP TABLE IF NOT EXISTS regions(chrom TEXT,start INTEGER,end INTEGER)')
            self.db.execute('DELETE FROM regions')
            self.db.executemany('INSERT INTO regions VALUES (?,?,?)', ((_chrom(c), a, b) for c, a, b in regions))
            self.db.execute('CREATE INDEX IF NOT EXISTS region_locus ON regions(chrom,start,end)')
            where.append('EXISTS(SELECT 1 FROM regions r WHERE r.chrom=hits.chrom AND hits.start<r.end '
                         'AND CASE WHEN hits.end>hits.start THEN hits.end>r.start ELSE hits.start>=r.start END)')
        for name, op, value in [('prevalence', '>=', request.get('minPrevalence')),
                                ('strength', '>=', request.get('minStrength')), ('q', '<=', request.get('maxQ'))]:
            if value is not None:
                if number(value) is None:
                    raise ValueError('Score filters must be finite numbers')
                where.append(f'{name}{op}?')
                args.append(float(value))
        # Arbitrary declared score filters, in addition to the canonical roles.
        for f in request.get('scoreFilters') or []:
            op = f.get('op')
            if op not in ('>=', '<=', '=', '>', '<') or not isinstance(f.get('name'), str) or number(f.get('value')) is None:
                raise ValueError('Invalid score filter')
            where.append(f'CAST(json_extract(payload, ?) AS REAL) {op} ?')
            args.extend(['$.scores.' + json.dumps(f['name']), float(f['value'])])
        if request.get('sharedOnly'):
            where.append("EXISTS(SELECT 1 FROM hits other WHERE other.set_id<>hits.set_id AND other.type_id=hits.type_id AND other.chrom=hits.chrom AND "
                "((hits.start=hits.end AND other.start=other.end AND abs(hits.start-other.start)<=20) OR "
                "(min(hits.end,other.end)-max(hits.start,other.start)>=0.5*(hits.end-hits.start) AND "
                "min(hits.end,other.end)-max(hits.start,other.start)>=0.5*(other.end-other.start) AND hits.end>hits.start AND other.end>other.start)))")
        sort = request.get('sort') or {}
        key = sort.get('key', 'locus')
        if key not in ('locus', 'label', 'prevalence', 'strength', 'q', 'delta'):
            raise ValueError('Unknown sort column')
        order = {'locus': 'chrom,start', 'label': 'label', 'prevalence': 'prevalence', 'strength': 'strength', 'q': 'q'}.get(key)
        if key == 'delta':
            pair = request.get('compare') or []
            if len(pair) != 2:
                raise ValueError('Choose two comparison groups')
            # Column names are quoted JSON paths, never SQL fragments.
            order = '(json_extract(payload, ?) - json_extract(payload, ?))'
            order_args = []
            for col in pair:
                order_args.append('$.values.' + json.dumps(col) + '.prevalence.v')
        else:
            order_args = []
        direction = 'DESC' if sort.get('dir') == 'desc' else 'ASC'
        clause = ' WHERE ' + ' AND '.join(where) if where else ''
        total = self.db.execute('SELECT count(*) FROM hits' + clause, args).fetchone()[0]
        limit = min(500, max(1, int(request.get('limit', 100))))
        offset = max(0, int(request.get('offset', 0)))
        sql = 'SELECT source,set_id,payload FROM hits' + clause + f' ORDER BY {order} {direction} NULLS LAST,chrom,start,set_id,hit_id LIMIT ? OFFSET ?'
        rows = [dict(source=source, setId=sid, hit=json.loads(payload)) for source, sid, payload in
                self.db.execute(sql, [*args, *order_args, limit, offset])]
        return dict(rows=rows, total=total, offset=offset, limit=limit, hasMore=offset + limit < total)


def query_hits(state, request):
    ensure_bound(state)
    regions = regions_for_scope(state, request.get('scope') or {})
    epoch = generation(state)
    with _INIT:
        index = getattr(state, '_hub_index', None)
        if index is None or index.epoch != epoch:
            # Old in-flight requests can finish using their index; GC releases its temporary directory.
            index = state._hub_index = HubIndex(epoch)
    with index.lock:
        scans = list_scans(state)
        active = {s.scan_id for s in scans}
        for key in list(index.revisions):
            if not key.startswith('browser:') and key not in active:
                index.db.execute('DELETE FROM hits WHERE source=?', (key,))
                del index.revisions[key]
        for scan in scans:
            index.scan(state, scan)
        index.providers(state, request.get('providers') or [])
        return index.page(request, regions)
