/**
 * The NFR Accessibility (preview) panel and its integration in the read view: NFRs and NFR variants as selectable
 * features, the NFR channel over the reads (with the NFR pair arcs), links to and from the Footprints panel's classes, its split
 * sources and combinatorial grouping, its session state and its analysis preference (the ChIP-Atlas choice).
 */
import { lazy } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { registerAnalysisPanel } from '../../plugins/registry';
import { registerBrowserHost } from '../../plugins/browserHosts';
import { openPanelItem, registerTrackKind, rowHeight } from '../../components/tracks/trackRegistry';
import { registerTrackRenderer } from '../../components/tracks/trackRenderers';
import { registerClassLinks, type ClassLink } from '../../components/controls/footprint-analysis/classLinks';
import { NucleosomeFree } from '../../components/ui/Icons';
import { registerFeatureKind, type FeatureRef } from '../../stores/featureStore';
import { registerNfrHubProvider } from './hubProvider';
import { useBrowserStore } from '../../stores/browserStore';
import { registerAnalysisPreferenceMap } from '../../utils/analysisPreferences';
import { registerFullReadAnalysis } from '../../components/tracks/read-track/ReadSampleNotice';
import { useAccessibilityStore } from './accessibilityStore';
import { loadStoredChipAtlasSelections, normalizeChipAtlasSelections } from './chipAtlasSelection';
import { NFR_FEATURE_HEADER, NfrFeatureTrack, nfrRunFor, nfrTrackHeight, nfrTrackLanes } from './NfrFeatureTrack';
import { registerNfrGrouping } from './nfrGrouping';
import { savedNfrsOver, showNfr } from './nfrLinks';
import { useNfrRunsStore } from './nfrRunsStore';
import { registerNfrState } from './nfrState';
import { useNfrFeatureBridge } from './useNfrFeatureBridge';
import { useNfrRuns } from './useNfrRuns';
import { registerPanelHeaderExtension } from '../../components/tracks/panelHeaderExtensions';
import { useNfrGroupsHeader } from './NfrGroupsChip';

const LazyAccessibility = lazy(() => import('./AccessibilityPanel').then(m => ({ default: m.AccessibilityPanel })));

/** "N1 V2" -> "N1 V2": an NFR or variant's short name in group labels. */
const nfrShortName = (f: FeatureRef): string => f.label || (f.kind === 'nfr-variant' ? f.id.replace(':', ' ') : f.id);

const LINK_COLOURS = 'text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-fuchsia-950/30';

/** Find variants runs the read panels draw in their NFR channel; the channel and the panel hover each other's variants. */
function NfrRunsHost() {
  useNfrRuns();
  useNfrFeatureBridge();
  return null;
}

