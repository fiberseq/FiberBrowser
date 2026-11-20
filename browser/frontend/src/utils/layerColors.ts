/**
 * Deterministic color assignment for annotation layers.
 *
 * The fiberseq Molecular-annotation-spec is extensible — tools can define
 * arbitrary annotation types (e.g. 'pol2', 'ctcf', 'enhancer'). Known types
 * get curated colors; the loaded datasets' other types get distinct palette
 * colours, the same for the same set of layers (assignExtraLayerColors).
 */

const KNOWN_COLORS: Record<string, string> = {
  tf_native_replay:'#94a3b8', tf_sr_lattice:'#8b5cf6', tf_cr:'#0891b2', tf_recall:'#db2777',
  tf_cr_recalled:'#0d9488', tf_xcr:'#06b6d4', nuc_cr_split:'#14b8a6', cr_split_gap:'#f59e0b',
  nuc: '#16a34a',        // green (nucleosomes)
  tf: '#e040fb',         // fuchsia (TF footprints)
  // Consensus-refinement shadow layers are complete post-pass call sets. Unchanged
  // calls render in their baseline layer color; these colors identify named
  // rescue/harmonization actions within the shadow layer.
  nuc_sr: '#0f766e',     // teal (nucleosome refinement actions)
  tf_sr: '#7c3aed',      // violet (TF refinement actions)
  tf_consensus: '#0891b2', // cyan (within-dataset recurrent family)
  tf_cross_consensus: '#db2777', // magenta (cross-dataset family validation)
  msp: '#ea580c',        // internal legacy key; user-facing display is FIRE
  fire: '#ea580c',       // orange (FIRE regulatory elements)
  m6a: '#6b21a8',        // purple (m6A methylation)
  mod: '#6b21a8',        // purple (back-compat alias for m6a)
  m5c: '#dc2626',        // red (5mC methylation)
  ddda_mcg: '#dc2626',   // red (DddA-inferred methylated-CpG spans)
  ddda_mcg_hemi: '#f97316', // orange (strand-asymmetric paired-read mCG spans)
  deam: '#2dd4bf',       // bright teal (DAF deamination — brighter R shade matches the per-event paint)
  deam_opportunity: '#0d9488', // C/G sites at which DAF deamination was observable
  // Cross-strand DAF consensus coverage (MA deam+ / deam-): translucent, so
  // where both strands cover the molecule the two blend to purple.
  deam_ct: '#2563eb',    // blue (CT / C->T strand covered)
  deam_ga: '#e11d48',    // rose (GA / G->A strand covered)
  footprint: '#16a34a',  // green (legacy primary footprint layer)
};

/** Short, human-friendly labels for known layer names. Falls back to the raw name. */
const KNOWN_LABELS: Record<string, string> = {
  tf_native_replay:'Native · analysis baseline', tf_sr_lattice:'SR · boundaries', tf_cr:'CR · classes',
  tf_recall:'Recall · new calls', tf_cr_recalled:'CR · including recall', tf_xcr:'XCR · relationships',
  nuc_cr_split:'CR · split alternatives', cr_split_gap:'CR · split separators',
  nuc: 'Nuc',
  tf: 'TF',
  nuc_sr: 'Nuc refined',
  tf_sr: 'TF refined',
  tf_consensus: 'CR · within dataset',
  tf_cross_consensus: 'XCR · cross dataset',
  msp: 'Accessibility',
  fire: 'Accessibility',
  m6a: 'm6A',
  mod: 'Mod',          // legacy — only shown when a dataset explicitly exposes 'mod'
  m5c: '5mC',
  ddda_mcg: 'DddA mCG',
  ddda_mcg_hemi: 'DddA hemi-mCG',
  deam: 'Deam',
  deam_opportunity: 'C/G sites',
  deam_ct: 'CT strand',
  deam_ga: 'GA strand',
  footprint: 'FP',
};

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Default colours for layers without a curated colour (extra MA-tag layers such
 * as `tf2`, `nuc_a`, scan products). Twelve colours, each at least ~26 CIE76 ΔE
 * from the others and from every KNOWN_COLORS entry, and at least ~16 apart
 * under simulated deuteranopia and protanopia; lightness 38-71, so they read on
 * light and dark backgrounds. The first slots alternate hue families: a dataset
 * with a few extra layers gets clearly different colours.
 */
