import { useMemo } from 'react';
import type { Gene, OverlapCondition } from '../../../types';
import { AnalysisButton } from '../shared';
import { Trash } from '../../ui/Icons';

interface OrthogonalTrackInfo {
  index: number;
  label: string;
  renderMode: 'signal' | 'annotation';
  category?: string;
}

interface ConditionEditorProps {
  condition: OverlapCondition;
  onChange: (condition: OverlapCondition) => void;
  onRemove: () => void;
  orthogonalTracks: OrthogonalTrackInfo[];
  genes: Gene[];
}

export function ConditionEditor({
  condition,
  onChange,
  onRemove,
  orthogonalTracks,
  genes,
}: ConditionEditorProps) {
  const selectableGenes = useMemo(
    () => genes
      .filter(g => g.id || g.name)
      .slice()
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [genes]
  );

  return (
    <div className="flex items-center gap-1.5 text-xs flex-wrap">
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={condition.negate ?? false}
          onChange={e => onChange({ ...condition, negate: e.target.checked })}
          className="rounded border-gray-300 dark:border-white/20"
        />
        <span className="text-gray-500">NOT</span>
      </label>
      <select
        value={condition.target}
        onChange={e => {
          const target = e.target.value as OverlapCondition['target'];
          const updates: OverlapCondition = { ...condition, target };
          if (target === 'track' && !condition.trackId && orthogonalTracks.length > 0) {
            updates.trackId = String(orthogonalTracks[0].index);
            updates.trackThreshold = 50;
          }
          onChange(updates);
        }}
        className="input-tool text-xs"
      >
        <option value="gene">In gene</option>
        <option value="peak">In peak</option>
        <option value="track">In track</option>
        <option value="motif">In motif track</option>
        <option value="region">In fixed region</option>
      </select>
      {condition.target === 'peak' && (
        <select
          value={condition.minPeakLayer ?? 3}
          onChange={e => onChange({ ...condition, minPeakLayer: parseInt(e.target.value) })}
          className="input-tool text-xs"
          title="Minimum peak layer (stronger = more confident)"
        >
          <option value={3}>Any</option>
          <option value={0}>Strong+</option>
          <option value={1}>Medium+</option>
          <option value={2}>Weak+</option>
        </select>
      )}
      {condition.target === 'gene' && (
        <select
          value={condition.geneId ?? ''}
          onChange={e => {
            const gene = selectableGenes.find(g => g.id === e.target.value);
            onChange({
              ...condition,
              geneId: gene?.id,
              geneName: gene?.name ?? null,
            });
          }}
          className="input-tool text-xs max-w-[180px]"
          title="Leave as Any gene to match any visible gene, or choose a viewport gene for reproducible gene-specific rules."
        >
          <option value="">Any gene in viewport</option>
          {selectableGenes.map(g => (
            <option key={g.id} value={g.id}>
              {g.name || g.id}{g.name ? ` (${g.id})` : ''}
            </option>
          ))}
        </select>
      )}
      {condition.target === 'track' && (
        <>
          {orthogonalTracks.length === 0 ? (
            <span className="text-gray-400 italic">No tracks loaded</span>
          ) : (
            <>
              <select
                value={condition.trackId ?? ''}
                onChange={e => onChange({ ...condition, trackId: e.target.value })}
                className="input-tool text-xs"
                title="Select loaded track"
              >
                <option value="" disabled>Select track...</option>
                {orthogonalTracks.map(track => (
                  <option key={track.index} value={String(track.index)}>{track.label}</option>
                ))}
              </select>
              <label className="flex items-center gap-1" title="Percentile threshold: footprint overlaps if signal at that position is above this percentile of the track's values in the viewport">
                <span className="text-gray-500">≥</span>
                <input
                  type="number"
                  value={condition.trackThreshold ?? 50}
                  onChange={e => onChange({ ...condition, trackThreshold: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) })}
                  className="input-tool w-12 text-xs"
                  min={0}
                  max={100}
                />
                <span className="text-gray-400">%ile</span>
              </label>
            </>
          )}
        </>
      )}
      {condition.target === 'motif' && (
        <span className="text-[11px] text-ink-secondary italic">
          {orthogonalTracks.filter(track => track.category === 'motif').length > 0
            ? `${orthogonalTracks.filter(track => track.category === 'motif').length} motif track(s)`
            : 'No motif tracks loaded'}
        </span>
      )}
      {condition.target === 'region' && (
        <span
          className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20"
          title="Fixed genomic region condition"
        >
          {condition.regionLabel ||
            (condition.regionChrom && condition.regionStart !== undefined && condition.regionEnd !== undefined
              ? `${condition.regionChrom}:${condition.regionStart}-${condition.regionEnd}`
              : 'fixed region')}
        </span>
      )}
      <button type="button" onClick={onRemove} className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300" title="Remove condition" aria-label="Remove condition"><Trash size={12} aria-hidden="true" /></button>
    </div>
  );
}
