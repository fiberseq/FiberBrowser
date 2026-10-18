import { describe, expect, it } from 'vitest';
import auditCases from '../../../../../../tests/data/sv_p0_evidence.json';
import {
  arcHeight, bodyClipRects, clampMinSvLen, clusterAtBandX, clusterAtCursor, clusterForEvent, eventsMatch, formatSvSize,
  labelFits, readCarriesCluster, readSvDraw, readSvEventAt, rowLabelFontPx, subtractSpans, supportingReadIds,
  svAlleleLabel, svEvidenceLevel, visibleSvSummary, isMinorCluster, placeSvLabels,
  clusterHitSpan, clipPileAtBandX, describeSvCluster, svBandMetrics, SV_MIN_HIT_PX,
} from './svDrawing';
import type { CompactRead, SvCluster, SvSummary } from './types';

const DEL: SvCluster = { id: 'D:10000:1500', t: 'D', ref: 10_000, len: 1500, end: 11_500, support: 13, informative: 21, sa_support: 3 };
const INS: SvCluster = { id: 'I:14000:400', t: 'I', ref: 14_000, len: 400, end: 14_000, support: 9, informative: 19, sa_support: 0 };
const SUMMARY: SvSummary = { min_len: 50, margin: 100, scope: 'all', n_reads: 24, clusters: [DEL, INS], clips: [{ side: 'R', ref: 10_000, n: 3 }] };

const read = (id: string, sv: CompactRead['sv']): CompactRead => ({ id, intervals: [[0, 100, -100]], sv });

it('describes and inspects retained sub-cutoff CIGAR evidence once per molecule', () => {
  const c = { ...INS, ref: 1000, end: 1000, len: 60, support: 2, informative: 2 };
  const seed = read('seed', [{ t: 'I', ref: 1000, len: 60, q: 100 }]);
  const near: CompactRead = { ...read('near', undefined), sv_evidence: [{ t: 'I', ref: 1000, len: 48, q: 100 }] };
  expect(describeSvCluster(c, null, [seed, near, near], 'chr1').cigar).toBe('CIGAR 60I in 1 read, 48I in 1');
  expect(readSvEventAt(near, 1000, 10, 10)?.len).toBe(48);
});

describe('SV labels', () => {
  it('formats sizes as the owner asked: −1.8 kb, +312', () => {
    expect(formatSvSize('D', 1800)).toBe('−1.8 kb');
    expect(formatSvSize('I', 312)).toBe('+312');
    expect(formatSvSize('D', 312)).toBe('−312');
    expect(formatSvSize('I', 25_400)).toBe('+25 kb');
    expect(svAlleleLabel('D', 9_999, 1800, 'chr2L')).toBe('DEL 1.8 kb @ chr2L:10,000');
    expect(svAlleleLabel('I', 0, 400, 'chr2L')).toBe('INS 400 bp @ chr2L:1');
  });

  it('labels only where they fit; no text in short rows', () => {
    expect(labelFits('−1.5 kb', 30)).toBe(false);
    expect(labelFits('−1.5 kb', 60)).toBe(true);
    expect(rowLabelFontPx(4)).toBe(0);
    expect(rowLabelFontPx(8)).toBe(7);
    expect(rowLabelFontPx(30)).toBe(10);
  });

  it('clamps the min size', () => {
    expect(clampMinSvLen(3)).toBe(10);
    expect(clampMinSvLen('abc')).toBe(50);
    expect(clampMinSvLen(2e7)).toBe(1_000_000);
  });
});

