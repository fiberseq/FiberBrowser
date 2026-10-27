import { describe, expect, it } from 'vitest';
import type { ColorRule } from '../types';
import {
  buildRuleMatchContext,
  footprintMatchesRule,
  getMatchingRuleId,
  nucMarkMatchesRule,
  readMatchesRule,
  ruleHasNucConditions,
} from './ruleMatching';
import { buildNucSizeIndex, nucSizeClassRules, nucSizeMarkFor, type NucSizeMark } from './nucLayers';

function rule(overrides: Partial<ColorRule>): ColorRule {
  return {
    id: 'rule',
    name: 'Rule',
    color: '#ff00ff',
    sizeMin: 1,
    sizeMax: null,
    targetLayers: [],
    conditions: [],
    enabled: true,
    ...overrides,
  };
}

const zByte = (z: number) => Math.max(0, Math.min(254, Math.round(20 * z + 128)));
const mark = (overrides: Partial<NucSizeMark>): NucSizeMark => ({
  start: 100, end: 247, coarse: 2, named: 0, posterior: 230, z: zByte(0), ...overrides,
});

describe('nucleosome rule conditions', () => {
  const ctx = buildRuleMatchContext([], [], [], 0, 2000, []);

  it('knows which rules set one', () => {
    expect(ruleHasNucConditions(rule({}))).toBe(false);
    expect(ruleHasNucConditions(rule({ nucCoarse: [], nucNamed: [], zMin: null, zMax: null, nucTf: null }))).toBe(false);
    expect(ruleHasNucConditions(rule({ nucCoarse: [2] }))).toBe(true);
    expect(ruleHasNucConditions(rule({ nucNamed: [3] }))).toBe(true);
    expect(ruleHasNucConditions(rule({ zMin: -2 }))).toBe(true);
    expect(ruleHasNucConditions(rule({ zMax: 0 }))).toBe(true);
    expect(ruleHasNucConditions(rule({ nucTf: false }))).toBe(true);
    expect(ruleHasNucConditions(rule({ zMin: Number.NaN }))).toBe(false);
  });

  it('coarse classes read the low four bits', () => {
    const mono = rule({ nucCoarse: [2] });
    expect(nucMarkMatchesRule(mono, mark({ coarse: 2 }))).toBe(true);
    expect(nucMarkMatchesRule(mono, mark({ coarse: 2 + 16 }))).toBe(true);
    expect(nucMarkMatchesRule(mono, mark({ coarse: 3 }))).toBe(false);
    expect(nucMarkMatchesRule(rule({ nucCoarse: [3, 4, 5] }), mark({ coarse: 5 }))).toBe(true);
    expect(nucMarkMatchesRule(rule({ nucCoarse: [0] }), mark({ coarse: 0 }))).toBe(true);
  });

  it('named classes match only the named byte', () => {
    const octasome = rule({ nucNamed: [3] });
    expect(nucMarkMatchesRule(octasome, mark({ named: 3 }))).toBe(true);
    expect(nucMarkMatchesRule(octasome, mark({ named: 0 }))).toBe(false);
  });

  it('z bounds are in z units, inclusive, and the missing byte never matches', () => {
    const undersized = rule({ zMax: -2 });
    expect(nucMarkMatchesRule(undersized, mark({ z: zByte(-2.5) }))).toBe(true);
    expect(nucMarkMatchesRule(undersized, mark({ z: zByte(-2) }))).toBe(true);
    expect(nucMarkMatchesRule(undersized, mark({ z: zByte(-1.9) }))).toBe(false);
    expect(nucMarkMatchesRule(undersized, mark({ z: 255 }))).toBe(false);
    const band = rule({ zMin: -1, zMax: 1 });
    expect(nucMarkMatchesRule(band, mark({ z: zByte(0.5) }))).toBe(true);
    expect(nucMarkMatchesRule(band, mark({ z: zByte(1.5) }))).toBe(false);
    expect(nucMarkMatchesRule(band, mark({ z: zByte(-1.5) }))).toBe(false);
    expect(nucMarkMatchesRule(band, mark({ z: 255 }))).toBe(false);
    // Clipped bytes sit at the ends of the range.
    expect(nucMarkMatchesRule(rule({ zMin: 6 }), mark({ z: 254 }))).toBe(true);
    expect(nucMarkMatchesRule(rule({ zMax: -6 }), mark({ z: 0 }))).toBe(true);
  });

  it('the TF flag picks TF calls (or calls overlapping one) or nucleosome calls', () => {
    const tfOnly = rule({ nucTf: true });
    const nucOnly = rule({ nucTf: false });
    const either = rule({ nucTf: null, nucCoarse: [1] });
    expect(nucMarkMatchesRule(tfOnly, mark({ coarse: 1 + 16 }))).toBe(true);
    expect(nucMarkMatchesRule(tfOnly, mark({ coarse: 1 }))).toBe(false);
    expect(nucMarkMatchesRule(nucOnly, mark({ coarse: 1 }))).toBe(true);
    expect(nucMarkMatchesRule(nucOnly, mark({ coarse: 1 + 16 }))).toBe(false);
    expect(nucMarkMatchesRule(either, mark({ coarse: 1 }))).toBe(true);
    expect(nucMarkMatchesRule(either, mark({ coarse: 1 + 16 }))).toBe(true);
  });

  it('all set conditions must hold', () => {
    const r = rule({ nucCoarse: [2], zMax: 0, nucTf: false });
    expect(nucMarkMatchesRule(r, mark({ coarse: 2, z: zByte(-1) }))).toBe(true);
    expect(nucMarkMatchesRule(r, mark({ coarse: 2, z: zByte(1) }))).toBe(false);
    expect(nucMarkMatchesRule(r, mark({ coarse: 2 + 16, z: zByte(-1) }))).toBe(false);
    expect(nucMarkMatchesRule(r, mark({ coarse: 3, z: zByte(-1) }))).toBe(false);
  });

  it('a rule with a nucleosome condition never matches an item without a mark', () => {
    const r = rule({ nucCoarse: [2] });
    expect(footprintMatchesRule(100, 247, 147, r, ctx, 'nuc')).toBe(false);
    expect(footprintMatchesRule(100, 247, 147, r, ctx, 'nuc', undefined, undefined, null)).toBe(false);
    expect(footprintMatchesRule(100, 247, 147, r, ctx, 'nuc', undefined, undefined, mark({}))).toBe(true);
    expect(nucMarkMatchesRule(rule({ nucTf: false }), null)).toBe(false);
  });

  it('rules without nucleosome conditions behave as before, mark or not', () => {
    const nuc = rule({ sizeMin: 90 });
    for (const m of [undefined, null, mark({ coarse: 1 + 16, z: 255 })]) {
      expect(footprintMatchesRule(100, 247, 147, nuc, ctx, 'nuc', undefined, undefined, m)).toBe(true);
      expect(footprintMatchesRule(100, 150, 50, nuc, ctx, 'nuc', undefined, undefined, m)).toBe(false);
    }
  });

  it('size and layer gates still apply to nucleosome rules', () => {
    const r = rule({ nucCoarse: [2], sizeMin: 120, targetLayers: ['tf'] });
    expect(footprintMatchesRule(100, 247, 147, r, ctx, 'tf', undefined, undefined, mark({}))).toBe(true);
    expect(footprintMatchesRule(100, 247, 147, r, ctx, 'nuc', undefined, undefined, mark({}))).toBe(false);
    expect(footprintMatchesRule(100, 200, 100, r, ctx, 'tf', undefined, undefined, mark({}))).toBe(false);
  });

  it('two reads with the same span but different marks do not share a cached answer', () => {
    // The match cache is shared by every read in view and keyed by span.
    const withPeak = rule({ nucCoarse: [2], conditions: [{ target: 'region', regionStart: 0, regionEnd: 2000 }] });
    const shared = buildRuleMatchContext([], [], [], 0, 2000, [withPeak]);
    expect(footprintMatchesRule(100, 247, 147, withPeak, shared, 'nuc', undefined, undefined, mark({ coarse: 2 }))).toBe(true);
    expect(footprintMatchesRule(100, 247, 147, withPeak, shared, 'nuc', undefined, undefined, mark({ coarse: 3 }))).toBe(false);
    expect(footprintMatchesRule(100, 247, 147, withPeak, shared, 'nuc', undefined, undefined, mark({ coarse: 2 }))).toBe(true);
  });

  it('the template colours each class and skips TF calls', () => {
    const rules = nucSizeClassRules();
    const first = (m: NucSizeMark | null) => getMatchingRuleId(100, 247, 147, rules, ctx, m);
    expect(first(mark({ coarse: 1 }))).toBe('nuc-size-1');
    expect(first(mark({ coarse: 3 }))).toBe('nuc-size-3');
    expect(first(mark({ coarse: 6 }))).toBe('nuc-size-6');
    expect(first(mark({ coarse: 1 + 16 }))).toBeNull();
    expect(first(null)).toBeNull();
  });
});

