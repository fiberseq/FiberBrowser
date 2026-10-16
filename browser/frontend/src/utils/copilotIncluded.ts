/**
 * Whether this FiberBrowser includes the Copilot. FiberBrowser.app leaves it
 * out (its server runs with --no-copilot and marks the page before any script
 * runs; /api/status reports `features.copilot: false`); the pip install keeps
 * it. Safe to read from modules that can't import the store.
 */
export function isCopilotIncluded(): boolean {
  return typeof window === 'undefined'
    || (window as unknown as { __FIBERBROWSER_NO_COPILOT__?: boolean }).__FIBERBROWSER_NO_COPILOT__ !== true;
}
