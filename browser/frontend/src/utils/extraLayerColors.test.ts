import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTRA_LAYER_PALETTE,
  assignExtraLayerColors,
  getLayerColor,
  legacyHashLayerColor,
  setLayerColorSource,
} from './layerColors';

// Built-in layers' curated colours (KNOWN_COLORS).
const BUILT_IN = [
  'nuc', 'tf', 'footprint', 'msp', 'fire', 'm6a', 'mod', 'm5c', 'deam', 'deam_ct', 'deam_ga',
  'nuc_sr', 'tf_sr', 'tf_consensus', 'tf_cross_consensus', 'ddda_mcg', 'ddda_mcg_hemi',
  'tf_native_replay', 'tf_sr_lattice', 'tf_cr', 'tf_recall', 'tf_cr_recalled', 'tf_xcr',
  'nuc_cr_split', 'cr_split_gap', 'deam_opportunity',
];

function lab(hex: string): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

const NAMES = ['tf2', 'tf3', 'tf4', 'nuc_a', 'nuc_b'];
const dataset = (names: string[]) => ({ available_layers: Object.fromEntries(names.map(n => [n, true])) });

afterEach(() => setLayerColorSource([]));

describe('extra layer colours', () => {
  it('gives similar names clearly different colours', () => {
    setLayerColorSource([dataset(['nuc', 'tf', ...NAMES])]);
    const colors = NAMES.map(getLayerColor);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(deltaE(colors[i], colors[j]), `${NAMES[i]} vs ${NAMES[j]}`).toBeGreaterThan(20);
      }
    }
    // 3.0.6's hash rule put tf2/tf3/tf4 within a few degrees of hue.
    expect(deltaE(legacyHashLayerColor('tf2'), legacyHashLayerColor('tf3'))).toBeLessThan(5);
  });

  it('keeps clear of the built-in colours', () => {
    setLayerColorSource([dataset(NAMES)]);
    const builtIn = BUILT_IN.map(getLayerColor);
    for (const name of NAMES) {
      for (const known of builtIn) expect(deltaE(getLayerColor(name), known)).toBeGreaterThan(20);
    }
    for (const color of EXTRA_LAYER_PALETTE) {
      for (const known of builtIn) expect(deltaE(color, known)).toBeGreaterThan(20);
    }
  });

  it('is stable across calls, reloads and load order', () => {
    const first = assignExtraLayerColors([dataset(['tf4', 'nuc_a']), dataset(['tf2', 'nuc_b', 'tf3'])]);
    const again = assignExtraLayerColors([dataset(['tf3', 'tf2', 'nuc_b']), dataset(['nuc_a', 'tf4'])]);
    expect([...again.entries()].sort()).toEqual([...first.entries()].sort());
    setLayerColorSource([dataset(NAMES)]);
    const a = NAMES.map(getLayerColor);
    setLayerColorSource([dataset([...NAMES].reverse())]);
    expect(NAMES.map(getLayerColor)).toEqual(a);
  });

  it("keeps a layer's own colour and does not reuse it", () => {
    const own = EXTRA_LAYER_PALETTE[0];
    const colors = assignExtraLayerColors([{
      available_layers: { tf2: true, tf3: true, scan_hits: true },
      derived_layers: { scan_hits: { color: own } },
    }]);
    expect(colors.has('scan_hits')).toBe(false);
    expect(colors.get('tf2')).not.toBe(own);
    expect(colors.get('tf3')).not.toBe(own);
    expect(colors.get('tf2')).not.toBe(colors.get('tf3'));
  });

  it('steps lightness past the palette instead of repeating a hue', () => {
    const names = Array.from({ length: EXTRA_LAYER_PALETTE.length * 2 + 3 }, (_, i) => `x${String(i).padStart(2, '0')}`);
    const colors = [...assignExtraLayerColors([dataset(names)]).values()];
    expect(new Set(colors).size).toBe(colors.length);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const n = EXTRA_LAYER_PALETTE.length;
    for (let i = 0; i + n < colors.length; i++) expect(deltaE(colors[i], colors[i + n])).toBeGreaterThan(12);
  });

  it('gives a name outside the loaded set a deterministic palette colour', () => {
    expect(getLayerColor('not_loaded')).toBe(getLayerColor('not_loaded'));
    expect(EXTRA_LAYER_PALETTE).toContain(getLayerColor('not_loaded'));
    expect(getLayerColor('nuc')).toBe('#16a34a');
  });
});

