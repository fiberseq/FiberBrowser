import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { performanceModeTitle } from '../../utils/performanceProfile';
import type { ReadSeparatorMode } from '../../stores/uiSlice';
import { Minus, Plus } from '../ui/Icons';

function clampCount(value: number): number {
  return Math.max(1, Math.min(50_000, Math.round(value)));
}

function clampRowHeight(value: number): number {
  return Math.max(1, Math.min(99, Math.round(value)));
}

function clampSeparatorMinHeight(value: number): number {
  return Math.max(0.5, Math.min(50, value));
}

function clampSeparatorWidth(value: number): number {
  return Math.max(0, Math.min(10, value));
}

type ReadDisplayToolbarControlsMode = 'all' | 'compact' | 'advanced';
type ReadRowHeight = number | 'auto';

interface ReadDisplayToolbarControlsProps {
  mode?: ReadDisplayToolbarControlsMode;
}

const ROW_HEIGHT_TITLE = 'Row height: how tall each read is drawn. The [ and ] keys make rows thinner or thicker.';
const FILL_TITLE = 'Fill: when there are only a few reads, stretch the rows to fill the panel. With many reads the row height is used.';

function FillToggle({
  fillReadHeight,
  onToggle,
}: {
  fillReadHeight: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={fillReadHeight}
      data-testid="read-display-fill-height"
      data-copilot-anchor="read-fill-height"
      className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
        fillReadHeight
          ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-400/60 dark:bg-teal-950/40 dark:text-teal-200'
          : 'border-gray-200 bg-white/70 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200'
      }`}
      title={FILL_TITLE}
    >
      Fill
    </button>
  );
}

function RowHeightStepper({
  compact = false,
  readRowHeight,
  onDecrease,
  onIncrease,
  onSetReadRowHeight,
}: {
  compact?: boolean;
  readRowHeight: ReadRowHeight;
  onDecrease: () => void;
  onIncrease: () => void;
  onSetReadRowHeight: (height: ReadRowHeight) => void;
}) {
  return (
    <div
      className={`flex items-center rounded-md border border-gray-200 bg-white/70 p-0.5 text-[11px] dark:border-white/10 dark:bg-white/[0.05] ${compact ? '' : 'gap-0.5'}`}
      title={ROW_HEIGHT_TITLE}
      data-testid={compact ? 'read-display-row-height-compact' : 'read-display-row-height-stepper'}
      data-copilot-anchor="read-row-height"
    >
      <button
        type="button"
        onClick={onDecrease}
        className="rounded px-1 py-0 font-semibold text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
        aria-label="Decrease read row height"
      >
        <Minus size={12} aria-hidden="true" />
      </button>
      {compact ? (
        <span className="min-w-8 px-1 text-center font-medium text-gray-600 dark:text-gray-300">
          <span className="font-normal text-gray-400 dark:text-gray-500">row </span>
          {readRowHeight === 'auto' ? 'auto' : `${Number(readRowHeight.toFixed(1))}px`}
        </span>
      ) : (
        <>
          <span className="px-0.5 text-gray-500 dark:text-gray-400">row</span>
          <input
            type="number"
            min={1}
            max={99}
            step={1}
            aria-label="Read row height"
            data-testid="read-display-row-height"
            value={readRowHeight === 'auto' ? '' : String(readRowHeight)}
            placeholder="auto"
            onChange={e => {
              const raw = e.target.value.trim();
              if (!raw) {
                onSetReadRowHeight('auto');
                return;
              }
              const next = Number(raw);
              if (Number.isFinite(next)) onSetReadRowHeight(clampRowHeight(next));
            }}
            className="input-tool h-6 w-12 px-1 py-0 text-center text-[11px]"
          />
          <span className="text-gray-400">px</span>
        </>
      )}
      <button
        type="button"
        onClick={onIncrease}
        className="rounded px-1 py-0 font-semibold text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white"
        aria-label="Increase read row height"
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ReadDisplayToolbarControls({ mode = 'all' }: ReadDisplayToolbarControlsProps) {
  const {
    readDisplayMode,
    setReadDisplayMode,
    downsampleCount,
    setDownsampleCount,
    readRowHeight,
    setReadRowHeight,
    fillReadHeight,
    setFillReadHeight,
    readSeparatorMode,
    setReadSeparatorMode,
    readSeparatorMinHeight,
    setReadSeparatorMinHeight,
    readSeparatorWidth,
    setReadSeparatorWidth,
    allReadsDisplayCap,
  } = useBrowserStore(useShallow(s => ({
    readDisplayMode: s.readDisplayMode,
    setReadDisplayMode: s.setReadDisplayMode,
    downsampleCount: s.downsampleCount,
    setDownsampleCount: s.setDownsampleCount,
    readRowHeight: s.readRowHeight,
    setReadRowHeight: s.setReadRowHeight,
    fillReadHeight: s.fillReadHeight,
    setFillReadHeight: s.setFillReadHeight,
    readSeparatorMode: s.readSeparatorMode,
    setReadSeparatorMode: s.setReadSeparatorMode,
    readSeparatorMinHeight: s.readSeparatorMinHeight,
    setReadSeparatorMinHeight: s.setReadSeparatorMinHeight,
    readSeparatorWidth: s.readSeparatorWidth,
    setReadSeparatorWidth: s.setReadSeparatorWidth,
    allReadsDisplayCap: s.allReadsDisplayCap,
  })));

  const showModeToggle = mode === 'all' || mode === 'compact';
  const showAdvanced = mode === 'all' || mode === 'advanced';
  const performanceTierTitle = performanceModeTitle();
  const numericReadRowHeight = readRowHeight === 'auto' ? 1 : readRowHeight;
  const adjustReadRowHeight = (delta: number) => {
    const step = numericReadRowHeight >= 12 ? 2 : 1;
    setReadRowHeight(clampRowHeight(numericReadRowHeight + delta * step));
  };

  return (
    <>
      {showModeToggle && (
        <>
          <div
            className="flex items-center rounded-md border border-gray-200 bg-white/70 p-px text-[11px] dark:border-white/10 dark:bg-white/[0.05]"
            title={`Fit draws a sample of the reads that fits the panel; All draws every read (up to ${allReadsDisplayCap.toLocaleString()}) and scrolls. ${performanceTierTitle}`}
            data-testid="read-display-mode-toggle"
          >
            <button
              type="button"
              onClick={() => setReadDisplayMode('sample')}
              aria-pressed={readDisplayMode === 'sample'}
              data-testid="read-display-fit"
              className={`rounded px-1.5 py-0 font-medium leading-[18px] ${
                readDisplayMode === 'sample'
                  ? 'bg-teal-600 text-white'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200'
              }`}
              title="Fit: draw a representative sample of the reads, as many as fit the panel without scrolling"
            >
              Fit
            </button>
            <button
              type="button"
              onClick={() => setReadDisplayMode('all')}
              aria-pressed={readDisplayMode === 'all'}
              data-testid="read-display-all"
              className={`rounded px-1.5 py-0 font-medium leading-[18px] ${
                readDisplayMode === 'all'
                  ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200'
              }`}
              title={`All: draw every read (up to ${allReadsDisplayCap.toLocaleString()}), scrolling when they don't fit`}
            >
              All
            </button>
          </div>
          {mode === 'compact' && (
            <RowHeightStepper
              compact
              readRowHeight={readRowHeight}
              onDecrease={() => adjustReadRowHeight(-1)}
              onIncrease={() => adjustReadRowHeight(1)}
              onSetReadRowHeight={setReadRowHeight}
            />
          )}
        </>
      )}

      {mode !== 'compact' && (showModeToggle || mode === 'advanced') && (
        <FillToggle
          fillReadHeight={fillReadHeight}
          onToggle={() => setFillReadHeight(!fillReadHeight)}
        />
      )}

      {showAdvanced && (
        <>
          <label className="flex items-center gap-0.5 text-gray-500 dark:text-gray-400" title="In Fit, the most reads to draw (a representative sample). Empty: as many as fit the panel.">
            <span>max reads</span>
            <input
              type="number"
              min={1}
              max={allReadsDisplayCap}
              step={100}
              disabled={readDisplayMode === 'all'}
              aria-label="Read display sample count"
              data-testid="read-display-sample-count"
              value={readDisplayMode === 'all' ? '' : (downsampleCount == null ? '' : String(downsampleCount))}
              placeholder={readDisplayMode === 'all' ? 'all' : 'auto'}
              onChange={e => {
                const raw = e.target.value.replace(/,/g, '').trim();
                if (!raw) {
                  setDownsampleCount(null);
                  return;
                }
                const next = Number(raw);
                if (Number.isFinite(next)) setDownsampleCount(clampCount(next));
              }}
              className="input-tool h-6 w-16 px-1 py-0 text-center text-[11px] disabled:opacity-50"
            />
          </label>

          <label className="flex items-center gap-0.5 text-gray-500 dark:text-gray-400" title="Lines between read rows. Auto scales the line with the row height; Fixed uses the width you set; Off draws none.">
            <span>row lines</span>
            <select
              value={readSeparatorMode}
              onChange={e => setReadSeparatorMode(e.target.value as ReadSeparatorMode)}
              className="input-tool h-6 w-16 px-1 py-0 text-[11px]"
              data-testid="read-display-separator-mode"
              data-copilot-anchor="read-separator-mode"
            >
              <option value="auto">auto</option>
              <option value="fixed">fixed</option>
              <option value="off">off</option>
            </select>
          </label>

          {readSeparatorMode !== 'off' && (
            <label className="flex items-center gap-0.5 text-gray-500 dark:text-gray-400" title="Draw the lines only when rows are at least this tall.">
              <span>when rows ≥</span>
              <input
                type="number"
                min={0.5}
                max={50}
                step={0.5}
                value={readSeparatorMinHeight}
                onChange={e => setReadSeparatorMinHeight(clampSeparatorMinHeight(parseFloat(e.target.value)))}
                className="input-tool h-6 w-11 px-1 py-0 text-center text-[11px]"
                data-testid="read-display-separator-min-height"
                data-copilot-anchor="read-separator-min-height"
              />
              <span className="text-gray-400">px</span>
            </label>
          )}

          {readSeparatorMode === 'fixed' && (
            <label className="flex items-center gap-0.5 text-gray-500 dark:text-gray-400" title="Width of each line between rows.">
              <span>width</span>
              <input
                type="number"
                min={0}
                max={10}
                step={0.25}
                value={readSeparatorWidth}
                onChange={e => setReadSeparatorWidth(clampSeparatorWidth(parseFloat(e.target.value)))}
                className="input-tool h-6 w-11 px-1 py-0 text-center text-[11px]"
                data-testid="read-display-separator-width"
                data-copilot-anchor="read-separator-width"
              />
              <span className="text-gray-400">px</span>
            </label>
          )}

          <button
            type="button"
            onClick={() => {
              setReadDisplayMode('sample');
              setDownsampleCount(null);
              setReadRowHeight(1);
            }}
            className="rounded px-1 py-0.5 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
            title="Back to Fit, automatic sampling and 1 px rows"
            data-testid="read-display-reset"
          >
            Reset
          </button>
        </>
      )}
    </>
  );
}
