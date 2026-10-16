import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { RedoIcon, UndoIcon, ChevronDown } from '../ui/Icons';
import { HistoryPanel } from './HistoryPanel';
import { undoRedoLabels } from '../../utils/historyLabels';

export function HistoryQuickControls() {
  const { undo, redo, historyStack, historyPointer } = useBrowserStore(useShallow(s => ({
    undo: s.undo,
    redo: s.redo,
    historyStack: s._historyStack,
    historyPointer: s._historyPointer,
  })));
  const canUndo = historyPointer > 0;
  const canRedo = historyPointer >= 0 && historyPointer < historyStack.length - 1;
  // Undo reverses the current step (the stack holds the state after each step).
  const { undo: undoLabel, redo: redoLabel } = undoRedoLabels(historyStack, historyPointer);

  const [timelineOpen, setTimelineOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!timelineOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setTimelineOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setTimelineOpen(false); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [timelineOpen]);

  return (
    <div ref={wrapperRef} className="relative shrink-0">
    <div className="flex shrink-0 items-center gap-0.5" aria-label="History: undo, redo">
      <button
        type="button"
        onClick={undo}
        disabled={!canUndo}
        className="flex h-[30px] w-[30px] items-center justify-center rounded-fb border border-line bg-white text-slate-700 shadow-chip hover:bg-surface-sunken hover:text-slate-900 disabled:cursor-default disabled:text-slate-300 disabled:shadow-none disabled:hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200 dark:shadow-none dark:hover:bg-white/10 dark:disabled:text-slate-600 dark:disabled:hover:bg-white/[0.06]"
        title={undoLabel ? `Undo: ${undoLabel} (Cmd/Ctrl+Z)` : 'Nothing to undo'}
        aria-label="Undo"
        data-testid="quick-undo-button"
      >
        <UndoIcon size={14} />
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!canRedo}
        className="flex h-[30px] w-[30px] items-center justify-center rounded-fb border border-line bg-white text-slate-700 shadow-chip hover:bg-surface-sunken hover:text-slate-900 disabled:cursor-default disabled:text-slate-300 disabled:shadow-none disabled:hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200 dark:shadow-none dark:hover:bg-white/10 dark:disabled:text-slate-600 dark:disabled:hover:bg-white/[0.06]"
        title={redoLabel ? `Redo: ${redoLabel} (Cmd/Ctrl+Shift+Z)` : 'Nothing to redo'}
        aria-label="Redo"
        data-testid="quick-redo-button"
      >
        <RedoIcon size={14} />
      </button>
      <button
        type="button"
        onClick={() => setTimelineOpen(open => !open)}
        className={`flex h-[30px] w-[30px] items-center justify-center rounded-fb border border-line bg-white text-slate-700 shadow-chip hover:bg-surface-sunken hover:text-slate-900 disabled:cursor-default disabled:text-slate-300 disabled:shadow-none disabled:hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200 dark:shadow-none dark:hover:bg-white/10 dark:disabled:text-slate-600 dark:disabled:hover:bg-white/[0.06] ${timelineOpen ? '!bg-slate-100 dark:!bg-white/10' : ''}`}
        title={`History: ${historyStack.length} step${historyStack.length === 1 ? '' : 's'}; jump to any of them`}
        aria-expanded={timelineOpen}
        aria-label="Show history"
        data-testid="history-timeline-button"
      >
        <ChevronDown size={13} />
      </button>
    </div>
    {timelineOpen && (
      <div
        className="absolute left-0 top-full z-[80] mt-1 max-h-[60vh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-fb-lg border border-line bg-white shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark"
        role="dialog"
        aria-label="History"
        data-testid="history-timeline"
      >
        <HistoryPanel />
      </div>
    )}
    </div>
  );
}
