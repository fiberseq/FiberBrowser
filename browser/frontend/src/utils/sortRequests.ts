import { cancelProgressiveAnalysis } from './progressiveAnalysis';
/**
 * One generation counter for sort requests, shared by the Sort button
 * (Browser.tsx) and Copilot's apply_sort_rule: a newer sort from either
 * supersedes every pending one, so a late response can't overwrite a newer
 * order.
 */
let generation = 0;

/** Start a sort request; returns its generation. */
export function nextSortRequest(): number {
  cancelProgressiveAnalysis();
  generation += 1;
  return generation;
}

/** Whether a sort request's result may still be applied. */
export function isCurrentSortRequest(request: number): boolean {
  return request === generation;
}
