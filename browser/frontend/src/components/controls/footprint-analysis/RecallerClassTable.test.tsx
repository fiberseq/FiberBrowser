import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { RecallerClassTable } from './RecallerClassTable';
import { SavedClassCard } from './SavedClassCard';
import { savedClassEntries } from '../../../utils/savedClasses';
import { useUndoToastStore } from '../../../stores/undoToastStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const r = (prevalence: number, extra = {}) => ({ prevalence, prevalence_edge: prevalence + .1, prevalence_loose: prevalence + .2, molecules: 100,
  prevalence_lower_bound: 0, broader: 0, other_shape: 0, accessible: 1 - prevalence, support_gain_nats: 20, supported: true,
  resolution_nats: 12, resolved: true, spots: '', L0: 0, L1: 1, R0: 2, R1: 3, unknown_accessible_fraction: .5, efficiency: null, ...extra });
const catalog = (p: number) => ({
  cr_mode: 'lattice_recaller', region: { chrom: 'chr1', start: 0, end: 1000 },
  datasets: {
    daf: { catalog: [{ family: 'class_001', consensus_start: 100, consensus_end: 140, recaller: { CT: r(p), GA: r(p, { supported: false }) } }] },
    hia5: { catalog: [{ family: 'class_001', consensus_start: 100, consensus_end: 140, recaller: { pooled: r(.5) } }] },
  },
}) as any;
const labels = { daf: 'DAF', hia5: 'Hia5' };

