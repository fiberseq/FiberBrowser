import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { deserializeSavedState, remapDatasetIds, serializeState } from '../../stores/historySlice';
import { applyImportedState, collectFrontendState } from '../../api/session';
import { refreshSvSplit } from '../../utils/svAlleleSplit';
import { importMembership, legacyDifferencesState, restoreDifferencesSession, restoreHistoricalMembership, previewHistoricalRelink } from './session';
import { DIFFERENCES_SCHEMA, fanOutMoleculeCalls, type MoleculeEnvelope } from './contracts';

// Generated with the authentic pre-P2c recipe: molecule|record|row|placement.
// Names and provenance deliberately contain pipes; there is no punctuation decoder.
const oldId = 'library|group|synthetic|molecule|record-digest|2|primary';
const record = { rawName: 'synthetic|molecule', provenanceGroup: 'library|group', libraryId: 'library-a',
  recordId: 'record-digest', rowIndex: 2, placement: 'primary' };
const known = { producer: 'live-lift:pre-P2c', folding: { molecule: false, orientation: false }, records: [record] };
const split = { datasetId: 'dataset', chrom: 'chrT', t: 'I', ref: 100, len: 100, end: 100,
  label: 'synthetic insertion', counts: [1, 0, 0], margin: 20, viewStart: 0, viewEnd: 300 };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

beforeEach(() => {
  localStorage.clear();
  useBrowserStore.setState({ ...useBrowserStore.getInitialState(), chrom: 'chrT', start: 0, end: 300,
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0 });
});

it('round trips projection placement/cap choices independently of lift and preserves saved versions', () => {
  const initial = restoreDifferencesSession(undefined);
  initial.options.projectionPolicy.cohort_alternatives = 'include';
  initial.options.projectionPolicy.search.max_hypotheses = 2;
  initial.versions.projection = 'guarded:v1';
  const restored = restoreDifferencesSession({ differencesSession: copy(initial), liveLiftEnabled: false });
  expect(restored.options.projectionPolicy).toEqual(initial.options.projectionPolicy);
  expect(restored.versions.projection).toBe('guarded:v1');
  expect(restoreDifferencesSession({ differencesSession: { ...initial, options: {} } }).options.projectionPolicy.search.max_transitions).toBe(16384);
});

describe('conservative historical membership', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('verifies authentic folded identities (molecule=%s, orientation=%s)', (molecule, orientation) => {
    const components = [`${record.provenanceGroup}|${record.rawName}`];
    if (!molecule) { components.push(record.recordId); if (!orientation) components.push(String(record.rowIndex)); }
    components.push(record.placement);
    const imported = importMembership(components.join('|'), { ...known, folding: { molecule, orientation } });
    expect(imported.status).toBe('resolved');
    expect(JSON.parse(imported.currentId!.slice('lift-cohort:v1 '.length))).toEqual([
      `${record.provenanceGroup}|${record.rawName}`, record.rawName,
      molecule ? null : record.recordId, molecule || orientation ? null : record.rowIndex, 'primary']);
  });
  it('reconstructs only when producer, folding and complete record provenance agree', () => {
    expect(importMembership(oldId, known)).toMatchObject({ status: 'resolved', originalId: oldId,
      molecule: { provenance_group: 'library|group', library_id: 'library-a', raw_name: 'synthetic|molecule' } });
    for (const metadata of [{}, { ...known, producer: undefined }, { ...known, folding: {} }, { ...known, records: [] }]) {
      expect(importMembership(oldId, metadata)).toMatchObject({ status: 'unresolved_import', originalId: oldId });
    }
    expect(importMembership(oldId, { ...known, records: [record, { ...record, libraryId: 'independent-library' }] }).status).toBe('unresolved_import');
  });
  it('retains unresolved placement membership even when colliding encodings share one molecule', () => {
    const a = { ...record, recordId: 'record|2', rowIndex: 3, placement: 'primary' };
    const b = { ...record, recordId: 'record', rowIndex: 2, placement: '3|primary' };
    const encode = (r: typeof a) => `${r.provenanceGroup}|${r.rawName}|${r.recordId}|${r.rowIndex}|${r.placement}`;
    expect(encode(a)).toBe(encode(b));
    expect(importMembership(encode(a), { ...known, records: [a, b] }))
      .toEqual({ status: 'unresolved_import', originalId: encode(a), reason: 'ambiguous_record_membership' });
  });
  it.each(['ordinary|pipe|name', oldId, 'lift-cohort:v1-looking'])('known raw QNAME stays verbatim: %s', rawName => {
    expect(importMembership(rawName, { producer: 'raw-qname:v1', records: [{ ...record, rawName }] }))
      .toMatchObject({ status: 'resolved', molecule: { raw_name: rawName } });
    expect(importMembership(rawName, {}).status).toBe('unresolved_import');
  });
});

