/**
 * M17 (UI audit): stacking datasets was hard to discover (only a drop on a
 * panel's bottom edge). The panel menu now stacks a panel or puts it side by
 * side. New datasets and "Add a copy" open side by side: stacking them by
 * default was tried (1 Oct) and the owner asked for side by side back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from './browserStore';
import { rowColumns } from './panelArrangement';

const dataset = (id: string) => ({ id, label: id, data_type: 'bam', paths: [`/${id}.bam`] }) as any;
const columns = () => rowColumns(useBrowserStore.getState().panels, 0).map(col => col.map(p => p.datasetId));
const panelOf = (id: string) => useBrowserStore.getState().panels.find(p => p.datasetId === id && !p.viewportOverride)!;

describe('stacked or side by side', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* jsdom */ }
    useBrowserStore.setState({
      datasets: [], panels: [], activeReadIds: {},
      chrom: 'chr2R', start: 9_974_319, end: 9_984_319,
    } as any);
  });

  it('datasets given at start-up are placed as datasets opened in the app (fb-n1-bugs 3)', () => {
    const shape = () => useBrowserStore.getState().panels.map(p => ({
      ds: p.datasetId, row: p.layoutRow ?? 0, col: p.layoutColumn ?? null, link: p.linkGroup, collapsed: p.collapsed,
    }));
    // Start-up: the dataset list arrives at once (Browser.tsx setDatasets from /api/datasets).
    useBrowserStore.getState().setDatasets([dataset('a'), dataset('b'), dataset('c')]);
    const atStartup = shape();
    expect(columns()).toEqual([['a'], ['b'], ['c']]);
    // In the app: one at a time.
    useBrowserStore.setState({ datasets: [], panels: [], activeReadIds: {} } as any);
    const s = useBrowserStore.getState();
    s.addDataset(dataset('a'));
    s.addDataset(dataset('b'));
    s.addDataset(dataset('c'));
    const inApp = shape();
    // Link group names count up across the store's life; what matters is that all share one.
    const sameGroup = (rows: ReturnType<typeof shape>) => new Set(rows.map(r => r.link)).size === 1 && rows[0].link !== null;
    expect(sameGroup(atStartup) && sameGroup(inApp)).toBe(true);
    const strip = (rows: ReturnType<typeof shape>) => rows.map(({ link: _link, ...rest }) => rest);
    expect(strip(atStartup)).toEqual(strip(inApp));
  });

  it('datasets opened at the same locus go side by side', () => {
    const s = useBrowserStore.getState();
    s.addDataset(dataset('a'));
    s.addDataset(dataset('b'));
    s.addDataset(dataset('c'));
    expect(columns()).toEqual([['a'], ['b'], ['c']]);
  });

  it('"Stack below" stacks one panel; "Side by side" puts it back (both undoable); neither changes where the next one goes', () => {
    const s = useBrowserStore.getState();
    s.addDataset(dataset('a'));
    s.addDataset(dataset('b'));
    s.arrangePanel(panelOf('b').id, 'stack');
    expect(columns()).toEqual([['a', 'b']]);
    s.addDataset(dataset('c'));
    expect(columns()).toEqual([['a', 'b'], ['c']]);
    s.arrangePanel(panelOf('b').id, 'side');
    expect(columns()).toEqual([['a'], ['b'], ['c']]);
    useBrowserStore.getState().undo();
    expect(columns()).toEqual([['a', 'b'], ['c']]);
  });

  it('"Add a copy" (same locus) goes beside its source', () => {
    const s = useBrowserStore.getState();
    s.addDataset(dataset('a'));
    s.addDataset(dataset('b'));
    s.arrangePanel(panelOf('b').id, 'stack');  // a stack chosen once is not remembered for new panels
    const copy = s.openPanelAtSite(panelOf('a').id, { linked: true });
    const cols = rowColumns(useBrowserStore.getState().panels, 0).map(col => col.map(p => p.id));
    expect(cols.find(col => col.includes(copy))).toEqual([copy]);
    expect(cols).toHaveLength(2);
  });
});

describe('minimized panels keep their own column', () => {
  it('a panel minimized from a stack is not restored into another panel\'s stack', async () => {
    const { stackBelow } = await import('./panelArrangement');
    const base = { contentType: 'dataset', subTracks: [], linkGroup: null, layoutRow: 0 };
    const panels = [
      { ...base, id: 'a', datasetId: 'a', collapsed: false },
      { ...base, id: 'b', datasetId: 'b', collapsed: false },
      { ...base, id: 'c', datasetId: 'c', collapsed: true, layoutColumn: 0 },
      { ...base, id: 'd', datasetId: 'd', collapsed: false },
    ] as any;
    const after = stackBelow(panels, 'd', 'b');
    const restored = after.map((p: any) => ({ ...p, collapsed: false }));
    const cols = rowColumns(restored, 0).map(col => col.map(p => p.id));
    expect(cols).toEqual([['a'], ['b', 'd'], ['c']]);
  });
});