describe('recaller classes and saved classes', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr1' } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const save = (jobId: string, p: number, runLabel: string) => {
    act(() => root.render(<RecallerClassTable jobId={jobId} catalog={catalog(p)} datasetLabels={labels} runLabel={runLabel} />));
    act(() => (container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement).click());
  };

  it('saves a class as its own definition tied to its run, on its supported channels, strict', () => {
    act(() => root.render(<RecallerClassTable jobId="run1" catalog={catalog(.9)} datasetLabels={labels} runLabel="run 1" />));
    expect(container.querySelectorAll('[data-testid="recaller-bar"]')).toHaveLength(3);
    expect(container.querySelector('[data-testid="recaller-cell"]')).toBeNull();       // the numbers are in Saved
    act(() => (container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement).click());
    const groups = useBrowserStore.getState().footprintGroups;
    expect(groups.map(g => [g.sourceDatasetId, g.consensusStrand ?? null])).toEqual([['daf', 'CT'], ['hia5', null]]);   // GA unsupported
    expect(groups.every(g => g.savedClass?.id === 'S1' && g.consensusJobId === 'run1' && g.consensusStateId === 'class_001' && g.consensusTier === 'core')).toBe(true);   // strict stored explicitly (never inherits a wider run tier)
    // one label per class: its own id, not a per-view rank
    expect(groups[0].savedClass).toMatchObject({ runLabel: 'run 1', className: 'Class 001', picked: ['daf::CT', 'hia5::pooled'] });
    expect(container.querySelector('[data-testid="recaller-save"]')?.textContent).toBe('Remove');
    expect(container.querySelector('[data-testid="recaller-save"]')!.getAttribute('aria-label')).toBe('Remove Class 001 from Saved');
    act(() => (container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(0);
  });

  it('Add to Saved retains real dataset and genomic window provenance from the catalog', () => {
    const pooled = catalog(.9);
    pooled.region = { chrom: 'oriented_BED', start: 0, end: 1000 };
    pooled.datasets = { 'd@reverse': pooled.datasets.daf };
    pooled.region_sources = { 'd@reverse': { dataset_id: 'd', coordinate_origin: 0,
      window: { chrom: 'chr2', start: 1000, end: 2000, strand: '-' } } };
    act(() => root.render(<RecallerClassTable jobId="pooled" catalog={pooled} datasetLabels={{ d: 'Reads' }} runLabel="run 1" />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="recaller-save"]')!.click());
    expect(useBrowserStore.getState().footprintGroups[0]).toMatchObject({ sourceDatasetId: 'd', consensusDatasetId: 'd@reverse',
      referenceChrom: 'chr2', referenceAbsStart: 1860, referenceAbsEnd: 1900, consensusStrand: 'CT' });
  });

  it('keeps a class saved from one run when another run reuses its class id', () => {
    save('run1', .9, 'run 1'); save('run2', .3, 'run 2');
    const entries = savedClassEntries(useBrowserStore.getState().footprintGroups);
    expect(entries.map(e => [e.info.id, e.groups[0].consensusJobId, e.info.stats['daf::CT'].prevalence])).toEqual([['S1', 'run1', .9], ['S2', 'run2', .3]]);
  });

  it('has a key for the yellow dot wherever a row shows one (L10)', () => {
    act(() => root.render(<RecallerClassTable jobId="run1" catalog={catalog(.4)} datasetLabels={labels} runLabel="run 1" />));
    expect(container.querySelector('[data-testid="recaller-flag"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recaller-flag-legend"]')?.textContent).toBe('strands or datasets disagree');
  });

  it('a saved class chooses what it counts and its channels, keeping its entries', () => {
    save('run1', .9, 'run 1');
    const renderCard = () => { const [e] = savedClassEntries(useBrowserStore.getState().footprintGroups);
      act(() => root.render(<SavedClassCard info={e.info} groups={e.groups} filtering={false} onFilter={() => {}} targetDatasetIds={[]} chartWidth={300} />)); };
    renderCard();
    const ids = useBrowserStore.getState().footprintGroups.map(g => g.id);
    act(() => (container.querySelector('[data-testid="saved-class-tier-edge-input"]') as HTMLInputElement).click());
    let groups = useBrowserStore.getState().footprintGroups;
    expect(groups.map(g => g.id)).toEqual(ids);
    expect(groups.every(g => g.consensusTier === 'core+edge' && g.name.startsWith('S1 · Class 001 (strict + edge)'))).toBe(true);
    renderCard();
    // Picking GA as well makes the DAF entry cover both strands.
    act(() => (container.querySelectorAll('[data-testid="saved-class-channel"]')[1] as HTMLButtonElement).click());
    groups = useBrowserStore.getState().footprintGroups;
    expect(groups.map(g => [g.sourceDatasetId, g.consensusStrand ?? null])).toEqual([['daf', null], ['hia5', null]]);
    expect(groups[0].id).not.toBe(ids[0]);
    expect(groups[1].id).toBe(ids[1]);
  });
});

describe('How to read this: plain words and a labelled sample bar', () => {
  it('labels the parts of the bar', async () => {
    const { PrevalenceLegend } = await import('./RecallerClassTable');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const html = renderToStaticMarkup(<PrevalenceLegend />);
    for (const words of ['exact match', '+ sharing one edge', '+ other footprints here', 'grey', 'disagree']) expect(html).toContain(words);
    expect(html).not.toMatch(/EM prevalence|strict|channel/);
  });
});

describe('read-order robustness', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr1' } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('marks classes robust to read order, with a one-line summary, only for a run that had the check', () => {
    const two = (robust: [boolean, number][] | null) => ({
      cr_mode: 'lattice_recaller', region: { chrom: 'chr1', start: 0, end: 1000 },
      robustness: robust ? { orderings: 3, replicates: 2, robust_fraction: 1 } : undefined,
      datasets: { daf: { catalog: [100, 300].map((start, i) => ({ family: `class_00${i + 1}`, consensus_start: start, consensus_end: start + 20,
        recaller: { CT: r(.5) }, ...(robust ? { robust: robust[i][0], order_robustness: robust[i][1] } : {}) })) } },
    }) as any;
    act(() => root.render(<RecallerClassTable jobId="run1" catalog={two(null)} datasetLabels={labels} />));
    expect(container.querySelector('[data-testid="recaller-robust-summary"]')).toBeNull();     // default run: nothing new
    expect(container.querySelector('[data-testid="recaller-robust-badge"]')).toBeNull();
    act(() => root.render(<RecallerClassTable jobId="run1" catalog={two([[true, 1], [false, 1 / 3]])} datasetLabels={labels} />));
    expect(container.querySelector('[data-testid="recaller-robust-summary"]')?.textContent).toBe('1 of 2 classes are robust to read order');
    const rows = [...container.querySelectorAll('[data-testid="recaller-row"]')];
    expect(rows[0].querySelector('[data-testid="recaller-robust-badge"]')?.textContent).toBe('robust');
    expect(rows[1].querySelector('[data-testid="recaller-robust-badge"]')).toBeNull();
    expect(rows[1].querySelector('[data-testid="recaller-not-robust"]')?.parentElement?.getAttribute('title')).toContain('found in 1 of 3 read orders');
    expect(rows[0].querySelector('[data-testid="recaller-robust-badge"]')?.parentElement?.getAttribute('title')).toContain('found in 3 of 3 read orders');
  });
});

