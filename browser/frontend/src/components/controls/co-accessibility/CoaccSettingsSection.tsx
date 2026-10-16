import type {
  CoaccNormalization,
  CoaccScaling,
  CoaccSignalType,
  CoaccTrackMode,
} from '../../../stores/coaccStore';
import type { CoaccMetadata } from '../../../api/coaccessibility';
import {
  AnalysisControlRow,
  AnalysisSelect,
  AnalysisSettingsSection,
  AnalysisToggleGroup,
} from '../shared';

interface CoaccSettingsSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: string;
  signalType: CoaccSignalType;
  setSignalType: (signalType: CoaccSignalType) => void;
  setLayer: (layer: string | null) => void;
  normalization: CoaccNormalization;
  setNormalization: (normalization: CoaccNormalization) => void;
  scaling: CoaccScaling;
  setScaling: (scaling: CoaccScaling) => void;
  colormap: string;
  setColormap: (colormap: string) => void;
  minCoverage: number;
  setMinCoverage: (minCoverage: number) => void;
  binSize: number;
  setBinSize: (binSize: number) => void;
  targetDatasetCount: number;
  displayMode: 'combined' | 'per-dataset';
  setDisplayMode: (displayMode: 'combined' | 'per-dataset') => void;
  coaccTrackMode: CoaccTrackMode;
  toggleCoaccTrackMode: (mode: NonNullable<CoaccTrackMode>) => void;
  metadata: CoaccMetadata | null;
}

function formatBp(bp: number): string {
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(1)}Mb`;
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(1)}kb`;
  return `${bp}bp`;
}

export function CoaccSettingsSection({
  open,
  onOpenChange,
  summary,
  signalType,
  setSignalType,
  setLayer,
  normalization,
  setNormalization,
  scaling,
  setScaling,
  colormap,
  setColormap,
  minCoverage,
  setMinCoverage,
  binSize,
  setBinSize,
  targetDatasetCount,
  displayMode,
  setDisplayMode,
  coaccTrackMode,
  toggleCoaccTrackMode,
  metadata,
}: CoaccSettingsSectionProps) {
  return (
    <AnalysisSettingsSection
      open={open}
      onOpenChange={onOpenChange}
      theme="teal"
      summary={summary}
      tourId="coacc-settings-toggle"
    >
      <div data-tour="coacc-signal">
      <AnalysisSelect
        label="Signal"
        value={signalType}
        onChange={v => {
          setSignalType(v as CoaccSignalType);
          setLayer(null);
        }}
        options={[
          { value: 'accessibility', label: 'Accessibility' },
          { value: 'nucleosome', label: 'Nucleosome' },
          { value: 'small_fp', label: 'Small footprint' },
          { value: 'linker', label: 'Linker' },
          { value: 'all_fp', label: 'All footprints' },
        ]}
      />
      </div>

      <div data-tour="coacc-normalization">
      <AnalysisSelect
        label="Normalization"
        value={normalization}
        onChange={v => setNormalization(v as CoaccNormalization)}
        options={[
          { value: 'raw', label: 'Raw' },
          { value: 'oe', label: 'O/E (marginal)' },
          { value: 'oe_distance', label: 'O/E (distance)' },
          { value: 'correlation', label: 'Correlation' },
        ]}
      />
      </div>

      <AnalysisSelect
        label="Scaling"
        value={scaling}
        onChange={v => setScaling(v as CoaccScaling)}
        options={[
          { value: 'linear', label: 'Linear' },
          { value: 'log', label: 'Log' },
          { value: 'sqrt', label: 'Sqrt' },
        ]}
      />

      <AnalysisSelect
        label="Colormap"
        value={colormap}
        onChange={setColormap}
        options={[
          { value: 'fall', label: 'Fall' },
          { value: 'red', label: 'Red' },
          { value: 'hot', label: 'Hot' },
          { value: 'viridis', label: 'Viridis' },
          { value: 'blues', label: 'Blues' },
        ]}
      />

      <AnalysisControlRow label="Min coverage">
        <div className="flex items-center gap-1" data-tour="coacc-min-coverage">
          <input
            type="range" min={5} max={100} step={5}
            value={minCoverage}
            onChange={e => setMinCoverage(Number(e.target.value))}
            className="w-16 h-3"
          />
          <span className="text-gray-400 w-6 text-right">{minCoverage}</span>
        </div>
      </AnalysisControlRow>

      <AnalysisSelect
        label="Bin size"
        value={binSize}
        onChange={setBinSize}
        options={[
          { value: 0, label: 'Auto' },
          { value: 50, label: '50 bp' },
          { value: 100, label: '100 bp' },
          { value: 200, label: '200 bp' },
          { value: 500, label: '500 bp' },
          { value: 1000, label: '1 kb' },
          { value: 2000, label: '2 kb' },
          { value: 5000, label: '5 kb' },
        ]}
      />

      {targetDatasetCount > 1 && (
        <AnalysisSelect
          label="Display"
          value={displayMode}
          onChange={v => setDisplayMode(v as 'combined' | 'per-dataset')}
          options={[
            { value: 'combined', label: 'Combined' },
            { value: 'per-dataset', label: 'Per dataset' },
          ]}
        />
      )}

      <div className="pt-1 border-t border-teal-200 dark:border-teal-800/30" data-tour="coacc-track-display">
        <div className="text-[11px] font-medium text-ink-secondary mb-1">Track Display</div>
        <AnalysisToggleGroup
          value={coaccTrackMode}
          onChange={mode => {
            if (mode) toggleCoaccTrackMode(mode as NonNullable<CoaccTrackMode>);
            else if (coaccTrackMode) toggleCoaccTrackMode(coaccTrackMode);
          }}
          theme="teal"
          allowDeselect
          options={[
            { value: 'heatmap', label: 'Heatmap Strip' },
            { value: 'arc', label: 'Arcs' },
            { value: 'virtual4c', label: 'Virtual 4C' },
          ]}
        />
      </div>

      {metadata && (
        <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800/50 rounded text-[11px] text-gray-500 space-y-0.5">
          <div>{metadata.n_reads} reads, {metadata.n_bins} bins ({formatBp(metadata.bin_size)})</div>
          <div>Coverage: {metadata.coverage_min}-{metadata.coverage_max} (median {metadata.coverage_median})</div>
          <div>{Math.round(metadata.masked_fraction * 100)}% cells masked (&lt;{minCoverage} reads)</div>
        </div>
      )}
    </AnalysisSettingsSection>
  );
}
