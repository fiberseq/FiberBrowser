import { getBrowserPerformanceProfile } from './performanceProfile';

const sizes = new WeakMap<object, number>();

/** Bound undo retention, including deep cluster assignments; keep the current step. */
export function trimHistory<T extends object>(stack: T[], maxEntries: number): T[] {
  const tier = getBrowserPerformanceProfile().tier;
  const budget = (tier === 'low' ? 8 : tier === 'high' ? 128 : 64) * 1024 ** 2;
  const bytes = (value: T) => {
    let size = sizes.get(value);
    if (size === undefined) { size = JSON.stringify(value).length * 2 + 1024; sizes.set(value, size); }
    return size;
  };
  let total = stack.reduce((sum, item) => sum + bytes(item), 0);
  while (stack.length > 1 && (stack.length > maxEntries || total > budget)) total -= bytes(stack.shift()!);
  return stack;
}
