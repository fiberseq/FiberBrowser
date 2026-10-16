export const FRONTEND_DIAGNOSTICS =
  import.meta.env.DEV && import.meta.env.VITE_FIBERBROWSER_DEBUG === '1';

export function logFrontendDiagnostic(...args: unknown[]): void {
  if (FRONTEND_DIAGNOSTICS) {
    console.log(...args);
  }
}
