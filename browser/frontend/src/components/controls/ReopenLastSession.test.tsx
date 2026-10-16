import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { serializeState, type SerializedState } from '../../stores/historySlice';
import {
  decideLaunchOffer, describeSavedSession, getLastSessionPreference, resetLaunchInfoForTests,
  setLastSessionPreference, type LaunchInfo,
} from '../../utils/launchSession';
import { CrashRecoveryBanner, autoSaveHasWork, restoreSnapshot } from './CrashRecoveryBanner';
import { autoSaveNow, withDatasetReferences } from '../../hooks/useAutoSave';
import { currentReadProjection, projectionInputSignature } from '../../utils/projectionExport';
import { clearAutoSave, loadAutoSave, saveAutoSave } from '../../stores/historyStorage';
import { launchOfferHidesWelcome, launchOfferPending, resetLaunchOfferForTests, setLaunchOfferPending, setLaunchUi, useLaunchUiStore } from '../../utils/launchSession';
import { WelcomeReopenLastSessionButton } from './WelcomeLoadFileButton';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const savedDataset = { id: 'ds1', label: 'napa_ddda', paths: ['/data/napa_ddda.bam'], color: '#2563eb', data_type: 'bam' };

/** A fake server: /api/session/launch says how the last run ended; datasets reload. */
function stubServer(launch: Partial<LaunchInfo> | null, extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let listed: Array<typeof savedDataset> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const custom = extra(url, init);
    if (custom) return custom;
    if (url.includes('/api/session/launch')) {
      return launch ? json({ boot_id: 'now', previous_boot_id: 'before', previous_exit: 'clean', ...launch }) : new Response('', { status: 404 });
    }
    // A relaunched server starts empty (no dataset on its command line); a restore adds the saved one.
    if (url.includes('/api/datasets/add')) { listed = [{ ...savedDataset, id: 'ds1' }]; return json({ success: true, dataset: listed[0] }); }
    if (url.includes('/api/datasets')) return json({ datasets: listed });
    if (url.includes('/api/panel_genomes')) return json({ main: {}, genomes: [], datasets: {} });
    return json({ success: true });
  }));
  return calls;
}

function entryFor(state: Partial<SerializedState>, bootId: string | null = 'before') {
  return { state: { datasets: [savedDataset], chrom: 'chr19', start: 47_514_000, end: 47_518_000, ...state } as SerializedState, timestamp: Date.now() - 60_000, bootId };
}

let mockEntry: ReturnType<typeof entryFor> | null = null;
vi.mock('../../stores/historyStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/historyStorage')>()),
  loadAutoSave: vi.fn(async () => mockEntry),
  clearAutoSave: vi.fn(async () => undefined),
  saveAutoSave: vi.fn(async () => undefined),
  hasRestoredWork: vi.fn(() => false),
}));

