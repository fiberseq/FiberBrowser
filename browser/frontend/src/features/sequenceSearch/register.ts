/**
 * Find sequence in genome: a Tools panel (next to Primers, which shares its BLAST database), the locus box's
 * "Find this sequence in the genome" suggestion for pasted DNA, and the `find-sequence` app command (command
 * palette, View menu). Registered through the same extension points a plugin pack uses; called once from
 * features/register.ts. Host compute (BLAST, a scan of the genome): hidden on public servers.
 */
import { lazy } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
import { registerSearchProvider } from '../../utils/search/providers';
import { SequenceSearchIcon } from './icon';
import { sequenceSearchProvider } from './provider';
import { SEQUENCE_SEARCH_PANEL } from './store';

const Panel = lazy(() => import('./SequenceSearchPanel').then(m => ({ default: m.SequenceSearchPanel })));
let done = false;

export function registerSequenceSearch(): void {
  if (done) return;
  done = true;
  registerAnalysisPanel({
    contentType: SEQUENCE_SEARCH_PANEL,
    hostOnly: true,
    label: 'Find sequence',
    shortLabel: 'Find seq',
    // sky-700: apart from Primers' rose and the Tracks blue.
    headerColor: '#0369a1',
    component: Panel,
    icon: SequenceSearchIcon,
    description: 'Find where a pasted DNA sequence is in the genome: an exact / IUPAC scan of both strands for short queries, BLAST for longer ones',
    group: 'tools',
    stripOrder: 1.5,
    minUsableWidth: 280,
    sessionKeys: [],
    apiEndpoints: ['/api/sequence_search/status', '/api/sequence_search', '/api/sequence_search/jobs/{job_id}',
      '/api/sequence_search/jobs/{job_id}/track'],
    settingsTargets: ['Genome', 'Primer Design'],
  });
  registerSearchProvider(sequenceSearchProvider);
}