describe.each(['svSplits', 'differenceSplit'])('reversible %s parent migration', parent => {
  const fixture = () => ({ [parent]: { dataset: split }, expandedInsertions: { main: [{ id: 'map-observation', length: 100 }] },
    panels: [{ id: 'native-panel', tracks: [{ type: 'sv', visible: false }] }],
    selectedReadIds: { dataset: [oldId] }, clusterAssignments: { dataset: { [oldId]: 0 } },
    differencesImportMetadata: { dataset: known }, svDisplayEnabled: false, showDuplicateReads: true });
  it('retains cold/warm nonempty membership, visibility, expansion and historical policy', () => {
    const saved = fixture();
    const cold = restoreDifferencesSession(saved);
    const warm = restoreDifferencesSession({ differencesSession: copy(cold) });
    expect(warm).toEqual(cold);
    expect(cold.targets.dataset).toMatchObject({ target_type: 'geometry', identity_state: 'provisional', frozen: true,
      policy: { includePutative: false, conflictOptions: { enabled: false } }, memberships: [{ status: 'resolved' }] });
    expect(legacyDifferencesState(warm)).toEqual(saved);
    // Sequence availability, cache eviction and locator changes do not bind
    // saved intent to a new grouping/target or erase a historical membership.
    expect(restoreDifferencesSession({ differencesSession: copy(warm), maps: [], files: [], locator: 'relocated-content' })).toEqual(cold);
  });
  it('missing historical provenance preserves original selection, assignments and snapshots', () => {
    const saved = { ...fixture(), differencesImportMetadata: undefined };
    const capsule = restoreDifferencesSession(saved);
    expect(capsule.imports.dataset).toEqual([{ status: 'unresolved_import', originalId: oldId, reason: 'missing_trustworthy_membership' }]);
    expect(capsule.legacySnapshot.clusterAssignments.dataset[oldId]).toBe(0);
    expect(capsule.targets.dataset.memberships).toEqual(capsule.imports.dataset);
  });
});

it('persists identity lineage through real serialize, hydration, undo/redo and session export', () => {
  const capsule = restoreDifferencesSession({ svSplits: { dataset: split }, selectedReadIds: { dataset: [oldId] } });
  capsule.ledger.records.parent = { identity_state: 'retired', exact_allele_id: null };
  capsule.ledger.lineage.parent = { descendants: ['a', 'b'], reason: 'cluster_split' };
  capsule.ledger.snapshots.parent = { members: ['m1'], target: [100, 100, 100], policy: { putative: false } };
  useBrowserStore.setState({ differencesSession: capsule });
  useBrowserStore.getState().pushSnapshot('Frozen historical state');
  const changed = copy(capsule);
  changed.options.unphasedLane = true;
  changed.options.matchingPolicy.broad_anchor_bp = 75;
  changed.options.likelihoodPolicy.min_log_odds = Math.log(1000);
  useBrowserStore.setState({ differencesSession: changed });
  useBrowserStore.getState().pushSnapshot('Change display option');
  useBrowserStore.getState().undo();
  expect(useBrowserStore.getState().differencesSession).toEqual(capsule);
  useBrowserStore.getState().redo();
  expect(useBrowserStore.getState().differencesSession).toEqual(changed);
  const snapshot = copy(serializeState(useBrowserStore.getState()));
  expect(deserializeSavedState(snapshot).differencesSession).toEqual(changed);
  const exported = collectFrontendState();
  expect(exported.differencesSession).toEqual(changed);
});

