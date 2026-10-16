/**
 * One generation counter for read-filter requests, shared by the Rules filter
 * (Browser.tsx) and Copilot's apply/clear filter actions: a newer request, or
 * a Clear from either, supersedes every pending one, so a late response can't
 * reinstall a filter the user has since cleared or replaced.
 */
let generation = 0;

/** Start a filter request; returns its generation. */
export function nextFilterRequest(): number {
  generation += 1;
  return generation;
}

/** Whether a request's result may still be applied. */
export function isCurrentFilterRequest(request: number): boolean {
  return request === generation;
}

/** Clear: every pending filter request is superseded. */
export function invalidateFilterRequests(): void {
  generation += 1;
}
