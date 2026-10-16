import type { BrowserState } from '../stores/browserStore';
import { SHORT_END_FOOTPRINT_BP, SHORT_END_FOOTPRINT_MAX_END_GAP_BP } from '../stores/uiSlice';
import { getLayerLabel } from './layerColors';

export interface SessionManifest {
  generatedAt: string;
  sessionName: string;
  viewport: {
    chrom: string;
    start: number;
    end: number;
    reversed: boolean;
  };
  reference: {
    genome: string | null;
    fastaPath: string | null;
    hasFasta: boolean;
  };
  datasets: Array<{
    id: string;
    label: string;
    paths: string[];
    dataType?: string;
    layers: string[];
  }>;
  tracks: {
    catalogEntries: number;
    unavailableCatalogEntries: number;
    compositeTracks: number;
    savedTracks: number;
  };
  labeling: {
    presetName: string;
    rules: number;
    enabledRules: number;
    qualityFilters: string[];
    readBackgroundColor: string | null;
    noReadBackgroundColor: string | null;
    displaySmoothing: {
      enabled: boolean;
      sigmaX: number;
      sigmaY: number;
    };
    layerOpacities: Record<string, number>;
    layerBackgroundOpacities: Record<string, number>;
  };
  reproducibility: {
    seed: string;
    analysisCap: number | null;
    clusterPreparationCount: number | null;
    clusterPreparationSamples: BrowserState['clusterPreparationSamples'];
    displayCap: number | null;
    displayMode: 'sample' | 'all';
    allReadsDisplayCap: number;
    backgroundReadCap: number | null;
    peaksLocked: boolean;
    selectedPeaks: number;
    peakRules: number;
    clusterMethod: string;
    clusterK: number;
    clusterResolution?: number;
    clusterFeatureRules: {
      total: number;
      enabled: number;
      terms: number;
      names: string[];
    };
    spanningOnly: boolean;
    qualityFilters: string[];
    disabledCachedLayers: string[];
    legacyLayerInference: {
      enabled: boolean;
      nucMinSize: number;
    };
    /** Read-end footprints under minBp dropped at load (display and analyses). */
    shortEndFootprints: {
      hidden: boolean;
      minBp: number;
      maxEndGapBp: number;
    };
    footprintRules: {
      total: number;
      enabled: number;
      pinned: number;
      layers: string[];
      rules: Array<{
        id: string;
        name: string;
        layer: string | null;
        layerLabel: string;
        enabled: boolean;
        sizeMin: number;
        sizeMax: number | null;
        pinned: boolean;
        referenceAbsStart: number | null;
        referenceAbsEnd: number | null;
        conditions: number;
      }>;
    };
    historySnapshots: number;
  };
  warnings: string[];
}

function pathsForDataset(dataset: any): string[] {
  if (Array.isArray(dataset.paths) && dataset.paths.length > 0) return dataset.paths.filter(Boolean);
  if (dataset.path) return [dataset.path];
  return [];
}

function enabledKeys(record: Record<string, boolean> | undefined): string[] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .sort();
}

function activeQualityFilters(state: BrowserState): string[] {
  const filters = state.activeColormap?.qualityFilters ?? [];
  return filters
    .filter((filter: any) => filter?.enabled)
    .map((filter: any) => {
      const layer = filter.layer || 'any';
      const quality = filter.qualityName || 'quality';
      const min = filter.minValue ?? 0;
      return `${layer}.${quality}>=${min}`;
    });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizedHexOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function summarizeLayerOpacities(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, opacity]) => typeof opacity === 'number' && Number.isFinite(opacity))
      .sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, number>;
}

