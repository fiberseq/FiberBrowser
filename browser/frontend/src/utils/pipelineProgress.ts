/** How a fiberhmm-pipeline job reads in the UI: status, per-step progress, ETA, result numbers. */
import type { JobStatus, PipelineJob, PipelineStep, ResultSummary } from '../api/pipeline';

export type Tone = 'info' | 'ok' | 'warn' | 'error' | 'muted';

export const STATUS_TEXT: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting', tone: 'muted' },
  running: { label: 'Running', tone: 'info' },
  cancelling: { label: 'Cancelling', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  interrupted: { label: 'Stopped', tone: 'error' },
};

export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 45) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface StepView {
  name: string;
  label: string;
  status: PipelineStep['status'];
  percent: number | null;
  detail: string | null;
}

export function describeStep(step: PipelineStep): StepView {
  let percent: number | null = null;
  const parts: string[] = [];
  if (step.status === 'done') percent = 100;
  else if (step.total && step.total > 0 && step.done !== undefined) {
    percent = Math.max(0, Math.min(100, (100 * step.done) / step.total));
  }
  if (step.status === 'running') {
    if (step.total && step.unit && step.unit !== 'permille') {
      parts.push(`${formatCount(step.done ?? 0)} / ${formatCount(step.total)} ${step.unit}`);
    }
    if (step.rate && step.unit && step.unit !== 'permille') parts.push(`${formatCount(step.rate)} ${step.unit}/s`);
    const eta = formatEta(step.eta_s);
    if (eta) parts.push(eta);
    if (!parts.length && step.message) parts.push(step.message);
  } else if (step.status === 'skipped') {
    parts.push(step.message && step.message !== 'complete' ? `skipped: ${step.message}` : 'already done (reused)');
  } else if (step.status === 'done') {
    // A count without a total (basecalling: "40 reads"), then how long the step took.
    if (step.done !== undefined && step.done !== null && step.unit && !step.total && step.unit !== 'permille') {
      parts.push(`${formatCount(step.done)} ${step.unit}`);
    }
    const took = step.started_at && step.finished_at ? formatDuration(step.finished_at - step.started_at) : null;
    if (took) parts.push(took);
  }
  return { name: step.name, label: step.label, status: step.status, percent, detail: parts.length ? parts.join(' · ') : null };
}

export interface JobView {
  statusLabel: string;
  tone: Tone;
  /** Overall progress 0-100 (steps done plus the running step's share), null before the start event. */
  percent: number | null;
  headline: string;
  steps: StepView[];
}

export function describeJob(job: Pick<PipelineJob, 'status' | 'progress' | 'error' | 'started_at' | 'finished_at'>): JobView {
  const status = STATUS_TEXT[job.status] ?? { label: job.status, tone: 'muted' as Tone };
  const steps = (job.progress?.steps ?? []).map(describeStep);
  let percent = job.progress?.fraction === null || job.progress?.fraction === undefined
    ? null : Math.round(1000 * job.progress.fraction) / 10;
  if (job.status === 'done') percent = 100;
  let headline: string;
  if (job.status === 'queued') headline = 'Waiting for a free slot (other runs are using the cores).';
  else if (job.status === 'running' || job.status === 'cancelling') {
    const current = steps.find(s => s.status === 'running');
    if (job.status === 'cancelling') headline = 'Stopping…';
    else if (current) headline = current.detail ? `${current.label}: ${current.detail}` : `${current.label}…`;
    else headline = job.progress?.started ? 'Working…' : 'Starting…';
  } else if (job.status === 'done') {
    const took = job.started_at && job.finished_at ? formatDuration(job.finished_at - job.started_at) : null;
    headline = took ? `Finished in ${took}.` : 'Finished.';
  } else {
    headline = job.error || status.label;
  }
  return { statusLabel: status.label, tone: status.tone, percent, headline, steps };
}

export interface SummaryItem {
  label: string;
  value: string;
  title?: string;
}

export function summaryItems(summary: ResultSummary | null | undefined): SummaryItem[] {
  if (!summary) return [];
  const approx = summary.approximate ? '≥ ' : '';
  const items: SummaryItem[] = [
    ...(summary.reads_basecalled !== undefined && summary.reads_basecalled !== null
      ? [{ label: 'Reads basecalled', value: formatCount(summary.reads_basecalled), title: 'Reads dorado basecalled from the POD5 input.' }]
      : []),
    { label: 'Reads aligned', value: approx + formatCount(summary.reads_aligned) },
    { label: 'Reads called', value: approx + formatCount(summary.reads_called) },
    {
      label: 'Duplicates',
      value: summary.duplicate_percent === null || summary.duplicate_percent === undefined ? '—' : `${summary.duplicate_percent.toFixed(1)}%`,
      title: 'PCR duplicates marked (0x400) by fiberhmm-call: kept in the BAM, left out of QC.',
    },
    {
      label: 'Footprints / read',
      value: summary.footprints_per_read === null || summary.footprints_per_read === undefined ? '—' : summary.footprints_per_read.toFixed(1),
      title: 'Nucleosome and TF footprints per called read (fiberhmm-qc sample).',
    },
  ];
  return items;
}

/** A failed or stopped job whose basecalling did not finish: Retry resumes it (dorado keeps what it wrote). */
export function resumesBasecall(job: Pick<PipelineJob, 'status' | 'progress'>): boolean {
  if (!['error', 'cancelled', 'interrupted'].includes(job.status)) return false;
  const step = (job.progress?.steps ?? []).find(s => s.name === 'basecall');
  return Boolean(step && step.status !== 'done' && step.status !== 'skipped');
}

export function isActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling';
}
