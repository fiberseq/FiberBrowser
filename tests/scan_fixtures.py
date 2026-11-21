"""Small fiberhmm-scan directories for the hub tests, written without FiberHMM (scan contract fiberhmm.scan.v1).

``write_scan_dir`` writes a manifest and bgzip + tabix tables (``fp`` hits, values and states) for one dataset
file. ``multi_locus_daf_bam`` joins FiberHMM's synthetic DAF locus (``fiberhmm.scan.testing``) at several
offsets of one long contig, so a grid scan has features in several units and across zone boundaries.
"""
from __future__ import annotations

import json
from pathlib import Path

COMMON = ['chrom', 'start', 'end', 'idx_start', 'idx_end']


def write_table(path: Path, columns, rows, contig_order):
    import pysam
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: (contig_order[r[0]], r[3], r[4], [str(x) for x in r[5:]]))
    plain = path.with_suffix('')
    with open(plain, 'w') as handle:
        handle.write('#' + '\t'.join(COMMON + list(columns)) + '\n')
        for r in rows:
            handle.write('\t'.join('' if x is None else str(x) for x in r) + '\n')
    pysam.tabix_compress(str(plain), str(path), force=True)
    plain.unlink()
    pysam.tabix_index(str(path), seq_col=0, start_col=3, end_col=4, zerobased=True, force=True, meta_char='#')
    return len(rows)


def row(chrom, start, end, *cells):
    a, b = (start, end) if end > start else (start, start + 1)
    return [chrom, start, end, a, b, *cells]


def write_scan_dir(out: Path, bam_path: str, *, contig='chrT', length=100_000, hits=(), states=(), values=(),
                   dataset_id='dataset_1', content_id=None, scan_id='0123456789abcdef'):
    """``hits``: (start, end, hit_id, label); ``values``: (hit_id, start, end, group, kind, name, value, n);
    ``states``: (hit_id, start, end, qname, record, state)."""
    from services.scan.identity import content_id as cid_of
    out.mkdir(parents=True, exist_ok=True)
    order = {contig: 0}
    tables = {}
    hit_cols = ['hit_id', 'type', 'anchor', 'strand', 'unit_id', 'score', 'label', 'flags', 'parent_id', 'class_id']
    n = write_table(out / 'fp' / 'hits.tsv.bgz', hit_cols,
                    [row(contig, s, e, h, 'fp.class', (s + e) // 2, '.', f'{contig}:0-{length}', '0.5', lab,
                         'zero_width' if e == s else '', '', lab) for s, e, h, lab in hits], order)
    tables['fp/hits.tsv.bgz'] = dict(rows=n, sha256='')
    n = write_table(out / 'fp' / 'values.tsv.bgz',
                    ['hit_id', 'group', 'group_kind', 'value_name', 'value', 'lo', 'hi', 'n_molecules', 'n_callable'],
                    [row(contig, s, e, h, g, k, name, v, '', '', nm, nm) for h, s, e, g, k, name, v, nm in values], order)
    tables['fp/values.tsv.bgz'] = dict(rows=n, sha256='')
    if states:
        n = write_table(out / 'fp' / 'states.tsv.bgz', ['hit_id', 'dataset_id', 'qname', 'record', 'molecule', 'state'],
                        [row(contig, s, e, h, dataset_id, q, rec, 'mol:v1 0', st) for h, s, e, q, rec, st in states], order)
        tables['fp/states.tsv.bgz'] = dict(rows=n, sha256='')
    n = write_table(out / 'units.tsv.bgz', ['unit_id', 'zone_start', 'zone_end', 'mode', 'status', 'records'],
                    [row(contig, 0, length, f'{contig}:0-{length}', 0, length, 'bed', 'done', 10)], order)
    tables['units.tsv.bgz'] = dict(rows=n, sha256='')
    manifest = {
        'schema': 'fiberhmm.scan.v1', 'scan_id': scan_id, 'fiberhmm': {'version': '3.1.0'},
        'reference': {'contigs': [[contig, length]], 'contigs_sha256': 'x' * 64}, 'frame': {'kind': 'linear'},
        'datasets': [{'dataset_id': dataset_id, 'ordinal': 0, 'chemistry': None,
                      'files': [{'name': Path(bam_path).name, 'path': str(bam_path), 'input_index': 0,
                                 'content_id': content_id or cid_of(bam_path), 'size': 1}]}],
        'read_policy': {'filters': {}, 'caps': {}, 'callable_min_molecules': 5},
        'units': {'mode': 'bed', 'unit_bp': 50000, 'stride_bp': 25000, 'grid_offset': 0, 'contigs': None,
                  'regions': None, 'bed': 'units.bed', 'bed_sha256': None, 'merged': [], 'count': 1},
        'modules': {'fp': {'version': '1.0', 'experimental': False, 'reconcile': 'anchor', 'settings': {},
                           'settings_hash': 'abcdabcdabcdabcd',
                           'feature_types': [{'type_id': 'fp.class', 'module': 'fp', 'label': 'Footprint class',
                                              'plural': 'Footprint classes', 'provides': ['hit', 'state'],
                                              'anchor': 'centre', 'zero_width': False,
                                              'scores': [{'name': 'prevalence', 'label': 'Prevalence', 'kind': 'fraction',
                                                          'better': 'high', 'per_group': True}],
                                              'state_rule': '1 member', 'columns': ['class_id']}],
                           'ma_groups': [{'group': 'fpcls', 'group_version': 1, 'kind': 'state',
                                          'quality_names': ['state', 'p', 'tier'],
                                          'state_codes': {'1': 'member', '2': 'non-member', '3': 'abstain'}}]}},
        'outputs': {'annotate': False, 'annotated': [], 'tables': tables},
        'status': {'units_total': 1, 'units_done': 1, 'units_failed': [], 'seams_open': 0},
    }
    (out / 'manifest.json').write_text(json.dumps(manifest))
    return out


