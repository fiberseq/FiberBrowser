import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../../api/sharedFetch', () => ({ fetchJson: (...args: unknown[]) => fetchJson(...args) }));

import { useBrowserStore } from '../../../stores/browserStore';
import { useReadActionsStore } from '../../../stores/readActionsStore';
import type { ChromInfo } from '../../../types';
import { ReadTrackActions } from './ReadTrackActions';
import type { CompactRead } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Codex 18 (fb-n3-search): Zoom to read's answer comes back later; it must not undo a newer navigation. */
const READ: CompactRead = { id: 'm1/7/ccs', intervals: [[100, 400, 300]] } as CompactRead;
const LAYOUT = { trackHeight: 200, autoRowHeight: 10, rowHeight: 10, rowGap: 0, totalContentHeight: 10, needsScroll: false, maxScrollOffset: 0, clampedScrollOffset: 0, scrollAdjust: 0 };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onViewportChange = vi.fn();
const setViewport = vi.fn();

function render(panelOwnLocus: boolean) {
  useBrowserStore.setState({
    chrom: 'chr1', start: 0, end: 1_000, spanningOnly: false,
    chroms: [{ name: 'chr1', size: 1_000_000 } as ChromInfo],
    datasets: [{ id: 'ds1', label: 'x' }] as never,
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [],
      ...(panelOwnLocus ? { viewportOverride: { chrom: 'chr1', start: 0, end: 1_000 } } : {}) }] as never,
    selectedReadIds: {}, filteredReadIds: {}, setViewport,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(
    <ReadTrackActions
      stateKey="ds1" datasetId="ds1" chrom="chr1" start={0} end={1_000}
      onViewportChange={panelOwnLocus ? onViewportChange : undefined}
      reads={[READ]} layout={LAYOUT as never} rowsTop={0} width={1000} sidebarWidth={0} regionWidth={1000} isReversed={false}
      contextTarget={{ clientX: 10, clientY: 10, x: 10, y: 5, read: READ, footprint: null } as never}
      closeContextMenu={() => {}} selectFootprintAt={() => false} selectReadById={() => {}}
    />,
  ));
}

async function zoomToRead(): Promise<(v: unknown) => void> {
  let answer: (v: unknown) => void = () => {};
  fetchJson.mockImplementation(() => new Promise(r => { answer = r; }));
  const item = document.querySelector<HTMLButtonElement>('[data-action="zoom-to-read"]');
  expect(item).toBeTruthy();
  act(() => item!.click());
  await act(async () => { await Promise.resolve(); });
  return (v: unknown) => answer(v);
}

const found = { scope: 'region', complete: true, not_found: [], found: [{ name: READ.id, read_id: READ.id, dataset_id: 'ds1', chrom: 'chr1', start: 5_000, end: 9_000, strand: '+' }] };

beforeEach(() => {
  fetchJson.mockReset();
  onViewportChange.mockReset();
  setViewport.mockReset();
  useReadActionsStore.setState({ highlight: null, pinnedReadIds: [] });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('Zoom to read (Codex 18)', () => {
  it('goes to the read when nothing moved meanwhile', async () => {
    render(false);
    const answer = await zoomToRead();
    await act(async () => { answer(found); await new Promise(r => setTimeout(r, 0)); });
    expect(setViewport).toHaveBeenCalledWith('chr1', expect.any(Number), expect.any(Number));
  });

  it('the main view moved while the read was looked up: the old answer moves nothing', async () => {
    render(false);
    const answer = await zoomToRead();
    act(() => useBrowserStore.setState({ start: 50_000, end: 51_000 } as never));
    await act(async () => { answer(found); await new Promise(r => setTimeout(r, 0)); });
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('a panel at its own locus panned meanwhile: not moved back', async () => {
    render(true);
    const answer = await zoomToRead();
    act(() => useBrowserStore.setState(s => ({
      panels: s.panels.map(p => ({ ...p, viewportOverride: { chrom: 'chr1', start: 70_000, end: 71_000 } })),
    }) as never));
    await act(async () => { answer(found); await new Promise(r => setTimeout(r, 0)); });
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('another session opened meanwhile: it stands down', async () => {
    render(false);
    const answer = await zoomToRead();
    act(() => useReadActionsStore.getState().reset());
    await act(async () => { answer(found); await new Promise(r => setTimeout(r, 0)); });
    expect(setViewport).not.toHaveBeenCalled();
  });
});
