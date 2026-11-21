import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeatureHubPanel } from './FeatureHubPanel';
import { useBrowserStore } from '../../stores/browserStore';
import { EMPTY_HUB } from './hubState';
import type { FeatureSet } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { provider } = vi.hoisted(() => ({ provider: { setId: 'browser:render', typeId: 'peaks.peak', datasets: ['sample'], groups: [],
  type: { typeId: 'peaks.peak', module: 'browser', label: 'Peak', plural: 'Peaks', provides: ['hit', 'state'], anchor: 'centre', zeroWidth: false, scores: [] },
  frame: { kind: 'linear', chrom: 'chrT' }, coverage: { territory: 'view' }, status: 'complete', provenance: { producer: 'browser', module: 'test', inputs: [], units: 'view' },
  source: { kind: 'inline', hits: [] } } }));
vi.mock('./hubData', async () => {
  const actual = await vi.importActual<typeof import('./hubData')>('./hubData');
  const sets = [provider];
  return { ...actual, useProviderSets: () => sets, restoreSessionScans: vi.fn().mockResolvedValue(undefined) };
});
let host: HTMLDivElement, root: Root;
const requests: any[] = [];
beforeEach(() => {
  requests.length = 0;
  useBrowserStore.setState({ featureHub: EMPTY_HUB, chrom: 'chrT', start: 0, end: 1000, datasets: [], panels: [] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    let response: unknown = { scans: [] };
    if (String(url).endsWith('/api/hub/hits/query')) {
      const req = JSON.parse(String(init?.body)); requests.push(req);
      response = { total: 100_005, offset: req.offset, limit: req.limit, hasMore: req.offset + req.limit < 100_005,
        rows: Array.from({ length: req.limit }, (_, i) => ({ source: provider.setId, setId: provider.setId, hit: {
          setId: provider.setId, hitId: `h${req.offset+i}`, typeId: provider.typeId, chrom: 'chrT', start: req.offset+i,
          end: req.offset+i+1, anchor: req.offset+i, frame: provider.frame, label: `Hit ${req.offset+i}`, scores: {}, stateSpec: { kind: 'open' },
        } })) };
    }
    return new Response(JSON.stringify(response), { status: 200 });
  });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { (provider.source as {hits: unknown[]}).hits = []; act(() => root.unmount()); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 220)); }); };
function change(selector: string, value: string) {
  act(() => { const el = host.querySelector<HTMLSelectElement>(selector)!; el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
it('renders only a page, changes scopes and sorts on the server, and retains selection across pages', async () => {
  await act(async () => root.render(<FeatureHubPanel isFullView={false} panelId="hub" />));
  await settle();
  expect(host.querySelectorAll('[data-testid="hub-row"]')).toHaveLength(100);
  expect(host.querySelector('[data-testid="hub-hit-count"]')?.textContent).toContain('100005');
  act(() => host.querySelector('[data-testid="hub-row"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(useBrowserStore.getState().featureHub.selected[0].hitId).toBe('h0');
  const next = [...host.querySelectorAll('button')].find(b => b.textContent === 'Next page')!;
  act(() => next.click()); await settle();
  expect(requests.at(-1).offset).toBe(100);
  expect(useBrowserStore.getState().featureHub.selected[0].hitId).toBe('h0');
  change('[aria-label="Hub scope"]', 'genome'); await settle();
  expect(requests.at(-1)).toMatchObject({ scope: { kind: 'genome' }, offset: 0 });
  change('[data-testid="hub-sort"]', 'q:asc'); await settle();
  expect(requests.at(-1).sort).toEqual({ key: 'q', dir: 'asc' });
  expect(host.querySelectorAll('[data-testid="hub-row"]')).toHaveLength(100);
  for (const id of ['split', 'highlight', 'catalog', 'condition']) expect(host.querySelector(`[data-testid="hub-use-${id}"]`)).toBeTruthy();
  expect(host.querySelector('[data-testid="hub-export-bed"]')).toBeTruthy();
});


it('bounds the initial provider list before the server page arrives for a large set', async () => {
  (provider.source as {hits: unknown[]}).hits = Array.from({ length: 100_005 }, (_, i) => ({
    setId: provider.setId, hitId: `inline-${i}`, typeId: provider.typeId, frame: provider.frame,
    chrom: 'chrT', start: i, end: i+1, anchor: i, scores: {},
  }));
  await act(async () => root.render(<FeatureHubPanel isFullView={false} panelId="hub" />));
  expect(host.querySelectorAll('[data-testid="hub-row"]')).toHaveLength(100);
  await settle();
  expect(host.querySelectorAll('[data-testid="hub-row"]')).toHaveLength(100);
});
