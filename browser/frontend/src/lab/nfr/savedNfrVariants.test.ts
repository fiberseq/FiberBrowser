import '../testSetup';
import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { applyImportedState } from '../../api/session';
import { deserializeSavedState as deserializeState, serializeState } from '../../stores/historySlice';
import { NFR_RESULT } from './accessibility/fixture';
import { CLUSTER_COLORS } from '../../components/tracks/read-track/constants';
import { variantColor } from './accessibilityView';
import {
  MAX_SAVED_NFRS, SAVED_NFR_VARIANTS_STORAGE_KEY, loadSavedNfrVariants, normalizeSavedNfrVariants, savedFromNfr, savedVariantIds, savedVariantsBed, type SavedNfr,
} from './savedNfrVariants';

const nfr = NFR_RESULT.nfrs[0];
const entry = (ids?: string[]) => savedFromNfr('job1', NFR_RESULT, nfr, ['ds1'], ids);
/** An entry of the older per-variant format, as sessions and localStorage hold it. */
const oldEntry = (variant = nfr.variants[1], extra: Record<string, unknown> = {}) => ({
  id: `old-${variant.name}`, name: `${nfr.id} ${variant.name} ${variant.relation}`, color: '#c026d3', jobId: 'job1', variantId: variant.id, nfrId: nfr.id,
  chrom: 'chr19', start: Math.round(variant.L), end: Math.round(variant.R), nfrStart: nfr.start, nfrEnd: nfr.end, region: NFR_RESULT.region,
  datasetIds: ['ds1'], relation: variant.relation, depth: variant.depth, width: variant.width, prevalence: variant.prevalence, strict: variant.strict,
  ci: variant.ci, callable: nfr.callable, reads: nfr.reads, stringency: 0.9, savedAt: 1, ...extra,
});

