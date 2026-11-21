/** Regressions for the frontend items of the round-2 Gemini audit (graph layers, export in full view, charts, focus,
 * cluster Analyse, TSV escaping, SVG export). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphCallLayers } from '../graphPanel/readGeometry';
import { readExportTrackSnapshots } from '../../utils/readExport';
import { figureDrawables } from '../../utils/figureExport';
import { drawProfile } from '../../components/controls/cluster-detail/ClusterCharts';
import { drawOverlayProfile } from '../../components/charts/OverlayProfileChart';
import { refocusAfter } from './geoActions';
import { useNucGeoFocusStore, geoFocusKey } from '../../stores/nucGeoFocusStore';
import { analyseClusterView, resetClusterAnalyse } from '../../components/controls/cluster-detail/clusterNuc';
import { useNucJob } from './nucJob';
import { geometriesTsv } from './GeometryClasses';
import { linesTsv, standaloneSvg, withLightTheme } from '../../utils/svgChartExport';
import type { NucGeometryResult, NucGeometryRow } from './types';

const recorder = () => {
  const pts: number[] = []; const texts: Array<[string, number]> = [];
  const ctx = new Proxy({ measureText: () => ({ width: 10 }), lineTo: (x: number, y: number) => pts.push(x, y), moveTo: (x: number, y: number) => pts.push(x, y),
    fillText: (t: string, _x: number, y: number) => texts.push([t, y]) } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : () => {}), set: () => true });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pts, texts };
};

describe('C3: the graph panel draws no regularity tiles or patches as calls', () => {
  it('graphCallLayers leaves out nucreg and nucpatch (and the size/segment layers)', () => {
    const layer = { iv: [[0, 10, 10]] } as never;
    const out = graphCallLayers({ nuc: layer, tf: layer, msp: layer, layers: { nucreg: layer, nucpatch: layer, nucmol: layer, nucsz: layer, nucseg: layer, fire: layer } } as never);
    expect(Object.keys(out).sort()).toEqual(['fire', 'msp', 'nucmol', 'nuc', 'tf'].sort());
  });
});

describe('H8: export in full view', () => {
  const panel = (id: string, hidden: boolean, count: number) => `<div data-panel-id="${id}" ${hidden ? 'data-full-view-hidden="true"' : ''}>
    <div data-read-track-dataset-id="${id}" data-read-track-working-count="${count}"><canvas data-copilot-track="reads"></canvas></div></div>`;
  it('panels hidden by full view are never counted, matched or drawn', () => {
    const root = document.createElement('div');
    root.innerHTML = panel('a', false, 200) + panel('b', true, 0);
    expect(readExportTrackSnapshots(root).map(s => [s.datasetId, s.workingCount])).toEqual([['a', 200]]);
    expect(figureDrawables(root, 'canvas')).toHaveLength(1);
  });
});

describe('M17: charts', () => {
  it('a profile with missing (NaN) bins is drawn, with gaps, never blank', () => {
    const { ctx, pts } = recorder();
    drawProfile(ctx, 100, 40, [NaN, 0.2, 0.5, NaN, 0.4, NaN], '#000000', false);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every(Number.isFinite)).toBe(true);
  });
  it('L22: the zero label is left out where it would overprint the bottom label', () => {
    const { ctx, texts } = recorder();
    drawOverlayProfile(ctx, 300, 70, [{ data: [-0.02, 1, 2.5], color: '#000', label: 'c0' }], false, false, undefined, 'score', false, undefined);
    expect(texts.some(([t]) => t === '0')).toBe(false);
    const r2 = recorder();
    drawOverlayProfile(r2.ctx, 300, 70, [{ data: [-2, 1, 2.5], color: '#000', label: 'c0' }], false, false, undefined, 'score', false, undefined);
    expect(r2.texts.some(([t]) => t === '0')).toBe(true);
  });
});

describe('M18: focus after a refold, and the cluster views\' Analyse while one runs', () => {
  const row = (id: string, gid: string, parentIndex: number | null, rootNumber: number): NucGeometryRow => ({ id, kind: 'high', number: 1, rootNumber,
    geometryId: gid, start: 0, end: 1000, width: 1000, openLeft: false, openRight: false, molecules: 5, patches: 5, startMad: 0, endMad: 0, score: 1,
    period: 190, parent: parentIndex == null ? null : 'G1', parentIndex, children: [], perObservation: {}, densityMatched: {} });
  const res = (G: NucGeometryRow[]) => ({ geometries: G, assignments: {} }) as unknown as NucGeometryResult;
  afterEach(() => useNucGeoFocusStore.getState().clear());

  it('unfolding keeps the focus on the root only; a folded child gone keeps the root\'s focus', () => {
    const folded = res([row('G1', 'root', null, 1), row('G2', 'child', 0, 1)]);
    useNucGeoFocusStore.getState().focus(geoFocusKey('high', 1));
    refocusAfter(folded, res([row('G1', 'root', null, 1), row('G2', 'child', null, 2)]));      // unfolded
    expect([...useNucGeoFocusStore.getState().focused]).toEqual([geoFocusKey('high', 1)]);
    refocusAfter(folded, res([row('G1', 'root', null, 1)]));                                       // the child dropped
    expect([...useNucGeoFocusStore.getState().focused]).toEqual([geoFocusKey('high', 1)]);
  });

  it('a cluster channel asks to wait while an Analyse runs, even for a view already tried', async () => {
    resetClusterAnalyse();
    useNucJob.setState({ submitting: true });
    const out = await analyseClusterView([], ['a'], 'v', { autoAnalyse: 'off' } as never, false, 'the patch channels');
    expect(out.status).toBe('analysing');
    useNucJob.setState({ submitting: false });
    const off = await analyseClusterView([], ['a'], 'v', { autoAnalyse: 'off' } as never, false, 'the patch channels');
    expect(off.status).toBe('needs-analyse');
  });
});

describe('L22: TSV exports escape their cells', () => {
  it('a label with a tab or newline stays in its column', () => {
    const t = linesTsv([{ key: 'k', label: 'a\tb', points: [[1, 2]] }]);
    expect(t.split('\n')[1]).toBe('k\t"a\tb"\t1\t2');   // the tab inside a quoted cell
    const g = { id: 'G1', kind: 'high', start: 1, end: 2, width: 1, openLeft: false, openRight: false, molecules: 1, patches: 1, startMad: null,
      endMad: null, score: null, period: 0, parent: null, perObservation: {}, densityMatched: {} } as unknown as NucGeometryRow;
    const tsv = geometriesTsv({ window: { chrom: 'c', start: 0, end: 10 }, geometries: [g] } as unknown as NucGeometryResult, [0],
      [{ obsId: 'o', label: 'two\nlines' } as never], v => String(v));
    expect(tsv).toContain('\t"two\nlines full"\t');                // the newline inside a quoted cell
  });
});

describe('M17: SVG export in dark mode', () => {
  afterEach(() => document.documentElement.classList.remove('dark'));
  it('styles are read under the light theme and the dark class comes back', () => {
    document.documentElement.classList.add('dark');
    const seen = withLightTheme(() => document.documentElement.classList.contains('dark'));
    expect(seen).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'fill-current');
    svg.appendChild(text);
    document.body.appendChild(svg);
    const spy = vi.spyOn(window, 'getComputedStyle');
    const out = standaloneSvg(svg as SVGSVGElement).text;
    expect(out).toContain('#ffffff');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore(); svg.remove();
  });
});