it('adds configurable matching defaults without rewriting historical policy versions or targets', () => {
  const old = restoreDifferencesSession({ svSplits: { dataset: split } });
  const historical = copy(old) as any;
  historical.versions.matching = 'candidate:v1';
  delete historical.options.matchingPolicy;
  delete historical.options.likelihoodPolicy;
  const restored = restoreDifferencesSession({ differencesSession: historical });
  expect(restored.versions.matching).toBe('candidate:v1');
  expect(restored.targets).toEqual(old.targets);
  expect(restored.options.matchingPolicy.broad_anchor_bp).toBe(50);
  expect(restored.options.likelihoodPolicy.profile_id).toBe('engineering-synthetic:v1');
});

it('preserves saved v2 scoring policies while new sessions use the repaired versions', () => {
  const current = restoreDifferencesSession({});
  expect(current.versions.matching).toBe('local-match:v3');
  expect(current.options.likelihoodPolicy.version).toBe('daf-indel:v3');
  const historical = copy(current);
  historical.versions.matching = historical.options.matchingPolicy.version = 'local-match:v2';
  historical.versions.daf_likelihood = historical.options.likelihoodPolicy.version = 'daf-indel:v2';
  expect(restoreDifferencesSession({ differencesSession: historical })).toEqual(historical);
});

it('actual dataset relocation preserves frozen reference/provenance and historical IDs', () => {
  const capsule = restoreDifferencesSession({ svSplits: { dataset: split },
    selectedReadIds: { dataset: [oldId] }, differencesImportMetadata: { dataset: known } });
  capsule.ledger.snapshots.parent = { datasetId: 'dataset', reference_id: 'reference-content', members: [oldId] };
  const moved = remapDatasetIds({ differencesSession: capsule, panels: [{ datasetId: 'dataset' }] }, { dataset: 'reopened' });
  expect(moved.panels[0].datasetId).toBe('reopened');
  expect(moved.differencesSession).toEqual(capsule);
  expect(moved.differencesSession.ledger.snapshots.parent.datasetId).toBe('dataset');
});

it('actual session import keeps an unresolved split frozen without an automatic network recompute', async () => {
  applyImportedState({ datasets: [], overlays: [], has_fasta: false, viewport: { chrom: 'chrT', start: 0, end: 300 },
    frontend: { svSplits: { dataset: split }, selectedReadIds: { dataset: [oldId] }, clusterAssignments: { dataset: { [oldId]: 0 } } } });
  const state = useBrowserStore.getState();
  expect(state.differencesSession.imports.dataset[0].status).toBe('unresolved_import');
  expect(state.clusterAssignments.dataset[oldId]).toBe(0);
  expect(state.svSplits.dataset.frozenImport).toBe(true);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('frozen import must not fetch'));
  await refreshSvSplit({ stateKey: 'dataset', datasetId: 'dataset', chrom: 'chrT', viewStart: 10, viewEnd: 200 }, state.svSplits.dataset);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
});

