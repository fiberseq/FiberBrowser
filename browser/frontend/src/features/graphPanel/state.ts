/**
 * The graph panel's saved state (PanelConfig.graphView) and the pure decisions around it: the first registration
 * and paths a new panel shows, what its target viewport is in each link mode, and when following a linear panel is
 * allowed (the same reference and contig only: never numerical coordinates copied between assemblies).
 */
import type { PanelConfig } from '../../types';
import { clampViewport, followViewport, GRAPH_DEFAULT_TARGET_BP, type GraphViewport } from './coordinates';
import type { GraphBinding, GraphRegistration, GraphViewState } from './types';

export const GRAPH_MAX_PATHS = 4;
export const DEFAULT_CONTEXT_BP = 100;

/** A linear panel's view and the reference it is on (its genome key: registry id or FASTA name; null: unknown). */
export interface LinearView { chrom: string; start: number; end: number; reference?: string | null }

/** Names of one assembly (lower case). A FASTA named after exactly one assembly ("GRCh38_chr3.fa") counts as it. */
const ASSEMBLY_ALIASES: string[][] = [
  ['grch38', 'hg38'], ['grch37', 'hg19'], ['chm13', 'chm13v2', 'hs1'], ['dm6', 'bdgp6'], ['mm10', 'grcm38'], ['mm39', 'grcm39'],
];

function normaliseReference(name: string): string {
  let n = name.trim().toLowerCase().replace(/^fasta:/, '');
  n = n.split(/[\\/]/).pop() ?? n;
  return n.replace(/(\.gz)?$/, '').replace(/\.(fa|fasta|fna|2bit)$/, '');
}

/**
 * Whether a linear panel's reference is the graph target's assembly: the same name, or a FASTA/registry name whose
 * words name that one assembly (by a known alias) and no other. "hg38_to_hg19.fa" names two: it matches neither.
 * Contig names alone never decide it (DESIGN §6: no numerical copying between assemblies).
 */
export function referenceMatches(target: Pick<GraphBinding, 'reference' | 'assembly'>, genome: string | null | undefined): boolean {
  if (!genome) return false;
  const g = normaliseReference(genome);
  const refs = [target.reference, target.assembly].filter(Boolean).map(r => normaliseReference(String(r)));
  if (refs.includes(g)) return true;
  const theirs = assembliesNamed(g);
  if (theirs.length !== 1) return false;
  return refs.some(r => { const ours = assembliesNamed(r); return ours.length === 1 && ours[0] === theirs[0]; });
}

/** The alias groups a (normalised) name names: as a whole, or by its words. */
function assembliesNamed(name: string): string[][] {
  const words = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  return ASSEMBLY_ALIASES.filter(group => group.includes(name) || group.some(n => words.has(n)));
}

/** The bindings a target can be compared with: those the package has a map to from it (correspondence), and any
 * already selected. */
export function selectableBindings(reg: GraphRegistration, target: string, selected: readonly string[] = []): GraphBinding[] {
  const sources = reg.maps.filter(m => m.target === target).map(m => m.source);
  const ordered = [...new Set([...sources, ...selected])];
  return ordered.filter(k => k !== target).map(k => reg.bindings.find(b => b.key === k)).filter((b): b is GraphBinding => Boolean(b));
}

/** Following onto another contig: the package's map target on it, if any (its own default paths). */
export function retargetFor(reg: GraphRegistration, state: GraphViewState, linear: LinearView | null): GraphViewState | null {
  if (state.linkMode !== 'follow' || !linear) return null;
  const current = reg.bindings.find(b => b.key === state.targetBinding);
  if (current && current.path.contig === linear.chrom) return null;
  const next = defaultTarget(reg, linear);
  if (!next || next.path.contig !== linear.chrom || next.key === state.targetBinding) return null;
  if (!referenceMatches(next, linear.reference)) return null;
  return { ...state, targetBinding: next.key, targetReferenceId: next.reference, initiatingReferenceId: linear.reference ?? null,
    selectedPathKeys: [next.key, ...defaultCompared(reg, next.key)] };
}

/** The target a new panel shows: a map target on the main view's contig when there is one, else the first map's. */
export function defaultTarget(reg: GraphRegistration, main: LinearView | null = null): GraphBinding | null {
  const targets = [...new Set(reg.maps.map(m => m.target))].map(k => reg.bindings.find(b => b.key === k)).filter((b): b is GraphBinding => Boolean(b));
  return (main && targets.find(b => b.path.contig === main.chrom && referenceMatches(b, main.reference)))
    ?? (main && targets.find(b => b.path.contig === main.chrom)) ?? targets[0] ?? reg.bindings[0] ?? null;
}

/** The paths compared by default: the target's map sources (they have correspondence), at most three. */
export function defaultCompared(reg: GraphRegistration, target: string): string[] {
  return [...new Set(reg.maps.filter(m => m.target === target).map(m => m.source))].slice(0, GRAPH_MAX_PATHS - 1);
}


