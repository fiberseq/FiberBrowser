"""Legacy job facades over frozen results, with stable hub mappings and scan-directory hit tables.

No inference is repeated on import: curation, scored populations, filters and active ids remain owned by the
legacy jobs. The facade projects their viewed results; per-molecule states keep using the legacy resolvers.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

# The public analysis-kind table also documents the session migration's coverage.
LEGACY_TYPES = {'consensus': 'fp.class', 'fp-class': 'fp.class', 'accessibility': 'nfr.region',
                'nfr': 'nfr.region', 'nfr-variant': 'nfr.variant', 'peaks': 'peaks.peak',
                'sv': 'var.sv', 'differences': 'var.diff', 'graph': 'graph.bubble', 'snp': 'var.snp'}


def _entry(job_id, element, dataset, type_id, chrom, start, end, label=None):
    kind = {'fp.class': 'fp-class', 'nfr.region': 'nfr', 'nfr.variant': 'nfr-variant'}[type_id]
    set_id = f'browser:{kind}:{job_id}'
    hit_id = f'{kind}:{job_id}:{element}'
    row = dict(jobId=job_id, family=element, datasetId=dataset, setId=set_id, hitId=hit_id,
                typeId=type_id, chrom=chrom, start=math.floor(start), end=math.ceil(end),
                anchor=math.floor((start + end) / 2), label=label or element,
                legacyRef=dict(kind=kind, source=job_id, id=element, datasetId=dataset,
                               chrom=chrom, start=start, end=end))
    if kind != 'fp-class':
        row['legacyRef'].pop('datasetId')
    return row


def _rows(kind, job):
    result = job['result']
    if kind == 'consensus':
        from services.consensus_workflow import viewed_result, viewing_final
        result = viewed_result(job)
        region = result['manifest']['region']
        from services.oriented_regions import catalog_sources, genomic_interval
        sources = catalog_sources(result)
        rows = []
        curation = job.get('_curation') or {}
        snapshots = curation.get('snapshots') or []
        cursor = curation.get('cursor', 0)
        snapshot = snapshots[cursor] if viewing_final(job) and 0 <= cursor < len(snapshots) else {}
        ignored = snapshot.get('ignored_families') or {}
        for dataset, ds in result.get('datasets', {}).items():
            source = sources.get(dataset)
            families = list(ds.get('cr', {}).get('catalog', []))
            # Curation's display hulls are summaries of the immutable calls, as in the legacy panel.
            for group in snapshot.get('manual_groups', []):
                if group.get('dataset_id') in (dataset, '__shared_families__'):
                    families.append(dict(group, consensus_start=group['display_start'], consensus_end=group['display_end']))
            for f in families:
                family = f.get('family') or f.get('group_id')
                if f.get('ignored') or family in ignored.get(dataset, []) or family in ignored.get('__shared_families__', []):
                    continue
                if f.get('consensus_start') is None or f.get('consensus_end') is None:
                    continue
                chrom, start, end = region['chrom'], f['consensus_start'], f['consensus_end']
                if source:
                    chrom = source['window']['chrom']
                    start, end = genomic_interval((start, end), source)
                elif chrom == 'oriented_BED':
                    raise ValueError('This matched run lacks genomic window provenance; its legacy panel still restores')
                row = _entry(job['job_id'], family, source['dataset_id'] if source else dataset,
                             'fp.class', chrom, start, end, f.get('label'))
                row['detail'] = dict(recaller=f.get('recaller'), manual=bool(f.get('manual')), view_stage=job.get('view_stage'))
                if source:
                    # Separate placements of one family share the same legacy family identity.
                    row['hitId'] += ':' + dataset
                    row['legacyRef']['datasetId'] = dataset
                    row['hasStates'] = False
                    row['note'] = 'Matched-window class: genomic placement shown; use its legacy panel for per-read states'
                rows.append(row)
        return rows
    region = result.get('region') or job.get('request', {})
    rows = []
    for dataset in job.get('request', {}).get('dataset_ids', []):
        for n in result.get('nfrs', []):
            rows.append(_entry(job['job_id'], n['id'], dataset, 'nfr.region', region['chrom'],
                               min([n['start'], *(v['L'] for v in n.get('variants', []))]),
                               max([n['end'], *(v['R'] for v in n.get('variants', []))])))
            for v in n.get('variants', []):
                rows.append(_entry(job['job_id'], v['id'], dataset, 'nfr.variant', region['chrom'], v['L'], v['R'], v.get('name')))
    return rows


def _write_facade(state, kind, job, mappings):
    """A scan-compatible hit snapshot beside the job's artifacts. It never replaces the engine's manifest."""
    from fiberhmm.scan.tables import COMMON, TableWriter
    curation = job.get('_curation') or {}
    payload = dict(kind=kind, job_id=job['job_id'], mappings=mappings, filters=job.get('filters'),
                   execution_scan=job.get('execution_scan'),
                   view_stage=job.get('view_stage'), curation={k: curation.get(k) for k in ('revision', 'cursor')})
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    directory = Path(job['artifact_dir']) / 'hub-scan' / digest[:20]
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text())
        if old.get('legacy_digest') == digest:
            return str(directory)
    directory.mkdir(parents=True, exist_ok=True)
    contigs = sorted({r['chrom'] for r in mappings})
    lengths = {c.name: c.size for c in getattr(state, 'chroms', []) if hasattr(c, 'size')}
    reference = [[c, lengths[c]] for c in contigs if c in lengths]
    order = {c: i for i, c in enumerate(contigs)}
    module = 'fp' if kind == 'consensus' else 'nfr'
    path = directory / module / 'hits.tsv.bgz'
    writer = TableWriter(path, (*COMMON, 'hit_id', 'type', 'anchor', 'strand', 'unit_id', 'score', 'label', 'flags', 'parent_id'), order)
    seen = set()
    for r in mappings:
        if r['hitId'] in seen:
            continue
        seen.add(r['hitId'])
        writer.add(r['chrom'], r['start'], r['end'], (r['hitId'], r['typeId'], r['anchor'], '.', job['job_id'], None, r['label'], '', ''))
    table = writer.close()
    types = sorted({r['typeId'] for r in mappings})
    manifest = dict(schema='fiberhmm.scan.v1', scan_id=f"legacy:{kind}:{job['job_id']}", legacy_digest=digest,
                    frame={'kind': 'linear'}, reference={'contigs': reference},
                    datasets=[], units={'mode': 'bed'}, read_policy={},
                    modules={module: dict(version='legacy', settings_hash=digest, feature_types=[dict(type_id=t, module=module,
                        label=t, plural=t, provides=['hit'], anchor='centre', zero_width=False, scores=[]) for t in types])},
                    outputs={'annotate': False, 'tables': {f'{module}/hits.tsv.bgz': table}},
                    legacy=dict(job_id=job['job_id'], kind=kind, state_resolver='legacy', mappings=mappings),
                    execution=dict(engine=job.get('execution_engine', 'legacy'), scan=job.get('execution_scan')))
    # Publish manifest last. Readers cannot see a complete snapshot before its tables exist.
    tmp = directory / 'manifest.tmp'
    tmp.write_text(json.dumps(manifest, sort_keys=True))
    tmp.replace(manifest_path)
    return str(directory)


def legacy_runs(state):
    """All completed runs, including ones whose panels are closed. Safe to call after pack import hooks."""
    runs, problems = [], []
    for kind, attr, lock_attr in (('consensus', 'consensus_workflow_jobs', 'consensus_workflow_lock'),
                                   ('accessibility', 'accessibility_jobs', 'accessibility_lock')):
        jobs = state.__dict__.get(attr, {})
        if not jobs:
            continue
        lock = state.__dict__.get(lock_attr)
        # Both legacy stores use an RLock. Conversion must see a consistent curated view.
        if lock is None:
            from contextlib import nullcontext
            lock = nullcontext()
        with lock:
            for job in list(jobs.values()):
                if job.get('status') != 'complete' or not job.get('result'):
                    continue
                try:
                    mappings = _rows(kind, job)
                    directory = _write_facade(state, kind, job, mappings)
                    run = dict(kind=kind, jobId=job['job_id'], path=directory, mappings=mappings,
                               executionEngine=job.get('execution_engine', 'legacy'),
                               active=kind == 'consensus' and state.__dict__.get('consensus_workflow_active') == job['job_id'])
                    job['hub'] = dict(path=directory, mappings=mappings)
                    runs.append(run)
                except Exception as error:
                    # A migration problem must never stop a legacy panel restoring.
                    problems.append(dict(kind=kind, jobId=job.get('job_id'), error=str(error)))
    return dict(runs=runs, problems=problems)
