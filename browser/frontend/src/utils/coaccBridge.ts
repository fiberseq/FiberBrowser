import { useCoaccStore, type CoaccSignalType } from '../stores/coaccStore';
import { normalizeAnnotationLayer } from './layerAliases';

export function coaccSettingsForFootprintLayer(layer: string | null | undefined): {
  signalType: CoaccSignalType;
  layer: string | null;
} {
  if (layer === 'all_fp') {
    return { signalType: 'all_fp', layer: null };
  }
  const normalized = normalizeAnnotationLayer(layer);
  if (!normalized) {
    return { signalType: 'all_fp', layer: null };
  }
  return {
    signalType: 'accessibility',
    layer: normalized,
  };
}

export function configureCoaccFromFootprintLayer(layer: string | null | undefined): void {
  const settings = coaccSettingsForFootprintLayer(layer);
  const store = useCoaccStore.getState();
  store.setCoaccSignalType(settings.signalType);
  store.setCoaccLayer(settings.layer);
  store.setCoaccTrackMode('heatmap');
}
