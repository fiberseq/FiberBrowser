import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import type { PanelGenomeInfo } from '../../api/panelGenomes';
import type { ChromInfo } from '../../types';
import { AxisTrack } from './AxisTrack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** fb-r2-integ (6): a panel's ruler reads its own reference's topology (circular chrM there, none in the main genome). */
const mito: PanelGenomeInfo = {
  key: 'fasta:mito', label: 'mito', kind: 'fasta', genome_id: null, assembly: null, fasta_path: '/refs/mito.fa',
  gtf_path: null, has_fasta: true, has_gtf: false, gene_count: 0, n_chroms: 1,
  chroms: [{ name: 'chrM', size: 16_569, circular: true }],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  useBrowserStore.setState({ chroms: [{ name: 'chr1', size: 248_956_422 } as ChromInfo] });
  usePanelGenomeStore.setState({ genomes: { [mito.key]: mito } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function hoverLeftEdge(): string | null {
  const canvas = host!.querySelector('canvas')!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 30, right: 1000, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
  act(() => { canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 10 })); });
  return useEphemeralStore.getState().crosshairLabel;
}

describe('AxisTrack on a panel with its own reference', () => {
  it('labels positions past the origin of its circular contig', () => {
    act(() => root!.render(<AxisTrack width={1000} height={30} genome={mito.key} overrideChrom="chrM" overrideStart={-200} overrideEnd={800} />));
    expect(hoverLeftEdge()).toBe('chrM:16,369 circular');
  });
});

it('mirrors ruler coordinates independently inside a panel', async () => {
  const { PanelDisplayContext } = await import('../../hooks/usePanelDisplayStore');
  useBrowserStore.setState({ navigationMode: 'perPanel', isReversed: false, panels: [{ id: 'reverse-ruler', reversed: true }] as never });
  act(() => root!.render(<PanelDisplayContext.Provider value="reverse-ruler"><AxisTrack width={1000} height={30}
    overrideChrom="chr1" overrideStart={1000} overrideEnd={2000} /></PanelDisplayContext.Provider>));
  expect(hoverLeftEdge()).toBe('chr1:2,000');
  act(() => useBrowserStore.getState().setPanelReversed('reverse-ruler', false));
  expect(hoverLeftEdge()).toBe('chr1:1,000');
});
