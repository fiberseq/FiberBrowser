import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SyncMap } from './SyncMap';
import { frameWindows, type Proposal, type SyncResult } from './model';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const base: Proposal = { id: 'p', panelId: 'b', partnerId: 'a', rank: 0, template: [100, 800], window: [100, 800], strand: '-', sources: ['sequence'], metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'agreement', confidence: 1, supports: 2, assessed: 2 };
it('draws one lane per window, keyboard-selects a reversed ribbon and highlights the crop', async () => {
  const result: SyncResult = {
    metrics: ['sequence'], windows: [{ panelId: 'a', datasetId: 'a', label: 'A', genome: null, chrom: 'chr1', start: 0, end: 1000 }, { panelId: 'b', datasetId: 'b', label: 'B', genome: 'alt', chrom: 'chr2', start: 0, end: 1000 }, { panelId: 'c', datasetId: 'c', label: 'C', genome: null, chrom: 'chr3', start: 0, end: 1000 }],
    proposals: [base, { ...base, id: 'q', panelId: 'c', strand: '+' }], coverage: {}, notes: []
  };
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const select = vi.fn();
  const selection = { matches: result.proposals, start: 200, end: 600 };
  await act(async () => root.render(<SyncMap result={result} selection={selection} frame={frameWindows(result, selection)} features={{ b: [{ name: 'mini-white', start: 100, end: 900 }] }} onSelect={select} onRefine={() => { }} />));
  expect(node.querySelector('[data-testid="sync-lane-b"]')).toBeTruthy();
  expect(node.querySelector('[data-testid="sync-lane-c"]')).toBeTruthy();
  const ribbon = node.querySelector('[data-testid="sync-ribbon-p"]')!;
  expect(ribbon.getAttribute('tabindex')).toBe('0');
  expect(ribbon.getAttribute('aria-label')).toContain('W2 · B');
  expect(ribbon.getAttribute('aria-label')).toContain('reversed');
  expect(ribbon.getAttribute('aria-label')).toContain('metrics agree (2 of 2 metrics support)');
  expect(node.querySelector('[data-testid="sync-lane-b"]')?.textContent).toContain('chr2:0–1,000');
  expect(node.textContent).toContain('mini-white');
  expect(node.querySelector('[data-testid="sync-map-legend"]')?.textContent).toContain('Metrics disagree');
  await act(async () => ribbon.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(select).toHaveBeenCalledWith(result.proposals[0]);
  await act(async () => ribbon.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  expect(select).toHaveBeenCalledTimes(2);
  // The template bar repeats in each lane; every selected window shows its crop.
  expect(node.querySelectorAll('[data-testid^="sync-selected-a"]')).toHaveLength(2);
  expect(node.querySelectorAll('[data-testid^="sync-selected-"]')).toHaveLength(4);
  await act(async () => root.unmount());
  node.remove();
});
it('steps to the next overlapping ribbon on repeated clicks', async () => {
  const big: Proposal = { ...base, id: 'big', strand: '+', template: [0, 1000], window: [0, 1000], confidence: .5 };
  const small: Proposal = { ...base, id: 'small', strand: '+', template: [400, 600], window: [400, 600] };
  const result: SyncResult = { metrics: ['sequence'], windows: [{ panelId: 'a', datasetId: 'a', label: 'A', genome: null, chrom: 'chr1', start: 0, end: 1000 }, { panelId: 'b', datasetId: 'b', label: 'B', genome: null, chrom: 'chr2', start: 0, end: 1000 }], proposals: [big, small], coverage: {}, notes: [] };
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const select = vi.fn();
  const render = (focusedId: string | null) => root.render(<SyncMap result={result} selection={null} focusedId={focusedId} onSelect={select} onRefine={() => { }} />);
  await act(async () => render(null));
  const svg = node.querySelector('svg')!;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: Number(svg.getAttribute('viewBox')!.split(' ')[2]), height: Number(svg.getAttribute('height')), right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
  const width = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  const click = (id: string) => node.querySelector(`[data-testid="sync-ribbon-${id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: width / 2, clientY: 18 + 12 + 10 + 23 }));
  await act(async () => click('small'));
  expect(select).toHaveBeenLastCalledWith(small);
  await act(async () => render('small'));
  await act(async () => click('small'));
  expect(select).toHaveBeenLastCalledWith(big);
  await act(async () => root.unmount());
  node.remove();
});
it('draws a chain with an insertion as separate ribbons and labels the gap', async () => {
  const chain: Proposal = {
    ...base, id: 'chain', strand: '+', template: [0, 600], window: [0, 1000], blocks: [{ template: [0, 300], window: [0, 300] }, { template: [300, 600], window: [700, 1000] }],
    gaps: [{ template: 300, window: 300, inserted: 400, deleted: 0 }], indels: { inserted: 400, deleted: 0, count: 1 }
  };
  const result: SyncResult = { metrics: ['sequence'], windows: [{ panelId: 'a', datasetId: 'a', label: 'A', genome: null, chrom: 'chr1', start: 0, end: 1000 }, { panelId: 'b', datasetId: 'b', label: 'B', genome: null, chrom: 'chr2', start: 0, end: 1000 }], proposals: [chain], coverage: {}, notes: [] };
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  await act(async () => root.render(<SyncMap result={result} selection={null} focusedId="chain" onSelect={() => { }} onRefine={() => { }} />));
  expect(node.querySelectorAll('[data-testid="sync-lane-b"] path')).toHaveLength(2);
  expect(node.querySelector('[data-testid="sync-gap-chain"]')?.textContent).toBe('+400 bp in W2');
  expect(node.querySelector('[data-testid="sync-ribbon-chain"]')?.getAttribute('aria-label')).toContain('2 blocks across indels');
  await act(async () => root.unmount());
  node.remove();
});
it('keeps every base of a chain when drawing it against a circular bar', async () => {
  const { drawnBlocks, proposalBlocks, splitForBars } = await import('./model');
  const p = { template: [0, 200] as [number, number], window: [0, 210] as [number, number], strand: '+' as const, blocks: [{ template: [0, 100] as [number, number], window: [0, 100] as [number, number] }, { template: [100, 200] as [number, number], window: [110, 210] as [number, number] }] };
  const bar = { start: 0, end: 1000 };
  const drawn = drawnBlocks({ ...p, blocks: proposalBlocks(p).flatMap(b => splitForBars(b, '+', bar, 1000, bar, 1000)) }, 20);
  expect(drawn).toEqual([{ template: [0, 200], window: [0, 210] }]);
});

it('selects region-first: a bar stretch lights its matches, Enter or a click picks one, Escape clears', async () => {
  const one: Proposal = { ...base, id: 'one', strand: '+', template: [100, 300], window: [600, 800] };
  const two: Proposal = { ...base, id: 'two', strand: '+', template: [150, 320], window: [100, 270], confidence: .5 };
  const far: Proposal = { ...base, id: 'far', strand: '+', template: [700, 900], window: [300, 500] };
  const result: SyncResult = { metrics: ['sequence'], windows: [{ panelId: 'a', datasetId: 'a', label: 'A', genome: null, chrom: 'chr1', start: 0, end: 1000 }, { panelId: 'b', datasetId: 'b', label: 'B', genome: null, chrom: 'chr2', start: 0, end: 1000 }], proposals: [one, two, far], coverage: {}, notes: [] };
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const select = vi.fn();
  await act(async () => root.render(<SyncMap result={result} selection={null} onSelect={select} onRefine={() => { }} />));
  // The template bar's first stretch carries the two overlapping proposals.
  const stretch = node.querySelector('[data-testid="sync-stretch-lane0-top-0"]')!;
  expect(stretch.querySelector('title')?.textContent).toContain('W1 ↔ W2');
  await act(async () => stretch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(node.querySelector('[data-testid="sync-armed"]')).toBeTruthy();
  const lit = [...node.querySelectorAll('[data-testid^="sync-lit-lane0-bottom-"]')];
  expect(lit).toHaveLength(2);
  expect(node.querySelector('[data-testid="sync-ribbon-far"]')!.parentElement!.getAttribute('opacity')).toBe('0.12');
  // Picking the lit stretch at 600–800 selects exactly that proposal.
  const rightLit = lit.find(el => Number(el.getAttribute('x')) > 100)!;
  await act(async () => rightLit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(select).toHaveBeenLastCalledWith(one);
  // Keyboard: the bottom bar is a stop; arrows move between lit stretches, Enter picks.
  const bottom = node.querySelector<SVGElement>('[data-testid="sync-stretches-lane0-bottom"]')!;
  await act(async () => bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  await act(async () => bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(select).toHaveBeenCalledTimes(2);
  await act(async () => bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(node.querySelector('[data-testid="sync-armed"]')).toBeNull();
  // Arm again, then a click on empty map space clears.
  await act(async () => stretch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => node.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(node.querySelector('[data-testid="sync-armed"]')).toBeNull();
  // Tiny stretches stay at least 8 px wide.
  expect([...node.querySelectorAll('[data-testid^="sync-stretch-"]')].every(el => Number(el.getAttribute('width')) >= 8)).toBe(true);
  await act(async () => root.unmount());
  node.remove();
});
it('stacks all windows, ribbons between neighbours, with common blocks bracketed', async () => {
  const { multiwayBlocks } = await import('./model');
  const ab: Proposal = { ...base, id: 'ab', partnerId: 'a', panelId: 'b', strand: '+', template: [100, 400], window: [200, 500], confidence: .5 };
  const ac: Proposal = { ...base, id: 'ac', partnerId: 'a', panelId: 'c', strand: '+', template: [100, 400], window: [500, 800], sources: ['shape'], flags: ['chromatin-only'], confidence: 1 };
  const windows = ['a', 'b', 'c'].map(id => ({ panelId: id, datasetId: id, label: id.toUpperCase(), genome: null, chrom: id, start: 0, end: 1000 }));
  const result: SyncResult = { metrics: ['sequence', 'shape'], windows, proposals: [ab, ac], coverage: {}, notes: [] };
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const chooseBlock = vi.fn();
  const blocks = multiwayBlocks(result);
  await act(async () => root.render(<SyncMap result={result} mode="all" blocks={blocks} onSelectBlock={chooseBlock} selection={null} onSelect={() => { }} onRefine={() => { }} />));
  expect(node.querySelectorAll('[data-testid^="sync-bar-all-"]')).toHaveLength(3);
  expect(node.querySelectorAll('[data-testid^="sync-link-"]')).toHaveLength(2);
  // The chromatin-only ribbon is hatched.
  expect(node.querySelector('[data-testid="sync-ribbon-ac"]')!.getAttribute('fill')).toMatch(/^url\(#/);
  const bracket = node.querySelector('[data-testid="sync-block-b0"]')!;
  expect(bracket.textContent).toContain('in 3 of 3');
  await act(async () => bracket.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(chooseBlock).toHaveBeenCalledWith(blocks[0]);
  await act(async () => root.unmount());
  node.remove();
});
