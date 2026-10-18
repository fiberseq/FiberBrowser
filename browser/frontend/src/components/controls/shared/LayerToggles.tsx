import { useShallow } from 'zustand/react/shallow';
import { isBamBacked } from '../../../utils/datasetKinds';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { getCanonicalLayerEntries, getLayerColor, getLayerLabel, getLayerTitle, getNucDisplayLabel, getNucDisplayTitle, isDerivedLayerName } from '../../../utils/layerColors';
import { isStrandRescueLayer } from '../../../utils/strandRescue';
import { ChevronDown } from '../../ui/Icons';

// MSP is an internal compatibility key for older BAM/BigBed outputs. The
// user-facing control is always FIRE; aq filtering lives in Quality Filters.
// The legacy 'mod' key is kept as a back-compat alias for 'm6a' so old
// datasets that declare `available_layers.mod=true` still light up the m6A
// toggle — getCanonicalLayerEntries collapses them to a single 'm6a' entry.
const MOD_TYPE_CONFIG = {
  fire: { label: 'Accessibility', color: 'text-orange-700', title: 'Show FIRE accessibility intervals. Uses aq-filtered FIRE when aq is present; falls back to raw accessibility when aq is unavailable.' },
  m6a: { label: 'm6A', color: 'text-purple-800', title: 'Show m6A methylation marks (purple) — from BAM MM/ML or _m6a.bb' },
  mod: { label: 'm6A', color: 'text-purple-800', title: 'Legacy "mod" layer (alias for m6A). Rename your pipeline output to _m6a.bb going forward.' },
  m5c: { label: '5mC', color: 'text-red-700', title: 'Show 5mC methylation marks (red) — from _m5c.bb' },
  deam: { label: 'Deamination', color: 'text-teal-700', title: 'Show DAF deamination events (teal) — from _deam.bb' },
  footprint: { label: 'FP', color: 'text-green-700', title: 'Show footprint regions (green)' },
} as const;

function datasetHasLayer(dataset: any, type: string): boolean {
  if (type === 'fire') {
    return !!(dataset.available_layers?.fire || dataset.available_layers?.msp || dataset.layer_type === 'fire' || dataset.layer_type === 'msp');
  }
  if (dataset.available_layers) return !!dataset.available_layers[type];
  if (isBamBacked(dataset)) return type === 'footprint' || type === 'mod';
  return dataset.layer_type === type;
}

interface LayerTogglesProps {
  /** compact=true renders the toolbar variant (no label header, tighter spacing). */
  compact?: boolean;
  /** wrap=false keeps toolbar chips on one scrollable line. */
  wrap?: boolean;
}

/** Horizontal strip of "Data Layer" toggles. Mirrors the chips that used to
 *  live in the View sidebar — canonical known layers, plus any custom layers
 *  auto-detected from dataset `available_layers`. Shared so the toolbar and
 *  any future surface render the same logic. */
