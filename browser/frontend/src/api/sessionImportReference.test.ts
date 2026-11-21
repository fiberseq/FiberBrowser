import { afterEach, describe, expect, it, vi } from 'vitest';

// A session the user opens counts as the user's reference choice.
vi.mock('./sharedFetch', async () => {
  const actual = await vi.importActual<typeof import('./sharedFetch')>('./sharedFetch');
  return {
    ...actual,
    fetchApiResponse: vi.fn(async () => new Response(JSON.stringify({ success: true, results: {} }), { status: 200 })),
  };
});

import { importSession } from './session';
import { useReferenceNoticeStore } from '../stores/referenceNoticeStore';

describe('opening a session file', () => {
  afterEach(() => useReferenceNoticeStore.setState({ userChose: false }));

  it('counts as the user choosing the reference', async () => {
    useReferenceNoticeStore.setState({ userChose: false });
    const pending = importSession({ version: 3, datasets: [] }).catch(() => undefined);
    // Marked before the import's request resolves (re-check R2: an auto-switch deciding meanwhile must see it).
    expect(useReferenceNoticeStore.getState().userChose).toBe(true);
    await pending;
    expect(useReferenceNoticeStore.getState().userChose).toBe(true);
  });
});