function summarizeLabeling(state: BrowserState): SessionManifest['labeling'] {
  const preset = state.activeColormap ?? {};
  const rules = Array.isArray((preset as any).rules) ? (preset as any).rules : [];
  const smoothing = (preset as any).displaySmoothing ?? {};
  return {
    presetName: String((preset as any).name ?? 'Default'),
    rules: rules.length,
    enabledRules: rules.filter((rule: any) => rule?.enabled !== false).length,
    qualityFilters: activeQualityFilters(state),
    readBackgroundColor: normalizedHexOrNull((preset as any).readBackgroundColor),
    noReadBackgroundColor: normalizedHexOrNull((preset as any).noReadBackgroundColor ?? (preset as any).backgroundColor),
    displaySmoothing: {
      enabled: Boolean(smoothing.enabled),
      sigmaX: finiteNumber(smoothing.sigmaX, 0),
      sigmaY: finiteNumber(smoothing.sigmaY, 0),
    },
    layerOpacities: summarizeLayerOpacities((preset as any).layerOpacities),
    layerBackgroundOpacities: summarizeLayerOpacities((preset as any).layerBackgroundOpacities),
  };
}

function disabledCachedLayers(state: BrowserState): string[] {
  return Object.entries(state.cachedLayerTypes ?? {})
    .filter(([, enabled]) => enabled === false)
    .map(([key]) => key)
    .sort();
}

function numericOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function footprintRuleLayerLabel(layer: string | null): string {
  return layer ? getLayerLabel(layer) : 'Base intervals';
}

function summarizeFootprintRules(state: BrowserState): SessionManifest['reproducibility']['footprintRules'] {
  const groups = Array.isArray(state.footprintGroups) ? state.footprintGroups : [];
  const rules = groups.map((group: any) => {
    const referenceAbsStart = numericOrNull(group?.referenceAbsStart);
    const referenceAbsEnd = numericOrNull(group?.referenceAbsEnd);
    const layer = typeof group?.layer === 'string' ? group.layer : null;
    return {
      id: String(group?.id ?? ''),
      name: String(group?.name ?? group?.id ?? 'Unnamed rule'),
      layer,
      layerLabel: footprintRuleLayerLabel(layer),
      enabled: group?.enabled !== false,
      sizeMin: typeof group?.sizeMin === 'number' ? group.sizeMin : 0,
      sizeMax: typeof group?.sizeMax === 'number' ? group.sizeMax : null,
      pinned: referenceAbsStart !== null && referenceAbsEnd !== null,
      referenceAbsStart,
      referenceAbsEnd,
      conditions: Array.isArray(group?.conditions) ? group.conditions.length : 0,
    };
  });
  const layers = [...new Set(rules.map(rule => rule.layerLabel))].sort();
  return {
    total: rules.length,
    enabled: rules.filter(rule => rule.enabled).length,
    pinned: rules.filter(rule => rule.pinned).length,
    layers,
    rules,
  };
}

function summarizeClusterFeatureRules(state: BrowserState): SessionManifest['reproducibility']['clusterFeatureRules'] {
  const rules = Array.isArray(state.clusterFeatureRules) ? state.clusterFeatureRules : [];
  const enabled = rules.filter((rule: any) => rule?.enabled !== false);
  return {
    total: rules.length,
    enabled: enabled.length,
    terms: enabled.reduce((sum: number, rule: any) => sum + (Array.isArray(rule?.terms) ? rule.terms.length : 0), 0),
    names: enabled.map((rule: any) => String(rule?.name ?? rule?.id ?? 'Unnamed rule')).slice(0, 12),
  };
}

