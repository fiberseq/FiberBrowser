import { useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { serializeState } from '../../stores/historySlice';
import { deserializeSets } from '../../stores/hydration';
import { normalizeSvSplits } from '../../stores/svSlice';
import { applySvSplit, requestSvSplit, svSplitDef, type SvSplitResponse } from '../../utils/svAlleleSplit';
import { membershipChanges, previewHistoricalRelink } from './session';

/** No cache or coordinate lookup participates in historical identity recovery.
 * Proposals are invalidated by any change to the saved intent or memberships. */
function signature() {
  const s = serializeState(useBrowserStore.getState());
  return JSON.stringify([s.differencesSession, s.clusterAssignments, s.selectedReadIds,
    s.svCarrierEvidence, s.filteredReadIds, s.readSortOrder, s.svSplits, s.datasets, s.panels]);
}

export function SavedDifferences() {
  const session = useBrowserStore(s => s.differencesSession);
  const datasets = useBrowserStore(s => s.datasets);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('');
  const [metadata, setMetadata] = useState('');
  const [error, setError] = useState('');
  const [relink, setRelink] = useState<{ base: string; proposal: ReturnType<typeof previewHistoricalRelink> } | null>(null);
  const [recompute, setRecompute] = useState<{ base: string; key: string; response: SvSplitResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const scopes = Object.keys(session.imports);
  const targets = Object.entries(session.targets).filter(([, t]) => t.snapshot.t === 'I' || t.snapshot.t === 'D');
  const lineage = Object.entries(session.ledger.lineage);
  if (!scopes.length && !targets.length && !lineage.length) return null;
  const unresolved = Object.values(session.imports).flat().filter(m => m.status === 'unresolved_import').length;
  const selected = scopes.includes(scope) ? scope : scopes[0];
  const previewRelink = () => {
    pending.current?.abort();
    setError(''); setRecompute(null);
    try {
      const parsed = JSON.parse(metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Membership metadata must be an object');
      setRelink({ base: signature(), proposal: previewHistoricalRelink(serializeState(useBrowserStore.getState()), session, selected, parsed) });
    } catch (e) { setRelink(null); setError(String((e as Error).message)); }
  };
  const applyRelink = () => {
    if (!relink || relink.base !== signature()) { setRelink(null); setError('Saved state changed. Preview the relink again.'); return; }
    const restored = { ...relink.proposal.restored };
    deserializeSets(restored);
    useBrowserStore.getState().pushSnapshot('Before historical differences relink');
    useBrowserStore.setState({ ...restored, differencesSession: relink.proposal.session });
    useBrowserStore.getState().pushSnapshot('Relink historical differences membership');
    setRelink(null);
  };
  const previewRecompute = async (key: string) => {
    setError(''); setRelink(null); setRecompute(null); setLoading(true);
    const base = signature();
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const def = normalizeSvSplits({ [key]: session.targets[key].snapshot })[key];
    try {
      if (!def) throw new Error('The saved target needs an explicit supported target before recomputing');
      const response = await requestSvSplit({ stateKey: key, datasetId: def.datasetId, chrom: def.chrom,
        viewStart: def.viewStart, viewEnd: def.viewEnd, includePutative: Boolean(def.includePutative),
        includeConflicting: Boolean(def.includeConflicting), includeAmbiguous: Boolean(def.includeAmbiguous),
        conflictOptions: def.conflictOptions }, def, def.margin, controller.signal, Boolean(def.includeDuplicates));
      if (controller.signal.aborted) return;
      if (signature() !== base) throw new Error('Saved state changed. Preview the recompute again.');
      setRecompute({ base, key, response });
    } catch (e) { if (!controller.signal.aborted) setError(String((e as Error).message)); }
    finally { if (pending.current === controller) setLoading(false); }
  };
  const applyRecompute = () => {
    if (!recompute || recompute.base !== signature()) { setRecompute(null); setError('Saved state changed. Preview the recompute again.'); return; }
    const def = normalizeSvSplits({ [recompute.key]: session.targets[recompute.key].snapshot })[recompute.key];
    const target = { stateKey: recompute.key, datasetId: def.datasetId, chrom: def.chrom,
      viewStart: def.viewStart, viewEnd: def.viewEnd, includePutative: Boolean(def.includePutative),
      includeConflicting: Boolean(def.includeConflicting), includeAmbiguous: Boolean(def.includeAmbiguous), conflictOptions: def.conflictOptions };
    useBrowserStore.getState().pushSnapshot('Before historical differences recompute');
    applySvSplit(recompute.key, { ...svSplitDef(target, def, recompute.response, def.includeDuplicates), frozenImport: true }, recompute.response.assignments);
    setRecompute(null);
  };
  const change = recompute ? membershipChanges(useBrowserStore.getState().clusterAssignments[recompute.key] ?? {}, recompute.response.assignments) : null;
  return <aside className="fixed bottom-2 left-2 z-[90] text-xs">
    <button className="border rounded bg-white dark:bg-slate-900 p-2" onClick={() => setOpen(!open)}>
      Saved differences{unresolved ? ` · ${unresolved} unresolved memberships` : ''}
    </button>
    {open && <section role="dialog" aria-label="Saved differences" className="p-3 border rounded bg-white dark:bg-slate-900 max-w-xl max-h-[70vh] overflow-auto">
      <button className="float-right" onClick={() => { pending.current?.abort(); setLoading(false); setOpen(false); }}>Close</button>
      <p>Historical targets and policies stay frozen. Reopen or relink missing files through session restore.</p>
      {scopes.length > 0 && <>
        <label>Saved membership scope <select value={selected} onChange={e => { setScope(e.target.value); setRelink(null); setMetadata(''); }}>
          {scopes.map(key => <option key={key}>{key}</option>)}
        </select></label>
        <p>{session.imports[selected].filter(m => m.status === 'unresolved_import').length} unresolved · original identities retained.</p>
        <details><summary>Relink from trustworthy producer metadata</summary>
          <p>Supply producer, folding and record membership from the saved source. Names containing pipes are preserved verbatim; missing or conflicting provenance stays unresolved.</p>
          <textarea aria-label="Historical membership metadata" rows={5} className="w-full border text-black" value={metadata} onChange={e => { setMetadata(e.target.value); setRelink(null); }} />
          <button onClick={previewRelink}>Preview relink</button>
        </details>
      </>}
      {relink && <div role="status">
        <p>{relink.proposal.resolved} resolved · {relink.proposal.unresolved} unresolved. Membership keys: +{relink.proposal.changes.added} / −{relink.proposal.changes.removed} / {relink.proposal.changes.changed} changed groups.</p>
        <p>Target, policy, counts and original snapshots are retained.</p>
        <button onClick={applyRelink}>Apply membership relink</button><button onClick={() => setRelink(null)}>Keep saved membership</button>
      </div>}
      {targets.map(([key, saved]) => {
        const def = normalizeSvSplits({ [key]: saved.snapshot })[key];
        const dataset = datasets.find(d => d.id === def?.datasetId);
        return <div key={key} className="mt-2 border-t">
          <p>{key} · frozen geometry · {def?.chrom}:{def?.ref} · {def?.counts.join('/') ?? 'counts unavailable'}</p>
          <details><summary>Saved target and policy</summary><pre className="whitespace-pre-wrap">{JSON.stringify({ target: saved.snapshot, policy: saved.policy }, null, 2)}</pre></details>
          <button disabled={loading || !def || dataset?.data_type !== 'bam'} onClick={() => void previewRecompute(key)}>Preview recompute with saved policy</button>
          {!dataset && <p>Source unavailable. Saved membership remains available.</p>}
          {dataset && dataset.data_type !== 'bam' && <p>This legacy adapter cannot recompute projected calls. Inspect an explicit target in Differences to preview a new scoped policy.</p>}
        </div>;
      })}
      {lineage.map(([id, node]) => <details key={id}><summary>Retired identity: {id}</summary>
        <p>{node.reason} · descendants: {Array.isArray(node.descendants) ? node.descendants.join(', ') : 'unresolved'}</p>
        <p>The saved target and membership stay frozen. Inspect a chosen descendant explicitly to preview a replacement; descendants are never selected or unioned automatically.</p>
      </details>)}
      {recompute && change && <div role="status">
        <p>Saved {session.targets[recompute.key].snapshot.counts?.join('/')} → proposed {recompute.response.counts.join('/')} carriers/reference/not informative.</p>
        <p>Membership: +{change.added} / −{change.removed} / {change.changed} changed groups. Saved target and policy are unchanged.</p>
        <button onClick={applyRecompute}>Apply recomputed membership</button><button onClick={() => setRecompute(null)}>Keep saved split</button>
      </div>}
      {loading && <p role="status">Preparing recompute preview…</p>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </aside>;
}
