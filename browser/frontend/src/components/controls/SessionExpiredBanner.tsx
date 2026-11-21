import { SESSION_EXPIRED_TEXT, useSessionExpiredStore } from '../../stores/sessionExpiredStore';

/** A full-width banner when the server stopped accepting this tab (401): reload with the server's new link. */
export function SessionExpiredBanner() {
  const expired = useSessionExpiredStore(s => s.expired);
  if (!expired) return null;
  return (
    <div role="alert" data-testid="session-expired-banner"
      className="flex items-center gap-3 border-b border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200">
      <span className="min-w-0 flex-1">{SESSION_EXPIRED_TEXT}</span>
      <button type="button" className="shrink-0 rounded border border-red-300 px-2 py-0.5 hover:bg-red-100 dark:border-red-400/40 dark:hover:bg-red-500/20"
        onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