describe('what a read draws', () => {
  const r = read('r', [
    { t: 'S', side: 'L', ref: 9_000, len: 80, q: 0 },
    { t: 'D', ref: 10_000, len: 1500, q: 1000 },
    { t: 'I', ref: 14_000, len: 40, q: 4000 },
    { t: 'SA', chrom: 'chr', pos: 1, strand: '+', mapq: 60, nm: 0, cigar_ref_len: 10, supp: false },
  ]);

  it('converts absolute events to the view and applies the min size', () => {
    const d = readSvDraw(r, 9_500, 15_000, 50);
    expect(d.deletions).toEqual([{ start: 500, end: 2000, len: 1500 }]);
    expect(d.insertions).toEqual([]);  // 40 bp < 50
    expect(d.clips).toEqual([]);       // out of view
    expect(readSvDraw(r, 8_000, 15_000, 30).insertions).toEqual([{ pos: 6000, len: 40, q: 4000, ref: 14_000 }]);
    // A deletion running off the view is still drawn (its visible part).
    expect(readSvDraw(r, 11_000, 12_000, 50).deletions).toEqual([{ start: -1000, end: 500, len: 1500 }]);
  });

  it('breaks the body at deletions, forward and reversed', () => {
    expect(subtractSpans(0, 100, [{ start: 40, end: 60 }])).toEqual([[0, 40], [60, 100]]);
    expect(subtractSpans(0, 100, [{ start: -10, end: 30 }, { start: 90, end: 200 }])).toEqual([[30, 90]]);
    const fwd = bodyClipRects({ start: 0, end: 1000 }, [{ start: 300, end: 700 }], 1000, rel => 10 + rel);
    expect(fwd).toEqual([{ x: 10, w: 300 }, { x: 710, w: 300 }]);
    const rev = bodyClipRects({ start: 0, end: 1000 }, [{ start: 300, end: 700 }], 1000, rel => 10 + (1000 - rel));
    expect(rev).toEqual([{ x: 710, w: 300 }, { x: 10, w: 300 }]);
    // A body wholly inside a deletion draws nothing.
    expect(bodyClipRects({ start: 400, end: 600 }, [{ start: 300, end: 700 }], 1000, rel => rel)).toEqual([]);
  });

  it('finds the read event under the pointer', () => {
    expect(readSvEventAt(r, 10_700, 5, 50)?.t).toBe('D');
    expect(readSvEventAt(r, 14_003, 5, 30)?.t).toBe('I');
    expect(readSvEventAt(r, 14_003, 5, 50)).toBeNull();
  });
});

