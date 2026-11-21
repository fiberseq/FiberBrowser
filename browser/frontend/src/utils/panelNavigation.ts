import type { PanelConfig } from '../types';

/**
 * Navigation per panel (fb-r2-genomes, fb-r3-nav).
 *
 * Linking is per reference. In "Linked navigation" the dataset panels on one
 * reference share one locus (a link group per reference): those of the main
 * genome follow the main view (no viewportOverride; the main nav bar moves
 * them), and those on another assembly (`panel.genome`,
 * services/panel_genomes.py) carry the same viewportOverride and move together
 * from any member's locus box, pan/zoom or drag. A reference's group never
 * moves another reference's panels.
 *
 * Panels outside the groups keep their own locus whatever the mode: copies
 * the user made at another locus (`ownLocus`; on the main genome any panel
 * with its own view), haplotype comparisons and contact regions.
 *
 * "Each panel navigates" (navigationMode 'perPanel') gives every group member
 * its own locus box (`navOwn` marks the panels the mode converted). Back in
 * "Linked navigation" each reference's group goes to one locus: that of the
 * panel of the group the user moved last, else its first panel.
 */

export type NavigationMode = 'linked' | 'perPanel';
export interface Locus { chrom: string; start: number; end: number }

// A live-lift source panel (`liftLink`, features/liveLift/linking) follows the main view through the lift map, so it
// leaves its reference's link group (DESIGN_LIVE_LIFT.md §5.1).
const GROUP_FIELDS = ['haplotypeGroup', 'contactRegionGroupId', 'genomeRegionGroupId', 'linkedSessionId', 'liftLink'] as const;

/** A panel opened by a comparison or region view (they keep their own locus whatever the mode). */
export function inComparisonGroup(panel: PanelConfig): boolean {
  return GROUP_FIELDS.some(field => Boolean(panel[field]));
}

/** A dataset panel of the main genome showing the main view, or its own locus only because of "Each panel navigates". */
export function isMainViewPanel(panel: PanelConfig): boolean {
  return !panel.genome && (!panel.viewportOverride || Boolean(panel.navOwn));
}

/** The panel can follow the main view (link): not one on another assembly (that one links with its own reference's panels). */
export function canLinkToMainView(panel: PanelConfig): boolean {
  return !panel.genome;
}

/** A link group's key: the panels' reference (PanelConfig.genome), '' for the main genome. */
export const MAIN_GROUP = '';
export const groupKeyOf = (panel: Pick<PanelConfig, 'genome'>): string => panel.genome ?? MAIN_GROUP;

const isDatasetPanel = (panel: PanelConfig) => panel.contentType === 'dataset' && !!panel.datasetId;

/**
 * A member of its reference's link group in "Linked navigation", for a panel
 * on another assembly: a plain dataset panel (not a copy at its own locus, not
 * a comparison's, not given its own locus by "Each panel navigates").
 */
export function inGenomeLinkGroup(panel: PanelConfig): boolean {
  return isDatasetPanel(panel) && !!panel.genome && !panel.navOwn && !panel.ownLocus && !inComparisonGroup(panel);
}

/** The panels that move with this one (itself first): its reference's link group in "Linked navigation", else itself. */
export function linkGroupPeers(panels: PanelConfig[], panel: PanelConfig, mode: NavigationMode): string[] {
  if (mode !== 'linked' || !inGenomeLinkGroup(panel)) return [panel.id];
  return [panel.id, ...panels.filter(p => p.id !== panel.id && p.genome === panel.genome && inGenomeLinkGroup(p)).map(p => p.id)];
}

const sameLocus = (a?: Locus | null, b?: Locus | null) =>
  !!a && !!b && a.chrom === b.chrom && a.start === b.start && a.end === b.end;

/**
 * "Linked navigation": the members of each other reference's link group show
 * one locus (`preferred[key]`, else the first member's).
 */
export function syncGenomeGroups(panels: PanelConfig[], preferred: Record<string, Locus> = {}): PanelConfig[] {
  const target: Record<string, Locus> = { ...preferred };
  for (const p of panels) {
    if (inGenomeLinkGroup(p) && p.viewportOverride && !target[p.genome!]) target[p.genome!] = p.viewportOverride;
  }
  let changed = false;
  const next = panels.map(p => {
    if (!inGenomeLinkGroup(p)) return p;
    const want = target[p.genome!];
    if (!want || sameLocus(p.viewportOverride, want)) return p;
    changed = true;
    return { ...p, viewportOverride: { ...want } };
  });
  return changed ? next : panels;
}

/**
 * Panels "Match other panels to this location" moves (fb-r3-nav): every other
 * dataset panel on the same reference except comparisons (haplotype views and
 * contact regions are defined by their own loci).
 */
export function matchablePanels(panels: PanelConfig[], panel: PanelConfig): PanelConfig[] {
  const key = groupKeyOf(panel);
  return panels.filter(p => p.id !== panel.id && isDatasetPanel(p) && groupKeyOf(p) === key && !inComparisonGroup(p));
}