/** Whether a linear view is on this target's contig and reference (the only case following is offered). */
export function canFollow(target: GraphBinding | null | undefined, linear: LinearView | null | undefined): boolean {
  return Boolean(target && linear && linear.chrom === target.path.contig && referenceMatches(target, linear.reference));
}

function firstCovered(target: GraphBinding): GraphViewport {
  const origin = target.fragments[0]?.origin ?? 0;
  return { contig: target.path.contig, start: origin, end: origin + GRAPH_DEFAULT_TARGET_BP };
}

/** A new panel's state: the first registration's target and up to three compared paths, following the main view
 * when it is on the target's contig, else on its own at the target's first covered stretch. */
export function initialGraphView(reg: GraphRegistration | null, main: LinearView | null, initiatingPanelId: string | null = null): GraphViewState {
  const target = reg ? defaultTarget(reg, main) : null;
  const follow = canFollow(target, main);
  const selected = reg && target ? [target.key, ...defaultCompared(reg, target.key)] : [];
  const viewport = target
    ? (follow ? followViewport(main!, target.size, target.size_inferred) : clampViewport(firstCovered(target), target.size, target.size_inferred))
    : null;
  return {
    schema: 2,
    role: 'standalone',
    registrationId: reg?.id ?? null,
    packageRevision: reg?.revisions.package ?? null,
    graphRevision: reg?.revisions.graph ?? null,
    mapRevision: reg?.revisions.maps ?? null,
    targetBinding: target?.key ?? null,
    targetReferenceId: target?.reference ?? null,
    initiatingPanelId: follow ? initiatingPanelId : null,
    initiatingReferenceId: follow ? (main?.reference ?? null) : null,
    selectedPathKeys: selected,
    targetViewport: viewport,
    linkMode: follow ? 'follow' : 'independent',
    layoutSettings: { contextBp: DEFAULT_CONTEXT_BP, laneHeight: 28 },
  };
}

/** The linear view a following graph panel reads: its initiating panel's own viewport, else the main view. */
export function initiatorView(state: GraphViewState, panels: readonly PanelConfig[], main: LinearView): LinearView | null {
  if (state.initiatingPanelId == null) return main;
  const panel = panels.find(p => p.id === state.initiatingPanelId);
  if (!panel) return null;   // closed: the graph panel keeps its last viewport (DESIGN §6)
  const reference = panel.genome || main.reference || null;
  return panel.viewportOverride ? { ...panel.viewportOverride, reference } : { ...main, reference };
}

/** The target viewport this panel shows now. */
export function effectiveViewport(state: GraphViewState, target: GraphBinding | null, panels: readonly PanelConfig[], main: LinearView): GraphViewport | null {
  if (!target) return null;
  if (state.linkMode === 'follow') {
    const linear = initiatorView(state, panels, main);
    // The reference it started following must still be the one shown (a genome switched under it detaches it).
    const same = !state.initiatingReferenceId || state.initiatingReferenceId === (linear?.reference ?? null);
    if (linear && same && canFollow(target, linear)) return followViewport(linear, target.size, target.size_inferred);
  }
  return state.targetViewport ? clampViewport(state.targetViewport, target.size, target.size_inferred) : null;
}

/** A restored state is usable only with its registration at the same revisions; otherwise the panel says so. */
export function restoreProblem(state: GraphViewState, regs: readonly GraphRegistration[]): string | null {
  if (!state.registrationId) return null;
  const reg = regs.find(r => r.id === state.registrationId);
  if (!reg) return 'Its graph package is not registered on this server.';
  if (reg.revisions.package !== state.packageRevision || reg.revisions.graph !== state.graphRevision || reg.revisions.maps !== state.mapRevision) {
    return 'Its graph package changed since this panel was saved.';
  }
  if (state.targetBinding && !reg.bindings.some(b => b.key === state.targetBinding)) return 'Its target path is no longer in the package.';
  return null;
}

/** Toggle a compared path; the target stays, at most four paths in all. */
export function togglePath(state: GraphViewState, key: string): GraphViewState {
  if (key === state.targetBinding) return state;
  const has = state.selectedPathKeys.includes(key);
  if (!has && state.selectedPathKeys.length >= GRAPH_MAX_PATHS) return state;
  const selectedPathKeys = has ? state.selectedPathKeys.filter(k => k !== key) : [...state.selectedPathKeys, key];
  return { ...state, selectedPathKeys };
}

export function isGraphViewState(v: unknown): v is GraphViewState {
  const s = v as GraphViewState | null;
  return Boolean(s && typeof s === 'object' && (s.schema === 1 || s.schema === 2) && Array.isArray(s.selectedPathKeys)
    && (s.linkMode === 'follow' || s.linkMode === 'independent'));
}
