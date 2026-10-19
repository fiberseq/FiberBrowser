import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { collectFrontendState } from '../../api/session';
import { deserializeSavedState, serializeState } from '../../stores/historySlice';
import { requestSvSplit } from '../../utils/svAlleleSplit';
import { SavedDifferences } from './SavedDifferences';
import { restoreDifferencesSession, importMembership } from './session';

vi.mock('../../utils/svAlleleSplit', async original => ({ ...await original<any>(), requestSvSplit: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const original = 'provenance|raw|record|0|primary';
const metadata = { producer: 'live-lift:pre-P2c', folding: { molecule: false, orientation: false }, records: [
  { rawName: 'raw', provenanceGroup: 'provenance', libraryId: 'library', recordId: 'record', rowIndex: 0, placement: 'primary' },
] };
const split = { datasetId: 'dataset', chrom: 'chrT', t: 'I', ref: 100, len: 100, end: 100,
  counts: [1, 0, 0], margin: 20, viewStart: 0, viewEnd: 300, label: 'saved geometry' };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
function button(label: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === label)!; }
async function enterMetadata() {
  const textarea = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, JSON.stringify(metadata));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(async () => {
  localStorage.clear();
  const state = { svSplits: { dataset: split }, selectedReadIds: { dataset: [original] }, clusterAssignments: { dataset: { [original]: 0 } } };
  useBrowserStore.setState(useBrowserStore.getInitialState());
  useBrowserStore.setState({ ...deserializeSavedState({ ...serializeState(useBrowserStore.getState()), ...state } as any),
    datasets: [{ id: 'dataset', label: 'Synthetic', data_type: 'bam', path: 'synthetic.bam', color: '#000' }],
    differencesSession: restoreDifferencesSession(state), _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0 });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<SavedDifferences />));
  await act(async () => button('Saved differences · 1 unresolved memberships').click());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.resetAllMocks(); });

it('previews trustworthy membership, applies atomically and survives undo/redo and crash hydration', async () => {
  const before = structuredClone(useBrowserStore.getState().differencesSession);
  await enterMetadata();
  await act(async () => button('Preview relink').click());
  expect(host.textContent).toContain('1 resolved · 0 unresolved');
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [original]: 0 });
  await act(async () => button('Apply membership relink').click());
  const current = importMembership(original, metadata).currentId!;
  expect(useBrowserStore.getState().selectedReadIds.dataset).toEqual(new Set([current]));
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [current]: 0 });
  expect(useBrowserStore.getState().differencesSession.legacySnapshot).toEqual(before.legacySnapshot);
  const restored = deserializeSavedState(collectFrontendState() as any);
  expect(restored.clusterAssignments?.dataset).toEqual({ [current]: 0 });
  act(() => useBrowserStore.getState().undo());
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [original]: 0 });
  act(() => useBrowserStore.getState().redo());
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [current]: 0 });
});

it('refuses a stale relink proposal without erasing the saved target', async () => {
  await enterMetadata();
  await act(async () => button('Preview relink').click());
  act(() => useBrowserStore.setState({ selectedReadIds: { dataset: new Set(['new-selection']) } }));
  await act(async () => button('Apply membership relink').click());
  expect(host.textContent).toContain('Saved state changed');
  expect(useBrowserStore.getState().selectedReadIds.dataset).toEqual(new Set(['new-selection']));
  expect(useBrowserStore.getState().differencesSession.targets.dataset.snapshot).toEqual(split);
});

it('previews count and membership changes with the saved confirmed-only policy before recompute', async () => {
  vi.mocked(requestSvSplit).mockResolvedValue({ assignments: { replacement: 1 }, counts: [0, 1, 0], label: 'new counts', margin: 20 });
  await act(async () => button('Preview recompute with saved policy').click());
  expect(requestSvSplit).toHaveBeenCalledWith(expect.objectContaining({ includePutative: false, includeConflicting: false,
    conflictOptions: expect.objectContaining({ enabled: false }) }), expect.objectContaining({ ref: 100, len: 100 }), 20, expect.any(AbortSignal), false);
  expect(host.textContent).toContain('Saved 1/0/0 → proposed 0/1/0');
  expect(host.textContent).toContain('Membership: +1 / −1 / 0 changed groups');
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [original]: 0 });
  await act(async () => button('Apply recomputed membership').click());
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ replacement: 1 });
  expect(useBrowserStore.getState().svSplits.dataset.frozenImport).toBe(true);
  expect(useBrowserStore.getState().differencesSession.targets.dataset.snapshot).toEqual(split);
});

it('keeps a removed source unresolved and disables its legacy recompute', async () => {
  act(() => useBrowserStore.setState({ datasets: [] }));
  expect(button('Preview recompute with saved policy').disabled).toBe(true);
  expect(host.textContent).toContain('Source unavailable');
  expect(useBrowserStore.getState().clusterAssignments.dataset).toEqual({ [original]: 0 });
});

it('freezes the current saved target when a preview starts before React commits a new render', async () => {
  vi.mocked(requestSvSplit).mockResolvedValue({ assignments: { current: 0 }, counts: [1, 0, 0], label: 'new counts', margin: 20 });
  await act(async () => {
    const session = structuredClone(useBrowserStore.getState().differencesSession);
    session.targets.dataset.snapshot.ref = 150;
    session.targets.dataset.snapshot.end = 150;
    useBrowserStore.setState({ differencesSession: session });
    button('Preview recompute with saved policy').click();
  });
  expect(requestSvSplit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ref: 150, end: 150 }), 20, expect.any(AbortSignal), false);
  await act(async () => button('Apply recomputed membership').click());
  expect(useBrowserStore.getState().svSplits.dataset).toMatchObject({ ref: 150, end: 150, frozenImport: true });
});

it('previews an explicit reopened source binding and restores its memberships without replacing the historical snapshot', async () => {
  act(() => useBrowserStore.setState({ datasets: [{ id: 'reopened', label: 'Reopened source', data_type: 'bam_livelift', path: 'relocated.bam',
    molecule_groups: [['relocated.bam', 'library']], color: '#000' }], panels: [{ id: 'panel', datasetId: 'reopened', stateKey: 'rows' } as any] }));
  await enterMetadata();
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Reopened source scope"]')!;
    select.value = JSON.stringify({ stateKey: 'rows', datasetId: 'reopened' });
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Preview relink').click());
  expect(host.textContent).toContain('Runtime scope: rows');
  expect(useBrowserStore.getState().clusterAssignments.rows).toBeUndefined();
  await act(async () => button('Apply membership relink').click());
  const current = importMembership(original, metadata).currentId!;
  expect(useBrowserStore.getState().clusterAssignments.rows).toEqual({ [current]: 0 });
  expect(useBrowserStore.getState().svSplits.rows).toMatchObject({ datasetId: 'reopened', ref: 100, frozenImport: true });
  expect(useBrowserStore.getState().differencesSession.targets.dataset.snapshot).toEqual(split);
  const serialized = collectFrontendState();
  expect((serialized.datasets as any[])[0].molecule_groups).toEqual([['relocated.bam', 'library']]);
  const crash = deserializeSavedState(serialized as any);
  expect(crash.clusterAssignments?.rows).toEqual({ [current]: 0 });
  expect(crash.differencesSession?.imports.dataset[0].status).toBe('resolved');
});
