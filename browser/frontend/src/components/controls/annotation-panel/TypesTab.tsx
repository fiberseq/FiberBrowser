import { useBrowserStore } from '../../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { setAnnotationThreshold as apiSetThreshold } from '../../../api/annotations';
import { AnalysisButton, AnalysisStatus } from '../shared';

export function TypesTab() {
  const {
    annotationFiles,
    enabledAnnotationTypes,
    annotationThresholds,
    annotationColors,
    annotationOpacityMin,
    annotationOpacityMax,
    toggleAnnotationType,
    setAnnotationThreshold,
    setAnnotationColor,
    setAnnotationOpacityRange,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    enabledAnnotationTypes: s.enabledAnnotationTypes,
    annotationThresholds: s.annotationThresholds,
    annotationColors: s.annotationColors,
    annotationOpacityMin: s.annotationOpacityMin,
    annotationOpacityMax: s.annotationOpacityMax,
    toggleAnnotationType: s.toggleAnnotationType,
    setAnnotationThreshold: s.setAnnotationThreshold,
    setAnnotationColor: s.setAnnotationColor,
    setAnnotationOpacityRange: s.setAnnotationOpacityRange,
  })));

  // Collect all types from active files
  const allTypes = annotationFiles
    .filter(f => f.active)
    .flatMap(f => f.annotationTypes ?? []);

  // Deduplicate by name
  const uniqueTypes = [...new Map(allTypes.map(t => [t.name, t])).values()];

  const handleThresholdChange = (name: string, value: number) => {
    setAnnotationThreshold(name, value);
    apiSetThreshold(name, value).catch(console.error);
  };

  const enableAll = () => uniqueTypes.forEach(t => toggleAnnotationType(t.name, true));
  const disableAll = () => uniqueTypes.forEach(t => toggleAnnotationType(t.name, false));

  if (uniqueTypes.length === 0) {
    return (
      <AnalysisStatus kind="empty" compact>
        Activate an annotation file first to see types.
      </AnalysisStatus>
    );
  }

  const opMinPct = Math.round(annotationOpacityMin * 100);
  const opMaxPct = Math.round(annotationOpacityMax * 100);

  return (
    <div className="space-y-2">
      {/* Global overlay opacity range */}
      <div className="p-1.5 rounded border border-gray-200 dark:border-white/10">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-gray-500 font-medium">Overlay opacity</span>
          <span className="text-[11px] text-ink-secondary">{opMinPct}% – {opMaxPct}%</span>
        </div>
        <div className="relative h-4">
          {/* Track background */}
          <div className="absolute top-1.5 left-0 right-0 h-1 bg-gray-200 dark:bg-white/10 rounded" />
          {/* Active range highlight */}
          <div
            className="absolute top-1.5 h-1 bg-indigo-400 rounded"
            style={{ left: `${opMinPct}%`, width: `${opMaxPct - opMinPct}%` }}
          />
          {/* Min thumb */}
          <input
            type="range"
            min={0}
            max={100}
            value={opMinPct}
            onChange={e => {
              const v = parseInt(e.target.value) / 100;
              setAnnotationOpacityRange(Math.min(v, annotationOpacityMax), annotationOpacityMax);
            }}
            className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-indigo-500 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow"
            style={{ zIndex: opMinPct > opMaxPct - 5 ? 5 : 3 }}
          />
          {/* Max thumb */}
          <input
            type="range"
            min={0}
            max={100}
            value={opMaxPct}
            onChange={e => {
              const v = parseInt(e.target.value) / 100;
              setAnnotationOpacityRange(annotationOpacityMin, Math.max(v, annotationOpacityMin));
            }}
            className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-600 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-indigo-600 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow"
            style={{ zIndex: 4 }}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <AnalysisButton onClick={enableAll} theme="violet" variant="soft">
          Enable All
        </AnalysisButton>
        <AnalysisButton onClick={disableAll} variant="outline">
          Disable All
        </AnalysisButton>
      </div>

      <div className="space-y-1.5" data-tour="annotations-type-list">
        {uniqueTypes.map(t => {
          const enabled = enabledAnnotationTypes[t.name] ?? false;
          const threshold = annotationThresholds[t.name] ?? 0;
          const color = annotationColors[t.name] || t.color;

          return (
            <div
              key={t.name}
              className="p-1.5 rounded border border-gray-200 dark:border-white/10"
              // Per-row Copilot anchor — the planner's toggle_annotation_visibility
              // action carries the annotation type name, so the spotlight can
              // ring this row instead of just flashing the panel header.
              data-copilot-anchor={`annotation-toggle-${t.name}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => toggleAnnotationType(t.name, e.target.checked)}
                  className="w-3 h-3"
                />
                <input
                  type="color"
                  value={color}
                  onChange={e => setAnnotationColor(t.name, e.target.value)}
                  className="w-4 h-4 rounded cursor-pointer border-0 p-0"
                  title="Change color"
                />
                <span className="text-xs font-medium flex-1">{t.name}</span>
                {t.category && (
                  <span className="text-[11px] px-1 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500">
                    {t.category}
                  </span>
                )}
              </div>
              {t.description && (
                <div className="text-[11px] text-ink-secondary mt-0.5 ml-9">{t.description}</div>
              )}
              <div className="flex items-center gap-2 mt-1 ml-9">
                <span className="text-[11px] text-gray-500">Min confidence:</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(threshold * 100)}
                  onChange={e => handleThresholdChange(t.name, parseInt(e.target.value) / 100)}
                  className="flex-1 h-1"
                />
                <span className="text-[11px] text-gray-500 w-8">{Math.round(threshold * 100)}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
