import { useContext } from 'react';
import { PanelDisplayContext, panelReversed } from './usePanelDisplayStore';
import { useBrowserStore } from '../stores/browserStore';
import { panelGenomeChroms } from '../stores/panelGenomeStore';
import { findChromInfo } from '../utils/chromAliases';
import { useWheelZoom } from './useWheelZoom';

interface Options {
  chrom: string; start: number; end: number; width: number; sidebarWidth?: number;
  isReversed?: boolean; genome?: string; panelId?: string | null;
  onViewportChange?: (start: number, end: number) => void;
  anchorAt?: (x: number) => number;
}

export function useLinearWheelZoom(options: Options) {
  const contextId = useContext(PanelDisplayContext);
  const { chrom, start, end, width, sidebarWidth = 0, genome, onViewportChange, anchorAt } = options;
  const panelId = options.panelId ?? contextId;
  const restoreTime = useBrowserStore(s => s._lastRestoreTime);
  const navigationMode = useBrowserStore(s => s.navigationMode);
  const reversed = options.isReversed ?? panelReversed(useBrowserStore.getState(), panelId);
  return useWheelZoom(`${panelId}:${chrom}:${start}:${end}:${reversed}:${restoreTime}:${genome}:${navigationMode}`, (x, factor) => {
    const fraction = Math.max(0, Math.min(1, (x - sidebarWidth) / Math.max(1, width - sidebarWidth)));
    const f = reversed ? 1 - fraction : fraction;
    const anchor = anchorAt?.(x) ?? start + f * (end - start);
    const s = useBrowserStore.getState();
    const info = findChromInfo(panelGenomeChroms(genome, s.chroms), chrom);
    const size = Math.max(3, Math.min(info?.size ?? 1e9, (end - start) * factor));
    let left = anchor - f * size;
    if (!info?.circular) left = Math.max(0, Math.min(info ? info.size - size : Infinity, left));
    const nextStart = Math.round(left), nextEnd = nextStart + Math.round(size);
    if (nextStart === start && nextEnd === end) return;
    if (onViewportChange) onViewportChange(nextStart, nextEnd);
    else if (panelId && s.panels.find(p => p.id === panelId)?.viewportOverride) s.setPanelViewport(panelId, nextStart, nextEnd);
    else s.setViewport(chrom, nextStart, nextEnd);
  }, { panelId, left: sidebarWidth, dataWidth: width - sidebarWidth });
}
