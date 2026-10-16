import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry, RecallPlan } from '../../../api/library';
import { LibraryDetails } from './LibraryDetails';

const api = vi.hoisted(() => ({ get: vi.fn(), recall: vi.fn(), locate: vi.fn(), pick: vi.fn() }));
vi.mock('../../../api/library', () => ({
  getLibraryEntry: api.get, recallLibraryEntry: api.recall,
  getLibraryEntryQc: vi.fn(), editLibraryEntry: vi.fn(), locateLibraryEntry: api.locate,
  removeLibraryEntries: vi.fn(), rescanLibraryEntry: vi.fn(), revealLibraryEntry: vi.fn(),
}));
vi.mock('../../../api/files', () => ({ pickAnyFile: api.pick }));
vi.mock('../daf-run/QcReport', () => ({
  QcReport: () => null,
  VerdictChip: (p: { label: string; status: string | null }) => <span data-testid="chip">{`${p.label}:${p.status}`}</span>,
}));
vi.mock('../daf-run/dafRunStore', () => ({ openDafRunDialog: vi.fn() }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: string): LibraryEntry => ({
  id, kind: 'bam', path: `/scratch/${id}.bam`, folder: '/scratch', label: id,
  available: true, tags: [], notes: '', inspected: 1, rerun: 'rerun-required',
  chemistry: { key: 'dddb', declared: true },
});

const planFor = (id: string): RecallPlan => ({
  entry_id: id, plan_id: `plan-${id}`, tool: 'fiberhmm-pipeline', sample: id, enzyme: 'dddb', cores: 4,
  reads: [`/scratch/${id}.aligned.bam`], outdir: `/scratch/${id}_out`, regions: [],
  display_command: `fiberhmm-pipeline /scratch/${id}.aligned.bam --dedup off`,
  settings: { source: 'outputs.json', labels: ['duplicates off'], regions_recorded: false },
  advisories_fixed: ['dddb-gt-table'],
});

describe('LibraryDetails re-call', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (id: string) => {
    await act(async () => root.render(
      <LibraryDetails entry={entry(id)} groups={[]} fiberhmmVersion="3.0.0"
        onOpen={() => {}} onChanged={() => {}} onAddToGroup={() => {}} />));
  };
  const button = () => container.querySelector('[data-testid="library-recall"]') as HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockImplementation(async (id: string) => ({ entry: entry(id) }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  // Usability round 3, R15: the details pane leads with what the advisory means, and folds the long advisory text.
  it('leads with a one-line consequence; the advisory text is folded; Re-call stays out of the fold', async () => {
    api.get.mockImplementation(async (id: string) => ({ entry: { ...entry(id), advisories: { key: 'k', items: [
      { id: 'dddb-gt-table', title: 'DddB calls made with an older model', severity: 'rerun-required', reason: 'A long reason.' },
    ] } } }));
    await render('A');
    const line = container.querySelector('[data-testid="library-rerun-consequence"]')!;
    expect(line.textContent).toBe('Opens as called, but a known FiberHMM problem changes its calls: re-call it before comparing results.');
    const fold = container.querySelector('details[data-testid="library-advisories-details"]') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toBe('FiberHMM advisories (1) · why, and how to fix');
    expect(fold.textContent).toContain('A long reason.');
    expect(fold.contains(button())).toBe(false);
    expect(button()).not.toBeNull();
  });

  it("drops a late dry-run answer for another entry and starts only the shown entry's reviewed plan", async () => {
    // Review round 4: A's dry run answered after B was selected, B showed A's plan,
    // and Start re-called B with no plan at all.
    let resolveA!: (value: unknown) => void;
    api.recall.mockImplementationOnce(() => new Promise(r => { resolveA = r; }));
    await render('A');
    await act(async () => button().click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { dry_run: true });

    await render('B');
    await act(async () => resolveA({ success: true, plan: planFor('A') }));
    expect(container.textContent).not.toContain('/scratch/A_out');
    expect(container.querySelector('[data-testid="library-recall-plan"]')).toBeNull();
    expect(button().textContent).toBe('Re-call with FiberHMM 3.0.0');
    expect(container.querySelector('[data-testid="library-details-message"]')).toBeNull();

    api.recall.mockResolvedValueOnce({ success: true, plan: planFor('B') });
    await act(async () => button().click());
    expect(api.recall).toHaveBeenLastCalledWith('B', { dry_run: true });
    const shown = container.querySelector('[data-testid="library-recall-plan"]')!;
    expect(shown.textContent).toContain('/scratch/B_out');
    expect(shown.textContent).toContain('duplicates off');
    expect(shown.textContent).toContain('fiberhmm-pipeline /scratch/B.aligned.bam --dedup off');
    expect(button().textContent).toBe('Start the re-call');

    api.recall.mockResolvedValueOnce({ success: true, job: { id: 'job-1' } });
    await act(async () => button().click());
    expect(api.recall).toHaveBeenLastCalledWith('B', { outdir: '/scratch/B_out', cores: 4, plan_id: 'plan-B' });
  });

  it("a reviewed plan does not survive a switch to another entry", async () => {
    api.recall.mockResolvedValueOnce({ success: true, plan: planFor('A') });
    await render('A');
    await act(async () => button().click());
    expect(button().textContent).toBe('Start the re-call');
    await render('B');
    expect(button().textContent).toBe('Re-call with FiberHMM 3.0.0');
    api.recall.mockResolvedValueOnce({ success: false, error: 'Re-calling cannot fix everything:\n- tag-m5c: Re-run fiberhmm-tag-m5c' });
    await act(async () => button().click());
    expect(api.recall).toHaveBeenLastCalledWith('B', { dry_run: true });
    expect(container.querySelector('[data-testid="library-details-message"]')!.textContent).toContain('Re-run fiberhmm-tag-m5c');
  });
});


const headerPlan = (id: string, extra: Partial<NonNullable<RecallPlan['header']>> = {}): RecallPlan => ({
  entry_id: id, plan_id: `hplan-${id}`, tool: 'fiberhmm-call', sample: id, enzyme: 'dddb', cores: 4,
  reads: ['/data/s01.aligned.sorted.bam'], outdir: '/runs/s01_recall', regions: [], version: '3.0.0',
  display_command: 'fiberhmm-call -i /data/s01.aligned.sorted.bam -o /runs/s01_recall/s01.fixed.dddb.bam --dedup -c 4',
  settings: { source: 'BAM header', labels: ['the fiberhmm-call 2.16.8 command in the BAM header'], regions_recorded: false },
  advisories_fixed: ['daf-dedup-orientation'], output_bam: '/runs/s01_recall/s01.fixed.dddb.bam',
  header: {
    program: 'fiberhmm-call', version: '2.16.8',
    command_line: '/old/fiberhmm/cli/call.py -i /data/s01.aligned.sorted.bam -o calls/s01.fixed.dddb.bam --dedup -c 4',
    rewrites: [{ flag: '-o', from: 'calls/s01.fixed.dddb.bam', to: '/runs/s01_recall/s01.fixed.dddb.bam', why: "into the re-call's folder" }],
    changed_defaults: [{ id: 'alignments', text: 'FiberHMM 3.0 also calls supplementary alignments (the other parts of a split read); the original called primary alignments only.', restore: ['--alignments', 'primary'], kept_old: false }],
    input: { flag: '-i', recorded: '/data/s01.aligned.sorted.bam', path: '/data/s01.aligned.sorted.bam', how: 'as recorded' },
    warnings: [], not_fixed: [], keep_old: [],
    ...extra,
  },
});

describe('LibraryDetails re-call from the BAM header', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (id: string) => {
    await act(async () => root.render(
      <LibraryDetails entry={entry(id)} groups={[]} fiberhmmVersion="3.0.0"
        onOpen={() => {}} onChanged={() => {}} onAddToGroup={() => {}} />));
  };
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockImplementation(async (id: string) => ({ entry: entry(id) }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  it('shows the original and the new command with every change, and starts only after the review', async () => {
    api.recall.mockResolvedValueOnce({ success: true, plan: headerPlan('A') });
    await render('A');
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(q('library-recall-settings')!.textContent).toContain('Settings from the BAM header');
    expect(q('library-recall-original')!.textContent).toContain('-o calls/s01.fixed.dddb.bam');
    expect(q('library-recall-command')!.textContent).toContain('-o /runs/s01_recall/s01.fixed.dddb.bam');
    expect(q('library-recall-rewrites')!.textContent).toContain("calls/s01.fixed.dddb.bam → /runs/s01_recall/s01.fixed.dddb.bam (into the re-call's folder)");
    expect(q('library-recall-defaults')!.textContent).toContain('also calls supplementary alignments');
    expect(q('library-recall-defaults')!.textContent).toContain('keep the original behaviour (--alignments primary)');
    expect(api.recall).toHaveBeenCalledTimes(1);  // nothing started yet

    // Keeping the original behaviour plans again with it.
    api.recall.mockResolvedValueOnce({ success: true, plan: { ...headerPlan('A', { keep_old: ['alignments'] }), plan_id: 'hplan-A2' } });
    await act(async () => (q('library-recall-keep-alignments') as HTMLInputElement).click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { dry_run: true, keep_old: ['alignments'] });

    api.recall.mockResolvedValueOnce({ success: true, job: { id: 'job-1' } });
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { outdir: '/runs/s01_recall', cores: 4, plan_id: 'hplan-A2', keep_old: ['alignments'] });
  });

  it('shows a retired option of the original command as left out, with the reason', async () => {
    const plan = headerPlan('A', {
      rewrites: [{ flag: '--phase-nrl', from: 'auto', to: null, why: 'retired in FiberHMM 3.0: caused artifacts' }],
    });
    api.recall.mockResolvedValueOnce({ success: true, plan });
    await render('A');
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(q('library-recall-dropped')!.textContent).toBe('--phase-nrl: auto → left out (retired in FiberHMM 3.0: caused artifacts)');
  });

  it('asks for a missing input, plans again with the chosen file, and starts with it', async () => {
    api.recall.mockResolvedValueOnce({ success: false, error: 'The input the header records was not found on this computer: /mnt/g/x.raw.bam.',
      needs_input: { flag: '-i', recorded: '/mnt/g/x.raw.bam', reason: 'missing' } });
    await render('A');
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(q('library-recall-needs-input')!.textContent).toContain('/mnt/g/x.raw.bam');
    api.pick.mockResolvedValueOnce({ success: true, path: '/Users/me/x.raw.bam' });
    const chosen = headerPlan('A', { input: { flag: '-i', recorded: '/mnt/g/x.raw.bam', path: '/Users/me/x.raw.bam', how: 'you chose it' } });
    api.recall.mockResolvedValueOnce({ success: true, plan: chosen });
    await act(async () => (q('library-recall-locate-input') as HTMLButtonElement).click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { dry_run: true, input: '/Users/me/x.raw.bam' });
    expect(q('library-recall-header')!.textContent).toContain('you chose it');
    api.recall.mockResolvedValueOnce({ success: true, job: { id: 'job-2' } });
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { outdir: '/runs/s01_recall', cores: 4, plan_id: 'hplan-A', input: '/Users/me/x.raw.bam' });
  });

  it('offers a New DAF-seq run when the header records no FiberHMM command', async () => {
    api.recall.mockResolvedValueOnce({ success: false, start_new_run: true,
      error: 'The Library cannot tell which calling options this BAM was made with: ... Start a New DAF-seq run from the aligned reads' });
    await render('A');
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(q('library-details-message')!.textContent).toContain('New DAF-seq run');
    expect(q('library-details-message')!.textContent).not.toContain('yourself');
    expect(q('library-recall-new-run')).not.toBeNull();
  });
});

describe('LibraryDetails re-call from outputs.json', () => {
  let container: HTMLDivElement;
  let root: Root;
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockImplementation(async (id: string) => ({ entry: entry(id) }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  it("lists the 3.0 defaults a run predates and the options left out, and keeps an original on request", async () => {
    const changes = [
      { id: 'alignments', text: 'FiberHMM 3.0 also calls supplementary alignments.', restore: ['--alignments', 'primary'], kept_old: false },
      { id: 'soft_clips', text: 'FiberHMM 3.0 keeps soft clips on linear contigs.', restore: ['--hard-clip'], kept_old: false },
      { id: 'daf_unaligned_mask', text: 'FiberHMM 3.0 masks inserted and soft-clipped bases for DAF.', restore: ['--no-daf-mask-unaligned'], kept_old: false },
    ];
    const base = planFor('A');
    const plan = { ...base, settings: { ...base.settings, changed_defaults: changes, keep_old: [],
      rewrites: [{ flag: '--call-args --phase-nrl', from: 'auto', to: null, why: 'retired in FiberHMM 3.0: caused artifacts' }] } };
    api.recall.mockResolvedValueOnce({ success: true, plan });
    await act(async () => root.render(
      <LibraryDetails entry={entry('A')} groups={[]} fiberhmmVersion="3.0.0"
        onOpen={() => {}} onChanged={() => {}} onAddToGroup={() => {}} />));
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    const defaults = q('library-recall-defaults')!.textContent!;
    for (const words of ['supplementary alignments', 'soft clips on linear contigs', 'inserted and soft-clipped bases'])
      expect(defaults).toContain(words);
    expect(q('library-recall-dropped')!.textContent).toContain('--call-args --phase-nrl: auto → left out');
    const kept = { ...plan, plan_id: 'plan-A2', settings: { ...plan.settings, keep_old: ['soft_clips'],
      changed_defaults: changes.map(c => ({ ...c, kept_old: c.id === 'soft_clips' })) } };
    api.recall.mockResolvedValueOnce({ success: true, plan: kept });
    await act(async () => (q('library-recall-keep-soft_clips') as HTMLInputElement).click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { dry_run: true, keep_old: ['soft_clips'] });
    api.recall.mockResolvedValueOnce({ success: true, job: { id: 'job-3' } });
    await act(async () => (q('library-recall') as HTMLButtonElement).click());
    expect(api.recall).toHaveBeenLastCalledWith('A', { outdir: '/scratch/A_out', cores: 4, plan_id: 'plan-A2', keep_old: ['soft_clips'] });
  });
});

describe('LibraryDetails Locate', () => {
  let container: HTMLDivElement;
  let root: Root;
  const missing = (): LibraryEntry => ({ ...entry('A'), available: false });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockImplementation(async () => ({ entry: missing() }));
    api.pick.mockResolvedValue({ success: true, path: '/moved/A.bam' });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  const locate = async (confirmed: boolean) => {
    const onChanged = vi.fn();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(confirmed);
    api.locate
      .mockResolvedValueOnce({ success: false, needs_confirmation: true, error: 'No content fingerprint.' })
      .mockResolvedValueOnce({ success: true });
    await act(async () => root.render(
      <LibraryDetails entry={missing()} groups={[]} fiberhmmVersion="3.0.0"
        onOpen={() => {}} onChanged={onChanged} onAddToGroup={() => {}} />));
    await act(async () => (container.querySelector('[data-testid="library-locate"]') as HTMLButtonElement).click());
    return { ask, onChanged };
  };

  it('relocates an entry without a content fingerprint only after the user confirms', async () => {
    // Review round 8: such an entry was relocated on header and size alone.
    const { ask, onChanged } = await locate(true);
    expect(ask).toHaveBeenCalledWith('No content fingerprint.');
    expect(api.locate.mock.calls).toEqual([['A', '/moved/A.bam'], ['A', '/moved/A.bam', true]]);
    expect(onChanged).toHaveBeenCalledWith('Found at /moved/A.bam.');
  });

  it('leaves the entry alone when the user declines', async () => {
    const { onChanged } = await locate(false);
    expect(api.locate.mock.calls).toEqual([['A', '/moved/A.bam']]);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('LibraryDetails QC without a readable QC JSON', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  const withQc = (qc: LibraryEntry['qc']): LibraryEntry => ({ ...entry('A'), rerun: undefined, qc } as LibraryEntry);

  it('shows the in-MSP and outside-MSP rates an outputs.json recorded', async () => {
    const e = withQc({
      verdicts: { overall: 'WARN', efficiency: 'WARN', background: 'PASS', verdict_basis: 'state-aware' },
      numbers: { msp_rate: 0.6212, outside_msp_rate: 0.1684, state_source: 'tags' },
      json: null,
    });
    api.get.mockResolvedValue({ entry: e });
    await act(async () => root.render(
      <LibraryDetails entry={e} groups={[]} fiberhmmVersion="3.0.0" onOpen={() => {}} onChanged={() => {}} onAddToGroup={() => {}} />));
    expect(container.querySelector('[data-testid="library-qc-efficiency"]')!.textContent).toBe('Efficiency 62.1%');
    expect([...container.querySelectorAll('[data-testid="chip"]')].map(c => c.textContent)).toEqual([
      'Overall:WARN', 'Efficiency:WARN', 'Background:PASS',
    ]);
    expect(container.querySelector('[data-testid="library-qc-background"]')!.textContent).toBe('Background 16.8%');
  });

  it('an older QC has no state rates', async () => {
    const e = withQc({ verdicts: { overall: 'PASS', signal: 'PASS', periodicity: 'WARN' }, numbers: { signal_label: 'deamination' }, json: null });
    api.get.mockResolvedValue({ entry: e });
    await act(async () => root.render(
      <LibraryDetails entry={e} groups={[]} fiberhmmVersion="3.0.0" onOpen={() => {}} onChanged={() => {}} onAddToGroup={() => {}} />));
    expect(container.querySelector('[data-testid="library-qc-efficiency"]')).toBeNull();
    // As before the state-aware fields: the rate chip is "Signal".
    expect([...container.querySelectorAll('[data-testid="chip"]')].map(c => c.textContent)).toEqual(['Overall:PASS', 'Signal:PASS', 'Periodicity:WARN']);
    expect(container.textContent).not.toContain('No fiberhmm-qc results');
  });
});

describe('LibraryDetails basecaller', () => {
  let container: HTMLDivElement;
  let root: Root;
  const MODEL = 'dna_r10.4.1_e8.2_400bps_sup@v5.2.0';
  const withCaller = (id: string, basecaller: LibraryEntry['basecaller']): LibraryEntry => ({ ...entry(id), basecaller });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  const render = async (shown: LibraryEntry) => {
    api.get.mockImplementation(async () => ({ entry: shown }));
    await act(async () => root.render(
      <LibraryDetails entry={shown} groups={[]} fiberhmmVersion="3.0.0"
        onOpen={() => {}} onChanged={() => {}} onAddToGroup={() => {}} />));
  };
  const line = () => container.querySelector('[data-testid="library-basecaller"]') as HTMLElement;

  it('shows the basecaller a BAM records, and unknown when it records none', async () => {
    await render(withCaller('A', { available: true, program: 'dorado', version: '2.0.1', basecall_model: MODEL,
      modbase_models: [`${MODEL}_6mA@v1`], source: 'outputs.json', sources: { modbase_models: 'rg_ds' } }));
    expect(line().textContent).toBe('Basecallerdorado 2.0.1 · sup v5.2.0 · 6mA v1');
    expect(line().getAttribute('title')).toContain(`Modification model: ${MODEL}_6mA@v1`);
    await render(withCaller('B', { available: false, modbase_models: null }));
    expect(line().textContent).toBe('Basecallerunknown');
    await render(entry('C'));  // read before FiberBrowser knew about basecallers
    expect(line().textContent).toBe('Basecallerunknown');
    await render(withCaller('D', { available: true, program: 'dorado', version: '0.9.6', basecall_model: MODEL,
      modbase_models: [], overridden: true }));
    expect(line().textContent).toBe('Basecallerdorado 0.9.6 · sup v5.2.0 · no modbase model (given with --basecaller-info)');
  });

  it("shows the re-call's basecaller and that a POD5 run is not basecalled again", async () => {
    await render(entry('A'));
    const plan = planFor('A');
    plan.reads = ['/scratch/A.basecalled.bam'];
    plan.settings.basecaller = { available: true, program: 'dorado', version: '0.9.6', basecall_model: MODEL,
      modbase_models: [], overridden: true };
    api.recall.mockResolvedValueOnce({ success: true, plan });
    await act(async () => (container.querySelector('[data-testid="library-recall"]') as HTMLButtonElement).click());
    const shown = container.querySelector('[data-testid="library-recall-basecaller"]')!;
    expect(shown.textContent).toBe("Basecaller: dorado 0.9.6 · sup v5.2.0 · no modbase model (an override: given to the "
      + "re-call again). Starts from the run's basecalled reads: no basecalling again.");
  });
});
