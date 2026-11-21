/**
 * Synthetic data for specs that need FiberHMM on the server's Python (nucleosomes, feature-hub*).
 *
 * The rule (coverage plan #10): a missing FiberHMM module is the only reason to skip, and only when
 * FIBERBROWSER_E2E_REQUIRE_FIBERHMM is unset. CI sets it, so there a missing module fails the spec. Once the modules
 * import, any error while writing the data fails the spec with the script's stderr: it never turns into a skip.
 */
import { spawnSync } from 'node:child_process';

export const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
export const REQUIRE_FIBERHMM = /^(1|true|yes)$/i.test(process.env.FIBERBROWSER_E2E_REQUIRE_FIBERHMM?.trim() ?? '');

export interface SyntheticData {
  /** The files the script wrote, or null when the spec must skip. */
  paths: string[] | null;
  /** Why the spec skips (empty when it runs). */
  skipReason: string;
}

/** Why `modules` cannot be imported by PYTHON, or null when they can. */
export function missingModules(modules: string[]): string | null {
  const probe = spawnSync(PYTHON, ['-c', modules.map(m => `import ${m}`).join('\n')], { encoding: 'utf-8' });
  if (probe.error) return `${PYTHON} could not start: ${probe.error.message}`;
  if (probe.status === 0) return null;
  const last = (probe.stderr || '').trim().split('\n').pop() || `exit ${probe.status}`;
  return `${modules.join(', ')} not importable by ${PYTHON}: ${last}`;
}

/**
 * Preflight `modules`, then run `script` (python -c) with `args`; returns `outputs` on success.
 * Throws when the script fails, or when the modules are missing and FIBERBROWSER_E2E_REQUIRE_FIBERHMM is set.
 */
export function makeSyntheticData(opts: { modules: string[]; script: string; args: string[]; outputs: string[] }): SyntheticData {
  const missing = missingModules(opts.modules);
  if (missing) {
    if (REQUIRE_FIBERHMM) throw new Error(`FIBERBROWSER_E2E_REQUIRE_FIBERHMM is set but ${missing}`);
    return { paths: null, skipReason: `needs FiberHMM (${missing})` };
  }
  const run = spawnSync(PYTHON, ['-c', opts.script, ...opts.args], { encoding: 'utf-8' });
  if (run.error) throw new Error(`synthetic data script could not start: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`synthetic data script failed (exit ${run.status}):\n${run.stderr}`);
  return { paths: opts.outputs, skipReason: '' };
}
