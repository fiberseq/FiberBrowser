/**
 * Named nucleosome classes (small, hexasome, octasome, chromatosome) were removed (owner, 20 Nov 2026): they need an
 * absolute control the data does not have, and FiberHMM 3.2.0 stops writing them. Saved rules (sessions, presets,
 * crash recovery, imported labeling files, rule snapshots in sort/filter/cluster terms) may still carry `nucNamed`
 * (`nuc_named` in request payloads): the condition is dropped on load, the rest of the rule is kept, and one notice per
 * load says how many conditions were dropped.
 */

let pending = 0;
let scheduled = false;

export function nucNamedRemovedNotice(count: number): string {
  return `Named nucleosome classes were removed; ${count} rule condition${count === 1 ? ' was' : 's were'} dropped.`;
}

function hasCodes(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Count `count` dropped conditions toward this load's notice (one notice per task, however many rules). */
export function noteNucNamedDropped(count = 1): void {
  if (count <= 0) return;
  pending += count;
  if (scheduled) return;
  scheduled = true;
  setTimeout(flushNucNamedNotice, 0);
}

/** Show the pending notice now (tests; the timer otherwise). */
export function flushNucNamedNotice(): void {
  scheduled = false;
  const count = pending;
  pending = 0;
  if (count <= 0) return;
  // Lazily: this module is imported by the store's own helpers.
  void import('../stores/browserStore').then(({ useBrowserStore }) => {
    useBrowserStore.getState().setError?.(nucNamedRemovedNotice(count));
  }).catch(() => undefined);
}

/** Does this saved rule carry a named-class condition (a non-empty `nucNamed` / `nuc_named`)? */
export function hasNucNamedCondition(rule: unknown): boolean {
  if (!rule || typeof rule !== 'object') return false;
  const raw = rule as Record<string, unknown>;
  return hasCodes(raw.nucNamed) || hasCodes(raw.nuc_named);
}

/** The rule without its named-class condition (counted for the notice when it set one); idempotent. */
export function withoutNucNamed<T>(rule: T): T {
  if (!rule || typeof rule !== 'object') return rule;
  const raw = rule as Record<string, unknown>;
  if (!('nucNamed' in raw) && !('nuc_named' in raw)) return rule;
  if (hasNucNamedCondition(raw)) noteNucNamedDropped(1);
  const { nucNamed: _named, nuc_named: _snake, ...rest } = raw;
  return rest as T;
}
