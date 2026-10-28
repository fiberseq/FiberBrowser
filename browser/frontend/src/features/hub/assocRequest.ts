/**
 * The association builder's choices and request (DESIGN §7.1): which hub sets can be A or B in each mode, the
 * responses of M2, the groups and scopes, and the four example questions of DESIGN §7.9 as presets.
 */
import type { BrowserState } from '../../stores/browserStore';
import type { AssocMode, AssocOptions, AssocRequest, AssocSetRef } from './assocApi';
import type { ScanInfo } from './api';
import type { AnchorSet, FeatureHit, FeatureSet } from './types';

export interface SetChoice {
  key: string;
  label: string;
  typeId: string;
  kind: AssocSetRef['kind'];
  /** It has per-molecule states (M1, M2 with a scan measure). */
  hasStates: boolean;
  /** Why it can't serve where it is greyed out. */
  why?: string;
  ref: AssocSetRef;
}

export const NUC_MARKS: Array<{ typeId: string; label: string }> = [
  { typeId: 'nuc.seg.regular', label: 'Regular nucleosome arrays' },
  { typeId: 'nuc.seg.disordered', label: 'Disordered arrays' },
  { typeId: 'nuc.seg.undetermined', label: 'Undetermined segments' },
  { typeId: 'nuc.event.undersized', label: 'Undersized runs' },
  { typeId: 'nuc.event.missing', label: 'Missing nucleosomes' },
];

export const RESPONSES: Array<{ key: string; label: string; module?: 'nuc' | 'nfr'; column?: string }> = [
  { key: 'phasing', label: 'Nucleosome phasing around the anchor (R − null; anchor and molecule frames)' },
  { key: 'nuc:nrl', label: 'Nucleosome repeat length per molecule (nuc scan)', module: 'nuc', column: 'nrl' },
  { key: 'nuc:regularity', label: 'Array regularity per molecule (nuc scan)', module: 'nuc', column: 'regularity' },
  { key: 'nuc:gap_cv', label: 'Linker variability (gap CV) per molecule (nuc scan)', module: 'nuc', column: 'gap_cv' },
  { key: 'nfr:openness', label: 'Openness per molecule (nfr scan)', module: 'nfr', column: 'openness' },
];

const isScanSet = (set: FeatureSet) => set.setId.startsWith('hub:');

function inlineHit(h: FeatureHit) {
  return {
    hitId: h.hitId, chrom: h.chrom, start: h.start, end: h.end, anchor: h.anchor, ...(h.strand ? { strand: h.strand } : {}),
    ...(h.label ? { label: h.label } : {}), ...(h.frame ? { frame: { kind: h.frame.kind } } : {}),
    ...(h.target ? { target: h.target } : {}),
    ...(h.values ? { values: Object.fromEntries(Object.entries(h.values).map(([k, roles]) =>
      [k, Object.fromEntries(Object.entries(roles).map(([r, v]) => [r, { v: v.v }]))])) } : {}),
    ...(h.legacyRefs?.length ? { legacyRefs: h.legacyRefs.map(r => ({ ...r } as unknown as Record<string, unknown>)) } : {}),
  };
}

export function setLabel(set: FeatureSet): string {
  const src = (set as { scan?: { label: string } }).scan?.label ?? set.provenance.module;
  return `${set.type.plural} · ${src}`;
}

/** Where a browser set was computed: the view it is listed in, or its recorded regions (`chrom:start-end`). */
function coverageOf(set: FeatureSet, view?: { chrom: string; start: number; end: number }): Array<[string, number, number]> | undefined {
  // The hub lists a browser set's hits in view only, so its coverage is the view (within its recorded regions).
  if (!view) return undefined;
  const v: [string, number, number] = [view.chrom, Math.floor(view.start), Math.ceil(view.end)];
  if (set.coverage.territory === 'regions' && set.coverage.ref) {
    const m = /^(.+):(\d+)-(\d+)$/.exec(set.coverage.ref);
    if (m) {
      const lo = Math.max(v[1], Number(m[2])), hi = Math.min(v[2], Number(m[3]));
      return m[1] === v[0] && hi > lo ? [[v[0], lo, hi]] : [];
    }
  }
  return [v];
}

