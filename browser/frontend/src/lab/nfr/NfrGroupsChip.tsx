/**
 * Accessibility (preview): the legend in a read panel's header while the panel holds read groups the NFR panel put
 * there (a pair, combination patterns, or an NFR's configurations): a chip naming the grouping that opens the groups'
 * colours, names and counts, with "Restore previous grouping".
 */
import { useEffect, useRef, useState } from 'react';
import { useAccessibilityStore, type AppliedNfrGroups } from './accessibilityStore';
import { useBrowserStore } from '../../stores/browserStore';
import { groupingIsCurrent, groupingIsCurrentOn, restoreReadGroups } from '../../utils/readGroups';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import type { PanelHeaderAddition, PanelHeaderContext } from '../../components/tracks/panelHeaderExtensions';

/** The groups of an applied NFR grouping, as legend rows. */
export function legendRows(a: AppliedNfrGroups): { id: number; label: string; n: number }[] {
  if (a.configurations) return a.configurations.groups.map(g => ({ id: g.id, label: g.display_label || g.label, n: g.count }));
  return (a.split?.groups ?? []).map(g => ({ id: g.id, label: g.label, n: g.molecules }));
}

export function NfrGroupsChip({ applied }: { applied: AppliedNfrGroups }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Restore puts back what the whole grouping replaced: only while every panel it wrote still holds it (a panel
  // regrouped since would otherwise lose its newer groups).
  const whole = groupingIsCurrent(applied.grouping);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const rows = legendRows(applied);
  const restore = () => {
    restoreReadGroups(applied.grouping, 'Restore previous grouping');
    useAccessibilityStore.getState().dismissApplied(applied);
    setOpen(false);
  };
  return (
    <span ref={box} className="relative inline-flex flex-shrink-0">
      <button type="button" ref={trigger} data-testid="nfr-groups-chip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(v => !v)}
        title={`${applied.grouping.label}: the groups' colours`}
        className="inline-flex max-w-[14rem] items-center gap-1 truncate rounded-full border border-fuchsia-300 bg-fuchsia-50 px-1.5 text-[10px] font-medium leading-4 text-fuchsia-800 dark:border-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-200">
        <span className="flex gap-px" aria-hidden="true">
          {rows.slice(0, 5).map(r => <span key={r.id} className="inline-block h-2 w-1.5 rounded-sm" style={{ background: getClusterColor(r.id) }} />)}
        </span>
        <span className="truncate">{applied.grouping.label.replace(/^Group reads by /, '')}</span>
      </button>
      {open && (
        <span role="dialog" aria-label="Read groups" data-testid="nfr-groups-legend"
          className="absolute left-0 top-full z-50 mt-1 block w-64 rounded-md border border-gray-200 bg-white p-2 text-[11px] text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
          <span className="mb-1 block font-medium">{applied.grouping.label}</span>
          <span className="block space-y-0.5">
            {rows.map(r => (
              <span key={r.id} className="flex items-center gap-1.5 tabular-nums">
                <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: getClusterColor(r.id) }} />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="text-ink-muted">{r.n.toLocaleString()}</span>
              </span>
            ))}
          </span>
          {whole ? (
            <button type="button" onClick={restore} data-testid="nfr-groups-chip-restore"
              className="mt-1.5 rounded px-1.5 py-0.5 text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-white/5">Restore previous grouping</button>
          ) : (
            <span className="mt-1.5 block text-ink-muted" data-testid="nfr-groups-chip-partial">Another panel was regrouped since: undo (or the NFR panel) takes these groups back.</span>
          )}
        </span>
      )}
    </span>
  );
}

/** The header extension: the chip on a read panel that holds the newest current NFR grouping. */
export function useNfrGroupsHeader({ panel }: PanelHeaderContext): PanelHeaderAddition | null {
  const applied = useAccessibilityStore(s => s.applied);
  // re-evaluated as the panels' groups change (undo, a new clustering)
  useBrowserStore(s => s.clusterAssignments);
  const key = panel.stateKey ?? panel.datasetId ?? null;
  if (!key || panel.contentType !== 'dataset') return null;
  const current = [...applied].reverse().find(a => groupingIsCurrentOn(a.grouping, key));
  if (!current) return null;
  return { chipTexts: [current.grouping.label.replace(/^Group reads by /, '')], chips: <NfrGroupsChip applied={current} /> };
}
