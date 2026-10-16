import { openRegionPanels } from '../../utils/regionPanels';
import { UndoToast } from '../ui/UndoToast';
import { useUndoToastStore } from '../../stores/undoToastStore';
/**
 * The last Cluster, Sort and Filter outcome, one slim line each (usability audit Top 3): it clears when the next run
 * of that kind starts, and can be dismissed. An operation's own refusal or note lives here, not in the global error
 * banner (which outlived a later successful run).
 *
 * Owner (6 Oct): a run that went through shows no line unless Settings › Read Display › "Notes after Cluster,
 * Sort and Filter" is on (the reads show what was done), and the lines are a toast at the foot of the window instead
 * of pushing the reads down.
 */
import { useMemo } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { runResultPanelsClosed, useRunResultStore, type RunKind, type RunTone } from '../../stores/runResultStore';
import { X } from '../ui/Icons';

const NAMES: Record<RunKind, string> = { cluster: 'Cluster', sort: 'Sort', filter: 'Filter' };
const TONES: Record<RunTone, string> = {
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
  note: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100',
  done: 'border-slate-200 bg-slate-50/80 text-slate-600 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-300',
};

/** "14:03:12" (the run's time, to the second: two runs a minute apart differ). */
export function formatRunTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function RunResultLines() {
  const hasUndo = useUndoToastStore(s => s.toast?.scope === 'browser');
  const results = useRunResultStore(s => s.results);
  const showSummaries = useRunResultStore(s => s.showSummaries);
  const clear = useRunResultStore(s => s.clearRunResult);
  // A line whose panels have all closed says so (round 2, N5), rather than reading as the state of what is on screen.
  const matchedRun = useBrowserStore(s => s.clusterMatchedRun);
  const panels = useBrowserStore(s => s.panels);
  const openIds = useMemo(() => new Set(panels.map(p => p.id)), [panels]);
  const kinds = (['cluster', 'sort', 'filter'] as RunKind[]).filter(k => results[k] && (showSummaries || results[k]!.tone === 'error' || results[k]!.alwaysShow));
  if (!kinds.length && !hasUndo) return null;
  return (
    // A toast at the foot of the window: no layout shift for the reads, and never over a panel header's buttons
    // (a card over the top of the panel row covered their Close).
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4" data-testid="run-results-anchor">
    <div className="pointer-events-auto flex w-[min(640px,100%)] flex-col gap-1" data-testid="run-results">
      {kinds.map(kind => {
        const r = results[kind]!;
        const closed = runResultPanelsClosed(r, openIds);
        return (
          <div key={kind} data-testid={`run-result-${kind}`} data-tone={r.tone} data-panels-closed={closed ? 'true' : undefined}
            role={r.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 rounded-fb border border-l-4 px-3 py-1 text-[12px] leading-snug shadow-dropdown dark:shadow-dropdown-dark ${TONES[r.tone]} ${closed ? 'opacity-60' : ''}`}>
            <span className="shrink-0 font-semibold">{NAMES[kind]}{r.tone === 'error' ? ' did not run' : ''}:</span>
            <span className="min-w-0 flex-1 whitespace-pre-line" data-testid={`run-result-${kind}-text`}>
              {r.text}
              {kind === 'cluster' && matchedRun?.groups.map(id => <button key={id} type="button" data-testid={`run-result-open-panels-${id}`} className="ml-1 underline"
                onClick={() => openRegionPanels(id)}>Open as panels</button>)}
              {r.action && <button type="button" data-testid={`run-result-${kind}-action`} className="ml-1 underline"
                onClick={() => useBrowserStore.getState().openAnalysisPanel(r.action!.panel)}>{r.action.label}</button>}
              {closed && ' '}
              {closed && <span className="italic" data-testid={`run-result-${kind}-closed`}>({r.panelIds!.length === 1 ? 'panel' : 'panels'} closed)</span>}
            </span>
            {/* Which run and when: a rerun with the same outcome still replaces the line visibly (round 3, B5). */}
            <span className="shrink-0 pt-px text-[11px] tabular-nums opacity-70" data-testid={`run-result-${kind}-marker`} data-run={r.run}
              title={`${NAMES[kind]} run ${r.run} of this session, at ${new Date(r.at).toLocaleTimeString()}`}>
              run {r.run} · {formatRunTime(r.at)}
            </span>
            <button type="button" onClick={() => clear(kind)} aria-label={`Dismiss the ${NAMES[kind]} result`}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
              <X size={13} />
            </button>
          </div>
        );
      })}
      {hasUndo && <UndoToast scope="browser" />}
    </div>
    </div>
  );
}