export function buildSessionManifest(
  state: BrowserState,
  options: { generatedAt?: string } = {},
): SessionManifest {
  const datasets = (state.datasets ?? []).map((dataset: any) => ({
    id: dataset.id,
    label: dataset.label ?? dataset.id,
    paths: pathsForDataset(dataset),
    dataType: dataset.data_type,
    layers: enabledKeys(dataset.available_layers),
  }));

  const unavailableCatalogEntries = (state.catalog ?? []).filter(entry => entry.unavailable).length;
  const warnings: string[] = [];

  if (datasets.length === 0) {
    warnings.push('No datasets are loaded.');
  }
  for (const dataset of datasets) {
    if (dataset.paths.length === 0) {
      const labelWithId = dataset.label !== dataset.id ? `${dataset.label} (${dataset.id})` : dataset.id;
      warnings.push(`Dataset "${labelWithId}" has no saved path.`);
    }
  }
  if (state.fastaPath && !state.hasFasta) {
    warnings.push(`FASTA path is saved but not loaded: ${state.fastaPath}`);
  } else if (state.currentGenome && !state.hasFasta) {
    warnings.push(`Genome "${state.currentGenome}" is selected but no FASTA is loaded.`);
  }
  if (unavailableCatalogEntries > 0) {
    warnings.push(`${unavailableCatalogEntries} catalog track${unavailableCatalogEntries === 1 ? '' : 's'} unavailable after restore.`);
  }
  if (state.analysisSampleCount != null) {
    warnings.push(`Analysis cap is active (${state.analysisSampleCount.toLocaleString()} reads).`);
  }
  if (state.selectedPeaks.size > 0 && !state.peaksLocked) {
    warnings.push('Selected peaks are not locked; autoscan/percentile changes can affect reproducibility.');
  }
  const disabledLayers = disabledCachedLayers(state);
  if (disabledLayers.length > 0) {
    warnings.push(`Layer cache disabled for: ${disabledLayers.join(', ')}.`);
  }
  const footprintRules = summarizeFootprintRules(state);
  const clusterFeatureRules = summarizeClusterFeatureRules(state);
  const labeling = summarizeLabeling(state);

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sessionName: state.sessionName || 'Untitled session',
    viewport: {
      chrom: state.chrom,
      start: state.start,
      end: state.end,
      reversed: state.isReversed,
    },
    reference: {
      genome: state.currentGenome ?? null,
      fastaPath: state.fastaPath ?? null,
      hasFasta: state.hasFasta,
    },
    datasets,
    tracks: {
      catalogEntries: state.catalog?.length ?? 0,
      unavailableCatalogEntries,
      compositeTracks: state.compositeTracks?.length ?? 0,
      savedTracks: state.savedTracks?.length ?? 0,
    },
    labeling,
    reproducibility: {
      seed: state.analysisSampleSeed,
      analysisCap: state.analysisSampleCount,
      clusterPreparationCount: state.clusterPreparationCount,
      clusterPreparationSamples: state.clusterPreparationSamples,
      displayCap: state.downsampleCount,
      displayMode: state.readDisplayMode,
      allReadsDisplayCap: state.allReadsDisplayCap,
      backgroundReadCap: state.backgroundReadCap,
      peaksLocked: state.peaksLocked,
      selectedPeaks: state.selectedPeaks.size,
      peakRules: state.peakRules.length,
      clusterMethod: state.clusterMethod,
      clusterK: state.clusterK,
      ...(state.clusterMethod === 'graph' ? { clusterResolution: state.clusterResolution } : {}),
      clusterFeatureRules,
      spanningOnly: state.spanningOnly,
      qualityFilters: activeQualityFilters(state),
      disabledCachedLayers: disabledLayers,
      legacyLayerInference: {
        enabled: state.legacyLayerInference,
        nucMinSize: state.legacyNucMinSize,
      },
      shortEndFootprints: {
        hidden: state.hideShortEndFootprints ?? true,
        minBp: SHORT_END_FOOTPRINT_BP,
        maxEndGapBp: SHORT_END_FOOTPRINT_MAX_END_GAP_BP,
      },
      footprintRules,
      historySnapshots: state._historyStack.length,
    },
    warnings,
  };
}

