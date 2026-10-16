// Footprints panel audit fixes (FiberBrowser 3.0 UI audit, stream B): M8, M21, L9, L10, L11.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedClassCard, SavedClassesSummary } from './SavedClassCard';
import { CoOccurrenceTab } from './CoOccurrenceTab';
import { ConsensusProgress } from './ConsensusProgress';
import { SizesTab } from './SizesTab';
import * as workflow from '../../../api/consensusWorkflow';
import type { ConsensusJob } from '../../../api/consensusWorkflow';

const stats = (prevalence: number, molecules: number) => ({ prevalence, prevalence_edge: prevalence, prevalence_loose: prevalence, supported: true, resolved: true, molecules });
// The audit's class: CT 45.9% of 1,432 and GA 36.6% of 1,217 molecules.
const info = { id: 'S1', family: 'class_003', className: 'Class 1', runLabel: 'run 1', start: 100, end: 141,
  channels: [{ key: 'd::CT', datasetId: 'd', strand: 'CT', label: 'D CT', daf: true }, { key: 'd::GA', datasetId: 'd', strand: 'GA', label: 'D GA', daf: true }],
  stats: { 'd::CT': stats(0.4589, 1432), 'd::GA': stats(0.3661, 1217) }, picked: ['d::CT', 'd::GA'] } as any;
const classGroup = { id: 'g1', name: 'S1 · Class 1 · d', color: '#7c3aed', sizeMin: 0, sizeMax: null, enabled: true, sourceIndex: -1,
  consensusJobId: 'run1', consensusStateId: 'class_003', sourceDatasetId: 'd', consensusTier: 'core', savedClass: info } as any;
const dataset = { id: 'd', label: 'D', color: '#000' } as any;

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('M8: the two occupancy numbers say what they count', () => {
  it('Saved shows the run estimate of molecules, and says how it differs from Co-occupancy', async () => {
    vi.spyOn(workflow, 'getConsensusJob').mockResolvedValue({ job_id: 'run1', status: 'complete' } as any);
    await act(async () => root.render(<SavedClassCard info={info} groups={[classGroup]} filtering={false} onFilter={() => {}} targetDatasetIds={['d']} chartWidth={300} />));
    const estimate = container.querySelector<HTMLElement>('[data-testid="saved-class-estimate"]')!;
    // the estimator is named, as Co-occupancy names its own
    expect(estimate.textContent).toBe('Estimated molecule prevalence 41.6% of 2,649 molecules');
    expect(estimate.title).toMatch(/duplicate reads of one molecule count once/);
    expect(estimate.title).toMatch(/Co-occupancy shows the confident-call read fraction instead/);
  });

  it('Co-occupancy says its counts are reads in view, and why its % differs from Saved', async () => {
    const result = { co_occupancy: { d: { total_reads: 3202, pairs: [], per_group: [{ eligible_reads: 2965, n_with: 1132, n_without: 1833, not_evaluated_reads: 237, ids_with: [], ids_without: [] }] } } } as any;
    await act(async () => root.render(<CoOccurrenceTab result={result} footprintGroups={[classGroup]} targetDatasets={[dataset]} coOccLoading={false} clusterLoading={false}
      footprintFilterKey={null} currentLayer={null} handleCellClick={() => {}} handleClusterByGroups={() => {}} />));
    const card = container.querySelector<HTMLElement>('[data-testid="coocc-per-group"]')!;
    expect(card.textContent).toContain('reads in view');
    expect(container.querySelector('[data-testid="coocc-group-not-spanning"]')?.textContent).toBe("237 more reads not scored: they don't cover the class and its flanks");
    expect(card.textContent).not.toContain('not evaluated');
    expect(container.querySelector('[data-testid="coocc-vs-saved"]')?.textContent).toMatch(/differs from Saved[^]*uncertain calls count as without[^]*duplicate reads of one molecule count once/);
  });
});

describe('L10: saved classes use icons and one count', () => {
  it('copy and remove are icon buttons with names, not glyphs', async () => {
    vi.spyOn(workflow, 'getConsensusJob').mockResolvedValue({ job_id: 'run1', status: 'complete' } as any);
    await act(async () => root.render(<SavedClassCard info={info} groups={[classGroup]} filtering={false} onFilter={() => {}} targetDatasetIds={['d']} chartWidth={300} />));
    for (const [id, label] of [['saved-class-copy', 'Copy S1'], ['saved-class-remove', 'Remove S1']]) {
      const b = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
      expect(b.getAttribute('aria-label')).toBe(label);
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.textContent).toBe('');
    }
    expect(container.textContent).not.toMatch(/[×⧉]/);
  });

  it('the summary row does not count the saved classes again', () => {
    const html = renderToStaticMarkup(<SavedClassesSummary groups={[classGroup]} />);
    expect(html).not.toMatch(/\d saved class/);
    expect(html).toContain('Export TSV');
  });
});

describe('L11: an occupancy filter is announced once (the Clear filter bar)', () => {
  it('no second notice and no "Filtering reads" in the tab header', async () => {
    const result = { co_occupancy: { d: { total_reads: 10, pairs: [], per_group: [{ eligible_reads: 10, n_with: 3, n_without: 7, ids_with: ['a'], ids_without: ['b'] }] } } } as any;
    await act(async () => root.render(<CoOccurrenceTab result={result} footprintGroups={[classGroup]} targetDatasets={[dataset]} coOccLoading={false} clusterLoading={false}
      footprintFilterKey="d:-1:with" currentLayer={null} handleCellClick={() => {}} handleClusterByGroups={() => {}} />));
    expect(container.textContent).not.toContain('Occupancy-filtered reads are active');
    expect(container.textContent).not.toContain('Filtering reads');
  });
});

describe('L9: the progress card names stages in plain words', () => {
  const job = (stage: string) => ({ job_id: 'j', status: 'running', stage, cr_mode: 'lattice_recaller', message: '', created_at: 1, started_at: 1 }) as unknown as ConsensusJob;
  it.each([['recaller_discovery', 'Finding classes'], ['recaller_quantify', 'Counting each class on the molecules']])('%s → %s', (stage, label) => {
    const html = renderToStaticMarkup(<ConsensusProgress job={job(stage)} />);
    expect(html).toContain(label);
    expect(html).not.toContain(stage);
  });
  it('an unlisted stage never shows its id', () => {
    const html = renderToStaticMarkup(<ConsensusProgress job={job('some_new_internal_stage')} />);
    expect(html).not.toContain('some_new_internal_stage');
    expect(html).toContain('Working');
  });
});

describe('M21: the size histogram fits its card', () => {
  it('takes the width of its box, not the panel width', async () => {
    const observers: Array<(entries: any[]) => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: any) { observers.push(cb); } observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const result = { overlap_stats: { d: { per_footprint: [{ overlap_count: 100, size_histogram: { bins: [10, 15, 20, 25], counts: [10, 40, 30, 20] } }] } } } as any;
    const fp = { chrom: 'chr1', absStart: 100, absEnd: 120, size: 20, layer: null } as any;
    await act(async () => root.render(<SizesTab result={result} selectedFootprints={[fp]} targetDatasets={[dataset]} chartWidth={600}
      footprintGroups={[]} addFootprintGroup={() => {}} updateFootprintGroup={() => {}} removeFootprintGroup={() => {}} hideCartList />));
    await act(async () => observers.forEach(cb => cb([{ contentRect: { width: 420 } }])));
    const canvas = container.querySelector<HTMLCanvasElement>('[data-testid="footprint-size-histogram"] canvas')!;
    expect(canvas.style.width).toBe('420px');
  });
});
