import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { ExpansionOverlay } from './ExpansionOverlay';
import { makeAxis } from './axis';
import { normalizeExpansions } from './persistence';
import { useBrowserStore } from '../../stores/browserStore';
import { useDifferenceSelection } from './inspectionStore';
import { openSourceView } from './sourceView';

vi.mock('./sourceView', () => ({ openSourceView: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it.each([{ initiating: 'PAT', closed: false }, { initiating: 'PAT', closed: true }, { initiating: 'native', closed: true }])(
  'uses PAT from the $initiating header (MAT closed: $closed)', async ({ initiating, closed }) => {
  const pat: any = { id: 'pat', datasetId: 'lift', liftHap: 'PAT' };
  const native: any = { id: 'native', datasetId: 'native' };
  const mat: any = { id: 'mat', datasetId: 'lift', liftHap: 'MAT' };
  useBrowserStore.setState({ panels: closed ? [pat, native] : [mat, pat, native] });
  const expansion = { chrom: 'chr1', pos: 500, ins_id: 'mat-ins', hap_label: 'MAT', length: 100,
    datasetId: 'lift', label: 'shared', src: { contig: 'mat', start: 100, end: 200 }, strand: '+' as const,
    alleles: [{ ins_id: 'pat-ins', hap_label: 'PAT', length: 98, src: { contig: 'pat', start: 300, end: 398 }, strand: '-' as const }] };
  const restored = normalizeExpansions(JSON.parse(JSON.stringify({ main: [expansion] }))).main[0];
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(<ExpansionOverlay panel={initiating === 'PAT' ? pat : native} viewKey="main" axis={makeAxis(0, 1000, 1000, false, [restored])} />));
    const buttons = [...host.querySelectorAll('button')];
    act(() => buttons.find(b => b.textContent === 'Identify')!.click());
    const selected = useDifferenceSelection.getState().selection!;
    expect(selected).toMatchObject({ panelId: 'pat', datasetId: 'lift', action: 'identify', difference: {
      id: 'pat-ins', hap_label: 'PAT', alt_bp: 98, strand: '-', src: { contig: 'pat', start: 300, end: 398 } } });
    await act(async () => buttons.find(b => b.textContent === 'Open in HG002 view')!.click());
    expect(openSourceView).toHaveBeenLastCalledWith(expect.objectContaining({ panelId: 'pat', difference: selected.difference }));
  } finally { act(() => root.unmount()); host.remove(); useDifferenceSelection.getState().select(null); }
});