describe('clusters', () => {
  it('hides single-read and two-read calls and clips by default, with a support override', () => {
    const summary = { ...SUMMARY, clusters: [DEL, { ...INS, support: 1 }, { ...INS, id: 'two', support: 2 }],
      clips: [{ side: 'R' as const, ref: 100, n: 1 }, { side: 'L' as const, ref: 200, n: 3 }] };
    expect(visibleSvSummary(summary, 50)?.clusters).toEqual([DEL]);
    expect(visibleSvSummary(summary, 50)?.clips).toEqual([summary.clips[1]]);
    expect(visibleSvSummary(summary, 50, 1)).toEqual(summary);
    expect(visibleSvSummary({ ...summary, clusters: [{ ...INS, support: 1 }], clips: [summary.clips[0]] }, 50)).toBeNull();
    expect(summary.clusters).toHaveLength(3);
  });

  it('matches the server tolerance: max(20 bp, 5%) breakpoints, 20% length', () => {
    expect(eventsMatch('D', 1070, 1500, 1000, 1500)).toBe(true);
    expect(eventsMatch('D', 1080, 1500, 1000, 1500)).toBe(false);
    expect(eventsMatch('D', 1000, 80, 1015, 80)).toBe(true);
    expect(eventsMatch('D', 1000, 80, 1025, 80)).toBe(false);
    expect(eventsMatch('I', 1000, 300, 1000, 400)).toBe(false);
    expect(eventsMatch('I', 1000, 330, 1005, 400)).toBe(true);
  });

  it('knows a carrier by CIGAR or by clip + SA segment', () => {
    const cigar = read('a', [{ t: 'D', ref: 10_010, len: 1495, q: 0 }]);
    const split = read('b', [{ t: 'S', side: 'R', ref: 10_004, len: 2000, q: 4000 },
      { t: 'SA', chrom: 'chrSV', pos: 11_497, strand: '+', mapq: 60, nm: 0, cigar_ref_len: 2000, supp: false }]);
    const other = read('c', [{ t: 'D', ref: 10_000, len: 600, q: 0 }]);
    expect(readCarriesCluster(cigar, DEL)).toBe(true);
    expect(readCarriesCluster(split, DEL, 'chrSV')).toBe(true);
    expect(readCarriesCluster(split, DEL, 'chrX')).toBe(true);
    expect(readCarriesCluster(other, DEL)).toBe(false);
    expect(supportingReadIds([cigar, split, other, read('d', undefined)], DEL, 'chrSV')).toEqual(['a', 'b']);
  });

  it('picks the cluster at the cursor by support, and under a band pixel', () => {
    const small: SvCluster = { ...DEL, id: 'small', ref: 10_500, len: 200, end: 10_700, support: 2 };
    const summary = { ...SUMMARY, clusters: [DEL, small, INS] };
    expect(clusterAtCursor(summary, 10_600)?.id).toBe(DEL.id);   // largest support under the cursor
    expect(clusterAtCursor(summary, 14_010)?.id).toBe(INS.id);
    expect(clusterAtCursor(summary, 12_500)).toBeNull();
    const toX = (rel: number) => rel / 10;  // view starts at 9_000
    expect(clusterAtBandX(summary, (10_600 - 9_000) / 10, 9_000, toX)?.id).toBe('small');  // the narrowest arc wins
    expect(clusterAtBandX(summary, (14_000 - 9_000) / 10 + 3, 9_000, toX)?.id).toBe(INS.id);
    expect(clusterForEvent(summary, { t: 'D', ref: 10_020, len: 1490, q: 0 }).id).toBe(DEL.id);
    expect(clusterForEvent(summary, { t: 'D', ref: 20_000, len: 90, q: 0 }).support).toBe(1);
  });

  it('hides the band when nothing in view passes the min size', () => {
    expect(visibleSvSummary(SUMMARY, 50)?.clusters).toHaveLength(2);
    expect(visibleSvSummary(SUMMARY, 500)?.clusters.map(c => c.id)).toEqual([DEL.id]);
    expect(visibleSvSummary({ ...SUMMARY, clips: [] }, 5000)).toBeNull();
    expect(visibleSvSummary(null, 50)).toBeNull();
    expect(arcHeight(DEL, 13, 22)).toBe(22);
    expect(arcHeight(INS, 13, 22)).toBeLessThan(22);
  });
});

describe('SA strand', () => {
  it('an inverted SA segment cannot confirm a deletion', () => {
    const clip = { t: 'S' as const, side: 'R' as const, ref: 10_004, len: 2000, q: 4000 };
    const seg = { t: 'SA' as const, chrom: 'chrSV', pos: 11_497, strand: '-' as const, mapq: 60, nm: 0, cigar_ref_len: 2000, supp: false };
    expect(svEvidenceLevel(read('a', [clip, { ...seg, same_strand: true }]), DEL, 'chrSV')).toBe('putative');
    expect(svEvidenceLevel(read('b', [clip, { ...seg, same_strand: false }]), DEL, 'chrSV')).toBe('putative');
  });
});

describe('SV band labels (integration fb33)', () => {
  const measure = (t: string) => t.length * 5;
  it('never prints two labels over each other: the stronger wins, the weaker tries its short text', () => {
    const placed = placeSvLabels([
      { texts: ['+86 45/2308', '45/2308'], x: 100, y: 10, align: 'left', priority: 45, color: 'p' },
      { texts: ['+86 2201/2369', '2201/2369'], x: 90, y: 10, align: 'left', priority: 2201, color: 'p' },
      { texts: ['+5.0 kb 2741/3055'], x: 400, y: 10, align: 'left', priority: 2741, color: 'p' },
    ], measure);
    expect(placed.map(p => p.text)).toEqual(['+5.0 kb 2741/3055', '+86 2201/2369']);
    const lower = placeSvLabels([
      { texts: ['long label here', 'short'], x: 0, y: 10, align: 'left', priority: 1, color: 'p' },
      { texts: ['winner'], x: 30, y: 10, align: 'left', priority: 9, color: 'p' },
    ], measure);
    expect(lower.map(p => p.text)).toEqual(['winner']);
    const apart = placeSvLabels([
      { texts: ['a label'], x: 0, y: 10, align: 'left', priority: 1, color: 'p' },
      { texts: ['b label'], x: 0, y: 30, align: 'left', priority: 2, color: 'p' },
    ], measure);
    expect(apart).toHaveLength(2);
  });

  it('fades clusters far weaker than the strongest in view', () => {
    expect(isMinorCluster(1, 1795)).toBe(true);
    expect(isMinorCluster(45, 2201)).toBe(false);
    expect(isMinorCluster(1, 10)).toBe(false);  // a shallow view keeps every cluster
  });
});