export function LayerToggles({ compact = false, wrap = true }: LayerTogglesProps) {
  const { enabledModTypes, toggleModType, datasets, modificationOverlays } = useBrowserStore(useShallow(s => ({
    enabledModTypes: s.enabledModTypes,
    toggleModType: s.toggleModType,
    datasets: s.datasets,
    modificationOverlays: s.modificationOverlays,
  })));
  const latticeEnabled = useConsensusViewStore(s => s.latticeEnabled);
  const hasNativeLattice = datasets.some(d => !!(d.available_layers?.tf_cr || d.derived_layers?.tf_cr || d.derived_layers?.tf_rc));

  const getOverlayForType = (type: string) => modificationOverlays.find(o => o.type === type);

  const knownModTypes = (Object.keys(MOD_TYPE_CONFIG) as Array<keyof typeof MOD_TYPE_CONFIG>).filter(type => {
    const hasFromDataset = datasets.some(d => datasetHasLayer(d, type));
    return hasFromDataset || getOverlayForType(type);
  });

  const customLayerSet = new Set<string>();
  for (const d of datasets) {
    if (!d.available_layers) continue;
    for (const [name, present] of Object.entries(d.available_layers)) {
      // deam_opportunity is retained only for explicit static diagnostics;
      // suppress it even when restored dataset metadata came from a version
      // that advertised the experimental live toggle.
      if (
        present
        && name !== 'msp'
        && name !== 'fire'
        && name !== 'deam_opportunity'
        && !(name in MOD_TYPE_CONFIG)
      ) {
        customLayerSet.add(name);
      }
    }
  }
  let availableModTypes: string[] = [...knownModTypes, ...customLayerSet];

  // Use the shared semantic order (baseline structure, family assignment,
  // modification evidence, then molecular refinement) instead of whichever order MA types happened
  // to be discovered in the BAM sample.
  const canonicalOrder = getCanonicalLayerEntries(datasets).map(entry => entry.key);
  availableModTypes = [
    ...canonicalOrder.filter(type => availableModTypes.includes(type)),
    ...availableModTypes.filter(type => !canonicalOrder.includes(type)),
  ];

  // Dedup: 'nuc' (v3 layer) + 'footprint' (legacy) render as one toggle; writes flow to both.
  const hasNuc = availableModTypes.includes('nuc');
  const hasFp = availableModTypes.includes('footprint');
  const nucIsAlias = hasNuc && hasFp;
  if (nucIsAlias) {
    availableModTypes = availableModTypes.filter(t => t !== 'footprint');
  }

  if (availableModTypes.length === 0 && !hasNativeLattice) return null;

  const textSize = compact ? 'text-[12px]' : 'text-[13px]';
  const gap = compact ? 'gap-2' : 'gap-3';
  const strandRescueTypes = availableModTypes.filter(type => (
    isStrandRescueLayer(type) && type !== 'tf_sr'
  ));
  const strandRescueTypeSet = new Set<string>(strandRescueTypes);
  const tfInferenceTypes = availableModTypes.filter(type => (
    type === 'tf_sr' || type === 'tf_consensus' || type === 'tf_cross_consensus'
  ));
  const tfInferenceTypeSet = new Set<string>(tfInferenceTypes);
  // Recaller runs: their class calls (tf_rc) are the class layer; the native-labelled one (tf_cr) would duplicate it.
  const recallerClasses = availableModTypes.includes('tf_rc');
  const derivedTypes = availableModTypes.filter(t => !(recallerClasses && t === 'tf_cr') && !strandRescueTypeSet.has(t) && !tfInferenceTypeSet.has(t) && (
    isDerivedLayerName(datasets, t) || ['tf_native_replay','tf_sr_lattice','tf_cr','tf_rc','tf_cr_manual','tf_recall','tf_cr_recalled','tf_xcr','nuc_cr_split','cr_split_gap','tf_bam_original'].includes(t)
  ));
  const standardTypes = availableModTypes.filter(t =>
    !(recallerClasses && t === 'tf_cr') && !derivedTypes.includes(t) && !strandRescueTypeSet.has(t) && !tfInferenceTypeSet.has(t)
  );

  const renderToggle = (modType: string) => {
    const knownConfig = (MOD_TYPE_CONFIG as Record<string, { label: string; color: string; title: string }>)[modType];
    const isNucLayerEntry = modType === 'nuc' || (nucIsAlias && modType === 'nuc');
    const derivedMeta = datasets.find(d => d.derived_layers?.[modType])?.derived_layers?.[modType];
    const label = isNucLayerEntry
      ? getNucDisplayLabel(datasets)
      : (modType === 'tf_cr' ? 'Footprint classes' : modType === 'tf_rc' ? 'Footprint classes' : derivedMeta?.label ?? knownConfig?.label ?? getLayerLabel(modType));
    const title = isNucLayerEntry
      ? getNucDisplayTitle(datasets)
      : (derivedMeta
        ? `Derived layer: ${derivedMeta.label ?? modType}${derivedMeta.source_layer ? ` (from ${getLayerLabel(derivedMeta.source_layer)})` : ''}`
        : (knownConfig?.title ?? getLayerTitle(modType)));
    const colorStyle = knownConfig ? undefined : { color: derivedMeta?.color ?? getLayerColor(modType) };
    const colorClass = knownConfig?.color ?? '';
    const isAliasForFp = nucIsAlias && modType === 'nuc';
    const checked = modType === 'fire'
      ? !!(enabledModTypes.fire || enabledModTypes.msp)
      : (enabledModTypes[modType] ?? false);
    return (
      <label
        key={modType}
        className={`flex items-center gap-1 ${textSize} cursor-pointer`}
        title={title}
        data-copilot-anchor={`layer-toggle-${modType}`}
      >
        <input
          type="checkbox"
          checked={checked}
          aria-label={`${label} layer`}
          data-testid={`layer-checkbox-${modType}`}
          onChange={e => {
            const store = useBrowserStore.getState();
            if (store._historyStack.length === 0) {
              store.pushSnapshot('Before layer toggle', { kind: 'layout' });
            }
            toggleModType(modType as any, e.target.checked);
            if (e.target.checked && modType === 'tf_cr') {
              toggleModType('tf_cr_manual' as any, false);
            }
            if (e.target.checked && modType === 'tf_cr_manual') {
              toggleModType('tf_cr' as any, false);
            }
            if (modType === 'fire') {
              toggleModType('msp' as any, e.target.checked);
            }
            if (isAliasForFp) {
              toggleModType('footprint' as any, e.target.checked);
            }
            store.pushSnapshot(`Toggle ${label} layer`, {
              kind: 'layout',
              coalesceKey: `layer-toggle:${modType}`,
              coalesceMs: 800,
            });
          }}
          className="rounded border-gray-300 dark:border-white/20"
        />
        {/* The swatch is the color the layer is drawn in, so these toggles
            double as the read-track legend. */}
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
          style={{ backgroundColor: derivedMeta?.color ?? getLayerColor(modType) }}
        />
        <span className={colorClass} style={colorStyle}>{label}</span>
      </label>
    );
  };

  return (
    <div
      className={`flex items-center ${gap} ${wrap ? 'flex-wrap' : 'flex-nowrap whitespace-nowrap'}`}
      data-testid="layer-toggle-group"
    >
      {standardTypes.map(renderToggle)}
      {derivedTypes.filter(t => t === 'tf_rc' || t === 'tf_cr').map(renderToggle)}
      {(tfInferenceTypes.length > 0 || strandRescueTypes.length > 0 || derivedTypes.some(t => t !== 'tf_cr' && t !== 'tf_rc') || hasNativeLattice) && <details className="relative" data-testid="advanced-layers">
        <summary className={`${textSize} flex cursor-pointer list-none items-center gap-0.5 text-slate-500 dark:text-slate-400 [&::-webkit-details-marker]:hidden`}>
          Advanced layers
          <ChevronDown size={11} aria-hidden="true" />
        </summary>
        <div className="absolute left-0 top-full z-[95] mt-1 flex min-w-[280px] max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-fb-lg border border-line bg-white p-3 shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark">
      {tfInferenceTypes.length > 0 && (
        <span
          className="inline-flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50/80 px-2 py-0.5 dark:border-violet-700 dark:bg-violet-950/25"
          data-testid="tf-inference-layer-group"
          title="Added TF inference layers. Baseline TF calls remain independently toggleable."
        >
          <span className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
            TF inference · added
          </span>
          {tfInferenceTypes.map(renderToggle)}
        </span>
      )}
      {strandRescueTypes.length > 0 && (
        <span
          className="inline-flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50/80 px-2 py-0.5 dark:border-violet-800/70 dark:bg-violet-950/25"
          data-testid="strand-rescue-layer-group"
          title="Per-molecule refinement. Baseline calls and consensus-state assignments remain independently toggleable."
        >
          <span className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
            Molecular refinement
          </span>
          {strandRescueTypes.map(renderToggle)}
          {!compact && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              rescue · edge · configuration
            </span>
          )}
        </span>
      )}
      {derivedTypes.length > 0 && standardTypes.length > 0 && (
        <span className="text-[11px] text-ink-secondary">
          Derived
        </span>
      )}
      {derivedTypes.filter(t => t !== 'tf_cr' && t !== 'tf_rc').map(renderToggle)}
      {hasNativeLattice && (
        <label
          className={`flex items-center gap-1 ${textSize} cursor-pointer`}
          title="Show the per-read assay opportunity lattice used by the population-state model. This is independent of the Deam and m6A evidence layers."
        >
          <input
            type="checkbox"
            checked={latticeEnabled}
            aria-label="Native opportunity lattice layer"
            data-testid="layer-checkbox-native-lattice"
            onChange={e => useConsensusViewStore.getState().configure({latticeEnabled:e.target.checked})}
            className="rounded border-gray-300 dark:border-white/20"
          />
          <span className="text-cyan-700 dark:text-cyan-300">Native opportunity lattice</span>
        </label>
      )}
        </div>
      </details>}
    </div>
  );
}
