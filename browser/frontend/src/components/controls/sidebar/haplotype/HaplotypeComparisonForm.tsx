import type { ChromInfo, Dataset } from '../../../../types';
import type { HaplotypePair } from '../../../../utils/haplotypePairs';
import { X } from '../../../ui/Icons';

interface HaplotypeComparisonFormProps {
  chroms: ChromInfo[];
  /** Loaded datasets; with two or more, each view can show its own. */
  datasets?: Array<Pick<Dataset, 'id' | 'label'>>;
  datasets1?: string[];
  datasets2?: string[];
  onDatasets1Change?: (value: string[]) => void;
  onDatasets2Change?: (value: string[]) => void;
  hapPairs: HaplotypePair[];
  chrom1: string;
  chrom2: string;
  region: string;
  resolving: boolean;
  error: string | null;
  onChrom1Change: (value: string) => void;
  onChrom2Change: (value: string) => void;
  onRegionChange: (value: string) => void;
  onErrorClear: () => void;
  onOpen: () => void;
}

export function HaplotypeComparisonForm({
  chroms,
  datasets = [],
  datasets1 = [],
  datasets2 = [],
  onDatasets1Change,
  onDatasets2Change,
  hapPairs,
  chrom1,
  chrom2,
  region,
  resolving,
  error,
  onChrom1Change,
  onChrom2Change,
  onRegionChange,
  onErrorClear,
  onOpen,
}: HaplotypeComparisonFormProps) {
  return (
    <>
      {hapPairs.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[11px] text-gray-500">Detected pairs:</div>
          {hapPairs.map(pair => (
            <button
              key={pair.base}
              onClick={() => {
                onChrom1Change(pair.chrom1);
                onChrom2Change(pair.chrom2);
              }}
              className={`w-full text-left px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                chrom1 === pair.chrom1 && chrom2 === pair.chrom2
                  ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'
              }`}
            >
              {pair.base}: {pair.chrom1} vs {pair.chrom2}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <select
          value={chrom1}
          onChange={e => onChrom1Change(e.target.value)}
          className="flex-1 px-1 py-0.5 border border-gray-300 dark:border-white/20 rounded text-[11px] bg-white dark:bg-[#2c2c2e] text-gray-700 dark:text-gray-300 truncate"
        >
          <option value="">Chrom 1...</option>
          {chroms.map(chrom => (
            <option key={chrom.name} value={chrom.name}>{chrom.name}</option>
          ))}
        </select>
        <span className="text-[11px] text-ink-secondary">vs</span>
        <select
          value={chrom2}
          onChange={e => onChrom2Change(e.target.value)}
          className="flex-1 px-1 py-0.5 border border-gray-300 dark:border-white/20 rounded text-[11px] bg-white dark:bg-[#2c2c2e] text-gray-700 dark:text-gray-300 truncate"
        >
          <option value="">Chrom 2...</option>
          {chroms.map(chrom => (
            <option key={chrom.name} value={chrom.name}>{chrom.name}</option>
          ))}
        </select>
      </div>

      {datasets.length > 1 && onDatasets1Change && onDatasets2Change && (
        <div className="grid grid-cols-2 gap-1.5" data-testid="haplotype-view-datasets">
          {([
            ['View 1 datasets', datasets1, onDatasets1Change],
            ['View 2 datasets', datasets2, onDatasets2Change],
          ] as const).map(([label, selected, onChange]) => (
            <fieldset key={label} className="min-w-0 rounded border border-gray-200 dark:border-white/10 px-1.5 pb-1">
              <legend className="px-0.5 text-[11px] font-semibold text-gray-600 dark:text-gray-300">{label}</legend>
              <div className="max-h-28 space-y-0.5 overflow-y-auto">
                {datasets.map(dataset => (
                  <label key={dataset.id} className="flex min-w-0 items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={selected.includes(dataset.id)}
                      onChange={event => onChange(event.target.checked
                        ? [...selected, dataset.id]
                        : selected.filter(id => id !== dataset.id))}
                    />
                    <span className="truncate" title={dataset.label}>{dataset.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}

      <input
        type="text"
        value={region}
        onChange={e => onRegionChange(e.target.value)}
        placeholder="Gene or region (blank: the current view)"
        aria-label="Gene or region to compare"
        title="Leave blank to compare the coordinates of the current view"
        className="w-full px-1.5 py-0.5 border border-gray-300 dark:border-white/20 rounded text-[11px] bg-white dark:bg-[#2c2c2e] text-gray-700 dark:text-gray-300"
        onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      />

      <button
        onClick={onOpen}
        disabled={resolving || !chrom1 || !chrom2 || (datasets.length > 1 && (datasets1.length === 0 || datasets2.length === 0))}
        // In the Regions panel's colour (it was indigo in a teal panel).
        className="px-2 py-0.5 bg-teal-700 text-white rounded text-[11px] hover:bg-teal-800 disabled:opacity-40"
      >
        {resolving ? 'Resolving...' : 'Compare Haplotypes'}
      </button>

      {error && (
        <div className="text-red-500 text-[11px]">
          {error}
          <button onClick={onErrorClear} className="ml-1 inline-flex align-[-2px] text-gray-500 hover:text-gray-700" aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
    </>
  );
}