it('old crash-recovery snapshots freeze legacy splits through repeated hydration and refresh', async () => {
  const saved = copy(serializeState(useBrowserStore.getState())) as any;
  delete saved.differencesSession;
  saved.svSplits = { dataset: split };
  saved.clusterAssignments = { dataset: { [oldId]: 0 } };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('historical split must not fetch'));
  try {
    for (let round = 0; round < 2; round++) {
      useBrowserStore.setState(deserializeSavedState(saved));
      const state = useBrowserStore.getState();
      expect(state.svSplits.dataset.frozenImport).toBe(true);
      await refreshSvSplit({ stateKey: 'dataset', datasetId: 'dataset', chrom: 'chrT', viewStart: 10, viewEnd: 200 }, state.svSplits.dataset);
      Object.assign(saved, copy(serializeState(state)));
    }
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

it('includes evidence-only historical membership in frozen target snapshots', () => {
  const session = restoreDifferencesSession({ svSplits: { dataset: split },
    svCarrierEvidence: { dataset: { [oldId]: { level: 'confirmed' } } }, differencesImportMetadata: { dataset: known } });
  expect(session.imports.dataset).toEqual([importMembership(oldId, known)]);
  expect(session.targets.dataset.memberships).toEqual(session.imports.dataset);
});

it.each(['clusterAssignments', 'svCarrierEvidence'])('checks %s collisions before migrating any membership field', field => {
  const current = importMembership(oldId, known).currentId!;
  const saved = { svSplits: { dataset: split }, differencesImportMetadata: { dataset: known },
    selectedReadIds: { dataset: [oldId] }, clusterAssignments: { dataset: { [oldId]: 0 } },
    svCarrierEvidence: { dataset: { [oldId]: { level: 'confirmed' } } } };
  (saved[field as 'clusterAssignments'] as any).dataset[current] = field === 'clusterAssignments' ? 1 : { level: 'putative' };
  const session = restoreDifferencesSession(saved);
  const restored = restoreHistoricalMembership(saved, session);
  expect(restored.selectedReadIds).toEqual(saved.selectedReadIds);
  expect(restored.clusterAssignments).toEqual(saved.clusterAssignments);
  expect(restored.svCarrierEvidence).toEqual(saved.svCarrierEvidence);
  expect(session.imports.dataset.every(m => m.status === 'unresolved_import')).toBe(true);
  expect(session.targets.dataset.memberships).toEqual(session.imports.dataset);
  expect(session.legacySnapshot.selectedReadIds).toEqual(saved.selectedReadIds);
});

it('hydrates established historical selections/assignments into nonempty current identities, cold and warm', () => {
  const source = { svSplits: { dataset: split }, selectedReadIds: { dataset: [oldId] },
    clusterAssignments: { dataset: { [oldId]: 0 } }, differencesImportMetadata: { dataset: known } };
  const importState = (frontend: any) => applyImportedState({ datasets: [], overlays: [], has_fasta: false,
    viewport: { chrom: 'chrT', start: 0, end: 300 }, frontend });
  importState(source);
  const expected = importMembership(oldId, known).currentId!;
  expect(useBrowserStore.getState().selectedReadIds.dataset).toEqual(new Set([expected]));
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [expected]: 0 });
  const exported = copy(collectFrontendState());
  importState(exported);
  expect(useBrowserStore.getState().selectedReadIds.dataset).toEqual(new Set([expected]));
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [expected]: 0 });
  expect(useBrowserStore.getState().differencesSession.legacySnapshot.selectedReadIds.dataset).toEqual([oldId]);
  expect(deserializeSavedState(exported as any).clusterAssignments?.dataset).toEqual({ [expected]: 0 });
});

it('fans one molecule call to qualified row/analysis identities without crossing libraries', () => {
  const call = { call: { assignment: 'target', level: 'confirmed', method: 'geometry_only', reasons: [], witness_ids: ['physical'] },
    complete: true, representations: [] };
  const envelope = { schema_version: DIFFERENCES_SCHEMA, calls_by_molecule: { a: call },
    membership: { rows: { dataset: { 'row-1': 'a', 'analysis-1': 'a', 'row-2': 'a', 'other-library': 'b' },
      unrelated: { 'same-name': 'b' } }, molecules: {}, legacy_aliases: {} } } as MoleculeEnvelope;
  expect(Object.keys(fanOutMoleculeCalls(envelope, 'dataset'))).toEqual(['row-1', 'analysis-1', 'row-2']);
  expect(fanOutMoleculeCalls(envelope, 'unrelated')).toEqual({});
});

