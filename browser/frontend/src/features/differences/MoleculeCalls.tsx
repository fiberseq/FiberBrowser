import { highlightMolecules } from './highlight';
import { applyFrozenDifferenceSplit } from './splits';
import { openInsertionLens } from '../insertion/insertionLensTarget';
import { expandableAltBlock } from './capabilities';
import { useEffect, useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { applySvSplit } from '../../utils/svAlleleSplit';
import type { DifferenceSelection } from '../liveLift/inspectionStore';
import { DEFAULT_EVIDENCE_POLICY, inspectDifference, type EvidencePolicy, type WorkspaceCalls, type WorkspaceQuery } from './api';
import { frozenTarget } from './selection';
import { workspaceAssignments } from './callModel';
import { membershipChanges } from './session';

export function MoleculeCalls({ selection, native = false }: { selection: DifferenceSelection; native?: boolean }) {
  const target = useMemo(() => frozenTarget(selection), [selection]);
  const [policy, setPolicy] = useState<EvidencePolicy>(selection.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY);
  const [requested, setRequested] = useState(native);
  const [result, setResult] = useState<WorkspaceCalls | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState(false);
  const [scope, setScope] = useState<WorkspaceQuery['analysis_scope']>(native ? 'native_only' : 'lifted_only');
  const [nativeDataset, setNativeDataset] = useState('');
  const datasets = useBrowserStore(s => s.datasets);
  const panel = useBrowserStore(s => s.panels.find(p => p.id === selection.panelId));
  const supported = ['insertion', 'replacement', 'deletion'].includes(selection.difference.kind);
  const q = useMemo<WorkspaceQuery>(() => ({ dataset_id: selection.datasetId, chrom: selection.chrom,
    start: Math.max(0, Math.floor(target.ref_start-1000)),
    end: Math.ceil(target.ref_end+1000), target,
    analysis_scope: scope, ...(scope === 'combined' ? { native_dataset_id: nativeDataset } : {}) }),
    [selection, target, scope, nativeDataset]);
  useEffect(() => {
    setResult(null); setError(''); setPreview(false);
    if (!requested || !supported) return;
    const controller = new AbortController();
    void inspectDifference(q, policy, controller.signal).then(r => {
      if (!controller.signal.aborted) { if (r.status) setError(`${r.status}: ${r.reason}`); else setResult(r); }
    }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [q, policy, requested, supported, revision]);
  const snapshot = result?.targets[0];
  const groups = result && snapshot ? workspaceAssignments(result, selection.datasetId, policy) : null;
  const saved = useBrowserStore(s => s.svSplits[panel?.stateKey ?? selection.datasetId]);
  const assignments = useBrowserStore(s => s.clusterAssignments[panel?.stateKey ?? selection.datasetId]);
  const changes = groups ? membershipChanges(assignments ?? {}, groups.rows) : null;
  const highlight = () => {
    if (!groups) return;
    highlightMolecules(result!,new Set(Object.keys(groups.groups).filter(id=>groups.groups[id]===0)));
  };
  const split = () => {
    if (!result || !groups || !snapshot) return;
    applyFrozenDifferenceSplit(panel?.stateKey ?? selection.datasetId, q, result);
    setPreview(false);
  };
  if (!supported) return <p>Read carriage for this topology is unavailable. Assembly geometry remains inspectable.</p>;
  return <section aria-label="Molecule calls" className="mt-2 border-t pt-2">
    <p>{target.target_type === 'geometry' ? 'Frozen geometry target · exact sequence carriage remains separate' : 'Frozen exact allele target'} · revision {target.revision}</p>
    <div className="flex gap-2 flex-wrap">
      {(['include_putative', 'include_conflicting', 'include_ambiguous', 'include_duplicates'] as const).map(key => <label key={key}>
        <input type="checkbox" checked={policy[key]} onChange={e => setPolicy(p => ({ ...p, [key]: e.target.checked }))} /> {key.replace('include_', '').replace(/_/g, ' ')}
      </label>)}
      {!native && <><select aria-label="Read analysis scope" value={scope} onChange={e => setScope(e.target.value as WorkspaceQuery['analysis_scope'])}>
        <option value="lifted_only">Lifted reads</option><option value="combined">Combined representations</option></select>
        {scope === 'combined' && <select aria-label="Native representation dataset" value={nativeDataset} onChange={e => setNativeDataset(e.target.value)}>
          <option value="">Select native dataset</option>{datasets.filter(d => d.data_type === 'bam').map(d => <option key={d.id} value={d.id}>{d.label ?? d.id}</option>)}</select>}</>}
      <button onClick={() => { setRequested(true); setRevision(n => n+1); }}>Load molecule calls</button>
    </div>
    {error && <p role="status">{error}</p>}
    {requested && !result && !error && <p role="status">Loading scoped calls…</p>}
    {snapshot && groups && <>
      <p>Calls are a frozen loaded snapshot. Reload explicitly after changing sources.</p>
      <p data-testid="difference-molecule-counts">{groups.counts[0]} carriers · {groups.counts[1]} reference · {groups.counts[2]} not informative · {snapshot.sequence_unresolved_count} sequence unresolved</p>
      <p>Discovery: {String(result!.scope.cohort ?? 'loaded')} · {JSON.stringify(result!.scope.reasons ?? [])}</p>
      {expandableAltBlock(selection.difference) && <button onClick={() => openInsertionLens({ datasetId:selection.datasetId, chrom:selection.chrom, pos:target.ref_start,
        ref:target.ref_start,len:target.alt_bp,tolerance:0,lenMin:target.alt_bp,lenMax:target.alt_bp,flank:0,anchor:'left',
        workspace:{query:q,calls:result!} },selection.panelId)}>Open detailed workspace</button>}{' '}
      <button onClick={highlight}>Highlight carriers</button>{' '}
      <button onClick={() => saved ? setPreview(true) : split()}>{saved ? 'Preview recompute' : 'Split by carrier'}</button>
      {preview && <div role="status">Saved {saved?.counts.join('/')} → proposed {groups.counts.join('/')} (carriers/reference/not informative).
        <p>Row membership: +{changes?.added} / −{changes?.removed} / {changes?.changed} changed groups.</p>
        <p>Target {saved?.differenceSnapshot?.target.target_id ?? 'historical geometry'} → {target.target_id}; revision {target.revision}. Current inspector policy replaces the saved policy only when applied.</p>
        <details><summary>Old and proposed policy</summary><pre>{JSON.stringify({ saved: saved?.differenceSnapshot?.policy ?? {
          include_putative: saved?.includePutative ?? false, include_conflicting: saved?.includeConflicting ?? false,
          include_ambiguous: saved?.includeAmbiguous ?? false, include_duplicates: saved?.includeDuplicates ?? false,
          conflict_options: saved?.conflictOptions }, proposed: policy }, null, 2)}</pre></details>
        <button onClick={split}>Apply recomputed split</button><button onClick={() => setPreview(false)}>Keep saved split</button></div>}
      <table className="w-full text-left"><thead><tr><th>Molecule</th><th>Final call / geometry</th><th>Representations and dissent</th></tr></thead>
        <tbody>{Object.entries(snapshot.calls_by_molecule).slice(0, 500).map(([id, call]) => <tr key={id}
          onMouseEnter={() => highlightMolecules(result!,new Set([id]))}>
          <td>{result!.membership.molecules[id]?.raw_name ?? id}</td><td>{call.call.assignment} · {call.call.level ?? 'unknown'}{call.geometry_group !== undefined && ` · geometry ${['carrier', 'reference', 'not informative'][call.geometry_group]}`}</td>
          <td><details><summary>{call.call.reasons.join(', ') || call.call.method}{call.complete ? '' : ' · partial'}</summary><pre className="whitespace-pre-wrap max-w-lg">{JSON.stringify({representations:call.representations,...(call as any).lifted&&{projection:(call as any).lifted},...(call as any).native&&{native:(call as any).native},geometry:(call as any).geometry_evidence}, null, 2)}</pre></details></td>
        </tr>)}</tbody></table>
      {Object.keys(snapshot.calls_by_molecule).length > 500 && <p>Showing the first 500 molecules. Counts use the full returned cohort.</p>}
    </>}
  </section>;
}