beforeEach(() => {
  localStorage.clear();
  resetLaunchInfoForTests();
  resetLaunchOfferForTests();
  useBrowserStore.setState({ datasets: [], panels: [], _historyStack: [], navigatorRegions: [], navigationMode: 'linked' } as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockEntry = null;
});

describe('decideLaunchOffer', () => {
  const hasWork = autoSaveHasWork;
  const launch = (previous_exit: LaunchInfo['previous_exit']): LaunchInfo => ({ boot_id: 'now', previous_exit, previous_boot_id: 'before' });

  it('offers to reopen a save from a run that was quit normally, even with no analysis in it', () => {
    expect(decideLaunchOffer(entryFor({}), launch('clean'), { hasWork })).toBe('reopen');
  });
  it('after a crash, offers crash recovery only when the save has work', () => {
    expect(decideLaunchOffer(entryFor({}), launch('crash'), { hasWork })).toBeNull();
    expect(decideLaunchOffer(entryFor({ selectedPeaks: [1] }), launch('crash'), { hasWork })).toBe('recover');
  });
  it('a reload within the same run, an old server or a save without a boot id: crash recovery as before', () => {
    expect(decideLaunchOffer(entryFor({ selectedPeaks: [1] }, 'now'), launch('clean'), { hasWork })).toBe('recover');
    expect(decideLaunchOffer(entryFor({ selectedPeaks: [1] }), null, { hasWork })).toBe('recover');
    expect(decideLaunchOffer(entryFor({ selectedPeaks: [1] }, null), launch('clean'), { hasWork })).toBe('recover');
  });
  it('remembers the choice: reopen without asking, or start fresh', () => {
    expect(decideLaunchOffer(entryFor({}), launch('clean'), { hasWork, preference: 'reopen' })).toBe('auto-reopen');
    expect(decideLaunchOffer(entryFor({}), launch('clean'), { hasWork, preference: 'fresh' })).toBe('discard');
  });
  it('nothing open and nothing done: nothing to offer', () => {
    expect(decideLaunchOffer(entryFor({ datasets: [] }), launch('clean'), { hasWork })).toBeNull();
  });
  it('describes the session by its datasets and locus', () => {
    expect(describeSavedSession(entryFor({}).state)).toBe('1 dataset, chr19:47,514,000-47,518,000');
  });
});

describe('Reopen last session (on the Welcome card)', () => {
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
  });
  const mount = async () => {
    await act(async () => {
      root.render(<><CrashRecoveryBanner /><WelcomeReopenLastSessionButton /></>);
      for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
    });
  };

  it('after a normal quit: a "Reopen last session" button on the Welcome card (N datasets, locus) restores it', async () => {
    mockEntry = entryFor({});
    stubServer({ previous_exit: 'clean' });
    await mount();
    const button = container.querySelector('[data-testid="welcome-reopen-last-session"]');
    expect(button?.textContent).toContain('Reopen last session');
    expect(button?.textContent).toContain('1 dataset, chr19:47,514,000-47,518,000');
    // No separate offer, and the Welcome card is not held back.
    expect(container.querySelector('[data-testid="reopen-last-session"]')).toBeNull();
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
    await act(async () => {
      (button as HTMLButtonElement).click();
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    });
    expect(useBrowserStore.getState().chrom).toBe('chr19');
    expect(useBrowserStore.getState().start).toBe(47_514_000);
    expect(container.querySelector('[data-testid="welcome-reopen-last-session"]')).toBeNull();
  });

  it('a crash offers recovery in its banner, and the Welcome card still shows (without a reopen button)', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] });
    stubServer({ previous_exit: 'crash' });
    await mount();
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')?.textContent).toContain('Unsaved session found');
    expect(container.querySelector('[data-testid="welcome-reopen-last-session"]')).toBeNull();
    expect(launchOfferHidesWelcome(useLaunchUiStore.getState())).toBe(false);
    expect(getLastSessionPreference()).toBe('ask');
  });

  it('remembered "reopen" reopens without asking', async () => {
    setLastSessionPreference('reopen');
    mockEntry = entryFor({ start: 47_515_000, end: 47_516_000 });
    stubServer({ previous_exit: 'clean' });
    await mount();
    await act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
    expect(useBrowserStore.getState().start).toBe(47_515_000);
    expect(container.querySelector('[data-testid="welcome-reopen-last-session"]')).toBeNull();
  });

  it('remembered "Start fresh" drops the saved session instead of keeping it', async () => {
    setLastSessionPreference('fresh');
    mockEntry = entryFor({ selectedPeaks: [1] });
    stubServer({ previous_exit: 'clean' });
    vi.mocked(clearAutoSave).mockClear();
    await mount();
    expect(container.querySelector('[data-testid="reopen-last-session"]')).toBeNull();
    expect(clearAutoSave).toHaveBeenCalled();
  });

  it('while a reopen is still loading (datasets opened, genome on its way) the saved session stays protected', async () => {
    mockEntry = entryFor({ currentGenome: 'dm6' });
    let datasets: Array<typeof savedDataset> = [];
    let releaseGenome: (r: Response) => void = () => {};
    stubServer({ previous_exit: 'clean' }, (url, init) => {
      if (url.includes('/api/datasets/add')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const added = String(body.path ?? body.paths?.[0] ?? '').includes('/x.bam')
          ? { ...savedDataset, id: 'other', paths: ['/x.bam'] } : { ...savedDataset, id: 'ds1' };
        datasets = [...datasets, added];
        return json({ success: true, dataset: added });
      }
      if (url.includes('/api/datasets')) return json({ datasets });
      return null;
    });
    const plainFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => (String(input).includes('/api/load_genome')
      ? new Promise<Response>(resolve => { releaseGenome = resolve; })
      : plainFetch(input, init))));
    await mount();
    mockEntry.state.datasets = [{ ...savedDataset }, { ...savedDataset, id: 'other', paths: ['/x.bam'] }] as any;
    await act(async () => {
      (container.querySelector('[data-testid="welcome-reopen-last-session"]') as HTMLButtonElement).click();
      for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    });
    // A dataset the restore opened is not "a new session": the offer and the hold stay.
    expect(useBrowserStore.getState().datasets.map((d: any) => d.id)).toContain('other');
    expect(useLaunchUiStore.getState().lastSession).not.toBeNull();
    expect(launchOfferPending()).toBe(true);
    await act(async () => {
      releaseGenome(json({ success: true, name: 'dm6' }));
      for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    });
    expect(useLaunchUiStore.getState().lastSession).toBeNull();
    expect(launchOfferPending()).toBe(false);
  });

  it('a page opened while a crashed page\'s last beat was fresh offers the recovery once it expires (Codex MED, fb62)', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] }, 'now');                 // saved in this run by the other page
    stubServer({ previous_exit: 'none' });
    const other = 'fiberbrowser.liveTab.crashed-page';
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() }));   // its last beat, then the crash
    await mount();
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
    // The beat is not renewed: it goes stale, and the next check offers the recovery.
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() - 11_000 }));
    await act(async () => { await new Promise(r => setTimeout(r, 3_300)); });
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')?.textContent).toContain('Unsaved session found');
  }, 10_000);

  it('the delayed offer is the crashed page\'s latest save, not the one seen at launch (Codex round 2)', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] }, 'now');
    stubServer({ previous_exit: 'none' });
    const other = 'fiberbrowser.liveTab.busy-page';
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() }));
    await mount();
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
    // The other page kept working and saving, then crashed.
    mockEntry = entryFor({ selectedPeaks: [1, 2, 3], chrom: 'chr2', start: 10, end: 20 }, 'now');
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() - 11_000 }));
    await act(async () => { await new Promise(r => setTimeout(r, 3_300)); });
    const banner = container.querySelector('[data-testid="crash-recovery-banner"]');
    expect(banner?.textContent).toContain('chr2');
    await act(async () => {
      [...container.querySelectorAll('button')].find(b => b.textContent === 'Restore')!.click();
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    });
    expect(useBrowserStore.getState().chrom).toBe('chr2');
    expect([...useBrowserStore.getState().selectedPeaks].sort()).toEqual([1, 2, 3]);
  }, 10_000);

  it('no delayed offer when the latest save no longer qualifies or another page is live again', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] }, 'now');
    stubServer({ previous_exit: 'none' });
    const other = 'fiberbrowser.liveTab.busy-page-2';
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() }));
    await mount();
    mockEntry = entryFor({ datasets: [] } as never, 'now');      // nothing worth recovering any more
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() - 11_000 }));
    await act(async () => { await new Promise(r => setTimeout(r, 3_300)); });
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
  }, 10_000);

  it('a page that closed normally is not offered as a crash', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] }, 'now');
    stubServer({ previous_exit: 'none' });
    const other = 'fiberbrowser.liveTab.closed-page';
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now() }));
    await mount();
    localStorage.setItem(other, JSON.stringify({ bootId: 'now', at: Date.now(), closed: true }));
    await act(async () => { await new Promise(r => setTimeout(r, 3_300)); });
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
  }, 10_000);

  it('after a crash: the crash-recovery offer', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] });
    stubServer({ previous_exit: 'crash' });
    await mount();
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')?.textContent).toContain('Unsaved session found');
    expect(container.querySelector('[data-testid="reopen-last-session"]')).toBeNull();
  });
});

