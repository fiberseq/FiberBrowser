import '../testSetup';
import { describe, expect, it } from 'vitest';
import {
  CLASS_COLORS, SAVED_LOCI, SAVED_MAX, addSaved, caption, cartoonModel, candidateEvidence, classKey, identifyVerdict,
  insertProfile, slimResult, type IdentifyResult, type TeCall,
} from './identifyModel';
import { jockeyFull, jockeyTruncated, roo } from './identifyFixtures.test-data';

describe('identify: caption and cartoon from the numb insertions', () => {
  it('roo: full length, − strand, LTRs boxed at both ends, 5-bp TSD', () => {
    expect(caption(roo)).toBe('full-length roo (LTR/Bel-Pao), − strand, 5-bp TSD');
    const m = cartoonModel(roo, false);
    const te = m.body.find(s => s.kind === 'te')!;
    expect(te.arrow).toBe('left');
    expect(te.jagged).toBeNull();
    expect(te.color).toBe(CLASS_COLORS.LTR);
    expect(m.body[0].kind).toBe('tsd');
    const ltrs = m.features.filter(f => f.kind === 'ltr').sort((a, b) => a.x0 - b.x0);
    expect(ltrs).toHaveLength(2);
    expect(ltrs[0].x0).toBeLessThan(500);
    expect(ltrs[1].x1).toBeGreaterThan(roo.length - 10);
    expect(m.features.some(f => f.kind === 'orf')).toBe(true);
  });

  it('reversed lens: mirrored, the element points the other way, the caption says + strand', () => {
    const m = cartoonModel(roo, true);
    expect(m.body.find(s => s.kind === 'te')!.arrow).toBe('right');
    expect(m.body.find(s => s.kind === 'tsd')!.x1).toBe(roo.length);
    expect(m.caption).toContain('+ strand');
  });

  it('full-length jockey with a poly(A) tail', () => {
    expect(caption(jockeyFull)).toBe('full-length jockey (LINE/Jockey), + strand, 12-bp TSD, poly(A) tail');
    const m = cartoonModel(jockeyFull, false);
    expect(m.body.map(s => s.kind)).toEqual(['tsd', 'te', 'polyA']);
    expect(m.body[1].color).toBe(CLASS_COLORS.LINE);
  });

  it('5′-truncated jockey: jagged on its 5′ (left) end only', () => {
    expect(caption(jockeyTruncated)).toContain('5′-truncated jockey (LINE/Jockey), + strand');
    const te = cartoonModel(jockeyTruncated, false).body.find(s => s.kind === 'te')!;
    expect(te.jagged).toBe('left');
    expect(cartoonModel(jockeyTruncated, true).body.find(s => s.kind === 'te')!.jagged).toBe('right');
  });

  it('unmatched stretches are grey, uncertain and say why', () => {
    const novel = {
      ...jockeyTruncated, te: { library: null, calls: [] }, tsd: null,
      genome: { ...jockeyTruncated.genome, loci: [], genes: [], copies: 0, n_loci: 0 },
      segments: [{ kind: 'unknown', qstart: 0, qend: 388, label: 'no match' }],
      summary: 'novel sequence: no match in the genome (388 bp)',
    } as IdentifyResult;
    const m = cartoonModel(novel, false);
    expect(m.body).toHaveLength(1);
    expect(m.body[0].uncertain).toBe(true);
    expect(m.body[0].title).toMatch(/No match in the genome/);
    expect(m.caption).toBe('novel sequence: no match in the genome (388 bp)');
  });

  it('gene fragments are labelled with the gene and exon', () => {
    const gene = {
      ...jockeyTruncated, te: { library: null, calls: [] }, tsd: null,
      genome: { ...jockeyTruncated.genome, genes: [{ gene: 'numb', transcript: 'tx', strand: '+', chrom: 'chr2L', gene_start: 1, gene_end: 9,
        exons: [3], n_exons: 6, exonic_bp: 300, intronic_bp: 0, query: [[0, 300]], identity: 98.5, spliced: false, region: 'exon' }] },
      segments: [{ kind: 'gene', qstart: 0, qend: 300, label: 'numb exon 3', gene: 'numb', identity: 98.5, strand: '+' }],
    } as IdentifyResult;
    expect(caption(gene)).toBe('fragment of numb exon 3');
    expect(cartoonModel(gene, false).body[0].label).toBe('numb exon 3');
  });
});

