/**
 * "Split into panels" by SNP allele or allele combination: which groups become read panels. The top groups by reads
 * are ticked (4 by default); the dialog says how many panels that opens, asks before opening more than the soft limit
 * (8 by default, adjustable) and refuses more than the hard limit (16). The panels are features' split panels
 * (utils/splitPanels.ts): beside their source, moving with the main view, closing together.
 */
import { useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { openSplitPanels, splitSourcePanels } from '../../utils/splitPanels';
import {
  SPLIT_DEFAULT_TOP, SPLIT_HARD_LIMIT, SPLIT_SOFT_LIMIT, expectedPanels, splitVerdict, variantSplitGrouping, variantSplitRows,
} from './variantSplit';
import type { AlleleGrouping, Snp } from './api';
import { X } from '../../components/ui/Icons';

export function VariantSplitDialog({ grouping, datasetId, title, snps, softLimit = SPLIT_SOFT_LIMIT, onSoftLimit, onClose, onOpened, note }: {
  /** The scan's calls (each SNP's reference allele, kept on the panels' rule). */
  snps?: readonly Snp[];
  /** Said under the description (a combined-SV split: panels stay on the reference). */
  note?: string;
  grouping: AlleleGrouping;
  datasetId: string;
  title: string;
  softLimit?: number;
  onSoftLimit?: (n: number) => void;
  onClose: () => void;
  onOpened?: (panels: number) => void;
}) {
  const datasets = useBrowserStore(s => s.datasets);
  const split = useMemo(() => variantSplitGrouping(grouping, datasetId, title, snps), [grouping, datasetId, title, snps]);
  const [top, setTop] = useState(SPLIT_DEFAULT_TOP);
  const [rows, setRows] = useState(() => variantSplitRows(split, SPLIT_DEFAULT_TOP));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const sources = useMemo(() => splitSourcePanels(split), [split]);
  const count = expectedPanels(rows, sources.length);
  const verdict = splitVerdict(count, softLimit, SPLIT_HARD_LIMIT);
  const combos = split.groups.filter(g => g.kind === 'group').length;

  const setTopN = (n: number) => {
    const next = Math.max(1, Math.min(Math.max(1, combos), Math.floor(n) || 1));
    setTop(next);
    setRows(variantSplitRows(split, next));
    setConfirming(false);
  };
  const open = () => {
    if (verdict.kind === 'none' || verdict.kind === 'refuse') return;
    if (verdict.kind === 'confirm' && !confirming) { setConfirming(true); return; }
    const out = openSplitPanels(split, rows, sources, SPLIT_HARD_LIMIT);
    if ('error' in out) { setError(out.error); return; }
    onOpened?.(count);
    onClose();
  };
  const datasetName = (() => { const d = datasets.find(x => x.id === datasetId); return d ? getDatasetDisplayLabel(d) : datasetId; })();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div role="dialog" aria-modal="true" aria-labelledby="variant-split-title" data-testid="variant-split-dialog"
        className="relative mx-4 max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-gray-800"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 id="variant-split-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">Split into panels by {title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"><X size={14} /></button>
        </div>
        <div className="space-y-3 px-4 py-3 text-[12px] text-gray-700 dark:text-gray-200">
          <p className="text-[11px] text-ink-secondary">
            One read panel per allele group of {datasetName}, at this locus and moving with the main view. The groups keep
            their read names (they are this view’s reads). “Group in this panel” colours one panel’s reads instead.
          </p>
          {note && <p className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="variant-split-note">{note}</p>}
          {sources.length === 0 && <p className="text-[11px] text-red-700 dark:text-red-300">Open a read panel of {datasetName} first.</p>}
          <label className="flex items-center gap-2 text-[11px]">
            Panels for the top
            <input type="number" min={1} max={Math.max(1, combos)} value={top} data-testid="variant-split-top"
              onChange={e => setTopN(Number(e.target.value))}
              className="w-12 rounded border px-1 py-0.5 tabular-nums dark:border-gray-600 dark:bg-gray-900" />
            of {combos} group{combos === 1 ? '' : 's'} by reads; the others go in “Other”.
          </label>
          <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-white/5 dark:border-gray-700" data-testid="variant-split-rows">
            {rows.map((row, i) => (
              <li key={row.key}>
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5" data-testid="variant-split-row" data-kind={row.kind}>
                  <input type="checkbox" checked={row.checked}
                    onChange={e => { setRows(rows.map((r, j) => (j === i ? { ...r, checked: e.target.checked } : r))); setConfirming(false); }} />
                  <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: row.colour }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={row.label}>{row.label}</span>
                  <span className="fb-num-secondary">{row.count.toLocaleString()} reads</span>
                </label>
              </li>
            ))}
          </ul>
          <p data-testid="variant-split-count" data-verdict={verdict.kind}
            className={`text-[11px] ${verdict.kind === 'refuse' ? 'text-red-700 dark:text-red-300' : verdict.kind === 'confirm' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-secondary'}`}>
            {verdict.kind === 'ok' ? `Opens ${verdict.message} The panel they come from folds away until its last split closes.` : verdict.message}
          </p>
          {confirming && verdict.kind === 'confirm' && (
            <p role="alert" data-testid="variant-split-confirm" className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-200">
              Open {count} panels? Click “Open {count} panels” again to go ahead, or tick fewer groups.
            </p>
          )}
          <label className="flex items-center gap-2 text-[11px] text-ink-secondary">
            Ask before opening more than
            <input type="number" min={1} max={SPLIT_HARD_LIMIT} value={softLimit} data-testid="variant-split-soft-limit"
              onChange={e => { onSoftLimit?.(Math.max(1, Math.min(SPLIT_HARD_LIMIT, Math.floor(Number(e.target.value)) || 1))); setConfirming(false); }}
              className="w-12 rounded border px-1 py-0.5 tabular-nums dark:border-gray-600 dark:bg-gray-900" />
            panels (never more than {SPLIT_HARD_LIMIT}).
          </label>
          {error && <p className="text-[11px] text-red-700 dark:text-red-300" data-testid="variant-split-error">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-2.5 dark:border-white/10">
          <button type="button" onClick={onClose} className="rounded px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">Cancel</button>
          <button type="button" onClick={open} disabled={verdict.kind === 'none' || verdict.kind === 'refuse' || sources.length === 0}
            data-testid="variant-split-open"
            className={`rounded px-3 py-1 text-[12px] font-medium text-white disabled:opacity-40 ${confirming ? 'bg-amber-600 hover:bg-amber-700' : 'bg-gray-900 dark:bg-gray-100 dark:text-gray-900'}`}>
            Open {count || ''} panel{count === 1 ? '' : 's'}{verdict.kind === 'confirm' && !confirming ? '…' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
