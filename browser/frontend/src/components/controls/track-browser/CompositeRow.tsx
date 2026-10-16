import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { exportTrack, exportTracksMulti } from '../../../api/tracks';
import { metaprofileExportColumns } from '../../../utils/metaprofileExport';
import type {
  AnnotationScoreScale,
  AnnotationStrandMode,
  AnnotationTrackStyle,
  CompositeTrack,
  TrackSource,
  SourceRef,
  CatalogEntry,
} from '../../../types/dataset';
import { TRACK_COLORS } from '../../tracks/TrackContainerConstants';
import { getLayerColor, getLayerLabel, getMetaprofileSourceEntries } from '../../../utils/layerColors';
import { AnalysisButton } from '../shared';
import { catalogRefKind, unloadCompositeSource, unloadCompositeTrack } from '../../../utils/trackLoader';
import { AddTrackBox } from './AddTrackBox';
import { Check, Eye, EyeOff } from '../../ui/Icons';
import { DisclosureChevron } from '../../ui/Disclosure';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DEFAULT_ANNOTATION_STYLE: Required<AnnotationTrackStyle> = {
  scoreMin: 0,
  scoreMax: 1,
  scoreScale: 'linear',
  strandMode: 'split',
  showScoreLegend: true,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function percentValue(value: number | undefined, fallback: number): number {
  return Math.round(clamp01(value ?? fallback) * 100);
}

function isMotifComposite(composite: CompositeTrack, catalog: CatalogEntry[]): boolean {
  if (composite.kind !== 'annotation') return false;
  return composite.sources.some(source => {
    const ref = source.ref;
    if (ref.kind === 'metaprofile') return false;
    const entry = catalog.find(candidate => candidate.id === ref.catalogEntryId);
    return entry?.kind === 'motif' || entry?.meta?.format === 'custom_motif';
  });
}

function AddSourcePicker({
  composite, onPick, onClose,
}: {
  composite: CompositeTrack;
  onPick: (ref: SourceRef) => void;
  onClose: () => void;
}) {
  const datasets = useBrowserStore(useShallow(s => s.datasets));
  const activeColormap = useBrowserStore(s => s.activeColormap) as {
    rules?: Array<{ id: string; name: string; color: string }>;
  };

  const acceptCatalog = composite.kind !== 'metaprofile';
  const acceptMeta = composite.kind === 'metaprofile' || composite.kind === 'signal';
  const fits = (kind: CatalogEntry['kind']) => (composite.kind === 'annotation'
    ? kind === 'bigbed' || kind === 'motif'
    : kind === 'bigwig' || kind === 'bigbed' || kind === 'motif');
  const layerOptions = acceptMeta
    ? getMetaprofileSourceEntries(datasets).map(entry => ({
        id: entry.key,
        name: entry.label,
        color: getLayerColor(entry.key),
        title: entry.title,
      }))
    : [];
  const layerOptionIds = new Set(layerOptions.map(option => option.id));
  const ruleOptions = acceptMeta
    ? [
        ...layerOptions,
        ...(activeColormap?.rules ?? [])
          .filter(rule => !layerOptionIds.has(rule.id) && rule.id !== 'subnuc')
          .map(rule => ({ id: rule.id, name: rule.name, color: rule.color, title: 'Color-rule metaprofile' })),
      ]
    : [];

  return (
    <div className="border border-gray-300 dark:border-white/20 rounded p-2 mt-1 bg-gray-50 dark:bg-white/5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Add source</span>
        <AnalysisButton
          onClick={onClose}
          variant="outline"
          className="px-1 py-0 leading-none"
          aria-label="Close source picker"
        >
          ×
        </AnalysisButton>
      </div>
      {acceptCatalog && (
        // Same search as the main Add box: recent sources, JASPAR, UCSC, a path
        // or URL, a motif sequence; results are added to this track.
        <AddTrackBox
          target={{
            accepts: fits,
            onAdded: ids => {
              const entries = useBrowserStore.getState().catalog;
              for (const id of ids) {
                const entry = entries.find(e => e.id === id);
                if (entry) onPick({ kind: catalogRefKind(entry), catalogEntryId: id });
              }
            },
          }}
        />
      )}
      {ruleOptions.length > 0 && (
        <div>
          <div className="text-[11px] text-gray-500 mb-1">Metaprofile sources</div>
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {ruleOptions.map(r => (
              <button
                key={r.id}
                onClick={() => onPick({ kind: 'metaprofile', ruleId: r.id })}
                className="w-full text-left text-xs px-2 py-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 flex items-center gap-2"
                title={r.title}
              >
                <span className="w-3 h-3 rounded" style={{ backgroundColor: r.color }} />
                <span className="truncate">{r.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!acceptCatalog && ruleOptions.length === 0 && (
        <div className="text-xs text-gray-400 px-2 py-2">
          No compatible sources available. Load a track or define rules first.
        </div>
      )}
    </div>
  );
}

function SourceRow({ composite, source }: { composite: CompositeTrack; source: TrackSource }) {
  const updateSource = useBrowserStore(s => s.updateSource);
  const catalog = useBrowserStore(useShallow(s => s.catalog));
  const cachedLayerTypes = useBrowserStore(useShallow(s => s.cachedLayerTypes));

  let label = '(missing)';
  let unavailable = false;
  const ref = source.ref;
  if (ref.kind === 'metaprofile') {
    label = getLayerLabel(ref.ruleId === 'mod' ? 'm6a' : ref.ruleId);
  } else {
    const e = catalog.find(c => c.id === ref.catalogEntryId);
    if (e) {
      label = e.label;
      unavailable = !!e.unavailable;
    } else {
      unavailable = true;
    }
  }

  const isMeta = ref.kind === 'metaprofile';
  const cacheKey = isMeta ? (ref.ruleId === 'mod' ? 'm6a' : ref.ruleId) : '';
  const cacheManaged = isMeta && ['fire', 'deam', 'm6a', 'm5c'].includes(cacheKey);
  const cacheEnabled = cacheManaged ? (cachedLayerTypes[cacheKey] ?? true) : false;
  const lazyTitle = cacheManaged
    ? cacheEnabled
      ? 'This layer is cached with read windows by default. Disable it in Settings > Read Display > Layer Cache if needed.'
      : 'This layer is not prefetched. Turning it on requests extra read payloads on the next refresh.'
    : undefined;

  return (
    <div className="flex items-center gap-1.5 py-1 px-1 text-xs rounded hover:bg-gray-100 dark:hover:bg-white/5">
      <input
        type="color"
        value={source.color}
        onChange={e => updateSource(composite.id, source.id, { color: e.target.value })}
        className="w-5 h-5 rounded cursor-pointer flex-shrink-0 border-0 p-0 bg-transparent"
        title="Color"
      />
      <AnalysisButton
        onClick={() => updateSource(composite.id, source.id, { visible: !source.visible })}
        theme="blue"
        variant="outline"
        className="px-1 py-0 text-base leading-none flex-shrink-0"
        title={lazyTitle ?? (source.visible ? 'Hide curve' : 'Show curve')}
        aria-label={source.visible ? 'Hide curve' : 'Show curve'}
        aria-pressed={source.visible}
      >
        {source.visible ? <Eye size={12} /> : <EyeOff size={12} />}
      </AnalysisButton>
      <span className={`flex-1 min-w-0 truncate ${unavailable ? 'text-red-500' : ''}`}>
        {label}
        {unavailable && <span className="ml-1 text-[11px] text-red-400">(unavail)</span>}
        {cacheManaged && (
          <span className={`ml-1 text-[11px] ${cacheEnabled ? 'text-slate-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {cacheEnabled ? '(cached)' : '(on-demand)'}
          </span>
        )}
      </span>
      {!isMeta && (
        <label className="flex items-center gap-1 text-xs text-gray-500" title="Sign-flip the curve (e.g. minus-strand PRO-seq)">
          <input
            type="checkbox"
            checked={source.negate}
            onChange={e => updateSource(composite.id, source.id, { negate: e.target.checked })}
            className="w-3.5 h-3.5"
          />
          neg
        </label>
      )}
      <input
        type="number"
        step="0.1"
        value={source.scale}
        onChange={e => updateSource(composite.id, source.id, { scale: parseFloat(e.target.value) || 1 })}
        className="w-14 text-xs px-1 py-0.5 rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30"
        title="Scale (multiplier)"
      />
      <AnalysisButton
        onClick={() => { void unloadCompositeSource(composite.id, source); }}
        variant="dangerOutline"
        className="px-1 py-0 text-base leading-none"
        title="Remove source and unload it if no other track uses it"
      >
        ×
      </AnalysisButton>
    </div>
  );
}

export function CompositeRow({
  composite, expanded, onToggleExpand,
}: {
  composite: CompositeTrack;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const updateComposite = useBrowserStore(s => s.updateComposite);
  const addSourceTo = useBrowserStore(s => s.addSourceTo);
  const saveCompositeAsTrack = useBrowserStore(s => s.saveCompositeAsTrack);
  const catalog = useBrowserStore(useShallow(s => s.catalog));
  const [showPicker, setShowPicker] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState(composite.label || 'Saved track');

  const openSavePreset = useCallback(() => {
    setPresetName(composite.label || 'Saved track');
    setSavePresetOpen(true);
  }, [composite.label]);

  const handleSavePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    saveCompositeAsTrack(composite.id, name);
    setSavedFlash(true);
    setSavePresetOpen(false);
    setTimeout(() => setSavedFlash(false), 1500);
  }, [composite.id, presetName, saveCompositeAsTrack]);

  const swatches = composite.sources.slice(0, 3).map(s => s.color);
  const summary =
    composite.scaleMode === 'manual'
      ? `manual ${composite.yMin ?? '?'}–${composite.yMax ?? '?'}`
      : composite.scaleMode === 'group'
      ? `group${composite.scaleGroup ? `:${composite.scaleGroup}` : ''}`
      : composite.scaleMode === 'per-source'
      ? 'per-source'
      : 'auto';
  const motifAnnotation = isMotifComposite(composite, catalog);
  const motifStyle: Required<AnnotationTrackStyle> = {
    ...DEFAULT_ANNOTATION_STYLE,
    ...(composite.annotationStyle ?? {}),
  };
  const updateAnnotationStyle = (patch: AnnotationTrackStyle) => {
    updateComposite(composite.id, {
      annotationStyle: {
        ...motifStyle,
        ...patch,
      },
    });
  };

  const handleExport = useCallback(async () => {
    const state = useBrowserStore.getState();
    const { chrom, start, end } = state;
    if (!chrom || end <= start) return;
    setExporting(true);
    try {
      if (composite.kind === 'metaprofile') {
        const cols: number[][] = [];
        const labels: string[] = [];
        // Each panel showing the main view draws its own profile, stored under
        // its state key: export one column per (panel, source), as displayed.
        const columns = metaprofileExportColumns(state, composite.sources);
        for (const column of columns) {
          cols.push(column.values);
          labels.push(column.label);
        }
        const nBins = Math.max(...cols.map(c => c.length), 0);
        const binSize = (end - start) / Math.max(nBins, 1);
        const rows = ['chrom\tstart\tend\t' + labels.join('\t')];
        for (let i = 0; i < nBins; i++) {
          const bs = Math.round(start + i * binSize);
          const be = Math.round(start + (i + 1) * binSize);
          const cells = cols.map(c => String(c[i] ?? 0));
          rows.push(`${chrom}\t${bs}\t${be}\t${cells.join('\t')}`);
        }
        const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/tab-separated-values' });
        downloadBlob(blob, `${composite.label.replace(/\s+/g, '_')}_${chrom}_${start}_${end}.tsv`);
        return;
      }
      const indices: number[] = [];
      const lbls: string[] = [];
      for (const s of composite.sources) {
        const ref = s.ref;
        if (ref.kind === 'metaprofile') continue;
        const entry = state.catalog.find(e => e.id === ref.catalogEntryId);
        if (!entry) continue;
        let ortho = typeof entry.trackIndex === 'number'
          ? state.orthogonalTracks.find(t => t.index === entry.trackIndex)
          : undefined;
        if (!ortho) {
          const target = entry.path ?? entry.url;
          if (target) ortho = state.orthogonalTracks.find(t => t.path === target);
        }
        if (!ortho) continue;
        indices.push(ortho.index);
        lbls.push(entry.label);
      }
      if (indices.length === 0) return;
      if (indices.length === 1) {
        const blob = await exportTrack(indices[0], chrom, start, end, 'bedgraph');
        downloadBlob(blob, `${lbls[0].replace(/\s+/g, '_')}_${chrom}_${start}_${end}.bedGraph`);
      } else {
        const blob = await exportTracksMulti(indices, lbls, chrom, start, end);
        downloadBlob(blob, `${composite.label.replace(/\s+/g, '_')}_${chrom}_${start}_${end}.tsv`);
      }
    } finally {
      setExporting(false);
    }
  }, [composite]);

  const kindBadge =
    composite.kind === 'metaprofile'
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      : composite.kind === 'annotation'
      ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';

  return (
    <div
      className={`border rounded ${
        composite.visible
          ? 'border-gray-200 dark:border-gray-700'
          : 'border-gray-200 dark:border-gray-700 opacity-60'
      }`}
      data-tour="tracks-row"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
        <input
          type="checkbox"
          checked={composite.groupAutoscaleSelected}
          onChange={e => updateComposite(composite.id, { groupAutoscaleSelected: e.target.checked })}
          className="w-3.5 h-3.5 flex-shrink-0"
          title="Select for group autoscale"
        />
        <AnalysisButton
          onClick={() => updateComposite(composite.id, { visible: !composite.visible })}
          theme="blue"
          variant="outline"
          className="px-1 py-0 text-base leading-none flex-shrink-0"
          title={composite.visible ? 'Hide track' : 'Show track'}
          aria-label={composite.visible ? 'Hide track' : 'Show track'}
          aria-pressed={composite.visible}
        >
          {composite.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </AnalysisButton>
        <div className="flex -space-x-1 flex-shrink-0">
          {swatches.length === 0 && <span className="w-4 h-4 rounded-full border border-dashed border-gray-300" />}
          {swatches.map((c, i) => (
            <span key={i} className="w-4 h-4 rounded-full border border-white dark:border-gray-800" style={{ backgroundColor: c }} />
          ))}
        </div>
        <button
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left flex items-center gap-1.5"
        >
          <span className="inline-flex w-3 text-gray-500"><DisclosureChevron open={expanded} /></span>
          <span className="truncate text-gray-700 dark:text-gray-300">{composite.label}</span>
          <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0 ${kindBadge}`}>
            {composite.kind}
          </span>
          <span className="text-gray-400 text-[11px] whitespace-nowrap flex-shrink-0">
            {composite.sources.length} src · {summary}
          </span>
        </button>
        {composite.removable !== false && (
          <AnalysisButton
            onClick={() => { void unloadCompositeTrack(composite); }}
            variant="dangerOutline"
            className="px-1 py-0 text-base leading-none flex-shrink-0"
            title="Remove track and unload orphaned sources"
          >
            ×
          </AnalysisButton>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-2 space-y-2 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="w-14 text-gray-500">Name</span>
            <input
              type="text"
              value={composite.label}
              onChange={e => updateComposite(composite.id, { label: e.target.value })}
              className="flex-1 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
            />
          </label>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="w-14 text-gray-500">Scale</span>
            <select
              value={composite.scaleMode}
              onChange={e => updateComposite(composite.id, { scaleMode: e.target.value as CompositeTrack['scaleMode'] })}
              className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            >
              <option value="auto">auto</option>
              <option value="manual">manual</option>
              <option value="group">group</option>
              <option value="per-source">per-source</option>
            </select>
            <label className="flex items-center gap-1 ml-2">
              <input
                type="checkbox"
                checked={composite.logScale}
                onChange={e => updateComposite(composite.id, { logScale: e.target.checked })}
                className="w-3.5 h-3.5"
              />
              log
            </label>
          </div>

          {composite.scaleMode === 'manual' && (
            <label className="flex items-center gap-1.5">
              <span className="w-14 text-gray-500">Range</span>
              <input
                type="number"
                step="0.1"
                value={composite.yMin ?? ''}
                onChange={e => updateComposite(composite.id, { yMin: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                placeholder="min"
                className="w-16 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-right"
              />
              <span className="text-gray-400">to</span>
              <input
                type="number"
                step="0.1"
                value={composite.yMax ?? ''}
                onChange={e => updateComposite(composite.id, { yMax: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                placeholder="max"
                className="w-16 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-right"
              />
            </label>
          )}

          {composite.scaleMode === 'group' && (
            <label className="flex items-center gap-1.5">
              <span className="w-14 text-gray-500">Group</span>
              <input
                value={composite.scaleGroup ?? ''}
                onChange={e => updateComposite(composite.id, { scaleGroup: e.target.value || undefined })}
                placeholder="group name"
                className="flex-1 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </label>
          )}

          {motifAnnotation && (
            <div className="rounded border border-purple-200 bg-purple-50/70 p-2 text-xs dark:border-purple-900/60 dark:bg-purple-950/20">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-purple-700 dark:text-purple-300">Motif display</span>
                <label className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={motifStyle.showScoreLegend}
                    onChange={e => updateAnnotationStyle({ showScoreLegend: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  score ramp
                </label>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="flex items-center gap-1.5">
                  <span className="w-16 text-gray-500">Show ≥</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={percentValue(motifStyle.scoreMin, 0)}
                    onChange={e => {
                      const next = clamp01(parseFloat(e.target.value) / 100);
                      updateAnnotationStyle({
                        scoreMin: next,
                        scoreMax: Math.max(next + 0.01, motifStyle.scoreMax),
                      });
                    }}
                    className="w-14 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-right dark:border-gray-600 dark:bg-gray-800"
                    title="Hide motif hits below this normalized score"
                  />
                  <span className="text-gray-400">%</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="w-16 text-gray-500">Full at</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={percentValue(motifStyle.scoreMax, 1)}
                    onChange={e => {
                      const next = Math.max(motifStyle.scoreMin + 0.01, clamp01(parseFloat(e.target.value) / 100));
                      updateAnnotationStyle({ scoreMax: next });
                    }}
                    className="w-14 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-right dark:border-gray-600 dark:bg-gray-800"
                    title="Score that maps to the strongest shading"
                  />
                  <span className="text-gray-400">%</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="w-16 text-gray-500">Scale</span>
                  <select
                    value={motifStyle.scoreScale}
                    onChange={e => updateAnnotationStyle({ scoreScale: e.target.value as AnnotationScoreScale })}
                    className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1.5 py-0.5 dark:border-gray-600 dark:bg-gray-800"
                    title="Score-to-shading transform"
                  >
                    <option value="linear">linear</option>
                    <option value="sqrt">sqrt</option>
                    <option value="log">log</option>
                    <option value="square">square</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="w-16 text-gray-500">Strand</span>
                  <select
                    value={motifStyle.strandMode}
                    onChange={e => updateAnnotationStyle({ strandMode: e.target.value as AnnotationStrandMode })}
                    className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1.5 py-0.5 dark:border-gray-600 dark:bg-gray-800"
                    title="How motif strand is encoded in the annotation strip"
                  >
                    <option value="split">+/− lanes</option>
                    <option value="inline">inline arrows</option>
                    <option value="none">hidden</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          <div>
            <div className="text-[11px] text-gray-500 mb-1 px-1">
              Sources ({composite.sources.length})
            </div>
            {composite.kind === 'metaprofile' && (
              <div className="mx-1 mb-1 rounded border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-200">
                FIRE, deam, m6A/5mC, and custom layer profiles load on demand; turn a source on and the read track will refresh with the needed payload.
              </div>
            )}
            {composite.sources.length === 0 && (
              <div className="text-xs text-gray-400 italic px-2 py-1">No sources. Add one below.</div>
            )}
            {composite.sources.map(s => (
              <SourceRow key={s.id} composite={composite} source={s} />
            ))}
          </div>

          {showPicker ? (
            <AddSourcePicker
              composite={composite}
              onPick={(ref) => {
                // Read the track fresh: several sources can be added at once (a motif file).
                const current = useBrowserStore.getState().compositeTracks.find(c => c.id === composite.id) ?? composite;
                const used = new Set(current.sources.map(s => s.color));
                const color = TRACK_COLORS.find(c => !used.has(c)) ?? TRACK_COLORS[current.sources.length % TRACK_COLORS.length];
                addSourceTo(composite.id, { ref, color, visible: true, negate: false, scale: 1 });
                setShowPicker(false);
              }}
              onClose={() => setShowPicker(false)}
            />
          ) : (
            <AnalysisButton
              onClick={() => setShowPicker(true)}
              theme="blue"
              variant="outline"
              size="sm"
              className="w-full border-dashed"
            >
              + Add source
            </AnalysisButton>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            <AnalysisButton
              onClick={handleExport}
              disabled={exporting || composite.sources.length === 0}
              variant="outline"
              size="sm"
              title="Download values for the current viewport"
            >
              {exporting ? 'Exporting…' : 'Export view'}
            </AnalysisButton>
            <span className="text-[11px] text-gray-400">
              {composite.kind === 'metaprofile' ? 'TSV' : composite.sources.length > 1 ? 'multi-TSV' : 'bedGraph'}
            </span>
            <span className="flex-1" />
            <AnalysisButton
              onClick={openSavePreset}
              disabled={composite.sources.length === 0}
              theme="blue"
              variant="soft"
              size="sm"
              title="Save this track as a reusable preset (appears in Catalog → Saved)"
            >
              {savedFlash ? <span className="inline-flex items-center gap-1"><Check size={11} strokeWidth={2.5} aria-hidden="true" />Saved</span> : 'Save preset…'}
            </AnalysisButton>
          </div>
          {savePresetOpen && (
            <div className="rounded border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 p-2 space-y-1.5">
              <label className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-blue-700 dark:text-blue-300">Preset name</span>
                <input
                  type="text"
                  value={presetName}
                  autoFocus
                  onChange={e => setPresetName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSavePreset();
                    if (e.key === 'Escape') setSavePresetOpen(false);
                  }}
                  className="flex-1 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-900"
                />
              </label>
              <div className="flex items-center justify-end gap-1.5">
                <AnalysisButton
                  onClick={() => setSavePresetOpen(false)}
                  theme="blue"
                  variant="outline"
                  size="sm"
                >
                  Cancel
                </AnalysisButton>
                <AnalysisButton
                  onClick={handleSavePreset}
                  disabled={!presetName.trim()}
                  theme="blue"
                  variant="primary"
                  size="sm"
                >
                  Save preset
                </AnalysisButton>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