export const EXTRA_LAYER_PALETTE: readonly string[] = [
  '#5571be', // blue
  '#bbb11b', // mustard
  '#ae0998', // magenta
  '#6f662a', // olive brown
  '#e97067', // coral
  '#c297d8', // lilac
  '#9b3b4e', // wine
  '#f6995a', // apricot
  '#de77f8', // orchid
  '#ae7709', // ochre
  '#d897a4', // rose
  '#be5594', // raspberry
];

/** Container formats that `layer_type` can name instead of a layer. */
const FILE_LAYER_TYPES = new Set(['bam', 'bigbed', 'bb', 'cram']);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** A palette slot past the palette's length: the same colour a lightness step
 *  darker (odd cycles) or lighter (even cycles), never a near-identical hue. */
function extraLayerPaletteColor(slot: number): string {
  const n = EXTRA_LAYER_PALETTE.length;
  const base = EXTRA_LAYER_PALETTE[((slot % n) + n) % n];
  const cycle = Math.floor(Math.max(0, slot) / n);
  if (cycle === 0) return base;
  const step = Math.ceil(cycle / 2) * 0.28;
  const toward = cycle % 2 === 1 ? 0 : 255;
  const rgb = hexToRgb(base).map(c => Math.round(c + (toward - c) * Math.min(step, 0.7)));
  return `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

type ColorSourceDataset = {
  available_layers?: Partial<Record<string, boolean>>;
  layer_type?: string;
  derived_layers?: Record<string, { color?: string | null } | undefined> | null;
};

/**
 * The default colours of the loaded datasets' layers that have no curated
 * colour: palette slots in sorted key order, so the same set of layers always
 * gets the same colours (reload, session restore, any load order). A layer
 * with its own colour (a derived layer's `color`) keeps it, and a palette slot
 * holding one of those colours is skipped. Past the palette, slots cycle with
 * a lightness step (extraLayerPaletteColor).
 */
export function assignExtraLayerColors(datasets: readonly ColorSourceDataset[] | null | undefined): Map<string, string> {
  const keys = new Set<string>();
  const taken = new Set<string>();
  for (const d of datasets ?? []) {
    for (const [name, meta] of Object.entries(d.derived_layers ?? {})) {
      const color = meta?.color;
      if (typeof color === 'string' && color) taken.add(color.toLowerCase());
      else keys.add(name);
    }
    for (const [name, present] of Object.entries(d.available_layers ?? {})) {
      if (present) keys.add(name);
    }
    if (d.layer_type && !FILE_LAYER_TYPES.has(d.layer_type)) keys.add(d.layer_type);
  }
  for (const d of datasets ?? []) {
    for (const [name, meta] of Object.entries(d.derived_layers ?? {})) {
      if (typeof meta?.color === 'string' && meta.color) keys.delete(name);
    }
  }
  const out = new Map<string, string>();
  let slot = 0;
  for (const key of [...keys].filter(k => !KNOWN_COLORS[k]).sort()) {
    let color = extraLayerPaletteColor(slot);
    // A colour already in use stays with its owner; bounded so it always ends.
    for (let guard = 0; taken.has(color.toLowerCase()) && guard < 4 * EXTRA_LAYER_PALETTE.length; guard++) {
      slot += 1;
      color = extraLayerPaletteColor(slot);
    }
    out.set(key, color);
    taken.add(color.toLowerCase());
    slot += 1;
  }
  return out;
}

let extraLayerColors: Map<string, string> = new Map();

/** The loaded datasets whose extra layers get palette colours (set from the
 *  store whenever `datasets` changes, before anything renders with them). */
export function setLayerColorSource(datasets: readonly ColorSourceDataset[] | null | undefined): void {
  extraLayerColors = assignExtraLayerColors(datasets);
}

function nameHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return hash;
}

/** The colour 3.0.6 and earlier gave a layer without a curated colour (a hue
 *  from the name's hash; near-identical for names like tf2/tf3). Only used to
 *  recognise colours stamped into saved tracks by that rule. */
export function legacyHashLayerColor(name: string): string {
  return hslToHex(Math.abs(nameHash(name)) % 360, 0.7, 0.5);
}

let defaultPaletteColors: Set<string> | null = null;

/** Whether a colour is one of the extra-layer palette's (any lightness cycle up to 8 rounds): a default
 *  colour, as opposed to one a user typed. Only for telling a replayed cart's stale default from a pick. */
export function isExtraPaletteColor(color: string | null | undefined): boolean {
  if (!color) return false;
  if (!defaultPaletteColors) {
    defaultPaletteColors = new Set();
    for (let slot = 0; slot < EXTRA_LAYER_PALETTE.length * 8; slot++) defaultPaletteColors.add(extraLayerPaletteColor(slot));
  }
  return defaultPaletteColors.has(color.toLowerCase());
}

/** The curated layer keys (KNOWN_COLORS), for the headless renderer's port. */
export const CURATED_LAYER_KEYS: readonly string[] = Object.keys(KNOWN_COLORS);

/** Whether a layer has a curated colour. */
export function hasKnownLayerColor(name: string): boolean {
  return Boolean(KNOWN_COLORS[name]);
}

/**
 * Get a color for a layer name. Known layers get curated colors; the loaded
 * datasets' other layers get collision-free palette colours
 * (assignExtraLayerColors); a name outside them gets a palette colour picked by
 * its hash (deterministic). The read-track canvas appends an alpha byte
 * (`color + 'a6'`), so this must be #rrggbb: an hsl() string would become an
 * invalid paint value and draw in the previous color.
 */
export function getLayerColor(name: string): string {
  if (KNOWN_COLORS[name]) return KNOWN_COLORS[name];
  const assigned = extraLayerColors.get(name);
  if (assigned) return assigned;
  return EXTRA_LAYER_PALETTE[Math.abs(nameHash(name)) % EXTRA_LAYER_PALETTE.length];
}

/** The accessibility layer's keys: legacy/internal `msp` and `fire` (one user-facing layer). */
export function isAccessibilityLayer(name: string | null | undefined): boolean {
  return name === 'msp' || name === 'fire';
}

type AccessibilityDataset = { available_layers?: Partial<Record<string, boolean>>; layer_type?: string };

/**
 * Whether a dataset's accessibility (MSP) intervals are FIRE elements. The
 * backend decides this once per file (services/fire_quality.py
 * file_fire_status) and reports it as `available_layers.fire` (a BAM whose
 * MSP scores are not FIRE scores reports `msp` instead); a FIRE bigBed has
 * layer_type `fire`. Label only: layer ids and filters are unchanged.
 */
export function datasetHasFireScores(dataset: AccessibilityDataset | null | undefined): boolean {
  return Boolean(dataset?.available_layers?.fire) || dataset?.layer_type === 'fire';
}

function datasetHasAccessibility(dataset: AccessibilityDataset): boolean {
  return datasetHasFireScores(dataset) || Boolean(dataset.available_layers?.msp) || dataset.layer_type === 'msp';
}

/** Among datasets with an accessibility layer: none FIRE, all FIRE, or a mix. */
export type AccessibilityMode = 'accessibility' | 'fire' | 'mixed';

export function accessibilityMode(datasets: readonly AccessibilityDataset[] | null | undefined): AccessibilityMode {
  const withLayer = (datasets ?? []).filter(datasetHasAccessibility);
  const fire = withLayer.filter(datasetHasFireScores).length;
  if (fire === 0) return 'accessibility';
  return fire === withLayer.length ? 'fire' : 'mixed';
}

/**
 * The accessibility layer's name: "FIRE" when every dataset that has the layer
 * carries FIRE scores ("FIRE elements" with `long`), "Accessibility" when none
 * does, and "Accessibility / FIRE" for a mix (a control that acts on all of them).
 */
export function accessibilityLabel(mode: AccessibilityMode, { long = false }: { long?: boolean } = {}): string {
  if (mode === 'fire') return long ? 'FIRE elements' : 'FIRE';
  if (mode === 'mixed') return 'Accessibility / FIRE';
  return 'Accessibility';
}

// The loaded datasets' mode, for labels drawn without the datasets at hand
// (set by the browser store whenever its datasets change).
let sessionAccessibilityMode: AccessibilityMode = 'accessibility';
export function setAccessibilityLabelSource(datasets: readonly AccessibilityDataset[] | null | undefined): void {
  sessionAccessibilityMode = accessibilityMode(datasets);
}
export function getSessionAccessibilityMode(): AccessibilityMode {
  return sessionAccessibilityMode;
}

/**
 * Get a display label for a layer name. The accessibility layer (msp/fire)
 * is named for `datasets` when given (one dataset: that dataset's own name for
 * it), else for the loaded datasets.
 */
export function getLayerLabel(name: string, datasets?: readonly AccessibilityDataset[] | null): string {
  if (isAccessibilityLayer(name)) {
    return accessibilityLabel(datasets ? accessibilityMode(datasets) : sessionAccessibilityMode);
  }
  return KNOWN_LABELS[name] ?? name;
}

/** One dataset's accessibility layer, for its hover text: FIRE elements, plain MSPs, or nothing without the layer. */
export function datasetAccessibilityNote(dataset: AccessibilityDataset | null | undefined): string | null {
  if (!dataset || !datasetHasAccessibility(dataset)) return null;
  return datasetHasFireScores(dataset)
    ? 'Accessibility layer: FIRE (FIRE elements; FIRE scores found)'
    : 'Accessibility layer: Accessibility (MSPs; no FIRE scores)';
}

/** The accessibility layer's name in one dataset: "FIRE" for a FIRE file, else "Accessibility". */
export function getDatasetLayerLabel(name: string, dataset: AccessibilityDataset | null | undefined): string {
  if (isAccessibilityLayer(name)) return datasetHasFireScores(dataset) ? 'FIRE' : 'Accessibility';
  return KNOWN_LABELS[name] ?? name;
}

/** Tooltip for the accessibility layer, saying which datasets carry FIRE scores. */
export function fireLayerTitle(datasets?: readonly AccessibilityDataset[] | null): string {
  const mode = datasets ? accessibilityMode(datasets) : sessionAccessibilityMode;
  if (mode === 'fire') return 'FIRE elements: accessible stretches scored by fibertools FIRE (aq-filtered by the FIRE quality filter)';
  if (mode === 'mixed') return 'Accessibility intervals; in datasets with FIRE scores these are FIRE elements (aq-filtered by the FIRE quality filter)';
  return 'Accessibility intervals (MSPs)';
}

/** Get a longer title (tooltip) for a layer name. */
export function getLayerTitle(name: string): string {
  const titles: Record<string, string> = {
    tf_native_replay:'Analysis input: fixed-MSP multi-interval re-call when enabled, otherwise existing source calls. Original BAM TFs and nucleosomes stay unchanged.',
    tf_sr_lattice:'Conservative cross-strand boundary normalization. Gray unchanged; violet moved. No new calls in this layer.',
    tf_cr:'Native-lattice population classes with configurable molecular edge variation. Fill shows actual jointly selected geometry.',
    tf_recall:'Only genuinely new, strict geometry-validated calls. This is separate from boundary normalization and grouping.',
    tf_cr_recalled:'The same frozen CR catalog after adding strict recalled calls; no discovery refit.',
    tf_xcr:'Atomic cross-dataset links. Both native intervals stay intact; outlines mark full-model comparability, uncertainty or disagreement.',
    nuc_cr_split:'Alternative internal protected pieces with CR support. Original outer nucleosome calls remain available; identities of remainder pieces are not inferred.',
    cr_split_gap:'Native-modification-supported accessible separators inside proposed split nucleosomes.',
    nuc: 'Nucleosome footprints',
    tf: 'HMM-called TF footprints',
    nuc_sr: 'Per-molecule nucleosome refinement. Baseline calls remain available; named rescue and edge-harmonization actions are highlighted.',
    tf_sr: 'Per-molecule refined/rescued TF calls. This adjusted molecular call set is independent of any recurrent consensus-state assignment.',
    tf_consensus: 'Within-dataset consensus recall (CR). Family confidence is producer-specific and can be unavailable; the family-colored outline marks that assay’s fitted boundary.',
    tf_cross_consensus: 'Cross-dataset consensus recall (XCR). Molecules are re-scored on their own assay lattice; family-colored outlines retain assay-specific edges with producer-declared score semantics; uncalibrated fq is unavailable.',
    msp: 'FIRE accessibility intervals (legacy as/al layer; aq-filtered when aq is present)',
    fire: 'FIRE accessibility intervals (aq-filtered when aq is present; raw accessibility when aq is unavailable)',
    m6a: 'm6A methylation (from BAM MM/ML tags or m6a extract BED)',
    mod: 'Methylation/modification marks (legacy — promoted to m6a where possible)',
    m5c: '5mC methylation',
    ddda_mcg: 'FiberHMM per-molecule methylated-CpG spans inferred from DddA deamination and encoded in MA tags',
    deam_ct: 'Cross-strand DAF consensus read: the span its CT (C->T) strand covered (MA deam+). Overlap with GA strand = both strands.',
    deam_ga: 'Cross-strand DAF consensus read: the span its GA (G->A) strand covered (MA deam-). Overlap with CT strand = both strands.',
    ddda_mcg_hemi: 'FiberHMM paired-read methylated-CpG spans supported on one strand only and encoded in MA tags',
    deam: 'DAF deamination events',
    deam_opportunity: 'Possible DAF deamination sites: observable C sites are short teal top ticks and observable G sites are short amber bottom ticks.',
    footprint: 'Footprints (legacy)',
  };
  return titles[name] ?? `Custom annotation layer: ${name}`;
}

/** Context-aware label for the ns/nl layer. When any loaded dataset has
 *  an explicit `tf` layer (v3 caller output), the nucleosome calls really
 *  are nucleosomes — call them "Nuc". Otherwise ns/nl is a generic footprint
 *  mix (legacy caller with no TF split), so call them "FP".
 *
 *  Analogous to the FIRE naming: the data changes semantic meaning based on
 *  what sibling tags are present.
 */
export function getNucDisplayLabel(
  datasets: Array<{ available_layers?: Partial<Record<string, boolean>> }>
): string {
  const hasTf = datasets.some(d => d.available_layers?.tf);
  return hasTf ? 'Nuc' : 'FP';
}

/** Title for the nuc/FP toggle, context-aware. */
export function getNucDisplayTitle(
  datasets: Array<{ available_layers?: Partial<Record<string, boolean>> }>
): string {
  const hasTf = datasets.some(d => d.available_layers?.tf);
  return hasTf
    ? 'Nucleosomes (explicit v3 calls)'
    : 'Footprints (ns/nl — mixed nucleosome + TF sizes)';
}

/** Canonical, deduplicated layer list shared by every UI component that
 *  exposes "data layer" toggles or selectors (View/Data Layers toggles,
 *  LayerSelector chips, cluster/sort dropdowns).
 *
 *  Rules mirror the user's mental model:
 *    - nuc / footprint collapse to a single entry (key = 'nuc' when a nuc
 *      layer exists, else 'footprint'). Label is context-aware ("Nuc" when
 *      an explicit TF layer is present, else "FP").
 *    - FIRE is surfaced as the user-facing accessibility layer. Older files
 *      may still store those intervals under the internal `msp` key; the UI
 *      never exposes MSP as a separate layer.
 *    - tf appears only when an explicit TF layer exists.
 *    - mod / m5c stay as their own entries when present.
 *    - arbitrary custom layers (fp_v2, pol2, ...) pass through.
 *
 *  Returns `{ key, label, title }[]` where `key` is the canonical layer name
 *  used in store state (e.g. enabledModTypes[key]) and `label` is what the
 *  UI should display.
 */
export interface LayerEntry {
  key: string;
  label: string;
  title: string;
  kind?: 'standard' | 'tf-inference' | 'strand-rescue' | 'derived' | 'custom';
  sourceLayer?: string;
  color?: string | null;
}

type LayerDataset = {
  available_layers?: Partial<Record<string, boolean>>;
  layer_type?: string;
  derived_layers?: Record<string, {
    id?: string;
    label?: string;
    source_layer?: string;
    sourceLayer?: string;
    kind?: string;
    color?: string | null;
  }>;
};

function getDerivedLayerMap(datasets: LayerDataset[]): Map<string, NonNullable<LayerDataset['derived_layers']>[string]> {
  const out = new Map<string, NonNullable<LayerDataset['derived_layers']>[string]>();
  for (const d of datasets) {
    if (!d.derived_layers) continue;
    for (const [id, meta] of Object.entries(d.derived_layers)) {
      out.set(id, meta ?? {});
    }
  }
  return out;
}

export function isDerivedLayerName(datasets: LayerDataset[], name: string): boolean {
  return getDerivedLayerMap(datasets).has(name);
}

export function getCanonicalLayerEntries(
  datasets: Array<{ available_layers?: Partial<Record<string, boolean>>; derived_layers?: LayerDataset['derived_layers'] }>
): LayerEntry[] {
  const groups = getCanonicalLayerGroups(datasets);
  return [...groups.standard, ...groups.tfInference, ...groups.strandRescue, ...groups.derived];
}

export function getCanonicalLayerGroups(
  datasets: Array<{ available_layers?: Partial<Record<string, boolean>>; derived_layers?: LayerDataset['derived_layers'] }>
): { standard: LayerEntry[]; tfInference: LayerEntry[]; strandRescue: LayerEntry[]; derived: LayerEntry[] } {
  const has = (name: string) => datasets.some(d => d.available_layers?.[name]);
  const hasTf = has('tf');
  const derivedMap = getDerivedLayerMap(datasets);

  const entries: LayerEntry[] = [];
  const seen = new Set<string>();

  const push = (key: string, label: string, title: string, kind: LayerEntry['kind'] = 'standard', color?: string | null, sourceLayer?: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, label, title, kind, color, sourceLayer });
  };

  // Nuc / FP — one entry, context-aware label. Key is 'nuc' when the layer
  // exists (ViewSection aliases footprint onto it), else 'footprint'.
  if (has('nuc')) {
    push('nuc', hasTf ? 'Nuc' : 'FP', getNucDisplayTitle(datasets));
  } else if (has('footprint')) {
    push('footprint', hasTf ? 'Nuc' : 'FP', getNucDisplayTitle(datasets));
  }

  // FIRE — user-facing alias for either explicit FIRE or legacy MSP/as/al.
  if (has('msp') || has('fire')) {
    push('fire', getLayerLabel('fire', datasets), fireLayerTitle(datasets));
  }

  // TF — only when an explicit TF layer exists.
  if (hasTf) {
    push('tf', 'TF', getLayerTitle('tf'));
  }
  // Modifications — m6a (MM/ML or _m6a.bb), 5mC (_m5c.bb), DAF deam (_deam.bb).
  // Legacy 'mod' key is treated as m6a unless an explicit m6a entry already
  // exists (avoids a duplicate toggle in mixed-vintage datasets).
  if (has('m6a') || has('mod')) {
    push('m6a', 'm6A', getLayerTitle('m6a'));
  }
  if (has('m5c')) push('m5c', '5mC', getLayerTitle('m5c'));
  if (has('deam')) push('deam', 'Deam', getLayerTitle('deam'));

  // TF inference products are additions to the baseline calls, never aliases
  // for them. Keep TF refined and TF consensus together in their own visible
  // group so neither can be mistaken for the producer's ordinary TF layer.
  const tfInference: LayerEntry[] = [];
  const pushTfInference = (key: string) => {
    if (!has(key) || seen.has(key)) return;
    seen.add(key);
    tfInference.push({
      key,
      label: getLayerLabel(key),
      title: getLayerTitle(key),
      kind: 'tf-inference',
      color: getLayerColor(key),
    });
  };
  for(const name of ['tf_native_replay','tf_sr_lattice','tf_cr','tf_rc','tf_recall','tf_cr_recalled','tf_xcr','nuc_cr_split','cr_split_gap'])pushTfInference(name);
  pushTfInference('tf_sr');
  pushTfInference('tf_consensus');
  pushTfInference('tf_cross_consensus');

  // Other molecular-refinement shadow layers remain a coordinated first-class
  // group. Possible C/G sites are diagnostic-only and intentionally hidden.
  const strandRescue: LayerEntry[] = [];
  const pushStrandRescue = (key: string) => {
    if (!has(key) || seen.has(key)) return;
    seen.add(key);
    strandRescue.push({
      key,
      label: getLayerLabel(key),
      title: getLayerTitle(key),
      kind: 'strand-rescue',
      color: getLayerColor(key),
    });
  };
  pushStrandRescue('nuc_sr');

  // Arbitrary custom layers (anything else in available_layers).
  const handled = new Set([
    'nuc', 'footprint', 'msp', 'fire', 'tf', 'nuc_sr', 'tf_sr', 'tf_consensus', 'tf_cross_consensus',
    'mod', 'm6a', 'm5c', 'deam', 'deam_opportunity', 'ddda_mcg', 'ddda_mcg_hemi',
  ]);
  if (has('ddda_mcg')) {
    push('ddda_mcg', getLayerLabel('ddda_mcg'), getLayerTitle('ddda_mcg'));
  }
  if (has('ddda_mcg_hemi')) {
    push('ddda_mcg_hemi', getLayerLabel('ddda_mcg_hemi'), getLayerTitle('ddda_mcg_hemi'));
  }
  for (const d of datasets) {
    if (!d.available_layers) continue;
    for (const [name, present] of Object.entries(d.available_layers)) {
      if (!present || handled.has(name) || seen.has(name) || derivedMap.has(name)) continue;
      push(name, getLayerLabel(name), getLayerTitle(name), 'custom');
    }
  }

  const derived: LayerEntry[] = [];
  for (const [key, meta] of derivedMap.entries()) {
    // Registered inference layers also carry derived-layer metadata. Keep
    // their canonical entry only, rather than presenting two controls for
    // the same layer key (and two identical React keys) in each selector.
    if (!has(key) || seen.has(key)) continue;
    seen.add(key);
    const label = meta.label || key;
    const sourceLayer = meta.source_layer || meta.sourceLayer || '';
    derived.push({
      key,
      label,
      sourceLayer,
      color: meta.color,
      kind: 'derived',
      title: sourceLayer
        ? `Derived layer: ${label} (from ${getLayerLabel(sourceLayer)})`
        : `Derived layer: ${label}`,
    });
  }

  return { standard: entries, tfInference, strandRescue, derived };
}

/** Canonical sources for metaprofile tracks. FIRE maps to explicit FIRE data
 *  or the legacy internal MSP/as-al layer, with aq filtering controlled by
 *  quality filters when aq is present. */
export function getMetaprofileSourceEntries(
  datasets: Array<{ available_layers?: Partial<Record<string, boolean>>; layer_type?: string; derived_layers?: LayerDataset['derived_layers'] }>
): LayerEntry[] {
  const has = (name: string) => datasets.some(d =>
    d.available_layers?.[name] ||
    d.layer_type === name ||
    (name === 'm6a' && (d.available_layers?.mod || d.layer_type === 'mod')) ||
    (name === 'fire' && (d.available_layers?.msp || d.layer_type === 'msp'))
  );
  const hasTf = has('tf');
  const derivedMap = getDerivedLayerMap(datasets);

  const entries: LayerEntry[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, title: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, label, title });
  };

  if (has('nuc')) {
    push('nuc', hasTf ? 'Nuc' : 'FP', getNucDisplayTitle(datasets));
  } else if (has('footprint')) {
    push('footprint', hasTf ? 'Nuc' : 'FP', getNucDisplayTitle(datasets));
  }
  if (hasTf) push('tf', 'TF', getLayerTitle('tf'));
  if (has('fire')) {
    push('fire', getLayerLabel('fire', datasets), `${accessibilityMode(datasets) === 'fire' ? 'FIRE element' : 'Accessibility'} density profile. Cached by default; can be disabled in Layer Cache for performance.`);
  }
  if (has('deam')) {
    push('deam', 'Deam', 'DAF deamination profile. Cached by default; can be disabled in Layer Cache for performance.');
  }
  if (has('m6a')) push('m6a', 'm6A', getLayerTitle('m6a'));
  if (has('m5c')) push('m5c', '5mC', getLayerTitle('m5c'));

  const handled = new Set([
    'nuc', 'footprint', 'tf', 'msp', 'fire', 'deam', 'mod', 'm6a', 'm5c',
    'nuc_sr', 'tf_sr', 'tf_consensus', 'tf_cross_consensus', 'deam_opportunity',
  ]);
  // layer_type can be the container format ("bam", "bigbed"), not a layer.
  const FILE_TYPES = new Set(['bam', 'bigbed', 'bb', 'cram']);
  for (const d of datasets) {
    if (d.layer_type && !handled.has(d.layer_type) && !FILE_TYPES.has(d.layer_type)) {
      push(d.layer_type, getLayerLabel(d.layer_type), getLayerTitle(d.layer_type));
    }
    if (!d.available_layers) continue;
    for (const [name, present] of Object.entries(d.available_layers)) {
      if (!present || handled.has(name) || derivedMap.has(name)) continue;
      push(name, getLayerLabel(name), getLayerTitle(name));
    }
  }

  for (const [key, meta] of derivedMap.entries()) {
    if (!has(key)) continue;
    const label = meta.label || key;
    const sourceLayer = meta.source_layer || meta.sourceLayer || '';
    push(
      key,
      label,
      sourceLayer
        ? `Derived layer: ${label} (from ${getLayerLabel(sourceLayer)})`
        : `Derived layer: ${label}`
    );
  }

  return entries;
}
