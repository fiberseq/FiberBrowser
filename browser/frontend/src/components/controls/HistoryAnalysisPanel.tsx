import { useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { AnalysisPanelShell } from './shared';
import { Compass, Sparkles } from '../ui/Icons';
import { CopilotCommandPanel } from './CopilotCommandPanel';
import { TutorialTourTab } from './TutorialTourTab';
import { isPublicServerPage } from '../../utils/publicServerFlag';
import { isCopilotIncluded } from '../../utils/copilotIncluded';

type TutorialTab = 'tour' | 'copilot';

const TABS = [
  { key: 'tour' as const, label: 'Guided tour', icon: <Compass size={13} /> },
  { key: 'copilot' as const, label: 'Copilot', icon: <Sparkles size={13} /> },
];

const TAB_STORAGE_KEY = 'fiberbrowser_tutorial_tab';

function initialTab(): TutorialTab {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) === 'copilot' ? 'copilot' : 'tour';
  } catch {
    return 'tour';
  }
}

/**
 * The Tutorial panel: the guided tour's steps (to search and start at any of
 * them), and Copilot, which answers plain-language requests. The undo
 * timeline lives on the Undo/Redo buttons, and keyboard shortcuts in the
 * toolbar's More menu.
 */
export function HistoryAnalysisPanel() {
  const commandCount = useBrowserStore(s => s.commandHistory.length);
  // Copilot runs a model on the host: public pages (and tour sandbox tabs) show the tour
  // only, and so does FiberBrowser.app, which leaves the Copilot out.
  const hostTools = !isPublicServerPage() && isCopilotIncluded();
  const [tab, setTab] = useState<TutorialTab>(() => (hostTools ? initialTab() : 'tour'));
  const changeTab = (next: TutorialTab) => {
    setTab(next);
    try { localStorage.setItem(TAB_STORAGE_KEY, next); } catch { /* not remembered */ }
  };
  return (
    <AnalysisPanelShell
      tabs={hostTools ? TABS : TABS.filter(t => t.key === 'tour')}
      activeTab={tab}
      onTabChange={changeTab}
      theme="slate"
      className="flex flex-col h-full"
      tabBarClassName="px-2"
      bodyMode="fill"
    >
      {/* Both stay mounted, so Copilot keeps its request and answer while the tour tab shows. */}
      <div className={tab === 'tour' ? 'h-full px-3 pb-2 pt-3' : 'hidden'}>
        <TutorialTourTab />
      </div>
      {hostTools && (
        <div className={tab === 'copilot' ? 'h-full' : 'hidden'}>
          <div className="flex items-baseline gap-2 px-3 pt-3 text-[12px] text-ink-muted">
            <span className="flex-1">Ask how to do something, in plain language.</span>
            <span className="text-[11px] tabular-nums">{commandCount} command{commandCount === 1 ? '' : 's'}</span>
          </div>
          <CopilotCommandPanel />
        </div>
      )}
    </AnalysisPanelShell>
  );
}
