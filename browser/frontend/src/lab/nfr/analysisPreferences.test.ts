import '../testSetup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { deserializeSavedState, serializeState } from '../../stores/historySlice';
import { flushPreferences, initAnalysisPreferences, PREFERENCES_MOVED_KEY, PREFERENCES_URL, resetAnalysisPreferences } from '../../utils/analysisPreferences';
import { PINNED_MOTIFS_STORAGE_KEY } from '../../utils/pinnedMotifs';
import { CHIPATLAS_SELECTION_STORAGE_KEY } from './chipAtlasSelection';

vi.mock('../../api/sharedFetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/sharedFetch')>()),
  fetchJson: vi.fn(),
}));
import { fetchJson } from '../../api/sharedFetch';

const SEL = { cellTypeClasses: ['Embryo'], cellTypes: [] };
const custom = (name: string) => ({ name, counts: { A: [1, 0, 0], C: [0, 1, 0], G: [0, 0, 1], T: [0, 0, 0] } });

/** A stand-in server: GET returns what is kept; PUT merges as routers/preferences.py does. */
function server(initial: Record<string, any> = {}) {
  let kept: Record<string, any> = { chipatlas_selection: {}, pinned_motifs: {}, ...initial };
  const puts: Record<string, any>[] = [];
  vi.mocked(fetchJson).mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
    expect(url).toBe(PREFERENCES_URL);
    if (options?.method !== 'PUT') return JSON.parse(JSON.stringify(kept));
    const body = JSON.parse(String(options.body));
    puts.push(body);
    for (const f of ['chipatlas_selection', 'pinned_motifs']) {
      for (const [k, v] of Object.entries(body[f] ?? {})) {
        if (body.only_missing && k in kept[f]) continue;
        if (v == null) delete kept[f][k]; else kept[f] = { ...kept[f], [k]: v };
      }
    }
    if ('custom_motifs' in body && !(body.only_missing && 'custom_motifs' in kept)) kept = { ...kept, custom_motifs: body.custom_motifs };
    return JSON.parse(JSON.stringify(kept));
  });
  return { puts, kept: () => kept };
}