export function formatSessionManifest(manifest: SessionManifest): string {
  const lines = [
    `FiberBrowser session: ${manifest.sessionName}`,
    `Generated: ${manifest.generatedAt}`,
    `Viewport: ${manifest.viewport.chrom}:${manifest.viewport.start}-${manifest.viewport.end}${manifest.viewport.reversed ? ' (reversed)' : ''}`,
    `Reference: ${manifest.reference.genome ?? 'none'}${manifest.reference.fastaPath ? ` (${manifest.reference.fastaPath})` : ''}`,
    `Datasets: ${manifest.datasets.length}`,
    ...manifest.datasets.map(dataset => (
      `  - ${dataset.label} [${dataset.dataType ?? 'unknown'}]: ${dataset.paths.join('; ') || 'no path'}${dataset.layers.length ? `; layers=${dataset.layers.join(',')}` : ''}`
    )),
    `Tracks: ${manifest.tracks.catalogEntries} catalog, ${manifest.tracks.compositeTracks} cart, ${manifest.tracks.savedTracks} saved`,
    `Labeling: ${manifest.labeling.presetName}, ${manifest.labeling.rules} rules (${manifest.labeling.enabledRules} enabled)`,
    `Layer opacity: ${Object.keys(manifest.labeling.layerOpacities).length ? Object.entries(manifest.labeling.layerOpacities).map(([layer, opacity]) => `${layer}=${opacity}`).join(', ') : 'none'}`,
    `Layer baseline opacity: ${Object.keys(manifest.labeling.layerBackgroundOpacities).length ? Object.entries(manifest.labeling.layerBackgroundOpacities).map(([layer, opacity]) => `${layer}=${opacity}`).join(', ') : 'none'}`,
    `Display smoothing: ${manifest.labeling.displaySmoothing.enabled ? `on (x=${manifest.labeling.displaySmoothing.sigmaX}, y=${manifest.labeling.displaySmoothing.sigmaY})` : 'off'}`,
    `Read backgrounds: read=${manifest.labeling.readBackgroundColor ?? 'default'}, no-read=${manifest.labeling.noReadBackgroundColor ?? 'default'}`,
    `Seed: ${manifest.reproducibility.seed}`,
    `Legacy layer inference: ${manifest.reproducibility.legacyLayerInference.enabled ? 'on' : 'off'} (nuc >= ${manifest.reproducibility.legacyLayerInference.nucMinSize}bp)`,
    `Footprints cut off at read ends (< ${manifest.reproducibility.shortEndFootprints.minBp}bp, within ${manifest.reproducibility.shortEndFootprints.maxEndGapBp}bp of the end): ${manifest.reproducibility.shortEndFootprints.hidden ? 'hidden' : 'shown'}`,
    `Analysis cap: ${manifest.reproducibility.analysisCap == null ? 'off' : manifest.reproducibility.analysisCap}`,
    `Display: ${manifest.reproducibility.displayMode}, sample cap=${manifest.reproducibility.displayCap == null ? 'auto' : manifest.reproducibility.displayCap}, display max=${manifest.reproducibility.allReadsDisplayCap}, profile pool=${manifest.reproducibility.backgroundReadCap == null ? 'none' : manifest.reproducibility.backgroundReadCap}`,
    `Peaks: ${manifest.reproducibility.selectedPeaks} selected, ${manifest.reproducibility.peakRules} rules, locked=${manifest.reproducibility.peaksLocked}`,
    `Clustering: ${manifest.reproducibility.clusterMethod}, k=${manifest.reproducibility.clusterK}, spanning=${manifest.reproducibility.spanningOnly}`,
    `Cluster feature rules: ${manifest.reproducibility.clusterFeatureRules.total} total, ${manifest.reproducibility.clusterFeatureRules.enabled} enabled, terms=${manifest.reproducibility.clusterFeatureRules.terms}${manifest.reproducibility.clusterFeatureRules.names.length ? `, names=${manifest.reproducibility.clusterFeatureRules.names.join(',')}` : ''}`,
    `Quality filters: ${manifest.reproducibility.qualityFilters.length ? manifest.reproducibility.qualityFilters.join(', ') : 'none'}`,
    `Disabled cached layers: ${manifest.reproducibility.disabledCachedLayers.length ? manifest.reproducibility.disabledCachedLayers.join(', ') : 'none'}`,
    `Footprint rules: ${manifest.reproducibility.footprintRules.total} total, ${manifest.reproducibility.footprintRules.enabled} enabled, ${manifest.reproducibility.footprintRules.pinned} pinned${manifest.reproducibility.footprintRules.layers.length ? `, layers=${manifest.reproducibility.footprintRules.layers.join(',')}` : ''}`,
    `History snapshots: ${manifest.reproducibility.historySnapshots}`,
  ];

  if (manifest.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of manifest.warnings) {
      lines.push(`  - ${warning}`);
    }
  } else {
    lines.push('Warnings: none');
  }

  return lines.join('\n');
}
