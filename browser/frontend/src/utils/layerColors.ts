/**
 * Deterministic color assignment for annotation layers.
 *
 * The fiberseq Molecular-annotation-spec is extensible — tools can define
 * arbitrary annotation types (e.g. 'pol2', 'ctcf', 'enhancer'). Known types
 * get curated colors; unknown types get a deterministic hash-based color
 * so repeated encounters of the same layer name always produce the same color.
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
  // fiberhmm-scan per-molecule groups (MA groups of annotated BAMs, or the scan overlay of tables-mode scans)
  fpcls: '#7c3aed',      // violet, as footprint classes
  nfrvar: '#0f766e',     // teal (NFR variant membership)
  nfrmol: '#64748b',     // slate (NFR molecule scalars: whole-molecule interval)
  nucsz: '#16a34a',      // green (nucleosome size classes)
  nucseg: '#15803d',     // dark green (array segments)
  nucmol: '#64748b',     // slate (nucleosome molecule scalars)
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
  fpcls: 'Scan · classes',
  nfrvar: 'Scan · NFR variants',
  nfrmol: 'Scan · NFR scalars',
  nucsz: 'Scan · nuc sizes',
  nucseg: 'Scan · arrays',
  nucmol: 'Scan · nuc scalars',
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
 * Get a color for a layer name. Known layers get curated colors; unknowns get
 * a deterministic six-digit hex color from the name. The read-track canvas
 * appends an alpha byte (`color + 'a6'`), so this must be #rrggbb: an hsl()
 * string would become an invalid paint value and draw in the previous color.
 */
export function getLayerColor(name: string): string {
  if (KNOWN_COLORS[name]) return KNOWN_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return hslToHex(Math.abs(hash) % 360, 0.7, 0.5);
}

/** Get a display label for a layer name. */
export function getLayerLabel(name: string): string {
  return KNOWN_LABELS[name] ?? name;
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
    push('fire', getLayerLabel('fire'), getLayerTitle('fire'));
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
    push('fire', getLayerLabel('fire'), 'FIRE accessibility density profile. Cached by default; can be disabled in Layer Cache for performance.');
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