describe('analysis preferences kept on this computer (not per port)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAnalysisPreferences();
    useBrowserStore.setState({ pinnedMotifs: {}, customMotifs: [], chipAtlasSelections: {} } as never);
  });
  afterEach(() => resetAnalysisPreferences());

  it('the first time on an origin, its own stored choices move to the server without overwriting what is kept there', async () => {
    localStorage.setItem(PINNED_MOTIFS_STORAGE_KEY, JSON.stringify({ fly: ['vfl', 'su(Hw)'], human: ['CTCF'] }));
    localStorage.setItem(CHIPATLAS_SELECTION_STORAGE_KEY, JSON.stringify({ dm6: SEL }));
    localStorage.setItem('fiberhmm_custom_motifs', JSON.stringify([custom('MINE')]));
    const srv = server({ pinned_motifs: { fly: ['Trl'] } });      // another port kept fly already
    await initAnalysisPreferences();
    expect(srv.puts[0]).toMatchObject({ only_missing: true, pinned_motifs: { fly: ['vfl', 'su(Hw)'], human: ['CTCF'] }, chipatlas_selection: { dm6: SEL } });
    const s = useBrowserStore.getState();
    expect(s.pinnedMotifs).toEqual({ fly: ['Trl'], human: ['CTCF'] });   // the server's fly, this origin's human
    expect(s.chipAtlasSelections).toEqual({ dm6: SEL });
    expect(s.customMotifs.map(c => c.name)).toEqual(['MINE']);
    expect(localStorage.getItem(PREFERENCES_MOVED_KEY)).toBe('1');
    // once moved, a new page (another port's leftovers in localStorage) does not move them again
    resetAnalysisPreferences();
    localStorage.setItem(PINNED_MOTIFS_STORAGE_KEY, JSON.stringify({ fly: ['stale'] }));
    useBrowserStore.setState({ pinnedMotifs: { fly: ['stale'] } } as never);
    const n = srv.puts.length;
    await initAnalysisPreferences();
    expect(srv.puts).toHaveLength(n);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toEqual(['Trl']);
  });

  it('changes are written back per species and genome (a reset species is forgotten); custom motifs as a list', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    const srv = server({ pinned_motifs: { fly: ['vfl'] }, chipatlas_selection: { hg38: { cellTypeClasses: [], cellTypes: ['K562'] } } });
    await initAnalysisPreferences();
    const s = useBrowserStore.getState();
    s.setPinnedMotifs('fly', ['vfl', 'su(Hw)']);
    s.setChipAtlasSelection('dm6', SEL);
    s.setCustomMotifs([custom('CAGGTAG')]);
    await flushPreferences();
    expect(srv.puts.at(-1)).toEqual({ pinned_motifs: { fly: ['vfl', 'su(Hw)'] }, chipatlas_selection: { dm6: SEL }, custom_motifs: [custom('CAGGTAG')] });
    s.setPinnedMotifs('fly', null);
    await flushPreferences();
    expect(srv.puts.at(-1)).toEqual({ pinned_motifs: { fly: null } });
    expect(srv.kept().pinned_motifs).toEqual({});
    expect(srv.kept().chipatlas_selection).toEqual({ hg38: { cellTypeClasses: [], cellTypes: ['K562'] }, dm6: SEL });
  });

  it('a value changed before the answer (a session restored on start) is kept and written; no server: localStorage only', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    let answer!: (v: unknown) => void;
    const srv = server({ pinned_motifs: { fly: ['vfl'] }, chipatlas_selection: { dm6: SEL } });
    const impl = vi.mocked(fetchJson).getMockImplementation()!;
    vi.mocked(fetchJson).mockImplementationOnce(() => new Promise(r => { answer = r; }));
    const ready = initAnalysisPreferences();
    useBrowserStore.setState({ pinnedMotifs: { fly: ['Trl'] }, chipAtlasSelections: { hg38: { cellTypeClasses: [], cellTypes: ['K562'] } } } as never);
    answer(await impl(PREFERENCES_URL));
    await ready;
    await flushPreferences();
    expect(useBrowserStore.getState().pinnedMotifs).toEqual({ fly: ['Trl'] });
    expect(useBrowserStore.getState().chipAtlasSelections).toEqual({ dm6: SEL, hg38: { cellTypeClasses: [], cellTypes: ['K562'] } });
    expect(srv.kept().pinned_motifs.fly).toEqual(['Trl']);
    // a public server or a tour tab refuses: the page keeps working from localStorage, nothing is sent
    resetAnalysisPreferences();
    vi.mocked(fetchJson).mockReset().mockRejectedValue(new Error('403'));
    await initAnalysisPreferences();
    useBrowserStore.getState().setPinnedMotifs('fly', ['x']);
    await flushPreferences();
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(PINNED_MOTIFS_STORAGE_KEY)!)).toEqual({ fly: ['x'] });
  });

  it('edits made before the answer touch only their own species; a first custom motif then is written (Codex review)', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    let answer!: (v: unknown) => void;
    const srv = server({ pinned_motifs: { fly: ['vfl'], human: ['CTCF'] } });      // no custom_motifs kept yet
    const impl = vi.mocked(fetchJson).getMockImplementation()!;
    vi.mocked(fetchJson).mockImplementationOnce(() => new Promise(r => { answer = r; }));
    const ready = initAnalysisPreferences();
    useBrowserStore.getState().setPinnedMotifs('fly', ['Trl']);
    useBrowserStore.getState().setCustomMotifs([custom('FIRST')]);
    answer(await impl(PREFERENCES_URL));
    await ready;
    await flushPreferences();
    expect(useBrowserStore.getState().pinnedMotifs).toEqual({ fly: ['Trl'], human: ['CTCF'] });
    expect(srv.kept().pinned_motifs).toEqual({ fly: ['Trl'], human: ['CTCF'] });   // human not deleted
    expect(srv.kept().custom_motifs.map((c: { name: string }) => c.name)).toEqual(['FIRST']);
  });

  it('writes go one at a time (the newest lands last) and a failed one is sent again with the next (Codex review)', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    const srv = server();
    await initAnalysisPreferences();
    const impl = vi.mocked(fetchJson).getMockImplementation()!;
    // the first PUT hangs; a second edit meanwhile must wait for it, not overtake it
    let release!: () => void;
    let inFlight = 0, maxInFlight = 0;
    vi.mocked(fetchJson).mockImplementation(async (url, options) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      if (options?.method === 'PUT' && JSON.parse(String(options.body)).pinned_motifs?.fly?.[0] === 'OLD') await new Promise<void>(r => { release = r; });
      try { return await impl(url, options); } finally { inFlight -= 1; }
    });
    useBrowserStore.getState().setPinnedMotifs('fly', ['OLD']);
    const first = flushPreferences();
    await new Promise(r => setTimeout(r, 0));
    useBrowserStore.getState().setPinnedMotifs('fly', ['NEW']);
    const second = flushPreferences();
    release();
    await Promise.all([first, second]);
    expect(maxInFlight).toBe(1);
    expect(srv.kept().pinned_motifs.fly).toEqual(['NEW']);
    // a failed write goes back in the queue under newer edits
    vi.mocked(fetchJson).mockImplementationOnce(async () => { throw new Error('offline'); });
    useBrowserStore.getState().setPinnedMotifs('human', ['CTCF']);
    await flushPreferences();
    expect(srv.kept().pinned_motifs.human).toBeUndefined();
    useBrowserStore.getState().setChipAtlasSelection('dm6', SEL);
    await flushPreferences();
    expect(srv.kept().pinned_motifs.human).toEqual(['CTCF']);
    expect(srv.kept().chipatlas_selection.dm6).toEqual(SEL);
  });

  it('opening a session file brings back its ChIP-Atlas choice for its assemblies; others keep theirs', async () => {
    const { applyImportedState } = await import('../../api/session');
    const K562 = { cellTypeClasses: [], cellTypes: ['K562'] };
    useBrowserStore.setState({ chipAtlasSelections: { hg38: K562 } } as never);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr2L', start: 1, end: 2 } });
    expect(useBrowserStore.getState().chipAtlasSelections).toEqual({ hg38: K562 });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { chipAtlasSelections: { dm6: SEL } }, viewport: { chrom: 'chr2L', start: 1, end: 2 } });
    expect(useBrowserStore.getState().chipAtlasSelections).toEqual({ hg38: K562, dm6: SEL });
  });

  it('a session carries the ChIP-Atlas choice per assembly and brings it back', () => {
    useBrowserStore.setState({ chipAtlasSelections: { dm6: SEL } } as never);
    const snap = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    expect(snap.chipAtlasSelections).toEqual({ dm6: SEL });
    expect((deserializeSavedState(snap) as { chipAtlasSelections: unknown }).chipAtlasSelections).toEqual({ dm6: SEL });
    const { chipAtlasSelections: _drop, ...older } = snap;
    void _drop;
    expect('chipAtlasSelections' in deserializeSavedState(older)).toBe(false);
  });
});
