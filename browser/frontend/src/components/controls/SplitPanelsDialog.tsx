/**
 * "Split into panels": which groups become panels (stores/splitPanelStore.ts pending; utils/splitPanels.ts).
 * The top groups by reads are ticked (4 by default), then the bins: the other groups, closed / none, not informative.
 */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import {
  DEFAULT_SPLIT_TOP, MAX_SPLIT_PANELS, loadSplitGrouping, openSplitPanels, splitPanelCount, splitRows, splitSourcePanels,
  type SplitGrouping, type SplitRow,
} from '../../utils/splitPanels';
import { X } from '../ui/Icons';
import { splitOpened, splitRowNote } from '../../utils/panelExtensions';
import { formatShare } from '../../utils/denominators';
import type { SvSplitDef } from '../../stores/svSlice';

export function SvSplitCounts({ def }: { def: SvSplitDef }) {
  const evidence = def.evidenceCounts;
  return <p className="text-[11px] text-ink-secondary" data-testid="split-panels-sv-counts"
    title="All molecules in view; confirmed plus reference are informative, with weaker evidence counted separately">
    {evidence ? <>
      Confirmed: {formatShare(evidence.confirmed, evidence.confirmed + def.counts[1], 'informative reads', { pct: true })}
      {' · '}{evidence.putative.toLocaleString()} putative · {evidence.ambiguous.toLocaleString()} ambiguous
    </> : <>Carriers: {formatShare(def.counts[0], def.counts[0] + def.counts[1], 'informative reads', { pct: true })}</>}
    {' '}(all {(def.counts[0] + def.counts[1] + def.counts[2]).toLocaleString()} reads in view; the SV row counts loaded reads only).
  </p>;
}

export function SplitPanelsDialogHost() {
  const pending = useSplitPanelStore(s => s.pending);
  if (!pending) return null;
  return <SplitPanelsDialog key={JSON.stringify(pending.source, (k, v) => (k === 'result' ? undefined : v))} />;
}

