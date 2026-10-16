import { useEffect, useState } from 'react';
import { SANDBOX_EXPIRED_EVENT, isWorkspacePage, sandboxExpired, sandboxId } from '../../utils/sandbox';

/** In a tour tab (sandbox) or an independent workspace: says this tab can't
 * change the user's other tabs, and when it has ended. */
export function SandboxBanner() {
  const workspace = isWorkspacePage();
  const [expired, setExpired] = useState(sandboxExpired);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SANDBOX_EXPIRED_EVENT, onExpired);
    if (sandboxExpired()) setExpired(true);
    return () => window.removeEventListener(SANDBOX_EXPIRED_EVENT, onExpired);
  }, []);

  const closeTab = () => {
    const id = sandboxId();
    // Free the sandbox (or workspace) now rather than when it times out.
    const route = workspace ? '/api/workspaces/' : '/api/sandbox/';
    if (id) fetch(`${route}${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    window.close();
  };

  return (
    <div
      data-testid="sandbox-banner"
      role="status"
      className="bg-sky-50 dark:bg-sky-900/30 border-b border-sky-200 dark:border-sky-700 px-4 py-1.5 flex items-center gap-3 text-sm"
    >
      <span className="text-sky-800 dark:text-sky-200 flex-1">
        {workspace
          ? (expired
            ? 'This workspace has ended (the server restarted, or it was unused for a long time). Close the tab; your other tabs are unchanged.'
            : 'Independent workspace: this tab has its own datasets and analyses; your other tabs are unchanged. Closing it with the button ends the workspace.')
          : expired
            ? 'This tour tab has ended (it was unused for a while). Close it and start the tour again from your main tab; your work there is unchanged.'
            : "Tour: this tab is a separate sandbox; nothing here changes your work. Close the tab when you're done."}
      </span>
      <button
        onClick={closeTab}
        className="px-2 py-0.5 text-xs rounded border border-sky-300 dark:border-sky-600 text-sky-800 dark:text-sky-200 hover:bg-sky-100 dark:hover:bg-sky-800/40"
        data-testid="sandbox-close-tab"
      >
        Close tab
      </button>
    </div>
  );
}
