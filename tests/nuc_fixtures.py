"""Synthetic Hia5 PacBio chromatin for the nucleosome-panel tests (written with pysam only).

``chromatin_bam`` writes molecules over one contig: a dyad map with regular arrays (190 and 172 bp repeats) and
irregular stretches, molecules of 8-12 kb every ``step`` bp (a third of them reverse), nucleosome calls as MA
``nuc.QQQ`` in molecular coordinates, MSPs as ``msp.``, m6A marks on A bases in linkers (MM/ML), alternating HP
tags, and a FiberHMM ``@PG`` declaring molecular coordinates. FiberHMM's nuc module decodes it as it decodes a
real FiberHMM-called BAM (the same construction as FiberHMM's own nuc scan tests).
"""
from __future__ import annotations

import array
from pathlib import Path

import numpy as np

COMP = str.maketrans('ACGT', 'TGCA')
ARRAYS_190 = ((20_000, 27_000), (38_000, 45_000), (54_000, 60_000))
ARRAYS_172 = ((95_000, 102_000), (116_000, 122_000))


def revcomp(s: str) -> str:
    return s.translate(COMP)[::-1]


def header(contig: str, length: int) -> dict:
    pg = {'ID': 'fiberhmm-call', 'PN': 'fiberhmm-call', 'VN': '3.0.2',
          'CL': 'fiberhmm-call -i in.bam -o out.bam --enzyme hia5 --seq pacbio',
          'DS': 'FiberHMM fused apply+recall; coord=molecular; mode=pacbio-fiber'}
    return {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': contig, 'LN': length}], 'PG': [pg]}


def _mm(mol_seq: str, marks) -> tuple:
    a_pos = [i for i, b in enumerate(mol_seq) if b == 'A']
    marks = set(int(m) for m in marks)
    skips, mls, run = [], [], 0
    for p in a_pos:
        if p in marks:
            skips.append(run)
            mls.append(250)
            run = 0
        else:
            run += 1
    return 'A+a.' + ''.join(f',{s}' for s in skips) + ';', array.array('B', mls)


def _record(out, name, mol_seq, ref_start, nucs, msps, marks, reverse, hp):
    import pysam
    L = len(mol_seq)
    r = pysam.AlignedSegment(out.header)
    r.query_name = name
    r.flag = 16 if reverse else 0
    r.reference_id = 0
    r.reference_start = ref_start
    r.mapping_quality = 60
    r.cigarstring = f'{L}M'
    r.query_sequence = revcomp(mol_seq) if reverse else mol_seq
    r.query_qualities = array.array('B', [30] * L)
    groups, aq = [], []
    if nucs:
        groups.append('nuc.QQQ:' + ','.join(f'{s + 1}-{e - s}' for s, e in sorted(nucs)))
        aq += [200, 255, 255] * len(nucs)
    if msps:
        groups.append('msp.:' + ','.join(f'{s + 1}-{e - s}' for s, e in sorted(msps)))
    r.set_tag('MA', ';'.join([str(L)] + groups))
    if aq:
        r.set_tag('AQ', array.array('B', aq))
    mm, ml = _mm(mol_seq, marks)
    r.set_tag('MM', mm)
    r.set_tag('ML', ml)
    r.set_tag('HP', hp)
    return r


def chromatin_bam(path, *, contig: str = 'chrS', length: int = 160_000, step: int = 900, seed: int = 21,
                  offset: int = 0) -> str:
    """Write and index the BAM; ``offset`` shifts every molecule (and the dyad map) along the contig."""
    import pysam
    rng = np.random.default_rng(seed)
    span = length - offset
    dyads, pos = [], 2_000.0
    while pos < span - 2_000:
        if any(a <= pos < b for a, b in ARRAYS_190):
            pos += 190 + rng.normal(0, 3)
        elif any(a <= pos < b for a, b in ARRAYS_172):
            pos += 172 + rng.normal(0, 3)
        else:
            pos += rng.uniform(150, 300)
        dyads.append(pos)
    dyads = np.array(dyads)
    genome = ''.join(rng.choice(list('ACGT'), size=span))
    recs = []
    for k, start in enumerate(range(0, span - 9_000, step)):
        L = min(int(rng.integers(8_000, 12_000)), span - start)
        ref_seq = genome[start:start + L]
        dd = dyads[(dyads > start + 80) & (dyads < start + L - 80)] - start
        nucs_ref = [(int(d - 73), int(d + 74)) for d in dd]
        rev = k % 3 == 1
        mol_seq = revcomp(ref_seq) if rev else ref_seq
        nucs = sorted([(L - e, L - s) for s, e in nucs_ref] if rev else nucs_ref)
        occ = np.zeros(L, bool)
        for s, e in nucs:
            occ[s:e] = True
        a = np.array([b == 'A' for b in mol_seq])
        marks = np.flatnonzero(a & ~occ & (rng.random(L) < 0.55))
        marks = marks[(marks >= 12) & (marks < L - 12)]
        msps, p = [], 0
        for s, e in nucs:
            if s > p:
                msps.append((p, s))
            p = e
        if p < L:
            msps.append((p, L))
        recs.append((offset + start, f'm{seed}/{5000 + k}/ccs', mol_seq, nucs, msps, marks, rev, 1 + k % 2))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(path), 'wb', header=header(contig, length)) as out:
        for start, name, mol_seq, nucs, msps, marks, rev, hp in recs:
            out.write(_record(out, name, mol_seq, start, nucs, msps, marks, rev, hp))
    pysam.index(str(path))
    return str(path)
