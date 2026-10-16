import { fetchApiResponse, fetchJson } from './sharedFetch';
import { useBrowserStore } from '../stores/browserStore';
import { computeCopilotDiagnostics, computeCopilotRawState, type CopilotDiagnostic, type CopilotDiagnosticExtras } from '../utils/copilotDiagnostics';

const API_BASE = '/api';

export interface NaturalLanguageAction {
  type: string;
  [key: string]: unknown;
}

export interface NaturalLanguagePlan {
  success: boolean;
  planner?: string;
  original_text?: string;
  summary?: string;
  actions: NaturalLanguageAction[];
  warnings?: string[];
  needs_confirmation?: boolean;
  error?: string;
  elapsed_ms?: number;
  stats?: Record<string, unknown>;
  debug?: Record<string, unknown>;
}

export interface CopilotApiRoute {
  path: string;
  methods: string[];
  allowed_methods: string[];
  copilot_allowed: boolean;
  blocked_methods: Record<string, string>;
  name?: string;
  description?: string;
}

export interface CopilotModelEntry {
  id: string;
  label: string;
  base: string;
  size_b: number;
  min_ram_gb: number;
  recommended_ram_gb: number;
  tier: string;
  trained: boolean;
  deprecated?: boolean;
  quantized?: boolean;
  version?: number;
  fused_path?: string | null;
  description?: string;
  fit?: 'comfortable' | 'minimum' | 'insufficient' | 'unknown';
  download_gb?: number | null;
}

export interface CopilotModelRegistry {
  system_ram_gb: number | null;
  models: CopilotModelEntry[];
  recommended_id: string | null;
  trained_count: number;
  latest_per_tier?: string[];
  update_available?: Record<string, string>;
}

export interface CopilotCapabilities {
  success: boolean;
  safe_methods: string[];
  routes: CopilotApiRoute[];
  allowed_count: number;
  blocked_count: number;
  notes?: string[];
  system_prompt?: string;
  backend?: 'ollama' | 'mlx';
  default_model?: string;
  available_models?: string[];
  model_warning?: string;
  copilot_ready?: boolean;
  mlx_reachable?: boolean;
  mlx_probe_error?: string | null;
  /** Why this machine can't run the local (MLX) Copilot model, in plain words;
   *  null on an Apple Silicon Mac with a native arm64 Python. */
  local_copilot_problem?: string | null;
  ollama_url?: string;
  mlx_url?: string;
  keep_alive?: string;
  model_registry?: CopilotModelRegistry;
}

export type CopilotEvent =
  | { event: 'start'; model: string; requested_model: string; prompt_chars: number; system_chars: number; keep_alive?: string; viewport?: Record<string, unknown> }
  | { event: 'thinking'; delta: string }
  | { event: 'token'; delta: string }
  | { event: 'raw'; content: string; parsed: unknown }
  | { event: 'warning'; message: string }
  | { event: 'error'; message: string; elapsed_ms?: number; setup_needed?: boolean }
  | { event: 'plan'; success: boolean; planner: string; actions: NaturalLanguageAction[]; warnings: string[]; summary: string; needs_confirmation?: boolean; original_text?: string; elapsed_ms?: number; stats?: Record<string, unknown> }
  | { event: 'done' };

export async function getCopilotCapabilities(): Promise<CopilotCapabilities> {
  return fetchJson(`${API_BASE}/nl/capabilities`);
}

export interface ShareStatus {
  success: boolean;
  absolute_path: string;
  exists: boolean;
  line_count: number;
  size_bytes: number;
}

export async function getShareStatus(): Promise<ShareStatus> {
  return fetchJson(`${API_BASE}/nl/share_status`);
}

export async function clearSharedUsage(): Promise<{ success: boolean }> {
  return fetchJson(`${API_BASE}/nl/share_clear`, { method: 'POST' });
}

export async function revealSharedUsage(): Promise<{ success: boolean; absolute_path?: string; error?: string }> {
  return fetchJson(`${API_BASE}/nl/share_reveal`, { method: 'POST' });
}

export interface ShareUploadStatus {
  configured: boolean;
  host?: string;
  has_token?: boolean;
}

export async function getShareUploadStatus(): Promise<ShareUploadStatus> {
  return fetchJson(`${API_BASE}/nl/share_upload_status`);
}

export interface ShareSendResult {
  success: boolean;
  status_code?: number;
  response?: string;
  bytes_sent?: number;
  lines_sent?: number;
  error?: string;
}

export async function sendSharedUsage(): Promise<ShareSendResult> {
  return fetchJson(`${API_BASE}/nl/share_send`, { method: 'POST' });
}

export interface BackendProbe {
  current: 'mlx' | 'ollama';
  mlx_reachable: boolean;
  mlx_models?: string[];
  ollama_reachable: boolean;
}

