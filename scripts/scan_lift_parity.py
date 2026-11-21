#!/usr/bin/env python
"""Gate target-frame browser scans against a lifted BAM on the same records.

Inputs are explicit arguments; output contains counts and table names only.
No data locations or molecule identifiers are written to the report.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from types import SimpleNamespace


def compare(source_bam, lifted_bam, map_path, regions, out, *, modules=('fp', 'nfr', 'nuc', 'peaks'), parameters=None):
    import pysam
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    from fiberhmm.scan.reader import ScanDir
    from services.lift.live_lift import LiftSettings, open_lift_map
    from services.scan.live_evidence import input_ids, run_live_units
    handle = open_lift_map(map_path)
    dataset = SimpleNamespace(id='sample', paths=[source_bam], live_lift=SimpleNamespace(
        handle=handle, haplotypes=handle.haplotypes, settings=LiftSettings()))
    state = SimpleNamespace(datasets={dataset.id: dataset})
    inputs = [dict(browser_id=dataset.id, dataset_id='sample', paths=dataset.paths,
                   chemistry=None, content_ids=input_ids(dataset), live_lift=True)]
    with pysam.AlignmentFile(lifted_bam) as bam:
        reference = dict(zip(bam.references, bam.lengths))
    units = plan(reference, regions=regions)
    out = Path(out)
    common = dict(modules=list(modules), params=parameters or {}, annotate=False, cores=4)
    run_live_units(state, inputs, units, runner=run_units, out=out / 'browser-route', **common)
    run_units([dict(dataset_id='sample', paths=[lifted_bam])], units, out=out / 'cli',
              continue_run=(out / 'cli' / 'manifest.json').is_file(), **common)
    a, b = ScanDir(out / 'browser-route'), ScanDir(out / 'cli')
    at, bt = a.manifest['outputs']['tables'], b.manifest['outputs']['tables']
    different = []
    counts = {}
    for rel in sorted(at.keys() | bt.keys()):
        aa = list(a.table(rel).rows()) if a.has(rel) else []
        bb = list(b.table(rel).rows()) if b.has(rel) else []
        counts[rel] = [len(aa), len(bb)]
        if aa != bb:
            different.append(rel)
    return dict(passed=not different, tables=counts, different=different)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('source-bam', 'lifted-bam', 'map', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--region', action='append', required=True)
    p.add_argument('--modules', default='fp,nfr,nuc,peaks')
    p.add_argument('--parameters', help='JSON module parameters')
    args = p.parse_args(argv)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from scripts.lift_parity import scratch_env, parse_region
    scratch_env()
    report = compare(args.source_bam, args.lifted_bam, args.map, [parse_region(r) for r in args.region], args.out,
                     modules=args.modules.split(','), parameters=json.loads(args.parameters) if args.parameters else None)
    Path(args.out).mkdir(parents=True, exist_ok=True)
    (Path(args.out) / 'parity.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
