/**
 * Quantify-window usability fixes (fix/window-quant-ux):
 * - nice x ticks (1-2-5 steps, whole numbers, about one per 60–90 px; 0 at a relative anchor);
 * - a window typed or dragged relative to an anchor gives the same numbers as the same window in genome bp, for plus-
 *   and minus-strand genes, with the view flipped or not, and on a meta-locus (anchor at the site);
 * - a click that does not move never arms a drag.
 */
import { describe, expect, it } from 'vitest';
import { axisTicks, genomicToRelative, resolveAnchor, X_TICK_TARGET_PX, type ResolvedAnchor } from './axisFrame';
import { effectiveBounds, normalizeQuantWindow, windowGenomic } from './spec';
import { bpToPx, pxToBp } from './WindowBand';
import { buildGroups, computeQuant } from './engine';
import { poolLayerData } from './sources';
import { DEFAULT_QUANT_SPEC, normalizeQuantSpec } from './spec';
import { setProfileReadPool } from '../../utils/profileReadPool';
import { armAfterMovement } from '../../utils/dragThreshold';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { LoadContext, MeasureDef } from './measures';
import type { Gene } from '../../types';

describe('x ticks', () => {
  const steps = (vals: number[]) => vals.slice(1).map((v, i) => v - vals[i]);
  for (const [span, width] of [[4000, 600], [4000, 1500], [250, 400], [1_000_000, 900], [37, 300], [12_345, 1000]] as const) {
    it(`a ${span.toLocaleString()} bp view ${width} px wide: 1-2-5 steps, whole numbers, about one per 60–90 px`, () => {
      const view = { start: 47_514_017, end: 47_514_017 + span };
      for (const anchor of [null, { pos: 47_514_017 + Math.round(span * 0.37), strand: '+' as const, name: 'x', axisLabel: '' }, { pos: 47_514_017 + Math.round(span * 0.6), strand: '-' as const, name: 'x', axisLabel: '' }]) {
        for (const reversed of [false, true]) {
          const t = axisTicks(view, reversed, anchor, width);
          const vals = t.map(x => x.value).sort((a, b) => a - b);
          const st = steps(vals);
          expect(new Set(st.map(x => +x.toPrecision(9))).size).toBe(1);
          const step = st[0];
          const mant = step / 10 ** Math.floor(Math.log10(step));
          expect([1, 2, 5]).toContain(+mant.toPrecision(6));
          if (step >= 1) expect(vals.every(v => Number.isInteger(v))).toBe(true);
          const px = step / span * width;
          expect(px).toBeGreaterThanOrEqual(X_TICK_TARGET_PX * 0.75 - 1e-9);
          expect(px).toBeLessThanOrEqual(X_TICK_TARGET_PX * 2.5);
          expect(t.length).toBeGreaterThanOrEqual(Math.min(3, Math.floor(width / (X_TICK_TARGET_PX * 2.5))));
          // Ticks in screen order, inside the plot.
          expect(t.every((x, i) => i === 0 || x.t >= t[i - 1].t)).toBe(true);
          expect(t.every(x => x.t >= -1e-9 && x.t <= 1 + 1e-9)).toBe(true);
          if (anchor) expect(vals).toContain(0);
        }
      }
    });
  }
  it('labels: genome with separators; relative signed, 0 at the anchor', () => {
    const t = axisTicks({ start: 1000, end: 3000 }, false, { pos: 2000, strand: '+', name: 'x', axisLabel: '' }, 600);
    expect(t.map(x => x.label)).toContain('0');
    expect(t.find(x => x.value > 0)!.label.startsWith('+')).toBe(true);
    expect(axisTicks({ start: 47_514_000, end: 47_518_000 }, false, null, 600)[0].label).toMatch(/^47,51\d,\d{3}$/);
  });
});

