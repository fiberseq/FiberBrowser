import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { CoOccurrenceTab } from './CoOccurrenceTab';

const group = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, color: '#7c3aed', sizeMin: 10, sizeMax: 40, enabled: true, sourceIndex: -1, ...extra }) as any;
const dataset = { id: 'd', label: 'D', color: '#000' } as any;
const perGroup = (n: number) => ({ eligible_reads: 10, n_with: n, n_without: 10 - n, ids_with: ['r1'], ids_without: ['r2'] });
const pair = (i: number, j: number) => ({ group_i: i, group_j: j, table: [[2, 3], [4, 1]], odds_ratio: 0.5, p_value: 0.2, q_value: 0.2,
  n_both: 2, n_i_only: 3, n_j_only: 4, n_neither: 1, ids_both: ['a'], ids_i_only: ['b'], ids_j_only: ['c'], ids_neither: ['e'] });

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function render(groups: any[], pairs: any[], onCell = vi.fn(), filterKey: string | null = null) {
  const result = { co_occupancy: { d: { per_group: groups.map((_, i) => perGroup(i + 3)), pairs, total_reads: 10 } } } as any;
  await act(async () => root.render(
    <CoOccurrenceTab result={result} footprintGroups={groups} targetDatasets={[dataset]} coOccLoading={false} clusterLoading={false}
      footprintFilterKey={filterKey} currentLayer={null} handleCellClick={onCell} handleClusterByGroups={() => {}} />,
  ));
  return onCell;
}
const q = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];