/**
 * The moves of link group members, most recent last, per group key (fb-r3-nav):
 * "Linked navigation" takes each group to where the panel moved last still is.
 * A move counts only while the panel is still where it went (an undone move
 * doesn't), and only for a member (a copy at its own locus or a comparison
 * isn't in the group).
 */
export interface PanelMove {
  panelId: string;
  locus: Locus;
  /** Order of the move across every group (utils/panelScope: the panel moved last of all). */
  at?: number;
}
export type PanelMoves = Record<string, PanelMove[]>;
const MOVES_KEPT = 30;
let moveSeq = 0;

/** A member of its reference's link group (in either mode: navOwn marks one given its own locus by "Each panel navigates"). */
export function isLinkGroupMember(panel: PanelConfig): boolean {
  if (!isDatasetPanel(panel) || inComparisonGroup(panel) || panel.ownLocus) return false;
  return panel.genome ? true : (!panel.viewportOverride || Boolean(panel.navOwn));
}

/** `moves` with this panel's move to `locus` recorded (unchanged for a panel outside the link groups). */
export function recordPanelMove(moves: PanelMoves, panel: PanelConfig, locus: Locus): PanelMoves {
  if (!isLinkGroupMember(panel)) return moves;
  const key = groupKeyOf(panel);
  const list = (moves[key] ?? []).filter(m => m.panelId !== panel.id);
  return { ...moves, [key]: [...list, { panelId: panel.id, locus: { ...locus }, at: ++moveSeq }].slice(-MOVES_KEPT) };
}

/** The group member moved last that is still where that move took it. */
function lastMovedStillThere(members: PanelConfig[], moves: PanelMove[] = []): PanelConfig | undefined {
  for (let i = moves.length - 1; i >= 0; i--) {
    const p = members.find(m => m.id === moves[i].panelId);
    if (p && sameLocus(p.viewportOverride, moves[i].locus)) return p;
  }
  return undefined;
}

/** Dataset panels the per-panel mode gives their own locus: the link groups' members (shown, not already independent). */
function convertible(panel: PanelConfig): boolean {
  if (!isDatasetPanel(panel) || inComparisonGroup(panel)) return false;
  if (panel.genome) return inGenomeLinkGroup(panel) && !!panel.viewportOverride;
  return !panel.viewportOverride;
}

/**
 * "Each panel navigates": every link group member gets its own locus, starting
 * where it is (the main view for the main genome's panels).
 */
export function panelsForPerPanelMode(panels: PanelConfig[], main: Locus): PanelConfig[] {
  let changed = false;
  const next = panels.map(panel => {
    if (!convertible(panel)) return panel;
    changed = true;
    return { ...panel, viewportOverride: { ...(panel.viewportOverride ?? main) }, navOwn: true, siteLocked: false, linkGroup: null };
  });
  return changed ? next : panels;
}

/**
 * Back to "Linked navigation": the panels the mode converted rejoin their
 * reference's link group, and each group goes to one locus: where the panel of
 * that group the user moved (or opened at its dataset's own locus) last still
 * is (`lastMoved[group key]`; a move since undone doesn't count), else its
 * first panel shown. For the main genome that is where the main view goes
 * (`mainLocus`), so the reads you were looking at stay on screen.
 */
export function panelsForLinkedMode(panels: PanelConfig[], lastMoved: PanelMoves = {}): { panels: PanelConfig[]; mainLocus: Locus | null } {
  const chosen: Record<string, Locus> = {};
  const keys = [...new Set(panels.filter(p => p.navOwn && p.viewportOverride).map(groupKeyOf))];
  for (const key of keys) {
    const members = panels.filter(p => p.navOwn && p.viewportOverride && groupKeyOf(p) === key);
    const last = lastMovedStillThere(members, lastMoved[key]);
    const pick = last ?? members.find(p => !p.collapsed) ?? members[0];
    chosen[key] = { ...pick.viewportOverride! };
  }
  let changed = false;
  const next = panels.map(panel => {
    if (!panel.navOwn) return panel;
    changed = true;
    const { navOwn: _navOwn, viewportOverride: _vpo, siteLocked: _locked, ...rest } = panel;
    if (!panel.genome) return rest as PanelConfig;
    // Another reference's panel keeps a locus of its own: its group's.
    return { ...rest, viewportOverride: { ...(chosen[panel.genome] ?? panel.viewportOverride!) } } as PanelConfig;
  });
  const synced = syncGenomeGroups(changed ? next : panels, chosen);
  return { panels: synced, mainLocus: chosen[MAIN_GROUP] ?? null };
}

