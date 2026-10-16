import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tracks from '../../../api/tracks';
import { useBrowserStore } from '../../../stores/browserStore';
import { AddTrackBox } from './AddTrackBox';

vi.mock('../../../api/tracks', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/tracks')>()),
  searchJasparMotifs: vi.fn(),
}));
vi.mock('../../../api/externalTracks', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/externalTracks')>()),
  getUcscCurated: vi.fn(async () => ({ tracks: [] })),
}));
vi.mock('../../../api/recentTracks', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/recentTracks')>()),
  getRecentTracks: vi.fn(async () => []),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

describe('Add track: JASPAR suggestions', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.mocked(tracks.searchJasparMotifs).mockReset().mockResolvedValue({ available: true, results: [] });
    useBrowserStore.setState({
      currentGenome: 'hg38', catalog: [], selectedDatasets: new Set(['insert']),
      panels: [{ id: 'genomic', datasetId: 'g', contentType: 'dataset' }, { id: 'insert', datasetId: 'alt', genome: 'fasta:alt_x', contentType: 'dataset' }],
    } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function type(value: string) {
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(260);   // the search is debounced (200 ms)
  }

  it('sends the analysed panel reference, and searches again when the main genome or a declaration changes', async () => {
    await act(async () => root.render(<AddTrackBox />));
    await type('CTCF');
    const calls = () => vi.mocked(tracks.searchJasparMotifs).mock.calls;
    expect(calls().length).toBe(1);
    expect(calls()[0].slice(0, 2)).toEqual(['CTCF', 'fasta:alt_x']);         // the insert's reference, not 'hg38'
    // The main reference (no panel selected): no panel key; loading another main genome ranks again.
    await act(async () => { useBrowserStore.setState({ selectedDatasets: new Set(['genomic']) } as never); });
    await wait(260);
    expect(calls().at(-1)!.slice(0, 2)).toEqual(['CTCF', null]);
    const n = calls().length;
    await act(async () => { useBrowserStore.setState({ currentGenome: 'dm6' } as never); });
    await wait(260);
    expect(calls().length).toBe(n + 1);
    expect(calls().at(-1)!.slice(0, 2)).toEqual(['CTCF', null]);
    // A genome declared anywhere (the shared reference revision): searched again.
    await act(async () => { useBrowserStore.getState().bumpReferenceRevision(); });
    await wait(260);
    expect(calls().length).toBe(n + 2);
  });
});