/** Placed anchors only: an assembly anchor that didn't lift has no position on this genome. */
export const placedAnchors = (a: AnchorSet) => a.anchors.filter(p => !p.frame || p.frame.kind !== 'source' || p.source);

/** Every hub set as an A/B choice: scan sets by id (the backend reads the scan), browser sets with their hits in view
 * and where they were computed (their absence means absence only there). */
export function setChoices(sets: FeatureSet[], anchors: AnchorSet[], view?: { chrom: string; start: number; end: number }): SetChoice[] {
  const out: SetChoice[] = [];
  for (const set of sets) {
    const scan = isScanSet(set);
    const states = set.type.provides.includes('state') && scan;
    const sv = set.typeId === 'var.sv';
    const hits = set.source.kind === 'inline' ? set.source.hits : [];
    out.push({
      key: set.setId, label: setLabel(set), typeId: set.typeId, kind: scan ? 'scan' : 'inline', hasStates: states || sv,
      why: states || sv ? undefined : 'no per-molecule states in the hub (scan sets and SVs have them)',
      ref: scan ? { kind: 'scan', setId: set.setId, typeId: set.typeId, label: set.type.plural }
        : { kind: 'inline', setId: set.setId, typeId: set.typeId, label: set.type.plural, hits: hits.map(inlineHit),
          ...(coverageOf(set, view) ? { coverage: coverageOf(set, view) } : {}) },
    });
  }
  for (const a of anchors) {
    out.push({ key: `anchors:${a.id}`, label: `Anchor set · ${a.label}`, typeId: 'anchors', kind: 'anchors', hasStates: false,
      why: 'an anchor set has positions only', ref: { kind: 'anchors', label: a.label,
        anchors: placedAnchors(a).map(p => ({ chrom: p.chrom, pos: p.pos,
          ...(p.start != null ? { start: p.start } : {}), ...(p.end != null ? { end: p.end } : {}), ...(p.strand ? { strand: p.strand } : {}),
          ...(p.label ? { label: p.label } : {}), ...(p.hitId ? { hitId: p.hitId } : {}) })) } });
  }
  return out;
}

/** Nucleosome mark types (M3's A) when an open table-mode scan has the nuc module. */
export function markChoices(scans: ScanInfo[]): SetChoice[] {
  const has = scans.some(s => s.modules.nuc && !s.annotate);
  return NUC_MARKS.map(m => ({ key: `marks:${m.typeId}`, label: m.label, typeId: m.typeId, kind: 'marks', hasStates: false,
    why: has ? undefined : 'needs a nucleosome scan in table mode (Scan… with nuc)', ref: { kind: 'marks', typeId: m.typeId, label: m.label } }));
}

export const TF_CHOICE: SetChoice = { key: 'tf', label: 'TF footprint centres (the nucleosome scan\'s calls)', typeId: 'tf', kind: 'tf', hasStates: false,
  ref: { kind: 'tf', label: 'TF footprints' } };

export interface AssocDraft {
  mode: AssocMode;
  aKey: string;
  bKey: string;
  response: string;
  group: 'none' | 'dataset' | 'haplotype' | 'cluster';
  acceptPostSelection: boolean;
  clusterFlank: number;
  scope: 'view' | 'bed' | 'anchors' | 'scan';
  bed: string;
  anchorSetId: string;
  anchorFlank: number;
  /** null: every loaded dataset. */
  datasets: string[] | null;
  options: AssocOptions;
  question?: string;
}

export const DEFAULT_DRAFT: AssocDraft = {
  mode: 'M1', aKey: '', bKey: '', response: 'phasing', group: 'none', acceptPostSelection: false, clusterFlank: 1000,
  scope: 'view', bed: '', anchorSetId: '', anchorFlank: 1000, datasets: null,
  options: { maxDistance: 5000, test: 'adjusted', density: 'rho_read', nPerm: 1000, nBoot: 1000, seed: 0, frames: ['anchor', 'molecule'], metric: 'R_minus_null' },
};

