import type { MoleculeCall } from './contracts';
import type { EvidencePolicy, WorkspaceCalls } from './api';

export function moleculeGroup(call: MoleculeCall, type: 'geometry' | 'exact', policy: EvidencePolicy): 0 | 1 | 2 {
  const geometry = type === 'geometry' ? call.geometry_evidence : undefined;
  const evidence = geometry?.assignment ? { ...call.call, ...geometry } : call.call;
  const level = geometry?.level ?? evidence.level;
  const allowed = level === 'confirmed' || level === 'putative' && policy.include_putative
    || level === 'conflicting' && policy.include_conflicting || level === 'ambiguous' && policy.include_ambiguous;
  if (type === 'geometry' && !geometry?.assignment && call.geometry_group !== undefined) {
    return call.geometry_group === 0 && !allowed ? 2 : call.geometry_group as 0 | 1 | 2;
  }
  if (evidence.assignment === 'target' && allowed) return 0;
  if (evidence.assignment === 'reference') return 1;
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
