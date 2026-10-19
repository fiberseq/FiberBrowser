/** Phase-1 reversible migration substrate. Frozen imports never guess a QNAME.
 * Legacy rendering remains available; convergence/relink UI follows in phase 5.
 */
import { DIFFERENCES_SCHEMA, type MoleculeIdentity } from './contracts';

type JsonRecord = Record<string, any>;
export interface ImportMembership {
  status: 'resolved' | 'unresolved_import';
  originalId: string;
  molecule?: MoleculeIdentity;
  currentId?: string;
  reason?: string;
}
export interface DifferencesSession {
  schema_version: typeof DIFFERENCES_SCHEMA;
  versions: Record<string, string>;
  ledger: { schema_version: typeof DIFFERENCES_SCHEMA; records: JsonRecord; seeds: JsonRecord; lineage: JsonRecord; snapshots: JsonRecord };
  targets: Record<string, { target_type: 'geometry'; identity_state: 'provisional'; frozen: true; snapshot: JsonRecord; policy: JsonRecord; memberships: ImportMembership[] }>;
  imports: Record<string, ImportMembership[]>;
  legacySnapshot: JsonRecord;
  options: { backgroundCatalogue: boolean; expansionAlignment: 'boundary' | 'homology'; unphasedLane: boolean; analysisScope: 'native_only' | 'lifted_only' | 'combined' };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

export function emptyDifferencesSession(): DifferencesSession {
  return { schema_version: DIFFERENCES_SCHEMA,
    versions: { normalization: 'local:v1', projection: 'guarded:v1', matching: 'candidate:v1', reconciliation: 'independent:v1', daf_likelihood: 'contract:v1' },
    ledger: { schema_version: DIFFERENCES_SCHEMA, records: {}, seeds: {}, lineage: {}, snapshots: {} },
    targets: {}, imports: {}, legacySnapshot: {},
    options: { backgroundCatalogue: false, expansionAlignment: 'boundary', unphasedLane: false, analysisScope: 'native_only' } };
}

/** Trust explicit producer/provenance + saved record membership, never punctuation.
 * Even the authentic historical encoding is verified by re-encoding known
 * components rather than splitting arbitrary user strings. */
export function importMembership(originalId: string, metadata: JsonRecord): ImportMembership {
  const producer = metadata.producer;
  const validRecord = (r: any) => r && typeof r.rawName === 'string' && r.rawName.length > 0
    && typeof r.provenanceGroup === 'string' && typeof r.libraryId === 'string'
    && r.provenanceGroup.length > 0 && r.libraryId.length > 0;
  const records = Array.isArray(metadata.records) ? metadata.records.filter(validRecord) : [];
  const fold = object(metadata.folding);
  const candidates = records.filter((r: any) => {
    if (producer === 'raw-qname:v1') return originalId === r.rawName;
    if (producer !== 'live-lift:pre-P2c' || typeof fold.molecule !== 'boolean' || typeof fold.orientation !== 'boolean') return false;
    const parts = [`${r.provenanceGroup}|${r.rawName}`];
    if (!fold.molecule) {
      if (typeof r.recordId !== 'string' || !r.recordId) return false;
      parts.push(r.recordId);
      if (!fold.orientation) {
        if (!Number.isInteger(r.rowIndex) || r.rowIndex < 0) return false;
        parts.push(String(r.rowIndex));
      }
    }
    if (typeof r.placement !== 'string' || !r.placement) return false;
    parts.push(r.placement);
    return originalId === parts.join('|');
  });
  const molecules = new Map<string, MoleculeIdentity>(candidates.map((r: any) => {
    const molecule = { provenance_group: r.provenanceGroup, library_id: r.libraryId, raw_name: r.rawName };
    return [JSON.stringify(molecule), molecule];
  }));
  if (molecules.size === 1) {
    const identities = new Set(candidates.map((record: any) => {
      const parts = [`${record.provenanceGroup}|${record.rawName}`, record.rawName,
        fold.molecule ? null : record.recordId, fold.molecule || fold.orientation ? null : record.rowIndex, record.placement];
      return JSON.stringify(parts).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }));
    if (producer !== 'raw-qname:v1' && identities.size !== 1) {
      return { status: 'unresolved_import', originalId, reason: 'ambiguous_record_membership' };
    }
    return { status: 'resolved', originalId, molecule: [...molecules.values()][0],
      currentId: producer === 'raw-qname:v1' ? originalId : `lift-cohort:v1 ${[...identities][0]}` };
  }
  return { status: 'unresolved_import', originalId, reason: molecules.size > 1 ? 'ambiguous_provenance' : 'missing_trustworthy_membership' };
}

/** Both parents: native svSplits and assembly differenceSplit/expandedInsertions.
 * Keep originals so an older producer can be restored without an irreversible
 * format rewrite. Missing/relinked sources cannot rebind these snapshots. */
export function restoreDifferencesSession(saved: JsonRecord | undefined): DifferencesSession {
  const state = object(saved);
  const existing = object(state.differencesSession);
  if (existing.schema_version === DIFFERENCES_SCHEMA) {
    const base = emptyDifferencesSession();
    return clone({ ...base, ...existing, options: { ...base.options, ...object(existing.options) } }) as DifferencesSession;
  }
  const result = emptyDifferencesSession();
  const keys = ['svSplits', 'differenceSplit', 'expandedInsertions', 'liveLiftExpansions', 'panels',
    'selectedReadIds', 'clusterAssignments', 'svCarrierEvidence', 'svDisplayEnabled', 'svMinLen',
    'svConflictOptions', 'showDuplicateReads', 'differencesImportMetadata'];
  for (const key of keys) if (state[key] !== undefined) result.legacySnapshot[key] = clone(state[key]);
  if (Object.keys(existing).length) result.legacySnapshot.differencesSession = clone(existing);
  const metadata = object(state.differencesImportMetadata);
  const assignments = object(state.clusterAssignments);
  const selected = object(state.selectedReadIds);
  const evidence = object(state.svCarrierEvidence);
  for (const dataset of new Set([...Object.keys(assignments), ...Object.keys(selected), ...Object.keys(evidence)])) {
    const ids = new Set([...Object.keys(object(assignments[dataset])), ...Object.keys(object(evidence[dataset])),
      ...(Array.isArray(selected[dataset]) ? selected[dataset].filter((x: unknown) => typeof x === 'string') : [])]);
    result.imports[dataset] = [...ids].map(id => importMembership(id, object(metadata[dataset])));
  }
  const definitions = { ...object(state.differenceSplit), ...object(state.svSplits) };
  for (const [key, raw] of Object.entries(definitions)) {
    const def = object(raw);
    if (!Object.keys(def).length) continue;
    result.targets[key] = { target_type: 'geometry', identity_state: 'provisional', frozen: true,
      snapshot: clone(def), policy: { includePutative: Boolean(def.includePutative),
        includeAmbiguous: Boolean(def.includeAmbiguous), includeConflicting: Boolean(def.includeConflicting),
        includeDuplicates: Boolean(def.includeDuplicates), conflictOptions: clone(def.conflictOptions ?? { enabled: false }) },
      memberships: clone(result.imports[key] ?? []) };
  }
  return result;
}

export function legacyDifferencesState(session: DifferencesSession): JsonRecord {
  return clone(session.legacySnapshot);
}

/** Apply only established identities, within their saved dataset scope. Original
 * IDs and policy/membership snapshots remain reversible in the capsule. */
export function restoreHistoricalMembership(state: JsonRecord, session: DifferencesSession): JsonRecord {
  const result: JsonRecord = {};
  const aliasesByDataset = new Map<string, Map<string, string>>();
  // Decide once for all fields. A later evidence collision must not leave
  // selections or assignments already rebound to current identities.
  for (const [dataset, imports] of Object.entries(session.imports)) {
    const aliases = new Map(imports.filter(m => m.status === 'resolved' && m.currentId).map(m => [m.originalId, m.currentId!]));
    const collision = ['clusterAssignments', 'svCarrierEvidence'].some(field => {
      const mapped = new Map<string, string>();
      for (const [id, value] of Object.entries(object(object(state[field])[dataset]))) {
        const current = aliases.get(id) ?? id;
        const encoded = JSON.stringify(value);
        if (mapped.has(current) && mapped.get(current) !== encoded) return true;
        mapped.set(current, encoded);
      }
      return false;
    });
    if (collision) {
      session.imports[dataset] = imports.map(m => ({ ...m, status: 'unresolved_import', reason: 'conflicting_historical_assignments' }));
      aliases.clear();
    }
    if (session.targets[dataset]) session.targets[dataset].memberships = clone(session.imports[dataset]);
    aliasesByDataset.set(dataset, aliases);
  }
  for (const field of ['clusterAssignments', 'selectedReadIds', 'svCarrierEvidence']) {
    if (!state[field]) continue;
    const datasets = { ...object(state[field]) };
    for (const [dataset, aliases] of aliasesByDataset) {
      if (!aliases.size || datasets[dataset] === undefined) continue;
      const value = datasets[dataset];
      if (Array.isArray(value)) datasets[dataset] = [...new Set(value.map(id => aliases.get(id) ?? id))];
      else {
        datasets[dataset] = Object.fromEntries(Object.entries(object(value)).map(([id, assignment]) => [aliases.get(id) ?? id, assignment]));
      }
    }
    result[field] = datasets;
  }
  return result;
}
