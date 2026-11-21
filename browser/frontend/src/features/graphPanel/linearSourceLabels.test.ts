import '../testSetup';
import { expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { seedSourceState } from './popOutKind';
import * as origins from './linearSources';
import { recordKey } from '../../utils/recordKeys';
import { serializeState, deserializeSavedState } from '../../stores/historySlice';

it('a linear fit seeds source views by each record’s own contig, across tree nodes and session round trips', () => {
  const aid = (digest: string) => `lift-cohort:v1 ${JSON.stringify(['library|synthetic', 'synthetic', digest, 0, 'primary'])}`;
  // The supplementary sorts first by id, but its primary is the source view's record.
  const supplementary = aid('aaa:0'), primary = aid('zzz:0');
  const from = { id: 'lift', contentType: 'dataset', datasetId: 'assembly', stateKey: 'lift', liftHap: 'MAT', subTracks: [], collapsed: false, linkGroup: null };
  const source = { ...from, id: 'source', datasetId: 'native', stateKey: 'source', liftHap: undefined,
    genome: 'source-genome', liftLink: { datasetId: 'assembly', liftPanelId: 'lift', hap: 'hm', hapLabel: 'MAT', contig: 'maternal' } };
  useBrowserStore.setState({ panels: [from, source], datasets: [{ id: 'assembly', data_type: 'bam_livelift', live_lift: {
    haplotypes: ['hm', 'hp'], haplotype_labels: { hm: 'MAT', hp: 'PAT' } } }],
    clusterAssignments: { lift: { [supplementary]: 2, [primary]: 1 } }, clusterOrder: { lift: [1, 2] },
    clusterTreeNodes: {}, activeClusterTreeNodeId: null, clusterMatchedRun: null, filteredReadIds: {}, clusterFocus: {} } as never);
  const state = useBrowserStore.getState();
  state.captureActiveClusterTreeNode({ name: 'Fit' });
  origins.adoptLinearSources('lift', 'assembly', {
    [supplementary]: { contig: 'paternal', hap: 'PAT' }, [primary]: { contig: 'maternal', hap: 'MAT' },
  });
  const fitted = useBrowserStore.getState();
  const id = fitted.activeClusterTreeNodeId!;
  // All provenance is durable node data; no graph run or drawn read rows are needed.
  const saved = JSON.parse(JSON.stringify(serializeState(fitted)));
  useBrowserStore.setState(deserializeSavedState(saved));
  seedSourceState('lift', 'source');
  expect(useBrowserStore.getState().clusterAssignments.source).toEqual({ synthetic: 1 });
  expect(useBrowserStore.getState().clusterTreeNodes[id].assignments.source).toEqual({ synthetic: 1 });
  expect(Object.values(useBrowserStore.getState().clusterTreeNodes[id].graphProvenance!.lift.owned).flat()).toContain(recordKey(primary));
});
