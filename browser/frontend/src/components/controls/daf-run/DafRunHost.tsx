import { useEffect, useRef, useState } from 'react';
import { runDatasetQc, type QcPayload } from '../../../api/pipeline';
import { getStatus } from '../../../api/status';
import { useBrowserStore } from '../../../stores/browserStore';
import { describeJob } from '../../../utils/pipelineProgress';
import { markJobOpened, openJobResult, openedJobs } from '../../../utils/pipelineResults';
import { DafRunJobList } from './DafRunJobList';
import { DafRunWizard } from './DafRunWizard';
import { activeJobs, OPEN_DAF_RUN_EVENT, useDafRunStore, type DafRunTab } from './dafRunStore';
import { QcFilePicker } from './QcFilePicker';
import { QcReport } from './QcReport';
import { isOwnRun, labRunsAvailable } from '../../../utils/labServer';
import { Dna, X } from '../../ui/Icons';

const AUTO_OPEN_WINDOW_S = 24 * 3600;

const QC_ENZYMES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Chemistry: automatic' },
  { id: 'dddb', label: 'DddB' },
  { id: 'ddda', label: 'DddA' },
  { id: 'hia5', label: 'Hia5 (Fiber-seq)' },
];

/** A QC result and the request it answers (dataset and chemistry). */
type QcResult = { key: string; datasetLabel: string; enzyme: string; payload: QcPayload };

function DatasetQcTab() {
  const datasets = useBrowserStore(s => s.datasets);
  const bams = datasets.filter(d => (d.data_type ?? 'bam') === 'bam');
  const [datasetId, setDatasetId] = useState('');
  const [enzyme, setEnzyme] = useState('auto');
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<QcResult | null>(null);
  // The latest request: a response to any earlier one (another dataset or chemistry) is dropped.
  const latest = useRef(0);
  const chosen = datasetId || bams[0]?.id || '';
  const key = `${chosen}\u0000${enzyme}`;
  const chosenLabel = bams.find(d => d.id === chosen)?.label ?? chosen;
  const enzymeLabel = (id: string) => (id === 'auto' ? 'chemistry from the BAM header' : QC_ENZYMES.find(e => e.id === id)?.label ?? id);
  const invalidate = () => { latest.current += 1; setRunning(null); setResult(null); };
  // Only what was asked for this dataset and chemistry is shown.
  const shown = result && result.key === key ? result : null;
  const isRunning = running === key;
  return (
    <div className="space-y-2" data-testid="daf-run-dataset-qc">
      <div className="text-[12px] text-gray-600 dark:text-gray-300">
        Run fiberhmm-qc on a FiberHMM BAM: verdicts, efficiency and background (the rates inside and outside MSPs), the per-read deamination (or m6A) CDF, periodicity and footprint sizes against the bundled reference.
      </div>
      {bams.length === 0 ? (
        <QcFilePicker />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select className="text-[12px] px-2 py-1 border rounded dark:bg-gray-900 dark:border-gray-600" value={chosen} onChange={e => { invalidate(); setDatasetId(e.target.value); }}>
            {bams.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <select className="text-[12px] px-2 py-1 border rounded dark:bg-gray-900 dark:border-gray-600" value={enzyme} onChange={e => { invalidate(); setEnzyme(e.target.value); }} title="Chemistry (automatic reads the BAM header)">
            {QC_ENZYMES.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <button
            type="button"
            className="px-3 py-1 rounded bg-blue-500 text-white text-[12px] hover:bg-blue-600 disabled:opacity-40"
            disabled={isRunning || !chosen}
            onClick={async () => {
              const request = ++latest.current;
              const asked = { key, datasetLabel: chosenLabel, enzyme };
              setRunning(key);
              setResult(null);
              let payload: QcPayload;
              try {
                payload = await runDatasetQc(chosen, enzyme);
              } catch (err) {
                payload = { available: false, success: false, error: err instanceof Error ? err.message : String(err), qc: null, curves: null, plots: {} };
              }
              if (request !== latest.current) return;  // superseded: another dataset or chemistry
              setResult({ ...asked, payload });
              setRunning(null);
            }}
            data-testid="daf-run-dataset-qc-run"
          >
            {isRunning ? 'Running QC…' : 'Run QC'}
          </button>
        </div>
      )}
      {shown && (
        <div className="space-y-1" data-testid="daf-run-dataset-qc-result">
          <div className="text-[11.5px] text-gray-500 dark:text-gray-400" data-testid="daf-run-dataset-qc-identity">
            QC of <span className="font-medium text-gray-700 dark:text-gray-200">{shown.datasetLabel}</span> ({enzymeLabel(shown.enzyme)})
          </div>
          {shown.payload.success === false || shown.payload.error
            ? <div className="text-[12px] text-red-600">{shown.payload.error}</div>
            : <QcReport payload={shown.payload} />}
        </div>
      )}
    </div>
  );
}

const TABS: { id: DafRunTab; label: string }[] = [
  { id: 'new', label: 'New DAF-seq run' },
  { id: 'runs', label: 'Runs' },
  { id: 'qc', label: 'QC a dataset' },
];

function DafRunDialog() {
  const open = useDafRunStore(s => s.open);
  const tab = useDafRunStore(s => s.tab);
  const setOpen = useDafRunStore(s => s.setOpen);
  const setTab = useDafRunStore(s => s.setTab);
  const jobs = useDafRunStore(s => s.jobs);
  const running = activeJobs(jobs).length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center overflow-y-auto py-6"
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="absolute inset-0 bg-brand-950/45 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-label="New DAF-seq run"
        className="relative w-full max-w-3xl mx-4 rounded-apple-lg bg-white dark:bg-dark-surface shadow-modal dark:shadow-modal-dark border border-line/70 dark:border-white/10"
        data-testid="daf-run-dialog"
      >
        <div className="flex items-center gap-1 border-b border-line dark:border-white/10 px-3 pt-2">
          <span className="mb-1.5 mr-1.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-fb bg-brand-50 text-brand-700 ring-1 ring-brand-100 dark:bg-brand-400/15 dark:text-brand-300 dark:ring-brand-400/20" aria-hidden="true"><Dna size={15} /></span>
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] transition-colors ${tab === t.id ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-200 font-semibold' : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}
              data-testid={`daf-run-tab-${t.id}`}
            >
              {t.label}{t.id === 'runs' && running > 0 ? ` (${running} running)` : ''}
            </button>
          ))}
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fb-icon-btn ml-auto mb-1"><X size={16} /></button>
        </div>
        <div className="p-4 max-h-[78vh] overflow-y-auto">
          {tab === 'new' && <DafRunWizard />}
          {tab === 'runs' && <DafRunJobList />}
          {tab === 'qc' && <DatasetQcTab />}
        </div>
      </div>
    </div>
  );
}

