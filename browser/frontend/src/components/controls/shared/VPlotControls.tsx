import { AnalysisControlRow, AnalysisSelect } from './AnalysisControls';

type VPlotNormalize = 'per_cluster' | 'shared';

const SIZE_BIN_OPTIONS = [1, 2, 5, 10, 20, 50].map(value => ({
  value,
  label: `${value}bp`,
}));

const POS_BIN_OPTIONS = SIZE_BIN_OPTIONS;

const SIZE_PRESETS = [
  { value: '10-300', label: 'All (10-300)' },
  { value: '10-120', label: 'Small FP (10-120)' },
  { value: '35-80', label: 'TF-size (35-80)' },
  { value: '80-240', label: 'Nuc (80-240)' },
  { value: '10-600', label: 'Wide (10-600)' },
];

const SMOOTH_OPTIONS = [0, 0.5, 1, 1.5, 2, 3].map(value => ({
  value,
  label: value === 0 ? 'Off' : `${value}\u03c3`,
}));

const NORMALIZE_OPTIONS: Array<{ value: VPlotNormalize; label: string }> = [
  { value: 'per_cluster', label: 'Per cluster' },
  { value: 'shared', label: 'Shared' },
];

const DEFAULT_LAYER_OPTIONS = [
  { value: '', label: 'HMM calls (ns/nl)' },
  { value: 'tf', label: 'TF (LLR)' },
  { value: 'fire', label: 'Accessibility' },
  { value: 'nuc', label: 'Nuc layer' },
];

interface VPlotControlsProps {
  sizeBin: number;
  onSizeBinChange: (value: number) => void;
  posBin: number;
  onPosBinChange: (value: number) => void;
  sizeMin: number;
  onSizeMinChange: (value: number) => void;
  sizeMax: number;
  onSizeMaxChange: (value: number) => void;
  log: boolean;
  onLogChange: (value: boolean) => void;
  smooth: number;
  onSmoothChange: (value: number) => void;
  normalize?: VPlotNormalize;
  onNormalizeChange?: (value: VPlotNormalize) => void;
  layer?: string | null;
  onLayerChange?: (value: string | null) => void;
  layerOptions?: Array<{ value: string; label: string }>;
  /** Each size row over its mean across the window (enrichment of that size by position). */
  rowNormalize?: boolean;
  onRowNormalizeChange?: (value: boolean) => void;
  className?: string;
}

export function VPlotControls({
  sizeBin,
  onSizeBinChange,
  posBin,
  onPosBinChange,
  sizeMin,
  onSizeMinChange,
  sizeMax,
  onSizeMaxChange,
  log,
  onLogChange,
  smooth,
  onSmoothChange,
  normalize,
  onNormalizeChange,
  layer,
  onLayerChange,
  layerOptions = DEFAULT_LAYER_OPTIONS,
  rowNormalize,
  onRowNormalizeChange,
  className = '',
}: VPlotControlsProps) {
  const presetValue = `${sizeMin}-${sizeMax}`;
  const presetOptions = SIZE_PRESETS.some(option => option.value === presetValue)
    ? SIZE_PRESETS
    : [...SIZE_PRESETS, { value: 'custom', label: `Custom (${sizeMin}-${sizeMax})` }];

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 ${className}`}>
      <AnalysisSelect
        label="Size bin"
        value={sizeBin}
        onChange={onSizeBinChange}
        options={SIZE_BIN_OPTIONS}
        selectClassName="w-16"
      />
      <AnalysisSelect
        label="Pos bin"
        value={posBin}
        onChange={onPosBinChange}
        options={POS_BIN_OPTIONS}
        selectClassName="w-16"
      />
      <AnalysisSelect
        label="Preset"
        value={presetOptions.some(option => option.value === presetValue) ? presetValue : 'custom'}
        onChange={value => {
          if (value === 'custom') return;
          const [lo, hi] = value.split('-').map(Number);
          onSizeMinChange(lo);
          onSizeMaxChange(hi);
        }}
        options={presetOptions}
        selectClassName="w-28"
        title="Quick size-range presets. Small FP zooms the TF/small-footprint band; Nuc focuses on nucleosomes; Wide extends to 600bp for longer assemblies."
      />
      <AnalysisControlRow label="Range" contentClassName="gap-1">
        <input
          type="number"
          value={sizeMin}
          onChange={e => onSizeMinChange(Number(e.target.value))}
          className="input-tool w-12 text-[11px] py-0.5 min-h-0"
          min={0}
          max={1000}
        />
        <span>-</span>
        <input
          type="number"
          value={sizeMax}
          onChange={e => onSizeMaxChange(Number(e.target.value))}
          className="input-tool w-12 text-[11px] py-0.5 min-h-0"
          min={10}
          max={2000}
        />
        <span>bp</span>
      </AnalysisControlRow>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={log}
          onChange={e => onLogChange(e.target.checked)}
          className="w-3 h-3 accent-emerald-500"
        />
        Log
      </label>
      {rowNormalize !== undefined && onRowNormalizeChange && (
        <label
          className="flex items-center gap-1 cursor-help"
          title="Divide each size row by its average across the window: 1 = as common here as this footprint size is anywhere in the window, 2 = twice as common. Shows where each size is enriched, so rare sizes are as visible as common ones. Sizes seen fewer than 20 times in the window are left blank."
        >
          <input
            type="checkbox"
            checked={rowNormalize}
            onChange={e => onRowNormalizeChange(e.target.checked)}
            className="w-3 h-3 accent-emerald-500"
            data-testid="vplot-row-normalize"
          />
          Per size row
        </label>
      )}
      <AnalysisSelect
        label="Smooth"
        value={smooth}
        onChange={onSmoothChange}
        options={SMOOTH_OPTIONS}
        selectClassName="w-16"
      />
      {normalize !== undefined && onNormalizeChange && (
        <AnalysisSelect
          label="Norm"
          value={normalize}
          onChange={onNormalizeChange}
          options={NORMALIZE_OPTIONS}
          selectClassName="w-24"
          className="cursor-help"
          title="Per cluster normalizes each heatmap to its own max; shared uses one global max across clusters."
        />
      )}
      {onLayerChange && (
        <AnalysisSelect
          label="Layer"
          value={layer ?? ''}
          onChange={value => onLayerChange(value || null)}
          options={layerOptions}
          selectClassName="w-28"
          title="Source layer. HMM calls use the full ns/nl call set; TF restricts to recalled TF calls when available."
        />
      )}
    </div>
  );
}

export type { VPlotNormalize };
