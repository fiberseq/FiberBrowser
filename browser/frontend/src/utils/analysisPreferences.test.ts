import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { flushPreferences, initAnalysisPreferences, PREFERENCES_MOVED_KEY, PREFERENCES_URL, resetAnalysisPreferences } from './analysisPreferences';
import { PINNED_MOTIFS_STORAGE_KEY } from './pinnedMotifs';
import { PREVIEW_STORAGE_KEY, resetPreviewsForTests, setPreviewDefault, usePreviewStore } from './previewFeatures';

vi.mock('../api/sharedFetch', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/sharedFetch')>()),
  fetchJson: vi.fn(),
}));
import { fetchJson } from '../api/sharedFetch';

const custom = (name: string) => ({ name, counts: { A: [1, 0, 0], C: [0, 1, 0], G: [0, 0, 1], T: [0, 0, 0] } });

/** A stand-in server: GET returns what is kept; PUT merges as routers/preferences.py does. */
function server(initial: Record<string, any> = {}) {
  let kept: Record<string, any> = { pinned_motifs: {}, ...initial };
  const puts: Record<string, any>[] = [];
  vi.mocked(fetchJson).mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
    expect(url).toBe(PREFERENCES_URL);
    if (options?.method !== 'PUT') return JSON.parse(JSON.stringify(kept));
    const body = JSON.parse(String(options.body));
    puts.push(body);
    for (const [k, v] of Object.entries(body.pinned_motifs ?? {})) {
      if (body.only_missing && k in kept.pinned_motifs) continue;
      if (v == null) delete kept.pinned_motifs[k]; else kept.pinned_motifs = { ...kept.pinned_motifs, [k]: v };
    }
    if ('custom_motifs' in body && !(body.only_missing && 'custom_motifs' in kept)) kept = { ...kept, custom_motifs: body.custom_motifs };
    return JSON.parse(JSON.stringify(kept));
  });
  return { puts, kept: () => kept };
}

// Core's own preferences (pinned and custom motifs); a plugin pack's per-key preferences: its own tests.
describe('analysis preferences kept on this computer: pinned and custom motifs', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAnalysisPreferences();
    useBrowserStore.setState({ pinnedMotifs: {}, customMotifs: [] } as never);
  });
  afterEach(() => resetAnalysisPreferences());

  it('the first time on an origin, its own stored pins move to the server without overwriting what is kept there', async () => {
    localStorage.setItem(PINNED_MOTIFS_STORAGE_KEY, JSON.stringify({ fly: ['vfl', 'su(Hw)'], human: ['CTCF'] }));
    localStorage.setItem('fiberhmm_custom_motifs', JSON.stringify([custom('MINE')]));
    const srv = server({ pinned_motifs: { fly: ['Trl'] } });
    await initAnalysisPreferences();
    expect(srv.puts[0]).toMatchObject({ only_missing: true, pinned_motifs: { fly: ['vfl', 'su(Hw)'], human: ['CTCF'] } });
    const s = useBrowserStore.getState();
    expect(s.pinnedMotifs).toEqual({ fly: ['Trl'], human: ['CTCF'] });
    expect(s.customMotifs.map(c => c.name)).toEqual(['MINE']);
    expect(localStorage.getItem(PREFERENCES_MOVED_KEY)).toBe('1');
  });

  it('changes are written back per species (a reset species is forgotten); custom motifs as a list', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    const srv = server({ pinned_motifs: { fly: ['vfl'] } });
    await initAnalysisPreferences();
    const s = useBrowserStore.getState();
    s.setPinnedMotifs('fly', ['vfl', 'su(Hw)']);
    s.setCustomMotifs([custom('CAGGTAG')]);
    await flushPreferences();
    expect(srv.puts.at(-1)).toEqual({ pinned_motifs: { fly: ['vfl', 'su(Hw)'] }, custom_motifs: [custom('CAGGTAG')] });
    s.setPinnedMotifs('fly', null);
    await flushPreferences();
    expect(srv.puts.at(-1)).toEqual({ pinned_motifs: { fly: null } });
    expect(srv.kept().pinned_motifs).toEqual({});
  });

  it('Show preview features: the server\'s choice, written back when it changes; this origin\'s own when the server has none', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    resetPreviewsForTests(false);
    let srv = server({ show_preview_features: true });
    await initAnalysisPreferences();
    expect(usePreviewStore.getState().enabled).toBe(true);
    usePreviewStore.getState().setEnabled(false);
    await flushPreferences();
    expect(srv.puts.at(-1)).toEqual({ show_preview_features: false });
    expect(localStorage.getItem(PREVIEW_STORAGE_KEY)).toBe('false');
    // Another port that turned it on before the server kept it: its choice goes to the server; the default alone doesn't.
    resetAnalysisPreferences();
    resetPreviewsForTests(true);
    srv = server();
    await initAnalysisPreferences();
    await flushPreferences();
    expect(srv.puts).toEqual([{ show_preview_features: true }]);
    resetAnalysisPreferences();
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
    resetPreviewsForTests(false);
    srv = server();
    await initAnalysisPreferences();
    await flushPreferences();
    expect(srv.puts).toEqual([]);
  });

  it('lab build (default on): the default alone is never written; an explicit "on" still moves to a server that has none', async () => {
    localStorage.setItem(PREFERENCES_MOVED_KEY, '1');
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
    resetPreviewsForTests(false);
    setPreviewDefault(true);
    let srv = server();
    await initAnalysisPreferences();
    await flushPreferences();
    expect(usePreviewStore.getState().enabled).toBe(true);
    expect(srv.puts).toEqual([]);
    // The user turned it on themselves (stored), equal to the lab default: kept by the server for every build.
    resetAnalysisPreferences();
    localStorage.setItem(PREVIEW_STORAGE_KEY, 'true');
    srv = server();
    await initAnalysisPreferences();
    await flushPreferences();
    expect(srv.puts).toEqual([{ show_preview_features: true }]);
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
    resetPreviewsForTests(false);
  });
});
