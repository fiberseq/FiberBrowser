/** Samples added before the run status arrives: the server's default cores and options still apply (Gemini L22). */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const { status } = vi.hoisted(() => {
  let resolve!: (v: unknown) => void;
  const promise = new Promise(r => { resolve = r; });
  return { status: { promise, resolve } as { promise: Promise<unknown>; resolve: (v: unknown) => void } };
});
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false, has_gtf: false, gene_count: 0, track_count: 0 })) }));
vi.mock('../../../api/pipeline', () => ({
  getPipelineStatus: vi.fn(() => status.promise),  // status.promise is replaced per test
  scanReads: vi.fn(async () => ({ success: true, warnings: [],
    samples: [{ key: 'k', name: 's1', order: null, barcode: null, size: 1, files: [{ path: '/tmp/s1.fastq', size: 1 }], kinds: ['fastq'] }] })),
  listJobs: vi.fn(async () => ({ jobs: [] })), getJob: vi.fn(), submitRun: vi.fn(), validateRun: vi.fn(), runDatasetQc: vi.fn(),
}));
vi.mock('../../../api/files', () => ({
  pickAnyFile: vi.fn(async () => ({ success: true, paths: ['/tmp/s1.fastq'] })),
  pickFolder: vi.fn(), pickFile: vi.fn(), pickDataset: vi.fn(), uploadFile: vi.fn(),
}));

import { DafRunHost } from './DafRunHost';
import { useDafRunStore } from './dafRunStore';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('samples picked while the status loads keep the server defaults (cores, options)', async () => {
  useBrowserStore.setState({ publicMode: false });
  useDafRunStore.setState({ open: true, tab: 'new', jobs: [], draft: null, draftSeeded: false });
  const box = document.createElement('div'); document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await act(async () => root.render(<DafRunHost />));
    const choose = box.querySelector('[data-testid="daf-run-choose-files"]') as HTMLElement | null;
    expect(choose).toBeTruthy();
    await act(async () => { choose!.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    await act(async () => {
      status.resolve({ available: true, aligner: { ok: true }, cores: 8, default_cores: 6, current_genome: 'hg38',
        genomes: [{ id: 'hg38', name: 'Human', downloaded: true, loaded: true, fasta: '/tmp/hg38.fa' }],
        output_parent: '/tmp/runs', default_options: { min_mapq: 37 }, loaded_references: [] });
      await new Promise(r => setTimeout(r, 20));
    });
    const draft = useDafRunStore.getState().draft as { samples: unknown[]; cores: number; options: Record<string, unknown> } | null;
    expect(draft?.samples).toHaveLength(1);
    expect(draft?.cores).toBe(6);
    expect(draft?.options.min_mapq).toBe(37);
  } finally {
    act(() => root.unmount()); box.remove();
  }
});

it('options changed while the status loads are kept over the server defaults (no silent revert)', async () => {
  status.promise = new Promise(r => { status.resolve = r; });
  useBrowserStore.setState({ publicMode: false });
  useDafRunStore.setState({ open: true, tab: 'new', jobs: [], draft: null, draftSeeded: false });
  const box = document.createElement('div'); document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await act(async () => root.render(<DafRunHost />));
    await act(async () => { (box.querySelector('[data-testid="daf-run-choose-files"]') as HTMLElement).click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    // The user changes options before the status arrives.
    await act(async () => {
      useDafRunStore.getState().updateDraft(prev => ({ ...prev!, options: { ...prev!.options, dedup: 'off', min_mapq: 20 } }));
    });
    await act(async () => {
      status.resolve({ available: true, aligner: { ok: true }, cores: 8, default_cores: 6, current_genome: 'hg38',
        genomes: [{ id: 'hg38', name: 'Human', downloaded: true, loaded: true, fasta: '/tmp/hg38.fa' }],
        output_parent: '/tmp/runs', default_options: { dedup: 'auto', min_mapq: 0, snp_screen: 'on' }, loaded_references: [] });
      await new Promise(r => setTimeout(r, 20));
    });
    const options = (useDafRunStore.getState().draft as { options: Record<string, unknown> } | null)?.options;
    expect(options?.dedup).toBe('off');
    expect(options?.min_mapq).toBe(20);
    expect(options?.snp_screen).toBe('on');   // an option the user left alone takes the server's default
  } finally {
    act(() => root.unmount()); box.remove();
  }
});