function SplitPanelsDialog() {
  const { pending, cancel } = useSplitPanelStore(useShallow(s => ({ pending: s.pending, cancel: s.cancel })));
  const datasets = useBrowserStore(s => s.datasets);
  const [grouping, setGrouping] = useState<SplitGrouping | null>(null);
  const [error, setError] = useState('');
  const [top, setTop] = useState(DEFAULT_SPLIT_TOP);
  const [rows, setRows] = useState<SplitRow[]>([]);

  useEffect(() => {
    if (!pending) return;
    let live = true;
    loadSplitGrouping(pending.source)
      .then(g => { if (live) { setGrouping(g); setRows(splitRows(g, DEFAULT_SPLIT_TOP)); } })
      .catch(e => { if (live) setError(String((e as Error).message ?? e)); });
    return () => { live = false; };
  }, [pending]);

  const sources = useMemo(() => (grouping ? splitSourcePanels(grouping, pending?.panelIds) : []), [grouping, pending]);
  const count = splitPanelCount(rows, sources);
  const tooMany = count > MAX_SPLIT_PANELS;
  const setTopN = (n: number) => {
    const next = Math.max(1, Math.min(MAX_SPLIT_PANELS, n));
    setTop(next);
    if (grouping) setRows(splitRows(grouping, next));
  };
  const apply = () => {
    if (!grouping) return;
    const out = openSplitPanels(grouping, rows, sources);
    if ('error' in out) { setError(out.error); return; }
    // Plugin packs' steps after a split opened (an insertion's SV allele split: the Carriers panel shows the insert
    // expanded, its header toggles back).
    if (pending) void splitOpened(out.groupId, pending.source as { kind: string; panelId?: string });
    cancel();
  };
  const what = grouping?.title || (pending?.source.kind === 'frozen' ? pending.source.title : 'the selected features');
  // An SV split (the panel's allele groups): its counts are of every read in view, the SV row's of the loaded ones (SV-3).
  const svDef = useBrowserStore(s => {
    const src = pending?.source;
    if (src?.kind !== 'frozen') return undefined;
    const panel = s.panels.find(p => p.id === src.panelId);
    return panel ? s.svSplits[panel.stateKey ?? panel.datasetId ?? panel.id] : undefined;
  });
  const source = pending?.source as { kind: string; panelId?: string } | undefined;
  // What a pack does to a row's panel (an insertion's Carriers open expanded, on their own contig: SV-2).
  const notes = source ? rows.map(r => ({ row: r, note: r.checked ? splitRowNote(source, r) : null })).filter(x => x.note) : [];
  const datasetNames = sources.map(p => { const d = datasets.find(x => x.id === p.datasetId); return d ? getDatasetDisplayLabel(d) : p.datasetId; }).join(', ');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={cancel}>
      <div className="absolute inset-0 bg-black/40" />
      <div role="dialog" aria-modal="true" aria-labelledby="split-panels-title" data-testid="split-panels-dialog"
        className="relative mx-4 max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-gray-800"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 id="split-panels-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">Split into panels{what ? ` by ${what}` : ''}</h2>
          <button type="button" onClick={cancel} aria-label="Close" className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"><X size={14} /></button>
        </div>
        <div className="space-y-3 px-4 py-3 text-[12px] text-gray-700 dark:text-gray-200">
          <p className="text-[11px] text-ink-secondary" data-testid="split-panels-intro">
            One read panel per group{datasetNames ? ` of ${datasetNames}` : ''}, side by side at this locus. Each read goes to one group, so the counts can differ from per-variant percentages.
            {pending?.source.kind === 'frozen' && <span className="font-medium text-gray-600 dark:text-gray-300" data-testid="split-panels-preview-note"> Preview shown behind.</span>}
          </p>
          {!grouping && !error && <p data-testid="split-panels-loading">Finding the groups…</p>}
          {grouping && (
            <>
              <label className="flex items-center gap-2 text-[11px]">
                Panels for the top
                <input type="number" min={1} max={MAX_SPLIT_PANELS} value={top} data-testid="split-panels-top"
                  onChange={e => setTopN(Number(e.target.value) || 1)} className="w-12 rounded border px-1 py-0.5 tabular-nums dark:border-gray-600 dark:bg-gray-900" />
                groups by reads; the others go in “Other”.
              </label>
              <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-white/5 dark:border-gray-700" data-testid="split-panels-rows">
                {rows.map((row, i) => (
                  <li key={row.key}>
                    <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5" data-testid="split-panels-row" data-kind={row.kind} data-count={row.count}>
                      <input type="checkbox" checked={row.checked} onChange={e => setRows(rows.map((r, j) => (j === i ? { ...r, checked: e.target.checked } : r)))} />
                      <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: row.colour }} />
                      <span className="min-w-0 flex-1 truncate" title={row.groupKeys.length > 1 ? row.groupKeys.join(', ') : undefined}>{row.label}</span>
                      <span className="fb-num-secondary">{row.count.toLocaleString()} reads</span>
                    </label>
                    {row.groupKeys.length > 1 && grouping && (
                      <details className="px-2 pb-1.5 pl-8 text-[11px] text-gray-600 dark:text-gray-300" data-testid="split-panels-row-members">
                        <summary className="cursor-pointer">What is in it ({row.groupKeys.length} groups)</summary>
                        <p className="mt-0.5 text-gray-500 dark:text-gray-400">
                          {row.kind === 'other'
                            ? 'Each read goes to the one group it most likely belongs to; the groups after the top ones by reads (and any “other” group) share this panel. Raise the top number to give one its own panel.'
                            : 'Each read goes to the one group it most likely belongs to; these groups share this panel.'}
                        </p>
                        <ul className="mt-0.5 space-y-px tabular-nums">
                          {grouping.groups.filter(g => row.groupKeys.includes(g.key)).map(g => (
                            <li key={g.key} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{g.label}</span><span>{g.count.toLocaleString()} reads</span></li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
              {svDef && <SvSplitCounts def={svDef} />}
              {notes.map(({ row, note }) => (
                <p key={row.key} className="text-[11px] font-medium text-violet-700 dark:text-violet-300" data-testid="split-panels-row-note">
                  {row.label}: {note}
                </p>
              ))}
              <p className={`text-[11px] ${tooMany ? 'text-red-700 dark:text-red-300' : 'text-ink-secondary'}`} data-testid="split-panels-count">
                {tooMany
                  ? `${count} panels: at most ${MAX_SPLIT_PANELS} at a time. Untick some, or lower the top number (they go in “Other”).`
                  : `${count} panel${count === 1 ? '' : 's'}${sources.length > 1 ? ` (${sources.length} datasets)` : ''}. The panel they come from folds away until its last split closes.`}
              </p>
            </>
          )}
          {error && <p className="text-[11px] text-red-700 dark:text-red-300" data-testid="split-panels-error">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-2.5 dark:border-white/10">
          <button type="button" onClick={cancel} className="rounded px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
          <button type="button" onClick={apply} disabled={!grouping || tooMany || count === 0} data-testid="split-panels-open"
            className="rounded bg-gray-900 px-3 py-1 text-[12px] font-medium text-white disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900">
            Open {count || ''} panel{count === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
