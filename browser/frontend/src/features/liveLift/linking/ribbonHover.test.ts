import { describe, expect, it } from 'vitest';
import { linearX, ribbonGeometry, type GapRow, type PieceRow } from './ribbon';
import { hoverScope, hoveredRows, moleculeKey, nativeLibrary, rowMoleculeKey } from './hover';
import { liveLiftHitAt } from '../../../components/tracks/read-track/liveLiftCanvas';
import type { CompactRead } from '../../../components/tracks/read-track/types';
import type { Dataset, PanelConfig } from '../../../types';

const S = 'chrS_MATERNAL';
// Both edges 1 px per bp over [0, 1000): top = target, bottom = source.
const top = linearX(0, 1000, 1000, false);
const bottom = linearX(0, 1000, 1000, false);
const base = { topX: top, bottomX: bottom, contig: S, height: 40, target: { start: 0, end: 1000 }, source: { start: 0, end: 1000 } };

describe('ribbon geometry', () => {
  it('fills a + correspondence edge to edge and crosses a - one', () => {
    const pieces: PieceRow[] = [[0, 400, 100, 500, '+', 0, false, S, 'H#1'], [500, 700, 600, 800, '-', 1, false, S, 'H#1']];
    const g = ribbonGeometry({ ...base, pieces, gaps: [] });
    const [plus, minus] = g.shapes.filter(s => s.kind === 'primary');
    expect(plus.points).toEqual([[0, 0], [400, 0], [500, 40], [100, 40]]);
    expect(minus.minus).toBe(true);
    // t0 (500) meets q_end (800) and t1 (700) meets q_start (600): the quad's sides cross.
    expect(minus.points).toEqual([[500, 0], [700, 0], [600, 40], [800, 40]]);
  });
  it('outlines alternatives, under the primaries, and counts other contigs', () => {
    const pieces: PieceRow[] = [[0, 100, 0, 100, '+', 0, false, S, 'H#1'], [0, 100, 300, 400, '+', 4, true, S, 'H#1'],
      [200, 300, 0, 100, '+', 7, false, 'chrX_MATERNAL', 'H#1']];
    const g = ribbonGeometry({ ...base, pieces, gaps: [] });
    expect(g.shapes.filter(s => s.kind !== 'uncovered_target' && s.kind !== 'uncovered_source').map(s => s.kind)).toEqual(['alternative', 'primary']);
    expect(g.elsewhere).toBe(1);
    expect(g.elsewhereContigs).toEqual(['chrX_MATERNAL']);
  });
  it('draws gaps as wedges: source insertion (point on top), target insertion (point at the bottom)', () => {
    const pieces: PieceRow[] = [[0, 300, 0, 300, '+', 0, false, S, 'H#1'], [300, 600, 400, 700, '+', 0, false, S, 'H#1'], [610, 900, 700, 990, '+', 0, false, S, 'H#1']];
    const gaps: GapRow[] = [[0, 300, 300, 300, 400, 'source_insertion'], [0, 600, 610, 700, 700, 'target_insertion'], [9, 0, 0, 0, 10, 'source_insertion']];
    const g = ribbonGeometry({ ...base, pieces, gaps });
    expect(g.shapes.find(s => s.kind === 'source_insertion')!.points).toEqual([[300, 0], [400, 40], [300, 40]]);
    expect(g.shapes.find(s => s.kind === 'target_insertion')!.points).toEqual([[600, 0], [610, 0], [700, 40]]);
    expect(g.shapes.filter(s => s.kind === 'source_insertion')).toHaveLength(1);   // the other chain is not on this contig
  });
  it('hatches stretches of either edge without a correspondence', () => {
    const g = ribbonGeometry({ ...base, pieces: [[200, 500, 300, 600, '+', 0, false, S, 'H#1']], gaps: [] });
    const t = g.shapes.filter(s => s.kind === 'uncovered_target').map(s => [s.points[0][0], s.points[1][0]]);
    const q = g.shapes.filter(s => s.kind === 'uncovered_source').map(s => [s.points[0][0], s.points[1][0]]);
    expect(t).toEqual([[0, 200], [500, 1000]]);
    expect(q).toEqual([[0, 300], [600, 1000]]);
  });
  it('follows each edge\'s orientation', () => {
    const reversedBottom = linearX(0, 1000, 1000, true);
    const g = ribbonGeometry({ ...base, bottomX: reversedBottom, pieces: [[0, 100, 0, 100, '+', 0, false, S, 'H#1']], gaps: [] });
    expect(g.shapes[0].points).toEqual([[0, 0], [100, 0], [900, 40], [1000, 40]]);
  });
});