export async function probeBackends(): Promise<BackendProbe> {
  return fetchJson(`${API_BASE}/nl/probe_backends`);
}

export async function setBackend(backend: 'mlx' | 'ollama'): Promise<{ success: boolean; current?: string; error?: string }> {
  return fetchJson(`${API_BASE}/nl/set_backend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend }),
  });
}

export interface CopilotSetupRequest {
  model_id?: string;
}

export interface CopilotSetupResult {
  success: boolean;
  model?: string;
  message?: string;
  error?: string;
}

export async function setupCopilot(req: CopilotSetupRequest = {}): Promise<CopilotSetupResult> {
  return fetchJson(`${API_BASE}/nl/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export type CopilotDownloadState = 'idle' | 'downloading' | 'spawning' | 'ready' | 'error';

export interface CopilotDownloadStatus {
  state: CopilotDownloadState;
  model_id?: string | null;
  label?: string | null;
  bytes_total?: number;
  bytes_done?: number;
  pct?: number;
  message?: string;
  error?: string | null;
  /** The model server's last log lines when it failed to start. */
  log_tail?: string | null;
}

export interface CopilotDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  title: string;
  detail: string;
  fix: string;
}

export interface CopilotDoctorReport {
  verdict: 'ready' | 'needs_download' | 'needs_fix' | 'unsupported';
  summary: string;
  checks: CopilotDoctorCheck[];
  host?: Record<string, unknown>;
}

/** The setup check (`python browser.py --copilot-doctor` in the panel). */
export async function getCopilotDoctor(): Promise<CopilotDoctorReport> {
  return fetchJson(`${API_BASE}/nl/doctor`);
}

/** Begin a consented model download in the background (non-blocking). Poll
 *  getCopilotDownloadStatus() for byte-level progress + the auto-start. */
export async function startCopilotDownload(modelId?: string): Promise<CopilotDownloadStatus & { success: boolean }> {
  return fetchJson(`${API_BASE}/nl/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(modelId ? { model_id: modelId } : {}),
  });
}

export async function getCopilotDownloadStatus(): Promise<CopilotDownloadStatus> {
  return fetchJson(`${API_BASE}/nl/download_status`);
}

export interface CopilotPreviousTurn {
  text: string;
  summary?: string;
  actions?: Array<Record<string, unknown>>;
}

/** Troubleshooting context sent with every Copilot request (see utils/copilotDiagnostics). */
export interface CopilotTroubleshooting {
  diagnostics: CopilotDiagnostic[];
  raw_state: Record<string, unknown>;
}

/** The browser's current diagnostics and compact state, read from the store. */
export function collectCopilotTroubleshooting(extras?: CopilotDiagnosticExtras): CopilotTroubleshooting {
  const state = useBrowserStore.getState();
  try {
    return {
      diagnostics: computeCopilotDiagnostics(state, extras),
      raw_state: computeCopilotRawState(state, extras),
    };
  } catch {
    // Diagnostics are a help, never a reason for a request to fail.
    return { diagnostics: [], raw_state: {} };
  }
}

export async function planNaturalLanguageCommand(
  text: string,
  context?: Record<string, unknown>,
  options?: { model?: string; previousTurns?: CopilotPreviousTurn[]; troubleshooting?: CopilotTroubleshooting },
): Promise<NaturalLanguagePlan> {
  const troubleshooting = options?.troubleshooting ?? collectCopilotTroubleshooting();
  return fetchJson(`${API_BASE}/nl/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      context: context ?? null,
      model: options?.model || null,
      previous_turns: options?.previousTurns ?? null,
      diagnostics: troubleshooting.diagnostics,
      raw_state: troubleshooting.raw_state,
    }),
  });
}

/**
 * Stream a Copilot plan and invoke `onEvent` for every NDJSON event.
 * Resolves when the server sends `{event:"done"}` or the stream closes.
 */
export async function streamNaturalLanguageCommand(
  text: string,
  context: Record<string, unknown> | undefined,
  onEvent: (event: CopilotEvent) => void,
  options?: { model?: string; signal?: AbortSignal; previousTurns?: CopilotPreviousTurn[]; troubleshooting?: CopilotTroubleshooting },
): Promise<void> {
  const troubleshooting = options?.troubleshooting ?? collectCopilotTroubleshooting();
  const response = await fetchApiResponse(`${API_BASE}/nl/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      context: context ?? null,
      model: options?.model || null,
      previous_turns: options?.previousTurns ?? null,
      diagnostics: troubleshooting.diagnostics,
      raw_state: troubleshooting.raw_state,
    }),
    signal: options?.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Copilot stream failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line) as CopilotEvent);
        } catch {
          // Ignore malformed lines; the server only emits valid JSON events.
        }
      }
      newline = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail) as CopilotEvent);
    } catch {
      // Ignore.
    }
  }
}
