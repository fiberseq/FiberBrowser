import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getPipelineStatus, scanReads, submitRun, validateRun,
  type BasecallSettings, type DoradoStatus, type Enzyme, type InputKind, type PipelineOptions, type PipelineStatus,
  type TriState, type ValidateResult,
} from '../../../api/pipeline';
import { pickAnyFile, pickFolder, uploadFile } from '../../../api/files';
import { loadGenome } from '../../../api/reference';
import {
  BASECALL_DEVICES, BASECALL_MODELS, DEFAULT_BASECALL, ENZYME_INFO, WIZARD_STEPS, basecallSummary, buildRunRequest,
  changedOptionLabels, defaultOutputRoot, enzymesFor, formatBytes, includedSamples, initialWizardState,
  sampleNameError, sampleOutdir, samplesFromScan, stepIssues, type WizardState, type WizardStep,
} from '../../../utils/dafRun';
import { useDafRunStore } from './dafRunStore';

const AUTO_OPEN_KEY = 'fiberbrowser.dafRun.autoOpen';

/** The server's check of one exact run request (its JSON). */
type RunCheck =
  | { key: string; state: 'checking' }
  | { key: string; state: 'done'; result: ValidateResult }
  | { key: string; state: 'failed'; error: string };
const READ_NAME = /\.(fastq|fq)(\.gz)?$|\.bam$|\.zip$/i;