it.each(['svSplits', 'differenceSplit'])('hydrates the %s parent into one row, frozen groups and saved columns, cold and warm', parent => {
  const frontend = { [parent]: { dataset: split }, selectedReadIds: { dataset: [oldId] },
    clusterAssignments: { dataset: { [oldId]: 0 } }, differencesImportMetadata: { dataset: known },
    panels: [{ id: 'panel', datasetId: 'dataset', contentType: 'dataset', liftHap: 'phase-a', subTracks: [
      { type: 'reads', visible: true }, { type: 'sv', visible: true },
      { type: 'differences', visible: false, heightOverride: 71 }, { type: 'difference', visible: true },
    ] }], expandedInsertions: { main: [{ chrom: 'chrT', pos: 100, id: 'saved-map-id', length: 100,
      label: 'historical column', hap_label: 'phase-a', map_id: 'immutable-map', datasetId: 'dataset' }] } };
  let saved: any = frontend;
  for (let round = 0; round < 2; round++) {
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, viewport: { chrom: 'chrT', start: 0, end: 300 }, frontend: saved });
    const state = useBrowserStore.getState();
    expect(state.svSplits.dataset).toMatchObject({ frozenImport: true, includePutative: false, conflictOptions: { enabled: false } });
    expect(state.clusterAssignments.dataset).toEqual({ [importMembership(oldId, known).currentId!]: 0 });
    expect(state.panels[0].subTracks.filter(t => t.type === 'sv')).toEqual([{ type: 'sv', visible: false, heightOverride: 71 }]);
    expect(state.panels[0].liftHap).toBe('phase-a');
    expect(state.liveLiftExpansions.main[0]).toMatchObject({ ins_id: 'saved-map-id', length: 100, map_id: 'immutable-map' });
    saved = copy(collectFrontendState());
    const crash = deserializeSavedState(saved);
    expect(crash.svSplits?.dataset.frozenImport).toBe(true);
    expect(crash.liveLiftExpansions).toEqual(state.liveLiftExpansions);
  }
  expect(useBrowserStore.getState().differencesSession.legacySnapshot[parent]).toEqual(frontend[parent]);
});

it('relinks only after a preview, retaining policies, snapshots and unresolved raw pipe names', () => {
  const state = { svSplits: { dataset: split }, selectedReadIds: { dataset: [oldId, 'ordinary|pipe'] },
    clusterAssignments: { dataset: { [oldId]: 0, 'ordinary|pipe': 2 } },
    filteredReadIds: { dataset: [oldId], unrelated: null }, readSortOrder: { dataset: [oldId, 'ordinary|pipe'] } };
  const session = restoreDifferencesSession(state);
  const before = copy(session);
  const proposed = previewHistoricalRelink(state, session, 'dataset', known);
  expect(session).toEqual(before);
  expect(proposed.session.imports.dataset.map(m => m.status)).toEqual(['resolved', 'unresolved_import']);
  expect(proposed.changes).toEqual({ added: 1, removed: 1, changed: 0, retained: 1 });
  expect(proposed.restored.filteredReadIds.unrelated).toBeNull();
  expect(proposed.restored.readSortOrder.dataset).toEqual([importMembership(oldId, known).currentId!, 'ordinary|pipe']);
  expect(proposed.session.legacySnapshot).toEqual(session.legacySnapshot);
  expect(proposed.session.targets.dataset.policy).toEqual(session.targets.dataset.policy);
  expect(proposed.session.targets.dataset.snapshot).toEqual(split);
});
