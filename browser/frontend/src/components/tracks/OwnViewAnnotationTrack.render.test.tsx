import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { OwnViewAnnotationTrack } from './OrthogonalTrack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('motif tracks in a panel on a contig of its own', () => {
  it('are fetched for the panel\'s own contig and reference, not the main view', async () => {
    const calls: string[] = [];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, json: async () => ({ tracks: [{ index: 3, intervals: [{ start: 2210, end: 2215, name: 'GGGTG', strand: '+', score: 1 }] }] }) } as Response;
    }));
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<OwnViewAnnotationTrack width={400} height={20} label="hobo GGGTG" trackIndex={3} trackType="motif"
      view={{ chrom: 'chr2L_9471223_INS1888', start: 1500, end: 4500 }} genome="fasta:alt_1" />));
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
    vi.useRealTimers();
    expect(calls[0]).toContain('/api/tracks/batch?panel_genome=fasta%3Aalt_1');
    expect(bodies[0]).toMatchObject({ track_indices: [3], chrom: 'chr2L_9471223_INS1888', start: 1500, end: 4500 });
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});
