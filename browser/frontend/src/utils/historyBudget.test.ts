import { afterEach, expect, it } from 'vitest';
import { trimHistory } from './historyBudget';
import { applyBrowserPerformanceMode, resetBrowserPerformanceProfileForTests } from './performanceProfile';

afterEach(resetBrowserPerformanceProfileForTests);

it('releases old large snapshots while preserving the current step', () => {
  const stack = Array.from({ length: 5 }, (_, step) => ({ step, assignments: 'a'.repeat(1024 ** 2) }));
  applyBrowserPerformanceMode('standard', 'standard');
  expect(trimHistory([...stack], 30)).toHaveLength(5);
  applyBrowserPerformanceMode('low', 'low');
  const kept = trimHistory([...stack], 30);
  expect(kept.length).toBeLessThan(5);
  expect(kept.at(-1)).toBe(stack[4]);
  expect(trimHistory([stack[4]], 0)).toEqual([stack[4]]);
});
