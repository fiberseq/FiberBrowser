/**
 * A shared lab server (profile "lab", backend services/lab/): the server
 * injects `window.__FIBERBROWSER_LAB__` into the page with who is signed in.
 * Everything the lab shares (data folders, Library, runs, the session shelf)
 * is visible to every member; host-only controls (Quit, New Window) are not
 * offered, and runs appear only when the server enables them.
 */

export interface LabPageInfo {
  user: string | null;
  role: 'member' | 'admin' | null;
  auth: 'accounts' | 'proxy' | 'none' | null;
  anonymous: boolean;
  jobs: boolean;
}

export function labInfo(win: Window | undefined = typeof window === 'undefined' ? undefined : window): LabPageInfo | null {
  const value = win ? (win as unknown as { __FIBERBROWSER_LAB__?: LabPageInfo }).__FIBERBROWSER_LAB__ : undefined;
  return value && typeof value === 'object' ? value : null;
}

/** This page is served by a lab server. */
export function isLabServerPage(): boolean {
  return labInfo() !== null;
}

/** A signed-in lab member (not an anonymous catalog visitor). */
export function labMember(): string | null {
  return labInfo()?.user ?? null;
}

/** Whether runs ("New DAF-seq run") are available here: always locally, on a lab server only when enabled. */
export function labRunsAvailable(): boolean {
  const info = labInfo();
  return info === null || (info.jobs && !!info.user);
}

/** A run this browser should act on by itself (auto-open): locally all, on a lab server the member's own. */
export function isOwnRun(job: { user?: string | null }): boolean {
  const info = labInfo();
  return info === null || !job.user || job.user === info.user;
}
