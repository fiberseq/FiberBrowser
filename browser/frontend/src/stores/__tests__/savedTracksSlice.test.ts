import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

describe('saved track preset history', () => {
  it('undoes saving and deleting a track preset', () => {
    store.setState({
      compositeTracks: [{
        id: 'comp-a',
        label: 'Signal',
        kind: 'signal',
        sources: [],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      }],
    } as any);

    const savedId = store.getState().saveCompositeAsTrack('comp-a', 'Signal preset');
    expect(savedId).toBeTruthy();
    expect(store.getState().savedTracks.map(saved => saved.id)).toContain(savedId);

    store.getState().undo();
    expect(store.getState().savedTracks.map(saved => saved.id)).not.toContain(savedId);

    store.setState({ _lastRestoreTime: 0 });
    store.getState().redo();
    expect(store.getState().savedTracks.map(saved => saved.id)).toContain(savedId);

    store.setState({ _lastRestoreTime: 0 });
    store.getState().removeSavedTrack(savedId!);
    expect(store.getState().savedTracks.map(saved => saved.id)).not.toContain(savedId);

    store.getState().undo();
    expect(store.getState().savedTracks.map(saved => saved.id)).toContain(savedId);
  });
});
