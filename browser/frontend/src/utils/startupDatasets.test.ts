import { describe, expect, it } from 'vitest';
import { startupDatasetsApply } from './startupDatasets';

describe('startupDatasetsApply', () => {
  it('applies when nothing replaced the datasets since startup', () => {
    const start: string[] = [];
    expect(startupDatasetsApply(start, start)).toBe(true);
  });
  it('applies when only a metadata refresh re-mapped the empty list', () => {
    expect(startupDatasetsApply([], [].map(x => x))).toBe(true);
  });
  it('does not overwrite datasets a session restore set during startup', () => {
    expect(startupDatasetsApply([], [{ id: 'restored' }])).toBe(false);
  });
});