describe('restoring a saved session brings back what newer features keep in it', () => {
  it('per-panel navigation, navigator regions and read separators (fields undo knows)', async () => {
    stubServer({ previous_exit: 'clean' });
    const panel = { id: 'ds1', datasetId: 'ds1', stateKey: 'ds1', navOwn: true, viewportOverride: { chrom: 'chr19', start: 47_515_000, end: 47_516_000 } };
    await restoreSnapshot({
      ...entryFor({}).state,
      panels: [panel],
      navigationMode: 'perPanel',
      navigatorRegions: [{ id: 'r1', chrom: 'chr19', start: 47_515_100, end: 47_515_200 }],
      readSeparatorMode: 'off',
    } as unknown as SerializedState);
    const st = useBrowserStore.getState() as any;
    expect(st.navigationMode).toBe('perPanel');
    expect(st.navigatorRegions).toEqual([{ id: 'r1', chrom: 'chr19', start: 47_515_100, end: 47_515_200 }]);
    expect(st.readSeparatorMode).toBe('off');
    expect(st.panels[0].viewportOverride).toEqual(panel.viewportOverride);
  });

  it("attaches each dataset's own reference again and moves its panels to the new key", async () => {
    const calls = stubServer({ previous_exit: 'clean' }, (url, init) => {
      if (url.includes('/api/datasets')) return json({ datasets: [{ ...savedDataset, id: 'ds1_new' }] });
      if (url.includes('/api/panel_genomes/attach') && init?.method === 'POST') {
        return json({ success: true, genome: { key: 'fasta:puc19_2', chroms: [] } });
      }
      return null;
    });
    // The server now has a different id for the same files: reconcile adds it.
    const dataset = { ...savedDataset, reference: { key: 'fasta:puc19', source: { fasta_path: '/ref/puc19.fa' } } };
    await restoreSnapshot({
      ...entryFor({}).state,
      datasets: [dataset],
      panels: [{ id: 'ds1', datasetId: 'ds1', stateKey: 'ds1', genome: 'fasta:puc19' }],
    } as unknown as SerializedState);
    const attach = calls.find(c => c.url.includes('/api/panel_genomes/attach'));
    expect(JSON.parse(attach!.body!)).toEqual({ dataset_ids: ['ds1_new'], fasta_path: '/ref/puc19.fa' });
    const panel = (useBrowserStore.getState().panels as any[])[0];
    expect(panel.datasetId).toBe('ds1_new');
    expect(panel.genome).toBe('fasta:puc19_2');
  });

  it('panel copies (state keys `<id>:…`) and saved peaks follow the recovered ids and reference keys', async () => {
    stubServer({ previous_exit: 'clean' }, (url, init) => {
      if (url.includes('/api/datasets')) return json({ datasets: [{ ...savedDataset, id: 'ds1_new' }] });
      if (url.includes('/api/panel_genomes/attach') && init?.method === 'POST') return json({ success: true, genome: { key: 'fasta:puc19_2', chroms: [] } });
      return null;
    });
    await restoreSnapshot({
      ...entryFor({}).state,
      datasets: [{ ...savedDataset, reference: { key: 'fasta:puc19', source: { fasta_path: '/ref/puc19.fa' } } }],
      panels: [{ id: 'ds1', datasetId: 'ds1', stateKey: 'ds1' }, { id: 'copy', datasetId: 'ds1', stateKey: 'ds1:copy', genome: 'fasta:puc19' }],
      clusterAssignments: { 'ds1:copy': { r1: 0 } },
      clusterFocus: { 'ds1:copy': [0] },
      selectedReadIds: { 'ds1:copy': ['r1'] },
      selectedDatasets: ['ds1'],
      peaksByRule: { rule: [{ index: 0, start: 1, end: 2, genome: 'fasta:puc19' }] },
    } as unknown as SerializedState);
    const st = useBrowserStore.getState() as any;
    expect(Object.keys(st.clusterAssignments)).toEqual(['ds1_new:copy']);
    expect(st.clusterFocus['ds1_new:copy']).toEqual(new Set([0]));
    expect(st.selectedReadIds['ds1_new:copy']).toEqual(new Set(['r1']));
    expect([...st.selectedDatasets]).toEqual(['ds1_new']);
    expect(st.panels[1]).toMatchObject({ stateKey: 'ds1_new:copy', genome: 'fasta:puc19_2' });
    expect(st.peaksByRule.rule[0].genome).toBe('fasta:puc19_2');
  });

  it('the autosave records the reference a dataset is on', () => {
    usePanelGenomeStore.setState({
      assignments: { ds1: 'fasta:puc19' },
      genomes: { 'fasta:puc19': { key: 'fasta:puc19', kind: 'fasta', fasta_path: '/ref/puc19.fa', gtf_path: null } as any },
    });
    useBrowserStore.setState({ datasets: [{ ...savedDataset }] } as any);
    const saved = withDatasetReferences(serializeState(useBrowserStore.getState()));
    expect(saved.datasets?.[0].reference).toEqual({ key: 'fasta:puc19', source: { fasta_path: '/ref/puc19.fa' } });
    usePanelGenomeStore.setState({ assignments: {}, genomes: {} });
  });
});