describe('readMatchesRule with nucleosome conditions', () => {
  const ctx = buildRuleMatchContext([], [], [], 0, 2000, []);
  const nucsz = {
    intervals: [[100, 247, 147], [300, 330, 30], [600, 900, 300]] as [number, number, number][],
    quality_names: ['coarse', 'named', 'posterior', 'z'],
    qualities: [[2, 1 + 16, 4], [0, 0, 0], [230, 230, 230], [zByte(0), zByte(-3), 255]],
  };
  const read = {
    id: 'r',
    // The multi(2) call [600, 900) split at a deletion: each piece keeps its call's size (sv_events.py
    // split_compact_read_at_deletions), the molecular length its mark carries.
    intervals: [[0, 100, -100], [100, 247, 147], [600, 740, 300], [760, 900, 300]] as [number, number, number][],
    layers: { tf: { intervals: [[300, 330, 30]] as [number, number, number][] }, nucsz },
  };

  it('reads the marks of primary items, split ones included, and of TF calls', () => {
    expect(readMatchesRule(read, rule({ nucCoarse: [2] }), ctx)).toBe(true);
    // The multi(2) call is split at a deletion: each piece finds the call's mark.
    expect(readMatchesRule(read, rule({ nucCoarse: [4] }), ctx)).toBe(true);
    expect(readMatchesRule(read, rule({ nucTf: true }), ctx)).toBe(true);
    expect(readMatchesRule(read, rule({ nucCoarse: [3] }), ctx)).toBe(false);
  });

  it('matches nothing on a read without size marks', () => {
    expect(readMatchesRule({ ...read, layers: { tf: read.layers.tf } }, rule({ nucCoarse: [2] }), ctx)).toBe(false);
  });

  it('looks pieces of one call up to one mark', () => {
    const index = buildNucSizeIndex(nucsz)!;
    expect(nucSizeMarkFor(index, 600, 740)).toBe(nucSizeMarkFor(index, 760, 900));
  });
});
