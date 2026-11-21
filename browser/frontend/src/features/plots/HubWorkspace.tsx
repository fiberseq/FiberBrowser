/**
 * The Feature hub as a full-window workspace (H), in the same shell as Plots: the shared locus, the mini read strip
 * and Back to browser (Esc) on an indigo band, then the hub itself (hits, combinations, association and the rest of
 * its tabs). The docked hub panel stays the "find" side beside the reads, with "Open in Hub" to come here.
 */
import { lazy, Suspense } from 'react';
import { WorkspaceBand, SHELL_BTN } from './WorkspaceShell';
import { openDockedHub } from './workspace';
import { HubWorkspaceContext } from '../hub/FeatureHubPanel';

const FeatureHubPanel = lazy(() => import('../hub/FeatureHubPanel').then(m => ({ default: m.FeatureHubPanel })));

export function HubWorkspace() {
  return (
    <div className="absolute inset-0 z-[40] flex flex-col bg-surface-sunken text-gray-800 dark:bg-dark-bg dark:text-gray-100"
      data-testid="hub-workspace" aria-label="Feature hub workspace">
      <WorkspaceBand tone="hub" title="Feature hub" prefix="hub"
        right={(
          <button type="button" className={SHELL_BTN} data-testid="hub-dock" onClick={() => openDockedHub()}
            title="Dock the hub beside the reads (the find side)">Dock beside the reads</button>
        )} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-[1400px] rounded-xl bg-white p-2 shadow-[0_0_0_1px_#dfe3eb] dark:bg-white/5 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)]">
          <HubWorkspaceContext.Provider value>
            <Suspense fallback={<div className="p-3 text-[12px] text-gray-500">Loading the Feature hub…</div>}>
              <FeatureHubPanel isFullView />
            </Suspense>
          </HubWorkspaceContext.Provider>
        </div>
      </div>
    </div>
  );
}
