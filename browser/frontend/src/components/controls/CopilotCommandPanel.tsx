import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  clearSharedUsage,
  getCopilotCapabilities,
  getShareStatus,
  getShareUploadStatus,
  probeBackends,
  revealSharedUsage,
  sendSharedUsage,
  setBackend as apiSetBackend,
  startCopilotDownload,
  getCopilotDownloadStatus,
  getCopilotDoctor,
  streamNaturalLanguageCommand,
  type CopilotDoctorReport as DoctorReport,
  type BackendProbe,
  type CopilotApiRoute,
  type CopilotEvent,
  type CopilotDownloadStatus,
  type CopilotModelEntry,
  type NaturalLanguageAction,
  type ShareStatus,
  type ShareUploadStatus,
} from '../../api/naturalLanguage';
import {
  flushSessionNow,
  readShareFullDetails,
  readShareOptIn,
  writeShareFullDetails,
  writeShareOptIn,
} from '../../hooks/useSessionLog';
import { executeBrowserAction } from '../../actions/browserActions';
import { readTutorialMode, writeTutorialMode, COPILOT_ANCHORS, endPopoverSequence } from '../../utils/copilotAnchors';
import { startTutorialTour } from '../../utils/tourLauncher';
import { readPreferFp16, writePreferFp16 } from '../../utils/copilotSettings';
import { COPILOT_TEACH_ACTIONS, COPILOT_TEACH_ONLY } from '../../utils/copilotTeach';
import { CopilotDoctorReport } from './copilot/CopilotDoctorReport';

/** Example questions shown under the box (click to fill it in). */
const EXAMPLE_QUESTIONS = [
  'How do I change genomes?',
  'How do I cluster reads?',
  'How do I look at a haplotype?',
  'Why are no reads visible?',
];
import { useBrowserStore } from '../../stores/browserStore';
import type { CommandHistoryActionRecord, CommandHistoryEntry } from '../../stores/historySlice';
import { AnalysisButton, AnalysisStatus } from './shared';
import { Check, CheckCircle, ClipboardList, Lightbulb, Pin, Play, SkipForward, Sliders, Sparkles, ThumbsDown, ThumbsUp, Wrench } from '../ui/Icons';

/** The executor's result prefixes (kept in the stored, exportable history) drawn as icons. */
const MESSAGE_MARKERS: [string, typeof Pin, string][] = [
  ['📌 ', Pin, 'text-amber-600 dark:text-amber-300'],
  ['⏭ ', SkipForward, 'text-slate-400'],
  ['✅ ', CheckCircle, 'text-emerald-600 dark:text-emerald-400'],
];

function ActionMessage({ message }: { message: string }) {
  const marker = MESSAGE_MARKERS.find(([prefix]) => message.startsWith(prefix));
  const text = marker ? message.slice(marker[0].length) : message;
  const Icon = marker?.[1];
  return (
    <div className="mt-1 flex items-start gap-1 text-[11px] text-slate-500 dark:text-slate-400">
      {Icon && <Icon size={11} className={`mt-px flex-shrink-0 ${marker![2]}`} aria-hidden="true" />}
      <span>{text}</span>
    </div>
  );
}

type ActionStatus = CommandHistoryActionRecord['status'];

interface StreamRunState {
  starting: boolean;
  streaming: boolean;
  thinking: string;
  tokens: string;
  rawContent: string;
  parsed: unknown;
  startInfo?: {
    model: string;
    requestedModel: string;
    promptChars: number;
    systemChars: number;
  };
  warnings: string[];
  errors: string[];
  plan?: PlanResult;
}

interface PlanResult {
  success: boolean;
  planner: string;
  actions: NaturalLanguageAction[];
  warnings: string[];
  summary: string;
  needs_confirmation?: boolean;
  original_text?: string;
  elapsed_ms?: number;
  stats?: Record<string, unknown>;
}

const EMPTY_RUN: StreamRunState = {
  starting: false,
  streaming: false,
  thinking: '',
  tokens: '',
  rawContent: '',
  parsed: null,
  warnings: [],
  errors: [],
};

function valueAsString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function valueAsBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function truncateText(text: string, max = 1200): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

function actionId(action: NaturalLanguageAction, index: number): string {
  return `${valueAsString(action.type, 'action')}-${index}-${Date.now()}`;
}

function actionSummary(action: NaturalLanguageAction): string {
  const type = valueAsString(action.type);
  if (type === 'navigate_region') {
    return `Navigate to ${valueAsString(action.label) || `${valueAsString(action.chrom)}:${action.start}-${action.end}`}`;
  }
  if (type === 'scan_peaks') return 'Scan enabled peak rules';
  if (type === 'set_peaks_locked') return valueAsBoolean(action.locked) ? 'Lock current peaks' : 'Unlock peaks';
  if (type === 'add_region_label_rule') {
    return `Add ${valueAsString(action.color_name, valueAsString(action.color))} label rule for ${valueAsString(action.region_label, 'target region')}`;
  }
  if (type === 'select_peak_at') return `Select ${valueAsString(action.label, 'nearest peak')}`;
  if (type === 'cluster_selected_peaks') return 'Cluster selected peaks';
  if (type === 'cluster_peak_at_gene_tss') return `Cluster peak at ${valueAsString(action.gene_name, 'gene')} TSS`;
  if (type === 'query_motif_overlaps') return `Query motif overlaps for ${valueAsString(action.label, 'target region')}`;
  if (type === 'api_call') {
    return `${valueAsString(action.method, 'GET').toUpperCase()} ${valueAsString(action.path, '/api/...')}`;
  }
  return type || 'Browser action';
}

function apiEquivalent(action: NaturalLanguageAction): CommandHistoryActionRecord['apiEquivalent'] {
  const type = valueAsString(action.type);
  if (type === 'navigate_region') {
    return {
      method: 'POST',
      path: '/api/jupyter/goto',
      body: { chrom: action.chrom, start: action.start, end: action.end },
    };
  }
  if (type === 'scan_peaks') {
    return { method: 'POST', path: '/api/scan_peaks', note: 'Browser rescan event respects current peak rules.' };
  }
  if (type === 'set_peaks_locked') return { note: 'Store action: setPeaksLocked(...)' };
  if (type === 'add_region_label_rule') return { note: 'Browser labeling action: prepend a fixed-region color rule.' };
  if (type === 'select_peak_at') return { note: 'Browser selection action: nearest already-detected peak.' };
  if (type === 'cluster_selected_peaks') return { note: 'Browser action: same workflow as the Cluster button.' };
  if (type === 'cluster_peak_at_gene_tss') return { note: 'Browser action: navigate, select TSS peak, cluster.' };
  if (type === 'query_motif_overlaps') return { note: 'Browser query against currently loaded motif tracks.' };
  if (type === 'api_call') {
    return {
      method: valueAsString(action.method, 'GET').toUpperCase(),
      path: valueAsString(action.path),
      body: action.body ?? undefined,
      note: valueAsBoolean(action.allowed, true)
        ? 'Direct same-origin API call executed only after review.'
        : valueAsString(action.blocked_reason, 'Blocked by Copilot safety rules.'),
    };
  }
  return undefined;
}

function makeActionRecord(action: NaturalLanguageAction, index: number, status: ActionStatus = 'pending'): CommandHistoryActionRecord {
  return {
    id: actionId(action, index),
    type: valueAsString(action.type, 'unknown'),
    summary: actionSummary(action),
    status,
    payload: action,
    apiEquivalent: apiEquivalent(action),
    timestamp: Date.now(),
  };
}

function actionPayloadPreview(action: NaturalLanguageAction): string {
  return truncateText(JSON.stringify(action, null, 2), 1600);
}

