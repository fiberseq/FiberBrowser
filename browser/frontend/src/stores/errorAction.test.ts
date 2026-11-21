import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from './browserStore';
import { serializeState } from './historySlice';

const state = () => useBrowserStore.getState();

beforeEach(() => state().setError(null));

describe('the error banner action (e.g. Retry)', () => {
  it('comes with its error and goes with every plain setError', () => {
    const run = vi.fn();
    state().setError('Could not build', { label: 'Retry', run });
    expect(state().error).toBe('Could not build');
    expect(state().errorAction).toEqual({ label: 'Retry', run });

    // A later error without an action: no stale Retry for the earlier one.
    state().setError('Something else');
    expect(state().errorAction).toBeNull();

    state().setError('Could not build', { label: 'Retry', run });
    state().setError(null);
    expect(state().error).toBeNull();
    expect(state().errorAction).toBeNull();

    // No banner, no action.
    state().setError(null, { label: 'Retry', run });
    expect(state().errorAction).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('goes with Reset view', () => {
    state().setError('Could not build', { label: 'Retry', run: () => {} });
    state().resetView();
    expect(state().error).toBeNull();
    expect(state().errorAction).toBeNull();
  });

  it('is never written into an undo step (it holds a function)', () => {
    state().setError('Could not build', { label: 'Retry', run: () => {} });
    const snapshot = serializeState(state()) as unknown as Record<string, unknown>;
    expect('error' in snapshot).toBe(false);
    expect('errorAction' in snapshot).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('Could not build');
  });
});
