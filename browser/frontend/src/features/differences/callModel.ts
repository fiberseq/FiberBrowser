import type { MoleculeCall } from './contracts';
import type { EvidencePolicy, WorkspaceCalls } from './api';

export function moleculeGroup(call: MoleculeCall, type: 'geometry' | 'exact', policy: EvidencePolicy): 0 | 1 | 2 {
  const level = call.call.level;
  const allowed = level === 'confirmed' || level === 'putative' && policy.include_putative
    || level === 'conflicting' && policy.include_conflicting || level === 'ambiguous' && policy.include_ambiguous;
  if (type === 'geometry' && call.geometry_group !== undefined) return call.geometry_group as 0 | 1 | 2;
  if (call.call.assignment === 'target' && allowed) return 0;
  if (call.call.assignment === 'reference') return 1;
  return 2;
}
export function workspaceAssignments(result: WorkspaceCalls, datasetId: string, policy: EvidencePolicy) {
  const target = result.targets[0];
  if (result.status || !target) throw new Error(result.reason ?? 'Calls unavailable');
  const groups = Object.fromEntries(Object.entries(target.calls_by_molecule).map(([id, call]) => [id, moleculeGroup(call, target.target.target_type, policy)]));
  const counts: [number, number, number] = [0, 0, 0];
  Object.values(groups).forEach(group => counts[group]++);
  return { counts, groups, rows: Object.fromEntries(Object.entries(result.membership.rows[datasetId] ?? {})
    .filter(([, molecule]) => molecule in groups).map(([row, molecule]) => [row, groups[molecule]])) };
}
