/**
 * Where the command palette's "Go to" goes (fb-n3-search, audit M7).
 *
 * The palette has no locus box of its own: a place found there goes to a
 * panel. One target per reference on screen (the main genome, and each other
 * assembly a dataset panel shows), each searched with that panel's own
 * context, as if typed in its locus box:
 *
 * - the panel the user is working in (panelScope.activePanelId) for its
 *   reference;
 * - for another reference, the first visible panel on it;
 * - a panel that follows the main view (Linked navigation) is reached through
 *   the main view (the main locus box); a panel with a locus of its own
 *   ("Each panel navigates", another assembly) through its own navigation.
 *
 * No dataset panel on screen: the main view alone (as before).
 *
 * The search providers fan out over these targets (providers.ts:
 * `SearchContext.targets`): genes are looked up in every reference, a
 * contig is checked against each reference's own chromosomes, regions come
 * from each reference's catalog. Each suggestion keeps its target and runs in
 * that panel's locus box (its progress, Cancel and outcome show there).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { panelGenomeLabel, usePanelGenomeStore } from '../../stores/panelGenomeStore';
import type { ChromInfo, PanelConfig } from '../../types';
import { mainReferenceLabel } from '../figureRegions';
import { activePanelId, visibleDatasetPanels, type PanelScopeState } from '../panelScope';
import { mainGenomeKey } from '../regionNavigation';
import type { SearchContext } from './providers';

export interface SearchTarget {
  /** 'main', or 'panel:<id>'. */
  key: string;
  /** The panel moved (null: the main view). */
  panelId: string | null;
  /** The reference's name, for labels ("dm6", "hg38"). */
  referenceLabel: string;
  /** The reference's catalog key (panelScope's genomeKey). */
  genomeKey: string;
  /** What the providers search and run with there (as that panel's locus box). */
  context: Pick<SearchContext, 'viewport' | 'navigate' | 'chroms' | 'genome' | 'target'>;
}

type State = PanelScopeState & { chroms: ChromInfo[] };

/** A panel's reference's chromosomes (its own assembly's, else the main genome's). */
function chromsOf(panel: PanelConfig, s: State): ChromInfo[] {
  if (!panel.genome) return s.chroms;
  const info = usePanelGenomeStore.getState().genomes[panel.genome];
  return (info?.chroms ?? []).map(c => ({ name: c.name, size: c.size, circular: c.circular }));
}

function referenceLabelOf(panel: PanelConfig | null, s: State): string {
  if (panel?.genome) return panelGenomeLabel(usePanelGenomeStore.getState().genomes[panel.genome], panel.genome);
  return mainReferenceLabel(s) ?? mainGenomeKey(s);
}

/** The main view as a target (its locus box: the main genome, the main locus). */
function mainTarget(s: State, label: string): SearchTarget {
  return {
    key: 'main',
    panelId: null,
    referenceLabel: label,
    genomeKey: mainGenomeKey(s),
    context: { viewport: { chrom: s.chrom, start: s.start, end: s.end }, chroms: s.chroms, genome: null, target: 'main' },
  };
}

/** A panel as a target: its own locus box's context. */
function panelTarget(panel: PanelConfig, s: State): SearchTarget {
  if (!panel.viewportOverride) return mainTarget(s, referenceLabelOf(panel, s));
  const id = panel.id;
  return {
    key: `panel:${id}`,
    panelId: id,
    referenceLabel: referenceLabelOf(panel, s),
    genomeKey: panel.genome || mainGenomeKey(s),
    context: {
      viewport: { ...panel.viewportOverride },
      navigate: (chrom, start, end) => useBrowserStore.getState().navigatePanel(id, chrom, start, end),
      chroms: chromsOf(panel, s),
      genome: panel.genome ?? null,
      target: { panelId: id },
    },
  };
}

/**
 * The palette's Go to targets now: one per reference on screen, the active
 * panel's first (see the module comment).
 */
export function paletteTargets(s: State = useBrowserStore.getState() as unknown as State): SearchTarget[] {
  const visible = visibleDatasetPanels(s);
  if (visible.length === 0) return [mainTarget(s, referenceLabelOf(null, s))];
  const activeId = activePanelId(s);
  const active = visible.find(p => p.id === activeId) ?? visible[0];
  const keyOf = (p: PanelConfig) => p.genome || mainGenomeKey(s);
  const out: SearchTarget[] = [];
  const seen = new Set<string>();
  for (const panel of [active, ...visible]) {
    const reference = keyOf(panel);
    if (seen.has(reference)) continue;
    seen.add(reference);
    // Linked navigation: a main-genome panel that follows the main view is reached through it.
    const follower = !panel.genome && !panel.viewportOverride ? panel : undefined;
    out.push(follower ? mainTarget(s, referenceLabelOf(panel, s)) : panelTarget(panel, s));
  }
  return out;
}

/** What identifies the targets (for the palette's search key: other targets, other answers). */
export function paletteTargetsKey(targets: readonly SearchTarget[]): string {
  return JSON.stringify(targets.map(t => [t.key, t.genomeKey, t.context.genome ?? null, t.context.chroms?.length ?? 0]));
}
