import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORMAP } from '../types';
import { buildRuleMatchContext, readMatchesRule } from './ruleMatching';
import {
  NUC_COARSE_CLASSES,
  NUC_SIZE_CLASS_COLORS,
  NUC_UNDRAWN_LAYERS,
  buildNucSegRows,
  buildNucSizeIndex,
  describeNucSegRow,
  describeNucSizeMark,
  isNucScalarGroup,
  nucCoarseCode,
  nucCoarseIsTf,
  nucCoarseName,
  nucMissingTriangle,
  nucNamedName,
  nucPosteriorFromByte,
  nucSegColor,
  nucSegLaneGeometry,
  nucSegName,
  nucSegRows,
  nucSegRowsAt,
  nucSizeClassRules,
  nucSizeIndex,
  nucSizeMarkAt,
  nucSizeMarkFor,
  nucUndersizedBar,
  nucZFromByte,
} from './nucLayers';

const zByte = (z: number) => Math.max(0, Math.min(254, Math.round(20 * z + 128)));

describe('nucsz codes', () => {
  it('reads coarse codes, the TF bit, named codes, z and posterior bytes', () => {
    expect(nucCoarseCode(2)).toBe(2);
    expect(nucCoarseCode(2 + 16)).toBe(2);
    expect(nucCoarseIsTf(2)).toBe(false);
    expect(nucCoarseIsTf(1 + 16)).toBe(true);
    expect(nucCoarseName(0)).toBe("can't tell");
    expect(nucCoarseName(4)).toBe('multi (2)');
    expect(nucCoarseName(6)).toBe('edge-truncated');
    expect(nucNamedName(0)).toBeNull();
    expect(nucNamedName(3)).toBe('octasome');
    expect(nucZFromByte(128)).toBe(0);
    expect(nucZFromByte(zByte(-2))).toBe(-2);
    expect(nucZFromByte(255)).toBeNull();
    expect(nucPosteriorFromByte(255)).toBe(1);
  });

  it('describes a mark for the hover', () => {
    expect(describeNucSizeMark({ start: 0, end: 147, coarse: 2, named: 0, posterior: 235, z: zByte(-0.4) }))
      .toBe('mono · z −0.4 · P 92%');
    expect(describeNucSizeMark({ start: 0, end: 30, coarse: 1 + 16, named: 1, posterior: 255, z: 255 }))
      .toBe('short · small · z missing · P 100% · TF call or overlaps one');
  });
});

describe('the size-class template', () => {
  it('has one rule per coarse code on nucleosome calls, in the agreed colours', () => {
    const rules = nucSizeClassRules();
    expect(rules).toHaveLength(NUC_COARSE_CLASSES.length);
    const byCode = Object.fromEntries(rules.map(rule => [rule.nucCoarse![0], rule]));
    expect(byCode[1].color).toBe('#f59e0b');
    expect(byCode[2].color).toBe('#16a34a');
    expect(byCode[3].color).toBe('#0d9488');
    expect(byCode[4].color).toBe('#2563eb');
    expect(byCode[5].color).toBe('#7c3aed');
    expect(byCode[0].color).toBe('#9ca3af');
    expect(byCode[6].color).toBe('#d1d5db');
    for (const rule of rules) {
      expect(rule.nucTf).toBe(false);
      expect(rule.color).toBe(NUC_SIZE_CLASS_COLORS[rule.nucCoarse![0]]);
      expect(rule.sizeMin).toBe(1);
      expect(rule.sizeMax).toBeNull();
      expect(rule.conditions).toEqual([]);
    }
    expect(new Set(rules.map(rule => rule.id)).size).toBe(rules.length);
  });

  it('leaves the default colormap without nucleosome rules', () => {
    for (const rule of DEFAULT_COLORMAP.rules) {
      expect(rule.nucCoarse ?? rule.nucNamed ?? rule.zMin ?? rule.zMax ?? rule.nucTf).toBeUndefined();
    }
    expect(DEFAULT_COLORMAP.rules.map(rule => rule.id)).toEqual(['pol2', 'tf', 'subnuc', 'fire', 'nuc']);
  });
});

