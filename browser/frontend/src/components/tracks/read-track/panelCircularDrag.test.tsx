import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import type { PanelGenomeInfo } from '../../../api/panelGenomes';
import type { ChromInfo } from '../../../types';
import { useReadTrackMouse } from './useReadTrackMouse';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-r2-integ (6): a panel on its own reference pans by that reference's
 * topology. The main FASTA has no chrM; the panel's own reference has a
 * circular chrM: dragging that panel across position 0 wraps instead of
 * clamping at 0.
 */
const plasmid: PanelGenomeInfo = {
  key: 'fasta:mito', label: 'mito', kind: 'fasta', genome_id: null, assembly: null, fasta_path: '/refs/mito.fa',
  gtf_path: null, has_fasta: true, has_gtf: false, gene_count: 0, n_chroms: 1,
  chroms: [{ name: 'chrM', size: 16_569, circular: true }],
};

type Handlers = ReturnType<typeof useReadTrackMouse>;
let handlers: Handlers | null = null;

function Harness({ genome, onViewportChange }: { genome?: string; onViewportChange: (s: number, e: number) => void }) {
  handlers = useReadTrackMouse({
    displayReads: [], width: 1000, height: 200, sidebarWidth: 0, regionWidth: 1000, start: 100, end: 1100,
    chrom: 'chrM', datasetId: 'ds1', stateKey: 'ds1', hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    myClusterFocus: null, mySelectedClusters: null, hasClusterFocus: false, isPanning: false, isReversed: false,
    fillReadHeight: false, storeReadRowHeight: 'auto', readScrollOffset: 0, readSeparatorMode: 'none' as never,
    readSeparatorMinHeight: 0, readSeparatorWidth: 0, showReadTooltip: false, showCoverageHistogram: false,
    onViewportChange, panScope: 'panel:ds1', genome,
  });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  useBrowserStore.setState({ chroms: [{ name: 'chr1', size: 248_956_422 } as ChromInfo] });
  usePanelGenomeStore.setState({ genomes: { [plasmid.key]: plasmid }, assignments: { ds1: plasmid.key } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  handlers = null;
});

function drag(fromX: number, toX: number) {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
  Object.defineProperty(canvas, 'clientHeight', { value: 200 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  act(() => {
    handlers!.handleMouseDown({ button: 0, clientX: fromX, clientY: 50, currentTarget: canvas, preventDefault: () => {} } as never);
  });
  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: toX, clientY: 50 }));
  });
}

describe('panel drag across the origin of its own circular contig', () => {
  it('wraps on the panel reference (not clamped by the main genome)', () => {
    const onViewportChange = vi.fn();
    act(() => root!.render(<Harness genome={plasmid.key} onViewportChange={onViewportChange} />));
    // Drag right by 300 px = 300 bp to the left: 100 - 300 = -200.
    drag(200, 500);
    expect(onViewportChange).toHaveBeenCalledWith(-200, 800);
  });

  it('still clamps at 0 on a linear contig of the main genome', () => {
    const onViewportChange = vi.fn();
    act(() => root!.render(<Harness onViewportChange={onViewportChange} />));
    drag(200, 500);
    expect(onViewportChange).toHaveBeenCalledWith(0, 1000);
  });
});
