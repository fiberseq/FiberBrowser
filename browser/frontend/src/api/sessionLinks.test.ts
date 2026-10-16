import { afterEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ fetchApiResponse: vi.fn() }));
vi.mock('./sharedFetch', () => ({ fetchApiResponse: shared.fetchApiResponse }));

import { previewLink } from './sessionLinks';

describe('previewLink', () => {
  afterEach(() => vi.resetAllMocks());

  it('keeps the message and preview fields of a 400 answer for an invalid document', async () => {
    // Review round 13: an invalid document is a 400 (it was a 200 with success:false).
    shared.fetchApiResponse.mockResolvedValue(new Response(JSON.stringify({
      success: false, error: 'The session document is not valid JSON (Expecting value, line 1).',
      id: 'abc', source: { kind: 'session', host: 'portal.example', url: 'https://portal.example/s.json' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const preview = await previewLink('abc', true);
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('not valid JSON');
    expect(preview.source.host).toBe('portal.example');
  });
});