describe('the nucsz index', () => {
  const layer = {
    // Out of order on purpose; one TF call overlapping a nucleosome.
    intervals: [[400, 547, 147], [100, 247, 147], [200, 220, 20], [700, 1000, 300]] as [number, number, number][],
    quality_names: ['coarse', 'named', 'posterior', 'z'],
    qualities: [[2, 2, 1 + 16, 4], [0, 0, 0, 0], [200, 210, 220, 230], [128, 140, 60, 255]],
  };

  it('finds the mark with the identical span', () => {
    const index = buildNucSizeIndex(layer)!;
    expect(nucSizeMarkFor(index, 400, 547)?.posterior).toBe(200);
    expect(nucSizeMarkFor(index, 200, 220)?.coarse).toBe(1 + 16);
  });

  it('gives the pieces of a split call the mark containing their midpoints', () => {
    const index = buildNucSizeIndex(layer)!;
    // A 300 bp call split at a deletion into two items.
    expect(nucSizeMarkFor(index, 700, 820)?.coarse).toBe(4);
    expect(nucSizeMarkFor(index, 880, 1000)?.coarse).toBe(4);
  });

  it('prefers the mark overlapping the item most where marks overlap', () => {
    const index = buildNucSizeIndex(layer)!;
    // Midpoint 210 is inside both the nucleosome (100-247) and the TF call (200-220).
    expect(nucSizeMarkFor(index, 120, 300)?.coarse).toBe(2);
    expect(nucSizeMarkFor(index, 202, 218)?.coarse).toBe(1 + 16);
  });

  it('has no mark where none covers the item', () => {
    const index = buildNucSizeIndex(layer)!;
    expect(nucSizeMarkFor(index, 250, 390)).toBeNull();
    expect(nucSizeMarkFor(null, 400, 547)).toBeNull();
  });

  it('is null without qualities, and built once per payload object', () => {
    expect(buildNucSizeIndex({ intervals: layer.intervals })).toBeNull();
    expect(nucSizeIndex(undefined)).toBeNull();
    expect(nucSizeIndex(layer)).toBe(nucSizeIndex(layer));
  });

  it('reads q0..q3 by position like the named bytes', () => {
    const legacy = { ...layer, quality_names: ['q0', 'q1', 'q2', 'q3'] };
    expect(nucSizeMarkFor(buildNucSizeIndex(legacy), 400, 547)?.z).toBe(128);
  });

  it('returns the smallest mark at a position (hover)', () => {
    const index = buildNucSizeIndex(layer)!;
    expect(nucSizeMarkAt(index, 210)?.coarse).toBe(1 + 16);
    expect(nucSizeMarkAt(index, 150)?.coarse).toBe(2);
    expect(nucSizeMarkAt(index, 300)).toBeNull();
  });
});

describe('clipped overlapping footprints keep their own class', () => {
  // A mono nucleosome [100, 247, 147] overlapping a short TF call [200, 220, 20], viewed at 205-215: both clip to
  // [0, 10) and differ only by molecular length.
  const clipped = {
    intervals: [[0, 10, 147], [0, 10, 20]] as [number, number, number][],
    quality_names: ['coarse', 'named', 'posterior', 'z'],
    qualities: [[2 + 16, 1 + 16], [0, 0], [200, 210], [128, 60]],
  };

  it('keeps each mark\'s molecular length and matches on span and length', () => {
    const index = buildNucSizeIndex(clipped)!;
    expect(index.marks.map(m => m.len).sort((a, b) => a! - b!)).toEqual([20, 147]);
    expect(nucSizeMarkFor(index, 0, 10, 20)?.coarse).toBe(1 + 16);
    expect(nucSizeMarkFor(index, 0, 10, 147)?.coarse).toBe(2 + 16);
  });

  it('an ambiguous span gives no class rather than another footprint\'s', () => {
    const index = buildNucSizeIndex(clipped)!;
    expect(nucSizeMarkFor(index, 0, 10)).toBeNull();
    expect(nucSizeMarkFor(index, 0, 10, 99)).toBeNull();
    // Marks with the same bytes are not ambiguous.
    const same = buildNucSizeIndex({ ...clipped, qualities: [[2, 2], [0, 0], [200, 200], [128, 128]] })!;
    expect(nucSizeMarkFor(same, 0, 10)?.coarse).toBe(2);
    // A piece of a clipped call (midpoint lookup) is told apart by length too.
    expect(nucSizeMarkFor(index, 2, 8, 20)?.coarse).toBe(1 + 16);
    expect(nucSizeMarkFor(index, 2, 8, 147)?.coarse).toBe(2 + 16);
    expect(nucSizeMarkFor(index, 2, 8)).toBeNull();
  });

  it('hover takes the shorter footprint where clipped spans tie', () => {
    expect(nucSizeMarkAt(buildNucSizeIndex(clipped), 5)?.len).toBe(20);
  });

  it('a TF item never takes the overlapping nucleosome\'s class in rule matching', () => {
    const read = { id: 'r1', intervals: [] as [number, number, number][],
      layers: { tf: { intervals: [[0, 10, 20]] as [number, number, number][] }, nucsz: clipped } };
    const ctx = buildRuleMatchContext([], [], [], 0, 10, []);
    const mono = nucSizeClassRules().find(r => r.nucCoarse?.[0] === 2)!;
    // Rule matching passes the item's molecular length: the TF item gets its own short TF class, never the
    // overlapping nucleosome's mono class.
    expect(readMatchesRule(read, mono, ctx)).toBe(false);
    expect(readMatchesRule(read, { ...mono, nucTf: null }, ctx)).toBe(false);
    expect(readMatchesRule(read, { ...mono, nucCoarse: [1], nucTf: true }, ctx)).toBe(true);
  });
});

