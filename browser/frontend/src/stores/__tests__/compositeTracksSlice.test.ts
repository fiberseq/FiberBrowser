import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_METAPROFILE_ID } from '../../types/dataset';
import type { TrackSource } from '../../types/dataset';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

function isMetaprofileSource(source: TrackSource): source is TrackSource & { ref: { kind: 'metaprofile'; ruleId: string } } {
  return source.ref.kind === 'metaprofile';
}

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

describe('group autoscale on log tracks', () => {
  it("stores the shared range in each track's displayed (signed-log) space", () => {
    const composite = (id: string, ruleId: string, logScale: boolean) => ({
      id, label: id, kind: 'signal', scaleMode: 'auto', logScale, visible: true,
      groupAutoscaleSelected: true, showAxes: true,
      sources: [{ id: id + '-s', ref: { kind: 'metaprofile', ruleId, datasetId: 'ds' }, color: '#000', visible: true }],
    });
    store.setState({
      datasets: [{ id: 'ds', label: 'ds', path: '/x.bam', color: '#000', data_type: 'bam' }],
      datasetProfiles: { ds: { layers: { a: [0, 999], b: [0, 99] } } },
      compositeTracks: [composite('log', 'a', true), composite('lin', 'b', false)],
    } as any);

    store.getState().applyGroupAutoscale(true);

    const byId = Object.fromEntries(store.getState().compositeTracks.map(c => [c.id, c]));
    expect(byId.log.scaleMode).toBe('group');
    expect(byId.log.yMax).toBeCloseTo(3, 6); // log10(999 + 1)
    expect(byId.lin.yMax).toBe(999);
    expect(byId.log.yMin).toBe(0);
  });
});

describe('group autoscale across dataset panels', () => {
  it("covers every dataset panel's profile, not just the first dataset's", () => {
    const composite = (id: string) => ({
      id, label: id, kind: 'signal', scaleMode: 'auto', logScale: false, visible: true,
      groupAutoscaleSelected: true, showAxes: true,
      sources: [{ id: id + '-s', ref: { kind: 'metaprofile', ruleId: 'nuc' }, color: '#000', visible: true }],
    });
    store.setState({
      datasets: [
        { id: 'ds1', label: 'ds1', path: '/1.bam', color: '#000', data_type: 'bam' },
        { id: 'ds2', label: 'ds2', path: '/2.bam', color: '#000', data_type: 'bam' },
      ],
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'ds1' },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', stateKey: 'copy2' },
      ],
      // Profiles are stored under each panel's state key.
      datasetProfiles: { ds1: { layers: { nuc: [0, 0.4] } }, copy2: { layers: { nuc: [0, 0.9] } } },
      compositeTracks: [composite('a'), composite('b')],
    } as any);

    store.getState().applyGroupAutoscale(true);

    expect(store.getState().compositeTracks.map(c => c.yMax)).toEqual([0.9, 0.9]);
  });
});

describe('default metaprofile sources', () => {
  it('seeds canonical detected layer sources with primary layers visible', () => {
    store.setState({
      datasets: [{
        id: 'primary',
        label: 'primary',
        path: '/tmp/primary.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: {
          nuc: true,
          tf: true,
          fire: true,
          deam: true,
          m6a: true,
          pol2: true,
        },
      }],
    });

    store.getState().seedDefaultMetaprofile();

    const defaultTrack = store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const ids = defaultTrack.sources
      .filter(isMetaprofileSource)
      .map(source => source.ref.ruleId);

    expect(ids).toEqual(['nuc', 'tf', 'fire', 'deam', 'm6a', 'pol2']);
    expect(defaultTrack.sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === 'nuc')?.visible).toBe(true);
    expect(defaultTrack.sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === 'tf')?.visible).toBe(true);
    expect(defaultTrack.sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === 'fire')?.visible).toBe(false);
    expect(defaultTrack.sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === 'deam')?.visible).toBe(false);
  });

  it('migrates legacy subnuc/mod default sources to layer-backed sources', () => {
    store.setState({
      datasets: [{
        id: 'primary',
        label: 'primary',
        path: '/tmp/primary.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: { nuc: true, tf: true, m6a: true },
      }],
      compositeTracks: [{
        id: DEFAULT_METAPROFILE_ID,
        label: 'Metaprofile',
        kind: 'metaprofile',
        sources: [
          { id: 'old-nuc', ref: { kind: 'metaprofile', ruleId: 'nuc' }, color: '#111111', visible: true, negate: false, scale: 1 },
          { id: 'old-subnuc', ref: { kind: 'metaprofile', ruleId: 'subnuc' }, color: '#222222', visible: true, negate: false, scale: 1 },
          { id: 'old-mod', ref: { kind: 'metaprofile', ruleId: 'mod' }, color: '#333333', visible: false, negate: false, scale: 1 },
        ],
        scaleMode: 'per-source',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
        removable: false,
      }],
    });

    store.getState().seedDefaultMetaprofile();

    const defaultTrack = store.getState().compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID)!;
    const ids = defaultTrack.sources
      .filter(isMetaprofileSource)
      .map(source => source.ref.ruleId);

    expect(ids).toEqual(['nuc', 'tf', 'm6a']);
    expect(defaultTrack.sources.find(s => s.ref.kind === 'metaprofile' && s.ref.ruleId === 'm6a')?.id).toBe('old-mod');
  });
});

describe('track cart history', () => {
  it('undoes adding and deleting a composite track', () => {
    const id = store.getState().addComposite({
      label: 'Motifs',
      kind: 'annotation',
      sources: [],
    });

    expect(store.getState().compositeTracks.map(c => c.id)).toContain(id);
    expect(store.getState().canUndo()).toBe(true);

    store.getState().undo();
    expect(store.getState().compositeTracks.map(c => c.id)).not.toContain(id);

    store.setState({ _lastRestoreTime: 0 });
    store.getState().redo();
    expect(store.getState().compositeTracks.map(c => c.id)).toContain(id);

    store.setState({ _lastRestoreTime: 0 });
    store.getState().removeComposite(id);
    expect(store.getState().compositeTracks.map(c => c.id)).not.toContain(id);

    store.getState().undo();
    expect(store.getState().compositeTracks.map(c => c.id)).toContain(id);
  });

  it('undoes composite and source edits', () => {
    store.setState({
      compositeTracks: [{
        id: 'comp-a',
        label: 'Signal',
        kind: 'signal',
        sources: [{
          id: 'src-a',
          ref: { kind: 'metaprofile', ruleId: 'nuc' },
          color: '#2563eb',
          visible: true,
          negate: false,
          scale: 1,
        }],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
    } as any);

    store.getState().updateComposite('comp-a', { visible: false });
    expect(store.getState().compositeTracks[0].visible).toBe(false);
    store.getState().undo();
    expect(store.getState().compositeTracks[0].visible).toBe(true);

    store.setState({ _lastRestoreTime: 0 });
    store.getState().updateSource('comp-a', 'src-a', { scale: 2 });
    expect(store.getState().compositeTracks[0].sources[0].scale).toBe(2);
    store.getState().undo();
    expect(store.getState().compositeTracks[0].sources[0].scale).toBe(1);
  });
});
