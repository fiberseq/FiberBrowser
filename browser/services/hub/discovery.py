"""Rediscover pooled NFR anchors on one physical-molecule hash half."""
from __future__ import annotations

from tempfile import TemporaryDirectory


def discover_anchors(molecules, source_scan, regions, *, cancel=None, progress=None):
    """Run the source scan's NFR module on exactly the discovery records.

    The held-out helper chooses the opposite half for inference. No hit from
    the full-data scan is reused as a discovery result.
    """
    from fiberhmm.scan import run_units
    from fiberhmm.scan.reader import ScanDir
    from fiberhmm.scan.units import plan
    from .assoc import AssocInputError, Cancelled
    if not molecules:
        return []
    inputs = {}
    for mol in molecules:
        meta = mol.meta
        if 'record' not in meta:
            raise AssocInputError('Held-out discovery needs complete source records')
        inputs.setdefault(meta['dataset'], {}).update(enumerate(meta.get('headers') or []))
        inputs[meta['dataset']][meta['input_index']] = meta['record'].header
    # Keep original input indices, including files without discovery records.
    datasets = []
    for ds, by_input in sorted(inputs.items()):
        if set(by_input) != set(range(max(by_input) + 1)):
            raise AssocInputError('Held-out discovery requires a header for every input file')
        datasets.append(dict(dataset_id=ds, headers=[by_input[i] for i in sorted(by_input)]))
    reference = dict(zip(molecules[0].meta['record'].header.references, molecules[0].meta['record'].header.lengths))
    if regions is None:
        info = source_scan.manifest['units']
        if info.get('mode') == 'grid':
            units = plan(reference, zones=info['zones']) if info.get('zones') else plan(reference, genome=True, contigs=info.get('contigs'))
        else:
            units = plan(reference, regions=[(r[0], r[1], r[2]) for r in info.get('merged') or info.get('regions') or []])
    else:
        units = plan(reference, regions=regions)
    evidence = ((m.meta['dataset'], m.meta['input_index'], m.meta['record']) for m in molecules)
    from services.scan.live_evidence import ScanCancellation
    with TemporaryDirectory(prefix='hub-discovery-') as out:
        try:
            run_units(datasets, units, modules=['nfr'],
                      params={'nfr': source_scan.manifest['modules']['nfr']['settings']},
                      read_policy=source_scan.manifest['read_policy'], evidence=evidence,
                      out=out, annotate=False, cores=1, progress=progress,
                      cancel=ScanCancellation(cancel) if cancel else None)
        except (KeyboardInterrupt, ValueError):
            if cancel and cancel():
                raise Cancelled() from None
            raise
        scan = ScanDir(out)
        return sorted({(r['chrom'], int(r['anchor'])) for r in scan.table('nfr/hits.tsv.bgz').rows()
                       if r['type'] == 'nfr.region'})


def discovery_regions(scan):
    """Completed scan territory, independent of which full-data hits were found."""
    from .assoc_inputs import merge_regions
    table = scan.tables.table('units.tsv.bgz')
    if table is None:
        raise ValueError('Held-out discovery needs the scan unit table')
    return merge_regions((row['chrom'], int(row.get('zone_start') or row['start']),
                          int(row.get('zone_end') or row['end']))
                         for row in table.rows() if row.get('status') == 'done')
