import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredFlag, writeStoredFlag } from './copilotSettings';
import { readTutorialMode, writeTutorialMode } from './copilotAnchors';
import { readShareOptIn, writeShareOptIn } from '../hooks/useSessionLog';

describe('Copilot preference flags', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('round-trips a flag through localStorage', () => {
    writeStoredFlag('k', true);
    expect(readStoredFlag('k')).toBe(true);
    writeStoredFlag('k', false);
    expect(readStoredFlag('k')).toBe(false);
  });

  it('reads false and writes nothing when storage is blocked', () => {
    // Blocked site data: the localStorage getter itself throws.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readTutorialMode()).toBe(false);
    expect(readShareOptIn()).toBe(false);
    expect(() => writeTutorialMode(true)).not.toThrow();
    expect(() => writeShareOptIn(true)).not.toThrow();
  });
});
