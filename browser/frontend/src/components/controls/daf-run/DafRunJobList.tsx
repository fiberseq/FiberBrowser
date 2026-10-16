import { useEffect, useState } from 'react';
import {
  cancelJob, forgetJob, getJobLog, getJobQc, retryJob, type PipelineJob, type QcPayload,
} from '../../../api/pipeline';
import { describeJob, isActive, resumesBasecall, summaryItems, type Tone } from '../../../utils/pipelineProgress';
import { basecallerLabel, basecallerTitle } from '../../../utils/basecaller';
import { openJobResult } from '../../../utils/pipelineResults';
import { ENZYME_INFO } from '../../../utils/dafRun';
import { useDafRunStore } from './dafRunStore';
import { QcReport, VerdictChip } from './QcReport';
import { stateSummary, verdictBasisTitle } from '../../../utils/qcView';
import { CheckCircle, Circle, CircleDashed, CircleHalf } from '../../ui/Icons';

const TONE: Record<Tone, string> = {
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  muted: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300',
};

const BAR: Record<Tone, string> = {
  info: 'bg-blue-500', ok: 'bg-emerald-500', warn: 'bg-amber-500', error: 'bg-red-500', muted: 'bg-gray-400',
};

const STEP_ICON: Record<string, typeof Circle> = { pending: Circle, running: CircleHalf, done: CheckCircle, skipped: CircleDashed };

const BUTTON = 'px-2 py-0.5 rounded border text-[11px] border-gray-300 dark:border-white/15 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';

