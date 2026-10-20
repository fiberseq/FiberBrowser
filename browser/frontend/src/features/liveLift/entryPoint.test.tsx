import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveLiftStore } from './store';
import { LiveLiftDialog } from './LiveLiftDialog';
import { useNativeBamLiftEntry } from './register';
import { inspectLiftMap, suggestLiftMaps } from './api';
import type { PanelConfig } from '../../types';

vi.mock('./api', async orig => ({ ...(await orig<typeof import('./api')>()), suggestLiftMaps: vi.fn(), inspectLiftMap: vi.fn() }));

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(inspectLiftMap).mockResolvedValue({ manifest: '/data/m.graphlift.json', haplotypes: [{ key: 'h1', label: 'MAT' }], targets: ['chr1'], sources: 1, chains: 1 });
  useLiveLiftStore.setState({ enabled: true, dialogOpen: false, prefillBams: null });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('viewing a loaded BAM on another assembly', () => {
  it('a native BAM panel offers it (flag on only); a lifted or linked panel does not', () => {
    let out: ReturnType<typeof useNativeBamLiftEntry> = null;
    function Probe({ panel, dataset }: { panel: PanelConfig; dataset: never }) { out = useNativeBamLiftEntry({ panel, dataset, showLayoutChrome: true }); return null; }
    const panel = { id: 'p', datasetId: 'n' } as PanelConfig;
    act(() => root.render(<Probe panel={panel} dataset={{ id: 'n', data_type: 'bam', path: '/data/s.bam', paths: ['/data/s.bam'] } as never} />));
    expect(out).not.toBeNull();
    act(() => root.render(<Probe panel={{ ...panel, liftLink: {} as never }} dataset={{ id: 'n', data_type: 'bam', path: '/data/s.bam' } as never} />));
    expect(out).toBeNull();
    act(() => root.render(<Probe panel={panel} dataset={{ id: 'n', data_type: 'bam_livelift', path: '/data/s.bam' } as never} />));
    expect(out).toBeNull();
    act(() => useLiveLiftStore.setState({ enabled: false }));
    act(() => root.render(<Probe panel={panel} dataset={{ id: 'n', data_type: 'bam', path: '/data/s.bam' } as never} />));
    expect(out).toBeNull();
  });
  it('opens the dialog with the BAM and the matching map found next to it', async () => {
    vi.mocked(suggestLiftMaps).mockResolvedValue({ near: '/data/s.bam', help: 'how', maps: [
      { manifest: '/data/m.graphlift.json', where: 'next to the BAM', haplotypes: ['MAT', 'PAT'], matches_bam: true, shared_contigs: 2 },
      { manifest: '/lib/other.graphlift.json', where: 'in the Library', matches_bam: false, shared_contigs: 0 }] });
    act(() => root.render(<LiveLiftDialog />));
    act(() => useLiveLiftStore.getState().openFor(['/data/s.bam']));
    await flush();
    expect((document.querySelector('[data-testid="live-lift-bams"]') as HTMLTextAreaElement).value).toBe('/data/s.bam');
    expect((document.querySelector('[data-testid="live-lift-manifest"]') as HTMLInputElement).value).toBe('/data/m.graphlift.json');
    const rows = [...document.querySelectorAll('[data-testid="live-lift-map-suggestion"]')].map(b => b.textContent);
    expect(rows[0]).toContain('matches the BAM');
    expect(rows[1]).toContain("not this map's sources");
  });
  it('explains what is needed when no map is found', async () => {
    vi.mocked(suggestLiftMaps).mockResolvedValue({ near: '/data/s.bam', help: 'A graphlift map relates…', maps: [] });
    act(() => root.render(<LiveLiftDialog />));
    act(() => useLiveLiftStore.getState().openFor(['/data/s.bam']));
    await flush();
    expect(document.querySelector('[data-testid="live-lift-map-help"]')?.textContent).toContain('A graphlift map relates');
  });
  it('opening from another BAM selects that BAM\'s map; a map the user typed stays', async () => {
    vi.mocked(suggestLiftMaps).mockImplementation(async near => ({ near, help: '', maps: [
      { manifest: near.startsWith('/a') ? '/a.graphlift.json' : '/b.graphlift.json', where: 'next to the BAM', matches_bam: true }] }));
    act(() => root.render(<LiveLiftDialog />));
    const manifest = () => (document.querySelector('[data-testid="live-lift-manifest"]') as HTMLInputElement).value;
    act(() => useLiveLiftStore.getState().openFor(['/a.bam']));
    await flush();
    expect(manifest()).toBe('/a.graphlift.json');
    act(() => useLiveLiftStore.getState().setDialogOpen(false));
    act(() => useLiveLiftStore.getState().openFor(['/b.bam']));
    await flush();
    expect(manifest()).toBe('/b.graphlift.json');
    // A typed map is the user's choice.
    const input = document.querySelector('[data-testid="live-lift-manifest"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, '/mine.graphlift.json'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => useLiveLiftStore.getState().setDialogOpen(false));
    act(() => useLiveLiftStore.getState().openFor(['/a.bam']));
    await flush();
    expect(manifest()).toBe('/mine.graphlift.json');
  });
});
