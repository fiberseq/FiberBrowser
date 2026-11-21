/**
 * The shell every full-window workspace shares (Plots, the Feature hub): a top band in the workspace's own tint
 * (Plots gold, Hub indigo; light, so text keeps its contrast) holding the shared locus with back / forward, pan and
 * zoom, Back to browser (Esc), the mini read strip and an optional row (Plots: Plot | Gallery). Everything in it moves
 * the same shared locus as the browser.
 */
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { findChromInfo } from '../../utils/chromAliases';
import { MiniReadStrip } from './MiniReadStrip';
import { formatLocus, formatWidth } from './plotModel';
import { usePlotTargets } from './usePlotTargets';
import { closePlots } from './workspace';

export type WorkspaceTone = 'plots' | 'hub';

/** The band's tint and rule per workspace (light tints of the design system's gold and indigo). */
export const WORKSPACE_BAND: Record<WorkspaceTone, string> = {
  plots: 'bg-amber-50/80 border-amber-200/80 dark:bg-amber-950/25 dark:border-amber-900/50',
  hub: 'bg-indigo-50/80 border-indigo-200/80 dark:bg-indigo-950/25 dark:border-indigo-900/50',
};

export const SHELL_BTN = 'inline-flex h-6 min-w-6 items-center justify-center rounded bg-white/70 px-1.5 text-[11px] text-gray-600 ring-1 ring-inset ring-gray-200 hover:bg-white disabled:opacity-40 dark:bg-transparent dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/5';

function NavRow({ title, prefix, right }: { title: string; prefix: string; right?: ReactNode }) {
  const { chrom, start, end, chroms, setViewport, goBack, goForward, zoomIn, zoomOut, perPanel } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, chroms: s.chroms, setViewport: s.setViewport,
    goBack: s.goBack, goForward: s.goForward, zoomIn: s.zoomIn, zoomOut: s.zoomOut, perPanel: s.navigationMode === 'perPanel',
  })));
  const pan = (dir: -1 | 1) => {
    const w = Math.max(3, end - start);
    const size = findChromInfo(chroms, chrom)?.size ?? Number.POSITIVE_INFINITY;
    let s = Math.max(0, Math.round(start + dir * w * 0.25));
    if (Number.isFinite(size) && s + w > size) s = Math.max(0, size - w);
    setViewport(chrom, s, s + w);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-testid={`${prefix}-nav`}>
      <h2 className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
      <span className="font-mono text-[11px] text-gray-700 dark:text-gray-200" data-testid={`${prefix}-locus`}>{formatLocus({ chrom, start, end })}</span>
      <span className="text-[10px] text-gray-500">{formatWidth(end - start)}</span>
      {/* Each panel navigates: as in the top bar, the main view's pan / zoom are off (back / forward still undo jumps). */}
      <fieldset disabled={perPanel} className="contents" title={perPanel ? 'Each panel navigates: move a panel with its own locus box' : undefined}>
        <div className={`flex items-center gap-1${perPanel ? ' opacity-40' : ''}`} role="group" aria-label="Navigation">
          <button type="button" className={SHELL_BTN} onClick={goBack} title="Back (Alt+←)" aria-label="Back" data-testid={`${prefix}-back`}>‹ Back</button>
          <button type="button" className={SHELL_BTN} onClick={goForward} title="Forward (Alt+→)" aria-label="Forward" data-testid={`${prefix}-forward`}>Fwd ›</button>
          <button type="button" className={SHELL_BTN} onClick={() => pan(-1)} title="Pan left (←)" aria-label="Pan left" data-testid={`${prefix}-pan-left`}>←</button>
          <button type="button" className={SHELL_BTN} onClick={() => pan(1)} title="Pan right (→)" aria-label="Pan right" data-testid={`${prefix}-pan-right`}>→</button>
          <button type="button" className={SHELL_BTN} onClick={zoomOut} title="Zoom out (↓ or −)" aria-label="Zoom out" data-testid={`${prefix}-zoom-out`}>−</button>
          <button type="button" className={SHELL_BTN} onClick={zoomIn} title="Zoom in (↑ or +)" aria-label="Zoom in" data-testid={`${prefix}-zoom-in`}>+</button>
        </div>
      </fieldset>
      <span className="text-[10px] text-gray-500">shared locus with the browser · ← → pan</span>
      <span className="ml-auto inline-flex items-center gap-2">
        {right}
        <button type="button" onClick={() => closePlots()} data-testid={`${prefix}-back-to-browser`}
          className="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-[11px] font-medium text-gray-700 ring-1 ring-inset ring-gray-200 hover:bg-gray-50 dark:bg-transparent dark:text-gray-200 dark:ring-white/15">
          Back to browser <kbd className="rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-white/10">Esc</kbd>
        </button>
      </span>
    </div>
  );
}

/** The workspace's top band: nav, mini strip and an optional row, on the workspace's tint. */
export function WorkspaceBand({ tone, title, prefix, right, row }: { tone: WorkspaceTone; title: string; prefix: string; right?: ReactNode; row?: ReactNode }) {
  const perPanel = useBrowserStore(s => s.navigationMode === 'perPanel');
  const first = usePlotTargets().allReads.panels[0];
  return (
    <div className={`shrink-0 border-b ${WORKSPACE_BAND[tone]}`} data-testid={`${prefix}-band`} data-tone={tone}>
      <NavRow title={title} prefix={prefix} right={right} />
      {!perPanel && <MiniReadStrip datasetId={first?.datasetId ?? null} label={first?.datasetLabel ?? first?.label ?? 'no dataset'} />}
      {row && <div className="px-3 pb-1.5 pt-0.5">{row}</div>}
    </div>
  );
}
