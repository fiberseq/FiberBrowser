import type { PanelConfig } from '../types';
import { canLinkToMainView, inComparisonGroup, type Locus } from './panelNavigation';

/** Independent panel state and locus used by panel copies and region views. */
export function copyPanelAtSite(source: PanelConfig, id: string, main: Locus, linked = false): PanelConfig {
  const linkedGenomeCopy = Boolean(linked && source.genome && !source.ownLocus && !inComparisonGroup(source));
  return {
    ...source,
    id,
    subTracks: source.subTracks.map(track => ({ ...track })),
    stateKey: id,
    linkGroup: null,
    collapsed: false,
    // Its own column right after the source, starting where the source is.
    layoutColumn: undefined,
    viewportOverride: source.viewportOverride ?? { chrom: main.chrom, start: main.start, end: main.end },
    // Never linked to the main view from another assembly.
    siteLocked: Boolean(linked) && canLinkToMainView(source),
    // A copy the user made keeps its own locus whatever the navigation mode; a
    // linked copy of a panel on another assembly moves with that reference's panels.
    navOwn: linkedGenomeCopy ? source.navOwn : undefined,
    ownLocus: linkedGenomeCopy ? undefined : true,
    regionLabel: undefined,
    regionPanelGroup: undefined,
    contactRegionGroupId: undefined,
    contactRegionRole: undefined,
    genomeRegionGroupId: undefined,
    haplotypeGroup: undefined,
    collapsedByContactRegionGroup: undefined,
    collapsedByHaplotypeGroup: undefined,
  };
}