function readAutoOpen(): boolean {
  try {
    return window.localStorage.getItem(AUTO_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveAutoOpen(value: boolean): void {
  try {
    window.localStorage.setItem(AUTO_OPEN_KEY, value ? '1' : '0');
  } catch { /* per-viewer convenience only */ }
}

/** Every read file (and zip) in a drop, walking dropped folders. */
async function droppedReadFiles(items: DataTransferItemList | null, files: FileList): Promise<File[]> {
  const out: File[] = [];
  const entries = items ? Array.from(items).map(item => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[] : [];
  if (!entries.length) return Array.from(files).filter(f => READ_NAME.test(f.name));
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') return;
    if (entry.isFile) {
      if (!READ_NAME.test(entry.name)) return;
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

const INPUT = 'text-[12px] px-2 py-1 border rounded bg-white dark:bg-gray-900 dark:border-gray-600 dark:text-gray-200 min-w-0';
const BUTTON = 'px-2.5 py-1 rounded border text-[12px] border-gray-300 dark:border-white/15 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';

function TriSelect({ value, onChange, testId }: { value: TriState; onChange: (v: TriState) => void; testId?: string }) {
  return (
    <select className={INPUT} value={value} onChange={e => onChange(e.target.value as TriState)} data-testid={testId}>
      <option value="auto">Automatic (default)</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  );
}

/** Whether dorado (not bundled) was found, and where; or how to install it, with Check again. */
export function DoradoLine({ dorado, checking, onCheck, compact = false }: {
  dorado: DoradoStatus | undefined | null;
  checking: boolean;
  onCheck: () => void;
  compact?: boolean;
}) {
  if (!dorado) return <div className="text-[11.5px] text-gray-500" data-testid="daf-run-dorado">Looking for dorado…</div>;
  if (dorado.ok) {
    return (
      <div className="text-[11.5px] text-emerald-700 dark:text-emerald-300 break-all" data-testid="daf-run-dorado" data-dorado="found"
        title={dorado.path ?? ''}>
        dorado {dorado.version} found{compact ? '' : `: ${dorado.path}`}
      </div>
    );
  }
  return (
    <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-600/40 px-3 py-2 text-[11.5px] text-amber-900 dark:text-amber-100 space-y-1"
      data-testid="daf-run-dorado" data-dorado="missing">
      <div className="font-medium">dorado was not found on this computer. FiberBrowser does not include it: install it once, then Check again.</div>
      {!compact && <div className="whitespace-pre-wrap" data-testid="daf-run-dorado-hint">{dorado.hint}</div>}
      <button type="button" className={BUTTON} disabled={checking} onClick={onCheck} data-testid="daf-run-dorado-recheck">
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}

function OptionRow({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-center gap-2 text-[12px]">
      <span className="text-gray-700 dark:text-gray-200" title={help}>{label}</span>
      <span className="flex flex-col gap-0.5 min-w-0">
        {children}
        <span className="text-[11px] text-gray-400">{help}</span>
      </span>
    </label>
  );
}

export function DafRunWizard() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // The draft lives in the store (dafRunStore), so leaving this tab or closing
  // the dialog doesn't lose it.
  const draft = useDafRunStore(s => s.draft);
  const draftSeeded = useDafRunStore(s => s.draftSeeded);
  const updateDraft = useDafRunStore(s => s.updateDraft);
  const markDraftSeeded = useDafRunStore(s => s.markDraftSeeded);
  const clearDraft = useDafRunStore(s => s.clearDraft);
  const fallback = useRef<WizardState | null>(null);
  if (fallback.current === null) fallback.current = initialWizardState(null, readAutoOpen());
  const state: WizardState = draft ?? fallback.current;
  const setState = useCallback((update: (prev: WizardState) => WizardState) => {
    updateDraft(prev => update(prev ?? fallback.current ?? initialWizardState(null, readAutoOpen())));
  }, [updateDraft]);
  const [scanning, setScanning] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  // The server's check of the run, for the exact request it was made for.
  const [check, setCheck] = useState<RunCheck | null>(null);
  const [recheck, setRecheck] = useState(0);
  // Steps where the user tried to go on: missing inputs show as errors there.
  const [attempted, setAttempted] = useState<ReadonlySet<WizardStep>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [checkingDorado, setCheckingDorado] = useState(false);
  const [dragging, setDragging] = useState(false);
  const setTab = useDafRunStore(s => s.setTab);
  const setOpen = useDafRunStore(s => s.setOpen);
  const upsert = useDafRunStore(s => s.upsert);
  const validateSeq = useRef(0);

  const loadStatus = useCallback(async (refresh = false) => {
    try {
      const next = await getPipelineStatus(refresh);
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Could not reach FiberBrowser');
      return null;
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // A new draft starts from the server's defaults (once: a kept draft keeps the user's edits).
  useEffect(() => {
    if (!status || draftSeeded) return;
    markDraftSeeded();
    setState(prev => {
      const fresh = initialWizardState(status, prev.autoOpen);
      // The input kind (and basecalling) the user may have picked while the status loaded are kept.
      return prev.samples.length ? prev : {
        ...fresh, inputKind: prev.inputKind, basecall: prev.basecall,
        options: { ...fresh.options, ...status.default_options },
      };
    });
  }, [status, draftSeeded, markDraftSeeded, setState]);

  const update = useCallback((changes: Partial<WizardState>) => setState(prev => ({ ...prev, ...changes })), [setState]);
  const setOption = useCallback(<K extends keyof PipelineOptions>(key: K, value: PipelineOptions[K]) => {
    setState(prev => ({ ...prev, options: { ...prev.options, [key]: value } }));
  }, [setState]);
  const setBasecall = useCallback(<K extends keyof BasecallSettings>(key: K, value: BasecallSettings[K]) => {
    setState(prev => ({ ...prev, basecall: { ...prev.basecall, [key]: value } }));
  }, [setState]);
  const raw = state.inputKind === 'pod5';
  /** Reads or raw POD5: the picked input is per kind, so switching starts the input afresh. */
  const setInputKind = (kind: InputKind) => {
    if (kind === state.inputKind) return;
    setScanError(null);
    setState(prev => ({
      ...prev, inputKind: kind, inputPaths: [], samples: [], scanWarnings: [],
      enzyme: prev.enzyme && !enzymesFor(kind).includes(prev.enzyme) ? '' : prev.enzyme,
    }));
  };
  const checkDorado = async () => {
    setCheckingDorado(true);
    try {
      await loadStatus(true);
      setRecheck(n => n + 1);
    } finally {
      setCheckingDorado(false);
    }
  };

  // The output folder follows the sample names until the user edits it.
  useEffect(() => {
    if (!status || state.outputTouched) return;
    const root = defaultOutputRoot(status.output_parent, state.samples);
    if (root !== state.outputRoot) update({ outputRoot: root });
  }, [status, state.samples, state.outputTouched, state.outputRoot, update]);

  const addPaths = useCallback(async (paths: string[]) => {
    const wanted = [...new Set([...state.inputPaths, ...paths.filter(Boolean)])];
    if (!wanted.length) return;
    setScanning('Looking for reads…');
    setScanError(null);
    // The draft this scan is for: if it was started over, or its reads changed
    // meanwhile (Clear reads, another add), the answer is stale.
    const revision = useDafRunStore.getState().draftRevision;
    const pathsBefore = state.inputPaths.join('\n');
    const stillThisDraft = () => {
      const store = useDafRunStore.getState();
      return store.draftRevision === revision && (store.draft?.inputPaths ?? []).join('\n') === pathsBefore;
    };
    try {
      const scan = await scanReads(wanted, state.inputKind);
      if (!stillThisDraft()) return;
      if (!scan.success) {
        setScanError(scan.error || 'Could not read those files.');
        return;
      }
      setState(prev => ({ ...prev, inputPaths: wanted, samples: samplesFromScan(scan, prev.samples), scanWarnings: scan.warnings ?? [] }));
      if (!scan.samples.length) setScanError(state.inputKind === 'pod5' ? 'No POD5 files there.' : 'No FASTQ or BAM files there.');
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Could not read those files.');
    } finally {
      setScanning(null);
    }
  }, [state.inputPaths, state.inputKind, setState]);

  const chooseFiles = async () => {
    const picked = await pickAnyFile();
    if (picked.success) await addPaths(picked.paths?.length ? picked.paths : (picked.path ? [picked.path] : []));
  };
  const chooseFolder = async () => {
    const picked = await pickFolder(raw
      ? 'Choose the POD5 folder (MinKNOW\'s pod5/ folder, or any folder of .pod5 files)'
      : 'Choose the folder with your reads (FASTQ, BAM or a Plasmidsaurus .zip)');
    if (picked.success && picked.path) await addPaths([picked.path]);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (state.step !== 0) return;
    if (raw) {
      // POD5 runs are large and must stay where they are: a drop would copy them.
      setScanError('Choose the POD5 folder with Choose POD5 folder… (or paste its path): a dropped folder would be copied.');
      return;
    }
    const files = await droppedReadFiles(e.dataTransfer.items, e.dataTransfer.files);
    if (!files.length) {
      setScanError('Drop FASTQ (.fastq, .fq, .gz), BAM files, a folder of them, or a .zip.');
      return;
    }
    // Browsers hide a dropped file's path: copy it to FiberBrowser (Choose files… avoids the copy).
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setScanning(`Copying ${i + 1} of ${files.length} (${formatBytes(files[i].size)})…`);
      try {
        const res = await uploadFile(files[i]);
        if (res.success && res.path) paths.push(res.path);
      } catch (err) {
        setScanError(`Could not copy ${files[i].name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    setScanning(null);
    await addPaths(paths);
  };

  const downloadGenome = async (genomeId: string) => {
    setDownloading(genomeId);
    try {
      const res = await loadGenome(genomeId);
      if (!res.success || res.fasta_loaded === false) setScanError(res.fasta_error || `Could not download ${genomeId}.`);
      await loadStatus();
    } finally {
      setDownloading(null);
    }
  };

  const issues = useMemo(() => stepIssues(state, state.step, status), [state, status]);
  const errors = useMemo(() => issues.map(i => i.message), [issues]);
  const included = includedSamples(state);
  // Missing inputs are help until the user tries Next/Run on this step; wrong inputs are errors.
  const tried = attempted.has(state.step);
  const shownErrors = issues.filter(i => tried || !i.missing).map(i => i.message);
  const help = tried ? [] : issues.filter(i => i.missing).map(i => i.message);
  const tryStep = (go: () => void) => {
    if (errors.length > 0) {
      setAttempted(prev => new Set(prev).add(state.step));
      return;
    }
    go();
  };

  // Step 3: ask the server (the pipeline, its aligner, the paths) as the user
  // edits. A result belongs to the request it checked: any edit makes it
  // obsolete at once (Checking…), and a failed check says so (Retry) instead
  // of leaving an older answer in charge of Run.
  const requestKey = useMemo(
    () => (state.step === 2 && errors.length === 0 ? JSON.stringify(buildRunRequest(state)) : null),
    [state, errors.length],
  );
  useEffect(() => {
    if (requestKey === null) return;
    const seq = ++validateSeq.current;
    setCheck({ key: requestKey, state: 'checking' });
    const timer = window.setTimeout(() => {
      validateRun(JSON.parse(requestKey))
        .then(result => { if (seq === validateSeq.current) setCheck({ key: requestKey, state: 'done', result }); })
        .catch(err => {
          if (seq === validateSeq.current) {
            setCheck({ key: requestKey, state: 'failed', error: err instanceof Error ? err.message : String(err) });
          }
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [requestKey, recheck]);
  const currentCheck = check && check.key === requestKey ? check : null;
  const validation: ValidateResult | null = currentCheck?.state === 'done' ? currentCheck.result : null;

  const run = async () => {
    setSubmitting(true);
    setSubmitErrors([]);
    const revision = useDafRunStore.getState().draftRevision;
    try {
      saveAutoOpen(state.autoOpen);
      const res = await submitRun(buildRunRequest(state));
      // Started over while it was submitting: the new draft stays as it is.
      if (useDafRunStore.getState().draftRevision !== revision) {
        if (res.success) upsert(res.jobs ?? []);
        return;
      }
      if (!res.success) {
        setSubmitErrors((res.errors ?? []).map(e => (e.hint ? `${e.message} ${e.hint}` : e.message)));
        return;
      }
      upsert(res.jobs ?? []);
      setState(prev => ({ ...initialWizardState(status, prev.autoOpen), options: prev.options }));
      setCheck(null);
      setAttempted(new Set());
      setOpen(true, 'runs', res.jobs?.[0]?.id ?? null);
    } catch (err) {
      setSubmitErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSubmitting(false);
    }
  };

  const toolProblem = status && (!status.available || !status.aligner.ok);
  // The server's dorado error repeats what the status line says: shown once, there.
  const shownValidation = validation ? { ...validation, errors: validation.errors.filter(e => e.field !== 'dorado') } : null;

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="daf-run-wizard"
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (state.step === 0) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <ol className="flex items-center gap-2 text-[12px]">
        {WIZARD_STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              className={`rounded-full px-2.5 py-0.5 ${i === state.step ? 'bg-blue-500 text-white' : i < state.step ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200' : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'}`}
              onClick={() => { if (i < state.step) update({ step: i as WizardStep }); }}
              disabled={i > state.step}
              data-testid={`daf-run-step-${i}`}
            >
              {i + 1}. {label}
            </button>
            {i < WIZARD_STEPS.length - 1 && <span className="text-gray-300">›</span>}
          </li>
        ))}
      </ol>

      {statusError && <div className="text-[12px] text-red-600">{statusError}</div>}
      {toolProblem && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-600/40 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-100 whitespace-pre-wrap" data-testid="daf-run-tool-problem">
          {!status!.available ? status!.hint : status!.aligner.hint}
        </div>
      )}

      {state.step === 0 && (
        <section className="space-y-2">
          <div className="inline-flex rounded-md border border-gray-300 dark:border-white/15 overflow-hidden text-[12px]" role="radiogroup" aria-label="Input">
            {([['reads', 'Reads (FASTQ / BAM)'], ['pod5', 'Raw Nanopore (POD5)']] as [InputKind, string][]).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={state.inputKind === kind}
                className={`px-3 py-1 ${state.inputKind === kind ? 'bg-blue-500 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10'}`}
                onClick={() => setInputKind(kind)}
                data-testid={`daf-run-input-${kind}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className={`rounded-lg border-2 border-dashed px-4 py-5 text-center ${dragging && !raw ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-300 dark:border-white/15'}`}
            data-testid="daf-run-dropzone"
          >
            {raw ? (
              <>
                <div className="text-[13px] text-gray-700 dark:text-gray-200 font-medium">Choose the POD5 folder</div>
                <div className="text-[11.5px] text-gray-500 dark:text-gray-400 mt-0.5">
                  MinKNOW&apos;s pod5/ folder (searched recursively) or .pod5 files. FiberHMM basecalls them with dorado on this computer first, then aligns and calls.
                </div>
              </>
            ) : (
              <>
                <div className="text-[13px] text-gray-700 dark:text-gray-200 font-medium">Drop your reads here</div>
                <div className="text-[11.5px] text-gray-500 dark:text-gray-400 mt-0.5">
                  FASTQ (.fastq, .fq, .gz) or BAM files, a folder, or the .zip Plasmidsaurus sends
                </div>
              </>
            )}
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {raw ? (
                <>
                  <button type="button" className={BUTTON} onClick={chooseFolder} data-testid="daf-run-choose-folder">Choose POD5 folder…</button>
                  <button type="button" className={BUTTON} onClick={chooseFiles} data-testid="daf-run-choose-files">Choose files…</button>
                </>
              ) : (
                <>
                  <button type="button" className={BUTTON} onClick={chooseFiles} data-testid="daf-run-choose-files">Choose files…</button>
                  <button type="button" className={BUTTON} onClick={chooseFolder} data-testid="daf-run-choose-folder">Choose folder…</button>
                </>
              )}
            </div>
            <div className="mt-2 flex gap-1 max-w-lg mx-auto">
              <input
                className={`${INPUT} flex-1`}
                value={pathInput}
                onChange={e => setPathInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && pathInput.trim()) { void addPaths([pathInput.trim()]); setPathInput(''); } }}
                placeholder={raw ? 'or paste a path: /Volumes/data/run1/pod5' : 'or paste a path: /Users/me/Downloads/ABC123.zip'}
                data-testid="daf-run-path-input"
              />
              <button
                type="button"
                className={BUTTON}
                disabled={!pathInput.trim()}
                onClick={() => { void addPaths([pathInput.trim()]); setPathInput(''); }}
                data-testid="daf-run-add-path"
              >
                Add
              </button>
            </div>
          </div>
          {raw && <DoradoLine dorado={status?.dorado} checking={checkingDorado} onCheck={() => void checkDorado()} />}
          {scanning && <div className="text-[12px] text-blue-600 dark:text-blue-300">{scanning}</div>}
          {scanError && <div className="text-[12px] text-red-600" data-testid="daf-run-scan-error">{scanError}</div>}
          {state.samples.length > 0 && (
            <div className="rounded border border-gray-200 dark:border-white/10 overflow-hidden">
              <table className="w-full text-[12px]" data-testid="daf-run-samples">
                <thead className="bg-gray-50 dark:bg-white/5 text-gray-500 dark:text-gray-400 text-[11px]">
                  <tr>
                    <th className="w-6" />
                    <th className="text-left font-medium px-2 py-1">{raw ? 'POD5' : 'Barcode'}</th>
                    <th className="text-left font-medium px-2 py-1">Sample name</th>
                    <th className="text-right font-medium px-2 py-1">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {state.samples.map((sample, index) => {
                    const others = included.filter(s => s.key !== sample.key).map(s => s.name);
                    const problem = sample.include ? sampleNameError(sample.name, others) : null;
                    return (
                      <tr key={sample.key} className="border-t border-gray-100 dark:border-white/5">
                        <td className="px-1 text-center">
                          <input
                            type="checkbox"
                            checked={sample.include}
                            onChange={e => setState(prev => ({ ...prev, samples: prev.samples.map((s, i) => i === index ? { ...s, include: e.target.checked } : s) }))}
                            aria-label={`Include ${sample.name}`}
                          />
                        </td>
                        <td className="px-2 py-1 text-gray-500 whitespace-nowrap">
                          {raw ? (sample.files.length === 1 && !/\.(pod5|fast5)$/i.test(sample.files[0].path) ? 'folder' : 'files')
                            : sample.barcode ? `${sample.order ? `${sample.order} ` : ''}#${sample.barcode}` : '—'}
                        </td>
                        <td className="px-2 py-1">
                          <input
                            className={`${INPUT} w-full ${problem ? 'border-red-400' : ''}`}
                            value={sample.name}
                            disabled={!sample.include}
                            onChange={e => setState(prev => ({ ...prev, samples: prev.samples.map((s, i) => i === index ? { ...s, name: e.target.value } : s) }))}
                            data-testid="daf-run-sample-name"
                          />
                          {problem && <div className="text-[11px] text-red-600">{problem}</div>}
                        </td>
                        <td className="px-2 py-1 text-right text-gray-500 whitespace-nowrap" title={sample.files.map(f => f.member || f.path).join('\n')}>
                          {raw && sample.files.length === 1 ? formatBytes(sample.size) : `${sample.files.length} · ${formatBytes(sample.size)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.scanWarnings.map(w => <div key={w} className="text-[11px] text-amber-700 dark:text-amber-300">{w}</div>)}
          {state.inputPaths.length > 0 && (
            <button type="button" className="text-[11px] text-gray-500 hover:underline" onClick={() => update({ inputPaths: [], samples: [], scanWarnings: [] })}>
              {raw ? 'Clear' : 'Clear reads'}
            </button>
          )}
        </section>
      )}

      {state.step === 1 && (
        <section className="space-y-3">
          <fieldset className="space-y-1.5">
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="radio" checked={state.referenceMode === 'genome'} onChange={() => update({ referenceMode: 'genome' })} data-testid="daf-run-ref-genome" />
              <span className="font-medium">A genome</span>
              <span className="text-[11px] text-gray-500">amplicons from genomic DNA (dm6, hg38, …)</span>
            </label>
            {state.referenceMode === 'genome' && (
              <div className="pl-6 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <select className={INPUT} value={state.genomeId} onChange={e => update({ genomeId: e.target.value })} data-testid="daf-run-genome-select">
                    <option value="">Choose a genome…</option>
                    {(status?.genomes ?? []).map(g => (
                      <option key={g.id} value={g.id}>
                        {g.name}{g.loaded ? ' (open now)' : ''}{g.downloaded ? '' : ' (not downloaded)'}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const g = status?.genomes.find(x => x.id === state.genomeId);
                    if (!g || g.downloaded) return null;
                    return (
                      <button type="button" className={BUTTON} disabled={downloading !== null} onClick={() => downloadGenome(g.id)} data-testid="daf-run-download-genome">
                        {downloading === g.id ? 'Downloading…' : `Download ${g.id}`}
                      </button>
                    );
                  })()}
                </div>
                <label className="block text-[12px] text-gray-600 dark:text-gray-300">
                  Amplicon region(s), optional
                  <textarea
                    className={`${INPUT} w-full mt-0.5 font-mono`}
                    rows={2}
                    value={state.regionsText}
                    onChange={e => update({ regionsText: e.target.value })}
                    placeholder="chr2L:1,000,000-1,004,000 (one per line); the view opens here"
                    data-testid="daf-run-regions"
                  />
                </label>
              </div>
            )}
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="radio" checked={state.referenceMode === 'file'} onChange={() => update({ referenceMode: 'file' })} data-testid="daf-run-ref-file" />
              <span className="font-medium">A plasmid map or FASTA</span>
              <span className="text-[11px] text-gray-500">.dna (SnapGene), .gb/.gbk, .embl, or .fa</span>
            </label>
            {state.referenceMode === 'file' && (
              <div className="pl-6 space-y-1.5">
                <div className="flex gap-1">
                  <input
                    className={`${INPUT} flex-1`}
                    value={state.referencePath}
                    onChange={e => update({ referencePath: e.target.value })}
                    placeholder="/path/to/construct.dna or reference.fa"
                    data-testid="daf-run-reference-path"
                  />
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={async () => {
                      const picked = await pickAnyFile();
                      if (picked.success && (picked.path || picked.paths?.[0])) update({ referencePath: picked.paths?.[0] ?? picked.path! });
                    }}
                  >
                    Choose…
                  </button>
                </div>
                {(status?.loaded_references ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1 text-[11px]">
                    <span className="text-gray-500">Open now:</span>
                    {status!.loaded_references.map(ref => (
                      <button key={ref.path} type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => update({ referencePath: ref.path })}>
                        {ref.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </fieldset>
        </section>
      )}

      {state.step === 2 && (
        <section className="space-y-3">
          <div className={`grid grid-cols-1 gap-2 ${raw ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            {enzymesFor(state.inputKind).map((id: Enzyme) => (
              <label
                key={id}
                className={`cursor-pointer rounded-lg border px-3 py-2 ${state.enzyme === id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-gray-200 dark:border-white/10 hover:border-blue-300'}`}
                data-testid={`daf-run-enzyme-${id}`}
              >
                <input type="radio" className="sr-only" checked={state.enzyme === id} onChange={() => update({ enzyme: id })} />
                <div className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">{ENZYME_INFO[id].label}</div>
                <div className="text-[11.5px] text-gray-500 dark:text-gray-400">{ENZYME_INFO[id].line}</div>
              </label>
            ))}
          </div>
          <label className="block text-[12px] text-gray-600 dark:text-gray-300">
            Output folder{included.length > 1 ? ' (one subfolder per sample)' : ''}
            <div className="flex gap-1 mt-0.5">
              <input
                className={`${INPUT} flex-1`}
                value={state.outputRoot}
                onChange={e => update({ outputRoot: e.target.value, outputTouched: true })}
                data-testid="daf-run-output"
              />
              <button
                type="button"
                className={BUTTON}
                onClick={async () => {
                  const picked = await pickFolder('Choose where to save the results');
                  if (picked.success && picked.path) update({ outputRoot: picked.path, outputTouched: true });
                }}
              >
                Choose…
              </button>
            </div>
          </label>
          <div className="flex flex-wrap items-center gap-4 text-[12px]">
            <label className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              Cores
              <input
                type="number"
                min={1}
                max={status?.cores ?? 64}
                className={`${INPUT} w-16`}
                value={state.cores}
                onChange={e => update({ cores: Number(e.target.value) })}
                data-testid="daf-run-cores"
              />
              <span className="text-[11px] text-gray-400">of {status?.cores ?? '?'}</span>
            </label>
            <label className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              <input type="checkbox" checked={state.autoOpen} onChange={e => update({ autoOpen: e.target.checked })} data-testid="daf-run-auto-open" />
              Open the results here when the run finishes
            </label>
          </div>

          {raw && (
            <details className="rounded border border-gray-200 dark:border-white/10 px-3 py-1.5" data-testid="daf-run-basecall">
              <summary className="cursor-pointer text-[12px] text-gray-700 dark:text-gray-200" data-testid="daf-run-basecall-summary">
                Basecalling
                <span className="ml-2 text-[11px] text-gray-400" data-testid="daf-run-basecall-line">
                  {basecallSummary(state.basecall, state.enzyme)}
                </span>
                <span className="ml-2 text-[11px] text-gray-400">· Advanced</span>
              </summary>
              <div className="space-y-2 py-2">
                <DoradoLine dorado={status?.dorado} checking={checkingDorado} onCheck={() => void checkDorado()} compact />
                <OptionRow label="Model" help="dorado's basecalling model: sup is the most accurate and the default; a version (sup@v5.2.0) or a model folder also works.">
                  <span className="flex gap-1 min-w-0">
                    <select
                      className={INPUT}
                      value={BASECALL_MODELS.some(m => m.id === state.basecall.model) ? state.basecall.model : 'other'}
                      onChange={e => setBasecall('model', e.target.value === 'other' ? '' : e.target.value)}
                      data-testid="daf-run-bc-model"
                    >
                      {BASECALL_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                      <option value="other">Other (a version or a model folder)…</option>
                    </select>
                    {!BASECALL_MODELS.some(m => m.id === state.basecall.model) && (
                      <input className={`${INPUT} flex-1`} value={state.basecall.model} placeholder="sup@v5.2.0 or /path/to/model"
                        onChange={e => setBasecall('model', e.target.value)} data-testid="daf-run-bc-model-other" />
                    )}
                  </span>
                </OptionRow>
                <OptionRow label="Modified bases" help="Automatic: the 6mA model for Hia5 Fiber-seq; none for DAF-seq (its deaminations are read from the sequence).">
                  <select className={INPUT} value={['auto', 'none', '6mA'].includes(state.basecall.modified_bases) ? state.basecall.modified_bases : 'auto'}
                    onChange={e => setBasecall('modified_bases', e.target.value)} data-testid="daf-run-bc-mods">
                    <option value="auto">Automatic (default)</option>
                    <option value="6mA">6mA</option>
                    <option value="none">None (plain basecalling)</option>
                  </select>
                </OptionRow>
                <OptionRow label="Device" help="Where dorado runs: automatic picks the GPU (Apple metal or NVIDIA cuda); the CPU is very slow.">
                  <select className={INPUT} value={BASECALL_DEVICES.some(d => d.id === state.basecall.device) ? state.basecall.device : 'auto'}
                    onChange={e => setBasecall('device', e.target.value)} data-testid="daf-run-bc-device">
                    {BASECALL_DEVICES.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                </OptionRow>
                <OptionRow label="Batch size" help="dorado --batchsize; blank lets dorado choose (lower it if the GPU runs out of memory).">
                  <input type="number" min={1} className={`${INPUT} w-24`} value={state.basecall.batchsize ?? ''} placeholder="automatic"
                    onChange={e => setBasecall('batchsize', e.target.value === '' ? null : Number(e.target.value))} data-testid="daf-run-bc-batch" />
                </OptionRow>
                {(state.basecall.model !== DEFAULT_BASECALL.model || state.basecall.modified_bases !== DEFAULT_BASECALL.modified_bases
                  || state.basecall.device !== DEFAULT_BASECALL.device || state.basecall.batchsize !== DEFAULT_BASECALL.batchsize) && (
                  <button type="button" className="text-[11px] text-gray-500 hover:underline" onClick={() => update({ basecall: { ...DEFAULT_BASECALL } })}>
                    Back to the defaults
                  </button>
                )}
              </div>
            </details>
          )}

          <details open={optionsOpen} onToggle={e => setOptionsOpen((e.target as HTMLDetailsElement).open)} className="rounded border border-gray-200 dark:border-white/10 px-3 py-1.5">
            <summary className="cursor-pointer text-[12px] text-gray-700 dark:text-gray-200" data-testid="daf-run-options">
              Calling options
              <span className="ml-2 text-[11px] text-gray-400">
                {changedOptionLabels(state.options, state.enzyme).join(', ') || 'fiberhmm-call defaults'}
              </span>
            </summary>
            <div className="space-y-2 py-2">
              {state.enzyme !== 'hia5' && <>
              <OptionRow label="PCR duplicates" help="Find PCR copies by their deamination pattern and alignment ends (automatic for DAF-seq).">
                <TriSelect value={state.options.dedup} onChange={v => setOption('dedup', v)} testId="daf-run-opt-dedup" />
              </OptionRow>
              <OptionRow label="Duplicate handling" help="Mark keeps every read (flag 0x400, left out of QC); collapse keeps one read per cluster.">
                <select className={INPUT} value={state.options.dedup_mode} disabled={state.options.dedup === 'off'} onChange={e => setOption('dedup_mode', e.target.value as PipelineOptions['dedup_mode'])} data-testid="daf-run-opt-dedup-mode">
                  <option value="flag">Mark, keep all reads (default)</option>
                  <option value="collapse">Collapse to one read per cluster</option>
                </select>
              </OptionRow>
              <OptionRow label="SNP screen" help="Find recurrent C→T/G→A SNPs and mask them from deamination calls (automatic when coverage allows).">
                <TriSelect value={state.options.snp_screen} onChange={v => setOption('snp_screen', v)} testId="daf-run-opt-snp" />
              </OptionRow>
              <OptionRow label="SNP mask (BED)" help="Your own SNP sites to mask (optional).">
                <input className={INPUT} value={state.options.snp_mask} onChange={e => setOption('snp_mask', e.target.value)} placeholder="/path/to/snps.bed" data-testid="daf-run-opt-snp-mask" />
              </OptionRow>
              <OptionRow label="Chimera filter" help="Skip strand-swap chimeras (C→T in one part of a read, G→A in another).">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={state.options.chimera_filter} onChange={e => setOption('chimera_filter', e.target.checked)} data-testid="daf-run-opt-chimera" /> Filter chimeras (default)</label>
              </OptionRow>
              </>}
              <OptionRow label="Alignments" help="Which alignment records to keep and call: a read's primary and supplementary alignments (both sides of a split read; FiberHMM 3.0's default), the primary alignment only, or all of them.">
                <select className={INPUT} value={state.options.alignments} onChange={e => setOption('alignments', e.target.value as PipelineOptions['alignments'])} data-testid="daf-run-opt-alignments">
                  <option value="primary-supplementary">Primary and supplementary (default)</option>
                  <option value="primary">Primary only</option>
                  <option value="all">All alignments</option>
                </select>
              </OptionRow>
              <OptionRow label="ML threshold" help="Minimum modification probability (0-255) for MM/ML input; blank = the chemistry's default. Binary DAF input ignores it.">
                <input
                  type="number"
                  min={0}
                  max={255}
                  className={`${INPUT} w-24`}
                  value={state.options.prob_threshold ?? ''}
                  onChange={e => setOption('prob_threshold', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="default"
                  data-testid="daf-run-opt-ml"
                />
              </OptionRow>
              {state.enzyme === 'ddda' && (
                <>
                  <OptionRow label="CpG-aware recall (DddA)" help="Exclude CpG observations outside unmethylated islands from footprint recall (on by default for DddA).">
                    <TriSelect value={state.options.use_m5c} onChange={v => setOption('use_m5c', v)} testId="daf-run-opt-m5c" />
                  </OptionRow>
                  <OptionRow label="CpG masking policy" help="Keep CpGs only inside unmethylated islands (default), or mask only methylated spans.">
                    <select className={INPUT} value={state.options.cpg_mask_policy} onChange={e => setOption('cpg_mask_policy', e.target.value as PipelineOptions['cpg_mask_policy'])}>
                      <option value="unmethylated-only">Unmethylated-only (default)</option>
                      <option value="methylated-only">Methylated-only</option>
                    </select>
                  </OptionRow>
                </>
              )}
            </div>
          </details>

          {currentCheck?.state === 'checking' && (
            <div className="text-[11.5px] text-gray-500 dark:text-gray-400" data-testid="daf-run-checking">Checking the run…</div>
          )}
          {currentCheck?.state === 'failed' && (
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-amber-800 dark:text-amber-200" data-testid="daf-run-check-failed">
              <span>Couldn&apos;t check the run: {currentCheck.error}</span>
              <button type="button" className={BUTTON} onClick={() => setRecheck(n => n + 1)} data-testid="daf-run-recheck">Retry</button>
            </div>
          )}
          {raw && validation?.errors.some(e => e.field === 'dorado') && (
            <DoradoLine dorado={validation.dorado ?? status?.dorado} checking={checkingDorado} onCheck={() => void checkDorado()} />
          )}
          {shownValidation && validation && !errors.length && (
            <div className="space-y-1 text-[11.5px]" data-testid="daf-run-preview">
              {shownValidation.errors.map(e => (
                <div key={e.message} className="text-red-600 whitespace-pre-wrap">{e.message}{e.hint ? `\n${e.hint}` : ''}</div>
              ))}
              {validation.warnings.map(w => <div key={w} className="text-amber-700 dark:text-amber-300">{w}</div>)}
              {validation.ok && validation.jobs.map(job => (
                <div key={job.sample} className="text-gray-500 dark:text-gray-400 truncate" title={job.command ?? ''}>
                  {job.sample} → {job.outdir || sampleOutdir(state.outputRoot, job.sample, validation.jobs.length)}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {help.length > 0 && (
        <ul className="text-[11.5px] text-gray-500 dark:text-gray-400 space-y-0.5" data-testid="daf-run-help">
          {help.map(e => <li key={e}>{e}</li>)}
        </ul>
      )}
      {(shownErrors.length > 0 || submitErrors.length > 0) && (
        <ul className="text-[11.5px] text-red-600 space-y-0.5" data-testid="daf-run-errors">
          {[...shownErrors, ...submitErrors].map(e => <li key={e}>{e}</li>)}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1 border-t border-gray-100 dark:border-white/5">
        {state.step > 0 && (
          <button type="button" className={BUTTON} onClick={() => update({ step: (state.step - 1) as WizardStep })}>Back</button>
        )}
        <span className="flex-1" />
        {(state.inputPaths.length > 0 || state.step > 0) && (
          <button
            type="button"
            className="text-[12px] text-gray-500 hover:underline"
            onClick={() => { clearDraft(); fallback.current = initialWizardState(null, state.autoOpen); setCheck(null); setAttempted(new Set()); }}
            data-testid="daf-run-start-over"
          >
            Start over
          </button>
        )}
        <button type="button" className="text-[12px] text-gray-500 hover:underline" onClick={() => setTab('runs')}>See runs</button>
        {state.step < 2 ? (
          <button
            type="button"
            className="px-3 py-1 rounded bg-blue-500 text-white text-[12px] hover:bg-blue-600 disabled:opacity-40"
            disabled={scanning !== null}
            onClick={() => tryStep(() => update({ step: (state.step + 1) as WizardStep }))}
            data-testid="daf-run-next"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className="px-3 py-1 rounded bg-emerald-600 text-white text-[12px] hover:bg-emerald-700 disabled:opacity-40"
            disabled={submitting || Boolean(validation && !validation.ok)}
            onClick={() => tryStep(() => { void run(); })}
            data-testid="daf-run-submit"
          >
            {submitting ? 'Starting…' : included.length > 1 ? `Run ${included.length} samples` : 'Run'}
          </button>
        )}
      </div>
    </div>
  );
}
