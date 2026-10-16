import '../../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { useBrowserStore } from '../../../stores/browserStore';
import { deserializeSavedState, serializeState } from '../../../stores/historySlice';
import { DEFAULT_NFR_MOTIF_SETTINGS } from '../nfrMotifSettings';
import { PINNED_MOTIFS_STORAGE_KEY } from '../../../utils/pinnedMotifs';
import { familyForPin, looksLikeMotif, mapFamilies, motifKey, NfrMotifs, sitesInside, sortFamilies, thresholdText, zeroSitePins } from './NfrMotifs';
import { COVER_TEST_LABEL, coverageOf, footprintOf, MARKER_MIN_COVERAGE, motifMapHit, motifMapLayout, motifMapWidth } from './MotifMap';
import { NfrMotifParameters } from './NfrMotifParameters';
import { normalizeNfrMotifSettings } from '../nfrMotifSettings';
import { useAccessibilityStore } from '../accessibilityStore';
import { resetJobs } from '../nfrJobs';

const DEFAULT_OPTIONS = { mode: 'p', p: 1e-4, background: 'local', strand: 'both', family_similarity: 0.8, flank: 300, core_bp: 10, min_reads: 10 };

vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNfrMotifs: vi.fn(),
  startNfrClassRun: vi.fn(),
  parseMotifs: vi.fn(),
  getNfrConservation: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: HTMLElement, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  return act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

const V = ['V1', 'V2'];
function family(name: string, o: Partial<api.MotifFamily> & { q?: number; qd?: number; sites?: number } = {}): api.MotifFamily {
  const { q = 1, qd = 1, sites = 1, ...rest } = o;
  const e = (n: string): api.MotifEnrichment => ({ sites: n === 'V1' ? sites : 0, bp: 100, expected: 0.05, log2_vs_local: 1, p_local: q, q_local: q, p_model: q, q_model: q });
  const d = (n: string): api.MotifDifferential => ({ only: n === 'V1' ? sites : 0, only_bp: 60, siblings: 0, siblings_bp: 200, p: qd, q: qd, log2_vs_siblings: 1, open_delta: n === 'V1' ? 0.5 : null, open_site: null });
  return {
    id: `MA_${name}`, name, common: null, pinned: [], members: [{ id: `MA_${name}`, name, common: null, length: 10, min_p: 1e-6, reachable: true }],
    total: sites, region_sites: sites, background: { sites: 2, bp: 8000, expected: 1.2 },
    enrichment: Object.fromEntries(V.map(n => [n, e(n)])), differential: Object.fromEntries(V.map(n => [n, d(n)])),
    sites: sites ? [{ start: 1100, end: 1110, strand: '+', score: 12, p: 1e-5, rel: 0.9, motif: `MA_${name}`, open: { V1: 0.9, V2: 0.2 }, in: ['V1'] }] : [],
    reachable: true, best_q: q, best_q_model: q, best_q_diff: qd, ...rest,
  };
}

function motifs(over: Partial<api.NfrMotifs> = {}): api.NfrMotifs {
  const ranked = Array.from({ length: 30 }, (_, i) => family(`F${String(i).padStart(2, '0')}`, { q: 0.01 + i / 100, qd: 1 - i / 100 }));
  return {
    nfr: 'N1', window: [1000, 2000], region: [0, 6000], variants: V, spans: { V1: [1050, 1200], V2: [1300, 1500] }, members: { V1: 40, V2: 60 },
    species: { genome: 'dm6', taxid: 7227, inferred: false, name: 'fly' },
    pinned: { requested: ['vfl', 'Trl', 'Ibf1'], resolved: { vfl: ['MA1462.2'], Trl: ['MA0205.3'] }, missing: ['Ibf1'], substituted: {}, defaults: ['vfl', 'Trl', 'Ibf1'], species: 'fly' },
    threshold: { mode: 'p', p: 1e-4, relative: null, background: 'local', composition: { A: 0.3, C: 0.2, G: 0.2, T: 0.3 } },
    scanned: 286, unreachable: [{ id: 'MA0212.1', name: 'bcd', length: 6, min_p: 2e-4 }], tested: 230, background: { bp: 8000, intervals: 4 },
    families: [
      family('vfl', { common: 'Zelda', pinned: ['vfl'], q: 0.5 }),
      family('Trl', { common: 'GAF', pinned: ['Trl'], sites: 0 }),
      family('dl', { id: 'MA0023.1', common: 'Dorsal', q: 0.2, members: [{ id: 'MA0023.1', name: 'dl', common: 'Dorsal', length: 10, min_p: 1e-6, reachable: true }, { id: 'MA2213.1', name: 'Dif', common: null, length: 10, min_p: 1e-6, reachable: true }] }),
      ...ranked,
    ],
    with_sites: 32, sentences: ['V1 opens over a vfl (Zelda) site at 1,100 (p = 1.0e-05; pinned): 90% of its reads open there, 20% of V2\'s.'],
    warnings: [], seconds: 0.4, definitions: { sites: 'p', background: 'local', enrichment: 'binomial', differential: 'own part', families: 'similar' },
    ...over,
  };
}