describe('the autosave keeps the offered session', () => {
  it('waits while the offer is being decided or shown, saves once decided (with the run\'s boot id) or once something is done', async () => {
    stubServer({ previous_exit: 'clean' });
    useBrowserStore.setState({ datasets: [{ ...savedDataset }], _historyStack: [] } as any);
    vi.mocked(saveAutoSave).mockClear();
    resetLaunchOfferForTests(false);  // a page that just opened: not decided yet
    await autoSaveNow();
    expect(saveAutoSave).not.toHaveBeenCalled();
    setLaunchOfferPending(true);  // "Reopen your last session" is up
    await autoSaveNow();
    expect(saveAutoSave).not.toHaveBeenCalled();
    // Something done here (an undo step that isn't navigation) is saved anyway.
    useBrowserStore.setState({ _historyStack: [{ label: 'Cluster', kind: 'clustering', timestamp: 0, state: {} }] } as any);
    await autoSaveNow();
    expect(saveAutoSave).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAutoSave).mock.calls[0][2]).toBe('now');
    // Decided (Start fresh, or nothing to offer): idle pages save again.
    useBrowserStore.setState({ _historyStack: [] } as any);
    setLaunchOfferPending(false);
    await autoSaveNow();
    expect(saveAutoSave).toHaveBeenCalledTimes(2);
  });
});