describe('default metaprofile source colours', () => {
  it('moves a colour stamped by the old hash rule to the palette colour, and keeps a chosen one', async () => {
    const { createTestStore } = await import('../stores/__tests__/helpers');
    const { DEFAULT_METAPROFILE_ID } = await import('../types/dataset');
    const ds = { id: 'ds1', label: 'A', path: '/tmp/a.bam', color: '#111111', data_type: 'bam',
      available_layers: { nuc: true, tf2: true, tf3: true } } as any;
    setLayerColorSource([ds]);
    const store = createTestStore();
    store.setState({ datasets: [ds] });
    store.getState().seedDefaultMetaprofile();
    const track = () => store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const colorOf = (key: string) => track().sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === key)!.color;
    expect(colorOf('tf2')).toBe(getLayerColor('tf2'));
    // A 3.0.6 session: tf2 still has its old hash colour, tf3 one the user picked.
    store.setState({
      compositeTracks: store.getState().compositeTracks.map(c => c.id !== DEFAULT_METAPROFILE_ID ? c : {
        ...c,
        sources: c.sources.map(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === 'tf2'
          ? { ...s, color: legacyHashLayerColor('tf2'), autoColor: undefined }
          : s.ref.kind === 'metaprofile' && s.ref.ruleId === 'tf3' ? { ...s, color: '#123456', autoColor: undefined } : s),
      }),
    });
    store.getState().seedDefaultMetaprofile();
    expect(colorOf('tf2')).toBe(getLayerColor('tf2'));
    expect(colorOf('tf3')).toBe('#123456');
  });
});

describe('default metaprofile colours follow the loaded set', () => {
  const ds = (id: string, layers: string[]) => ({ id, label: id, path: `/tmp/${id}.bam`, color: '#111111', data_type: 'bam',
    available_layers: Object.fromEntries([['nuc', true], ...layers.map(l => [l, true])]) }) as any;

  async function sourceColors(order: any[][]) {
    const { createTestStore } = await import('../stores/__tests__/helpers');
    const { DEFAULT_METAPROFILE_ID } = await import('../types/dataset');
    const store = createTestStore();
    for (const datasets of order) {
      store.setState({ datasets });
      store.getState().seedDefaultMetaprofile();
    }
    const track = store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    return Object.fromEntries(track.sources.filter(s => s.ref.kind === 'metaprofile')
      .map(s => [(s.ref as any).ruleId, s.color]));
  }

  it('is the same whichever dataset loads first, and matches the read layers', async () => {
    const a = ds('a', ['tf3']); const b = ds('b', ['tf2']);
    const ab = await sourceColors([[a], [a, b]]);
    const ba = await sourceColors([[b], [b, a]]);
    expect(ab.tf2).toBe(ba.tf2);
    expect(ab.tf3).toBe(ba.tf3);
    expect(ab.tf2).not.toBe(ab.tf3);
    expect(ab.tf2).toBe(getLayerColor('tf2'));
  });

  it('an imported cart with old colours takes the current ones, keeping a picked colour', async () => {
    const { createTestStore } = await import('../stores/__tests__/helpers');
    const { DEFAULT_METAPROFILE_ID } = await import('../types/dataset');
    const store = createTestStore();
    const d = ds('a', ['tf2', 'tf3']);
    store.setState({ datasets: [d] });
    store.getState().seedDefaultMetaprofile();
    const seeded = store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    store.getState().setCompositeTracks([{ ...seeded, sources: seeded.sources.map(s =>
      (s.ref as any).ruleId === 'tf2' ? { ...s, color: legacyHashLayerColor('tf2'), autoColor: undefined }
        : (s.ref as any).ruleId === 'tf3' ? { ...s, color: '#123456', autoColor: undefined } : s) }]);
    const track = store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const color = (k: string) => track.sources.find(s => (s.ref as any).ruleId === k)!.color;
    expect(color('tf2')).toBe(getLayerColor('tf2'));
    expect(color('tf3')).toBe('#123456');
  });
});

describe('picked colours (re-check)', () => {
  it('a palette colour the user picks is kept', async () => {
    const { createTestStore } = await import('../stores/__tests__/helpers');
    const { DEFAULT_METAPROFILE_ID } = await import('../types/dataset');
    const store = createTestStore();
    store.setState({ datasets: [{ id: 'a', label: 'a', path: '/tmp/a.bam', color: '#111111', data_type: 'bam',
      available_layers: { nuc: true, tf2: true, tf3: true } } as any] });
    store.getState().seedDefaultMetaprofile();
    const track = () => store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const tf3 = track().sources.find(s => (s.ref as any).ruleId === 'tf3')!;
    store.getState().updateSource(DEFAULT_METAPROFILE_ID, tf3.id, { color: getLayerColor('tf2') });
    const after = track().sources.find(s => s.id === tf3.id)!;
    expect(after.color).toBe(getLayerColor('tf2'));
    expect(after.autoColor).toBe(false);
  });
});

