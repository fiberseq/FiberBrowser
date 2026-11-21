/**
 * The Browser · Hub · Plots toggle (Hub only with the experimental flag on: hubWorkspaceFlag) (mock "1 · Main"), as a vertical group at the top of the right-hand icon strip,
 * which stays on show in every workspace. Browser: the reads. Hub: the Feature hub full window (H). Plots: the Plots
 * workspace (P). Esc goes back to the browser.
 *
 * Not in the top bar: at 1600 px it has about 13 px to spare (ui-chrome-budget: one row from 1600 px), and the
 * operations row about 25 px at 1280 px; a horizontal toggle in either wraps a row and takes the reads' height.
 */
import type { ReactNode } from 'react';
import { BarChart, Reads } from '../../components/ui/Icons';
import { FeatureHubIcon } from '../hub/icon';
import { setWorkspace, toggleFeatureHub, useWorkspaceStore } from './workspace';
import { useHubWorkspaceEnabled } from './hubWorkspaceFlag';

function Item({ on, label, title, testId, onClick, children }: {
  on: boolean; label: string; title: string; testId: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button type="button" aria-pressed={on} aria-label={label} title={title} data-testid={testId} onClick={onClick}
      className={`relative flex h-9 w-9 shrink-0 flex-col items-center justify-center gap-px rounded-fb text-[8px] font-medium leading-none transition-colors
        ${on ? 'bg-white text-brand-700 shadow-chip ring-1 ring-line dark:bg-white/[0.12] dark:text-brand-200 dark:ring-white/15'
          : 'text-gray-500 hover:bg-white hover:text-brand-700 dark:text-gray-400 dark:hover:bg-white/[0.12] dark:hover:text-brand-200'}`}>
      {on && <span className="absolute -left-1 top-1.5 bottom-1.5 w-[3px] rounded-full bg-amber-600 dark:bg-amber-400" aria-hidden="true" />}
      {children}
      <span>{label}</span>
    </button>
  );
}

export function WorkspaceToggle() {
  const view = useWorkspaceStore(s => s.view);
  const hubOn = view === 'hub';
  const hubAllowed = useHubWorkspaceEnabled();
  return (
    <div role="group" aria-label="Workspace" className="flex shrink-0 flex-col items-center gap-0.5" data-testid="workspace-toggle">
      <Item on={view === 'browser'} label="Browser" title="Browser: the reads (Esc from Plots)" testId="workspace-browser"
        onClick={() => setWorkspace('browser')}><Reads size={14} /></Item>
      {hubAllowed && <Item on={hubOn} label="Hub" title="Feature hub, full window (H)" testId="workspace-hub"
        onClick={() => toggleFeatureHub()}><FeatureHubIcon size={14} /></Item>}
      <Item on={view === 'plots'} label="Plots" title="Plots workspace (P)" testId="workspace-plots"
        onClick={() => setWorkspace(view === 'plots' ? 'browser' : 'plots')}><BarChart size={14} /></Item>
      <div className="my-1 h-px w-6 bg-line dark:bg-white/10" aria-hidden="true" />
    </div>
  );
}