function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeTsv(value: unknown): string {
  return String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function commandHistoryToTsv(history: CommandHistoryEntry[]): string {
  const rows = [['timestamp', 'command', 'planner', 'command_status', 'trace', 'action', 'action_status', 'summary', 'message', 'api_equivalent']];
  for (const entry of history) {
    for (const action of entry.actions) {
      rows.push([
        new Date(entry.timestamp).toISOString(),
        entry.text,
        entry.planner ?? '',
        entry.status,
        (entry.trace ?? []).join(' | '),
        action.type,
        action.status,
        action.summary,
        action.message ?? '',
        action.apiEquivalent ? JSON.stringify(action.apiEquivalent) : '',
      ]);
    }
  }
  return rows.map(row => row.map(escapeTsv).join('\t')).join('\n');
}

export function CopilotCommandPanel() {
  const {
    chrom, start, end, currentGenome, commandHistory,
    selectedGenes, relativeGene, relativeTSS,
    clusterMethod, clusterK, analysisSampleSeed, analysisSampleCount,
    subnucleosomalThreshold, accessibilityThreshold, spanningOnly, peaksLocked,
    addCommandHistoryEntry, updateCommandHistoryEntry, clearCommandHistory,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    currentGenome: s.currentGenome,
    commandHistory: s.commandHistory,
    selectedGenes: s.selectedGenes,
    relativeGene: s.relativeGene,
    relativeTSS: s.relativeTSS,
    clusterMethod: s.clusterMethod,
    clusterK: s.clusterK,
    analysisSampleSeed: s.analysisSampleSeed,
    analysisSampleCount: s.analysisSampleCount,
    subnucleosomalThreshold: s.subnucleosomalThreshold,
    accessibilityThreshold: s.accessibilityThreshold,
    spanningOnly: s.spanningOnly,
    peaksLocked: s.peaksLocked,
    addCommandHistoryEntry: s.addCommandHistoryEntry,
    updateCommandHistoryEntry: s.updateCommandHistoryEntry,
    clearCommandHistory: s.clearCommandHistory,
  })));

  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiRoutes, setApiRoutes] = useState<CopilotApiRoute[]>([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [keepAlive, setKeepAlive] = useState('');
  const [backend, setBackend] = useState<'ollama' | 'mlx'>('ollama');
  const [copilotReady, setCopilotReady] = useState(false);
  const [mlxReachable, setMlxReachable] = useState(false);
  const [modelRegistry, setModelRegistry] = useState<{
    system_ram_gb: number | null;
    models: Array<{
      id: string; label: string; tier: string; size_b: number;
      min_ram_gb: number; recommended_ram_gb: number;
      trained: boolean; fit?: string; description?: string;
      version?: number; deprecated?: boolean; quantized?: boolean;
    }>;
    recommended_id: string | null;
    trained_count: number;
    latest_per_tier?: string[];
    update_available?: Record<string, string>;
  } | null>(null);
  const [showOlderVersions, setShowOlderVersions] = useState<boolean>(false);
  const [shareEnabled, setShareEnabled] = useState<boolean>(() => readShareOptIn());
  const [shareFullDetails, setShareFullDetails] = useState<boolean>(() => readShareFullDetails());
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  const [shareUploadStatus, setShareUploadStatus] = useState<ShareUploadStatus | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<CopilotDownloadStatus | null>(null);
  const [preferFp16, setPreferFp16] = useState<boolean>(() => readPreferFp16());
  const downloadPollRef = useRef<number | null>(null);
  const [tutorialMode, setTutorialMode] = useState<boolean>(() => readTutorialMode());
  const [ollamaProbe, setOllamaProbe] = useState<BackendProbe | null>(null);
  // Why this machine can't run the local model (server-side host check:
  // Linux, Windows, Intel Mac, Rosetta Python, old macOS); null when it can.
  const [localCopilotProblem, setLocalCopilotProblem] = useState<string | null>(null);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const handleCheckSetup = async () => {
    setDoctorBusy(true);
    try {
      setDoctorReport(await getCopilotDoctor());
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : 'Setup check failed');
    } finally {
      setDoctorBusy(false);
    }
  };
  const checkSetupButton = (
    <div className="mt-2 flex items-center gap-2">
      <button type="button" onClick={() => { void handleCheckSetup(); }} disabled={doctorBusy}
        data-testid="copilot-check-setup"
        className="rounded px-1.5 py-0.5 text-[11px] text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-100 disabled:opacity-50 dark:text-emerald-200 dark:ring-emerald-500/40 dark:hover:bg-emerald-500/10">
        {doctorBusy ? 'Checking…' : 'Check setup'}
      </button>
      <span className="text-[11px] text-emerald-700/80 dark:text-emerald-300/70">Checks Python, the model runtime, disk, network and the model server, with fixes.</span>
    </div>
  );
  const [ollamaProbing, setOllamaProbing] = useState(false);

  const handleTutorialToggle = (next: boolean) => {
    writeTutorialMode(next);
    setTutorialMode(next);
  };


  // Setup wizard is opt-in only. The auto-popup nagged users who already had
  // a working install (race conditions on initial capabilities fetch could
  // flicker availableModels=[] briefly and re-fire the wizard). Users open
  // the wizard explicitly from the Settings disclosure when they need it.
  const [wizardShown, setWizardShown] = useState<boolean>(false);
  const noModelsLoaded = availableModels.length === 0 && !copilotReady;
  const setupNeeded = noModelsLoaded && !(backend === 'mlx' && mlxReachable);
  const showSetupWizard = wizardShown;
  const dismissWizard = () => setWizardShown(false);
  const openWizard = () => setWizardShown(true);
  const recommendedModel = modelRegistry?.recommended_id
    ?? (modelRegistry?.models ?? []).find(m => m.trained && m.fit !== 'insufficient')?.id
    ?? null;

  // Derive the q4 (small/fast) and fp16 (full quality) builds of the
  // recommended tier, plus the remaining tiers for the Advanced expander.
  const tierBuilds = useMemo(() => {
    const models = (modelRegistry?.models ?? []) as CopilotModelEntry[];
    const current = models.filter(m => m.trained && !m.deprecated);
    const recEntry = current.find(m => m.id === recommendedModel)
      ?? models.find(m => m.id === recommendedModel) ?? null;
    const tier = recEntry?.tier;
    const q4 = tier ? current.find(m => m.tier === tier && m.quantized) ?? null : null;
    const fp16 = tier ? current.find(m => m.tier === tier && !m.quantized) ?? null : null;
    const others = current.filter(m => m.tier !== tier);
    return { recEntry, tier, q4, fp16, others };
  }, [modelRegistry, recommendedModel]);

  // The default one-click model: q4 of the recommended tier, unless the user
  // toggled "Higher quality (fp16)". Falls back gracefully.
  const defaultDownloadEntry: CopilotModelEntry | null = preferFp16
    ? (tierBuilds.fp16 ?? tierBuilds.q4 ?? tierBuilds.recEntry)
    : (tierBuilds.q4 ?? tierBuilds.fp16 ?? tierBuilds.recEntry);
  const altDownloadEntry: CopilotModelEntry | null = preferFp16 ? tierBuilds.q4 : tierBuilds.fp16;
  const formatGb = (gb?: number | null) => (gb ? `~${gb} GB` : '');
  const formatBytesGb = (bytes?: number) => `${((bytes ?? 0) / 1024 ** 3).toFixed(1)} GB`;
  const downloadInFlight = downloadStatus?.state === 'downloading' || downloadStatus?.state === 'spawning';

  const handleProbeOllama = async () => {
    setOllamaProbing(true);
    setSetupMessage(null);
    try {
      const probe = await probeBackends();
      setOllamaProbe(probe);
      setMlxReachable(Boolean(probe.mlx_reachable));
      if (probe.ollama_reachable) {
        // Refresh capabilities so the model dropdown picks up newly-pulled
        // Ollama models without requiring a panel reopen.
        const caps = await getCopilotCapabilities();
        const nextAvailableModels = caps.available_models ?? [];
        setAvailableModels(nextAvailableModels);
        setCopilotReady(Boolean(caps.copilot_ready) || nextAvailableModels.length > 0);
        if (caps.default_model) setModel(caps.default_model);
      }
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : 'Probe failed');
    } finally {
      setOllamaProbing(false);
    }
  };

  const handleSwitchToMlx = async () => {
    try {
      await apiSetBackend('mlx');
      setBackend('mlx');
      const caps = await getCopilotCapabilities();
      const nextAvailableModels = caps.available_models ?? [];
      setAvailableModels(nextAvailableModels);
      setCopilotReady(Boolean(caps.copilot_ready) || nextAvailableModels.length > 0);
      setMlxReachable(Boolean(caps.mlx_reachable) || nextAvailableModels.length > 0);
      setModelRegistry(caps.model_registry ?? null);
      if (caps.default_model) {
        setModel(prev => nextAvailableModels.length > 0 && !nextAvailableModels.includes(prev) ? caps.default_model! : (prev || caps.default_model!));
      }
      setSetupMessage(nextAvailableModels.length > 0
        ? 'Switched to MLX.'
        : 'Switched to MLX. Waiting for mlx_lm.server to report a loaded model.');
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : 'Switch failed');
    }
  };

  // The browser can't tell an Apple Silicon Mac from an Intel one (both say
  // "MacIntel"), so the server's host check decides.
  const canRunLocalModel = !localCopilotProblem;

  // Kick off a consented, non-blocking model download and poll byte-level
  // progress until the model is downloaded + the server has started. Replaces
  // the old blocking setupCopilot() call so the panel can show a progress bar.
  const handleDownloadModel = async (modelId?: string) => {
    if (downloadPollRef.current) { window.clearInterval(downloadPollRef.current); downloadPollRef.current = null; }
    setSetupBusy(true);
    setSetupMessage(null);
    try {
      const started = await startCopilotDownload(modelId);
      setDownloadStatus(started);
      if (started.state === 'error') {
        setSetupMessage(started.message || started.error || 'Download failed');
        setSetupBusy(false);
        return;
      }
      downloadPollRef.current = window.setInterval(async () => {
        try {
          const st = await getCopilotDownloadStatus();
          setDownloadStatus(st);
          if (st.state === 'ready' || st.state === 'error') {
            if (downloadPollRef.current) { window.clearInterval(downloadPollRef.current); downloadPollRef.current = null; }
            setSetupBusy(false);
            if (st.state === 'ready') {
              await refreshCapabilities();
              setWizardShown(false);
            } else {
              setSetupMessage(st.message || st.error || 'Download failed');
            }
          }
        } catch { /* transient; keep polling */ }
      }, 1000);
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : 'Download failed');
      setSetupBusy(false);
    }
  };

  // Clear the progress poller on unmount.
  useEffect(() => () => {
    if (downloadPollRef.current) window.clearInterval(downloadPollRef.current);
  }, []);
  const [apiCatalogOpen, setApiCatalogOpen] = useState(false);
  const [apiRouteFilter, setApiRouteFilter] = useState('');
  const [run, setRun] = useState<StreamRunState>(EMPTY_RUN);
  const [running, setRunning] = useState(false);
  // Index of the action currently executing during a run; null when idle.
  // Used to visually highlight the active step in the planned-actions list
  // so the user can follow along as Copilot works through the plan.
  const [runningStepIndex, setRunningStepIndex] = useState<number | null>(null);
  // Per-plan feedback. Resets whenever a new `raw` event arrives (i.e. a
  // new plan starts streaming). Free-text comment is intended for the
  // alpha — once we have enough signal we'll likely drop it for thumbs-only.
  const [feedbackRating, setFeedbackRating] = useState<'up' | 'down' | null>(null);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const allowedRoutes = useMemo(() => apiRoutes.filter(r => r.copilot_allowed), [apiRoutes]);
  const filteredRoutes = useMemo(() => {
    const q = apiRouteFilter.trim().toLowerCase();
    if (!q) return allowedRoutes.slice(0, 120);
    return allowedRoutes.filter(route =>
      route.path.toLowerCase().includes(q) ||
      (route.description ?? '').toLowerCase().includes(q),
    ).slice(0, 120);
  }, [allowedRoutes, apiRouteFilter]);

  // Re-pull capabilities. The MLX probe is rate-limited server-side and can
  // briefly return zero models if mlx_lm.server is mid-load — this is why the
  // setup wizard would sometimes "stick" even after the server came online.
  const refreshCapabilities = useCallback(async () => {
    try {
      const res = await getCopilotCapabilities();
      setApiRoutes(res.routes ?? []);
      setSystemPrompt(res.system_prompt ?? '');
      setKeepAlive(res.keep_alive ?? '');
      const nextAvailableModels = res.available_models ?? [];
      const nextBackend = (res.backend as 'ollama' | 'mlx') ?? 'ollama';
      setAvailableModels(nextAvailableModels);
      setBackend(nextBackend);
      setCopilotReady(Boolean(res.copilot_ready) || nextAvailableModels.length > 0);
      setMlxReachable(Boolean(res.mlx_reachable) || (nextBackend === 'mlx' && nextAvailableModels.length > 0));
      setModelRegistry(res.model_registry ?? null);
      setLocalCopilotProblem(res.local_copilot_problem ?? null);
      // Prefer the registry's recommended id when it is actually served.
      // If MLX has a different model loaded, keep the UI on that model
      // instead of selecting an unavailable recommendation.
      const recommended = res.model_registry?.recommended_id;
      const fallback = nextBackend === 'mlx'
        ? (
          (recommended && nextAvailableModels.includes(recommended))
            ? recommended
            : (nextAvailableModels[0] || res.default_model || recommended || '')
        )
        : (res.default_model || nextAvailableModels[0] || recommended || '');
      if (fallback) {
        setModel(prev => {
          if (!prev) return fallback;
          if (nextBackend === 'mlx' && nextAvailableModels.length > 0 && !nextAvailableModels.includes(prev)) {
            return fallback;
          }
          return prev;
        });
      }
    } catch {
      setApiRoutes([]);
      setCopilotReady(false);
    }
  }, []);

  useEffect(() => {
    void refreshCapabilities();
    getShareStatus().then(setShareStatus).catch(() => setShareStatus(null));
    getShareUploadStatus().then(setShareUploadStatus).catch(() => setShareUploadStatus(null));
  }, [refreshCapabilities]);

  // Auto-refresh capabilities every 6s WHILE the panel reports no models.
  // This catches the race where the initial fetch raced mlx_lm.server boot —
  // without it, the user is stuck with a wizard even after the server is up.
  // Stops as soon as we see at least one model, to avoid pointless polling.
  useEffect(() => {
    if (availableModels.length > 0 || copilotReady) return;
    const id = window.setInterval(() => { void refreshCapabilities(); }, 6000);
    return () => window.clearInterval(id);
  }, [availableModels.length, copilotReady, refreshCapabilities]);

  const refreshShareStatus = async () => {
    try { setShareStatus(await getShareStatus()); } catch { /* ignore */ }
  };

  const handleShareToggle = (next: boolean) => {
    writeShareOptIn(next);
    setShareEnabled(next);
  };

  const handleShareFullDetailsToggle = (next: boolean) => {
    writeShareFullDetails(next);
    setShareFullDetails(next);
  };

  const handleShareSend = async () => {
    setShareBusy(true);
    try {
      const res = await sendSharedUsage();
      setMessage(res.success
        ? `Sent ${res.lines_sent ?? 0} sessions (${(res.bytes_sent ?? 0) / 1024 | 0} KB) to maintainer.`
        : `Send failed: ${res.error || res.response || 'unknown error'}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setShareBusy(false);
    }
  };

  const handleShareReveal = async () => {
    setShareBusy(true);
    try {
      await revealSharedUsage();
    } finally {
      setShareBusy(false);
    }
  };

  const handleSaveNow = async () => {
    setShareBusy(true);
    try {
      const ok = await flushSessionNow();
      if (ok) await refreshShareStatus();
      setMessage(ok ? 'Session log saved.' : 'Session log POST failed — see browser console for details.');
    } finally {
      setShareBusy(false);
    }
  };

  const handleShareClear = async () => {
    if (!confirm('Delete the shared usage file? This cannot be undone.')) return;
    setShareBusy(true);
    try {
      await clearSharedUsage();
      await refreshShareStatus();
    } finally {
      setShareBusy(false);
    }
  };

  const copyPath = (path: string) => {
    if (navigator.clipboard) navigator.clipboard.writeText(path).catch(() => {/* ignore */});
  };

  useEffect(() => {
    if (!run.streaming && !run.starting) return;
    const startedAt = Date.now();
    setElapsed(0);
    const interval = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 250);
    return () => window.clearInterval(interval);
  }, [run.streaming, run.starting]);

  const planActions = run.plan?.actions ?? [];

  const handlePlan = async () => {
    if (run.streaming) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setMessage(null);
    setRun({ ...EMPTY_RUN, starting: true, streaming: true });
    // Reset per-plan feedback so each plan gets a fresh thumbs/comment row.
    setFeedbackRating(null);
    setFeedbackComment('');
    setFeedbackSent(false);

    const accumulator: StreamRunState = { ...EMPTY_RUN, starting: true, streaming: true };
    const apply = (mut: (s: StreamRunState) => void) => {
      mut(accumulator);
      setRun({ ...accumulator });
    };

    // Pull the last 3 successful command-history entries as conversation context.
    const previousTurns = (commandHistory ?? [])
      .filter(e => e.status === 'success')
      .slice(0, 3)
      .reverse()  // chronological order
      .map(e => ({
        text: e.text,
        summary: e.summary,
        actions: e.actions.map(a => a.payload as Record<string, unknown>),
      }));

    try {
      await streamNaturalLanguageCommand(
        text,
        {
          chrom, start, end, currentGenome,
          selectedGenes, relativeGene, relativeTSS,
          clusterMethod, clusterK, analysisSampleSeed, analysisSampleCount,
          subnucleosomalThreshold, accessibilityThreshold, spanningOnly, peaksLocked,
        },
        (event: CopilotEvent) => {
          if (event.event === 'start') {
            apply(s => {
              s.starting = false;
              s.startInfo = {
                model: event.model,
                requestedModel: event.requested_model,
                promptChars: event.prompt_chars,
                systemChars: event.system_chars,
              };
            });
          } else if (event.event === 'thinking') {
            apply(s => { s.thinking += event.delta; });
          } else if (event.event === 'token') {
            apply(s => { s.tokens += event.delta; });
          } else if (event.event === 'raw') {
            apply(s => {
              s.rawContent = event.content;
              s.parsed = event.parsed;
            });
          } else if (event.event === 'warning') {
            apply(s => { s.warnings = [...s.warnings, event.message]; });
          } else if (event.event === 'error') {
            apply(s => { s.errors = [...s.errors, event.message]; });
            if (event.setup_needed) {
              setWizardShown(true);
              void refreshCapabilities();
            }
          } else if (event.event === 'plan') {
            apply(s => {
              s.plan = {
                success: event.success,
                planner: event.planner,
                actions: event.actions,
                warnings: event.warnings,
                summary: event.summary,
                needs_confirmation: event.needs_confirmation,
                original_text: event.original_text,
                elapsed_ms: event.elapsed_ms,
                stats: event.stats,
              };
            });
          } else if (event.event === 'done') {
            apply(s => { s.streaming = false; });
          }
        },
        { model, signal: controller.signal, previousTurns },
      );
    } catch (err) {
      apply(s => {
        s.streaming = false;
        s.errors.push(err instanceof Error ? err.message : 'Streaming failed.');
      });
    } finally {
      apply(s => {
        s.streaming = false;
        s.starting = false;
      });
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleRunPlan = async () => {
    const plan = run.plan;
    if (!plan || !plan.success || plan.actions.length === 0) {
      setMessage('Plan first: nothing to run.');
      return;
    }
    const entryId = `cmd-${Date.now()}`;
    const records = plan.actions.map((a, i) => makeActionRecord(a, i));
    const trace: string[] = [
      `Command: ${truncateText(text.trim(), 220)}`,
      `Planner: ${plan.planner}`,
      `Viewport: ${currentGenome || 'custom'} ${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`,
      plan.summary ? `Interpretation: ${plan.summary}` : '',
      ...plan.warnings.map(w => `Warning: ${w}`),
    ].filter(Boolean);
    const messages: string[] = [];

    addCommandHistoryEntry({
      id: entryId,
      text,
      planner: plan.planner,
      summary: plan.summary,
      trace,
      debug: {
        thinking: run.thinking,
        rawContent: run.rawContent,
        parsed: run.parsed,
        elapsedMs: plan.elapsed_ms,
        stats: plan.stats,
      },
      status: 'running',
      warnings: plan.warnings,
      actions: records,
      messages,
      timestamp: Date.now(),
    });

    setRunning(true);
    setRunningStepIndex(0);
    setMessage(null);
    // Pull the model's <think> reasoning so the popover can surface WHY
    // this plan was chosen alongside each step. Cap to ~3 lines so the
    // popover stays readable but the user gets the gist of the reasoning.
    const thinkingExcerpt = (run.thinking || '').split('\n').filter(Boolean).slice(0, 3).join(' ');
    // Copilot teaches: every step is a spotlit tutorial step the user clicks
    // through, in one popover that moves from control to control ("2 of 5").
    const teach = COPILOT_TEACH_ONLY || tutorialMode;
    const teachSteps = plan.actions.filter(a => !COPILOT_TEACH_ONLY || COPILOT_TEACH_ACTIONS.has(String(a.type ?? '')));
    // Steps with skip_if / requires may be dropped or gain a prerequisite note
    // when reached, so then the total isn't known: count "Step n" instead.
    const gated = teachSteps.some(a => 'skip_if' in a || 'requires' in a);
    let stepNumber = 0;
    let endedByUser = false;
    try {
      for (let i = 0; i < plan.actions.length; i += 1) {
        setRunningStepIndex(i);
        const action = plan.actions[i];
        if (endedByUser) {
          records[i] = { ...records[i], status: 'skipped', message: 'Walkthrough ended.', timestamp: Date.now() };
          continue;
        }
        if (COPILOT_TEACH_ONLY && !COPILOT_TEACH_ACTIONS.has(String(action.type ?? ''))) {
          // Defence in depth (the planner already drops these): Copilot never runs operations.
          const skipped = `Skipped "${action.type}": Copilot shows you where to do this instead of doing it.`;
          records[i] = { ...records[i], status: 'skipped', message: skipped, timestamp: Date.now() };
          messages.push(skipped);
          updateCommandHistoryEntry(entryId, { actions: [...records], messages: [...messages] });
          continue;
        }
        stepNumber += 1;
        try {
          const anchorDef = COPILOT_ANCHORS[(action.type as string) || ''];
          // The model can override the spotlight popover's description by
          // putting free-form narration in action.label. Useful for the
          // explanatory tutorial pattern where the same action type
          // (e.g. open_panel) needs different per-step explanations.
          const labelRaw = (action as unknown as { label?: unknown }).label;
          const modelLabel = typeof labelRaw === 'string' ? labelRaw.trim() : '';
          const stepDescription = modelLabel
            || (anchorDef ? anchorDef.describe(action as Record<string, unknown>) : `${action.type}`);
          const actionMessage = await executeBrowserAction(action, {
            tutorial: teach,
            description: stepDescription,
            // Passed separately so the popover renders it as a styled
            // secondary section (italic, "Model thinking" label) rather than blending
            // into the action description.
            thinking: teach ? thinkingExcerpt : undefined,
            // In tutorial mode, hold the spotlight longer so the user can read it,
            // and require a click to advance so users absorb each step.
            durationMs: teach ? 1500 : 700,
            waitForClick: teach,
            ...(teach ? {
              sequence: true,
              title: plan.summary || undefined,
              progress: gated ? `Step ${stepNumber}` : `${stepNumber} of ${teachSteps.length}`,
              onEnd: () => { endedByUser = true; },
            } : {}),
          });
          // Detect manual / unsupported actions so the panel marks them as
          // instructional rather than silently succeeding. The executor
          // returns "📌 Manual step:" for manualOnly actions and "Skipped
          // unsupported action type" for ones with no driver at all.
          const isManual = actionMessage.startsWith('📌 Manual step:')
            || actionMessage.startsWith('Skipped unsupported');
          // A step dropped by skip_if, or a try_it the user skipped, doesn't count as shown.
          const skippedStep = actionMessage.startsWith('⏭');
          if (actionMessage.startsWith('⏭ Already done')) stepNumber -= 1;
          records[i] = {
            ...records[i],
            status: skippedStep ? 'skipped' : 'success',
            message: isManual ? actionMessage : actionMessage,
            timestamp: Date.now(),
          };
          messages.push(actionMessage);
          updateCommandHistoryEntry(entryId, { actions: [...records], messages: [...messages] });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Action failed';
          records[i] = { ...records[i], status: 'error', message: errorMessage, timestamp: Date.now() };
          updateCommandHistoryEntry(entryId, {
            status: 'error',
            actions: [...records],
            messages: [...messages, errorMessage],
            error: errorMessage,
            completedAt: Date.now(),
          });
          throw err;
        }
      }
      useBrowserStore.getState().pushSnapshot(`Copilot: ${plan.summary || text.slice(0, 40)}`, { kind: 'analysis' });
      updateCommandHistoryEntry(entryId, {
        status: 'success',
        actions: [...records],
        messages: [...messages],
        completedAt: Date.now(),
      });
      setMessage(messages[messages.length - 1] || 'Command executed.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Command failed');
    } finally {
      // The walkthrough's last popover goes away with it.
      endPopoverSequence();
      setRunning(false);
      setRunningStepIndex(null);
    }
  };

  const submitFeedback = async (rating: 'up' | 'down') => {
    // Capture rating immediately for UI; send to backend with whatever
    // comment text the user has typed so far. Empty comments are fine —
    // a thumbs-only signal is still useful.
    setFeedbackRating(rating);
    setFeedbackSending(true);
    try {
      await fetch('/api/nl/feedback', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating,
          comment: feedbackComment.trim(),
          prompt: text,
          summary: run.plan?.summary ?? null,
          planner: run.plan?.planner ?? null,
          actions: (run.plan?.actions ?? []).map(a => a as Record<string, unknown>),
          thinking: run.thinking || null,
          // Useful viewport context for distillation since the same prompt
          // can mean different things in different regions.
          context: { chrom, start, end, currentGenome },
        }),
      });
      setFeedbackSent(true);
    } catch {
      // Feedback is fire-and-forget; if it fails, just keep the UI silent
      // rather than nagging the user. Logs end up on the server when
      // network is back.
      setFeedbackSent(true);
    } finally {
      setFeedbackSending(false);
    }
  };

  const exportJson = () => {
    downloadText(
      `fiberbrowser_copilot_history_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      JSON.stringify(commandHistory, null, 2),
      'application/json',
    );
  };
  const exportTsv = () => {
    downloadText(
      `fiberbrowser_copilot_history_${new Date().toISOString().replace(/[:.]/g, '-')}.tsv`,
      commandHistoryToTsv(commandHistory),
      'text/tab-separated-values',
    );
  };

  const showThinking = run.thinking.length > 0;
  const showTokens = run.tokens.length > 0;
  const isBusy = run.streaming || run.starting;

  return (
    <div className="flex h-full flex-col gap-3 px-3 py-2">
      {showSetupWizard && backend === 'mlx' && (
        <div className="relative rounded-lg border border-emerald-300 bg-emerald-50 p-3 shadow-sm dark:border-emerald-500/40 dark:bg-emerald-500/[0.05]">
          <button
            type="button"
            onClick={dismissWizard}
            aria-label="Dismiss setup wizard"
            title="Dismiss (won't show again this session)"
            className="absolute right-2 top-1.5 text-emerald-700/60 hover:text-emerald-900 dark:text-emerald-300/60 dark:hover:text-emerald-100"
          >×</button>
          {downloadInFlight ? (
            <>
              <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                {downloadStatus?.state === 'spawning'
                  ? 'Starting the model server…'
                  : `Downloading ${downloadStatus?.label ?? 'model'}`}
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-emerald-200/70 dark:bg-emerald-900/40">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
                  style={{ width: `${downloadStatus?.state === 'spawning' ? 100 : (downloadStatus?.pct ?? 0)}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-emerald-700 dark:text-emerald-300">
                <span>
                  {downloadStatus?.state === 'spawning'
                    ? 'Loading weights into memory…'
                    : `${downloadStatus?.pct ?? 0}%`}
                </span>
                {downloadStatus?.state === 'downloading' && (downloadStatus?.bytes_total ?? 0) > 0 && (
                  <span className="tabular-nums">
                    {formatBytesGb(downloadStatus?.bytes_done)} / {formatBytesGb(downloadStatus?.bytes_total)}
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-emerald-700/80 dark:text-emerald-300/70">
                Runs fully offline; cached at <code>~/.fiberhmm/copilot_models/</code>. You can keep working while it downloads.
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Enable the local AI assistant</div>
              <div className="mt-1 text-[11px] leading-snug text-emerald-700 dark:text-emerald-300">
                {modelRegistry?.system_ram_gb !== null && modelRegistry?.system_ram_gb !== undefined && (
                  <>Detected <strong>{modelRegistry.system_ram_gb} GB</strong> RAM. </>
                )}
                Runs fully offline on your machine — one-time download, then cached.
              </div>
              {defaultDownloadEntry ? (
                <div className="mt-2 rounded-md border border-emerald-300/70 bg-white/70 p-2 dark:border-emerald-500/30 dark:bg-black/20">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold text-emerald-900 dark:text-emerald-100">{defaultDownloadEntry.label}</div>
                      <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                        {formatGb(defaultDownloadEntry.download_gb)} download
                        {defaultDownloadEntry.fit === 'comfortable' ? ' · fits comfortably'
                          : defaultDownloadEntry.fit === 'minimum' ? ' · fits (minimum RAM)'
                          : defaultDownloadEntry.fit === 'insufficient' ? ' · may exceed your RAM' : ''}
                      </div>
                    </div>
                    <AnalysisButton
                      onClick={() => handleDownloadModel(defaultDownloadEntry.id)}
                      disabled={setupBusy}
                      theme="slate"
                      size="sm"
                    >
                      {setupBusy ? 'Starting…' : 'Download & start'}
                    </AnalysisButton>
                  </div>
                  {altDownloadEntry && (
                    <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                      <input
                        type="checkbox"
                        checked={preferFp16}
                        disabled={setupBusy}
                        onChange={e => { setPreferFp16(e.target.checked); writePreferFp16(e.target.checked); }}
                        className="rounded border-emerald-400"
                      />
                      {preferFp16
                        ? `Smaller / faster (q4, ${formatGb(tierBuilds.q4?.download_gb)})`
                        : `Higher quality (fp16, ${formatGb(tierBuilds.fp16?.download_gb)})`}
                    </label>
                  )}
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">No downloadable model tier found for this host.</div>
              )}
              {setupMessage && (
                <div className="mt-1 whitespace-pre-wrap text-[11px] text-rose-600 dark:text-rose-400">{setupMessage}</div>
              )}
              {downloadStatus?.state === 'error' && downloadStatus.log_tail && (
                <details className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">
                  <summary className="cursor-pointer">Model server log</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-rose-50 px-1.5 py-1 font-mono dark:bg-black/30">{downloadStatus.log_tail}</pre>
                </details>
              )}
              {checkSetupButton}
              {doctorReport && <CopilotDoctorReport report={doctorReport} onClose={() => setDoctorReport(null)} />}
              {tierBuilds.others.length > 0 && (
                <details className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  <summary className="cursor-pointer">Advanced: other tiers</summary>
                  <div className="mt-1 space-y-0.5">
                    {tierBuilds.others.map(m => (
                      <div key={m.id} className="flex items-center justify-between gap-2">
                        <span className={m.fit === 'insufficient' ? 'opacity-60' : ''}>
                          {m.label} — {formatGb(m.download_gb)}{m.fit === 'insufficient' ? ' · may exceed RAM' : ''}
                        </span>
                        <button
                          onClick={() => handleDownloadModel(m.id)}
                          disabled={setupBusy}
                          className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 disabled:opacity-50 dark:bg-black/20 dark:text-slate-200 dark:ring-white/10"
                        >Download</button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      )}

      {showSetupWizard && backend === 'ollama' && (
        <div className="relative rounded-lg border border-emerald-300 bg-emerald-50 p-3 shadow-sm dark:border-emerald-500/40 dark:bg-emerald-500/[0.05]">
          <button
            type="button"
            onClick={dismissWizard}
            aria-label="Dismiss setup wizard"
            title="Dismiss (won't show again this session)"
            className="absolute right-2 top-1.5 text-emerald-700/60 hover:text-emerald-900 dark:text-emerald-300/60 dark:hover:text-emerald-100"
          >×</button>
          <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Set up Copilot</div>
          {/* MLX-first guidance: trained tiers + faster local inference + one-click setup. */}
          {canRunLocalModel ? (
            <>
              <div className="mt-1 text-[11px] leading-snug text-emerald-700 dark:text-emerald-300">
                <strong>MLX is the recommended backend on Mac.</strong> It uses our LoRA-trained
                model (better on FiberBrowser-specific commands) and downloads + starts with one click —
                no separate terminal needed. Ollama is supported as a fallback but is generally slower
                and uses an untrained base model.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <AnalysisButton onClick={handleSwitchToMlx} theme="slate" size="sm">
                  Switch to MLX (recommended)
                </AnalysisButton>
                {setupMessage && (
                  <span className="text-[11px] text-emerald-700 dark:text-emerald-300">{setupMessage}</span>
                )}
              </div>
              <details className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                <summary className="cursor-pointer">First-time MLX install (one shell command)</summary>
                <pre className="mt-1 rounded bg-emerald-100/60 px-2 py-1 font-mono text-[11px] text-emerald-900 dark:bg-black/30 dark:text-emerald-200">pip install 'mlx-lm&gt;=0.19' huggingface_hub</pre>
                <div className="mt-1">After installing, click <em>Switch to MLX</em> above.</div>
              </details>
            </>
          ) : (
            <div className="mt-1 text-[11px] leading-snug text-emerald-700 dark:text-emerald-300"
              data-testid="copilot-unsupported-host">
              <strong>{localCopilotProblem}</strong>
            </div>
          )}
          {checkSetupButton}
          {doctorReport && <CopilotDoctorReport report={doctorReport} onClose={() => setDoctorReport(null)} />}

          <div className="mt-3 border-t border-emerald-200 pt-2 dark:border-emerald-500/30">
            <div className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">
              Using Ollama instead?
            </div>
            <div className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300">
              {ollamaProbe?.ollama_reachable === false
                ? <><strong>Ollama is not reachable.</strong> Start <code>ollama serve</code> in a terminal, pull a model, then re-detect:</>
                : ollamaProbe?.ollama_reachable === true && availableModels.length === 0
                  ? <><strong>Ollama is reachable but no models are pulled.</strong> Pull one and re-detect:</>
                  : <>Ollama needs a running server and at least one pulled model:</>}
            </div>
            <pre className="mt-1 rounded bg-emerald-100/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-emerald-900 dark:bg-black/30 dark:text-emerald-200">{`# in one terminal:
ollama serve

# in another:
ollama pull qwen2.5`}</pre>
            <div className="mt-2 flex items-center gap-2">
              <AnalysisButton onClick={handleProbeOllama} disabled={ollamaProbing} theme="slate" size="sm" variant="outline">
                {ollamaProbing ? 'Detecting...' : 'Re-detect Ollama'}
              </AnalysisButton>
              {ollamaProbe && (
                <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
                  Ollama: {ollamaProbe.ollama_reachable ? 'reachable' : 'not reachable'} · MLX: {ollamaProbe.mlx_reachable ? 'reachable' : 'not reachable'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
        {/* Header removed entirely — the viewport pill (dm6 · 2R:…) and the
            subtitle were both clutter. The prompt textarea below is the
            content. Viewport info is already in the URL/sidebar; the user
            doesn't need a duplicate inside the Copilot panel. */}
        {/* Chat-style prompt area: Plan button lives inside the textarea as
            a send arrow, so the primary action sits where users naturally
            look after typing. Stop button replaces it during streaming. */}
        <div className="relative">
          <textarea
            data-tour="copilot-input"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              // Cmd/Ctrl+Enter submits, like ChatGPT/Claude.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim() && !isBusy) {
                e.preventDefault();
                void handlePlan();
              }
            }}
            className="input-tool min-h-[88px] w-full resize-y pb-9 text-xs leading-snug"
            placeholder="Ask how to do anything, e.g. “how do I cluster reads?” or “why are no reads visible?”. Copilot opens the right panels and points at the controls; you click them."
          />
          <div className="pointer-events-none absolute bottom-1.5 left-2 right-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
              <kbd className="fb-kbd">⌘</kbd><kbd className="fb-kbd">↵</kbd> to plan
            </span>
            <div className="pointer-events-auto">
              {!isBusy ? (
                <button
                  type="button"
                  onClick={handlePlan}
                  disabled={!text.trim() || running}
                  title="Generate plan (⌘↵)"
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1 text-[11px] font-medium text-white shadow-chip hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none dark:disabled:bg-white/10 dark:disabled:text-slate-500"
                >
                  <Sparkles size={12} aria-hidden="true" />
                  <span>Plan</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStop}
                  title="Stop streaming"
                  className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-rose-700"
                >
                  <span>Stop</span>
                  <span className="opacity-80">{elapsed}s</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1" data-testid="copilot-example-questions">
          {EXAMPLE_QUESTIONS.map(question => (
            <button
              key={question}
              type="button"
              onClick={() => setText(question)}
              className="rounded-full px-2 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/5"
            >
              {question}
            </button>
          ))}
        </div>
        {modelRegistry && backend === 'mlx' && modelRegistry.models.length > 0 && (() => {
          // Filter to non-deprecated trained models by default; reveal older
          // versions (v1/v2/v3...) only when the user opts in. Untrained
          // entries (14b/32b stubs) are always hidden — they aren't real
          // downloadable models and cluttered the dropdown.
          const latestIds = new Set(modelRegistry.latest_per_tier || []);
          const visible = modelRegistry.models.filter(m =>
            m.trained
            && (showOlderVersions || latestIds.has(m.id))
          );
          const updateTo = modelRegistry.update_available?.[model];
          const replacementModel = updateTo
            ? modelRegistry.models.find(m => m.id === updateTo)
            : null;
          return (
            <>
              {/* Update-available banner. Shows when the currently-loaded
                  model has a newer version registered. One-click swap +
                  prompts user to actually download the replacement. */}
              {replacementModel && (
                <div className="mt-2 flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-500/50 dark:bg-amber-900/30 dark:text-amber-100">
                  <span>🆕</span>
                  <span className="flex-1">
                    Newer Copilot available:{' '}
                    <span className="font-medium">{replacementModel.label}</span>
                    {' '}(you're on a deprecated version).
                  </span>
                  <button
                    type="button"
                    onClick={() => setModel(replacementModel.id)}
                    className="rounded bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700"
                  >
                    Switch
                  </button>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-slate-500 dark:text-slate-400">Model:</span>
                <select
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  className="input-tool h-7 px-1.5 text-[11px]"
                  title="Pick the LoRA-trained Copilot tier that fits your hardware"
                >
                  {visible.map(m => {
                    const fitLabel = m.fit === 'comfortable' ? 'OK'
                      : m.fit === 'minimum' ? 'min'
                      : m.fit === 'insufficient' ? 'too big'
                      : '';
                    const depLabel = m.deprecated ? ' [old]' : '';
                    const qLabel = m.quantized ? ' · 4-bit' : '';
                    // Mark the recommended model on its own option, where the
                    // user is choosing, not as a separate stray line.
                    const isRecommended = m.id === modelRegistry.recommended_id;
                    const recLabel = isRecommended ? ' · recommended' : '';
                    return (
                      <option key={m.id} value={m.id}>
                        {m.label}{depLabel} — {m.recommended_ram_gb} GB{qLabel}{fitLabel ? ` · ${fitLabel}` : ''}{recLabel}
                      </option>
                    );
                  })}
                </select>
                <label className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={showOlderVersions}
                    onChange={e => setShowOlderVersions(e.target.checked)}
                    className="h-3 w-3"
                  />
                  Show older versions
                </label>
              </div>
            </>
          );
        })()}
        {backend === 'ollama' && availableModels.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-slate-500 dark:text-slate-400">Model:</span>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              className="input-tool h-7 px-1.5 text-[11px]"
              title="Pick one of the Ollama models available on this machine"
            >
              {availableModels.map(availableModel => (
                <option key={availableModel} value={availableModel}>
                  {availableModel}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* Inline status pill: shows the active model + lets the user open
            the setup wizard or settings disclosure on demand. Replaces the
            wide button row that previously dominated this section. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-white/5">
            {backend} · <span className="font-mono">{model ? model.split('/').pop() : '—'}</span>
          </span>
          {setupNeeded && (
            <button
              type="button"
              onClick={openWizard}
              className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30"
            >
              <Wrench size={11} className="mr-1 inline-block align-[-1px]" aria-hidden="true" />Set up Copilot
            </button>
          )}
          {!setupNeeded && backend === 'mlx' && mlxReachable && availableModels.length === 0 && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30">
              MLX reachable · waiting for model list
            </span>
          )}
          {/* Copilot always teaches step by step when teach-only. */}
          {!COPILOT_TEACH_ONLY && (
            <label
              className="ml-auto flex items-center gap-1 cursor-pointer"
              title="Tutorial mode: spotlight each panel + button the plan affects, with explanatory popovers."
            >
              <input
                type="checkbox"
                checked={tutorialMode}
                onChange={e => handleTutorialToggle(e.target.checked)}
                className="h-3 w-3"
              />
              Tutorial mode
            </label>
          )}
          <button
            type="button"
            onClick={() => startTutorialTour()}
            className="rounded px-1.5 py-0.5 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50 dark:text-emerald-300 dark:ring-emerald-500/30 dark:hover:bg-emerald-500/10"
            title="A scripted walk through the main tools on a demo dataset (no model needed)"
          >
            Guided tour
          </button>
          {message && <span className="basis-full truncate text-[11px]" title={message}>{message}</span>}
        </div>

        {/* Everything below this point — model picker, stream diagnostics,
            telemetry sharing, API catalog — lives behind a single Settings
            disclosure so the prompt + plan + thinking dominate the panel. */}
        <details className="mt-2 rounded border border-slate-200 dark:border-white/10">
          <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.03]">
            <Sliders size={12} className="mr-1.5 inline-block align-[-2px] text-slate-400" aria-hidden="true" />Settings, diagnostics &amp; sharing
          </summary>
          <div className="border-t border-slate-200 px-2 py-2 dark:border-white/10">

        {run.startInfo && (
          <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            Streaming from <span className="font-mono">{run.startInfo.model}</span>
            {' · '}
            system prompt {(run.startInfo.systemChars ?? 0).toLocaleString()} chars (cached, keep_alive {keepAlive || '60m'})
            {' · '}
            request {(run.startInfo.promptChars ?? 0).toLocaleString()} chars
          </div>
        )}

        <div className="mt-2 rounded border border-slate-200 bg-slate-50/60 px-2 py-1.5 text-[11px] dark:border-white/10 dark:bg-white/[0.02]">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareEnabled}
              onChange={e => handleShareToggle(e.target.checked)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-700 dark:text-slate-200">
                Share anonymized usage with the FiberBrowser team
              </div>
              <div className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Off by default. When on, each session is appended (with file paths and dataset paths
                redacted, user agent generalized) to a single local file you can drop into Slack.
                Nothing leaves your machine automatically.
              </div>
            </div>
          </label>
          {shareEnabled && (
            <label className="mt-1.5 flex items-start gap-2 cursor-pointer text-[11px] text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={shareFullDetails}
                onChange={e => handleShareFullDetailsToggle(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <strong>Share full details</strong> (cleartext gene + motif + dataset names, exact coordinates, your typed labels).
                Off by default — gene/motif/dataset names are hashed per session, coordinates bucketed to 1 kb,
                free-form labels redacted. Tick this only if you're OK sharing your research direction along with action patterns.
              </span>
            </label>
          )}
          {shareEnabled && shareStatus && (
            <div className="mt-1.5 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-500 dark:text-slate-400">file:</span>
                <code className="min-w-0 flex-1 truncate rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 dark:bg-black/20 dark:text-slate-200 dark:ring-white/10" title={shareStatus.absolute_path}>
                  {shareStatus.absolute_path}
                </code>
                <button
                  onClick={() => copyPath(shareStatus.absolute_path)}
                  className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-black/20 dark:text-slate-200 dark:ring-white/10"
                >Copy path</button>
                <button
                  onClick={handleShareReveal}
                  disabled={shareBusy}
                  className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 disabled:opacity-50 dark:bg-black/20 dark:text-slate-200 dark:ring-white/10"
                >Reveal in Finder</button>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span>{shareStatus.exists
                  ? `${shareStatus.line_count} sessions · ${(shareStatus.size_bytes / 1024).toFixed(1)} KB`
                  : 'no sessions logged yet'}</span>
                <button
                  onClick={handleSaveNow}
                  disabled={shareBusy}
                  className="ml-auto rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100 disabled:opacity-50 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-500/30"
                  title="Force-save the current session right now without closing the tab"
                >Save now</button>
                <button
                  onClick={refreshShareStatus}
                  disabled={shareBusy}
                  className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                >Refresh</button>
                <button
                  onClick={handleShareClear}
                  disabled={shareBusy || !shareStatus.exists}
                  className="rounded px-1.5 py-0.5 text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-500/15"
                >Clear file</button>
              </div>
              {shareUploadStatus?.configured && (
                <div className="mt-1 flex items-center gap-2 rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                  <span>Maintainer receiver:</span>
                  <code className="font-mono">{shareUploadStatus.host}</code>
                  {shareUploadStatus.has_token && <span className="opacity-60">(token-auth)</span>}
                  <button
                    onClick={handleShareSend}
                    disabled={shareBusy || !shareStatus.exists}
                    className="ml-auto rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    title="POST your local shared_usage.jsonl to the configured maintainer endpoint"
                  >Send to maintainer</button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setApiCatalogOpen(v => !v)}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/[0.05]"
          >
            {apiCatalogOpen ? 'Hide' : 'Show'} safe API catalog ({allowedRoutes.length})
          </button>
        </div>
        {apiCatalogOpen && (
          <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 dark:border-white/10 dark:bg-black/10">
            <div className="mb-1 flex items-center gap-2">
              <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Safe API catalog (in system prompt)</div>
              <input
                value={apiRouteFilter}
                onChange={e => setApiRouteFilter(e.target.value)}
                className="input-tool ml-auto w-40 text-[11px]"
                placeholder="Filter routes..."
              />
            </div>
            {systemPrompt && (
              <details className="mb-2 rounded bg-white px-2 py-1 text-[11px] text-slate-500 ring-1 ring-slate-200 dark:bg-white/[0.03] dark:text-slate-400 dark:ring-white/10">
                <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">System prompt (full)</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug">{systemPrompt}</pre>
              </details>
            )}
            <div className="max-h-44 space-y-0.5 overflow-y-auto">
              {filteredRoutes.map(route => (
                <div key={`${route.path}:${route.allowed_methods.join(',')}`} className="flex items-start gap-2 rounded bg-white px-2 py-1 text-[11px] ring-1 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/10">
                  <span className="font-mono text-slate-500 dark:text-slate-400">{route.allowed_methods.join('|')}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-slate-700 dark:text-slate-200">{route.path}</span>
                    {route.description && <span className="ml-1 text-slate-400">{route.description}</span>}
                  </span>
                </div>
              ))}
              {filteredRoutes.length === 0 && (
                <div className="text-[11px] text-slate-400">No matching safe routes.</div>
              )}
            </div>
          </div>
        )}
          </div>
        </details>
      </div>

      {/* Run plan: BIG button immediately above the plan output when a plan
          exists. Keeps the primary post-plan action above the fold even
          on short panels — the user explicitly asked for this placement. */}
      {run.plan?.success && planActions.length > 0 && (
        <button
          type="button"
          onClick={handleRunPlan}
          disabled={running || isBusy}
          className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-white/10 dark:disabled:text-slate-500"
        >
          {running ? 'Running…' : (
            <span className="inline-flex items-center gap-2">
              <Play size={14} aria-hidden="true" />
              {`Run plan (${planActions.length} step${planActions.length === 1 ? '' : 's'})`}
            </span>
          )}
        </button>
      )}

      {/* Streaming status pill (shown only during stream, before plan
          renders). Once thinking starts, the thinking card itself
          conveys liveness — we drop this. Model path is shown as basename
          only because the full /Users/.../copilot_7b_v4 path was noise. */}
      {isBusy && !showThinking && !showTokens && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-2 py-1.5 text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"></span>
          Waiting for first token from <span className="font-mono">{(model || 'model').split('/').pop()}</span> · {elapsed}s
          {elapsed > 15 && <span className="text-amber-600 dark:text-amber-300">— model server may be loading or unreachable</span>}
        </div>
      )}

      {/* Errors render in their own block right after the prompt so they're
          impossible to miss. */}
      {run.errors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-2 dark:border-red-500/30 dark:bg-red-500/[0.05]">
          {run.errors.map((err, i) => {
            // When the planner failed because its current backend is
            // unreachable but the *other* backend is up, offer a one-click
            // switch rather than making the user restart with env vars.
            const ollamaDown = /Ollama is not reachable/i.test(err);
            const mlxDown = /mlx_lm\.server is not reachable/i.test(err);
            const otherBackend: 'mlx' | 'ollama' | null =
              ollamaDown ? 'mlx' : mlxDown ? 'ollama' : null;
            return (
              <div key={`${err}-${i}`} className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                <div>{err}</div>
                {otherBackend && (
                  <button
                    onClick={async () => {
                      try {
                        const probe = await probeBackends();
                        const target = otherBackend;
                        const reachable = target === 'mlx' ? probe.mlx_reachable : probe.ollama_reachable;
                        if (!reachable) {
                          setMessage(`${target} backend not reachable either — start it first.`);
                          return;
                        }
                        await apiSetBackend(target);
                        setBackend(target);
                        setMessage(`Switched to ${target}. Hit Plan again.`);
                      } catch (e) {
                        setMessage(e instanceof Error ? e.message : 'Switch failed.');
                      }
                    }}
                    className="mt-1 rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700"
                  >
                    Try switching to {otherBackend} →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Warnings: their own block so they don't get tied to errors. */}
      {run.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/[0.05] dark:text-amber-200">
          {run.warnings.map((w, i) => (
            <div key={`${w}-${i}`}>{w}</div>
          ))}
        </div>
      )}

      {/* Plan output: the visual centerpiece of the panel. Strong border
          and tinted background draw the eye here once a plan exists. */}
      {run.plan && (
        <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50/30 p-3 shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/[0.04]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
              <ClipboardList size={14} className="mr-1.5 inline-block align-[-2px] text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              Planned actions{run.plan.success ? ` (${planActions.length})` : ''}
            </div>
            <span className="text-[11px] text-slate-400" title={run.plan.planner}>
              {typeof run.plan.elapsed_ms === 'number' && `${(run.plan.elapsed_ms / 1000).toFixed(1)}s`}
            </span>
          </div>
          {run.plan.success ? (
            <div className="space-y-1.5">
              {run.plan.summary && (
                <div className="rounded bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 ring-1 ring-slate-200 dark:bg-black/20 dark:text-slate-200 dark:ring-white/10">
                  {run.plan.summary}
                </div>
              )}
              {planActions.map((action, index) => {
                const isActive = runningStepIndex === index;
                const isDone = runningStepIndex !== null && index < runningStepIndex;
                return (
                <details
                  key={`${action.type}-${index}`}
                  open={isActive}
                  className={`rounded px-2 py-1 text-[11px] ring-1 transition ${
                    isActive
                      ? 'bg-amber-50 text-slate-800 ring-amber-400 shadow-sm animate-pulse dark:bg-amber-500/15 dark:text-slate-100 dark:ring-amber-400/60'
                      : isDone
                        ? 'bg-emerald-50/60 text-slate-500 ring-emerald-200 dark:bg-emerald-500/[0.08] dark:text-slate-400 dark:ring-emerald-500/30'
                        : 'bg-white text-slate-600 ring-slate-200 dark:bg-black/20 dark:text-slate-300 dark:ring-white/10'
                  }`}
                >
                  <summary className="cursor-pointer">
                    <span className="inline-flex w-4 justify-center font-mono text-slate-400 align-[-2px]">
                      {isActive
                        ? <Play size={11} className="text-amber-600 dark:text-amber-300" aria-label="Running" />
                        : isDone
                          ? <Check size={12} className="text-emerald-600 dark:text-emerald-400" aria-label="Done" />
                          : `${index + 1}.`}
                    </span>{' '}
                    {actionSummary(action)}
                  </summary>
                  <pre className="mt-1 max-h-36 overflow-auto rounded bg-slate-900/90 p-1.5 text-[11px] text-slate-100">
                    {actionPayloadPreview(action)}
                  </pre>
                  {apiEquivalent(action) && (
                    <pre className="mt-1 max-h-28 overflow-auto rounded bg-slate-100 p-1.5 text-[11px] text-slate-600 dark:bg-white/10 dark:text-slate-200">
                      {JSON.stringify(apiEquivalent(action), null, 2)}
                    </pre>
                  )}
                </details>
                );
              })}
            </div>
          ) : (
            <AnalysisStatus kind="empty" compact title="No executable plan">
              The model finished but no validated actions came out. Open Model thinking below to debug.
            </AnalysisStatus>
          )}
        </div>
      )}

      {/* Plan feedback (alpha). Thumbs up/down + free-text textarea so
          testers can describe what went wrong / what would help. POSTed
          to /api/nl/feedback which appends a jsonl record under
          data/copilot_dataset/usage_logs/ for the next training round.
          Visible whenever a plan has been generated (success or not)
          so we capture signal on bad plans too. */}
      {run.plan && !feedbackSent && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-2 text-[11px] dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-700 dark:text-slate-200">Was this plan helpful?</span>
            <button
              type="button"
              onClick={() => submitFeedback('up')}
              disabled={feedbackSending}
              title="Thumbs up — plan worked as expected"
              aria-label="Thumbs up"
              aria-pressed={feedbackRating === 'up'}
              className={`inline-flex items-center rounded-fb px-2 py-1 text-[12px] ring-1 transition ${
                feedbackRating === 'up'
                  ? 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-200 dark:ring-emerald-500/40'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-emerald-50 dark:bg-black/20 dark:text-slate-300 dark:ring-white/10'
              } disabled:opacity-60`}
            ><ThumbsUp size={13} /></button>
            <button
              type="button"
              onClick={() => submitFeedback('down')}
              disabled={feedbackSending}
              title="Thumbs down — plan was wrong or unhelpful"
              aria-label="Thumbs down"
              aria-pressed={feedbackRating === 'down'}
              className={`inline-flex items-center rounded-fb px-2 py-1 text-[12px] ring-1 transition ${
                feedbackRating === 'down'
                  ? 'bg-rose-100 text-rose-700 ring-rose-300 dark:bg-rose-500/20 dark:text-rose-200 dark:ring-rose-500/40'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-rose-50 dark:bg-black/20 dark:text-slate-300 dark:ring-white/10'
              } disabled:opacity-60`}
            ><ThumbsDown size={13} /></button>
            <span className="ml-2 text-[11px] text-slate-400">
              feeds the v5 training corpus — comment box optional
            </span>
          </div>
          <textarea
            value={feedbackComment}
            onChange={e => setFeedbackComment(e.target.value)}
            placeholder="Optional: describe what went wrong, what you expected, or which action is off. Submitted with the thumb above."
            className="input-tool mt-1.5 min-h-[44px] w-full resize-y text-[11px] leading-snug"
          />
        </div>
      )}
      {run.plan && feedbackSent && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-2.5 py-1.5 text-[11px] text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/[0.05] dark:text-emerald-200">
          <CheckCircle size={13} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />
          Feedback saved ({feedbackRating === 'up' ? 'helpful' : 'not helpful'}) — thanks, this is going into the next training round.
        </div>
      )}

      {/* Model thinking BELOW the plan — the plan is the user's primary
          output; the thinking is supplementary "show your work" content.
          Auto-scrolls to the latest line during streaming so the user sees
          something actively happening, not just a static end-of-stream blob. */}
      {(showThinking || showTokens || isBusy) && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2 dark:border-white/10 dark:bg-white/[0.03]">
          {showThinking && (
            <div className="mb-1 rounded bg-white px-2 py-1.5 text-[11px] text-slate-700 ring-1 ring-emerald-200 dark:bg-black/10 dark:text-slate-200 dark:ring-emerald-500/30">
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                <span className="inline-flex items-center gap-1"><Lightbulb size={12} aria-hidden="true" />Model thinking {isBusy && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 align-middle"></span>}</span>
                <span className="font-normal text-slate-400">{run.thinking.length} chars · {elapsed}s</span>
              </div>
              <pre
                ref={el => {
                  // Auto-scroll to bottom on each render while streaming so
                  // newly-arrived tokens are always visible — matches what
                  // ChatGPT/Claude do during streaming.
                  if (el && isBusy) el.scrollTop = el.scrollHeight;
                }}
                className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-700 dark:text-slate-200"
              >{run.thinking}</pre>
            </div>
          )}
          {showTokens && (
            <details className="mb-1 rounded bg-white px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-200 dark:bg-black/10 dark:text-slate-300 dark:ring-white/10">
              <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">Streamed JSON output ({run.tokens.length} chars)</summary>
              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-900/90 p-1.5 font-mono text-[11px] text-slate-100">{run.tokens}</pre>
            </details>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Command history</div>
        <div className="flex-1" />
        <AnalysisButton onClick={exportJson} disabled={commandHistory.length === 0} variant="outline" size="sm">Export JSON</AnalysisButton>
        <AnalysisButton onClick={exportTsv} disabled={commandHistory.length === 0} variant="outline" size="sm">Export TSV</AnalysisButton>
        <AnalysisButton onClick={clearCommandHistory} disabled={commandHistory.length === 0} variant="dangerOutline" size="sm">Clear</AnalysisButton>
      </div>

      {commandHistory.length === 0 ? (
        <AnalysisStatus kind="empty" center title="No Copilot commands yet">
          Plan and run a command above to record reproducible browser steps here.
        </AnalysisStatus>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {commandHistory.map(entry => (
            <div key={entry.id} className="rounded-lg border border-slate-200 bg-white p-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
              <div className="truncate font-medium text-slate-700 dark:text-slate-200" title={entry.text}>{entry.text}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                {new Date(entry.timestamp).toLocaleString()} · {entry.status}{entry.planner ? ` · ${entry.planner}` : ''}
              </div>
              {(entry.trace ?? []).length > 0 && (
                <details className="mt-1 rounded bg-slate-50 px-2 py-1 dark:bg-black/10">
                  <summary className="cursor-pointer text-[11px] text-slate-600 dark:text-slate-300">Trace</summary>
                  <div className="mt-1 space-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {entry.trace?.map(row => <div key={row}>{row}</div>)}
                  </div>
                </details>
              )}
              {entry.debug !== undefined && entry.debug !== null && (
                <details className="mt-1 rounded bg-slate-50 px-2 py-1 dark:bg-black/10">
                  <summary className="cursor-pointer text-[11px] text-slate-600 dark:text-slate-300">Model debug</summary>
                  <pre className="mt-1 max-h-60 overflow-auto rounded bg-slate-900/90 p-1.5 text-[11px] text-slate-100">
                    {truncateText(JSON.stringify(entry.debug ?? {}, null, 2), 24000)}
                  </pre>
                </details>
              )}
              <div className="mt-1 space-y-1">
                {entry.actions.map((action, index) => (
                  <details key={action.id} className="rounded bg-slate-50 px-2 py-1 dark:bg-black/10">
                    <summary className="cursor-pointer text-[11px] text-slate-600 dark:text-slate-300">
                      <span className="font-mono text-slate-400">{index + 1}.</span> {action.summary}
                      <span className={`ml-1 rounded px-1 py-0.5 text-[11px] ${
                        action.status === 'success'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                          : action.status === 'error'
                            ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                            : 'bg-slate-200 text-slate-500 dark:bg-white/10 dark:text-slate-300'
                      }`}>
                        {action.status}
                      </span>
                    </summary>
                    {action.message && <ActionMessage message={action.message} />}
                    {action.apiEquivalent && (
                      <pre className="mt-1 max-h-28 overflow-auto rounded bg-slate-900/90 p-1.5 text-[11px] text-slate-100">
                        {JSON.stringify(action.apiEquivalent, null, 2)}
                      </pre>
                    )}
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