describe('nucseg rows', () => {
  const layer = {
    intervals: [[0, 800, 800], [800, 1200, 400], [1200, 1500, 300], [1500, 2000, 500], [300, 450, 150], [1000, 1100, 100]] as [number, number, number][],
    quality_names: ['code', 'posterior_or_llr10', 'q_hat_minus_100_or_count'],
    qualities: [[1, 2, 4, 3, 17, 16], [230, 200, 140, 0, 51, 255], [87, 0, 0, 0, 2, 3]],
  };

  it('splits segment rows from event rows', () => {
    const rows = buildNucSegRows(layer)!;
    expect(rows.segments.map(r => r.code)).toEqual([1, 2, 4, 3]);
    expect(rows.events.map(r => r.code)).toEqual([17, 16]);
    expect(nucSegRows(layer)).toBe(nucSegRows(layer));
    expect(buildNucSegRows({ intervals: layer.intervals })).toBeNull();
  });

  it('names states and events, and reads q-hat and LLR for the hover', () => {
    expect(nucSegName(1)).toBe('regular');
    expect(nucSegName(2)).toBe('disordered');
    expect(nucSegName(3)).toBe('low information');
    expect(nucSegName(4)).toBe('undetermined');
    expect(nucSegName(16)).toBe('undersized footprint run');
    expect(nucSegName(17)).toBe('missing nucleosome');
    const rows = buildNucSegRows(layer)!;
    const at350 = nucSegRowsAt(rows, 350);
    expect(describeNucSegRow(at350.segment!)).toBe('regular · P 90% · q̂ 187 bp');
    expect(at350.events.map(describeNucSegRow)).toEqual(['missing nucleosome · LLR 5.1 · 2 marks']);
    const at1050 = nucSegRowsAt(rows, 1050);
    expect(describeNucSegRow(at1050.segment!)).toBe('disordered · P 78%');
    expect(describeNucSegRow(at1050.events[0])).toBe('undersized footprint run · LLR 25.5+ · 3 footprints');
    expect(describeNucSegRow(nucSegRowsAt(rows, 1300).segment!)).toBe('undetermined · mean P(regular) 55%');
    expect(nucSegRowsAt(rows, 2500)).toEqual({ segment: null, events: [] });
  });

  it('colours every state and event, distinctly, in light and dark', () => {
    for (const dark of [false, true]) {
      const colors = [1, 2, 3, 4, 16, 17].map(code => nucSegColor(code, dark));
      expect(new Set(colors).size).toBe(colors.length);
      for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(nucSegColor(1, false)).not.toBe(nucSegColor(1, true));
  });
});

describe('the segment lane', () => {
  it('is the bottom 1-3 px of the row body, and absent below 2 px', () => {
    expect(nucSegLaneGeometry(0, 1)).toBeNull();
    expect(nucSegLaneGeometry(0, 2)).toEqual({ y: 1, h: 1, gapAbove: false, markers: false });
    expect(nucSegLaneGeometry(10, 5)).toEqual({ y: 14, h: 1, gapAbove: false, markers: false });
    expect(nucSegLaneGeometry(0, 6)).toEqual({ y: 4, h: 2, gapAbove: false, markers: true });
    expect(nucSegLaneGeometry(0, 20)).toEqual({ y: 17, h: 3, gapAbove: true, markers: true });
    expect(nucSegLaneGeometry(0, 99)?.h).toBe(3);
  });

  it('places event marks inside or just above it', () => {
    const lane = nucSegLaneGeometry(0, 20)!;
    expect(nucUndersizedBar(lane)).toEqual({ y: 17, h: 2 });
    expect(nucUndersizedBar(nucSegLaneGeometry(0, 3)!)).toEqual({ y: 2, h: 1 });
    expect(nucMissingTriangle(lane, 50)).toEqual([[47.5, 13], [52.5, 13], [50, 17]]);
    expect(nucMissingTriangle(nucSegLaneGeometry(0, 4)!, 50)).toBeNull();
  });
});

describe('layers that are never drawn', () => {
  it('covers the nucleosome marks, segments and scalar groups', () => {
    for (const name of ['nucsz', 'nucseg', 'nucmol', 'nfrmol']) expect(NUC_UNDRAWN_LAYERS.has(name)).toBe(true);
    expect(NUC_UNDRAWN_LAYERS.has('nuc')).toBe(false);
    expect(isNucScalarGroup('nucmol')).toBe(true);
    expect(isNucScalarGroup('nfrmol')).toBe(true);
    expect(isNucScalarGroup('nucsz')).toBe(false);
  });
});