// ------------------------------------------------------------------ raw ≡ relative
const VIEW = { chrom: 'chr1', start: 10_000, end: 14_000, genome: null };
const W = VIEW.end - VIEW.start, RES = 500;
const gene = (id: string, start: number, end: number, strand: '+' | '-'): Gene => ({ id, name: id, chrom: 'chr1', start, end, strand, biotype: 'protein_coding', exons: [] });

function poolReads(): CompactRead[] {
  const out: CompactRead[] = [];
  let x = 11;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < 90; i++) {
    const s = Math.floor(rnd() * 1200), e = 2400 + Math.floor(rnd() * 1600);
    const nuc: Array<[number, number, number]> = [], tf: Array<[number, number, number]> = [];
    for (let p = s + 15; p + 150 < e; p += 160 + Math.floor(rnd() * 110)) nuc.push([p, p + 147, 147]);
    for (let p = s + 9; p + 30 < e; p += 95 + Math.floor(rnd() * 190)) tf.push([p, p + 14 + Math.floor(rnd() * 18), 20]);
    out.push({ id: `r${i}`, intervals: [[s, e, 1]], layers: { nuc: { intervals: nuc }, tf: { intervals: tf } } } as unknown as CompactRead);
  }
  return out;
}

const layer = (key: string): MeasureDef => ({ id: `layer:${key}`, label: key, source: 'layers', kind: 'fraction', unit: 'fraction of covered bp', enrichment: true, windowed: true, available: true });

function quantFor(bounds: { from: number; to: number }, units: 'curve' | 'exact', view = VIEW) {
  const panels = [{ key: 'ds', datasetId: 'ds', label: 'DS' }];
  const ctx = { view, bounds, allReads: { ...view, panels }, flankFraction: 0.1, layerUnits: units, readSource: 'panel' } as unknown as LoadContext;
  const data = poolLayerData(['nuc', 'tf'], ctx)!;
  const spec = normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, resamples: 200, minReads: 0 });
  const groups = buildGroups('clusters', { panels, clusterPanels: panels, visible: [0, 1].map(c => ({ cluster: c, color: '#000' })), clusterLabel: c => `C${c}` });
  const assignments = { ds: Object.fromEntries(poolReads().map((r, i) => [r.id, i % 2])) };
  return computeQuant({ spec, measures: [{ def: layer('nuc'), data: data['layer:nuc'] }, { def: layer('tf'), data: data['layer:tf'] }], groups, assignments, boundsBp: bounds.to - bounds.from, seed: 3 });
}

