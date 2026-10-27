import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useHubData } from '../hub/hubData';
import type { ScanInfo } from '../hub/api';
import { PatchList } from './PatchList';
import type { NucObservation } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const obs: NucObservation[] = [
  { obsId: 'a', label: 'A', color: '#111111', datasetId: 'dA', panelId: 'p1', stateKey: 'p1', kind: 'linear', chrom: 'chr3', start: 0, end: 50_000 },
  { obsId: 'b', label: 'B', color: '#222222', datasetId: 'dB', panelId: 'p2', stateKey: 'p2', kind: 'linear', chrom: 'chr3', start: 0, end: 50_000 },
];
const scan = { scanId: 's1', path: '/scan', label: 'scan', source: 'cache', manifestDigest: 'm', units: { mode: 'grid' },
  modules: { nuc: { version: '2.2', settingsHash: 'h', experimental: true } }, annotate: false, annotated: [],
  datasets: [{ scanDataset: 'dataset_1', ordinal: 1, files: [], dataset: 'dA', status: 'bound' }], sets: [] } as unknown as ScanInfo;
const hit = (id: string, type: string, start: number, extra: Record<string, unknown> = {}) => ({
  hitId: id, typeId: `nuc.patch.${type}`, chrom: 'chr3', start, end: start + 2000, anchor: start + 1000, label: id, score: 0.6,
  flags: [], zeroWidth: false, columns: {}, raw: {}, groupKinds: {}, module: { q_hat: type === 'regular' ? 188.4 : '', P: type === 'phased' ? 190 : '' }, ...extra });

describe('patch list', () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: Array<{ url: string; body?: any }>;
  beforeEach(() => {
    requests = [];
    useBrowserStore.setState({ chrom: 'chr3', start: 10_000, end: 40_000, showDuplicateReads: false } as never);
    useHubData.setState({ scans: [scan] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = url.includes('/hits')
        ? { hits: [hit('r1', 'regular', 12_000), hit('m1', 'missing', 20_000), hit('p1', 'phased', 30_000, { raw: { dataset_1: { R_minus_null: { v: 0.31 } } } })], truncated: false }
        : { fdr: 0.05, observations: [
          { obsId: 'a', datasetId: 'dA', patches: { 's1|r1': { kind: 'reg', n: 20, fraction: 0.71, p: 0.001, q: 0.002, significant: true }, 's1|m1': { kind: 'mis', n: 20, fraction: 0.04, p: 0.4, q: 0.4, significant: false } } },
          { obsId: 'b', datasetId: 'dB', patches: { 's1|r1': { kind: 'reg', n: 9, fraction: 0.3, p: 0.2, q: 0.3, significant: false }, 's1|m1': { error: 'Not on this observation' } } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); useHubData.setState({ scans: [] }); });

  it('lists the patches in view with each observation’s own score, and selects molecules from a cell', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<PatchList observations={obs} settings={{}} setSettings={() => { }} onSelect={onSelect} revision="r1" />));
    await act(async () => { vi.advanceTimersByTime(400); });
    await act(async () => { await Promise.resolve(); });
    await vi.waitFor(() => expect(container.querySelectorAll('[data-testid="nuc-patch-score"]').length).toBe(3));
    const rowsEls = [...container.querySelectorAll('[data-testid="nuc-patch-row"]')];
    expect(rowsEls.map(r => r.getAttribute('data-type'))).toEqual(['regular', 'missing', 'phased']);
    expect(rowsEls[0].textContent).toContain('188');
    expect(rowsEls[0].textContent).toContain('71%');
    expect(rowsEls[1].textContent).toContain('n/a');
    // Phased patches carry the scan's own per-dataset value, for the dataset the scan bound.
    expect(rowsEls[2].querySelector('[data-testid="nuc-patch-scan-value"]')!.textContent).toBe('R−null 0.31');
    // Only the recurrence kinds are scored per observation.
    const scored = requests.find(r => r.url.includes('/api/nuc/patches'))!.body;
    expect(scored.patches.map((p: { type: string }) => p.type)).toEqual(['regular', 'missing']);
    act(() => (rowsEls[0].querySelector('[data-testid="nuc-patch-score"] button') as HTMLElement).click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ obsId: 'a', start: 12_000, end: 14_000 }), { kind: 'segment', state: 'regular', scope: 'patch' });
    // Codex E1: new outputs (a compute, a scan, dataset content) or a changed read scope score again.
    const scoredRequests = () => requests.filter(r => r.url.includes('/api/nuc/patches')).length;
    const before = scoredRequests();
    await act(async () => root.render(<PatchList observations={obs} settings={{}} setSettings={() => { }} onSelect={onSelect} revision="r2" />));
    await vi.waitFor(() => expect(scoredRequests()).toBe(before + 1));
    const scoped = [{ ...obs[0], readIds: ['q1'] }, obs[1]];
    await act(async () => root.render(<PatchList observations={scoped} settings={{}} setSettings={() => { }} onSelect={onSelect} revision="r2" />));
    await vi.waitFor(() => expect(scoredRequests()).toBe(before + 2));
    expect(requests.filter(r => r.url.includes('/api/nuc/patches')).at(-1)!.body.observations[0].readIds).toEqual(['q1']);
  });

  it('runs the nuc scan over the view', async () => {
    await act(async () => root.render(<PatchList observations={obs} settings={{ parameters: { calibration: 'self' } }} setSettings={() => { }} onSelect={() => { }} revision="r1" />));
    await act(async () => (container.querySelector('[data-testid="nuc-find-patches"]') as HTMLElement).click());
    const submitted = requests.find(r => r.url.includes('/api/scan/jobs'))!.body;
    expect(submitted).toMatchObject({ datasets: ['dA', 'dB'], scope: 'view', chrom: 'chr3', start: 10_000, end: 40_000, modules: ['nuc'],
      parameters: { nuc: { calibration: 'self' } } });
  });
});

describe('patch list: scoped columns', () => {
  it('a column of part of a dataset never shows the scan\'s whole-dataset value (Codex E2-3)', async () => {
    useBrowserStore.setState({ chrom: 'chr3', start: 10_000, end: 40_000, showDuplicateReads: false } as never);
    useHubData.setState({ scans: [scan] });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/hits')
      ? { hits: [hit('p1', 'phased', 30_000, { raw: { dataset_1: { R_minus_null: { v: 0.31 } } } })], truncated: false }
      : { fdr: 0.05, observations: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    const scoped = [obs[0], { ...obs[0], obsId: 'a2', readIds: [] as string[] }];
    await act(async () => root.render(<PatchList observations={scoped} settings={{}} setSettings={() => { }} onSelect={() => { }} revision="r1" />));
    await vi.waitFor(() => expect(container.querySelectorAll('[data-testid="nuc-patch-scan-value"]').length).toBe(2), { timeout: 3000 });
    expect([...container.querySelectorAll('[data-testid="nuc-patch-scan-value"]')].map(e => e.textContent)).toEqual(['R−null 0.31', '—']);
    act(() => root.unmount()); container.remove(); spy.mockRestore(); useHubData.setState({ scans: [] });
  });
});