describe('NFR motif view: the map first', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    resetJobs();
    useAccessibilityStore.setState({ qMax: 0.05 });
    useBrowserStore.setState({ pinnedMotifs: {}, motifScoreMode: 'p', motifPValue: 1e-4, motifThreshold: 0.85, customMotifs: [],
      nfrMotifSettings: normalizeNfrMotifSettings(undefined) } as never);
    vi.mocked(api.parseMotifs).mockReset().mockResolvedValue({ motifs: [{ name: 'CAGGTAG', counts: { A: [0, 1, 0, 0, 0, 1, 0], C: [1, 0, 0, 0, 0, 0, 0], G: [0, 0, 1, 1, 0, 0, 1], T: [0, 0, 0, 0, 1, 0, 0] } }] });
    vi.mocked(api.getNfrMotifs).mockReset().mockImplementation(async (_id, _nfr, options) => {
      const m = motifs();
      if (options.pinned) m.pinned = { ...m.pinned, requested: options.pinned, missing: options.pinned.filter(x => x === 'Ibf1') };
      return m;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function render(names = V) {
    await act(async () => root.render(<NfrMotifs jobId="job1" nfrId="N1" names={names} width={600} />));
    await wait(20);
  }
  const enter = (el: HTMLElement) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

  it('scans again when a genome is declared, redeclared or cleared in any view (the shared reference revision)', async () => {
    await render();
    const calls = () => vi.mocked(api.getNfrMotifs).mock.calls.length;
    const before = calls();
    for (let i = 0; i < 3; i++) {              // declare, redeclare, clear: each bumps the revision once
      await act(async () => { useBrowserStore.getState().bumpReferenceRevision(); });
      await wait(20);
      expect(calls()).toBe(before + i + 1);
    }
  });

  it('opens on the motif map of the pinned factors with a site here, and one summary table; no tabs, no q columns', async () => {
    await render();
    expect(api.getNfrMotifs).toHaveBeenCalledWith('job1', 'N1', DEFAULT_OPTIONS);
    const map = q(container, 'nfr-motif-map-wrap')!;
    expect(map.dataset.families).toBe('vfl');                               // pinned with a site (Trl has none here)
    expect(map.dataset.sites).toBe('1');
    expect(q(container, 'nfr-motif-map')).not.toBeNull();
    // the removed views are gone: enrichment, NFR size, profiles, the multi-q sites table, summary sentences
    for (const id of ['nfr-motif-tab-enrichment', 'nfr-motif-tab-sizes', 'nfr-motif-tab-sites', 'nfr-site-metric-share', 'nfr-site-metric-layers',
      'nfr-sizes-view', 'nfr-profile-toggle', 'nfr-motif-summary-sentences', 'nfr-site-q-open', 'nfr-site-q-size', 'nfr-site-q-fp', 'nfr-class-status']) {
      expect(q(container, id), id).toBeNull();
    }
    // the one test sits in the Details disclosure, named the same in its header
    const head = q(container, 'nfr-cover-test-head')!;
    expect(head.closest('details')!.getAttribute('data-testid')).toBe('nfr-motif-details');
    expect(head.textContent).toBe(COVER_TEST_LABEL);
    expect(head.title).toContain('by chance');
    // summary: pinned first; every other family on request
    let rows = qa(container, 'nfr-motif-row');
    expect(rows.map(r => r.dataset.motif)).toEqual(['vfl']);
    expect(rows[0].querySelector('[data-variant="V1"]')!.textContent).toBe('1');   // inside V1's span
    expect(rows[0].querySelector('[data-variant="V2"]')!.textContent).toBe('0');
    expect(q(container, 'nfr-motif-show-all')!.textContent).toContain('Show all families (31 more)');
    await click(q(container, 'nfr-motif-show-all'));
    rows = qa(container, 'nfr-motif-row');
    expect(rows).toHaveLength(32);
    expect(rows[0].dataset.motif).toBe('vfl');                                // pinned stay first
    expect(rows.find(r => r.dataset.motif === 'dl')!.textContent).toContain('+1');   // family members counted
    // sortable: by name, pinned still first
    await click(q(container, 'nfr-motif-sort-name'));
    rows = qa(container, 'nfr-motif-row');
    expect(rows.slice(0, 3).map(r => r.dataset.motif)).toEqual(['vfl', 'dl', 'F00']);
    // the ChIP-Atlas check is behind its own disclosure
    expect(q(container, 'nfr-chipatlas-disclosure')!.tagName).toBe('DETAILS');
  });

  it('a search shows the matching families on the map and in the table (names, common names, members)', async () => {
    await render();
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'dif');
    expect(q(container, 'nfr-motif-map-wrap')!.dataset.families).toBe('dl');
    expect(qa(container, 'nfr-motif-row').map(r => r.dataset.motif)).toEqual(['dl']);
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'zelda');
    expect(q(container, 'nfr-motif-map-wrap')!.dataset.families).toBe('vfl');
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'nothing-like-it');
    // one message, with the way out: no site at the threshold · Relax threshold
    const zero = q(container, 'nfr-motif-zero')!;
    expect(zero.textContent).toContain('nothing-like-it: no site at p ≤ 1.0e−4');
    expect(q(container, 'nfr-motif-map-empty')).toBeNull();
    expect(container.textContent).not.toContain('No family with a site here matches');
    expect(q(container, 'nfr-motif-notice')).toBeNull();
    await click(q(container, 'nfr-motif-relax'));
    expect(useBrowserStore.getState().motifPValue).toBe(1e-3);
    expect(q(container, 'nfr-motif-threshold')!.textContent).toContain('p ≤ 0.001');
  });

  it('a consensus or a pasted matrix typed at the search box becomes a custom motif, pinned and scored', async () => {
    expect(looksLikeMotif('CAGGTAG')).toBe(true);
    expect(looksLikeMotif('CTCF')).toBe(false);
    expect(looksLikeMotif('Clamp')).toBe(false);
    for (const name of ['BEAF-32', 'NRF1', 'Ibf1', 'MA0139.2']) expect(looksLikeMotif(name), name).toBe(false);   // names with digits
    expect(looksLikeMotif('A [ 1 2 ]\nC [ 0 1 ]')).toBe(true);
    expect(looksLikeMotif('A [ 10 2 0 7 ] C [ 0 1 3 4 ]')).toBe(true);          // a one-line matrix
    await render();
    const box = q(container, 'nfr-motif-search') as HTMLInputElement;
    await type(box, 'CAGGTAG');
    await enter(box);
    await wait(20);
    expect(api.parseMotifs).toHaveBeenCalledWith('CAGGTAG', 'CAGGTAG');
    expect(useBrowserStore.getState().customMotifs.map(c => c.name)).toEqual(['CAGGTAG']);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toContain('CAGGTAG');
    // what was added, and (no site here at the threshold) the way out, in one line
    expect(q(container, 'nfr-motif-zero')!.textContent).toContain('Added CAGGTAG (7 bp), pinned ·CAGGTAG: no site at');
    expect(vi.mocked(api.getNfrMotifs).mock.calls.at(-1)![2]).toMatchObject({ custom: [{ name: 'CAGGTAG' }], pinned: expect.arrayContaining(['CAGGTAG']) });
    vi.mocked(api.parseMotifs).mockRejectedValueOnce(new Error('No motif in the text'));
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'NNNNNNACGT');
    await enter(q(container, 'nfr-motif-search')!);
    await wait(20);
    expect(q(container, 'nfr-motif-notice')!.textContent).toContain('Not a motif');
  });

  it('pins and unpins per species (search Enter, a star, the pinned chips), sends it, keeps it in localStorage and the session', async () => {
    await render();
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'Clamp');
    await enter(q(container, 'nfr-motif-search')!);
    await wait(20);
    expect(useBrowserStore.getState().pinnedMotifs).toEqual({ fly: ['vfl', 'Trl', 'Ibf1', 'Clamp'] });
    expect(api.parseMotifs).not.toHaveBeenCalled();
    expect(api.getNfrMotifs).toHaveBeenLastCalledWith('job1', 'N1', { ...DEFAULT_OPTIONS, pinned: ['vfl', 'Trl', 'Ibf1', 'Clamp'] });
    expect(JSON.parse(localStorage.getItem(PINNED_MOTIFS_STORAGE_KEY)!)).toEqual({ fly: ['vfl', 'Trl', 'Ibf1', 'Clamp'] });
    // a name with digits pins too (not parsed as a matrix)
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'BEAF-32');
    await enter(q(container, 'nfr-motif-search')!);
    await wait(20);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toContain('BEAF-32');
    expect(api.parseMotifs).not.toHaveBeenCalled();
    // a common name pins the family's own name
    await type(q(container, 'nfr-motif-search') as HTMLInputElement, 'dorsal');
    await enter(q(container, 'nfr-motif-search')!);
    await wait(20);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toContain('dl');
    // a star pins a family onto the map
    await click(q(container, 'nfr-motif-show-all'));
    await click(qa(container, 'nfr-motif-row').find(r => r.dataset.motif === 'F03')!.querySelector('[data-testid="nfr-motif-star"]'));
    expect(useBrowserStore.getState().pinnedMotifs.fly).toContain('F03');
    await wait(20);
    // the pinned list in one line; its chips behind it
    expect(q(container, 'nfr-motif-pinned-toggle')!.textContent).toContain('with a site here');
    expect(q(container, 'nfr-motif-chip')).toBeNull();
    await click(q(container, 'nfr-motif-pinned-toggle'));
    await click(container.querySelector('[aria-label="Unpin Trl"]'));
    expect(useBrowserStore.getState().pinnedMotifs.fly).not.toContain('Trl');
    expect(qa(container, 'nfr-motif-chip').find(c => c.dataset.name === 'Ibf1')!.className).toContain('line-through');
    // the session carries it; an older session without it keeps the local list
    const snap = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    expect(snap.pinnedMotifs.fly).toContain('Clamp');
    expect((deserializeSavedState(snap) as { pinnedMotifs: Record<string, string[]> }).pinnedMotifs.fly).toContain('F03');
    const { pinnedMotifs: _drop, ...older } = snap;
    void _drop;
    expect('pinnedMotifs' in deserializeSavedState(older)).toBe(false);
    await wait(20);
    await click(q(container, 'nfr-motif-reset'));
    expect(useBrowserStore.getState().pinnedMotifs).toEqual({});
  });

  it('a motif added by name resolves whatever the spelling; one with no site here says so on the map, in the table and the notice (fb-n13)', async () => {
    // the server answers as it resolves: Su(Hw) -> su(Hw) (no site at the threshold), GAF -> Trl, NOPE not in JASPAR
    vi.mocked(api.getNfrMotifs).mockReset().mockImplementation(async (_id, _nfr, options) => {
      const m = motifs();
      const requested = options.pinned ?? m.pinned.requested;
      const names: Record<string, string[]> = { vfl: ['vfl'], Trl: ['Trl'], 'Su(Hw)': ['su(Hw)'], 'su(Hw)': ['su(Hw)'] };
      m.pinned = { ...m.pinned, requested, names: Object.fromEntries(requested.filter(n => names[n]).map(n => [n, names[n]])),
        resolved: { ...m.pinned.resolved, 'Su(Hw)': ['MA0533.1'] }, missing: requested.filter(x => x === 'Ibf1' || x === 'NOPE') };
      if (requested.includes('Su(Hw)')) m.families = [...m.families, family('su(Hw)', { id: 'MA0533.1', pinned: ['Su(Hw)'], sites: 0, members: [{ id: 'MA0533.1', name: 'su(Hw)', common: 'Suppressor of Hairy-wing', length: 20, min_p: 1e-9, reachable: true }] })];
      return m;
    });
    await render();
    const box = () => q(container, 'nfr-motif-search') as HTMLInputElement;
    // a family listed here, typed in another case or by its common name: its JASPAR name, never a second pin
    await type(box(), 'zelda');
    await enter(box());
    await wait(20);
    expect(useBrowserStore.getState().pinnedMotifs.fly ?? ['vfl', 'Trl', 'Ibf1']).toEqual(['vfl', 'Trl', 'Ibf1']);
    expect(q(container, 'nfr-motif-notice')!.textContent).toContain('vfl is pinned already');
    // Su(Hw): not listed here (no site), pinned as typed; the server resolves it, and the view says it has none
    await type(box(), 'Su(Hw)');
    await enter(box());
    await wait(30);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toEqual(['vfl', 'Trl', 'Ibf1', 'Su(Hw)']);
    expect(api.getNfrMotifs).toHaveBeenLastCalledWith('job1', 'N1', expect.objectContaining({ pinned: ['vfl', 'Trl', 'Ibf1', 'Su(Hw)'] }));
    // one line says it (with Relax threshold), not a notice besides it
    expect(q(container, 'nfr-motif-notice')).toBeNull();
    const zero = q(container, 'nfr-motif-zero')!;
    expect(zero.textContent).toContain('Su(Hw) (su(Hw)): no site at p ≤ 1.0e−4');
    expect(zero.dataset.names).toBe('Su(Hw) (su(Hw))');                         // your own pins (defaults stay faint chips)
    expect(q(container, 'nfr-motif-relax')).not.toBeNull();
    const row = qa(container, 'nfr-motif-row').find(r => r.dataset.motif === 'su(Hw)')!;
    expect(row.dataset.sites).toBe('0');
    expect(q(row, 'nfr-motif-zero-row')!.textContent).toBe('0 sites here at p ≤ 1.0e−4');
    // the same motif typed again in another case is pinned already
    await type(box(), 'SU(HW)');
    await enter(box());
    await wait(20);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toHaveLength(4);
    expect(q(container, 'nfr-motif-zero')!.textContent).toContain('Su(Hw) (su(Hw)): no site');
    // a name JASPAR does not have: said under the map and in the notice
    await type(box(), 'NOPE');
    await enter(box());
    await wait(30);
    expect(q(container, 'nfr-motif-notice')!.textContent).toContain('NOPE: not found in JASPAR CORE');
    expect(q(container, 'nfr-motif-zero')).toBeNull();                          // the last action's message only
    // the default Ibf1 that JASPAR lacks is said plainly, not as an error
    expect(q(container, 'nfr-motif-unavailable')!.textContent).toBe('Default factor unavailable in JASPAR CORE: Ibf1');
    // typing clears the notice; the map's own message (Su(Hw) has no site) comes back
    await type(box(), 'x');
    await type(box(), '');
    expect(q(container, 'nfr-motif-notice')!.textContent).toBe('Not in JASPAR CORE (fly): NOPE');
    // relative scoring words the threshold its way
    expect(thresholdText({ ...motifs(), threshold: { ...motifs().threshold, mode: 'relative', relative: 0.8 } })).toBe('≥ 80% of the score range');
  });

  it('the name helpers: punctuation- and case-free keys, a pin\'s family through what it resolved to, pins with no site', () => {
    expect(motifKey('Su(Hw)')).toBe('suhw');
    expect(motifKey('Krüppel')).toBe(motifKey('kruppel'));
    const m = motifs();
    m.pinned = { ...m.pinned, requested: ['vfl', 'GAF', 'Trl', 'Ibf1'], resolved: { vfl: ['MA_vfl'], GAF: ['MA_Trl'], Trl: ['MA_Trl'] } };
    expect(familyForPin(m, 'GAF')!.name).toBe('Trl');                           // pinned twice: the first name's family
    expect(zeroSitePins(m)).toEqual(['GAF', 'Trl']);                             // Ibf1 is missing, not empty
  });

  it('the summary helpers: sites inside each span, pinned first whatever the sort, the map families in pinned order', () => {
    const a = family('A', { sites: 1 }), b = family('B', { sites: 1, pinned: ['B'] });
    b.sites = [...b.sites, { ...b.sites[0], start: 1400, end: 1410, in: ['V2'] }];
    expect(sitesInside(b, V)).toEqual({ V1: 1, V2: 1 });
    expect(sortFamilies([a, b], { key: 'name', dir: 1 }, V, ['B']).map(r => r.name)).toEqual(['B', 'A']);
    expect(sortFamilies([a, b], { key: 'V2', dir: -1 }, V, ['B']).map(r => r.name)).toEqual(['B', 'A']);
    const m = motifs({ pinned: { ...motifs().pinned, requested: ['dl', 'vfl'] } });
    m.families.find(f => f.name === 'dl')!.pinned = ['dl'];
    expect(mapFamilies(m, '').map(f => f.name)).toEqual(['dl', 'vfl']);       // the pinned list's order
  });
});

