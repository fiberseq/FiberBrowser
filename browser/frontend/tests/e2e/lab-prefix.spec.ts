/**
 * A lab server (profile "lab", built-in accounts) behind a stand-in for Open
 * OnDemand's reverse proxy (deploy/ondemand/dev/rnode_proxy.py), which serves it
 * at /rnode/localhost/<port>/ and answers 404 to anything outside that prefix:
 * sign in, the app loads, its requests all go through the prefix (with the
 * CSRF header), data opens from the lab data folder, a session goes on the lab
 * shelf, and signing out ends it. Needs the frontend build (npm run build).
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect, test } from './fixtures/nativeDialogs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(__dirname, '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const DEMO_BAM = path.join(REPO_ROOT, 'browser', 'data', 'demo', 'napa_ddda.bam');
const PASSWORD = 'lab test password';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitFor(url: string, timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

function logTo(proc: ChildProcess, name: string) {
  proc.stdout?.on('data', d => process.stderr.write(`[${name}] ${d}`));
  proc.stderr?.on('data', d => process.stderr.write(`[${name}] ${d}`));
}

let server: ChildProcess | null = null;
const proxies: ChildProcess[] = [];
let prefix = '';
let proxyUrl = '';
let keepPrefixUrl = '';
let dataDir = '';

test.beforeAll(async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-lab-'));
  dataDir = path.join(scratch, 'data');
  mkdirSync(dataDir);
  mkdirSync(path.join(scratch, 'runs'));
  copyFileSync(DEMO_BAM, path.join(dataDir, 'napa_ddda.bam'));
  copyFileSync(`${DEMO_BAM}.bai`, path.join(dataDir, 'napa_ddda.bam.bai'));
  const port = await freePort();
  const proxyPort = await freePort();
  const keepPort = await freePort();
  prefix = `/rnode/localhost/${port}`;
  const config = path.join(scratch, 'server.toml');
  writeFileSync(config, [
    'profile = "lab"',
    '[server]', 'host = "127.0.0.1"', `port = ${port}`, `root_path = "${prefix}"`,
    '[[data.roots]]', `path = "${dataDir}"`, 'label = "Lab data"',
    '[[data.roots]]', `path = "${path.join(scratch, 'runs')}"`, 'label = "Runs"', 'writable = true',
    '[state]', `dir = "${path.join(scratch, 'state')}"`,
    '[auth]', 'mode = "accounts"',
    '',
  ].join('\n'));
  const env = {
    ...process.env,
    HOME: path.join(scratch, 'home'),
    PYTHONUNBUFFERED: '1',
    FIBERBROWSER_SETTINGS: path.join(REPO_ROOT, 'tests', '__no_user_settings__.json'),
    FIBERBROWSER_RUNTIME_FILE: path.join(scratch, 'runtime.json'),
    FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN: '1',
  };
  const added = spawnSync(PYTHON, ['-m', 'fiberbrowser', 'users', 'add', 'alice', '--role', 'admin',
    '--password-stdin', '--config', config], { cwd: REPO_ROOT, env, input: `${PASSWORD}\n`, encoding: 'utf-8' });
  expect(added.status, added.stderr).toBe(0);
  server = spawn(PYTHON, ['-m', 'fiberbrowser', 'serve', '--config', config], { cwd: REPO_ROOT, env });
  logTo(server, 'lab-server');
  const proxyScript = path.join(REPO_ROOT, 'deploy', 'ondemand', 'dev', 'rnode_proxy.py');
  for (const [listen, extra] of [[proxyPort, []], [keepPort, ['--keep-prefix']]] as const) {
    const proc = spawn(PYTHON, [proxyScript, '--listen', String(listen), '--backend', `127.0.0.1:${port}`,
      '--prefix', prefix, '--quiet', ...extra], { cwd: REPO_ROOT, env });
    logTo(proc, 'proxy');
    proxies.push(proc);
  }
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
  keepPrefixUrl = `http://127.0.0.1:${keepPort}`;
  await waitFor(`${proxyUrl}${prefix}/auth/login`);
  await waitFor(`${keepPrefixUrl}${prefix}/auth/login`);
});

test.afterAll(async () => {
  for (const proc of [server, ...proxies]) proc?.kill('SIGTERM');
});

test('a lab member signs in and works under the OnDemand-style prefix', async ({ page }) => {
  const outside: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === proxyUrl && !url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) {
      outside.push(`${response.status()} ${url.pathname}`);
    }
  });

  // No genome autoload: with an empty scratch HOME it would download hg38 (3 GB) and hold up the dataset add below.
  await page.addInitScript(() => { (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true; });
  await page.goto(`${proxyUrl}${prefix}/`);
  await expect(page).toHaveURL(new RegExp(`${prefix}/auth/login`));
  await page.getByLabel('User name').fill('alice');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${prefix}/(\\?.*)?$`));
  await expect(page.getByTestId('lab-user')).toHaveText('alice (admin)');
  // The app itself is up (its sidebar), with requests of its own through the prefix.
  await page.waitForFunction(() => document.querySelectorAll('button').length > 20, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);

  // The app's own /api/... requests go through the prefix and carry the CSRF header.
  const me = await page.evaluate(() => fetch('/api/auth/me').then(r => r.json()));
  expect(me.user.name).toBe('alice');
  const added = await page.evaluate(async bam => {
    const response = await fetch('/api/datasets/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bam }),
    });
    return { status: response.status, body: await response.json() };
  }, path.join(dataDir, 'napa_ddda.bam'));
  expect(added.status).toBe(200);
  expect(added.body.success, JSON.stringify(added.body)).toBeTruthy();
  const refused = await page.evaluate(() => fetch('/api/files/list?path=/etc').then(r => r.status));
  expect(refused).toBe(403);

  // The lab session shelf (Data & Sessions).
  const saved = await page.evaluate(() => fetch('/api/lab/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'prefix smoke', session: { viewport: { chrom: 'chr19' } } }),
  }).then(r => r.json()));
  expect(saved.user).toBe('alice');

  // Admin page, under the prefix too.
  const admin = await page.context().newPage();
  await admin.goto(`${proxyUrl}${prefix}/admin`);
  await expect(admin.getByRole('heading', { name: 'Lab admin' })).toBeVisible();
  await expect(admin.locator('#users')).toContainText('alice');
  await expect(admin.locator('#audit')).toContainText('session_save');
  await admin.close();

  expect(outside, 'requests that missed the prefix').toEqual([]);
  const shots = process.env.FIBERBROWSER_E2E_SCREENSHOT_DIR;
  if (shots) await page.screenshot({ path: path.join(shots, 'lab-prefix.png') });

  await page.getByTestId('lab-signout').click();
  await expect(page).toHaveURL(new RegExp(`${prefix}/auth/login`));
  // (The sign-in page is plain HTML without the app's prefix layer: use the full path.)
  const after = await page.evaluate(p => fetch(`${p}/api/datasets`).then(r => r.status), prefix);
  expect(after).toBe(401);
});

test('a proxy that forwards the prefix (OnDemand /node/ style) works too', async ({ request }) => {
  const login = await request.get(`${keepPrefixUrl}${prefix}/auth/login`);
  expect(login.status()).toBe(200);
  expect(await login.text()).toContain(`action='${prefix}/auth/login'`);
  const api = await request.get(`${keepPrefixUrl}${prefix}/api/datasets`);
  expect(api.status()).toBe(401);
});