function copy(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function JobCard({ job, compact = false }: { job: PipelineJob; compact?: boolean }) {
  const upsert = useDafRunStore(s => s.upsert);
  const remove = useDafRunStore(s => s.remove);
  const focused = useDafRunStore(s => s.focusJobId === job.id);
  const [showSteps, setShowSteps] = useState(!compact);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState('');
  const [qc, setQc] = useState<QcPayload | null>(null);
  const [showQc, setShowQc] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const view = describeJob(job);
  const active = isActive(job.status);

  useEffect(() => {
    if (!showLog) return;
    let stop = false;
    const load = () => getJobLog(job.id).then(text => { if (!stop) setLog(text); }).catch(() => {});
    load();
    if (!active) return () => { stop = true; };
    const timer = window.setInterval(load, 2000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [showLog, active, job.id]);

  useEffect(() => {
    if (!showQc || qc || job.status !== 'done') return;
    getJobQc(job.id).then(setQc).catch(err => setQc({ available: false, qc: null, curves: null, plots: {}, error: String(err) }));
  }, [showQc, qc, job.id, job.status]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const qcStatus = job.summary?.qc_status ?? null;

  return (
    <div
      className={`rounded-lg border p-2 space-y-1.5 ${focused ? 'border-blue-400 dark:border-blue-500/60' : 'border-gray-200 dark:border-white/10'} bg-white/70 dark:bg-white/[0.03]`}
      data-testid="daf-run-job"
      data-job-id={job.id}
      data-job-status={job.status}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-[12.5px] text-gray-800 dark:text-gray-100 truncate" title={job.outdir}>{job.sample}</span>
        {job.user && <span className="text-[11px] text-gray-500 dark:text-gray-400 truncate" data-testid="daf-run-owner">by {job.user}</span>}
        <span className="text-[11px] text-gray-400">{ENZYME_INFO[job.enzyme]?.label ?? job.enzyme}</span>
        {job.reference?.label && <span className="text-[11px] text-gray-400 truncate">· {job.reference.label}</span>}
        <span className={`ml-auto flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[view.tone]}`} data-testid="daf-run-job-status">
          {view.statusLabel}
        </span>
      </div>
      {(active || job.status === 'done') && (
        <div className="h-1.5 w-full rounded bg-gray-200 dark:bg-white/10 overflow-hidden" aria-label="progress">
          <div className={`h-full ${BAR[view.tone]} transition-all`} style={{ width: `${view.percent ?? 2}%` }} />
        </div>
      )}
      <div className={`text-[11.5px] ${view.tone === 'error' ? 'text-red-700 dark:text-red-300' : 'text-gray-600 dark:text-gray-300'} break-words`} data-testid="daf-run-job-headline">
        {view.headline}
      </div>
      {job.hint && (
        <div className="text-[11px] rounded bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100 px-2 py-1 whitespace-pre-wrap" data-testid="daf-run-job-hint">{job.hint}</div>
      )}
      {job.option_labels?.length > 0 && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400">Options: {job.option_labels.join(', ')}</div>
      )}
      {job.status === 'done' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="daf-run-job-summary">
          {summaryItems(job.summary).map(item => (
            <span key={item.label} title={item.title} className="text-[11px] text-gray-500 dark:text-gray-400">
              {item.label} <span className="font-medium text-gray-800 dark:text-gray-100">{item.value}</span>
            </span>
          ))}
          {!job.summary && <span className="text-[11px] text-gray-400">Counting reads…</span>}
          {job.outputs?.settings?.basecaller && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400" title={basecallerTitle(job.outputs.settings.basecaller)}
              data-testid="daf-run-job-basecaller">
              Basecaller <span className="font-medium text-gray-800 dark:text-gray-100">{basecallerLabel(job.outputs.settings.basecaller)}</span>
            </span>
          )}
          {qcStatus && <VerdictChip label="QC" status={qcStatus} title={verdictBasisTitle(job.outputs?.qc?.verdicts)} />}
          {stateSummary(job.outputs?.qc?.verdicts).map(item => (
            <span key={item.label} title={item.title} className="text-[11px] text-gray-500 dark:text-gray-400" data-testid={`daf-run-qc-${item.label.toLowerCase()}`}>
              {item.label} <span className="font-medium text-gray-800 dark:text-gray-100">{item.value}</span>
            </span>
          ))}
        </div>
      )}
      {showSteps && view.steps.length > 0 && (
        <ol className="space-y-0.5" data-testid="daf-run-job-steps">
          {view.steps.map(step => (
            <li key={step.name} className="flex items-baseline gap-1.5 text-[11px]" data-step={step.name} data-step-status={step.status}>
              {(() => { const StepIcon = STEP_ICON[step.status] ?? Circle; return (
                <StepIcon size={11} aria-label={step.status} role="img"
                  className={`flex-shrink-0 self-center ${step.status === 'running' ? 'text-blue-500 animate-pulse' : step.status === 'done' ? 'text-emerald-500' : 'text-gray-400'}`} />
              ); })()}
              <span className={step.status === 'pending' ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200'}>{step.label}</span>
              {step.percent !== null && step.status === 'running' && <span className="text-gray-500">{Math.round(step.percent)}%</span>}
              {step.detail && <span className="text-gray-400 truncate">{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-1 pt-0.5">
        {job.status === 'done' && (
          <button
            type="button"
            className="px-2 py-0.5 rounded text-[11px] bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => act('open', async () => {
              const result = await openJobResult(job);
              setMessage(result.success ? (result.message ?? 'Opened.') : (result.error ?? 'Could not open the results.'));
            })}
            data-testid="daf-run-open-result"
          >
            {busy === 'open' ? 'Opening…' : 'Open in browser'}
          </button>
        )}
        {job.status === 'done' && (
          <button type="button" className={BUTTON} onClick={() => setShowQc(v => !v)} data-testid="daf-run-show-qc">
            {showQc ? 'Hide QC' : 'QC report'}
          </button>
        )}
        {active && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy !== null || job.status === 'cancelling'}
            onClick={() => act('cancel', async () => upsert([await cancelJob(job.id)]))}
            data-testid="daf-run-cancel"
          >
            Cancel
          </button>
        )}
        {(job.status === 'error' || job.status === 'cancelled' || job.status === 'interrupted') && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy !== null}
            title={resumesBasecall(job)
              ? 'Resume: dorado keeps the reads it already basecalled and does the rest; later steps follow'
              : 'Run again; steps that already finished are reused'}
            onClick={() => act('retry', async () => upsert([await retryJob(job.id)]))}
            data-testid="daf-run-retry"
          >
            {resumesBasecall(job) ? 'Resume basecalling' : 'Retry'}
          </button>
        )}
        <button type="button" className={BUTTON} onClick={() => setShowSteps(v => !v)}>{showSteps ? 'Hide steps' : 'Steps'}</button>
        <button type="button" className={BUTTON} onClick={() => setShowLog(v => !v)} data-testid="daf-run-view-log">
          {showLog ? 'Hide log' : 'View log'}
        </button>
        {job.command && (
          <button
            type="button"
            className={BUTTON}
            title={job.command}
            onClick={() => act('copy', async () => setMessage(await copy(job.command!) ? 'Command copied.' : job.command!))}
            data-testid="daf-run-copy-command"
          >
            Copy command
          </button>
        )}
        <button
          type="button"
          className={BUTTON}
          title={job.outdir}
          onClick={() => act('copy', async () => setMessage(await copy(job.outdir) ? `Copied ${job.outdir}` : job.outdir))}
        >
          Copy folder path
        </button>
        {!active && (
          <button
            type="button"
            className={`${BUTTON} ml-auto`}
            title="Remove from this list (the output folder is kept)"
            onClick={() => act('forget', async () => { await forgetJob(job.id); remove(job.id); })}
          >
            Remove
          </button>
        )}
      </div>
      {message && <div className="text-[11px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-all" data-testid="daf-run-job-message">{message}</div>}
      {showLog && (
        <pre className="max-h-56 overflow-auto rounded bg-gray-900 text-gray-100 text-[11px] p-2 whitespace-pre-wrap break-all" data-testid="daf-run-log">
          {log || 'The log is empty so far.'}
        </pre>
      )}
      {showQc && (
        <div className="border-t border-gray-200 dark:border-white/10 pt-2">
          {qc ? <QcReport payload={qc} /> : <div className="text-[11px] text-gray-400">Loading QC…</div>}
        </div>
      )}
    </div>
  );
}

export function DafRunJobList({ compact = false, limit }: { compact?: boolean; limit?: number }) {
  const jobs = useDafRunStore(s => s.jobs);
  const loaded = useDafRunStore(s => s.loaded);
  const error = useDafRunStore(s => s.error);
  const shown = limit ? jobs.slice(0, limit) : jobs;
  if (error) return <div className="text-[11px] text-red-600">{error}</div>;
  if (!loaded) return <div className="text-[11px] text-gray-400">Loading runs…</div>;
  if (!jobs.length) return <div className="text-[11.5px] text-gray-500 dark:text-gray-400" data-testid="daf-run-no-jobs">No runs yet.</div>;
  return (
    <div className="space-y-2" data-testid="daf-run-job-list">
      {shown.map(job => <JobCard key={job.id} job={job} compact={compact} />)}
      {limit && jobs.length > limit && <div className="text-[11px] text-gray-400">{jobs.length - limit} older run(s) in the Runs tab.</div>}
    </div>
  );
}
