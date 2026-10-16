import { afterEach, describe, expect, it } from 'vitest';
import { recentTracksOffered } from './recentTracks';
import { resetSandboxForTests } from '../utils/sandbox';

describe('recentTracksOffered', () => {
  afterEach(() => {
    resetSandboxForTests(null);
    delete (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__;
  });

  it('is on in a local tab and an independent workspace', () => {
    expect(recentTracksOffered(false)).toBe(true);
    resetSandboxForTests('ws-abcdefghijklmnop');
    expect(recentTracksOffered(false)).toBe(true);
  });

  it('is off in a tour sandbox tab, even before the server says it is public (GET /api/tracks/recent is 403 there)', () => {
    resetSandboxForTests('sb-abcdefghijklmnop');
    expect(recentTracksOffered(false)).toBe(false);
  });

  it('is off on a public server', () => {
    expect(recentTracksOffered(true)).toBe(false);
    (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__ = true;
    expect(recentTracksOffered(false)).toBe(false);
  });
});