describe('identify: classes, sessions, profile', () => {
  it('maps class names to colour keys', () => {
    expect(classKey('LTR')).toBe('LTR');
    expect(classKey('LINE')).toBe('LINE');
    expect(classKey('RC')).toBe('RC');
    expect(classKey('DNA')).toBe('DNA');
    expect(classKey(null)).toBe('Unknown');
  });

  it('caps what sessions save', () => {
    const big = { ...roo, genome: { ...roo.genome, loci: Array.from({ length: 300 }, () => roo.genome.loci[0]) } } as IdentifyResult;
    expect(slimResult(big).genome.loci).toHaveLength(SAVED_LOCI);
    let saved = {};
    for (let i = 0; i < SAVED_MAX + 3; i++) {
      saved = addSaved(saved, `k${i}`, { seqSha: 'x', at: `2026-10-03T00:00:${String(i).padStart(2, '0')}Z`, result: roo });
    }
    expect(Object.keys(saved)).toHaveLength(SAVED_MAX);
    expect(saved).not.toHaveProperty('k0');
    expect(saved).toHaveProperty(`k${SAVED_MAX + 2}`);
  });

  it('takes the insert part of a lens profile, in display order', () => {
    // total 30: flank 10 | insert 10 | flank 10; one value per base.
    const values = Array.from({ length: 30 }, (_, i) => (i >= 10 && i < 20 ? (i - 10) / 10 : 0));
    const axis = { flank: 10, displayLen: 10, total: 30, reversed: false };
    const out = insertProfile(values, axis, 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBeCloseTo(0.05);
    expect(out[4]).toBeCloseTo(0.85);
  });
});

describe('identify: candidates, not identifications (docs/identify.md)', () => {
  it('results saved before verdicts get one: the numb roo and jockeys are confident candidates', () => {
    for (const r of [roo, jockeyFull, jockeyTruncated]) {
      expect(r.verdict).toBeUndefined();
      expect(identifyVerdict(r).status).toBe('candidate');
    }
    expect(identifyVerdict(roo).candidates).toEqual(['roo']);
    const evidence = candidateEvidence(roo);
    expect(evidence[0]).toBe('roo: 98.8% identity, 100% of the insert, 100% of the element');
    expect(evidence[1]).toContain('TE library: D. melanogaster TE canonical set v10.2');
    expect(evidence[1]).toContain('genome: dm6');
  });

  it('a server verdict is used as it is', () => {
    const v = { status: 'ambiguous', source: 'te', candidates: ['a', 'b'], reason: 'r',
      thresholds: { min_identity: 80, min_query_coverage: 0.5, ambiguous_bitscore_fraction: 0.05, ambiguous_min_overlap: 0.5 } } as const;
    expect(identifyVerdict({ ...roo, verdict: { ...v, candidates: [...v.candidates] } }).status).toBe('ambiguous');
  });

  const top = roo.te.calls[0];
  const withCalls = (calls: TeCall[]) => ({ ...roo, te: { ...roo.te, calls } }) as IdentifyResult;

  it('another family within 5% over the same bases: ambiguous; elsewhere or 10% lower: not', () => {
    const rival = { ...top, family: 'hobo', bitscore: top.bitscore * 0.97 };
    expect(identifyVerdict(withCalls([top, rival])).status).toBe('ambiguous');
    expect(identifyVerdict(withCalls([top, rival])).candidates).toEqual(['roo', 'hobo']);
    expect(identifyVerdict(withCalls([top, { ...rival, bitscore: top.bitscore * 0.9 }])).status).toBe('candidate');
    expect(identifyVerdict(withCalls([top, { ...rival, family: 'roo (LTR)' }])).status).toBe('candidate');
    expect(identifyVerdict(withCalls([{ ...top, query: [[0, 4000]] }, { ...rival, query: [[4000, 9184]] }])).status).toBe('candidate');
  });

  it('below 80% identity or half the insert, and no genome match: no confident match', () => {
    const none = { ...roo, genome: { ...roo.genome, loci: [], genes: [], rmsk_family: null } } as IdentifyResult;
    const weak = { ...none, te: { ...roo.te, calls: [{ ...top, query_coverage: 0.3 }] } } as IdentifyResult;
    const v = identifyVerdict(weak);
    expect(v.status).toBe('no_match');
    expect(v.reason).toContain('30% of the insert');
    expect(identifyVerdict({ ...none, te: { ...roo.te, calls: [] } } as IdentifyResult).reason).toMatch(/^no match in the genome or the TE library/);
  });

  it('the best candidate is the best-ranked one that passes; RepeatMasker names only from passing copies (as the server)', () => {
    const none = { ...roo, genome: { ...roo.genome, loci: [], genes: [], rmsk_family: null } } as IdentifyResult;
    const a = { ...top, family: 'famA', identity: 99, query_coverage: 0.49 };
    const b = { ...top, family: 'famB', identity: 85, query_coverage: 0.6, bitscore: top.bitscore * 0.5 };
    const v = identifyVerdict({ ...none, te: { ...roo.te, calls: [a, b] } } as IdentifyResult);
    expect([v.status, v.candidates]).toEqual(['candidate', ['famB']]);
    const weak = { chrom: 'chr3', strand: '+', start: 5, end: 900, qstart: 0, qend: 900, qcov: 0.9, identity: 79, evalue: 0, bitscore: 900, near_site: null,
      rmsk: { name: 'WEAK', class: 'LTR', family: 'x', class_label: 'LTR/x', fraction: 1 } } as const;
    const good = { ...weak, chrom: 'chr2', start: 10, identity: 95, qcov: 1, rmsk: undefined };
    const g = identifyVerdict({ ...none, te: { ...roo.te, calls: [] },
      genome: { ...none.genome, loci: [weak, good], rmsk_family: { name: 'WEAK', class_label: 'LTR/x', class: 'LTR', loci: 1 } } } as unknown as IdentifyResult);
    expect([g.source, g.candidates]).toEqual(['genome', ['chr2:11']]);
  });
});
