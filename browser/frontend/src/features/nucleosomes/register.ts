/**
 * The nucleosome panel (native/nucleosome_panel/DESIGN.md §6.1): an analysis panel, not a singleton (several can
 * show different scopes), registered through the same extension points a plugin pack uses; called once from
 * features/register.ts. Its settings travel on its panel (panels[].nucleosomes), so sessions save them.
 */
import { lazy } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
import { declareContribution } from '../../plugins/packRegistry';
import { NucleosomeIcon } from './icon';
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
    singleton: false, minUsableWidth: 360,
    description: 'Footprint sizes, spacing and array segments for every panel side by side (haplotypes, strands, linked loci, graph paths), from FiberHMM\'s nucleosome module.',
    sessionKeys: ['panels[].nucleosomes'],
    apiEndpoints: ['/api/nuc/available', '/api/nuc/status', '/api/nuc/jobs', '/api/nuc/jobs/{job_id}', '/api/nuc/summary', '/api/nuc/records', '/api/nuc/window', '/api/nuc/select', '/api/nuc/metrics', '/api/nuc/patches'],
  });
  declareContribution('panelFields', 'nucleosomes');
}
