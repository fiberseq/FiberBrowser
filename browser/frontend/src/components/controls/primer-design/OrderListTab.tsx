import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { SavedPrimer } from '../../../types';
import { PRIMER_ORDER_FORMATS, type PrimerOrderFormat } from '../../../utils/primerExport';
import { AnalysisButton, AnalysisStatus, AnalysisToggleGroup } from '../shared';
import { Download, Trash } from '../../ui/Icons';

type CartTrackDisplay = 'off' | 'all' | 'imported' | 'design';

const CART_TRACK_OPTIONS: Array<{ value: CartTrackDisplay; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: "Don't overlay cart primers on the track" },
  { value: 'all', label: 'All', title: 'Show all cart primers (imported + design)' },
  { value: 'imported', label: 'Imported', title: 'Show only imported (BED/TSV) primers' },
  { value: 'design', label: 'Design', title: 'Show only design-derived cart primers' },
];

export function OrderListTab({
  fileInputRef,
  onImportPrimers,
  importMsg,
  setImportMsg,
  savedPrimers,
  cartTrackDisplay,
  setCartTrackDisplay,
  updateSavedPrimerName,
  removeSavedPrimer,
  exportOrderFile,
  exportTsv,
  orderExportFormat,
  setOrderExportFormat,
  includeLoadedInExport,
  setIncludeLoadedInExport,
  exportableForOrder,
  clearSavedPrimers,
}: {
  fileInputRef: RefObject<HTMLInputElement>;
  onImportPrimers: (files: FileList | null) => void;
  importMsg: string | null;
  setImportMsg: Dispatch<SetStateAction<string | null>>;
  savedPrimers: SavedPrimer[];
  cartTrackDisplay: CartTrackDisplay;
  setCartTrackDisplay: (mode: CartTrackDisplay) => void;
  updateSavedPrimerName: (index: number, name: string) => void;
  removeSavedPrimer: (index: number) => void;
  exportOrderFile: () => void;
  exportTsv: () => void;
  orderExportFormat: PrimerOrderFormat;
  setOrderExportFormat: Dispatch<SetStateAction<PrimerOrderFormat>>;
  includeLoadedInExport: boolean;
  setIncludeLoadedInExport: Dispatch<SetStateAction<boolean>>;
  exportableForOrder: SavedPrimer[];
  clearSavedPrimers: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-gray-200 dark:border-white/10">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".bed,.tsv,.txt"
          className="hidden"
          onChange={e => onImportPrimers(e.target.files)}
        />
        <AnalysisButton
          onClick={() => fileInputRef.current?.click()}
          theme="indigo"
          variant="primary"
          title="Load primers from a BED6+ file (paired F/R rows) or a Full TSV previously exported here"
        >
          Load BED / TSV...
        </AnalysisButton>
        <span className="text-[11px] text-gray-500">
          Loaded primers show on track with a distinct color and are excluded from orders
        </span>
      </div>

      {importMsg && (
        <AnalysisStatus kind="info" compact>
          <span className="flex items-center gap-2">
            <span className="flex-1">{importMsg}</span>
            <AnalysisButton onClick={() => setImportMsg(null)} variant="outline" className="px-1 py-0 leading-none" aria-label="Dismiss primer import message">
              x
            </AnalysisButton>
          </span>
        </AnalysisStatus>
      )}

      {savedPrimers.length === 0 ? (
        <AnalysisStatus kind="empty" center>
          No primers saved yet. Design primers and click "+ Order" to add them, or load an existing BED/TSV.
        </AnalysisStatus>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <span>Show on track:</span>
            <AnalysisToggleGroup
              value={cartTrackDisplay}
              onChange={value => { if (value) setCartTrackDisplay(value); }}
              options={CART_TRACK_OPTIONS}
              theme="indigo"
            />
          </div>

          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-white/10">
                <th className="py-1 pr-2">Name</th>
                <th className="py-1 pr-2">Src</th>
                <th className="py-1 pr-2">Fwd Seq</th>
                <th className="py-1 pr-2">Rev Seq</th>
                <th className="py-1 pr-2">Fwd Tm</th>
                <th className="py-1 pr-2">Rev Tm</th>
                <th className="py-1 pr-2">Product</th>
                <th className="py-1 pr-2">Region</th>
                <th className="py-1 w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-white/5">
              {savedPrimers.map((sp, i) => {
                const src = sp.source ?? 'design';
                const srcColor = src === 'design' ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                  : src === 'bed' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
                return (
                  <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                    <td className="py-1 pr-2">
                      <input
                        type="text"
                        className="input-tool w-20 text-[11px]"
                        value={sp.name}
                        onChange={e => updateSavedPrimerName(i, e.target.value)}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <span className={`px-1 py-0 rounded text-[11px] ${srcColor}`} title={sp.loadedFromFile ? `From ${sp.loadedFromFile}` : `Source: ${src}`}>{src}</span>
                    </td>
                    <td className="py-1 pr-2 font-mono text-green-700 dark:text-green-400 max-w-[140px] truncate" title={sp.pair.fwd_seq}>{sp.pair.fwd_seq}</td>
                    <td className="py-1 pr-2 font-mono text-red-600 dark:text-red-400 max-w-[140px] truncate" title={sp.pair.rev_seq}>{sp.pair.rev_seq}</td>
                    <td className="py-1 pr-2">{sp.pair.fwd_tm}C</td>
                    <td className="py-1 pr-2">{sp.pair.rev_tm}C</td>
                    <td className="py-1 pr-2">{sp.pair.product_size?.toLocaleString() ?? '-'}</td>
                    <td className="py-1 pr-2 text-gray-400">{sp.chrom}:{sp.targetStart?.toLocaleString() ?? '?'}-{sp.targetEnd?.toLocaleString() ?? '?'}</td>
                    <td className="py-1">
                      <AnalysisButton
                        onClick={() => removeSavedPrimer(i)}
                        variant="dangerOutline"
                        className="px-1 py-0 leading-none"
                        title="Remove"
                      >
                        <Trash size={10} />
                      </AnalysisButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="flex items-center gap-2 pt-2 border-t border-gray-200 dark:border-white/10">
            <select
              value={orderExportFormat}
              onChange={e => setOrderExportFormat(e.target.value as PrimerOrderFormat)}
              className="input-tool text-[11px]"
              title="Vendor/order export format"
            >
              {PRIMER_ORDER_FORMATS.map(format => (
                <option key={format.value} value={format.value}>{format.label}</option>
              ))}
            </select>
            <AnalysisButton onClick={exportOrderFile} theme="rose" variant="primary" className="flex items-center gap-1">
              <Download size={10} /> Export
            </AnalysisButton>
            <AnalysisButton onClick={exportTsv} variant="neutral" className="flex items-center gap-1">
              <Download size={10} /> Full TSV
            </AnalysisButton>
            <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer" title="Include imported (BED/TSV) primers in the vendor/FASTA export. Full TSV always includes everything.">
              <input
                type="checkbox"
                checked={includeLoadedInExport}
                onChange={e => setIncludeLoadedInExport(e.target.checked)}
                className="w-3 h-3"
              />
              Include loaded
            </label>
            {!includeLoadedInExport && exportableForOrder.length !== savedPrimers.length && (
              <span className="text-[11px] text-ink-secondary">
                ({exportableForOrder.length}/{savedPrimers.length} will be ordered)
              </span>
            )}
            <span className="flex-1" />
            <AnalysisButton onClick={clearSavedPrimers} variant="dangerOutline">
              Clear All
            </AnalysisButton>
          </div>
        </>
      )}
    </div>
  );
}