/** A-choices and B-choices of a mode. */
export function choicesFor(mode: AssocMode, all: SetChoice[], marks: SetChoice[]): { a: SetChoice[]; b: SetChoice[] } {
  switch (mode) {
    case 'M1': return { a: all.filter(c => c.kind !== 'anchors'), b: all.filter(c => c.kind !== 'anchors') };
    case 'M2': return { a: all, b: [] };
    case 'M3': return { a: marks, b: [TF_CHOICE] };
    default: return { a: all, b: all };
  }
}

/** Cluster labels of the shown cluster run, per dataset (C0, C1, …), and the regions it clustered. Reads outside the
 * run (negative labels) get none; a read two panels of one dataset label differently gets none either. */
export function clusterGroup(s: BrowserState): { labels: Record<string, Record<string, string>>; regions: Array<[string, number, number]> } {
  const found: Record<string, Record<string, Set<string>>> = {};
  for (const [key, byRead] of Object.entries(s.clusterAssignments ?? {})) {
    const panel = s.panels.find(p => (p.stateKey ?? p.datasetId) === key);
    const ds = panel?.datasetId ?? key;
    const out = found[ds] ?? (found[ds] = {});
    for (const [read, c] of Object.entries(byRead)) {
      if (!Number.isFinite(c) || c < 0) continue;
      (out[read] ?? (out[read] = new Set())).add(`C${c}`);
    }
  }
  const labels: Record<string, Record<string, string>> = {};
  for (const [ds, byRead] of Object.entries(found)) {
    labels[ds] = Object.fromEntries(Object.entries(byRead).filter(([, v]) => v.size === 1).map(([r, v]) => [r, [...v][0]]));
  }
  const regions = (s.clusterPeakRegions ?? []).filter(r => !r.genome).map(r => [r.chrom ?? s.chrom, r.start, r.end] as [string, number, number]);
  return { labels, regions };
}

export function hasClusters(s: BrowserState): boolean {
  return Object.values(s.clusterAssignments ?? {}).some(m => Object.keys(m).length > 0);
}

/** The request of a draft, or why it can't run. */
export function buildRequest(draft: AssocDraft, ctx: { all: SetChoice[]; marks: SetChoice[]; state: BrowserState; anchors: AnchorSet[] }):
  { request: AssocRequest } | { error: string } {
  const { a: aList, b: bList } = choicesFor(draft.mode, ctx.all, ctx.marks);
  const a = aList.find(c => c.key === draft.aKey);
  if (!a) return { error: 'Choose feature A' };
  if (draft.mode === 'M3' && a.why) return { error: `${a.label}: ${a.why}` };
  const b = draft.mode === 'M3' ? TF_CHOICE : bList.find(c => c.key === draft.bKey);
  if ((draft.mode === 'M1' || draft.mode === 'M4') && !b) return { error: 'Choose feature B' };
  if (draft.mode === 'M1') {
    if (!a.hasStates) return { error: `A (${a.label}): ${a.why}` };
    if (!b!.hasStates) return { error: `B (${b!.label}): ${b!.why}` };
  }
  const resp = RESPONSES.find(r => r.key === draft.response);
  if (draft.mode === 'M2' && resp?.module && !a.hasStates) return { error: `A (${a.label}): a per-molecule measure needs A's states; ${a.why}` };
  const s = ctx.state;
  let scope: AssocRequest['scope'] = { kind: 'view', chrom: s.chrom, start: Math.floor(s.start), end: Math.ceil(s.end) };
  if (draft.scope === 'bed') {
    if (!draft.bed.trim()) return { error: 'Type the BED file\'s path' };
    scope = { kind: 'bed', bed: draft.bed.trim() };
  } else if (draft.scope === 'anchors') {
    const set = ctx.anchors.find(x => x.id === draft.anchorSetId);
    if (!set) return { error: 'Choose an anchor set for the scope' };
    const placed = placedAnchors(set);
    if (!placed.length) return { error: 'None of the anchor set\'s anchors is placed on this genome' };
    scope = { kind: 'anchors', anchorSetId: set.id, flank: draft.anchorFlank, anchors: placed.map(p => [p.chrom, p.pos] as [string, number]) };
  } else if (draft.scope === 'scan') {
    scope = { kind: 'scan' };
  }
  let group: AssocRequest['group'] | undefined;
  if (draft.group === 'cluster') {
    if (!hasClusters(s)) return { error: 'No cluster run is shown: cluster the reads first, or group by dataset or haplotype' };
    const cg = clusterGroup(s);
    group = { kind: 'cluster', labels: cg.labels, clusterRegions: cg.regions, flank: draft.clusterFlank, acceptPostSelection: draft.acceptPostSelection };
  } else if (draft.group !== 'none') {
    group = { kind: draft.group };
  }
  const request: AssocRequest = {
    mode: draft.mode, a: a.ref, ...(b && draft.mode !== 'M2' ? { b: b.ref } : {}),
    ...(draft.mode === 'M2' ? { response: resp?.module ? { kind: 'scalar', module: resp.module, column: resp.column! } : { kind: 'phasing' } } : {}),
    ...(group ? { group } : {}), scope, ...(draft.datasets ? { datasets: draft.datasets } : {}),
    options: draft.options, ...(draft.question ? { question: draft.question } : {}),
  };
  return { request };
}