describe('usability round 1: one class identity, Inspect without saving, Add to Saved with undo, labelled tiers', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    useBrowserStore.setState({ footprintGroups: [], chrom: 'chr1', hasFasta: false } as any);
    useConsensusViewStore.setState({ selections: [] } as any);
    useUndoToastStore.setState({ toast: null });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('labels the class by its own id and the run by its kind; prints the tiers; a legend above the list', () => {
    act(() => root.render(<RecallerClassTable jobId="26a17840abcd" catalog={catalog(.9)} datasetLabels={labels} runLabel="run 1 · stringency 0.90" />));
    const row = container.querySelector<HTMLElement>('[data-testid="recaller-row"]')!;
    expect(row.querySelector('[data-testid="recaller-class-name"]')!.textContent).toBe('Class 001');
    expect(container.querySelector('[data-testid="recaller-run-label"]')!.textContent).toBe('Footprint run 26a1… · stringency 0.90');
    const tiers = [...row.querySelectorAll<HTMLElement>('[data-testid="recaller-tier-text"]')].map(t => t.textContent);
    expect(tiers[0]).toBe('90.0% · +10 · +10 pp');                            // CT: exact, then what each wider tier adds (N20), compact (R4)
    expect(tiers[1]).toBe('90.0%');                                           // GA: not supported, no upper tiers
    // the words are read out (and in the legend, the tooltip and Inspect)
    const words = [...row.querySelectorAll<HTMLElement>('[data-testid="recaller-channel-line"] .sr-only')].map(t => t.textContent);
    expect(words[0]).toBe('DAF CT: exact 90.0% · edge +10 pp · other +10 pp');
    expect(words[1]).toBe('DAF GA: exact 90.0%. Not supported on GA (exact matches only)');
    expect(container.querySelector('[data-testid="recaller-class-count"]')!.textContent).toBe('1 class in this window');   // scoped (R12)
    // the tooltip says the same increments first (one formatter), then the cumulative values, labelled apart
    const title = row.querySelector<HTMLElement>('[data-testid="recaller-tier-text"]')!.title;
    expect(title.split('\n')[0]).toBe('DAF CT: exact 90.0% · edge +10 pp · other +10 pp of 100 molecules');
    expect(title).toContain('cumulative: exact 90.0% · ≤ edge 100.0% · ≤ other 110.0%');
    expect(container.querySelector('[data-testid="recaller-legend-tiers"]')!.textContent).toBe('exact % · + edge · + other pp');
  });

  it('Inspect opens a class without saving it, and marks the row', () => {
    act(() => root.render(<RecallerClassTable jobId="run1" catalog={catalog(.9)} datasetLabels={labels} />));
    act(() => (container.querySelector('[data-testid="recaller-inspect"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="recaller-inspect-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recaller-inspect-channel"]')!.textContent).toContain('DAF CT: exact 90.0% · edge +10 pp · other +10 pp of 100 molecules');
    expect(container.querySelector('[data-testid="entry-inspect"]')).not.toBeNull();
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(0);         // nothing saved
    expect(container.querySelector<HTMLElement>('[data-testid="recaller-row"]')!.dataset.selected).toBe('true');
  });

  it('Add to Saved / Remove, with an undo for the removal', () => {
    act(() => root.render(<RecallerClassTable jobId="run1" catalog={catalog(.9)} datasetLabels={labels} runLabel="run 1" />));
    const button = () => container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement;
    expect(button().textContent).toBe('Add to Saved');
    act(() => button().click());
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(2);
    act(() => button().click());
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(0);
    const toast = useUndoToastStore.getState().toast!;
    expect(toast.text).toBe('Removed S1 · Class 001 from Saved');
    act(() => toast.undo());
    expect(useBrowserStore.getState().footprintGroups.map(g => g.savedClass?.id)).toEqual(['S1', 'S1']);
  });

  it('the Saved card: one label, run provenance, the named estimator and labelled tiers; Remove offers undo', async () => {
    act(() => root.render(<RecallerClassTable jobId="26a17840abcd" catalog={catalog(.9)} datasetLabels={labels} runLabel="run 1" />));
    act(() => (container.querySelector('[data-testid="recaller-save"]') as HTMLButtonElement).click());
    const [e] = savedClassEntries(useBrowserStore.getState().footprintGroups);
    act(() => root.render(<SavedClassCard info={e.info} groups={e.groups} filtering={false} onFilter={() => {}} targetDatasetIds={[]} chartWidth={300} />));
    expect(container.querySelector('[data-testid="saved-class-label"]')!.textContent).toBe('S1 · Class 001');
    expect(container.querySelector('[data-testid="saved-class-run"]')!.textContent).toContain('Footprint run 26a1…');
    expect(container.querySelector('[data-testid="saved-class-estimate"]')!.textContent).toContain('Estimated molecule prevalence');
    expect(container.querySelector('[data-testid="saved-class-tiers-text"]')!.textContent).toBe('exact 90.0% · edge +10 pp · other +10 pp · of 100 molecules');
    act(() => (container.querySelector('[data-testid="saved-class-remove"]') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(0);
    act(() => useUndoToastStore.getState().toast!.undo());
    expect(useBrowserStore.getState().footprintGroups).toHaveLength(2);
  });
});
