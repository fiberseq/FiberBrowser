/**
 * The nucleosome panel (native/nucleosome_panel/DESIGN.md §6.1): an analysis panel, not a singleton (several can
 * show different scopes), registered through the same extension points a plugin pack uses; called once from
 * features/register.ts. Its settings travel on its panel (panels[].nucleosomes), so sessions save them.
 */
import { createElement, lazy } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
import { declareContribution } from '../../plugins/packRegistry';
import { openPanelItem, registerTrackKind, rowHeight } from '../../components/tracks/trackRegistry';
import { registerTrackRenderer } from '../../components/tracks/trackRenderers';
import { sameChrom } from '../../utils/chromAliases';
import { NucleosomeIcon } from './icon';
import { registerGeometryFeatures } from './geoHub';
import { geoRunFor, pruneGeoRuns, useNucGeoRuns } from './geoRuns';
import { useBrowserStore } from '../../stores/browserStore';
import { registerSavedGeometries } from './savedGeometries';
import { GEO_TRACK_HEADER, GEO_TRACK_TYPE, GeometryFeatureTrack, geometryTrackHeight, geometryTrackLanes } from './GeometryFeatureTrack';
import './types';

export const NUCLEOSOME_PANEL = 'nucleosomes';
const Panel = lazy(() => import('./NucleosomePanel').then(m => ({ default: m.NucleosomePanel })));
let done = false;

export function registerNucleosomePanel(): void {
  if (done) return;
  done = true;
  registerAnalysisPanel({
    contentType: NUCLEOSOME_PANEL, label: 'Nucleosomes', shortLabel: 'Nuc',
    // green-700: the nucleosome layers' green, apart from the other tiles.
    headerColor: '#15803d', component: Panel, icon: NucleosomeIcon, group: 'analysis', stripOrder: 5.5,
    singleton: false, minUsableWidth: 280, bodyLayout: 'fill',
    description: 'Single-fibre nucleosome regularity for every panel side by side (haplotypes, strands, linked loci, graph paths): a continuous score, high- and low-regularity patches and the geometries datasets share, from FiberHMM\'s nucleosome module.',
    sessionKeys: ['panels[].nucleosomes', 'savedNucGeometries'],
    apiEndpoints: ['/api/nuc/available', '/api/nuc/status', '/api/nuc/jobs', '/api/nuc/jobs/{job_id}', '/api/nuc/records', '/api/nuc/metrics', '/api/nuc/regularity', '/api/nuc/geometries', '/api/nuc/patch_labels'],
  });
  declareContribution('panelFields', 'nucleosomes');
  // Shared geometries as features (hub kind and provider), saved geometries, and their track above the reads.
  registerGeometryFeatures();
  registerSavedGeometries();
  // A closed panel's geometries leave the hub and the tracks (runs outlive their components while the panel is open).
  useBrowserStore.subscribe((st, prev) => { if (st.panels !== prev.panels) pruneGeoRuns(st.panels.map(p => p.id)); });
  registerTrackKind({
    type: GEO_TRACK_TYPE, label: 'Regularity geometries', defaultHeight: geometryTrackHeight(2), minHeight: 18, maxHeight: 240, builtin: true,
    shownWhen: 'after the nucleosome panel finds shared geometries',
    menu: () => [openPanelItem(NUCLEOSOME_PANEL, 'Nucleosomes')],
    defaultPlacement: { after: ['nfr-variants', 'consensus', 'fire'], before: ['reads'], requires: 'reads' },
  });
  registerTrackRenderer({
    type: GEO_TRACK_TYPE,
    useHeight: () => {
      const runs = useNucGeoRuns(st => st.runs);
      return ({ datasetId, view, track }) => {
        const run = geoRunFor(runs, datasetId, view.chrom, view.start, view.end, sameChrom);
        if (!run) return null;
        if (track.collapsed) return GEO_TRACK_HEADER;
        return rowHeight(track, geometryTrackHeight(geometryTrackLanes(run.result.geometries).count));
      };
    },
    render: ({ panel, track, datasetId, width, height, sidebarWidth }) => {
      const vpo = panel.viewportOverride;
      return createElement(GeometryFeatureTrack, { width, height, datasetId: datasetId!, panelId: panel.id, collapsed: !!track.collapsed, sidebarWidth,
        ...(vpo ? { overrideChrom: vpo.chrom, overrideStart: vpo.start, overrideEnd: vpo.end } : {}) });
    },
  });
}