describe('no autosave while a session restores (Codex review)', () => {
  it('a page that already did something does not overwrite the saved copy mid-restore', async () => {
    stubServer({ previous_exit: 'clean' });
    useBrowserStore.setState({ datasets: [{ ...savedDataset }], _historyStack: [{ label: 'Cluster', kind: 'clustering', timestamp: 0, state: {} }] } as any);
    vi.mocked(saveAutoSave).mockClear();
    setLaunchUi({ restoring: true });
    await autoSaveNow();
    expect(saveAutoSave).not.toHaveBeenCalled();
    setLaunchUi({ restoring: false });
    await autoSaveNow();
    expect(saveAutoSave).toHaveBeenCalledTimes(1);
  });
});

describe('the Projection map reopens with the session (integ-r4, Codex review)', () => {
  it('the autosave carries the current map; a reopen brings it back under the new dataset ids, still current', async () => {
    stubServer({ previous_exit: 'clean' }, (url) => (url.includes('/api/datasets') ? json({ datasets: [{ ...savedDataset, id: 'ds1_new' }] }) : null));
    useBrowserStore.setState({
      datasets: [{ ...savedDataset }], chrom: 'chr19', start: 47_514_000, end: 47_518_000,
      clusterAssignments: { ds1: { r1: 0 } }, _historyStack: [{ label: 'Cluster', kind: 'clustering', timestamp: 0, state: {} }],
    } as any);
    const map = {
      method: 'tsne', chrom: 'chr19', start: 47_514_000, end: 47_518_000, params: {},
      signature: projectionInputSignature(useBrowserStore.getState()), coords: { ds1: { r1: [1, 2] as [number, number] } },
    };
    useBrowserStore.setState({ readProjection: map } as any);
    setLaunchOfferPending(false);
    vi.mocked(saveAutoSave).mockClear();
    await autoSaveNow();
    const saved = vi.mocked(saveAutoSave).mock.calls[0][0] as SerializedState;
    expect(saved.readProjection).toEqual(map);
    useBrowserStore.setState({ readProjection: null, clusterAssignments: {} } as any);
    await restoreSnapshot(JSON.parse(JSON.stringify(saved)));
    const st = useBrowserStore.getState() as any;
    expect(st.readProjection?.coords).toEqual({ ds1_new: { r1: [1, 2] } });
    expect(currentReadProjection(st.readProjection, st)).not.toBeNull();
  });
});

