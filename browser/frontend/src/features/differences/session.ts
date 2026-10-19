/** Reversible migration. Frozen imports never guess a QNAME. */
import { DIFFERENCES_SCHEMA, type MoleculeIdentity } from './contracts';

type JsonRecord = Record<string, any>;
export interface ImportMembership {
  status: 'resolved' | 'unresolved_import';
  originalId: string;
  molecule?: MoleculeIdentity;
  currentId?: string;
  reason?: string;
}
export interface ImportBinding { stateKey: string; datasetId: string; libraryIds: string[]; producer: string }
export interface DifferencesSession {
  schema_version: typeof DIFFERENCES_SCHEMA;
  versions: Record<string, string>;
  ledger: { schema_version: typeof DIFFERENCES_SCHEMA; records: JsonRecord; seeds: JsonRecord; lineage: JsonRecord; snapshots: JsonRecord };
  targets: Record<string, { target_type: 'geometry' | 'exact'; identity_state: 'provisional' | 'exact'; frozen: true; snapshot: JsonRecord; policy: JsonRecord; memberships: ImportMembership[] }>;
  imports: Record<string, ImportMembership[]>;
  selectionSnapshot?: JsonRecord | null;
  bindings?: Record<string, ImportBinding>;
  legacySnapshot: JsonRecord;
  options: { backgroundCatalogue: boolean; expansionAlignment: 'boundary' | 'homology'; unphasedLane: boolean; analysisScope: 'native_only' | 'lifted_only' | 'combined';
    projectionPolicy: { version: string; cohort_alternatives: 'include' | 'exclude'; min_mapq: number;
      search: { version: string; max_hypotheses: number; max_path_states: number; max_transitions: number } };
    matchingPolicy: { version: string; anchor_bp: number; anchor_fraction: number; span_bp: number; span_fraction: number;
      broad_anchor_bp: number; broad_anchor_fraction: number; max_members: number; max_window_bp: number; max_sequence_bp: number };
    likelihoodPolicy: { version: string; profile_id: string; substitution_rate: number; indel_rate: number;
      conversion_rate: number; min_log_odds: number; max_noise_fraction: number } };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

export function emptyDifferencesSession(): DifferencesSession {
  return { schema_version: DIFFERENCES_SCHEMA,
    versions: { normalization: 'haplotype:v2', projection: 'read-map:v1', matching: 'local-match:v3', reconciliation: 'independent:v1', daf_likelihood: 'daf-indel:v3' },
    ledger: { schema_version: DIFFERENCES_SCHEMA, records: {}, seeds: {}, lineage: {}, snapshots: {} },
    targets: {}, imports: {}, legacySnapshot: {},
    options: { backgroundCatalogue: false, expansionAlignment: 'boundary', unphasedLane: false, analysisScope: 'native_only',
      projectionPolicy: { version: 'read-map:v1', cohort_alternatives: 'exclude', min_mapq: 20,
        search: { version: 'hypothesis:v1', max_hypotheses: 64, max_path_states: 4096, max_transitions: 16384 } },
      matchingPolicy: { version: 'local-match:v3', anchor_bp: 20, anchor_fraction: .05, span_bp: 20, span_fraction: .20,
        broad_anchor_bp: 50, broad_anchor_fraction: .20, max_members: 32, max_window_bp: 10_000, max_sequence_bp: 100_000 },
      likelihoodPolicy: { version: 'daf-indel:v3', profile_id: 'engineering-synthetic:v1', substitution_rate: .01, indel_rate: .02,
        conversion_rate: .90, min_log_odds: Math.log(100), max_noise_fraction: .20 } } };
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
    const options = object(existing.options);
    return clone({ ...base, ...existing, options: { ...base.options, ...options,
      projectionPolicy: { ...base.options.projectionPolicy, ...object(options.projectionPolicy),
        search: { ...base.options.projectionPolicy.search, ...object(object(options.projectionPolicy).search) } },
      matchingPolicy: { ...base.options.matchingPolicy, ...object(options.matchingPolicy) },
      likelihoodPolicy: { ...base.options.likelihoodPolicy, ...object(options.likelihoodPolicy) } } }) as DifferencesSession;
  }
  const result = emptyDifferencesSession();
  const keys = ['svSplits', 'differenceSplit', 'expandedInsertions', 'liveLiftExpansions', 'panels',
    'selectedReadIds', 'clusterAssignments', 'svCarrierEvidence', 'svDisplayEnabled', 'svMinLen',
    'svConflictOptions', 'showDuplicateReads', 'differencesImportMetadata', 'filteredReadIds', 'readSortOrder'];
  for (const key of keys) if (state[key] !== undefined) result.legacySnapshot[key] = clone(state[key]);
  if (Object.keys(existing).length) result.legacySnapshot.differencesSession = clone(existing);
  const metadata = object(state.differencesImportMetadata);
  const assignments = object(state.clusterAssignments);
  const selected = object(state.selectedReadIds);
  const evidence = object(state.svCarrierEvidence);
  const filters = object(state.filteredReadIds), orders = object(state.readSortOrder);
  for (const dataset of new Set([...Object.keys(assignments), ...Object.keys(selected), ...Object.keys(evidence), ...Object.keys(filters), ...Object.keys(orders)])) {
    const ids = new Set([...Object.keys(object(assignments[dataset])), ...Object.keys(object(evidence[dataset])),
      ...[selected[dataset], filters[dataset], orders[dataset]].flatMap(value => Array.isArray(value) ? value.filter((x: unknown) => typeof x === 'string') : [])]);
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

export function declaredLibraries(dataset: JsonRecord): string[] {
  const groups = dataset.molecule_groups ?? dataset.live_lift?.settings?.molecule_groups;
  return Array.isArray(groups) ? [...new Set<string>(groups.filter((p: any) => Array.isArray(p) && typeof p[1] === 'string' && p[1]).map((p: any) => p[1]))] : [];
}
export function bindingAvailable(state: JsonRecord, binding: ImportBinding): boolean {
  const dataset = Array.isArray(state.datasets) ? state.datasets.find((d: any) => d.id === binding.datasetId) : undefined;
  return Boolean(dataset && binding.libraryIds.length && binding.libraryIds.every(id => declaredLibraries(dataset).includes(id))
    && (binding.producer !== 'live-lift:pre-P2c' || dataset.data_type === 'bam_livelift')
    && (binding.stateKey === binding.datasetId || state.panels?.some((p: any) => (p.stateKey ?? p.datasetId) === binding.stateKey && p.datasetId === binding.datasetId)));
}

/** Apply only established identities, within their saved dataset scope. Original
 * IDs and policy/membership snapshots remain reversible in the capsule. */
export function restoreHistoricalMembership(state: JsonRecord, session: DifferencesSession): JsonRecord {
  const result: JsonRecord = {};
  const aliasesByDataset = new Map<string, Map<string, string>>();
  // Decide once for all fields. A later evidence collision must not leave
  // selections or assignments already rebound to current identities.
  for (const [dataset, imports] of Object.entries(session.imports)) {
    const binding = session.bindings?.[dataset];
    const active = binding?.stateKey ?? dataset;
    const aliases = new Map(imports.filter(m => m.status === 'resolved' && m.currentId).map(m => [m.originalId, m.currentId!]));
    if (binding && !bindingAvailable(state, binding)) {
      session.imports[dataset] = imports.map(m => ({ ...m, status: 'unresolved_import', reason: 'unavailable_bound_source' }));
      aliases.clear();
    }
    const collision = ['clusterAssignments', 'svCarrierEvidence'].some(field => {
      const mapped = new Map<string, string>();
      for (const [id, value] of Object.entries(object(object(state[field])[active] ?? object(state[field])[dataset]))) {
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
    aliasesByDataset.set(active, aliases);
  }
  for (const field of ['clusterAssignments', 'selectedReadIds', 'svCarrierEvidence', 'filteredReadIds', 'readSortOrder']) {
    if (!state[field]) continue;
    const datasets = { ...object(state[field]) };
    for (const [dataset, aliases] of aliasesByDataset) {
      if (!aliases.size || datasets[dataset] === undefined) continue;
      const value = datasets[dataset];
      if (value === null) continue;
      if (Array.isArray(value)) datasets[dataset] = [...new Set(value.map(id => aliases.get(id) ?? id))];
      else {
        datasets[dataset] = Object.fromEntries(Object.entries(object(value)).map(([id, assignment]) => [aliases.get(id) ?? id, assignment]));
      }
    }
    result[field] = datasets;
  }
  return result;
}

/** Coordinate targets from either parent stay geometry targets. Invalid or
 * conflicting legacy definitions remain in legacySnapshot for recovery. */
export function legacySplitDefinitions(state: JsonRecord): JsonRecord {
  return { ...object(state.differenceSplit), ...object(state.svSplits) };
}

export interface MembershipChanges { added: number; removed: number; changed: number; retained: number }
export function membershipChanges(before: Record<string, number>, after: Record<string, number>): MembershipChanges {
  return { added: Object.keys(after).filter(id => !(id in before)).length,
    removed: Object.keys(before).filter(id => !(id in after)).length,
    changed: Object.keys(before).filter(id => id in after && before[id] !== after[id]).length,
    retained: Object.keys(before).filter(id => id in after && before[id] === after[id]).length };
}

/** Deliberate relink uses the same verified decoder as initial import. It does
 * not replace target/policy snapshots, bind a missing dataset, or read a cache.
 * The caller previews and atomically applies this proposal against its base. */
export function previewHistoricalRelink(state: JsonRecord, session: DifferencesSession, dataset: string, metadata: JsonRecord,
  requestedBinding?: Pick<ImportBinding, 'stateKey' | 'datasetId'>) {
  if (!session.imports[dataset]) throw new Error('No saved membership for this scope');
  const next = clone(session);
  next.imports[dataset] = next.imports[dataset].map(m => m.status === 'resolved' && !requestedBinding ? m : importMembership(m.originalId, metadata));
  const input = clone(state);
  if (requestedBinding) {
    const producer = session.bindings?.[dataset]?.producer ?? session.legacySnapshot.differencesImportMetadata?.[dataset]?.producer;
    if (producer && producer !== metadata.producer) throw new Error('Historical producer does not match the saved provenance');
    const members = next.imports[dataset].filter(m => m.status === 'resolved');
    const libraryIds = [...new Set(members.flatMap(m => m.molecule ? [m.molecule.library_id] : []))];
    const binding: ImportBinding = { ...requestedBinding, libraryIds, producer: String(metadata.producer ?? '') };
    if (!members.length || !bindingAvailable(state, binding)) throw new Error('Relinking requires matching declared library provenance in the chosen source');
    if (Object.entries(next.bindings ?? {}).some(([key, b]) => key !== dataset && b.stateKey === binding.stateKey)) throw new Error('Another saved scope already uses this runtime scope');
    const known = new Set(next.imports[dataset].flatMap(m => [m.originalId, ...(m.currentId ? [m.currentId] : [])]));
    const active = object(object(state.clusterAssignments)[binding.stateKey]);
    if (binding.stateKey !== dataset && Object.keys(active).some(id => !known.has(id))) throw new Error('The runtime scope contains unrelated membership; choose a separate panel');
    next.bindings = { ...next.bindings, [dataset]: binding };
    for (const field of ['clusterAssignments', 'selectedReadIds', 'svCarrierEvidence', 'filteredReadIds', 'readSortOrder']) {
      if (input[field]?.[binding.stateKey] === undefined && input[field]?.[dataset] !== undefined) input[field][binding.stateKey] = clone(input[field][dataset]);
    }
    const def = object(state.svSplits)[dataset] ?? next.targets[dataset]?.snapshot;
    if (def?.t === 'I' || def?.t === 'D') input.svSplits = { ...object(state.svSplits), [binding.stateKey]: { ...clone(def), datasetId: binding.datasetId, frozenImport: true } };
    const labels = object(state.clusterGroupLabels)[dataset];
    if (labels) input.clusterGroupLabels = { ...object(state.clusterGroupLabels), [binding.stateKey]: clone(labels) };
  }
  const restored = restoreHistoricalMembership(input, next);
  if (requestedBinding) {
    if (input.svSplits) restored.svSplits = input.svSplits;
    if (input.clusterGroupLabels) restored.clusterGroupLabels = input.clusterGroupLabels;
  }
  const active = next.bindings?.[dataset]?.stateKey ?? dataset;
  const before = object(object(state.clusterAssignments)[active]);
  const after = object(object(restored.clusterAssignments ?? state.clusterAssignments)[active]);
  return { session: next, restored, changes: membershipChanges(before, after),
    resolved: next.imports[dataset].filter(m => m.status === 'resolved').length,
    unresolved: next.imports[dataset].filter(m => m.status === 'unresolved_import').length };
}