// fb-n11-tracks: the owner could not tell whether the faint grey SVs did anything.
describe('faint SV clusters: hit targets and what they are', () => {
  const STRONG: SvCluster = { id: 'D:strong', t: 'D', ref: 10_000, len: 1500, end: 11_500, support: 3000, informative: 3600, sa_support: 0 };
  const FAINT_DEL: SvCluster = { id: 'D:faint', t: 'D', ref: 12_000, len: 60, end: 12_060, support: 1, informative: 40, sa_support: 0 };
  const FAINT_INS: SvCluster = { id: 'I:faint', t: 'I', ref: 13_000, len: 55, end: 13_000, support: 1, informative: 40, sa_support: 0 };
  const JITTER: SvCluster = { id: 'D:jitter', t: 'D', ref: 12_008, len: 62, end: 12_070, support: 2, informative: 40, sa_support: 0 };
  const summary: SvSummary = { min_len: 50, margin: 100, scope: 'all', n_reads: 3600, clusters: [STRONG, FAINT_DEL, FAINT_INS, JITTER], clips: [{ side: 'L', ref: 14_000, n: 4 }] };
  const toX = (rel: number) => rel / 100;  // 100 bp a pixel: a 60 bp deletion is under a pixel wide

  it('gives every glyph, the faint ones too, a hit box at least SV_MIN_HIT_PX wide', () => {
    expect(SV_MIN_HIT_PX).toBeGreaterThanOrEqual(8);
    for (const c of [FAINT_DEL, FAINT_INS]) {
      const [a, b] = clusterHitSpan(c, 0, toX);
      expect(b - a).toBeGreaterThanOrEqual(SV_MIN_HIT_PX);
    }
    // 4 px off a 0.6 px faint deletion still hits it (a strong arc elsewhere doesn't steal it).
    const x = toX(12_030);
    expect(clusterAtBandX(summary, x + 4, 0, toX)?.id).toMatch(/faint|jitter/);
    expect(clusterAtBandX(summary, toX(13_000) + 6, 0, toX, 7)?.id).toBe('I:faint');   // on its flag
    expect(clusterAtBandX(summary, toX(13_000) - 4.5, 0, toX, 7)?.id).toBe('I:faint'); // just left of it
    expect(clipPileAtBandX(summary, toX(14_000) + 3, 0, toX)).toEqual(summary.clips[0]);
    expect(clipPileAtBandX(summary, toX(14_000) + 20, 0, toX)).toBeNull();
    // Faint clusters are de-emphasised, not shrunk: the arc keeps at least 35% of the row.
    expect(isMinorCluster(FAINT_DEL.support, STRONG.support)).toBe(true);
    expect(arcHeight(FAINT_DEL, STRONG.support, 100)).toBeGreaterThanOrEqual(35);
  });

  it('says what a faint cluster is: type, size, breakpoints, support, CIGAR, faint and jitter', () => {
    const reads: CompactRead[] = [
      read('a', [{ t: 'D', ref: 12_000, len: 60, q: 5 }]),
      read('b', [{ t: 'D', ref: 12_004, len: 61, q: 9 }]),
    ];
    const d = describeSvCluster(FAINT_DEL, summary, reads, 'chr2L');
    expect(d.title).toBe('DEL 60 bp');
    expect(d.where).toBe('chr2L:12,001–12,060 (breakpoints vary by 4 bp)');
    expect(d.sizes).toBe('Sizes 60–61 bp');
    expect(d.support).toMatch(/^1 confirmed of 40 informative (loaded reads|reads in view)/);
    expect(d.cigar).toBe('CIGAR 60D in 1 read, 61D in 1');
    expect(d.faint).toContain('weak next to the strongest SV in view (1 vs 3,000 reads)');
    expect(d.jitter).toContain('aligner jitter: 1 other deletion cluster of similar size within 8 bp');
    expect(d.example?.readId).toBe('a');
    // A strong one is not faint, and an insertion says where it goes in.
    expect(describeSvCluster(STRONG, summary, [], 'chr2L').faint).toBe('');
    const ins = describeSvCluster(FAINT_INS, summary, [read('i', [{ t: 'I', ref: 13_000, len: 55, q: 40 }])], 'chr2L');
    expect(ins.title).toBe('INS 55 bp');
    expect(ins.where).toBe('after chr2L:13,000');
    expect(ins.example?.event.t).toBe('I');
    // Support only by clips / split reads: it says so.
    expect(describeSvCluster(STRONG, summary, [], 'chr2L').cigar).toContain('by clips / split reads');
  });

  it('scales the glyphs with the row height', () => {
    expect(svBandMetrics(24).flagW).toBeLessThan(svBandMetrics(120).flagW);
    expect(svBandMetrics(120).inner).toBeGreaterThan(svBandMetrics(44).inner);
    expect(svBandMetrics(44).inner + svBandMetrics(44).labelRoom + 3).toBe(44);
  });
});