describe('a relative window gives the same numbers as the same window in genome bp', () => {
  setProfileReadPool('ds', { reads: poolReads(), chrom: VIEW.chrom, start: VIEW.start, end: VIEW.end, resolution: RES });
  const genes = [gene('PLUS', 11_800, 30_000, '+'), gene('MINUS', 0, 12_401, '-')];
  for (const id of ['PLUS', 'MINUS']) {
    for (const reversed of [false, true]) {
      it(`${id === 'PLUS' ? 'plus' : 'minus'}-strand gene, view ${reversed ? 'flipped' : 'not flipped'}: typed −100..+200 and dragged, against genome bp`, () => {
        const a = resolveAnchor({ mode: 'relative', anchor: 'tss', gene: id, position: null }, { ...VIEW, genes }) as ResolvedAnchor;
        // Typed relative window, as WindowFields stores it.
        const rel = normalizeQuantWindow({ chrom: 'chr1', from: -100, to: 200, relative: true })!;
        const bRel = effectiveBounds({ bounds: 'window' }, rel, VIEW, a);
        // The same bases in genome bp: upstream..downstream on the gene's strand.
        const g = a.strand === '+' ? [a.pos - 100, a.pos + 200] : [a.pos - 200, a.pos + 100];
        const bRaw = effectiveBounds({ bounds: 'window' }, { chrom: 'chr1', from: g[0], to: g[1] }, VIEW, null);
        expect(bRel).toEqual(bRaw);
        expect(bRel.windowMissing).toBe(false);
        // A drag on the (flipped or not) screen, stored relative and resolved again, is the dragged genome window.
        const geom = { left: 30, width: 800 };
        const px0 = bpToPx(g[0], geom, VIEW, reversed), px1 = bpToPx(g[1], geom, VIEW, reversed);
        const d0 = pxToBp(Math.min(px0, px1), geom, VIEW, reversed), d1 = pxToBp(Math.max(px0, px1), geom, VIEW, reversed);
        const dragged = { from: Math.min(d0, d1), to: Math.max(d0, d1) };
        const [rf, rt] = genomicToRelative(dragged.from, dragged.to, a);
        expect(windowGenomic({ chrom: 'chr1', from: rf, to: rt, relative: true }, 'chr1', a)).toEqual([dragged.from, dragged.to]);
        // Identical numbers, curve units and exact bp.
        for (const units of ['curve', 'exact'] as const) {
          const qr = quantFor(bRel, units), qg = quantFor(bRaw, units);
          expect(qr.cells.map(c => [c.value, c.lo, c.hi, c.n])).toEqual(qg.cells.map(c => [c.value, c.lo, c.hi, c.n]));
          expect(qr.cells.some(c => c.value != null && c.value > 0)).toBe(true);
        }
      });
    }
  }

  it('a meta-locus: relative to the site (x = flank, as headless meta_locus_numbers._bounds) equals genome bp on the contig', () => {
    const meta = { chrom: 'meta:p1', start: 0, end: 4000, genome: null };
    setProfileReadPool('ds', { reads: poolReads(), chrom: meta.chrom, start: 0, end: 4000, resolution: RES });
    const a = resolveAnchor({ mode: 'relative', anchor: 'tss', gene: null, position: null }, { ...meta, genes: [], meta: { site: 2000, word: 'TSS' } }) as ResolvedAnchor;
    const bRel = effectiveBounds({ bounds: 'window' }, { chrom: 'meta:p1', from: -100, to: 200, relative: true }, meta, a);
    const bRaw = effectiveBounds({ bounds: 'window' }, { chrom: 'meta:p1', from: 1900, to: 2200 }, meta, null);
    expect(bRel).toEqual(bRaw);
    expect(quantFor(bRel, 'curve', meta).cells.map(c => c.value)).toEqual(quantFor(bRaw, 'curve', meta).cells.map(c => c.value));
    setProfileReadPool('ds', { reads: poolReads(), chrom: VIEW.chrom, start: VIEW.start, end: VIEW.end, resolution: RES });
  });

  it('a relative window never resolves without an anchor (no silent whole view as if it were genome bp)', () => {
    expect(windowGenomic({ chrom: 'chr1', from: -100, to: 200, relative: true }, 'chr1', null)).toBeNull();
    expect(effectiveBounds({ bounds: 'window' }, { chrom: 'chr1', from: -100, to: 200, relative: true }, VIEW, null)).toMatchObject({ windowMissing: true });
  });

  it('genes on an aliased chromosome name ("1" vs "chr1") still anchor', () => {
    const a = resolveAnchor({ mode: 'relative', anchor: 'tss', gene: null, position: null }, { ...VIEW, genes: [{ ...gene('G', 11_000, 13_000, '+'), chrom: '1' }] });
    expect(a).toMatchObject({ pos: 11_000, strand: '+' });
  });
});

describe('a click that does not move', () => {
  it('never arms a drag; a real movement does', () => {
    const listeners = new Map<string, EventListener>();
    const target = { addEventListener: (t: string, f: EventListener) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) } as unknown as Document;
    let armed = 0;
    armAfterMovement(100, 50, () => { armed++; }, 4, target);
    listeners.get('mousemove')!({ clientX: 101, clientY: 51 } as unknown as Event);
    listeners.get('mouseup')!({} as Event);
    expect(armed).toBe(0);
    expect(listeners.size).toBe(0);
    armAfterMovement(100, 50, () => { armed++; }, 4, target);
    listeners.get('mousemove')!({ clientX: 108, clientY: 50 } as unknown as Event);
    expect(armed).toBe(1);
    expect(listeners.size).toBe(0);
  });
});