// ── Hover identity ──────────────────────────────────────────────────────────

const lifted = { id: 'lift', path: '/a.bam', paths: ['/data/a.bam', '/data/b.bam'], label: 'l', color: '#000', data_type: 'bam_livelift' } as Dataset;
const single = { ...lifted, paths: ['/data/a.bam'] } as Dataset;
const row = (id: string, ll?: object, extra: object = {}) => ({ id, intervals: [[0, 10, 1]], ...(ll ? { live_lift: ll } : {}), ...extra }) as unknown as CompactRead;

describe('hover by molecule', () => {
  it('keys lifted rows by their library and native rows by their file', () => {
    const scopeLift = { lifted, role: 'lift' as const };
    const scopeSource = { lifted, role: 'source' as const };
    expect(rowMoleculeKey(row('r1', { library: 1 }), scopeLift)).toBe(moleculeKey('lift', 1, 'r1'));
    expect(rowMoleculeKey(row('r1', undefined, { library_id: '/resolved/data/b.bam' }), scopeSource)).toBe(moleculeKey('lift', 1, 'r1'));
    expect(nativeLibrary(row('r1'), single)).toBe(0);
    expect(nativeLibrary(row('r1'), lifted)).toBe(-1);   // two files and no library: cannot be matched
  });
  it('never matches the same QNAME from another file', () => {
    const scope = { lifted, role: 'lift' as const };
    const a = row('q', { library: 0 }), b = row('q', { library: 1 }), c = row('q', { library: 0 });
    const hover = { key: moleculeKey('lift', 0, 'q'), datasetId: 'lift', panelId: 'src' };
    const rows = hoveredRows([a, b, c], scope, hover)!;
    expect(rows.has(a) && rows.has(c) && !rows.has(b)).toBe(true);
    expect(hoveredRows([a], scope, { ...hover, datasetId: 'other' })).toBeUndefined();
  });
  it('takes part only between a lifted panel and its linked source panel', () => {
    const liftPanel = { id: 'mat', datasetId: 'lift' } as PanelConfig;
    const other = { id: 'nat', datasetId: 'native' } as PanelConfig;
    const source = { id: 'src', datasetId: 'native', liftLink: { datasetId: 'lift' } } as PanelConfig;
    const datasets = [lifted, { id: 'native', data_type: 'bam' } as Dataset];
    expect(hoverScope(liftPanel, [liftPanel, other], datasets)).toBeNull();          // no linked panel open
    expect(hoverScope(liftPanel, [liftPanel, other, source], datasets)?.role).toBe('lift');
    expect(hoverScope(source, [liftPanel, source], datasets)?.role).toBe('source');
    expect(hoverScope(other, [liftPanel, other, source], datasets)).toBeNull();      // a plain native panel
  });
});

describe('badge click vs the read', () => {
  const ll = { segments: [[0, 1000, 0, '+', true]], connectors: [], badges: [[500, 'source_insertion', 2400, 2400, 'right']] } as never;
  const opts = { y: 10, rowHeight: 10, linkedOffset: 0, regionWidth: 1000, toX: (rel: number) => rel };
  it('a click inside the badge is the badge; anywhere else on the row is the read (no badge action)', () => {
    expect(liveLiftHitAt(ll, 500, 15, opts)?.badge).toBeDefined();
    const body = liveLiftHitAt(ll, 200, 15, opts);
    expect(body).toEqual({});
    expect(liveLiftHitAt(ll, 1500, 15, opts)).toBeNull();
  });
});