describe('a command-line dataset takes precedence over the last session', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('a saved session after a normal quit is declined (start fresh): no hidden offer, autosave goes on', async () => {
    mockEntry = entryFor({});
    stubServer({ previous_exit: 'clean' }, url => (url.includes('/api/datasets') && !url.includes('/add')
      ? json({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] }) : null));
    useBrowserStore.setState({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] } as any);
    await act(async () => {
      root.render(<><CrashRecoveryBanner /><WelcomeReopenLastSessionButton /></>);
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    });
    expect(useLaunchUiStore.getState().lastSession).toBeNull();
    expect(container.querySelector('[data-testid="welcome-reopen-last-session"]')).toBeNull();
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
    expect(launchOfferPending()).toBe(false);  // the page's own session is saved from now on
    expect(useLaunchUiStore.getState().deciding).toBe(false);
  });

  it('a declined save with analysis (or acted) is superseded by the first save, navigation only included (Codex rc4)', async () => {
    mockEntry = { ...entryFor({ selectedPeaks: [1] }), acted: true };
    stubServer({ previous_exit: 'clean' }, url => (url.includes('/api/datasets') && !url.includes('/add')
      ? json({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] }) : null));
    useBrowserStore.setState({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] } as any);
    await act(async () => {
      root.render(<><CrashRecoveryBanner /><WelcomeReopenLastSessionButton /></>);
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    });
    useBrowserStore.setState({ chrom: 'chr19', start: 47_515_500, end: 47_516_500, _historyStack: [],
      selectedPeaks: new Set(), clusterAssignments: {}, readSortOrder: {}, filteredReadIds: {}, excludedReadIds: {} } as any);
    expect(autoSaveHasWork(serializeState(useBrowserStore.getState()))).toBe(false);  // navigation only
    vi.mocked(saveAutoSave).mockClear();
    await autoSaveNow();   // what a navigation, or Quit, saves
    expect(saveAutoSave).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAutoSave).mock.calls[0][0]).toMatchObject({ chrom: 'chr19', start: 47_515_500 });
  });

  it('without a decline, an idle page still never replaces a save with work (crash recovery keeps it)', async () => {
    mockEntry = { ...entryFor({ selectedPeaks: [1] }), acted: true };
    stubServer({ previous_exit: 'crash' }, url => (url.includes('/api/datasets') && !url.includes('/add')
      ? json({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] }) : null));
    useBrowserStore.setState({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }], _historyStack: [],
      selectedPeaks: new Set(), clusterAssignments: {}, readSortOrder: {}, filteredReadIds: {}, excludedReadIds: {} } as any);
    expect(autoSaveHasWork(serializeState(useBrowserStore.getState()))).toBe(false);  // an idle page
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    });
    vi.mocked(saveAutoSave).mockClear();
    await autoSaveNow();
    expect(saveAutoSave).not.toHaveBeenCalled();
    // Dismiss (Start fresh on the crash offer): superseded from then on.
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')!.click(); });
    await autoSaveNow();
    expect(saveAutoSave).toHaveBeenCalledTimes(1);
  });

  it('a crash still offers recovery in its banner beside a command-line dataset', async () => {
    mockEntry = entryFor({ selectedPeaks: [1] });
    stubServer({ previous_exit: 'crash' }, url => (url.includes('/api/datasets') && !url.includes('/add')
      ? json({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] }) : null));
    useBrowserStore.setState({ datasets: [{ ...savedDataset, id: 'cli', paths: ['/data/cli.bam'] }] } as any);
    await act(async () => {
      root.render(<CrashRecoveryBanner />);
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')?.textContent).toContain('Unsaved session found');
  });
});

