import { useReadActionsStore } from '../../stores/readActionsStore';
import type { WorkspaceCalls } from './api';

/** Fan out within each qualified dataset, preserving one call per molecule. */
export function highlightMolecules(result:WorkspaceCalls,molecules:Set<string>){
  const scopedRows=Object.fromEntries(Object.entries(result.membership.rows).map(([dataset,rows])=>[dataset,new Set(Object.entries(rows).filter(([,id])=>molecules.has(id)).map(([row])=>row))]));
  useReadActionsStore.setState({highlight:{ids:new Set(Object.values(scopedRows).flatMap(ids=>[...ids])),scopedRows,
    pulseUntil:null,scrollTo:null,scrolled:new Set(),nonce:Date.now()}});
}
