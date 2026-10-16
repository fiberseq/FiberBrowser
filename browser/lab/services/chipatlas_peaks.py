"""ChIP-Atlas peaks of chosen factors over an NFR run's window (data-driven support beyond PWMs).

ChIP-Atlas (chip-atlas.dbcls.jp) publishes one small peak bigBed per experiment (q < 1e-5: ``bb05``, a few hundred KB).
For each factor (the antigen symbol, as in JASPAR for fly and human), the newest ``max_per_factor`` experiments of
the run's assembly are downloaded once into ~/.fiberhmm/chipatlas/peaks/<genome>/ and read locally. Which
experiments exist comes from ChIP-Atlas' experimentList.tab (the app's ChIP-Atlas cache, ~340 MB, downloaded only
on request); a per-assembly index of it is kept next to it. Runs in the background with progress.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
import uuid

BASE = 'https://chip-atlas.dbcls.jp/data'
MAX_PER_FACTOR = 12
MAX_FACTORS = 40
_jobs = {}
_lock = threading.Lock()
_index_cache = {}


def data_dir():
    from services.external_chipatlas import chipatlas_data_dir
    return chipatlas_data_dir()


def metadata_path():
    return os.path.join(data_dir(), 'experimentList.tab')


def antigen_index(genome):
    """{antigen (lower case): [(experiment id, antigen, cell type class, cell type), ...]} for TFs of ``genome``,
    newest (highest number) first; built once from experimentList.tab and cached on disk."""
    tab = metadata_path()
    if not os.path.exists(tab):
        return None
    stamp = int(os.path.getmtime(tab))
    key = (genome, stamp)
    if key in _index_cache:
        return _index_cache[key]
    cache = os.path.join(data_dir(), f'index_{genome}.json')
    if os.path.exists(cache):
        try:
            with open(cache) as fh:
                saved = json.load(fh)
            if saved.get('stamp') == stamp:
                _index_cache[key] = saved['index']
                return saved['index']
        except (OSError, ValueError):
            pass
    index = {}
    with open(tab, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 6 or parts[1] != genome or parts[2] != 'TFs and others':
                continue
            index.setdefault(parts[3].lower(), []).append([parts[0], parts[3], parts[4], parts[5]])
    num = lambda e: int(''.join(ch for ch in e[0] if ch.isdigit()) or 0)  # noqa: E731
    for v in index.values():
        v.sort(key=num, reverse=True)
    try:
        with open(cache, 'w') as fh:
            json.dump(dict(stamp=stamp, index=index), fh)
    except OSError:
        pass
    _index_cache[key] = index
    return index


class NoPeakFile(Exception):
    """ChIP-Atlas publishes no readable peaks for this experiment (an empty or zero-filled bb05 file:
    no peak at q < 1e-5). Remembered, so it is neither downloaded nor opened again."""


def _none_marker(path):
    return path[:-len('.bb')] + '.none' if path.endswith('.bb') else path + '.none'


def peak_file(genome, srx, fetch=None):
    """The experiment's bb05 peak file, downloaded once (atomically) into the cache; its path.
    Raises NoPeakFile for an experiment ChIP-Atlas has no readable peaks for (remembered)."""
    d = os.path.join(data_dir(), 'peaks', genome)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f'{srx}.05.bb')
    if os.path.exists(_none_marker(path)):
        raise NoPeakFile(srx)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        if _valid_bigbed(path):
            return path
        os.unlink(path)                                    # a corrupt cached file: fetched again
    url = f'{BASE}/{genome}/eachData/bb05/{srx}.05.bb'
    tmp = f'{path}.part-{os.getpid()}-{threading.get_ident()}'
    try:
        if fetch is not None:
            data = fetch(url)
        else:
            req = urllib.request.Request(url, headers={'User-Agent': 'FiberBrowser'})
            with urllib.request.urlopen(req, timeout=60) as resp:
                size = resp.headers.get('Content-Length') if getattr(resp, 'headers', None) else None
                if size is not None and str(size).isdigit() and int(size) > MAX_PEAK_FILE:
                    raise IOError(f'{srx}: peak file of {int(size):,} bytes is over the {MAX_PEAK_FILE:,}-byte limit')
                data = resp.read(MAX_PEAK_FILE + 1)
                if len(data) > MAX_PEAK_FILE:
                    raise IOError(f'{srx}: peak file over the {MAX_PEAK_FILE:,}-byte limit')
                if size is not None and str(size).isdigit() and len(data) != int(size):
                    raise IOError(f'{srx}: download incomplete ({len(data)} of {size} bytes)')
        with open(tmp, 'wb') as fh:
            fh.write(data)
        if fetch is None and not _valid_bigbed(tmp):
            # A complete download that is no bigBed with peaks: what ChIP-Atlas serves for an
            # experiment without peaks. Remember it (a marker), rather than fetch it every run.
            with open(_none_marker(path), 'w') as fh:
                fh.write(f'{len(data)} bytes, no readable peaks: {url}\n')
            raise NoPeakFile(srx)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path


MAX_PEAK_FILE = 50_000_000


def _bigbed_has_chroms(path):
    """Whether the file is a bigBed with at least one chromosome, read from its header in Python:
    libBigWig prints "[bwHdrRead] ... [pyBwOpen] bw is NULL!" to stderr for every file it can't
    open, so empty or zero-filled files are turned away before it sees them."""
    import struct
    try:
        with open(path, 'rb') as fh:
            head = fh.read(16)
            if len(head) < 16:
                return False
            magic, _version, _zooms, tree = struct.unpack('<IHHQ', head)
            if magic != 0x8789F2EB:
                return False
            fh.seek(tree)
            node = fh.read(24)
            if len(node) < 24:
                return False
            tree_magic, _block, _key, _val, items = struct.unpack('<IIIIQ', node)
            return tree_magic == 0x78CA8C91 and items > 0
    except OSError:
        return False


def _valid_bigbed(path):
    if not _bigbed_has_chroms(path):
        return False
    bb = None
    try:
        import pyBigWig
        bb = pyBigWig.open(path)
        return bool(bb) and bb.isBigBed()
    except Exception:  # noqa: BLE001
        return False
    finally:
        if bb is not None:
            bb.close()


def read_peaks(path, chrom, start, end):
    import pyBigWig
    bb = pyBigWig.open(path)
    try:
        names = set(bb.chroms() or {})
        c = chrom if chrom in names else (f'chr{chrom}' if f'chr{chrom}' in names else chrom.removeprefix('chr'))
        if c not in names:
            return []
        lo, hi = max(0, int(start)), min(int(end), int(bb.chroms(c)))
        if hi <= lo:
            return []
        return [(int(a), int(b), str(rest).split('\t')[0] if rest else '') for a, b, rest in (bb.entries(c, lo, hi) or [])]
    finally:
        bb.close()


def summarise(result, factors_out, region):
    """Per factor: experiments, those with a peak in the window, and per NFR / variant the share of experiments with a
    peak overlapping its span; 'bound here' = factors with a peak over any NFR."""
    nfrs = [n for n in result.get('nfrs') or () if n.get('variants')]
    bound = []
    for f in factors_out:
        exps = f['experiments']
        per = {}
        for n in nfrs:
            spans = {v['name']: (v['L'], v['R']) for v in n['variants']}
            spans['NFR'] = (n['start'], n['end'])
            per[n['id']] = {k: round(sum(1 for e in exps if any(p[0] < b and p[1] > a for p in e['peaks']))/len(exps), 3) if exps else None
                            for k, (a, b) in spans.items()}
        f['overlap'] = per
        best = max((x.get('NFR') or 0 for x in per.values()), default=0)
        if best > 0:
            bound.append(dict(factor=f['factor'], best_share=best, nfrs=[k for k, x in per.items() if (x.get('NFR') or 0) > 0]))
    bound.sort(key=lambda b: -b['best_share'])
    return bound


def _names(values):
    """A set of non-empty names (a list, or one comma-separated string); empty: no filter."""
    if values is None:
        return set()
    if isinstance(values, str):
        values = values.split(',')
    return {str(v).strip() for v in values if str(v).strip()}


def matching(experiments, cell_type_classes=None, cell_types=None):
    """The experiments (index entries [id, antigen, cell type class, cell type]) of the chosen cell type classes and
    cell types (each empty: any)."""
    classes, types = _names(cell_type_classes), _names(cell_types)
    return [e for e in experiments if (not classes or e[2] in classes) and (not types or e[3] in types)]


def facets(genome, factors=None, cell_type_classes=None, cell_types=None):
    """ChIP-Atlas' TF experiments of ``genome`` for the experiment selector: per cell type class and per cell type
    (tissue, developmental stage or cell line, as ChIP-Atlas names them) how many experiments, over the given factors
    (antigens; none: every TF), and how many match the chosen classes / cell types (per factor too)."""
    index = antigen_index(genome)
    if index is None:
        return dict(present=False, genome=genome, total=0, matching=0, cell_type_classes=[], cell_types=[], factors={})
    wanted = [str(f).strip() for f in factors or () if str(f).strip()][:MAX_FACTORS]
    pool = [e for f in wanted for e in index.get(f.lower(), [])] if wanted else [e for v in index.values() for e in v]
    by_class, by_type = {}, {}
    for e in pool:
        by_class[e[2]] = by_class.get(e[2], 0) + 1
        key = (e[2], e[3])
        by_type[key] = by_type.get(key, 0) + 1
    chosen = matching(pool, cell_type_classes, cell_types)
    return dict(
        present=True, genome=genome, total=len(pool), matching=len(chosen),
        cell_type_classes=[dict(key=k, count=v) for k, v in sorted(by_class.items(), key=lambda kv: (-kv[1], kv[0]))],
        cell_types=[dict(key=t, cell_type_class=c, count=v) for (c, t), v in sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0]))],
        factors={f: len(matching(index.get(f.lower(), []), cell_type_classes, cell_types)) for f in wanted})


def submit(state, job_id, result, genome, factors, max_per_factor=MAX_PER_FACTOR, fetch=None, cell_type_classes=None,
           cell_types=None):
    factors = [str(f).strip() for f in factors or () if str(f).strip()][:MAX_FACTORS]
    if not factors:
        raise ValueError('factors: one or more factor names (ChIP-Atlas antigens)')
    max_per_factor = max(1, min(30, int(max_per_factor)))
    index = antigen_index(genome)
    if index is None:
        raise ValueError('ChIP-Atlas experiment list not downloaded yet (about 340 MB, once): open Tracks > ChIP-Atlas, '
                         'or allow the download here.')
    # the experiments of the chosen cell type classes / cell types only, newest first, up to max_per_factor each
    plan = [(f, matching(index.get(f.lower(), []), cell_type_classes, cell_types)[:max_per_factor]) for f in factors]
    selection = dict(cell_type_classes=sorted(_names(cell_type_classes)), cell_types=sorted(_names(cell_types)))
    tid = uuid.uuid4().hex
    total = sum(len(e) for _f, e in plan)
    job = dict(id=tid, job_id=job_id, status='running', done=0, total=total, message='Fetching ChIP-Atlas peaks', genome=genome,
               factors=factors, selection=selection, started=time.time())
    with _lock:
        _jobs[tid] = job
    region = result['region']

    def work():
        out = []
        try:
            for f, exps in plan:
                rec = dict(factor=f, available=len(matching(index.get(f.lower(), []), cell_type_classes, cell_types)),
                           experiments=[])
                for e in exps:
                    try:
                        path = peak_file(genome, e[0], fetch)
                        peaks = read_peaks(path, region['chrom'], region['start'], region['end'])
                        rec['experiments'].append(dict(id=e[0], cell_type_class=e[2], cell_type=e[3], peaks=peaks))
                    except NoPeakFile:
                        # Published without peaks: not counted (as before), said once in the result.
                        rec.setdefault('no_peaks', []).append(e[0])
                    except Exception as error:  # noqa: BLE001 - one unreadable experiment: noted, the rest go on
                        rec.setdefault('failed', []).append(f'{e[0]}: {type(error).__name__}')
                    with _lock:
                        job['done'] += 1
                rec['with_peak'] = sum(1 for x in rec['experiments'] if x['peaks'])
                out.append(rec)
            bound = summarise(result, out, region)
            empty = sorted(x for f in out for x in f.get('no_peaks', ()))
            message = 'ChIP-Atlas peaks ready'
            if empty:
                message += (f"; {len(empty)} experiment{'s' if len(empty) != 1 else ''} without published peaks "
                            f"(q < 1e-5) left out: {', '.join(empty)}")
            with _lock:
                job.update(status='complete', factors_out=out, bound=bound, message=message,
                           finished=time.time(), region=region, no_peaks=empty)
        except Exception as error:  # noqa: BLE001
            with _lock:
                job.update(status='error', message=f'{type(error).__name__}: {error}')
    threading.Thread(target=work, daemon=True, name='chipatlas-peaks').start()
    return status(tid)


def status(tid):
    with _lock:
        job = _jobs.get(tid)
        if job is None:
            raise KeyError(tid)
        return {k: v for k, v in job.items()}


def metadata_status():
    tab = metadata_path()
    return dict(present=os.path.exists(tab), bytes=os.path.getsize(tab) if os.path.exists(tab) else None)