// The same anonymous local-evidence snapshots are checked by test_sv_events.py.
// A display cutoff must never remove allele evidence from highlighting.

describe('P0 audited carrier parity', () => {
  for (const fixture of auditCases) {
    for (const cutoff of fixture.name === 'alu' ? [50, 2000] : [50]) {
      it(`${fixture.name} at ${cutoff} bp: highlights the backend molecule set`, () => {
        const cluster = { ...fixture.target, id: '', end: fixture.target.ref } as SvCluster;
        const reads = fixture.reads.map(r => ({
          ...r, intervals: [],
          sv: r.sv.filter(e => e.len >= cutoff),
          sv_evidence: r.sv,
        })) as CompactRead[];
        expect(supportingReadIds([...reads, ...reads], cluster, fixture.chrom, 'confirmed').sort()).toEqual([...fixture.evidence_expected.confirmed].sort());
        expect(supportingReadIds(reads, cluster, fixture.chrom).sort()).toEqual([...fixture.evidence_expected.confirmed, ...fixture.evidence_expected.putative].sort());
      });
    }
  }

  it('keeps insertion clip rules aligned with the backend, including hard clips', () => {
    const c = { ...INS, ref: 1000, len: 10_000 };
    for (const side of ['L', 'R'] as const) {
      expect(svEvidenceLevel(read('hard', [{ t: 'S', ref: 1050, len: 50, q: 0, side, h: 1 }]), c)).toBe('putative');
      expect(readCarriesCluster(read('short', [{ t: 'S', ref: 1000, len: 49, q: 0, side }]), c)).toBe(false);
      expect(readCarriesCluster(read('far', [{ t: 'S', ref: 1051, len: 500, q: 0, side }]), c)).toBe(false);
    }
  });

  it('can highlight evidence even when no event survives the glyph cutoff', () => {
    const r = { id: 'clipped', intervals: [], sv_evidence: [{ t: 'S', side: 'R', ref: INS.ref, len: 50, q: 0 }] } as CompactRead;
    expect(svEvidenceLevel(r, INS)).toBe('putative');
    expect(supportingReadIds([r, r], INS)).toEqual(['clipped']);
    expect(readSvDraw(r, 0, 20000, 2000).clips).toEqual([]);
  });
});
