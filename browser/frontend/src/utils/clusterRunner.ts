/**
 * The Cluster button's handler (Browser.tsx handleCluster), registered so
 * Copilot and the guided tour cluster exactly as the button does: per panel,
 * with panels at other loci and one-strand panels handled.
 */
let runner: (() => Promise<void>) | null = null;

export function registerClusterRunner(fn: (() => Promise<void>) | null): void {
  runner = fn;
}

/** Run the Cluster button's clustering on the selected peaks; false when no browser view is mounted. */
export async function runUiCluster(): Promise<boolean> {
  const run = runner;
  if (!run) return false;
  await run();
  return true;
}

/** The Scan button's handler (all enabled peak rules), registered the same way. */
let scanRunner: (() => Promise<void>) | null = null;

export function registerScanRunner(fn: (() => Promise<void>) | null): void {
  scanRunner = fn;
}

/** Scan peaks as the Scan button does and wait for every rule; false when no browser view is mounted. */
export async function runUiScan(): Promise<boolean> {
  const run = scanRunner;
  if (!run) return false;
  await run();
  return true;
}
