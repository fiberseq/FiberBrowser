import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SHORT_END_FOOTPRINT_BP, SHORT_END_FOOTPRINT_MAX_END_GAP_BP } from '../../../../stores/uiSlice';
import { defineSettings, inSidebar, settingAnchor, storeToggle } from '../../../../utils/settingsCatalog';

export const GAP_FILTER_SETTINGS = defineSettings({
  hideTerminalGaps: {
    id: 'view.hide-terminal-gaps',
    label: 'Hide terminal gaps',
    keywords: ['read ends', 'edges', 'gap filter', 'unaligned ends', 'soft clip'],
    location: inSidebar('view.advanced'),
    toggle: storeToggle('hideTerminalGaps', 'setHideTerminalGaps'),
  },
  terminalGapThreshold: {
    id: 'view.terminal-gap-max',
    label: 'Max terminal gap (bp)',
    keywords: ['threshold', 'read ends', 'gap size'],
    location: inSidebar('view.advanced'),
    hiddenReason: () => (useBrowserStore.getState().hideTerminalGaps ? null : 'shown when Hide terminal gaps is on'),
  },
  hideShortEndFootprints: {
    id: 'view.hide-short-end-footprints',
    label: `Hide footprints cut off at read ends (< ${SHORT_END_FOOTPRINT_BP} bp)`,
    keywords: ['read-end footprints', 'read ends', 'edges', 'truncated', 'amplicon ends', 'stubs', 'short footprints'],
    location: inSidebar('view.advanced'),
    toggle: storeToggle('hideShortEndFootprints', 'setHideShortEndFootprints'),
  },
  fillSmallGaps: {
    id: 'view.fill-gaps',
    label: 'Fill gaps',
    keywords: ['small gaps', 'merge footprints', 'bridge', 'gap size'],
    location: inSidebar('view.advanced'),
    toggle: storeToggle('fillSmallGaps', 'setFillSmallGaps'),
  },
});

function TerminalGapInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [local, setLocal] = useState(String(value));
  const commit = () => {
    const parsed = Math.max(0, parseInt(local) || 0);
    setLocal(String(parsed));
    onChange(parsed);
  };

  return (
    <div className="flex items-center gap-1 py-0.5 ml-4" {...settingAnchor(GAP_FILTER_SETTINGS.terminalGapThreshold)}>
      <span className="text-[11px] text-gray-500 dark:text-gray-400">Max gap:</span>
      <input
        type="number"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className="w-16 text-xs border rounded px-1 py-0.5 dark:bg-dark-surface dark:border-white/20 dark:text-gray-200"
        min={0}
        step={100}
        title="Reads with terminal gaps larger than this (bp) are filtered out. 0 = no filtering."
      />
      <span className="text-[11px] text-gray-500 dark:text-gray-400">bp</span>
    </div>
  );
}

export function GapReadFilters() {
  const {
    fillSmallGaps, setFillSmallGaps,
    fillGapSize, setFillGapSize,
    hideTerminalGaps, setHideTerminalGaps,
    terminalGapThreshold, setTerminalGapThreshold,
    hideShortEndFootprints, setHideShortEndFootprints,
  } = useBrowserStore(useShallow(s => ({
    fillSmallGaps: s.fillSmallGaps, setFillSmallGaps: s.setFillSmallGaps,
    fillGapSize: s.fillGapSize, setFillGapSize: s.setFillGapSize,
    hideTerminalGaps: s.hideTerminalGaps, setHideTerminalGaps: s.setHideTerminalGaps,
    terminalGapThreshold: s.terminalGapThreshold, setTerminalGapThreshold: s.setTerminalGapThreshold,
    hideShortEndFootprints: s.hideShortEndFootprints, setHideShortEndFootprints: s.setHideShortEndFootprints,
  })));

  return (
    <>
      <label className="flex items-center gap-1.5 text-[13px] cursor-pointer" title="Hide terminal gaps" {...settingAnchor(GAP_FILTER_SETTINGS.hideTerminalGaps)}>
        <input
          type="checkbox"
          checked={hideTerminalGaps}
          onChange={e => setHideTerminalGaps(e.target.checked)}
          className="rounded border-gray-300 dark:border-white/20"
        />
        <span className="text-purple-700">{GAP_FILTER_SETTINGS.hideTerminalGaps.label}</span>
      </label>
      {hideTerminalGaps && (
        <TerminalGapInput value={terminalGapThreshold} onChange={setTerminalGapThreshold} />
      )}
      <label
        className="flex items-center gap-1.5 text-[13px] cursor-pointer"
        {...settingAnchor(GAP_FILTER_SETTINGS.hideShortEndFootprints)}
        title={`A read's first or last footprint that sits at the read end (within ${SHORT_END_FOOTPRINT_MAX_END_GAP_BP} bp of it) is cut off there, so its true size is unknown; on amplicons these stubs pile up at the amplicon ends. Hide the ones under ${SHORT_END_FOOTPRINT_BP} bp from the reads and from FiberBrowser's analyses (footprint sizes, co-occupancy, clustering, read stats). Calls further in are kept. Find classes runs in FiberHMM and is not affected.`}
      >
        <input
          type="checkbox"
          checked={hideShortEndFootprints}
          onChange={e => setHideShortEndFootprints(e.target.checked)}
          className="rounded border-gray-300 dark:border-white/20"
          data-testid="hide-short-end-footprints"
        />
        <span className="text-purple-700">{GAP_FILTER_SETTINGS.hideShortEndFootprints.label}</span>
      </label>

      <div className="flex items-center gap-2" {...settingAnchor(GAP_FILTER_SETTINGS.fillSmallGaps)}>
        <label className="flex items-center gap-1 text-[13px] cursor-pointer">
          <input
            type="checkbox"
            checked={fillSmallGaps}
            onChange={e => setFillSmallGaps(e.target.checked)}
            className="rounded border-gray-300 dark:border-white/20"
          />
          <span className="text-orange-700">{GAP_FILTER_SETTINGS.fillSmallGaps.label}</span>
        </label>
        {fillSmallGaps && (
          <>
            <input
              type="number"
              value={fillGapSize}
              onChange={e => setFillGapSize(Math.max(1, parseInt(e.target.value) || 50))}
              className="input-tool w-14 text-xs"
              min={1}
              max={200}
            />
            <span className="text-xs text-ink-secondary">bp max</span>
          </>
        )}
      </div>
    </>
  );
}
