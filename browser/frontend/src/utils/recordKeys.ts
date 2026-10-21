/**
 * Record keys (DESIGN_GRAPH_PRIMARY §3.1): a lifted row's record identity — molecule, QNAME, record — independent of
 * its row index and placement, derived from the row's own versioned `analysis_id`. A graph row and the linear rows of
 * the same record share it, so state written in one view (cluster assignments, read filters, sort orders) reads in the
 * other without loading the other view's rows. The server derives the same string (services/lift/cohort.py
 * `record_key`); fixtures/recordKeys.json is shared by both test suites.
 *
 * Native rows have no versioned identity: their QNAME is their key (a native panel's selections and filters are
 * QNAMEs already).
 */

const IDENTITY_PREFIX = 'lift-cohort:v1 ';
const RECORD_PREFIX = 'lift-record:v1 ';

/** JSON as Python's `json.dumps(..., separators=(",", ":"), ensure_ascii=True)` writes it. */
function pyJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

const isRecordPart = (v: unknown) => v === null || typeof v === 'string';

/** The record key of a row identity: an `analysis_id`, a record key itself (returned as is), else null. */
export function recordKey(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith(RECORD_PREFIX)) {
    const parts = parse(id.slice(RECORD_PREFIX.length));
    const ok = Array.isArray(parts) && parts.length === 3 && typeof parts[0] === 'string' && typeof parts[1] === 'string'
      && parts[1] !== '' && isRecordPart(parts[2]);
    return ok && RECORD_PREFIX + pyJson(parts) === id ? id : null;
  }
  if (!id.startsWith(IDENTITY_PREFIX)) return null;
  const parts = parse(id.slice(IDENTITY_PREFIX.length));
  if (!Array.isArray(parts) || parts.length !== 5 || typeof parts[0] !== 'string' || typeof parts[1] !== 'string'
    || parts[1] === '' || !isRecordPart(parts[2]) || IDENTITY_PREFIX + pyJson(parts) !== id) return null;
  return RECORD_PREFIX + pyJson(parts.slice(0, 3));
}

/** The row index and placement of an `analysis_id` (display precedence: the primary placement's lowest row). */
function rowRank(id: string): number {
  if (!id.startsWith(IDENTITY_PREFIX)) return 0;
  const parts = parse(id.slice(IDENTITY_PREFIX.length)) as unknown[] | null;
  if (!Array.isArray(parts)) return 0;
  const row = typeof parts[3] === 'number' ? parts[3] : 0;
  return (parts[4] === 'primary' ? 0 : 1_000_000) + row;
}

const keySets = new WeakMap<object, Set<string>>();

/** The record keys an id set names (memoised per set): a row matches when its record key is in it. */
export function recordKeysOf(ids: ReadonlySet<string> | readonly string[]): Set<string> {
  const hit = keySets.get(ids as object);
  if (hit) return hit;
  const out = new Set<string>();
  for (const id of ids) { const rk = recordKey(id); if (rk) out.add(rk); }
  keySets.set(ids as object, out);
  return out;
}

const valueIndexes = new WeakMap<object, Map<string, number>>();

/**
 * A map keyed by row identity (cluster assignments: `analysis_id` -> label), re-keyed by record key (memoised per
 * map). Where a record's rows carry different values, the primary placement's lowest row index wins (§3.1).
 */
export function recordValueIndex<T extends number>(map: Readonly<Record<string, T>>): Map<string, T> {
  const hit = valueIndexes.get(map as object);
  if (hit) return hit as Map<string, T>;
  const out = new Map<string, T>();
  const rank = new Map<string, number>();
  for (const [id, value] of Object.entries(map)) {
    const rk = recordKey(id);
    if (!rk) continue;
    const r = rowRank(id);
    if (!rank.has(rk) || r < rank.get(rk)!) { rank.set(rk, r); out.set(rk, value); }
  }
  valueIndexes.set(map as object, out);
  return out;
}

const orderIndexes = new WeakMap<object, Map<string, number>>();

/** A sort order (ids, first first) as ranks by id and by record key (memoised per list). */
export function orderIndex(order: readonly string[]): Map<string, number> {
  const hit = orderIndexes.get(order as object);
  if (hit) return hit;
  const out = new Map<string, number>();
  order.forEach((id, i) => {
    if (!out.has(id)) out.set(id, i);
    const rk = recordKey(id);
    if (rk && !out.has(rk)) out.set(rk, i);
  });
  orderIndexes.set(order as object, out);
  return out;
}

/** Whether a row with these identities is named by an id set: any identity exactly, or its record key. */
export function idSetHas(ids: ReadonlySet<string>, keys: readonly (string | null | undefined)[], rk: string | null | undefined): boolean {
  for (const k of keys) if (k && ids.has(k)) return true;
  return Boolean(rk && (ids.has(rk) || recordKeysOf(ids).has(rk)));
}
