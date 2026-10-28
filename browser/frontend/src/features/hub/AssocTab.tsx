/**
 * The hub's association tab (DESIGN §7, A2): a builder (A, B, mode, unit, group, strata, scope), the four example
 * questions as presets, the running job (progress, cancel), the session's runs, and the shown run's results.
 */
import { useEffect, useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { AnalysisButton } from '../../components/controls/shared/AnalysisControls';
import { JobStatus } from '../../components/controls/shared/JobStatus';
import type { ScanInfo } from './api';
import { MODE_LABELS, MODE_SHORT, MODE_UNITS, type AssocMode } from './assocApi';
import { useAssocJob } from './assocJob';
import { buildRequest, choicesFor, DEFAULT_DRAFT, hasClusters, markChoices, presets, RESPONSES, setChoices, type AssocDraft } from './assocRequest';
import { AssocResults } from './AssocResults';
import type { FeatureSet } from './types';

const MODES: AssocMode[] = ['M1', 'M2', 'M3', 'M4'];
const LIVE = new Set(['queued', 'running', 'cancelling']);

const STRATA_TEXT: Record<AssocMode, string> = {
  M1: 'Per pair: channel × openness bins, plus mark-density bins when A or B is a footprint or nucleosome type. Pooled: adjusted for density, openness and channel, variance clustered by molecule.',
  M2: 'Within anchor × mark-density stratum (12 bins) × coverage of each flank bin; matched random backgrounds (coverage and site-density deciles) for Δ site.',
  M3: 'Within each molecule (inside versus outside A on its own measured bases); circular shifts keep each molecule\'s exposure.',
  M4: 'Territory where both sets were scanned; A clusters relocate within strata (one per contig unless a strata BED is given).',
};

/** A draft prefilled from the hub (a selection's set as A). */
export interface AssocSeed { aKey?: string; mode?: AssocMode }

export function AssocTab({ sets, scans, seed }: { sets: FeatureSet[]; scans: ScanInfo[]; seed?: AssocSeed | null }) {
  const hub = useBrowserStore(s => s.featureHub);
  const setHub = useBrowserStore(s => s.setFeatureHub);
  const datasets = useBrowserStore(s => s.datasets);
  const job = useAssocJob(s => s.job);
  const shownId = useAssocJob(s => s.shown);
  const error = useAssocJob(s => s.error);
  const [draft, setDraft] = useState<AssocDraft>(DEFAULT_DRAFT);
  const [problem, setProblem] = useState('');
  const chrom = useBrowserStore(s => s.chrom);
  const vStart = useBrowserStore(s => s.start);
  const vEnd = useBrowserStore(s => s.end);
  const all = useMemo(() => setChoices(sets, hub.anchors, { chrom, start: vStart, end: vEnd }), [sets, hub.anchors, chrom, vStart, vEnd]);
  const marks = useMemo(() => markChoices(scans), [scans]);
  const { a: aChoices, b: bChoices } = choicesFor(draft.mode, all, marks);
  const natives = datasets.filter(d => (d as { data_type?: string }).data_type !== 'bam_livelift').length;
  const qs = useMemo(() => presets(all, marks, natives), [all, marks, natives]);
  const clusters = useBrowserStore(s => hasClusters(s));
  const live = job && LIVE.has(job.status);
  const patch = (p: Partial<AssocDraft>) => { setProblem(''); setDraft(d => ({ ...d, ...p })); };
  const patchOptions = (p: Partial<AssocDraft['options']>) => setDraft(d => ({ ...d, options: { ...d.options, ...p } }));

  useEffect(() => { if (seed?.aKey) patch({ aKey: seed.aKey, ...(seed.mode ? { mode: seed.mode } : {}) }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [seed]);

  const runs = hub.assocRuns;
  const shown = runs.find(r => r.id === shownId) ?? (shownId === null ? runs[runs.length - 1] : undefined);
  const submit = () => {
    const built = buildRequest(draft, { all, marks, state: useBrowserStore.getState(), anchors: hub.anchors });
    if ('error' in built) { setProblem(built.error); return; }
    void useAssocJob.getState().submit(built.request);
  };
  const rerun = (id: string) => {
    const run = runs.find(r => r.id === id);
    if (!run) return;
    // a kept run whose browser-set hits were cut can't be run again as it was: rebuild it in the builder
    if (run.definition.truncated) { setProblem('This run\'s browser-set hits were cut when it was kept with the session: rebuild it in the builder to run it again.'); return; }
    void useAssocJob.getState().submit(run.definition);
  };
  const remove = (id: string) => {
    setHub(h => ({ assocRuns: h.assocRuns.filter(r => r.id !== id) }));
    if (shownId === id) useAssocJob.getState().show(null);
  };
  const pick = (key: string, list: typeof all, value: string, onChange: (v: string) => void, testId: string, label: string, needStates = false) =>
    <label className="flex min-w-0 items-center gap-1 text-[11px]">
      <span className="w-14 shrink-0 font-medium">{label}</span>
      <select className="input-tool min-h-0 min-w-0 flex-1 rounded px-1.5 py-0.5 text-[11px]" value={value} onChange={e => onChange(e.target.value)} data-testid={testId} aria-label={label}>
        <option value="">Choose…</option>
        {list.map(c => <option key={`${key}-${c.key}`} value={c.key} disabled={(needStates && !c.hasStates) || (c.kind === 'marks' && Boolean(c.why))}
          title={(needStates && !c.hasStates) || c.kind === 'marks' ? c.why : undefined}>{c.label}{(needStates && !c.hasStates) || (c.kind === 'marks' && c.why) ? ` — ${c.why}` : ''}</option>)}
      </select>
    </label>;

  return <div className="space-y-2" data-testid="assoc-tab">
    <section className="space-y-1" data-testid="assoc-presets">
      <div className="text-[11px] font-medium text-ink-secondary">Example questions</div>
      <div className="grid gap-1">
        {qs.map(q => <button key={q.id} type="button" data-testid={`assoc-preset-${q.id}`} disabled={Boolean(live)}
          className="rounded-fb border border-line px-2 py-1 text-left hover:bg-indigo-50/60 disabled:opacity-60 dark:border-white/10 dark:hover:bg-indigo-950/30"
          title={q.note} onClick={() => { setProblem(q.missing ? `This question needs ${q.missing}.` : ''); setDraft(d => ({ ...d, ...q.draft })); }}>
          <span className="font-medium">{q.question}</span>
          <span className="block text-[10px] text-ink-muted">{q.missing ? `Needs ${q.missing}.` : q.note}</span>
        </button>)}
      </div>
    </section>

    <section className="space-y-1 rounded-fb border border-line px-2 py-1.5 dark:border-white/10" data-testid="assoc-builder">
      <label className="flex items-center gap-1 text-[11px]">
        <span className="w-14 shrink-0 font-medium">Mode</span>
        <select className="input-tool min-h-0 flex-1 rounded px-1.5 py-0.5 text-[11px]" value={draft.mode} data-testid="assoc-mode" aria-label="Mode"
          onChange={e => patch({ mode: e.target.value as AssocMode, aKey: '', bKey: e.target.value === 'M3' ? 'tf' : '' })}>
          {MODES.map(m => <option key={m} value={m}>{m} · {MODE_SHORT[m]}: {MODE_LABELS[m]}</option>)}
        </select>
      </label>
      {pick('a', aChoices, draft.aKey, v => patch({ aKey: v }), 'assoc-a', draft.mode === 'M2' ? 'A (anchors)' : 'A', draft.mode === 'M1')}
      {draft.mode === 'M2'
        ? <label className="flex items-center gap-1 text-[11px]"><span className="w-14 shrink-0 font-medium">Response</span>
          <select className="input-tool min-h-0 min-w-0 flex-1 rounded px-1.5 py-0.5 text-[11px]" value={draft.response} data-testid="assoc-response" aria-label="Response"
            onChange={e => patch({ response: e.target.value })}>{RESPONSES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
        : pick('b', bChoices, draft.mode === 'M3' ? 'tf' : draft.bKey, v => patch({ bKey: v }), 'assoc-b', 'B', draft.mode === 'M1')}
      <div className="text-[11px] text-ink-muted" data-testid="assoc-unit">Unit: {MODE_UNITS[draft.mode]}</div>
      <label className="flex items-center gap-1 text-[11px]"><span className="w-14 shrink-0 font-medium">Group</span>
        <select className="input-tool min-h-0 flex-1 rounded px-1.5 py-0.5 text-[11px]" value={draft.group} data-testid="assoc-group" aria-label="Group"
          onChange={e => patch({ group: e.target.value as AssocDraft['group'] })}>
          <option value="none">None (pooled)</option>
          <option value="dataset">Datasets (interaction)</option>
          <option value="haplotype">Haplotypes (HP tags or MAT/PAT; unphased shown apart)</option>
          <option value="cluster" disabled={!clusters}>Cluster labels of the shown run{clusters ? '' : ' (none shown)'}</option>
        </select></label>
      {draft.group === 'cluster' && <label className="ml-14 flex items-center gap-1 text-[11px]">
        <input type="checkbox" checked={draft.acceptPostSelection} onChange={e => patch({ acceptPostSelection: e.target.checked })} data-testid="assoc-accept-post" />
        If the cluster run used this window, show the numbers without p-values (post-selection)
      </label>}
      <div className="flex flex-wrap items-center gap-1 text-[11px]"><span className="w-14 shrink-0 font-medium">Scope</span>
        <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={draft.scope} data-testid="assoc-scope" aria-label="Scope"
          onChange={e => patch({ scope: e.target.value as AssocDraft['scope'] })}>
          <option value="view">In view</option><option value="bed">Regions (BED file)</option>
          <option value="anchors" disabled={!hub.anchors.length}>Around an anchor set</option><option value="scan">The scans' whole territory</option>
        </select>
        {draft.scope === 'bed' && <input className="input-tool min-w-0 flex-1 text-[11px]" placeholder="path to a BED file (e.g. enhancers)" value={draft.bed}
          onChange={e => patch({ bed: e.target.value })} data-testid="assoc-bed" />}
        {draft.scope === 'anchors' && <>
          <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={draft.anchorSetId} onChange={e => patch({ anchorSetId: e.target.value })} aria-label="Anchor set">
            <option value="">Choose…</option>{hub.anchors.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          ± <input type="number" min={0} step={500} className="input-tool w-20 text-[11px]" value={draft.anchorFlank} onChange={e => patch({ anchorFlank: Math.max(0, Number(e.target.value) || 0) })} aria-label="Flank" /> bp
        </>}
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-ink-secondary">Strata and settings</summary>
        <p className="text-ink-muted" data-testid="assoc-strata">{STRATA_TEXT[draft.mode]}</p>
        <div className="flex flex-wrap items-center gap-2">
          {draft.mode === 'M1' && <>
            <label>Pairs within <input type="number" min={0} step={1000} className="input-tool w-20 text-[11px]" value={draft.options.maxDistance}
              onChange={e => patchOptions({ maxDistance: Math.max(0, Number(e.target.value) || 0) })} /> bp</label>
            <label>Pooled test <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={draft.options.test} onChange={e => patchOptions({ test: e.target.value as 'adjusted' | 'strata' })}>
              <option value="adjusted">adjusted score (default)</option><option value="strata">design strata (MH)</option></select></label>
            <label>Density <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={draft.options.density} onChange={e => patchOptions({ density: e.target.value as 'rho_read' | 'lambda_acc' })}>
              <option value="rho_read">mark density (rho_read)</option><option value="lambda_acc">accessible-mark rate (lambda_acc)</option></select></label>
          </>}
          {draft.mode === 'M2' && draft.response === 'phasing' && <>
            <label>Metric <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={draft.options.metric} onChange={e => patchOptions({ metric: e.target.value as 'R' | 'R_minus_null' })}>
              <option value="R_minus_null">R − null (default)</option><option value="R">R</option></select></label>
            <label><input type="checkbox" checked={draft.options.frames?.includes('molecule')} onChange={e => patchOptions({ frames: e.target.checked ? ['anchor', 'molecule'] : ['anchor'] })} /> molecule frame too</label>
          </>}
          {draft.mode === 'M2' && draft.response !== 'phasing' && <label>Anchor BED (others are backgrounds) <input className="input-tool w-48 text-[11px]" value={draft.options.anchorBed ?? ''}
            onChange={e => patchOptions({ anchorBed: e.target.value || undefined })} /></label>}
          {draft.mode === 'M4' && <label>Strata BED (chrom start end label) <input className="input-tool w-48 text-[11px]" value={draft.options.strataBed ?? ''}
            onChange={e => patchOptions({ strataBed: e.target.value || undefined })} /></label>}
          <label>Permutations <input type="number" min={20} step={100} className="input-tool w-20 text-[11px]" value={draft.options.nPerm} onChange={e => patchOptions({ nPerm: Number(e.target.value) || 1000 })} /></label>
          <label>Bootstrap <input type="number" min={0} step={100} className="input-tool w-20 text-[11px]" value={draft.options.nBoot} onChange={e => patchOptions({ nBoot: Number(e.target.value) || 0 })} /></label>
          <label>Seed <input type="number" min={0} className="input-tool w-16 text-[11px]" value={draft.options.seed} onChange={e => patchOptions({ seed: Number(e.target.value) || 0 })} /></label>
        </div>
      </details>
      <div className="flex items-center gap-2">
        <AnalysisButton theme="indigo" variant="primary" disabled={Boolean(live)} onClick={submit} data-testid="assoc-run">Run</AnalysisButton>
        {(problem || error) && <span role="status" className="text-[11px] text-amber-800 dark:text-amber-300" data-testid="assoc-problem">{problem || error}</span>}
      </div>
    </section>

    {job && <JobStatus testId="assoc-job" title="Association" state={job.status === 'complete' ? 'complete' : job.status === 'error' ? 'error' : job.status === 'cancelled' ? 'cancelled' : job.status === 'cancelling' ? 'cancelling' : job.status === 'queued' ? 'queued' : 'running'}
      stage={job.stage ?? null} message={live ? job.message : undefined} runKey={job.job_id} startedAt={job.created_at} finishedAt={job.finished_at ?? null}
      onCancel={live ? () => { void useAssocJob.getState().cancel(); } : undefined}
      result={job.status === 'complete' ? 'Done: results below' : job.error ?? undefined} />}

    {runs.length > 0 && <section className="space-y-0.5" data-testid="assoc-runs">
      <div className="text-[11px] font-medium text-ink-secondary">Runs (kept with the session)</div>
      {[...runs].reverse().map(r => <button key={r.id} type="button" data-testid="assoc-run-item" data-selected={shown?.id === r.id ? 'true' : 'false'}
        className={`flex w-full items-center gap-2 rounded-fb px-1 text-left text-[11px] ${shown?.id === r.id ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-gray-50 dark:hover:bg-white/5'}`}
        onClick={() => useAssocJob.getState().show(r.id)}>
        <span className="min-w-0 flex-1 truncate">{r.label}</span>
        <span className="text-ink-muted">{r.status !== 'complete' ? r.status : r.result?.status === 'ok' ? 'ran' : r.result?.status ?? ''}</span>
      </button>)}
    </section>}

    {shown && <AssocResults key={shown.id} run={shown} onRerun={() => rerun(shown.id)} onRemove={() => remove(shown.id)} />}
  </div>;
}
