import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { getCanonicalLayerEntries } from '../../../utils/layerColors';

export interface PeakSourceOption {
  value: string;
  label: string;
}

export interface PeakSourceOptionGroup {
  label: string;
  options: PeakSourceOption[];
}

/** Build grouped signal-source options for the Peak Detection panel. */
export function usePeakSourceOptions(): PeakSourceOptionGroup[] {
  const {
    orthogonalTracks, annotationFiles, datasetProfiles, fireSignal,
    datasets, activeColormap, enabledModTypes,
  } = useBrowserStore(useShallow(s => ({
    orthogonalTracks: s.orthogonalTracks,
    annotationFiles: s.annotationFiles,
    datasetProfiles: s.datasetProfiles,
    fireSignal: s.fireSignal,
    datasets: s.datasets,
    activeColormap: s.activeColormap,
    enabledModTypes: s.enabledModTypes,
  })));

  return useMemo(() => {
    const groups: PeakSourceOptionGroup[] = [];

    // Layers use the same canonical order/naming as toolbar layer toggles,
    // cluster/sort dropdowns, and layer-aware analysis controls.
    const layerOptions: PeakSourceOption[] = [];
    for (const entry of getCanonicalLayerEntries(datasets)) {
      let backendValue: string | null = null;
      if (entry.key === 'nuc') backendValue = 'nuc_layer';
      else if (entry.key === 'footprint') backendValue = 'accessibility';
      else if (entry.key === 'fire') backendValue = 'fire';
      else if (entry.key === 'tf') backendValue = 'tf_layer';
      else if (entry.key === 'm6a' || entry.key === 'mod') backendValue = 'm6a';
      else if (entry.key === 'm5c') backendValue = 'm5c';
      else if (entry.key === 'deam') backendValue = 'deam';
      else backendValue = entry.key;
      if (backendValue) layerOptions.push({ value: backendValue, label: entry.label });
    }
    if (layerOptions.length > 0) {
      groups.push({ label: 'Layers', options: layerOptions });
    }

    const signalTracks = orthogonalTracks
      .filter((track: any) => track.renderMode === 'signal')
      .map((track: any, index: number) => ({
        value: `track:${track.index ?? index}`,
        label: track.label || `Track ${track.index ?? index}`,
      }));
    if (signalTracks.length > 0) {
      groups.push({ label: 'Tracks', options: signalTracks });
    }

    const annotTypes = annotationFiles
      .filter((file: any) => file.active)
      .flatMap((file: any) => file.annotationTypes ?? []);
    const uniqueAnnotTypes = [...new Map(annotTypes.map((type: any) => [type.name, type])).values()];
    if (uniqueAnnotTypes.length > 0) {
      groups.push({
        label: 'Annotations',
        options: uniqueAnnotTypes.map((type: any) => ({
          value: `annot:${type.name}`,
          label: type.name,
        })),
      });
    }

    const firstDatasetId = datasets[0]?.id;
    const profiles = firstDatasetId ? datasetProfiles[firstDatasetId] : undefined;
    const profileOptions: PeakSourceOption[] = [];
    if (profiles?.rules) {
      for (const [ruleId, values] of Object.entries(profiles.rules)) {
        if (values && (values as number[]).length > 0) {
          const colormapRule = activeColormap?.rules?.find((rule: any) => rule.id === ruleId);
          profileOptions.push({
            value: `profile:rule:${ruleId}`,
            label: colormapRule?.name || ruleId,
          });
        }
      }
    }
    if (fireSignal?.length > 0) {
      profileOptions.push({ value: 'fire_signal', label: 'Raw accessibility (FIRE) signal' });
    }
    if (profileOptions.length > 0) {
      groups.push({ label: 'Rule profiles', options: profileOptions });
    }

    groups.push({
      label: 'Manual',
      options: [{ value: 'custom', label: 'Custom (draw)' }],
    });

    void enabledModTypes;
    return groups;
  }, [orthogonalTracks, annotationFiles, datasetProfiles, fireSignal, datasets, activeColormap, enabledModTypes]);
}
