/**
 * One identity per footprint class across panels (usability audit Top 4, FP-1): every panel that lists classes, the
 * Footprints class table and Saved name a class by its own id, "Class 025" (saved: "S1 · Class 025"), never by a per-view rank.
 * Run ids are labelled with what kind of run they are ("Footprint run 26a1…", and in the lab build the source run of
 * another panel's classes).
 *
 * The class's own id is the family / class_id / consensusStateId the panels that show a class share.
 */

export type ClassRef = string | number | { family?: string | number | null; class_id?: string | number | null; label?: string | null; id?: string | number | null };

/** The class id's number: the last run of digits in it ("025" → 25, "cr_25" → 25, "F0004" → 4); null if none. */
export function classNumber(id: string | number | null | undefined): number | null {
  if (id == null) return null;
  if (typeof id === 'number') return Number.isFinite(id) ? Math.trunc(id) : null;
  const m = /(\d+)(?!.*\d)/.exec(id);
  return m ? Number(m[1]) : null;
}

function idOf(ref: ClassRef): string | number | null {
  if (typeof ref === 'string' || typeof ref === 'number') return ref;
  return ref.family ?? ref.class_id ?? ref.id ?? ref.label ?? null;
}

/** "Class 025": the class's id, zero-padded to three digits; an id without a number keeps its own text ("Class A"). */
export function classLabel(ref: ClassRef): string {
  const id = idOf(ref);
  const n = classNumber(id);
  if (n != null) return `Class ${String(n).padStart(3, '0')}`;
  const text = id == null ? '' : String(id).replace(/^class\s*/i, '').trim();
  return text ? `Class ${text}` : 'Class';
}

/** "S1 · Class 025": a class saved in the Footprints panel's Saved list (slot from 1). */
export function savedClassLabel(slot: number, ref: ClassRef): string {
  return `S${slot} · ${classLabel(ref)}`;
}

export type RunKind = 'footprint'
  | 'nfr' | 'source-nfr'
;

const RUN_NAMES: Record<RunKind, string> = {
  footprint: 'Footprint run',
  nfr: 'NFR run',
  // An NFR run named from somewhere else (a Footprints class's provenance): where the classes came from.
  'source-nfr': 'Source NFR run',
};

/** "Footprint run 26a1…": the kind of run and the first 4 characters of its id. */
export function runLabel(kind: RunKind, runId: string | null | undefined): string {
  if (!runId) return RUN_NAMES[kind];
  const short = runId.replace(/[^0-9a-z]/gi, '').slice(0, 4) || runId.slice(0, 4);
  return `${RUN_NAMES[kind]} ${short}${runId.length > short.length ? '…' : ''}`;
}

/** The full form for a tooltip: "Footprint run 26a17840-…". */
export function runTitle(kind: RunKind, runId: string | null | undefined): string {
  return runId ? `${RUN_NAMES[kind]} ${runId}` : RUN_NAMES[kind];
}