describe('a late launch decision (storage and server slower than the Welcome card waits)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  /** Both answers held: the saved session (IndexedDB) and /api/session/launch. */
  async function lateDecision(previous_exit: LaunchInfo['previous_exit'], entry: ReturnType<typeof entryFor> & { acted?: boolean }) {
    let releaseStorage!: () => void;
    let releaseLaunch!: () => void;
    const storage = new Promise<void>(r => { releaseStorage = r; });
    const launchHeld = new Promise<void>(r => { releaseLaunch = r; });
    vi.mocked(loadAutoSave).mockImplementationOnce(async () => { await storage; return entry as any; });
    mockEntry = entry;
    stubServer({ previous_exit }, url => (url.includes('/api/session/launch')
      ? launchHeld.then(() => json({ boot_id: 'now', previous_boot_id: 'before', previous_exit })) as any : null));
    useBrowserStore.setState({ datasets: [], _historyStack: [], selectedPeaks: new Set(), clusterAssignments: {}, readSortOrder: {},
      filteredReadIds: {}, excludedReadIds: {} } as any);
    await act(async () => {
      root.render(<><CrashRecoveryBanner /><WelcomeReopenLastSessionButton /></>);
      for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
    });
    // Past the Welcome card's wait: the card is up, and the user opens a BAM from it.
    await act(async () => { await new Promise(r => setTimeout(r, 3_100)); });
    expect(useLaunchUiStore.getState().deciding).toBe(false);
    act(() => useBrowserStore.setState({ datasets: [{ ...savedDataset, id: 'opened', paths: ['/data/opened.bam'] }] } as any));
    await act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); });
    // Then the answers arrive.
    await act(async () => {
      releaseStorage(); releaseLaunch();
      for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    });
    useBrowserStore.setState({ chrom: 'chr19', start: 47_515_500, end: 47_516_500 } as any);
    expect(autoSaveHasWork(serializeState(useBrowserStore.getState()))).toBe(false);  // navigation only
  }

  it('after a normal quit: the last session is declined (no hidden offer) and the new session is saved', async () => {
    await lateDecision('clean', { ...entryFor({ selectedPeaks: [1] }), acted: true });
    expect(useLaunchUiStore.getState().lastSession).toBeNull();
    expect(container.querySelector('[data-testid="welcome-reopen-last-session"]')).toBeNull();
    expect(container.querySelector('[data-testid="reopen-last-session"]')).toBeNull();
    expect(launchOfferPending()).toBe(false);
    vi.mocked(saveAutoSave).mockClear();
    await autoSaveNow();   // a navigation's save, or Quit's
    expect(saveAutoSave).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('after a crash: the recovery banner is shown (never held invisibly), and protects its save until Dismiss', async () => {
    await lateDecision('crash', { ...entryFor({ selectedPeaks: [1] }), acted: true });
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')?.textContent).toContain('Unsaved session found');
    vi.mocked(saveAutoSave).mockClear();
    await autoSaveNow();
    expect(saveAutoSave).not.toHaveBeenCalled();
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')!.click(); });
    expect(container.querySelector('[data-testid="crash-recovery-banner"]')).toBeNull();
    await autoSaveNow();
    expect(saveAutoSave).toHaveBeenCalledTimes(1);
  }, 10_000);
});

