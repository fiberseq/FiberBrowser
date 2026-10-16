/**
 * Server fixture: spawns a real FiberBrowser Python backend with a test BAM,
 * waits for /api/status to return, and yields the base URL. The server is
 * torn down after each test so state-mutating workflow tests stay isolated.
 *
 * Override defaults via env:
 *   FIBERBROWSER_TEST_DATA_DIR     — optional lab data dir (its fly_lab_data layout, or its parent);
 *                                    the same variable tests/conftest.py reads. FIBERHMM_E2E_DATA_DIR is
 *                                    still accepted as an older alias.
 *   FIBERBROWSER_TEST_BAM          — path to BAM (default: the rich DAF BAM under FIBERBROWSER_TEST_DATA_DIR,
 *                                    else the tracked demo BAM browser/data/demo/napa_ddda.bam, whose
 *                                    default region is chr19:47514000-47518000)
 *   FIBERBROWSER_TEST_FASTA        — optional indexed reference FASTA (needed by evidence-model workflows)
 *   FIBERBROWSER_TEST_REGION       — region as chrom:start-end for richer workflow tests
 *   FIBERBROWSER_TEST_BIGBED       — representative standard Fiber-seq BigBed for parser tests
 *   FIBERBROWSER_TEST_BIGBED_DIR   — optional full Fiber-seq BigBed directory for heavier manual tests
 *   FIBERBROWSER_TEST_PORT         — preferred server port (free fallback within FIBERBROWSER_TEST_PORTS)
 *   FIBERBROWSER_TEST_PORTS        — comma-separated ports test servers may use (default 8880–8889 without
 *                                    8886 and 8888, a developer's own FiberBrowser and Jupyter ports)
 *   FIBERBROWSER_TEST_PYTHON       — Python interpreter that runs browser.py (default: `python` on PATH)
 *   FIBERBROWSER_TEST_DIR          — repo root (default: ../../.. from this file)
 *   FIBERBROWSER_TEST_PANEL_LAUNCHER — where the analysis panel launchers are: `rail` (default, the
 *                                    app's default: tiles in the sidebar rail) or `strip` (the classic
 *                                    strip above the reads, as if each viewer had chosen it)
 */
import { spawn, type ChildProcess } from 'child_process';
import { test as base, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(__dirname, '../../../../..');

const DEFAULT_TEST_PORTS = [8880, 8881, 8882, 8883, 8884, 8885, 8887, 8889];

/** The ports test servers may use (FIBERBROWSER_TEST_PORTS, else the default list). */
export function testPorts(raw = process.env.FIBERBROWSER_TEST_PORTS): number[] {
  const text = raw?.trim();
  if (!text) return DEFAULT_TEST_PORTS;
  const ports = text.split(',').map(p => p.trim()).filter(Boolean).map(Number);
  if (!ports.length || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`FIBERBROWSER_TEST_PORTS must list ports: ${raw}`);
  }
  return ports;
}
const TEST_PORTS = testPorts();
const portListText = () => TEST_PORTS.join(', ');
const RICH_DAF_REGION = { chrom: 'chr2R', start: 9_929_319, end: 10_029_319 };
// The tracked NAPA demo BAM: 3,202 DddA reads on chr19 starting 47,514,488-47,517,768.
const DEMO_REGION = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };

// Lab data is opt-in (no machine-specific default location); without it the
// tests run on the demo BAM tracked in the repository.
const DEMO_BAM = path.join(REPO_ROOT, 'browser', 'data', 'demo', 'napa_ddda.bam');

function resolveDrosophilaDataDir(): string {
  const configured = (process.env.FIBERBROWSER_TEST_DATA_DIR ?? process.env.FIBERHMM_E2E_DATA_DIR)?.trim();
  if (configured) {
    const root = path.resolve(configured);
    const nested = path.join(root, 'fly_lab_data');
    return existsSync(nested) ? nested : root;
  }
  return path.join(REPO_ROOT, '.no-e2e-data-dir');
}

const DROSOPHILA_DIR = resolveDrosophilaDataDir();
const DAF_TIMECOURSE = path.join(DROSOPHILA_DIR, 'Datasets', 'DAF-seq', 'daf_timecourse');
const RICH_DAF_BAM = path.join(DAF_TIMECOURSE, 'fp_update', 'stage_d_recalled.bam');
const CURRENT_FIBER_BIGBED = path.join(DROSOPHILA_DIR, 'Datasets', 'Fiber-seq', 'recall_v3seg', '2-4', 'sample_10_nucleosome.bb');
const CURRENT_FIBER_BIGBED_DIR = path.join(DROSOPHILA_DIR, 'Datasets', 'Fiber-seq', 'recall_v3seg', '2-4');

