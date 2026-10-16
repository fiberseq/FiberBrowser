import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceManager } from './ReferenceManager';
import { PanelSiteBar } from '../tracks/PanelSiteBar';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { pickFile } from '../../api/files';
import { loadGtf, setCircularChrom } from '../../api/reference';
import { detachPanelGenome } from '../../api/panelGenomes';
import type { PanelConfig } from '../../types';
import type { PanelGenomeInfo } from '../../api/panelGenomes';

vi.mock('../../api/files', () => ({ pickFile: vi.fn() }));
vi.mock('../../api/panelGenomes', async importOriginal => ({ ...await importOriginal<object>(), detachPanelGenome: vi.fn(async () => ({ success: true })) }));
vi.mock('../../api/sharedFetch', () => ({ fetchJson: vi.fn(async () => ({ pairs: [] })) }));
vi.mock('../../api/reference', async importOriginal => ({ ...await importOriginal<object>(), loadGtf: vi.fn(), setCircularChrom: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const genome: PanelGenomeInfo = { key: 'fasta:constructs', label: 'Constructs', kind: 'fasta', genome_id: null, assembly: null,
  fasta_path: '/tmp/constructs.fa', gtf_path: '/tmp/constructs.gtf', has_fasta: true, has_gtf: true, gene_count: 2,
  n_chroms: 2, chroms: [{ name: 'ring', size: 6000, circular: true }, { name: 'linear', size: 2000 }] };
const panel = { id: 'p', datasetId: 'd', contentType: 'dataset', genome: genome.key, subTracks: [],
  viewportOverride: { chrom: 'ring', start: 100, end: 900 } } as unknown as PanelConfig;
let root: Root;
let container: HTMLDivElement;
const attach = vi.fn(async () => ({ success: true, genome }));
const detach = vi.fn(async () => {});
const realDetach = usePanelGenomeStore.getState().detach;
const close = vi.fn();
const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const click = async (id: string) => { await act(async () => button(id).click()); };
async function mount(chip = false) { await act(async () => root.render(chip ? <PanelSiteBar panel={panel} /> : <ReferenceManager panelId="p" onClose={close} />)); }

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useBrowserStore.setState({ panels: [panel], datasets: [{ id: 'd', label: 'Reads' }] as never, publicMode: false, exportInProgress: false,
    chroms: [{ name: 'chr1', size: 10000 }], currentGenome: 'hg38' });
  usePanelGenomeStore.setState({ genomes: { [genome.key]: genome, dm6: { ...genome, key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6' } },
    assignments: { d: genome.key }, refresh: vi.fn(async () => {}), attach, detach });
  useGenomeCheckStore.setState({ refresh: vi.fn(async () => {}), check: { datasets: [{ dataset_id: 'd', assembly: { short: 'dm6' },
    status: 'missing_contigs', severity: 'warning', message: 'Some contigs are missing from this reference.',
    suggestion: { can_load: true, genome_id: 'dm6' } }] } as never });
  vi.mocked(pickFile).mockResolvedValue({ success: true, path: '/tmp/new.gtf' });
  vi.mocked(loadGtf).mockResolvedValue({ success: true });
  vi.mocked(setCircularChrom).mockResolvedValue({ success: true });
});
afterEach(async () => {
  act(() => root.unmount());
  // Finish queued focus restoration before the next case mounts its chip.
  await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  container.remove(); vi.restoreAllMocks();
});

describe('Reference manager', () => {
  it('shows the panel reference, window, BAM reference and mismatch even if dismissed elsewhere', async () => {
    await mount();
    const text = button('reference-manager').textContent;
    for (const value of ['Constructs', '/tmp/constructs.fa', '/tmp/constructs.gtf', '2 contigs', 'Circular: ring', 'ring:100-900', 'Reads', 'Aligned to: dm6', 'Some contigs are missing']) expect(text).toContain(value);
    await click('reference-manager-fix');
    expect(attach).toHaveBeenCalledWith({ dataset_ids: ['d'], genome_id: 'dm6' });
  });
  it('attaches files and updates circular state on this reference only', async () => {
    await mount();
    await click('reference-manager-gtf');
    expect(loadGtf).toHaveBeenCalledWith('/tmp/new.gtf', genome.key);
    await click('reference-manager-fasta');
    expect(attach).toHaveBeenCalledWith({ dataset_ids: ['d'], fasta_path: '/tmp/new.gtf' });
    await click('reference-manager-circular-input');
    expect(setCircularChrom).toHaveBeenCalledWith('ring', false, genome.key);
  });
  it('switches to a loaded reference and can return to the main reference', async () => {
    await mount();
    const select = button('reference-manager-switch') as unknown as HTMLSelectElement;
    await act(async () => { select.value = 'dm6'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(attach).toHaveBeenCalledWith({ dataset_ids: ['d'], genome_id: 'dm6' });
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(detach).toHaveBeenCalledWith(['d']);
  });
  it('keeps failures visible and accepts picker cancellation', async () => {
    await mount();
    vi.mocked(pickFile).mockResolvedValueOnce({ success: false });
    await click('reference-manager-fasta');
    expect(attach).not.toHaveBeenCalled();
    vi.mocked(loadGtf).mockResolvedValueOnce({ success: false, message: 'Invalid annotation' });
    await click('reference-manager-gtf');
    expect(button('reference-manager-error').textContent).toBe('Invalid annotation');
  });
  it('keeps every dataset panel following the main viewport after detaching in Linked navigation', async () => {
    useBrowserStore.setState({ panels: [panel, { ...panel, id: 'p2' }], navigationMode: 'linked',
      chrom: 'chr1', start: 2000, end: 4000 });
    usePanelGenomeStore.setState({ detach: realDetach });
    await mount();
    vi.mocked(usePanelGenomeStore.getState().refresh).mockImplementationOnce(async () => {
      usePanelGenomeStore.setState({ assignments: {} });
      usePanelGenomeStore.getState().applyAssignments();
    });
    const select = button('reference-manager-switch') as unknown as HTMLSelectElement;
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(detachPanelGenome).toHaveBeenCalledWith(['d']);
    for (const p of useBrowserStore.getState().panels) {
      expect(p.genome).toBeUndefined();
      expect(p.viewportOverride).toBeUndefined();
    }
    act(() => useBrowserStore.getState().setViewport('chr1', 5000, 7000));
    const state = useBrowserStore.getState();
    for (const p of state.panels) {
      expect(p.viewportOverride ?? { chrom: state.chrom, start: state.start, end: state.end })
        .toEqual({ chrom: 'chr1', start: 5000, end: 7000 });
    }
  });
  it('disables changes in public mode and opens genome settings', async () => {
    useBrowserStore.setState({ publicMode: true });
    await mount();
    for (const id of ['fasta', 'gtf', 'switch', 'circular-input', 'fix']) expect(button(`reference-manager-${id}`).disabled).toBe(true);
    await click('reference-manager-settings');
    expect(useBrowserStore.getState().activeSection).toBe('genome');
    expect(close).toHaveBeenCalled();
  });
  it('opens from the chip, traps focus and closes with Escape', async () => {
    await mount(true);
    const chip = button('panel-genome-chip'); chip.focus();
    await click('panel-genome-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(document.activeElement).toBe(button('reference-manager'));
    button('reference-manager-library').focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })));
    expect(document.activeElement).toBe(button('reference-manager-close'));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    expect(button('reference-manager')).toBeNull();
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(chip);
  });
  it('opens from the overflow menu without leaving a menu over the dialog', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
    await mount(true);
    await click('panel-site-more');
    await click('panel-genome-chip');
    expect(button('panel-site-menu')).toBeNull();
    expect(document.activeElement).toBe(button('reference-manager'));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    expect(button('reference-manager')).toBeNull();
  });
});