describe('pinned motifs and imported sessions', () => {
  it('take an imported session\'s list, and keep the local one for a session without', async () => {
    const { applyImportedState } = await import('../../../api/session');
    useBrowserStore.setState({ pinnedMotifs: { fly: ['vfl'] } } as never);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr2L', start: 1, end: 2 } });
    expect(useBrowserStore.getState().pinnedMotifs).toEqual({ fly: ['vfl'] });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { pinnedMotifs: { fly: ['Trl', 'Clamp'] } }, viewport: { chrom: 'chr2L', start: 1, end: 2 } });
    expect(useBrowserStore.getState().pinnedMotifs).toEqual({ fly: ['Trl', 'Clamp'] });
  });
});



// ---------------------------------------------------------------- coverage, the footprint marker, parameters
function layer(open: number, fp: number | null, reads = 100): api.SiteLayer {
  return { reads, open: Math.round(open * reads), labelled: Math.round(open * reads), unlabelled_open: fp == null ? null : 0,
    footprinted: fp == null ? 0 : Math.round(open * reads * fp), excluded_members: fp == null ? null : { nucleosome: 2, linker: 0 },
    p_open: open, ci_open: [open - 0.05, open + 0.05], p_fp_given_open: fp, ci_fp_given_open: fp == null ? null : [fp - 0.1, fp + 0.1],
    p_footprinted: fp == null ? null : open * fp,
    stack: { closed: 1 - open, open_unfootprinted: fp == null ? null : open * (1 - fp), open_footprinted: fp == null ? null : open * fp } };
}

