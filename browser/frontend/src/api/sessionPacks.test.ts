/**
 * A state saved by a build with a plugin pack this one lacks (a session, an undo step, a crash-recovery copy): the
 * pack's panels, the panels its owner fields mark, its rows and panel fields are left out, and so are the panels of
 * datasets the server skipped; the full view and the datasets follow the panels that are left.
 */
import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { missingPacksNote, missingSessionPacks, withoutMissingPackState } from './sessionPacks';
import { deserializeSavedState, serializeState, type SerializedState } from '../stores/historySlice';
import { declareContribution } from '../plugins/packRegistry';

const packs = { extras: { label: 'Extra features', panels: ['extra-panel'], tracks: ['extra-row'], features: [], panelFields: ['extraField', 'extraOwner'], panelOwners: ['extraOwner'], stateKeys: [] } };
const panel = (id: string, more: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: `ds_${id}`, subTracks: [{ type: 'reads' }, { type: 'extra-row' }], ...more,
});

describe('sessions and plugin packs this build lacks', () => {
  it('names the missing pack, and only a marked state has one', () => {
    expect(missingSessionPacks({ packs }).map(p => p.label)).toEqual(['Extra features']);
    expect(missingSessionPacks({})).toEqual([]);
    expect(missingPacksNote(['Extra features'])).toMatch(/doesn't include \(Extra features\); they were left out/);
  });

  it('a part the missing pack wrote that this build has (a feature that graduated to core) is kept', () => {
    // An older build's pack held two features; one of them is this build's own now.
    declareContribution('panels', 'graduated-panel');
    declareContribution('panelFields', 'graduatedField');
    declareContribution('panelFields', 'graduatedOwner');
    declareContribution('panelOwners', 'graduatedOwner');
    const older = { extras: { label: 'Extra features', panels: ['extra-panel', 'graduated-panel'], tracks: [], features: [],
      panelFields: ['graduatedField', 'graduatedOwner', 'extraField'], panelOwners: ['graduatedOwner'], stateKeys: [] } };
    const [missing] = missingSessionPacks({ packs: older });
    expect(missing.panels).toEqual(['extra-panel']);
    expect(missing.panelFields).toEqual(['extraField']);
    expect(missing.panelOwners).toEqual([]);
    const out = withoutMissingPackState({
      packs: older,
      panels: [
        { id: 'g', contentType: 'graduated-panel', datasetId: null, subTracks: [], graduatedField: { a: 1 } },
        { id: 'x', contentType: 'extra-panel', datasetId: null, subTracks: [] },
        panel('owned', { graduatedOwner: { contig: 'c' }, extraField: 1 }),
      ],
    });
    expect(out.panels.map(p => p.id)).toEqual(['g', 'owned']);
    expect(out.panels[0]).toHaveProperty('graduatedField');
    expect(out.panels[1]).not.toHaveProperty('extraField');
    // Every part of it is this build's: not missing at all (no note).
    expect(missingSessionPacks({ packs: { old: { label: 'Old', panels: ['graduated-panel'], panelFields: ['graduatedField'] } } })).toEqual([]);
  });

  it('leaves out the pack\'s panels, owned panels, rows and fields; the full view and datasets follow', () => {
    const state = {
      packs,
      panels: [
        panel('a', { extraField: { x: 1 } }),
        { id: 'p', contentType: 'extra-panel', datasetId: null, subTracks: [] },
        panel('owned', { extraOwner: { contig: 'c' } }),
        panel('b'),
      ],
      fullViewPanelId: 'owned',
      datasets: [{ id: 'ds_a' }, { id: 'ds_owned' }, { id: 'ds_b' }],
    };
    const out = withoutMissingPackState(state);
    expect(out.panels.map(p => p.id)).toEqual(['a', 'b']);
    expect(out.panels[0]).not.toHaveProperty('extraField');
    expect(out.panels[0].subTracks.map(t => t.type)).toEqual(['reads']);
    expect(out.fullViewPanelId).toBeNull();
    expect(out.datasets.map(d => d.id)).toEqual(['ds_a', 'ds_b']);
    expect(withoutMissingPackState({ ...state, fullViewPanelId: 'b' }).fullViewPanelId).toBe('b');
  });

  it('drops the panels of datasets the server skipped, marker or not', () => {
    const out = withoutMissingPackState({ panels: [panel('a'), panel('b')], fullViewPanelId: 'b' }, { skippedDatasetIds: ['ds_b'] });
    expect(out.panels.map(p => p.id)).toEqual(['a']);
    expect(out.fullViewPanelId).toBeNull();
    const plain = { panels: [panel('a')], fullViewPanelId: null };
    expect(withoutMissingPackState(plain)).toBe(plain);
  });

  it('a recovered state or an undo step goes through the same filter', () => {
    const saved = {
      packs, panels: [panel('a'), panel('owned', { extraOwner: {} })], fullViewPanelId: 'owned',
      datasets: [{ id: 'ds_a', paths: [] }, { id: 'ds_owned', paths: [] }],
    } as unknown as SerializedState;
    const restored = deserializeSavedState(saved);
    expect(restored.panels!.map(p => p.id)).toEqual(['a']);
    expect(restored.fullViewPanelId).toBeNull();
    expect((restored.datasets as { id: string }[]).map(d => d.id)).toEqual(['ds_a']);
  });

  it('Undo to a step a build with the pack saved brings back none of its panels', () => {
    useBrowserStore.setState({ datasets: [], panels: [], activeReadIds: {}, fullViewPanelId: null } as any);
    useBrowserStore.getState().addDataset({ id: 'ds_a', label: 'a', data_type: 'bam', paths: ['/a.bam'] } as any);
    const open = useBrowserStore.getState().panels;
    const now = serializeState(useBrowserStore.getState());
    const step = {
      ...now, packs,
      // The step collapsed panel a; it also had the pack's panel (maximized) and a panel of a dataset the pack built.
      panels: [{ ...open[0], collapsed: true }, { id: 'p', contentType: 'extra-panel', datasetId: null, subTracks: [] }, { ...open[0], id: 'owned', datasetId: 'ds_owned', extraOwner: {} }],
      datasets: [...(now.datasets ?? []), { id: 'ds_owned', label: 'o', paths: ['/o.bam'] }],
      fullViewPanelId: 'p',
    } as unknown as SerializedState;
    useBrowserStore.setState({
      _historyStack: [{ label: 'before', timestamp: 1, state: step }, { label: 'now', timestamp: 2, state: now }],
      _historyPointer: 1, _historyPaused: false,
    } as any);
    useBrowserStore.getState().undo();
    const after = useBrowserStore.getState();
    // The pack's dataset is left out of the step, so the step matches the open datasets: its own change comes back,
    // the pack's panels don't.
    expect(after.panels.map(p => [p.id, !!p.collapsed])).toEqual([[open[0].id, true]]);
    expect(after.fullViewPanelId).toBeNull();
  });
});
