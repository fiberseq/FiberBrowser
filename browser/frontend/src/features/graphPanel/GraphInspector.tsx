/**
 * The graph inspector (DESIGN_GRAPH_PANEL.md §6, Gate F): a graph difference or graph locus, from the registered
 * package alone. It needs no dataset and no live lift: paths, both coordinate frames (target, and each path's
 * source spans), allele lengths, orientation, completeness and provenance, and the bases within the sequence limit.
 * A canonical live-lift difference is shown only when the server matched it exactly (same map, boundary and
 * placement); otherwise the selection is a graph-derived observation with a provisional identity. Read rows appear
 * only with a read binding. Opened by right-click → Inspect or ⌘/Ctrl-click on the graph; never by a plain click.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBrowserStore } from '../../stores/browserStore';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { getGraphCanonical, getGraphSequence, type GraphCanonicalResponse, type GraphSequenceResult } from './api';
import { canonicalProblem, focusWindow, placementsByPath, selectionProblem, type GraphSelection, type SourcePlacement } from './inspection';
import { laneLabel } from './layout';
import { navigateGraph, showSourceSpan, sourcePanelsFor } from './navigation';
import { closeGraphInspector, selectGraph } from './selectionStore';
import { useGraphReadsStore } from './graphReadsStore';
import { useGraphStatusStore } from './statusStore';
import type { GraphRegistration } from './types';

const SEQUENCE_PREVIEW = 600;
const n = (v: number) => v.toLocaleString('en-US');
const spanText = (s: { start: number; end: number }) => (s.end === s.start ? `boundary ${n(s.start)}` : `${n(s.start)}–${n(s.end)} (${n(s.end - s.start)} bp)`);

function pathLabel(reg: GraphRegistration | null, key: string): string {
  const b = reg?.bindings.find(x => x.key === key);
  return laneLabel(b, key);
}

function pathIdentity(reg: GraphRegistration | null, key: string): string {
  const b = reg?.bindings.find(x => x.key === key);
  return b ? `${b.path.sample}#${b.path.haplotype}#${b.path.contig}` : key;
}

const WHAT: Record<string, string> = {
  insertion: 'Insertion', deletion: 'Deletion', substitution: 'Substitution', inversion: 'Inversion',
  complex: 'Complex region', junction: 'Fragment junction', sequence: 'Shared sequence', gap: 'Graph gap',
  cluster: 'Clustered differences', 'open end': 'Open end',
};

function Placement({ sel, reg, p, ambiguous }: { sel: GraphSelection; reg: GraphRegistration | null; p: SourcePlacement; ambiguous: boolean }) {
  const panels = useBrowserStore(s => s.panels);
  void panels;   // re-render when panels open or close (source panels)
  const targets = sourcePanelsFor(p.path, sel.panelId);
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="graph-inspector-placement" data-path={p.path}
      data-start={p.span.start} data-end={p.span.end}>
      <span><strong>{pathLabel(reg, p.path)}</strong> {pathIdentity(reg, p.path)}:{spanText(p.span)}{p.note ? ` · ${p.note}` : ''}</span>
      {targets.map(t => (
        <button key={t.panelId} type="button" data-testid="graph-inspector-show-source" className="underline"
          title={`Move ${t.label} to this span`} onClick={() => showSourceSpan(sel.panelId, p, t, sel.registrationId)}>Show in {t.label}</button>
      ))}
      <button type="button" data-testid="graph-inspector-open-path" className="underline" disabled={!reg}
        title={ambiguous ? 'This path has more than one placement here: this one is shown' : 'A graph view on this path (its own coordinates; no BAM needed)'}
        onClick={() => showSourceSpan(sel.panelId, p, null, sel.registrationId)}>{targets.length ? 'Open path view' : 'Show source span'}</button>
    </li>
  );
}

function SequenceRow({ sel, reg, path, span }: { sel: GraphSelection; reg: GraphRegistration; path: string; span: { start: number; end: number } }) {
  const [seq, setSeq] = useState<GraphSequenceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const len = span.end - span.start;
  if (len <= 0) return <li>{pathLabel(reg, path)}: no bases (deleted here)</li>;
  const tooLong = len > 60_000;
  const load = () => {
    setBusy(true);
    getGraphSequence(reg.id, reg.revisions, path, { start: span.start, end: Math.min(span.end, span.start + 60_000) })
      .then(r => { setSeq(r); setError(null); }).catch(e => setError(String(e?.message ?? e))).finally(() => setBusy(false));
  };
  const text = seq ? seq.pieces.map(p => p.sequence).join('') : '';
  return (
    <li data-testid="graph-inspector-sequence" data-path={path}>
      <span>{pathLabel(reg, path)} · {n(len)} bp </span>
      {!seq && <button type="button" className="underline" disabled={busy || sel.registrationId !== reg.id} onClick={load}
        data-testid="graph-inspector-load-sequence">{busy ? 'Loading…' : tooLong ? 'Load the first 60,000 bp' : 'Load bases'}</button>}
      {error && <span className="text-red-600"> {error}</span>}
      {seq && <>
        <code className="block max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px]" data-testid="graph-inspector-bases">
          {text.slice(0, SEQUENCE_PREVIEW)}{text.length > SEQUENCE_PREVIEW ? '…' : ''}</code>
        <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(text)}>Copy {n(text.length)} bases</button>
        {!seq.complete && <span> · partial (graph gap: {seq.coverage.filter(c => c.kind !== 'covered').map(c => spanText(c.span)).join(', ')})</span>}
      </>}
    </li>
  );
}

export function GraphInspector({ selection: sel }: { selection: GraphSelection }) {
  const status = useGraphStatusStore(s => s.status);
  const regs = status?.registrations ?? [];
  const problem = status ? selectionProblem(sel, regs) : null;
  const reg = problem ? null : regs.find(r => r.id === sel.registrationId) ?? null;
  const dark = useBrowserStore(s => Boolean((s as { darkMode?: boolean }).darkMode));
  const graphOpen = useBrowserStore(s => s.panels.some(p => p.id === sel.panelId));
  const byPanel = useGraphReadsStore(s => s.byPanel);
  const bindings = useMemo(() => Object.values(byPanel).flatMap(v => v.bindings), [byPanel]);
  const revisions = useMemo(() => Object.fromEntries(bindings.map(b => [b.dataset_id, b.revision])), [bindings]);

  // Canonical difference (graph differences with one allele placement): the server's exact match only.
  const [canonical, setCanonical] = useState<{ response: GraphCanonicalResponse | null; error: string | null; for: string } | null>(null);
  const ask = sel.kind === 'graph-difference' && sel.target && reg
    ? (sel.selectedAllele ? sel.alleles.filter(a => a.id === sel.selectedAllele) : sel.alleles).flatMap(a => a.source).slice(0, 4)
    : [];
  const askKey = JSON.stringify([sel.registrationId, sel.locusKey, sel.selectedAllele, ask]);
  useEffect(() => {
    if (!reg || !sel.target || !ask.length) { setCanonical(null); return; }
    const controller = new AbortController();
    Promise.all(ask.map(s => getGraphCanonical({ registrationId: reg.id, revisions: reg.revisions, target: sel.targetBinding,
      path: s.path, targetSpan: sel.target!, sourceSpan: s.span }, controller.signal)))
      .then(rs => setCanonical({ for: askKey, error: null, response: {
        matches: rs.flatMap(r => r.matches), rejected: rs.flatMap(r => r.rejected), map: rs[0]?.map ?? null,
        reason: rs.map(r => r.reason).filter(Boolean).join('; ') || undefined } }))
      .catch(e => { if (!controller.signal.aborted) setCanonical({ for: askKey, error: String(e?.message ?? e), response: null }); });
    return () => controller.abort();
  }, [askKey, reg?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = canonical?.for === askKey ? canonical.response?.matches ?? [] : [];
  const stillCanonical = matches.filter(m => !canonicalProblem({ datasetId: m.dataset_id, id: m.id, revision: m.revision }, revisions));

  // Read rows hold only while their bindings do: every dataset still bound, at the revision it was counted at.
  const readsGone = sel.reads && sel.reads.datasetIds.length ? (() => {
    const missing = sel.reads.datasetIds.filter(id => !bindings.some(b => b.dataset_id === id));
    if (missing.length) return `${missing.length === 1 ? 'its dataset is' : 'its datasets are'} not bound to this graph now`;
    const changed = sel.reads.datasetIds.filter(id => sel.reads!.revisions?.[id] && revisions[id] !== sel.reads!.revisions[id]);
    return changed.length ? 'its dataset changed since (other files or map)' : null;
  })() : null;
  const placements = sel.placements ?? [];
  const byPath = placementsByPath(placements);
  const target = reg?.bindings.find(b => b.key === sel.targetBinding) ?? null;
  const left = Math.max(8, window.innerWidth - 560);
  return createPortal(
    <div role="dialog" aria-label="Inspect graph selection" data-testid="graph-inspector" data-kind={sel.kind} data-what={sel.what}
      data-problem={problem ?? ''} data-canonical={stillCanonical.map(m => m.id).join(',')}
      className="fixed z-[100] rounded border border-stone-400 bg-white p-3 text-xs text-slate-800 shadow-xl dark:bg-slate-900 dark:text-slate-100"
      style={{ left, top: 72, width: Math.min(540, window.innerWidth - 16), maxHeight: window.innerHeight - 90, overflow: 'auto' }}>
      <div className="flex items-start justify-between gap-4">
        <strong className="text-[12px]">{WHAT[sel.what] ?? sel.what}
          {sel.target ? ` · ${sel.contig}:${spanText(sel.target)}` : ''}</strong>
        <button type="button" aria-label="Close graph inspection" data-testid="graph-inspector-close" onClick={() => { closeGraphInspector(); selectGraph(null); }}>×</button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        {sel.kind === 'graph-difference' ? 'Graph difference' : 'Graph locus'} · {sel.complete ? 'complete' : 'incomplete'}
        · {sel.provenance === 'direct' ? 'direct correspondence' : sel.provenance === 'inferred' ? 'correspondence partly inferred' : 'unresolved placement'}
        {stillCanonical.length ? '' : ' · graph-derived, provisional identity'}
      </p>
      {problem && <p className="mt-2 rounded bg-amber-50 p-1.5 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100" data-testid="graph-inspector-problem">
        {problem} The selection is frozen as saved: target {sel.contig}{sel.target ? `:${spanText(sel.target)}` : ''}; it is not moved to other geometry. Register the package again to inspect it live.</p>}
      {!graphOpen && !problem && <p className="mt-2 text-slate-500" data-testid="graph-inspector-detached">Its graph panel is closed; the inspection stays usable.</p>}
      {sel.reason && <p className="mt-1">Reason: {sel.reason.replace(/_/g, ' ')}</p>}

      <h4 className="mt-2 font-semibold">Target · {target?.assembly ?? sel.targetReference ?? 'target'} ({pathIdentity(reg, sel.targetBinding)})</h4>
      <p>{sel.target ? `${sel.contig}:${spanText(sel.target)}` : 'No target sequence here'}
        {sel.base ? (sel.base.bp === 0 && sel.what === 'insertion' ? ' · no target sequence (insertion boundary)'
          : ` · target allele ${n(sel.base.bp)} bp, shared by ${sel.base.paths.map(k => pathLabel(reg, k)).join(', ') || '—'}`) : ''}</p>
      {sel.occurrence && <p data-testid="graph-inspector-occurrence">Node {sel.occurrence.node} · {pathLabel(reg, sel.occurrence.path)} visit
        {` ${pathIdentity(reg, sel.occurrence.path)}:${spanText(sel.occurrence.span)}`}</p>}

      {sel.alleles.length > 0 && <>
        <h4 className="mt-2 font-semibold">Alleles</h4>
        <table className="w-full text-left text-[11px]" data-testid="graph-inspector-alleles"><tbody>
          {sel.alleles.map(a => (
            <tr key={a.id} data-allele={a.id} className={a.id === sel.selectedAllele ? 'bg-stone-100 dark:bg-stone-800' : ''}>
              <td className="pr-2 align-top">{a.paths.map(k => <span key={k} style={{ color: liveLiftHaplotypeColor(pathLabel(reg, k), dark) }} className="mr-1 font-semibold">{pathLabel(reg, k)}</span>)}</td>
              <td className="pr-2 align-top">{n(a.bp)} bp{a.inverted ? ' · inverted' : ''}{a.status !== 'ok' ? ` · ${a.status}` : ''}</td>
              <td className="align-top">{a.source.map(s => <div key={`${s.path}|${s.span.start}-${s.span.end}`}>{pathIdentity(reg, s.path)}:{spanText(s.span)}</div>)}</td>
            </tr>
          ))}
        </tbody></table>
      </>}
      {sel.unavailable.length > 0 && <p className="mt-1">No verified traversal here: {sel.unavailable.map(k => pathLabel(reg, k)).join(', ')} (unavailable, not an empty allele)</p>}

      {sel.kind === 'graph-difference' && <div className="mt-2" data-testid="graph-inspector-canonical">
        {!reg ? null : !canonical || canonical.for !== askKey ? <p>Checking live-lift differences…</p>
          : canonical.error ? <p>Live-lift differences unavailable: {canonical.error}</p>
          : <>
            {stillCanonical.map(m => <p key={`${m.dataset_id}|${m.id}`}>Canonical difference <code>{m.id}</code> of {m.label} ({m.kind}, {n(m.ref_bp)} → {n(m.alt_bp)} bp): the same map, boundary and placement.</p>)}
            {!stillCanonical.length && <p>No canonical live-lift difference reused{canonical.response?.reason ? `: ${canonical.response.reason}` : ''}.</p>}
            {(canonical.response?.rejected ?? []).map((r, i) => <p key={i} className="text-slate-500" data-testid="graph-inspector-rejected" data-reason={r.reason}>Not reused · {r.label}: {r.message}</p>)}
          </>}
      </div>}

      {reg && (sel.alleles.some(a => a.source.some(s => s.span.end > s.span.start)) || sel.occurrence) && <>
        <h4 className="mt-2 font-semibold">Sequence</h4>
        <ul className="space-y-1">
          {sel.alleles.flatMap(a => a.source.slice(0, 1).map(s => <SequenceRow key={`${a.id}|${s.path}`} sel={sel} reg={reg} path={s.path} span={s.span} />))}
          {sel.occurrence && <SequenceRow key={`${sel.occurrence.id}|${sel.occurrence.span.start}`} sel={sel} reg={reg} path={sel.occurrence.path} span={sel.occurrence.span} />}
        </ul>
      </>}

      <h4 className="mt-2 font-semibold">Reads</h4>
      {readsGone
        ? <p data-testid="graph-inspector-reads" data-stale="true">Read evidence from when it was selected is unavailable: {readsGone}.</p>
        : sel.reads && sel.reads.datasetIds.length
        ? <p data-testid="graph-inspector-reads">{n(sel.reads.molecules)} molecules of {sel.reads.datasetIds.map(id => bindings.find(b => b.dataset_id === id)?.label ?? id).join(', ')} drawn over these spans.</p>
        : <p data-testid="graph-inspector-reads">No read binding: load a dataset whose files are aligned to one of these paths (read-dependent rows need one).</p>}

      <div className="mt-2 flex flex-wrap gap-3">
        {sel.target && target && graphOpen && !problem && <button type="button" className="underline" data-testid="graph-inspector-focus"
          onClick={() => navigateGraph(sel.panelId, { contig: sel.contig, ...focusWindow(sel.target!, target.size) })}>Focus the target {sel.target.end === sel.target.start ? 'boundary' : 'span'}</button>}
      </div>
      {placements.length > 0 && !problem && <>
        <h4 className="mt-2 font-semibold">Source spans{[...byPath.values()].some(v => v.length > 1) ? ' (more than one placement: choose one)' : ''}</h4>
        <ul className="space-y-1">{placements.map((p, i) => <Placement key={i} sel={sel} reg={reg} p={p} ambiguous={(byPath.get(p.path)?.length ?? 0) > 1} />)}</ul>
      </>}
    </div>,
    document.body,
  );
}

/** The graph selection's inspector, when open (DifferenceInspectorRoot mounts it before any dataset lookup). */
export function GraphInspectorHost() {
  const sel = useBrowserStore(s => (s as { graphSelection?: GraphSelection | null }).graphSelection ?? null);
  const open = useBrowserStore(s => Boolean((s as { graphInspect?: boolean }).graphInspect));
  const load = useGraphStatusStore(s => s.load);
  useEffect(() => { if (sel && open) void load(); }, [sel, open, load]);
  if (!sel || !open) return null;
  return <GraphInspector key={`${sel.registrationId}|${sel.locusKey}|${sel.selectedAllele}|${sel.occurrence?.id ?? ''}|${sel.occurrence?.offset ?? ''}`} selection={sel} />;
}
