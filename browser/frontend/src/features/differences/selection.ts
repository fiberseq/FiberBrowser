import type { Difference } from '../liveLift/differenceTypes';
import type { SvCluster } from '../../components/tracks/read-track/types';
import { useBrowserStore } from '../../stores/browserStore';
import { liveLiftViewKey } from '../liveLift/persistence';
import { useDifferenceSelection, type DifferenceSelection } from '../liveLift/inspectionStore';
import type { FrozenTarget } from './api';

export function frozenTarget(s: DifferenceSelection): FrozenTarget {
  return s.target ?? { target_id: s.difference.id, revision: 1, target_type: 'geometry', chrom: s.chrom,
    ref_start: s.difference.t_start, ref_end: s.difference.t_end, alt_bp: s.difference.alt_bp };
}
export function selectNativeDifference(c: Pick<SvCluster, 'id' | 't' | 'ref' | 'len' | 'end' | 'ref_len' | 'alt_len'>,
  datasetId: string, chrom: string, panelId?: string, inspect = true) {
  const state = useBrowserStore.getState();
  const panel = state.panels.find(p => panelId ? p.id === panelId : p.datasetId === datasetId);
  if (!panel) return;
  useDifferenceSelection.getState().select({ datasetId, panelId: panel.id, viewKey: liveLiftViewKey(panel), chrom, inspect,
    difference: nativeDifference(c,chrom),
    evidencePolicy: { include_duplicates: state.showDuplicateReads, include_putative: true, include_conflicting: false, include_ambiguous: false } });
}

export function nativeDifference(c: Pick<SvCluster, 'id' | 't' | 'ref' | 'len' | 'end' | 'ref_len' | 'alt_len'>, chrom:string):Difference {
  const ref_bp=c.ref_len??Math.max(0,c.end-c.ref),alt_bp=c.alt_len??(c.t==='I'?c.len:0);
  return {id:c.id,hap:'',hap_label:'',source:'reads',kind:ref_bp&&alt_bp?'replacement':ref_bp?'deletion':'insertion',
    reason:'geometry_only',t_start:c.ref,t_end:c.ref+ref_bp,ref_bp,alt_bp,chain:null,strand:null,
    src:{contig:chrom,start:null,end:null},grch38:null,alt:null};
}