describe('saved NFRs (one entry per NFR, holding its variants)', () => {
  it('describe themselves: the NFR, every variant\'s geometry and prevalence when saved, the run and its window', () => {
    const e = entry(['N1:V2']);
    expect(e).toMatchObject({ name: 'N1', jobId: 'job1', nfrId: 'N1', chrom: 'chr19', nfrStart: 47518170, nfrEnd: 47518510, region: NFR_RESULT.region,
      datasetIds: ['ds1'], callable: 2661, stringency: 0.9 });
    expect(e.variants.map(v => [v.name, v.shown])).toEqual([['V1', false], ['V2', true], ['V3', false]]);
    expect(e.variants[1]).toMatchObject({ variantId: 'N1:V2', start: 47518219, end: 47518459, prevalence: 0.2907, strict: 0.2679, relation: 'full' });
  });

  it('saving a variant saves its NFR; saving more of it ticks them in the same entry; localStorage follows', () => {
    useBrowserStore.setState({ savedNfrVariants: [] } as never);
    const add = useBrowserStore.getState().addSavedNfrVariants;
    expect(add([entry(['N1:V2'])])).toBe(1);
    expect(add([entry(['N1:V2'])])).toBe(0);                              // already saved
    expect(add([entry(['N1:V1', 'N1:V2'])])).toBe(1);                     // V1 ticked in the same entry
    let saved = useBrowserStore.getState().savedNfrVariants;
    expect(saved).toHaveLength(1);
    expect(saved[0].variants.filter(v => v.shown).map(v => v.name)).toEqual(['V1', 'V2']);
    expect(add([entry()])).toBe(1);                                        // Save all: every variant
    saved = useBrowserStore.getState().savedNfrVariants;
    expect(savedVariantIds(saved, 'job1')).toEqual(new Set(['N1:V1', 'N1:V2', 'N1:V3']));
    useBrowserStore.getState().setSavedNfrVariantShown(saved[0].id, 'N1:V3', false);
    expect(useBrowserStore.getState().savedNfrVariants[0].variants.map(v => v.shown)).toEqual([true, true, false]);
    const stored = JSON.parse(localStorage.getItem(SAVED_NFR_VARIANTS_STORAGE_KEY)!) as SavedNfr[];
    expect(stored).toHaveLength(1);
    expect(stored[0].variants.map(v => v.shown)).toEqual([true, true, false]);
    useBrowserStore.getState().updateSavedNfrVariant(saved[0].id, { name: 'GATA NFR', note: 'check in mutant' });
    expect(useBrowserStore.getState().savedNfrVariants[0]).toMatchObject({ name: 'GATA NFR', note: 'check in mutant' });
    useBrowserStore.getState().removeSavedNfrVariant(saved[0].id);
    expect(useBrowserStore.getState().savedNfrVariants).toHaveLength(0);
  });

  it('migrate older per-variant entries (localStorage and sessions) into one entry per run and NFR', () => {
    const old = [oldEntry(nfr.variants[1]), oldEntry(nfr.variants[0], { name: 'left register', note: 'check' }),
      oldEntry(nfr.variants[2], { id: 'other-run', jobId: 'job2' })];
    const out = normalizeSavedNfrVariants(old);
    expect(out.map(e => [e.jobId, e.nfrId, e.variants.map(v => v.name).join('+')])).toEqual([['job1', 'N1', 'V1+V2'], ['job2', 'N1', 'V3']]);
    expect(out[0]).toMatchObject({ id: 'old-V2', name: 'N1', nfrStart: 47518170, callable: 2661, note: 'V1: left register: check' });
    expect(out[0].variants.every(v => v.shown)).toBe(true);
    expect(out[0].variants[0]).toMatchObject({ variantId: 'N1:V1', start: 47518152, prevalence: 0.1811 });
    localStorage.setItem(SAVED_NFR_VARIANTS_STORAGE_KEY, JSON.stringify(old));
    expect(loadSavedNfrVariants().map(e => e.variants.length)).toEqual([2, 1]);
    // a session written before the change restores per-NFR entries
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { savedNfrVariants: old }, viewport: { chrom: 'chr19', start: 1, end: 2 } });
    expect(useBrowserStore.getState().savedNfrVariants.map(e => e.variants.length)).toEqual([2, 1]);
  });

  it('resaving a variant of a migrated entry brings in its missing siblings (unticked)', () => {
    useBrowserStore.setState({ savedNfrVariants: normalizeSavedNfrVariants([oldEntry(nfr.variants[0])]) } as never);
    expect(useBrowserStore.getState().savedNfrVariants[0].variants.map(v => v.name)).toEqual(['V1']);
    expect(useBrowserStore.getState().addSavedNfrVariants([entry(['N1:V1'])])).toBe(0);
    expect(useBrowserStore.getState().savedNfrVariants[0].variants.map(v => [v.name, v.shown])).toEqual([['V1', true], ['V2', false], ['V3', false]]);
  });

  it('migration keeps merging variants into NFRs already kept once the entry limit is reached', () => {
    const many = Array.from({ length: MAX_SAVED_NFRS }, (_, i) => oldEntry(nfr.variants[0], { id: `o${i}`, jobId: `job${i}` }));
    const out = normalizeSavedNfrVariants([...many, oldEntry(nfr.variants[1], { id: 'late', jobId: 'job0' }), oldEntry(nfr.variants[1], { id: 'new', jobId: 'jobX' })]);
    expect(out).toHaveLength(MAX_SAVED_NFRS);
    expect(out[0].variants.map(v => v.name)).toEqual(['V1', 'V2']);
    expect(out.some(e => e.jobId === 'jobX')).toBe(false);
  });

  it('travel with the session state (serialize -> deserialize), and an older session without them restores none', () => {
    useBrowserStore.setState({ savedNfrVariants: [] } as never);
    useBrowserStore.getState().addSavedNfrVariants([entry(['N1:V1'])]);
    const snap = serializeState(useBrowserStore.getState());
    expect(snap.savedNfrVariants).toHaveLength(1);
    const json = JSON.parse(JSON.stringify(snap));
    useBrowserStore.setState({ savedNfrVariants: [] } as never);
    const restored = deserializeState(json) as { savedNfrVariants: SavedNfr[] };
    expect(restored.savedNfrVariants[0]).toMatchObject({ nfrId: 'N1', jobId: 'job1' });
    expect(restored.savedNfrVariants[0].variants.map(v => v.shown)).toEqual([true, false, false]);
    const { savedNfrVariants: _drop, ...older } = json;
    void _drop;
    expect((deserializeState(older) as { savedNfrVariants: SavedNfr[] }).savedNfrVariants).toEqual([]);
  });

  it('normalise untrusted input', () => {
    const good = { ...entry(), id: 'a', savedAt: 1 };
    const out = normalizeSavedNfrVariants([good, { ...good }, null, { id: 'b' }, { ...good, id: 'c', variants: [{ variantId: 'N1:V1', start: 'x' }] },
      { ...good, id: 'd', jobId: 'job9', variants: [{ ...good.variants[0], ci: [1] }] }]);
    expect(out.map(e => e.id)).toEqual(['a', 'd']);
    expect(out[1].variants[0].ci).toBeNull();
    expect(normalizeSavedNfrVariants('nope')).toEqual([]);
  });

  it('export the ticked variants as BED6+ with the prevalence as score and the variant\'s colour', () => {
    const bed = savedVariantsBed([{ ...entry(['N1:V2', 'N1:V3']), id: 'a', savedAt: 1 }]);
    const lines = bed.trim().split('\n').slice(1).map(l => l.split('\t'));
    expect(lines.map(l => l[3])).toEqual(['N1_V2_full', 'N1_V3_alternative-right']);
    expect(lines[0].slice(0, 6)).toEqual(['chr19', '47518219', '47518459', 'N1_V2_full', '291', '.']);
    const hex = variantColor('V2');
    expect(lines[0][8]).toBe([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(','));
  });

  it('variant k has cluster colour k - 1 (the read panels\' colour for the single-variant configuration Vk)', () => {
    expect(['V1', 'V2', 'V3'].map(variantColor)).toEqual(CLUSTER_COLORS.slice(0, 3));
  });

  it('are replaced by an imported session\'s own (none for a session without them)', () => {
    useBrowserStore.setState({ savedNfrVariants: [] } as never);
    useBrowserStore.getState().addSavedNfrVariants([entry()]);
    const theirs = [{ ...entry(['N1:V3']), id: 'theirs', savedAt: 5 }];
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { savedNfrVariants: theirs }, viewport: { chrom: 'chr19', start: 1, end: 2 } });
    expect(useBrowserStore.getState().savedNfrVariants.map(e => e.id)).toEqual(['theirs']);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr19', start: 1, end: 2 } });
    expect(useBrowserStore.getState().savedNfrVariants).toEqual([]);
  });
});