describe('Co-occupancy tab: what opens and what filters is explicit', () => {
  it('says what the tab shows', async () => {
    await render([group('a', 'A'), group('b', 'B')], [pair(0, 1)]);
    expect(q('[data-testid="coocc-intro"]')[0]?.textContent).toMatch(/same reads/);
  });

  it('matrix cells are disclosures: aria-expanded, a chevron, and they open the 2×2 table they control', async () => {
    await render([group('a', 'A'), group('b', 'B'), group('c', 'C')], [pair(0, 1), pair(0, 2), pair(1, 2)]);
    const cells = q('[data-testid="coocc-pair-cell"]');
    expect(cells).toHaveLength(3);
    for (const c of cells) {
      expect(c.tagName).toBe('BUTTON');
      expect(c.getAttribute('aria-expanded')).toBe('false');
      expect(c.querySelector('[data-disclosure="closed"]')).not.toBeNull();
      expect(c.title).toMatch(/^Show the 2×2 table of /);
    }
    expect(q('[data-testid="coocc-pair-detail"]')).toHaveLength(0); // several pairs: none open by default
    await act(async () => cells[1].click());
    expect(cells[1].getAttribute('aria-expanded')).toBe('true');
    expect(cells[1].querySelector('[data-disclosure="open"]')).not.toBeNull();
    const detail = q('[data-testid="coocc-pair-detail"]');
    expect(detail).toHaveLength(1);
    expect(detail[0].id).toBe(cells[1].getAttribute('aria-controls'));
    // Its own header closes it again.
    const close = detail[0].querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
    await act(async () => close.click());
    expect(q('[data-testid="coocc-pair-detail"]')).toHaveLength(0);
    expect(cells[1].getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(cells[1]); // focus returns to the cell that opened it
  });

  it('a lone pair is shown open, and closing it sticks', async () => {
    await render([group('a', 'A'), group('b', 'B')], [pair(0, 1)]);
    const [cell] = q('[data-testid="coocc-pair-cell"]');
    expect(cell.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-testid="coocc-pair-detail"]')).toHaveLength(1);
    await act(async () => cell.click());
    expect(q('[data-testid="coocc-pair-detail"]')).toHaveLength(0);
  });

  it('counts are filter toggles (buttons with aria-pressed), not disclosures', async () => {
    const onCell = await render([group('a', 'A'), group('b', 'B')], [pair(0, 1)], vi.fn(), 'd:-1:with');
    const withA = q('[data-testid="coocc-group-with"]');
    expect(withA).toHaveLength(2);
    expect(withA[0].tagName).toBe('BUTTON');
    expect(withA[0].getAttribute('aria-pressed')).toBe('true');
    expect(withA[1].getAttribute('aria-pressed')).toBe('false');
    expect(withA[1].title).toBe('Show only the 4 reads with B');
    expect(withA[1].getAttribute('aria-label')).toBe('Show only the 4 reads with B');
    expect(withA[0].hasAttribute('aria-expanded')).toBe(false);
    await act(async () => withA[1].click());
    expect(onCell).toHaveBeenCalledWith('d', -2, 'with', ['r1']);
    const both = q('[data-testid="coocc-pair-both"]')[0];
    expect(both.tagName).toBe('BUTTON');
    await act(async () => both.click());
    expect(onCell).toHaveBeenLastCalledWith('d', 0, 'both', ['a']);
  });

  it('2×2 labels name the whole class, not a six-letter cut ("S1 · C+")', async () => {
    const cls = (id: string, sid: string, start: number) => group(id, `${sid} · Class ${id} · D`, {
      consensusStateId: `class_${id}`, savedClass: { id: sid }, referenceAbsStart: start, referenceAbsEnd: start + 20 });
    await render([cls('1', 'S1', 100), cls('2', 'S2', 200)], [pair(0, 1)]);
    const text = q('[data-testid="coocc-pair-detail"]')[0].textContent ?? '';
    expect(text).toContain('with S1');
    expect(text).toContain('without S2');
    expect(text).not.toContain('C+');
  });

  it('overlapping classes still open their 2×2 table, with the same affordance, and say why the odds ratio is not a measured avoidance', async () => {
    const cls = (id: string, sid: string, start: number) => group(id, `${sid} · Class ${id} · D`, {
      consensusStateId: `class_${id}`, savedClass: { id: sid }, referenceAbsStart: start, referenceAbsEnd: start + 20 });
    await render([cls('1', 'S1', 100), cls('2', 'S2', 110), cls('3', 'S3', 300)],
      [{ ...pair(0, 1), n_both: 0, odds_ratio: 0 }, pair(0, 2), pair(1, 2)]);
    const cells = q('[data-testid="coocc-pair-cell"]');
    const ex = cells.find(c => c.textContent?.startsWith('×'))!;
    expect(ex.getAttribute('aria-expanded')).toBe('false');
    expect(ex.querySelector('[data-disclosure="closed"]')).not.toBeNull();
    await act(async () => ex.click());
    expect(q('[data-testid="coocc-pair-detail"]')[0].textContent).toMatch(/overlap/);
  });
});

describe('Co-occupancy tab: choosing the footprints to cluster by', () => {
  async function renderPick(n: number, props: Record<string, unknown> = {}) {
    const groups = Array.from({ length: n }, (_, i) => group(String.fromCharCode(97 + i), String.fromCharCode(65 + i)));
    const result = { co_occupancy: { d: { per_group: groups.map((_, i) => perGroup(i + 1)), pairs: [], total_reads: 10 } } } as any;
    const onCluster = vi.fn();
    await act(async () => root.render(
      <CoOccurrenceTab result={result} footprintGroups={groups} targetDatasets={[dataset]} coOccLoading={false} clusterLoading={false}
        footprintFilterKey={null} currentLayer={null} handleCellClick={vi.fn()} handleClusterByGroups={onCluster} {...props} />,
    ));
    return onCluster;
  }
  const picks = () => q('[data-testid="coocc-cluster-pick"]');
  const ticked = () => picks().filter(p => p.getAttribute('aria-checked') === 'true').map(p => p.dataset.groupId);
  const button = () => q('[data-testid="coocc-cluster-button"]')[0];

  it('ticks all of up to three by default and says how many in the button', async () => {
    const onCluster = await renderPick(2);
    expect(ticked()).toEqual(['a', 'b']);
    expect(button().textContent).toBe('Cluster reads by 2 footprints');
    expect(q('[data-testid="coocc-cluster-warning"]')).toHaveLength(0);
    await act(async () => button().click());
    expect(onCluster).toHaveBeenCalledWith(['a', 'b']);
  });

  it('with more than three, ticks the first three; ticking a fourth warns (16 patterns > 8)', async () => {
    const onCluster = await renderPick(5);
    expect(ticked()).toEqual(['a', 'b', 'c']);
    expect(q('[data-testid="coocc-cluster-warning"]')).toHaveLength(0);
    await act(async () => picks()[4].click());
    expect(ticked()).toEqual(['a', 'b', 'c', 'e']);
    expect(button().textContent).toBe('Cluster reads by 4 footprints');
    expect(q('[data-testid="coocc-cluster-warning"]')[0].textContent).toMatch(/up to 16 patterns/);
    await act(async () => picks()[0].click());
    await act(async () => button().click());
    expect(onCluster).toHaveBeenCalledWith(['b', 'c', 'e']);
  });

  it('one footprint reads "1 footprint"; none blocks the button and says why', async () => {
    const onCluster = await renderPick(2);
    await act(async () => picks()[1].click());
    expect(button().textContent).toBe('Cluster reads by 1 footprint');
    await act(async () => picks()[0].click());
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(button().title).toMatch(/Tick at least one footprint/);
    await act(async () => button().click());
    expect(onCluster).not.toHaveBeenCalled();
  });

  it('a controlling panel owns the choice (remembered per locus)', async () => {
    const onChange = vi.fn();
    await renderPick(4, { clusterSelection: ['b', 'd'], onClusterSelectionChange: onChange });
    expect(ticked()).toEqual(['b', 'd']);
    await act(async () => picks()[0].click());
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'd']);
  });
});
