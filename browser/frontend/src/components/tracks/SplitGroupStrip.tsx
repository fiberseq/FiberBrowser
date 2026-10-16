import { matchedGroupLabel } from '../../utils/matchedGroupActions';
import { closeRegionPanels } from '../../utils/regionPanels';
/**
 * Header strips over split sets (usability audit SV-7): with two split sets open side by side, each set's columns get
 * a strip saying which split they are ("Split: INS 9.2 kb · 2 panels") with × to close that set.
 */
import type { PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { closeSplitPanels } from '../../utils/splitPanels';
import { splitGroupLabel } from '../../utils/splitGroupLabels';
import { X } from '../ui/Icons';

/** Room for a 24-px close target (usability round 2, N22). */
export const SPLIT_STRIP_HEIGHT = 28;

export interface StripSegment { key: string; groupId: string; left: number; width: number; panels: PanelConfig[]; colour: string }

/**
 * One segment per run of neighbouring columns of one split set (a column belongs to a set when all its panels do):
 * a set whose columns were dragged apart gets a strip over each run, never one spanning another set's columns.
 */
export function splitStripSegments(columns: Array<{ panels: PanelConfig[] }>, widths: number[], inFlow: boolean[], gap: number): StripSegment[] {
  const out: StripSegment[] = [];
  let x = gap;
  let last: StripSegment | null = null;
  columns.forEach((col, i) => {
    if (!inFlow[i]) return;
    const w = widths[i];
    const groups = new Set(col.panels.map(p => p.regionPanelGroup?.id ?? p.readSubset?.groupId ?? null));
    const groupId = groups.size === 1 ? [...groups][0] : null;
    if (groupId && last && last.groupId === groupId) {
      last.width = x + w - last.left;
      last.panels.push(...col.panels);
    } else if (groupId) {
      last = { key: `${groupId}:${out.length}`, groupId, left: x, width: w, panels: [...col.panels], colour: col.panels[0].regionPanelGroup?.color ?? col.panels[0].readSubset?.colour ?? '#64748b' };
      out.push(last);
    } else {
      last = null;
    }
    x += w + gap;
  });
  return out;
}

/** What closing a split does to the panel it came from: shown again, or kept folded for another split from it (R16). */
export function closeSplitOutcome(panels: PanelConfig[], groupId: string): string {
  const source = panels.find(p => p.readSubset?.groupId === groupId)?.readSubset?.sourcePanelId;
  const other = source ? panels.find(p => p.readSubset?.sourcePanelId === source && p.readSubset.groupId !== groupId) : undefined;
  return other ? 'the panel it came from stays folded while another split from it is open' : 'the panel it came from shows again';
}

export function SplitGroupStrip({ segments, width }: { segments: StripSegment[]; width?: number }) {
  const panels = useBrowserStore(s => s.panels);
  const rules = useBrowserStore(s => s.peakRules);
  const regions = useBrowserStore(s => s.peaksByRule);
  return (
    <div className="relative shrink-0" style={{ height: SPLIT_STRIP_HEIGHT, width }} data-testid="split-group-strips">
      {segments.map(seg => {
        const region = seg.panels[0].regionPanelGroup;
        const rule = region ? rules.find(r => r.id === region.id) : undefined;
        const label = rule ? matchedGroupLabel(rule, rules) : region?.label ?? splitGroupLabel(seg.groupId, seg.panels);
        const n = seg.panels.length;
        return (
          <div key={seg.key} data-testid="split-group-strip" data-group-id={seg.groupId}
            className="absolute top-[3px] flex h-[25px] items-center gap-1 overflow-hidden rounded-t-fb border-x border-t border-line bg-surface-sunken pl-2 pr-0.5 text-[11px] text-ink dark:border-white/10 dark:text-gray-100"
            style={{ left: seg.left, width: seg.width, boxShadow: `inset 0 2px 0 ${seg.colour}` }}
            title={region ? `${label} · ${n} regions` : `Split: ${label} · ${n} panel${n === 1 ? '' : 's'}`}>
            {!region && <span className="font-semibold">Split:</span>}
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 text-ink-secondary">· {n} {region ? 'regions' : `panel${n === 1 ? '' : 's'}`}</span>
            {rules.some(r => r.matchGroup?.origin === 'sv' && regions[r.id]?.some(m => seg.panels.some(p => p.id === m.match?.panelId))) && <span data-testid="split-flanks-matched" className="shrink-0 text-ink-secondary">· flanks matched</span>}
            {/* The whole set's ×, 24 px, and said apart from each panel's own × ("Close this panel"). */}
            <button type="button" onClick={() => { if (region) closeRegionPanels(seg.groupId); else void closeSplitPanels(seg.groupId); }} aria-label={`Close ${region ? 'group panels' : 'split'} (${n} panel${n === 1 ? '' : 's'}): ${label}`}
              data-testid="split-group-strip-close" title={region ? "Close group panels and restore the previous layout" : `Close split (${n} panel${n === 1 ? '' : 's'}): ${closeSplitOutcome(panels, seg.groupId)}`}
              className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10">
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