export function registerNfr(): void {
  registerAnalysisPanel({
    contentType: 'accessibility',
    label: 'NFRs',
    shortLabel: 'NFRs',
    headerColor: '#c026d3',
    component: LazyAccessibility,
    // The co-accessibility icon on purpose while the old Co-accessibility panel still exists.
    icon: NucleosomeFree,
    description: 'NFR variants on each read, and which open together',
    group: 'analysis',
    stripOrder: 5.5,
    settingsTargets: ['Analysis & Reproducibility'],
    // Saved NFR variants travel in the session's frontend state; the runs themselves in its accessibility_runs block.
    sessionKeys: ['savedNfrVariants', 'pinnedMotifs', 'motifScoreMode', 'motifPValue', 'nfrMotifSettings', 'customMotifs', 'chipAtlasSelections'],
    apiEndpoints: ['/api/accessibility/jobs', '/api/accessibility/jobs/*'],
  });

  registerNfrState();
  registerAnalysisPreferenceMap({
    field: 'chipatlas_selection', storeKey: 'chipAtlasSelections',
    normalize: v => normalizeChipAtlasSelections(v), loadLocal: () => loadStoredChipAtlasSelections(),
  });

  // NFRs and their variants (an Accessibility run's elements): read states on the accessibility layer.
  const notes = {
    layerNote: 'NFRs and variants on the accessibility layer',
    groupingNote: 'the Accessibility panel\'s "Group reads by variant" / "Split by combination pattern" groups',
  };
  registerFeatureKind({ kind: 'nfr', typeId: 'nfr.region', layerLabel: 'accessibility', shortName: nfrShortName, regionMode: () => 'accessibility', pluralName: 'NFRs', listOrder: 0, ...notes });
  registerFeatureKind({ kind: 'nfr-variant', typeId: 'nfr.variant', layerLabel: 'accessibility', shortName: nfrShortName, regionMode: () => 'accessibility', pluralName: 'NFR variants', listOrder: 1,
    stateNote: 'NFR variants: open or not', ...notes });
  registerNfrGrouping();
  registerNfrHubProvider();
  // Find variants reads every alignment of the view (the sampled-reads notice says so).
  registerFullReadAnalysis('Find NFR variants', 0);

  // The NFR pair arcs are drawn on the NFR track (its 'nfr-variants' row), not in a row of their own: the former 'nfr'
  // row is no longer a kind, so a session or snapshot that has it drops it on loading (stores/utils
  // migratePanelTracks -> dropUnknownTracks) and its panels show the arcs on their NFR track instead.
  // The NFR channel: each NFR of a Find variants run on the panel's dataset and view, its variants as bars; a row of
  // every reads panel, right after the footprint class channel.
  registerTrackKind({
    type: 'nfr-variants', label: 'NFR variants', defaultHeight: 76, minHeight: 18, maxHeight: 320, builtin: true,
    menu: () => [openPanelItem('accessibility', 'NFRs')],
    defaultPlacement: { after: ['consensus', 'fire'], before: ['reads'], requires: 'reads' },
  });
  registerTrackRenderer({
    type: 'nfr-variants',
    // A completed Find variants run on this panel's dataset and view (render and layout alike).
    // Its default height follows its lanes (the unfolded NFRs) and the arcs drawn on it (the shown run's pairs).
    useHeight: () => {
      const { shownJob, showArcs, expanded, showClassArcs, elements } = useAccessibilityStore(useShallow(s => ({
        shownJob: s.jobId, showArcs: s.showArcs && !!s.result, expanded: s.expanded, showClassArcs: s.showClassArcs, elements: s.result?.elements,
      })));
      const runs = useNfrRunsStore(s => s.nfrRuns);
      return ({ datasetId, view, track }) => {
        const run = datasetId ? nfrRunFor(runs, shownJob, datasetId, view.chrom, view.start, view.end) : null;
        if (!run) return null;
        if (track.collapsed) return NFR_FEATURE_HEADER;
        const arcs = showArcs && run.jobId === shownJob;
        const lanes = nfrTrackLanes(run.result.nfrs, expanded[run.jobId] ?? []).count;
        const classLane = arcs && showClassArcs && !!elements?.some(e => e.kind === 'tf');
        return rowHeight(track, nfrTrackHeight(lanes, arcs, classLane));
      };
    },
    render: ({ panel, track, datasetId, width, height, sidebarWidth }) => {
      const vpo = panel.viewportOverride;
      return <NfrFeatureTrack width={width} height={height} datasetId={datasetId!} panelId={panel.id} collapsed={!!track.collapsed}
        sidebarWidth={sidebarWidth} {...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {})} />;
    },
  });
  registerBrowserHost('nfr-runs', NfrRunsHost);
  // A read panel holding read groups from this panel says so in its header, with the groups' colours (the legend).
  registerPanelHeaderExtension(useNfrGroupsHeader);

  // The Footprints panel's classes link to the NFRs they sit in (the shown run) and to saved NFRs over them.
  registerClassLinks({
    useRowLinks: () => {
      const nfrRun = useAccessibilityStore(useShallow(s => ({ jobId: s.jobId, result: s.result })));
      return ({ chrom, start, end, classId, jobId: classJob }): ClassLink[] => {
        const r = nfrRun.result;
        if (!r || !nfrRun.jobId || !chrom || r.region.chrom.replace(/^chr/i, '') !== chrom.replace(/^chr/i, '')) return [];
        const c = (start + end) / 2;
        return r.nfrs.filter(n => n.variants.length && Math.min(n.start, ...n.variants.map(v => v.L)) <= c && c < Math.max(n.end, ...n.variants.map(v => v.R)))
          .map(n => {
            const inside = n.variants.filter(v => v.L <= c && c < v.R).map(v => v.name);
            return {
              key: n.id, testId: 'recaller-nfr-link', className: LINK_COLOURS, onClick: () => showNfr(nfrRun.jobId!, n.id, false, undefined, classId ?? undefined, classJob ?? undefined),
              label: `${n.id}${inside.length ? ` ${inside.join('/')}` : ''} ↗`,
              title: `Open the NFR panel at ${n.id}${inside.length ? ` (${inside.join(', ')} open over this class)` : ''}, on its Footprints view with this class marked: how often each variant opens here, and is footprinted when open`,
            };
          });
      };
    },
    useSavedLinks: () => {
      // Saved NFRs over a saved class (linked, not copied): open them in the NFR panel.
      const saved = useBrowserStore(s => s.savedNfrVariants);
      return ({ chrom, start, end, classId, jobId: classJob }): ClassLink[] => (saved.length ? savedNfrsOver(chrom, start, end) : []).map(e => ({
        key: e.id, testId: 'saved-class-nfr-link', className: LINK_COLOURS, onClick: () => showNfr(e.jobId, e.nfrId, true, undefined, classId ?? undefined, classJob ?? undefined),
        label: `${e.name} ↗`,
        title: `Saved NFR ${e.name} covers this class: open it (its variants and this class together) in the NFR panel`,
      }));
    },
  });
}
