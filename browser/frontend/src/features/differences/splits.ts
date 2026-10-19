import { useBrowserStore } from '../../stores/browserStore';
import { applySvSplit } from '../../utils/svAlleleSplit';
import { workspaceAssignments } from './callModel';
import type { WorkspaceCalls, WorkspaceQuery } from './api';

export function applyFrozenDifferenceSplit(stateKey: string, query: WorkspaceQuery, result: WorkspaceCalls) {
  const entry=result.targets[0], t=entry.target, policy=result.evidence_policy;
  const groups=workspaceAssignments(result,query.dataset_id,policy);
  const ref=t.ref_end-t.ref_start;
  const store=useBrowserStore.getState();
  const intent=`split-intent:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  useBrowserStore.setState({differencesSession:{...store.differencesSession,targets:{...store.differencesSession.targets,
    [intent]:{target_type:t.target_type,identity_state:t.target_type==='exact'?'exact':'provisional',frozen:true,snapshot:{target:t,scope:result.analysis_scope,membership:result.membership,callsByMolecule:entry.calls_by_molecule},policy:{...policy},
      memberships:Object.entries(result.membership.rows[query.dataset_id]??{}).map(([row,id])=>({status:'resolved',originalId:row,currentId:row,molecule:result.membership.molecules[id]}))}}}});
  applySvSplit(stateKey,{datasetId:query.dataset_id,chrom:query.chrom,t:t.alt_bp>=ref?'I':'D',ref:t.ref_start,end:t.ref_end,
    len:Math.max(ref,t.alt_bp),margin:100,label:`${ref}→${t.alt_bp} bp (${t.target_type})`,counts:groups.counts,
    viewStart:query.start,viewEnd:query.end,frozenImport:true,
    includeDuplicates:policy.include_duplicates,includePutative:policy.include_putative,includeConflicting:policy.include_conflicting,includeAmbiguous:policy.include_ambiguous,
    differenceSnapshot:{target:t,policy,analysisScope:result.analysis_scope,producerPolicy:result.policy,scope:result.scope,
      membership:result.membership,callsByMolecule:entry.calls_by_molecule,frozen:true}},groups.rows);
  return useBrowserStore.getState().svSplits[stateKey];
}