def tiny_bam(path: Path, contig='chrT', length=100_000, reads=(('m1/1/ccs', 1000, 0),)):
    """A coordinate-sorted, indexed BAM: (qname, start, flag) records of 500 bp."""
    import pysam
    header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': contig, 'LN': length}],
              'CO': ['fiberhmm:coord=molecular']}
    with pysam.AlignmentFile(str(path), 'wb', header=header) as out:
        for qname, start, flag in sorted(reads, key=lambda r: r[1]):
            a = pysam.AlignedSegment()
            a.query_name, a.flag, a.reference_id, a.reference_start = qname, flag, 0, start
            a.mapping_quality, a.cigarstring, a.query_sequence = 60, '500M', 'A' * 500
            out.write(a)
    pysam.index(str(path))
    return str(path)


def multi_locus_daf_bam(path: Path, *, offsets=(3_000, 22_000, 47_500, 76_000, 104_000), seed=3, reads=40,
                        contig='chrT', length=140_000):
    """FiberHMM's synthetic DAF locus copied to several offsets of one contig (needs fiberhmm.scan)."""
    import pysam
    from fiberhmm.scan.testing import write_daf_locus_bam
    from fiberhmm.io.bam_header import append_chemistry
    tmp = Path(str(path) + '.parts')
    tmp.mkdir(parents=True, exist_ok=True)
    header = pysam.AlignmentHeader.from_dict(dict(HD={'VN': '1.6', 'SO': 'coordinate'},
                                                  SQ=[{'SN': contig, 'LN': length}], CO=['fiberhmm:coord=molecular']))
    header = append_chemistry(header, dict(assay='daf', enzyme='ddda', platform='pacbio', mode='daf'))
    recs = []
    for i, off in enumerate(offsets):
        part = write_daf_locus_bam(tmp / f'p{i}.bam', seed=seed + i, reads=reads)
        with pysam.AlignmentFile(part) as bam:
            for r in bam.fetch(until_eof=True):
                d = r.to_dict()
                d['ref_name'] = contig
                d['ref_pos'] = str(int(d['ref_pos']) + off)
                d['name'] = f'm{seed}{i}/{r.query_name.split("/")[1]}/ccs'
                recs.append(pysam.AlignedSegment.from_dict(d, header))
    recs.sort(key=lambda r: r.reference_start)
    with pysam.AlignmentFile(str(path), 'wb', header=header) as out:
        for r in recs:
            out.write(r)
    pysam.index(str(path))
    return str(path)