/**
 * Mounted once: the dialog, the "run in progress" chip, the poller that keeps
 * the runs list current (and reconnects to runs after a reload), and the
 * automatic opening of finished runs.
 */
export function DafRunHost() {
  const publicMode = useBrowserStore(s => s.publicMode);
  const jobs = useDafRunStore(s => s.jobs);
  const open = useDafRunStore(s => s.open);
  const setOpen = useDafRunStore(s => s.setOpen);
  const refresh = useDafRunStore(s => s.refresh);
  const pageLoaded = useRef(Date.now() / 1000);
  const [notice, setNotice] = useState<string | null>(null);
  // Only on a local server (a public one refuses the pipeline routes): ask first.
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (publicMode) return;
    let cancelled = false;
    if (!labRunsAvailable()) return;  // a lab server with runs turned off
    getStatus(false).then(status => { if (!cancelled && !status.public_mode) setEnabled(true); }).catch(() => {});
    return () => { cancelled = true; };
  }, [publicMode]);

  useEffect(() => {
    if (publicMode) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: DafRunTab; jobId?: string }>).detail ?? {};
      setOpen(true, detail.tab ?? 'new', detail.jobId ?? null);
      void refresh();
    };
    window.addEventListener(OPEN_DAF_RUN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DAF_RUN_EVENT, onOpen);
  }, [publicMode, refresh, setOpen]);

  // Poll: fast while a run is active or the dialog is open, slow otherwise.
  const anyActive = activeJobs(jobs).length > 0;
  useEffect(() => {
    if (publicMode || !enabled) return;
    let stopped = false;
    void refresh();
    const timer = window.setInterval(() => { if (!stopped) void refresh(); }, anyActive || open ? 1500 : 15000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [publicMode, enabled, anyActive, open, refresh]);

  // Auto-open: runs that asked for it and finished recently, once per browser.
  useEffect(() => {
    if (publicMode) return;
    const opened = openedJobs();
    const now = Date.now() / 1000;
    // On a lab server every member sees every run; only open your own.
    const ready = jobs.find(j => j.status === 'done' && j.auto_open && j.outputs && !opened.has(j.id) && isOwnRun(j)
      && (j.finished_at ?? 0) > Math.min(pageLoaded.current, now) - AUTO_OPEN_WINDOW_S);
    if (!ready) return;
    markJobOpened(ready.id);
    void openJobResult(ready).then(result => {
      setNotice(result.success ? `${ready.sample} finished and is open.` : `${ready.sample} finished; opening failed: ${result.error}`);
      window.setTimeout(() => setNotice(null), 8000);
    });
  }, [jobs, publicMode]);

  if (publicMode) return null;
  const active = activeJobs(jobs);
  const first = active[0];
  return (
    <>
      <DafRunDialog />
      {!open && (first || notice) && (
        <button
          type="button"
          onClick={() => setOpen(true, 'runs', first?.id ?? null)}
          className="fixed bottom-3 left-3 z-[60] max-w-xs rounded-full border border-blue-200 bg-white/95 px-3 py-1.5 text-left text-[11.5px] text-blue-800 shadow-lg hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/95 dark:text-blue-200"
          data-testid="daf-run-chip"
        >
          {first ? (
            <>
              <span className="font-medium">{first.sample}</span>
              {': '}
              {(() => { const v = describeJob(first); return v.percent !== null ? `${Math.round(v.percent)}%` : v.statusLabel; })()}
              {active.length > 1 ? ` (+${active.length - 1} more)` : ''}
            </>
          ) : notice}
        </button>
      )}
    </>
  );
}