export interface Preset {
  id: string;
  question: string;
  /** What the data must have; '' when it is all there. */
  missing: string;
  draft: Partial<AssocDraft>;
  note?: string;
}

/** The four example questions of DESIGN §7.9, filled from what the hub has. */
export function presets(all: SetChoice[], marks: SetChoice[], nativeDatasets: number): Preset[] {
  const scanOf = (type: string) => all.find(c => c.typeId === type && c.kind === 'scan');
  const anyOf = (type: string) => scanOf(type) ?? all.find(c => c.typeId === type);
  const group: AssocDraft['group'] = nativeDatasets >= 2 ? 'dataset' : 'haplotype';
  const groupNote = nativeDatasets >= 2 ? 'groups: datasets (interaction)' : 'groups: haplotypes (one dataset loaded; unphased molecules apart)';
  const regular = marks.find(m => m.typeId === 'nuc.seg.regular');
  const nfr = scanOf('nfr.region');
  const sv = anyOf('var.sv');
  const fp = scanOf('fp.class');
  const peaks = scanOf('peaks.peak') ?? anyOf('peaks.peak');
  return [
    { id: 'q1', question: 'Are regular nucleosome arrays depleted of TF footprints?',
      missing: regular && !regular.why ? '' : 'a nucleosome scan in table mode (Scan… with nuc)',
      draft: { mode: 'M3', aKey: regular?.key ?? '', bKey: 'tf', group, question: 'q1' }, note: `M3 · rate ratio per group and the ratio of ratios · ${groupNote}` },
    { id: 'q2', question: 'Do NFRs phase their flanks?', missing: nfr ? '' : 'NFR regions from a scan (Scan… with nfr)',
      draft: { mode: 'M2', aKey: nfr?.key ?? '', response: 'phasing', group, question: 'q2' },
      note: `M2 · Δ site per bin, both frames · NFRs in the scope (an enhancer BED as the scope restricts them) · ${groupNote}` },
    { id: 'q3', question: 'Is a footprint class bound more often on molecules carrying an insertion?',
      missing: [sv ? '' : 'an SV in view (the SV row)', fp ? '' : 'footprint classes from a scan (Scan… with fp)'].filter(Boolean).join(' and '),
      draft: { mode: 'M1', aKey: sv?.key ?? '', bKey: fp?.key ?? '', group: 'none', question: 'q3' },
      note: 'M1 at the locus · A = carriage of the SV (carrier / reference), B = class membership · odds ratio, exact p, counts with exclusions' },
    { id: 'q4', question: 'Do peaks cluster near SV breakpoints?',
      missing: [sv ? '' : 'SVs (the SV row)', peaks ? '' : 'peaks (a scan with peaks, or a peak rule)'].filter(Boolean).join(' and '),
      draft: { mode: 'M4', aKey: sv?.key ?? '', bKey: peaks?.key ?? '', group: 'none', question: 'q4' },
      note: 'M4 · O/E by distance, global max-statistic p, both directions' },
  ];
}