let classesJoined = 3;
describe('NFR motif map: coverage per site, the footprint marker, Details', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    resetJobs();
    useAccessibilityStore.setState({ qMax: 0.05 });
    useBrowserStore.setState({ pinnedMotifs: {}, motifScoreMode: 'p', motifPValue: 1e-4, motifThreshold: 0.85, customMotifs: [],
      nfrMotifSettings: normalizeNfrMotifSettings(undefined) } as never);
    vi.mocked(api.getNfrMotifs).mockReset().mockImplementation(async () => {
      const m = motifs();
      const dl = m.families.find(f => f.name === 'dl')!;
      dl.pinned = ['dl'];
      m.pinned = { ...m.pinned, requested: ['vfl', 'Trl', 'Ibf1', 'dl'] };
      dl.sites = [{ ...dl.sites[0], layers: { V1: layer(0.95, 0.2), V2: layer(0.4, 0.05) }, classes: classesJoined ? [{ id: 'c7', label: 'class 007', start: 1095, end: 1115, prevalence: 0.2 }] : [],
        q_open_diff: 1e-40, q_fp_diff: 0.001, p_open_diff: 1e-41, p_fp_diff: 1e-4,
        coverage: { V1: { n: 40, covered: 38, p: 0.95, ci: [0.83, 0.99], share: 0.86 }, V2: { n: 60, covered: 3, p: 0.05, ci: [0.01, 0.14], share: 0.14 } },
        q_cover_diff: 1e-20, cover_delta: 0.85, sizes: { V1: { n: 38, q1: 140, median: 150, q3: 160 } }, q_size_diff: 0.002 }];
      m.occupancy = { available: true, classes: classesJoined, class_job: classesJoined ? 'cj' : null, joined: classesJoined ? 'run' : null, sites: 10, sites_with_class: classesJoined ? 1 : 0,
        class_reason: classesJoined ? null : 'No Find classes run in this session covers these molecules.',
        definitions: { cover_test: 'Coverage between variants: Fisher', coverage: 'cov' } };
      return m;
    });
    classesJoined = 3;
    vi.mocked(api.startNfrClassRun).mockReset().mockResolvedValue({ job_id: 'c1', status: 'queued', existing: false });
    vi.mocked(api.parseMotifs).mockReset().mockResolvedValue({ motifs: [{ name: 'MINE', counts: { A: [1, 0, 0], C: [0, 1, 0], G: [0, 0, 1], T: [0, 0, 0] } }] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function render() {
    await act(async () => root.render(<NfrMotifs jobId="job1" nfrId="N1" names={V} width={600} datasetIds={['ds1']} />));
    await wait(20);
  }

  it('one metric per site and variant (coverage); the footprint marker only where classes exist and the variant opens', async () => {
    await render();
    const map = q(container, 'nfr-motif-map-wrap')!;
    expect(map.dataset.families).toBe('vfl,dl');
    const m = await vi.mocked(api.getNfrMotifs).mock.results[0].value as api.NfrMotifs;
    const site = m.families.find(f => f.name === 'dl')!.sites[0];
    expect(coverageOf(site, 'V1')).toBe(0.95);
    expect(footprintOf(site, 'V1')).toBe(0.2);
    expect(MARKER_MIN_COVERAGE).toBeGreaterThan(0.05);               // V2 covers 5%: no marker drawn there
    // the tooltip names the site, each variant's coverage with its reads, and the one test
    const lay = motifMapLayout(600, 2, 2, 2);
    await act(async () => { map.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: lay.L + 3, clientY: lay.gridTop + 3 })); });
    const tip = q(container, 'nfr-motif-map-tip')!;
    expect(tip.textContent).toContain('dl (Dorsal)');
    expect(tip.textContent).toContain('V1: 95% (38 of 40 reads) · footprinted when open 20%');
    expect(tip.textContent).toContain('Coverage differs: q 1.0e-20');
    expect(tip.textContent).toContain('class 007');
    // Details: the same sites as numbers, the one test, the classes linked
    const dl = qa(container, 'nfr-site-row').find(r => r.dataset.motif === 'dl')!;
    expect(dl.querySelector('[data-variant="V1"]')!.textContent).toBe('95%●20%');
    expect(dl.querySelector('[data-variant="V1"]')!.getAttribute('title')).toContain('38 of 40 reads');
    expect(dl.querySelector('[data-variant="V2"]')!.textContent).toBe('5%');            // covers too little for a marker
    expect(dl.querySelector('[data-testid="nfr-site-q-cover"]')!.textContent).toBe('1.0e-20');
    expect(dl.querySelector('[data-testid="nfr-site-q-cover"]')!.getAttribute('title')).toContain('Fisher');
    expect(dl.querySelector('[data-testid="nfr-site-classes"]')!.textContent).toContain('007');
    // no Run Find classes here: it lives in the Footprints section
    expect(q(container, 'nfr-run-classes')).toBeNull();
  });

  it('every variant column fits: a narrow map is drawn at the width it needs (Codex review)', () => {
    for (const n of [2, 4, 8, 12]) {
      for (const width of [260, 360, 760]) {
        const w = motifMapWidth(width, n);
        const lay = motifMapLayout(w, n, 3, 5);
        expect(lay.L + n * lay.cellW + lay.R, `${n} variants at ${width}`).toBeLessThanOrEqual(w);
        expect(w).toBeGreaterThanOrEqual(width);
      }
    }
    expect(motifMapWidth(760, 4)).toBe(760);                          // wide enough: as given
  });

  it('the hit test finds a grid cell and a tick', () => {
    const lay = motifMapLayout(600, 2, 1, 1);
    const fam = family('dl');
    const sites = [{ family: fam, site: fam.sites[0], color: '#000' }];
    expect(motifMapHit(lay, 600, [1000, 2000], sites, [{ family: fam, color: '#000' }], V, lay.L + lay.cellW + 2, lay.gridTop + 2)).toEqual({ site: 0, variant: 'V2' });
    const x = lay.L + ((1105 - 1000) / 1000) * (600 - lay.L - lay.R);
    expect(motifMapHit(lay, 600, [1000, 2000], sites, [{ family: fam, color: '#000' }], V, x, lay.famTop + 3)).toEqual({ site: 0, variant: null });
    expect(motifMapHit(lay, 600, [1000, 2000], sites, [{ family: fam, color: '#000' }], V, 5, 2)).toBeNull();
  });

  it('without footprint classes: no class column and no marker; a cached answer is asked again once; phyloP on request', async () => {
    classesJoined = 0;
    await render();
    const dl = qa(container, 'nfr-site-row').find(r => r.dataset.motif === 'dl')!;
    expect(dl.querySelector('[data-testid="nfr-site-classes"]')).toBeNull();
    expect(dl.querySelector('[data-variant="V1"]')!.textContent).toBe('95%');
    await wait(20);
    expect(api.getNfrMotifs).toHaveBeenCalledTimes(2);                  // asked again once (no loop)
    vi.mocked(api.getNfrConservation).mockResolvedValue({ nfr: 'N1', genome: 'dm6', track: 'phyloP', url: 'u', window: [1000, 1200],
      values: Array.from({ length: 200 }, (_, i) => (i >= 100 && i < 110 ? 4 : 0.5)) });
    await click(q(container, 'nfr-sites-conservation'));
    await wait(20);
    const ph = qa(container, 'nfr-site-row').find(r => r.dataset.motif === 'dl')!.querySelector('[data-testid="nfr-site-phylop"]')!;
    expect(ph.textContent).toBe('4.0 / 0.5');
  });

  it('the Parameters panel changes the request; scoring mode keeps a threshold per mode; custom motifs are added and sent', async () => {
    await act(async () => root.render(<><NfrMotifParameters /><NfrMotifs jobId="job1" nfrId="N1" names={V} width={600} /></>));
    await wait(20);
    await click(q(container, 'nfr-motif-parameters-toggle'));
    const input = q(container, 'nfr-motif-scoring-p-input') as HTMLInputElement;
    await type(input, '3.2e-5');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await wait(20);
    expect(useBrowserStore.getState().motifPValue).toBeCloseTo(3.2e-5);
    expect(vi.mocked(api.getNfrMotifs).mock.calls.at(-1)![2]).toMatchObject({ mode: 'p', p: 3.2e-5 });
    await click(q(container, 'nfr-motif-scoring-mode-relative'));
    await wait(20);
    expect(vi.mocked(api.getNfrMotifs).mock.calls.at(-1)![2]).toMatchObject({ mode: 'relative', relative: 0.85 });
    expect(vi.mocked(api.getNfrMotifs).mock.calls.at(-1)![2]).not.toHaveProperty('p');
    const calls = vi.mocked(api.getNfrMotifs).mock.calls.length;
    await click(q(container, 'nfr-motif-scoring-mode-p'));
    await wait(20);
    expect(useBrowserStore.getState()).toMatchObject({ motifScoreMode: 'p', motifPValue: 3.2e-5 });   // its own threshold back
    expect(vi.mocked(api.getNfrMotifs).mock.calls.length).toBe(calls);   // that scan is cached by its options: no new request
    const core = q(container, 'nfr-motif-core') as HTMLInputElement;
    await type(core, '16');
    await wait(20);
    expect(useBrowserStore.getState().nfrMotifSettings.coreBp).toBe(16);
    expect(vi.mocked(api.getNfrMotifs).mock.calls.at(-1)![2]).toMatchObject({ core_bp: 16 });
    const text = q(container, 'nfr-custom-motif-text') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(text, 'CAG'); text.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q(container, 'nfr-custom-motif-add'));
    await wait(20);
    expect(api.parseMotifs).toHaveBeenCalledWith('CAG', undefined);
    expect(useBrowserStore.getState().customMotifs.map(c => c.name)).toEqual(['MINE']);
    expect(vi.mocked(api.getNfrMotifs).mock.calls.at(-1)![2]).toMatchObject({ custom: [{ name: 'MINE' }] });
    // settings travel with the session; a session from before the toggle restores in relative mode
    const snap = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    expect(snap).toMatchObject({ motifScoreMode: 'p', nfrMotifSettings: { coreBp: 16 }, customMotifs: [{ name: 'MINE' }] });
    const { motifScoreMode: _m, ...older } = snap;
    void _m;
    expect((deserializeSavedState(older) as { motifScoreMode: string }).motifScoreMode).toBe('relative');
  });

  it('a session or stored preference with the removed profile settings loads without them', () => {
    const old = { ...DEFAULT_NFR_MOTIF_SETTINGS, coreBp: 12, profileHalf: 200, profileSmooth: 3, profileNormalise: 'flanks' };
    const norm = normalizeNfrMotifSettings(old);
    expect(norm).toEqual({ ...DEFAULT_NFR_MOTIF_SETTINGS, coreBp: 12 });
    expect(Object.keys(norm)).not.toContain('profileHalf');
    const snap = JSON.parse(JSON.stringify(serializeState(useBrowserStore.getState())));
    const restored = deserializeSavedState({ ...snap, nfrMotifSettings: old }) as { nfrMotifSettings: Record<string, unknown> };
    expect(restored.nfrMotifSettings).toEqual({ ...DEFAULT_NFR_MOTIF_SETTINGS, coreBp: 12 });
    localStorage.setItem('fiberhmm_nfr_motif_settings', JSON.stringify(old));
    expect(Object.keys(normalizeNfrMotifSettings(JSON.parse(localStorage.getItem('fiberhmm_nfr_motif_settings')!)))).not.toContain('profileSmooth');
  });

  it('an imported session from before the p / % toggle keeps relative mode; a newer one its own', async () => {
    const { applyImportedState } = await import('../../../api/session');
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { motifThreshold: 0.9 }, viewport: { chrom: 'chr2L', start: 1, end: 2 } });
    expect(useBrowserStore.getState().motifScoreMode).toBe('relative');
    expect(useBrowserStore.getState().motifThreshold).toBe(0.9);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { motifThreshold: 0.9, motifScoreMode: 'p', motifPValue: 1e-6 }, viewport: { chrom: 'chr2L', start: 1, end: 2 } });
    expect(useBrowserStore.getState().motifScoreMode).toBe('p');
    expect(useBrowserStore.getState().motifPValue).toBe(1e-6);
  });
});