/**
 * Panels follow their datasets' references. `assignments`: dataset id ->
 * reference key (a dataset not listed uses the main genome). `loci`: where a
 * dataset just given a reference opens (its best-covered window there).
 * `fallback`: a locus on a reference for a panel that has none yet.
 *
 * A panel joining a reference: in "Linked navigation" it joins that
 * reference's link group (at the group's locus when it has members already,
 * else at the first joining dataset's locus); in "Each panel navigates" it
 * gets its own locus there; a copy at its own locus stays one.
 */
export function panelsForGenomes(
  panels: PanelConfig[],
  assignments: Record<string, string>,
  options: {
    loci?: Record<string, Locus>;
    main: Locus;
    mode: NavigationMode;
    fallback?: (genome: string) => Locus | null;
    hasChrom?: (genome: string, chrom: string) => boolean;
  },
): PanelConfig[] {
  const { loci = {}, main, mode, fallback, hasChrom } = options;
  const onRef = (genome: string, v?: Locus | null): v is Locus => !!v && (!hasChrom || hasChrom(genome, v.chrom));
  // Where each reference's link group is: its members' locus, else the first joining dataset's.
  const groupLocus: Record<string, Locus> = {};
  if (mode === 'linked') {
    for (const p of panels) {
      const want = p.datasetId ? assignments[p.datasetId] : undefined;
      if (want && p.genome === want && inGenomeLinkGroup(p) && onRef(want, p.viewportOverride) && !groupLocus[want]) {
        groupLocus[want] = p.viewportOverride;
      }
    }
    for (const p of panels) {
      const want = p.datasetId ? assignments[p.datasetId] : undefined;
      if (want && p.genome !== want && !groupLocus[want] && loci[p.datasetId!] && isDatasetPanel(p) && !inComparisonGroup(p)) {
        groupLocus[want] = loci[p.datasetId!];
      }
    }
  }
  let changed = false;
  const next = panels.map(panel => {
    if (!isDatasetPanel(panel)) return panel;
    const want = assignments[panel.datasetId!];
    const locus = loci[panel.datasetId!];
    if (want) {
      const v = panel.viewportOverride;
      const onIt = onRef(want, v);
      if (inComparisonGroup(panel)) {
        // A comparison's view keeps its locus when it is on that reference.
        const target = onIt ? v : (locus ?? fallback?.(want) ?? null);
        if (panel.genome === want && target === v && !panel.siteLocked && !panel.navOwn && !panel.ownLocus) return panel;
        changed = true;
        return { ...panel, genome: want, ...(target ? { viewportOverride: { ...target } } : {}),
          navOwn: undefined, ownLocus: undefined, siteLocked: false, linkGroup: null };
      }
      if (panel.genome === want) {
        // Already there: it stays where it is (a dataset given the reference again opens at its new locus).
        const target = onIt && !locus ? v : (locus ?? (onIt ? v : fallback?.(want) ?? null));
        // In "Linked navigation" a panel left with its own locus by the other mode rejoins its group.
        const navOwn = mode === 'perPanel' ? panel.navOwn : undefined;
        if (target === v && !panel.siteLocked && panel.navOwn === navOwn) return panel;
        changed = true;
        return { ...panel, ...(target ? { viewportOverride: { ...target } } : {}), navOwn, siteLocked: false };
      }
      // Joining the reference. A copy at its own locus (on the main genome: any panel with its own view
      // but "Each panel navigates") stays one; a plain panel joins the link group, or gets its own locus.
      changed = true;
      const copy = Boolean(panel.ownLocus || (!panel.genome && v && !panel.navOwn));
      const target = (!copy && mode === 'linked' ? groupLocus[want] : undefined) ?? locus ?? fallback?.(want) ?? null;
      if (!copy && mode === 'linked' && target && !groupLocus[want]) groupLocus[want] = target;
      return {
        ...panel,
        genome: want,
        ...(target ? { viewportOverride: { ...target } } : {}),
        navOwn: !copy && mode === 'perPanel' ? true : undefined,
        ownLocus: copy ? true : undefined,
        siteLocked: false,
        linkGroup: null,
      };
    }
    if (!panel.genome) return panel;
    // Back on the main genome: a plain panel follows the main view again (or
    // gets its own locus there in per-panel mode); comparison panels keep theirs.
    changed = true;
    const { genome: _genome, ownLocus: _own, ...rest } = panel;
    if (inComparisonGroup(panel)) return rest as PanelConfig;
    const { viewportOverride: _vpo, ...plain } = rest as PanelConfig;
    return mode === 'perPanel'
      ? { ...plain, viewportOverride: { ...main }, navOwn: true, siteLocked: false }
      : { ...plain, navOwn: undefined, siteLocked: undefined };
  });
  const out = changed ? next : panels;
  return mode === 'linked' ? syncGenomeGroups(out, groupLocus) : out;
}

/** Panels still needing their own locus in per-panel mode (a dataset opened since). */
export function needsPerPanelLocus(panels: PanelConfig[]): boolean {
  return panels.some(convertible);
}
