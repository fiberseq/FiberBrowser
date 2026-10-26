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
import { exactTargetsFor, type ExactTarget } from './comparison';
import { runInspectComparison, useInspectEntry, useMapDataset } from './AssemblyComparisonPanel';
import { fetchJson } from '../../api/sharedFetch';
import { callText, INSPECTOR_BUTTON, reasonText } from './inspectorText';
import type { Dataset } from '../../types';

export function MoleculeCalls({ selection, native = false }: { selection: DifferenceSelection; native?: boolean }) {
  const ownDataset = useBrowserStore(s => s.datasets.find(d => d.id === selection.datasetId));
  const map = useMapDataset(ownDataset ?? ({ id: selection.datasetId, data_type: native ? 'bam' : 'bam_livelift' } as Dataset));
  const comparison = useInspectEntry(selection, map);
  const exactTargets = useMemo(() => exactTargetsFor(comparison), [comparison]);
  // Geometry by default; an exact assembly allele (with its competitors and the reference) on request.
  const [exactId, setExactId] = useState('');
  const exact: ExactTarget | undefined = exactTargets.find(t => t.target_id === exactId);
  const geometry = useMemo(() => frozenTarget(selection), [selection]);
  const target = exact ?? geometry;
  const [consensus, setConsensus] = useState<{ busy: boolean; message: string }>({ busy: false, message: '' });
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
  // The reads' consensus is the read allele's sequence; comparing it lets an insertion reach "Confirmed by assembly".
  const compareConsensus = async () => {
    if (!result || !map) return;
    setConsensus({ busy: true, message: '' });
    try {
      const lens = await fetchJson<{ consensus?: { seq: string; method_label: string; n_reads: number }; status?: string; reason?: string; consensus_resource?: { reason: string } }>(
        '/api/differences/lens', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...q, frozen_calls: result, consensus: true, include_duplicates: policy.include_duplicates }) });
      const seq = lens.consensus?.seq;
      if (!seq) { setConsensus({ busy: false, message: `No consensus: ${lens.reason ?? lens.consensus_resource?.reason ?? 'no full carrier sequence'}` }); return; }
      // Discovery completeness comes from the loaded calls (a 'not in the assembly' verdict needs it).
      const r = await runInspectComparison(selection, map, { [selection.difference.id]: seq }, undefined, Boolean(result.scope?.search_complete));
      setConsensus({ busy: false, message: r.status ? `${r.status}: ${r.reason}` : `Compared a ${seq.length.toLocaleString()} bp consensus (${lens.consensus!.method_label}, ${lens.consensus!.n_reads} reads).` });
    } catch (e) { setConsensus({ busy: false, message: String((e as Error).message ?? e) }); }
  };
  const canConsensus = selection.difference.source === 'reads' && selection.difference.alt_bp > 0 && Boolean(map) && !exact;
  if (!supported) return <p>Read carriage for this topology is unavailable. Assembly geometry remains inspectable.</p>;
  return <section aria-label="Molecule calls" className="mt-2 border-t pt-2">
    <p title={`Target revision ${target.revision}`}>{target.target_type === 'geometry'
      ? `Molecule calls for this difference's geometry (any sequence of this size here; sequence is not checked${exactTargets.length ? ': pick an exact assembly allele below to check it' : ''})`
      : 'Molecule calls for the exact assembly allele'}</p>
    {exactTargets.length > 0 && <p><label className="inline-flex items-center gap-1">Allele target
      <select aria-label="Allele target" data-testid="allele-target" value={exactId} onChange={e => { setExactId(e.target.value); setRequested(true); }}>
        <option value="">Geometry (any sequence)</option>
        {exactTargets.map(t => <option key={t.target_id} value={t.target_id}>Exact assembly allele: {t.candidate_labels[t.target_id] ?? 'assembly'} {t.ref_end - t.ref_start}→{t.alt_bp} bp</option>)}
      </select></label>
      {exact && <span data-testid="allele-target-competitors"> · competing: {Object.keys(exact.candidates ?? {}).filter(k => k !== exact.target_id).map(k => k === 'reference' ? 'reference' : exact.candidate_labels[k] ?? 'other allele').join(', ')}
        {exact.competition_complete ? '' : ' · competition incomplete (some local alleles lack sequence)'}</span>}</p>}
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {(['include_putative', 'include_conflicting', 'include_ambiguous', 'include_duplicates'] as const).map(key => <label key={key} className="inline-flex items-center gap-1 whitespace-nowrap">
        <input type="checkbox" checked={policy[key]} onChange={e => setPolicy(p => ({ ...p, [key]: e.target.checked }))} /> {key.replace('include_', '').replace(/_/g, ' ')}
      </label>)}
      {!native && <><select aria-label="Read analysis scope" value={scope} onChange={e => setScope(e.target.value as WorkspaceQuery['analysis_scope'])}>
        <option value="lifted_only">Lifted reads</option><option value="combined">Combined representations</option></select>
        {scope === 'combined' && <select aria-label="Native representation dataset" value={nativeDataset} onChange={e => setNativeDataset(e.target.value)}>
          <option value="">Select native dataset</option>{datasets.filter(d => d.data_type === 'bam').map(d => <option key={d.id} value={d.id}>{d.label ?? d.id}</option>)}</select>}</>}
      <button className={INSPECTOR_BUTTON} onClick={() => { setRequested(true); setRevision(n => n+1); }}>Load molecule calls</button>
    </div>
    {error && <p role="status">{error}</p>}
    {requested && !result && !error && <p role="status">Loading scoped calls…</p>}
    {snapshot && groups && <>
      <p className="text-slate-500">These calls are a snapshot: load them again after changing the options above.</p>
      <p data-testid="difference-molecule-counts">{groups.counts[0]} carriers · {groups.counts[1]} reference · {groups.counts[2]} not informative · {snapshot.sequence_unresolved_count} sequence unresolved</p>
      {(() => { const reasons = Array.isArray(result!.scope.reasons) ? (result!.scope.reasons as unknown[]).map(String) : [];
        return reasons.length > 0 && <p data-testid="difference-discovery">Read search ({String(result!.scope.cohort ?? 'loaded').replace(/_/g, ' ')} reads): {reasonText(reasons)}</p>; })()}
      <div className="my-1 flex flex-wrap gap-1.5">
      {expandableAltBlock(selection.difference) && <button className={INSPECTOR_BUTTON} onClick={() => openInsertionLens({ datasetId:selection.datasetId, chrom:selection.chrom, pos:target.ref_start,
        ref:target.ref_start,len:target.alt_bp,tolerance:0,lenMin:target.alt_bp,lenMax:target.alt_bp,flank:0,anchor:'left',
        workspace:{query:q,calls:result!} },selection.panelId)}>Open detailed workspace</button>}
      {canConsensus && <button className={INSPECTOR_BUTTON} data-testid="compare-consensus" disabled={consensus.busy} onClick={() => { void compareConsensus(); }}>
        {consensus.busy ? 'Building consensus…' : 'Compare consensus with assembly'}</button>}
      <button className={INSPECTOR_BUTTON} onClick={highlight}>Highlight carriers</button>
      <button className={INSPECTOR_BUTTON} onClick={() => saved ? setPreview(true) : split()}>{saved ? 'Preview recompute' : 'Split by carrier'}</button>
      </div>
      {consensus.message && <p role="status" data-testid="consensus-status">{consensus.message}</p>}
      {target.target_type === 'exact' && <p data-testid="exact-counts">Exact allele calls: {snapshot.counts[0]} carry it · {snapshot.counts[1]} reference · {snapshot.counts[2]} other allele or unresolved
        {(result as { chemistry_default?: { chemistry: string; provenance: string } | null }).chemistry_default
          ? ` · chemistry ${(result as any).chemistry_default.chemistry} (${(result as any).chemistry_default.provenance})` : ' · chemistry from st tags only'}</p>}
      {preview && <div role="status">Saved {saved?.counts.join('/')} → proposed {groups.counts.join('/')} (carriers/reference/not informative).
        <p>Row membership: +{changes?.added} / −{changes?.removed} / {changes?.changed} changed groups.</p>
        <p>Target {saved?.differenceSnapshot?.target.target_id ?? 'historical geometry'} → {target.target_id}; revision {target.revision}. Current inspector policy replaces the saved policy only when applied.</p>
        <details><summary>Old and proposed policy</summary><pre>{JSON.stringify({ saved: saved?.differenceSnapshot?.policy ?? {
          include_putative: saved?.includePutative ?? false, include_conflicting: saved?.includeConflicting ?? false,
          include_ambiguous: saved?.includeAmbiguous ?? false, include_duplicates: saved?.includeDuplicates ?? false,
          conflict_options: saved?.conflictOptions }, proposed: policy }, null, 2)}</pre></details>
        <div className="flex gap-1.5"><button className={INSPECTOR_BUTTON} onClick={split}>Apply recomputed split</button><button className={INSPECTOR_BUTTON} onClick={() => setPreview(false)}>Keep saved split</button></div></div>}
      <table className="w-full text-left"><thead><tr><th>Molecule</th><th>Call</th><th>Why (click for the evidence)</th></tr></thead>
        <tbody>{Object.entries(snapshot.calls_by_molecule).slice(0, 500).map(([id, call]) => <tr key={id}
          onMouseEnter={() => highlightMolecules(result!,new Set([id]))}>
          <td>{result!.membership.molecules[id]?.raw_name ?? id}</td><td data-testid="molecule-call" title={`${call.call.assignment} · ${call.call.level ?? 'no level'}`}>{callText(call.call, call.geometry_group)}</td>
          <td><details><summary title={call.call.reasons.join(', ') || call.call.method}>{reasonText(call.call.reasons.length ? call.call.reasons : [call.call.method])}{call.complete ? '' : ' · partial'}</summary><pre className="whitespace-pre-wrap max-w-lg">{JSON.stringify({representations:call.representations,...(call as any).lifted&&{projection:(call as any).lifted},...(call as any).native&&{native:(call as any).native},geometry:(call as any).geometry_evidence}, null, 2)}</pre></details></td>
        </tr>)}</tbody></table>
      {Object.keys(snapshot.calls_by_molecule).length > 500 && <p>Showing the first 500 molecules. Counts use the full returned cohort.</p>}
    </>}
  </section>;
}
