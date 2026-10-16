import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useQualityFilterSync } from './useQualityFilterSync';
import { useBrowserStore } from '../stores/browserStore';
import { lookupExactReadResponse, readRegionGeneration, rememberExactReadResponse } from '../api/loadedReadRegion';
import type { LayerQualityFilter } from '../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const filter: LayerQualityFilter = { layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true };
const key = '/api/reads/compact?dataset_id=one&start=0&end=100';
const data = { reads: [{ id: 'one', intervals: [[0, 100, 100]] }], width: 100 };
function Sync({ filters, enabled = true }: { filters: LayerQualityFilter[]; enabled?: boolean }) {
  useQualityFilterSync(filters, enabled);
  return null;
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('preserves loaded reads and pending fills when session restore copies identical filters', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const refresh = useBrowserStore.getState().refreshGeneration;
  await act(async () => { root.render(<StrictMode><Sync filters={[filter]} /></StrictMode>); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(useBrowserStore.getState().refreshGeneration).toBe(refresh + 1);
  const generation = readRegionGeneration();
  rememberExactReadResponse(key, data, generation);
  await act(async () => { root.render(<StrictMode><Sync filters={[{ ...filter }]} /></StrictMode>); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(readRegionGeneration()).toBe(generation);
  expect(lookupExactReadResponse(key)).toMatchObject(data);
  rememberExactReadResponse(`${key}&neighbor=1`, data, generation);
  expect(lookupExactReadResponse(`${key}&neighbor=1`)).toMatchObject(data);
  await act(async () => { root.render(<StrictMode><Sync filters={[{ ...filter, minValue: 231 }]} /></StrictMode>); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(lookupExactReadResponse(key)).toBeUndefined();
  expect(useBrowserStore.getState().refreshGeneration).toBe(refresh + 2);
});

it('waits for the confirmed setting before refreshing reads, including the first sync', async () => {
  let complete!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const refresh = useBrowserStore.getState().refreshGeneration;
  await act(async () => { root.render(<Sync filters={[filter]} enabled={false} />); });
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => { root.render(<Sync filters={[filter]} />); });
  expect(useBrowserStore.getState().refreshGeneration).toBe(refresh);
  await act(async () => { complete(new Response('{}', { status: 200 })); });
  expect(useBrowserStore.getState().refreshGeneration).toBe(refresh + 1);
});

it('keeps cached reads when the server already has the restored quality settings', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"changed":false}', { status: 200 })));
  const refresh = useBrowserStore.getState().refreshGeneration;
  const generation = readRegionGeneration();
  rememberExactReadResponse(key, data, generation);
  await act(async () => { root.render(<Sync filters={[filter]} />); });
  expect(useBrowserStore.getState().refreshGeneration).toBe(refresh);
  expect(lookupExactReadResponse(key)).toMatchObject(data);
});