describe('picked colours (second re-check)', () => {
  it('a colour picked on an older (unflagged) source is kept, and a notebook cart edit too', async () => {
    const { createTestStore } = await import('../stores/__tests__/helpers');
    const { keepPickedSourceColors } = await import('../stores/compositeTracksSlice');
    const { DEFAULT_METAPROFILE_ID } = await import('../types/dataset');
    const store = createTestStore();
    store.setState({ datasets: [{ id: 'a', label: 'a', path: '/tmp/a.bam', color: '#111111', data_type: 'bam',
      available_layers: { nuc: true, tf2: true } } as any] });
    store.getState().seedDefaultMetaprofile();
    const track = () => store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const tf2 = () => track().sources.find(s => (s.ref as any).ruleId === 'tf2')!;
    // Older source: no flag, a custom colour; then the user picks the old hash colour.
    store.getState().setCompositeTracks([{ ...track(), sources: track().sources.map(s => s.id === tf2().id ? { ...s, color: '#123456', autoColor: undefined } : s) }]);
    store.getState().updateSource(DEFAULT_METAPROFILE_ID, tf2().id, { color: legacyHashLayerColor('tf2') });
    expect(tf2().color).toBe(legacyHashLayerColor('tf2'));
    // Notebook: get the cart, recolour a default-coloured source, set it back.
    store.getState().updateSource(DEFAULT_METAPROFILE_ID, tf2().id, { autoColor: true, color: getLayerColor('tf2') });
    const cart = store.getState().compositeTracks.map(c => c.id !== DEFAULT_METAPROFILE_ID ? c
      : { ...c, sources: c.sources.map(s => s.id === tf2().id ? { ...s, color: '#abcdef' } : s) });
    store.getState().setCompositeTracks(keepPickedSourceColors(cart, store.getState().compositeTracks));
    expect(tf2().color).toBe('#abcdef');
  });
});

describe('notebook carts (third re-check)', () => {
  it('a resubmitted cart keeps its pick; a replayed older default cart takes the current colours', async () => {
    const { createTestStore } = await import('../stores/__tests__/helpers');
    const { keepPickedSourceColors } = await import('../stores/compositeTracksSlice');
    const { DEFAULT_METAPROFILE_ID } = await import('../types/dataset');
    const store = createTestStore();
    const ds = (layers: string[]) => ({ id: 'a', label: 'a', path: '/tmp/a.bam', color: '#111111', data_type: 'bam',
      available_layers: Object.fromEntries([['nuc', true], ...layers.map(l => [l, true])]) }) as any;
    store.setState({ datasets: [ds(['tf3'])] });
    store.getState().seedDefaultMetaprofile();
    const track = () => store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const src = (k: string) => track().sources.find(s => (s.ref as any).ruleId === k)!;
    const saved = JSON.parse(JSON.stringify(store.getState().compositeTracks));
    const submit = (cart: any) => store.getState().setCompositeTracks(keepPickedSourceColors(cart, store.getState().compositeTracks));
    // Replay of an older default cart after the assignment moved.
    store.setState({ datasets: [ds(['tf2', 'tf3'])] });
    store.getState().seedDefaultMetaprofile();
    expect(src('tf3').color).toBe(getLayerColor('tf3'));
    submit(saved.map((c: any) => ({ ...c, label: c.label + ' x' })));
    expect(src('tf3').color).toBe(getLayerColor('tf3'));
    store.getState().seedDefaultMetaprofile(); // the older cart had no tf2 source
    // A pick, submitted twice from the same object.
    const picked = store.getState().compositeTracks.map(c => c.id !== DEFAULT_METAPROFILE_ID ? c
      : { ...c, sources: c.sources.map(s => (s.ref as any).ruleId === 'tf2' ? { ...s, color: '#123456' } : s) });
    submit(picked);
    expect(src('tf2').color).toBe('#123456');
    submit(picked);
    expect(src('tf2').color).toBe('#123456');
    submit(picked);
    expect(src('tf2').color).toBe('#123456');
  });
});