export interface ServerFixture {
  port: number;
  baseUrl: string;
  bamPath: string;
  defaultRegion?: { chrom: string; start: number; end: number };
  fiberBigBedPath?: string;
  fiberBigBedDir?: string;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find(p => existsSync(p));
}

/** A BigBed that is really there (Dropbox leaves 0-byte placeholders for offline files). */
function hydratedFile(p: string): string | undefined {
  try {
    return statSync(p).size > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

function parseRegion(value: string | undefined): ServerFixture['defaultRegion'] {
  if (!value) return undefined;
  const m = value.replace(/,/g, '').match(/^([^:]+):(\d+)-(\d+)$/);
  if (!m) return undefined;
  return { chrom: m[1], start: Number(m[2]), end: Number(m[3]) };
}

function defaultRegionForBam(bamPath: string): ServerFixture['defaultRegion'] {
  if (path.resolve(bamPath) === path.resolve(RICH_DAF_BAM)) return RICH_DAF_REGION;
  if (path.resolve(bamPath) === path.resolve(DEMO_BAM)) return DEMO_REGION;
  return undefined;
}

export type ServerProcess = ChildProcess & { port: number; baseUrl: string };

async function waitForServer(proc: ChildProcess, listeningPort: () => number | undefined, timeoutMs = 45_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('Test server exited before becoming ready');
    try {
      const port = listeningPort();
      if (port !== undefined) {
        if (!TEST_PORTS.includes(port)) throw new Error(`Test server left its allowed ports (${portListText()})`);
        const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok && proc.exitCode === null && proc.signalCode === null) return port;
      }
    } catch { /* this child's listener is not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Test server did not become ready within ${timeoutMs}ms`);
}

/** Stop only the child we spawned, waiting for exit before the next test. */
export async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }, 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

/** Whether something accepts connections on host:port (refused or unreachable: no). */
function somethingListens(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = (listening: boolean) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(500, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', (err: NodeJS.ErrnoException) => done(!['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT'].includes(err.code ?? '')));
  });
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * Free only when nothing listens on it and it binds on both addresses. A bind alone is fooled on macOS: Node
 * binds with SO_REUSEADDR, and a 0.0.0.0 bind then succeeds next to another process's 127.0.0.1 listener (the
 * 3.0.0 audit's test servers landed on a developer's port that way), so ask the port first.
 */
export async function portIsFree(port: number): Promise<boolean> {
  if (await somethingListens(port, '127.0.0.1') || await somethingListens(port, '::1')) return false;
  return await canBind(port, '127.0.0.1') && await canBind(port, '0.0.0.0');
}

export async function pickRandomPort(): Promise<number> {
  const preferred = Number(process.env.FIBERBROWSER_TEST_PORT);
  return pickPort(TEST_PORTS.includes(preferred) ? preferred : TEST_PORTS[Math.floor(Math.random() * TEST_PORTS.length)]);
}

/** The first free test port from `preferred` on (in list order, wrapping), skipping `exclude`. */
export async function pickPort(preferred: number, exclude: number[] = []): Promise<number> {
  const start = TEST_PORTS.indexOf(preferred);
  if (start < 0) throw new Error(`Test ports must be one of ${portListText()} (FIBERBROWSER_TEST_PORTS)`);
  for (let i = 0; i < TEST_PORTS.length; i++) {
    const port = TEST_PORTS[(start + i) % TEST_PORTS.length];
    if (!exclude.includes(port) && await portIsFree(port)) return port;
  }
  throw new Error(`No free test port in ${portListText()} (FIBERBROWSER_TEST_PORTS)`);
}

/**
 * Start the FiberBrowser backend with a BAM. Returns the process handle.
 * Uses `python browser.py -b <bam> -p <port> --no-open` from the repo root (no `-b` when
 * bamPath is null; `extraArgs` are appended, e.g. several `--dataset` and a `--fasta`).
 * Exported for specs that stop and start their own server (session reopen).
 */
export async function startServer(
  bamPath: string | null, port: number, options: { runtimeFile?: string; extraArgs?: string[]; public?: boolean; token?: string } = {},
): Promise<ServerProcess> {
  // The port is checked here and the server may use only it (FIBERBROWSER_PORT_MIN = MAX): its own fallback walks a
  // range, which could reach a port outside the test list. Taken in between: the next free test port.
  const tried: number[] = [];
  for (let attempt = 0; ; attempt++) {
    const free = await pickPort(TEST_PORTS.includes(port) ? port : TEST_PORTS[0], tried);
    tried.push(free);
    try {
      return await startServerOn(bamPath, free, options);
    } catch (err) {
      if (attempt >= 2 || !(err instanceof Error) || !/exited before becoming ready/.test(err.message)) throw err;
    }
  }
}

async function startServerOn(
  bamPath: string | null, port: number, options: { runtimeFile?: string; extraArgs?: string[]; public?: boolean; token?: string },
): Promise<ServerProcess> {
  const runtimeFile = options.runtimeFile ?? path.join(mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-runtime-')), 'browser_runtime.json');
  const copilotMode = process.env.FIBERBROWSER_E2E_COPILOT?.trim() || 'off';
  // --no-token: the specs drive the UI and API directly on a throwaway server
  // (the access token itself is covered by tests/test_local_auth.py).
  // No BAM: the spec names its data in extraArgs (e.g. several --dataset).
  const args = ['browser.py', ...(bamPath ? ['-b', bamPath] : []), '-p', String(port), '--copilot', copilotMode, '--no-open', ...(options.public ? ['--public', '--host', '127.0.0.1'] : options.token ? [] : ['--no-token'])];
  // A scratch Library (never the user's ~/.fiberhmm/library.json) with an empty
  // job registry, no rescan of watched folders at startup, and a scratch upload cache.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-library-'));
  const fastaPath = process.env.FIBERBROWSER_TEST_FASTA?.trim();
  if (fastaPath) args.push('--fasta', fastaPath);
  args.push(...(options.extraArgs ?? []));
  const proc = spawn(
    process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
    args,
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...(options.token ? { FIBERBROWSER_TOKEN: options.token } : {}),
        FIBERBROWSER_NO_OPEN: '1',
        FIBERBROWSER_PORT_MIN: String(port),
        FIBERBROWSER_PORT_MAX: String(port),
        PYTHONUNBUFFERED: '1',
        // Never read the developer's ~/.fiberhmm/browser_settings.json (it can pick a
        // FiberHMM source tree or change defaults), and list the throwaway server in a
        // scratch runtime file instead of ~/.fiberhmm/browser_runtime.json.
        FIBERBROWSER_SETTINGS: path.join(REPO_ROOT, 'tests', '__no_user_settings__.json'),
        // Nor the app's own settings, and no update check over the network.
        FIBERBROWSER_APP_SETTINGS: path.join(scratch, 'app_settings.json'),
        FIBERBROWSER_NO_UPDATE_CHECK: '1',
        // A spec that restarts its server passes the same file (and port) again: how the
        // last run ended is recorded next to it (services/launch_state.py).
        FIBERBROWSER_RUNTIME_FILE: runtimeFile,
        FIBERBROWSER_LIBRARY: process.env.FIBERBROWSER_LIBRARY || path.join(scratch, 'library.json'),
        FIBERBROWSER_JOBS_DIR: process.env.FIBERBROWSER_JOBS_DIR || path.join(scratch, 'jobs'),
        FIBERBROWSER_QC_CACHE_DIR: process.env.FIBERBROWSER_QC_CACHE_DIR || path.join(scratch, 'qc_cache'),
        FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN: '1',
        // Dropped files are uploaded to a scratch cache, never ~/.fiberhmm/uploads.
        FIBERBROWSER_UPLOAD_DIR: process.env.FIBERBROWSER_UPLOAD_DIR || path.join(scratch, 'uploads'),
        // Saved regions (the Regions panel's catalog) in a scratch folder, never ~/.fiberhmm/regions.
        FIBERBROWSER_REGION_CATALOG_DIR: process.env.FIBERBROWSER_REGION_CATALOG_DIR || path.join(scratch, 'regions'),
        // Analysis preferences (pinned motifs, Show preview features) in a scratch file, never
        // ~/.fiberhmm/analysis_preferences.json: a spec that flips a switch must not change the developer's.
        FIBERBROWSER_PREFERENCES: process.env.FIBERBROWSER_PREFERENCES || path.join(scratch, 'analysis_preferences.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '', listeningPort: number | undefined;
  const onOutput = (data: Buffer) => {
    process.stderr.write(`[server] ${data}`);
    output = (output + data.toString()).slice(-8192);
    // This child's startup banner contains the resolved port. Public servers
    // do not publish a runtime record and Uvicorn's info log is suppressed.
    // Readiness still requires a successful health request and a live child.
    const match = output.match(/Open http:\/\/localhost:(\d+)/);
    if (match) listeningPort = Number(match[1]);
  };
  proc.stdout?.on('data', onOutput);
  proc.stderr?.on('data', onOutput);
  try {
    port = await waitForServer(proc, () => listeningPort);
  } catch (err) {
    // Never ready on this port (e.g. it moved to another one): stop it, or it
    // outlives the run, since the spec only holds the handle it returns.
    await stopServer(proc);
    throw err;
  }
  return Object.assign(proc, { port, baseUrl: `http://localhost:${port}` });
}

export interface ServerOptions {
  /**
   * Pin a spec to one BAM whatever the environment says: `'demo'` is the tracked
   * browser/data/demo/napa_ddda.bam (with its default region), any other string a
   * path. Use it for specs whose assertions depend on the data (e.g. which
   * footprint a canvas click lands on), so they cannot drift with lab data.
   * Set with `test.use({ fixtureBam: 'demo' })`.
   */
  fixtureBam: string | undefined;
}

/**
 * A narrow window with reads for the zoomed-in UI specs: centred in the fixture's
 * default region (the demo BAM's chr19 locus), else the Drosophila chr2L window
 * those specs were first written against (rich DAF BAM).
 */
export function readWindow(server: ServerFixture, width = 344): [string, number, number] {
  const r = server.defaultRegion;
  if (!r) return ['chr2L', 15_478_106, 15_478_106 + width];
  const mid = Math.floor((r.start + r.end) / 2);
  return [r.chrom, mid - Math.floor(width / 2), mid + Math.ceil(width / 2)];
}

/**
 * Where the analysis panel launchers are for this run (FIBERBROWSER_TEST_PANEL_LAUNCHER):
 * the sidebar rail by default, as in the app, or the classic strip on request.
 */
export const TEST_PANEL_LAUNCHER: 'rail' | 'strip' =
  process.env.FIBERBROWSER_TEST_PANEL_LAUNCHER?.trim().toLowerCase() === 'strip' ? 'strip' : 'rail';

/**
 * An analysis panel's launcher, whichever this run shows: its rail tile or its
 * strip chip (`library`: the Library launcher, which is not a panel).
 */
export function panelButton(page: Page, id: string): Locator {
  return id === 'library'
    ? page.locator('[data-testid="panel-rail-library"], [data-testid="analysis-strip-library"]')
    : page.locator(`[data-testid="panel-rail-${id}"], [data-testid="analysis-strip-button-${id}"]`);
}

/** The analysis panel launchers (the rail's, or the strip, folded or not). */
export function panelLaunchers(page: Page): Locator {
  return page.locator('[data-testid="panel-rail"], [data-testid="analysis-strip"], [data-testid="analysis-strip-collapsed"]');
}

/** The tracked demo BAM and its default region, for specs that assert on it directly. */
export const DEMO_FIXTURE = { bamPath: DEMO_BAM, region: DEMO_REGION };

export const test = base.extend<{ server: ServerFixture } & ServerOptions>({
  fixtureBam: [undefined, { option: true }],
  baseURL: async ({ server }, use) => { await use(server.baseUrl); },
  // FIBERBROWSER_TEST_PANEL_LAUNCHER=strip: the classic strip is every viewer's choice unless a
  // spec (or ?panels=) saves another. It survives the specs' localStorage.clear(), like a build default.
  // A sandbox or workspace tab swaps in its own storage: pass &panels=${TEST_PANEL_LAUNCHER} there.
  context: async ({ context }, use) => {
    if (TEST_PANEL_LAUNCHER === 'strip') {
      await context.addInitScript(() => {
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (this: Storage, key: string) {
          const value = getItem.call(this, key);
          return value == null && key === 'fiberbrowser_panel_launcher' && this === window.localStorage ? 'strip' : value;
        };
      });
    }
    await use(context);
  },
  server: async ({ fixtureBam }, use) => {
    const requestedPort = process.env.FIBERBROWSER_TEST_PORT
      ? Number(process.env.FIBERBROWSER_TEST_PORT)
      : null;
    const port = requestedPort ? await pickPort(requestedPort) : await pickRandomPort();
    const pinned = fixtureBam === 'demo' ? DEMO_BAM : fixtureBam;
    const bamPath = pinned
      ?? process.env.FIBERBROWSER_TEST_BAM
      ?? firstExisting([RICH_DAF_BAM])
      ?? DEMO_BAM;
    const defaultRegion = pinned
      ? defaultRegionForBam(bamPath)
      : parseRegion(process.env.FIBERBROWSER_TEST_REGION) ?? defaultRegionForBam(bamPath);
    const fiberBigBedPath = process.env.FIBERBROWSER_TEST_BIGBED ?? hydratedFile(CURRENT_FIBER_BIGBED);
    const fiberBigBedDir = process.env.FIBERBROWSER_TEST_BIGBED_DIR ?? firstExisting([CURRENT_FIBER_BIGBED_DIR]);
    const proc = await startServer(bamPath, port);
    try {
      await use({
        port: proc.port,
        baseUrl: proc.baseUrl,
        bamPath,
        defaultRegion,
        fiberBigBedPath,
        fiberBigBedDir,
      });
    } finally {
      await stopServer(proc);
    }
  },
});

export { expect } from '@playwright/test';

/**
 * Settings → Show preview features on for this page (Preview features: the Variants panel, insert-expanded panels;
 * src/utils/previewFeatures.ts). Call after any init script that clears localStorage: init scripts run in order.
 */
export async function enablePreviews(page: Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('fiberbrowser_show_preview_features', 'true'); });
}
