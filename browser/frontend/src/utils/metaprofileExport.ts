import type { DatasetProfile, PanelConfig, TrackSource } from '../types';
import { mainViewStateKeys } from './mainViewPanels';

interface ExportState {
  panels: PanelConfig[];
  datasets: Array<{ id: string; label?: string }>;
  datasetProfiles: Record<string, DatasetProfile>;
  chrom: string;
  start: number;
  end: number;
}

/** A profile's values for a metaprofile rule, looked up as the track draws them. */
function profileValues(dsp: DatasetProfile | undefined, ruleId: string): number[] {
  if (!dsp) return [];
  const profileId = ruleId === 'mod' ? 'm6a' : ruleId;
  return dsp.layers?.[profileId]
    ?? (profileId === 'm6a' ? dsp.layers?.mod : undefined)
    ?? (profileId === 'm6a' ? dsp.mod : profileId === 'fire' ? dsp.fire : undefined)
    ?? dsp.rules?.[profileId]
    ?? [];
}

/**
 * Columns of a metaprofile export: one per source for each panel showing the
 * main view (the source's own dataset's panels when it names one), read from
 * the profile that panel draws. Labelled by dataset when there are several.
 */
export function metaprofileExportColumns(
  state: ExportState,
  sources: TrackSource[],
): Array<{ label: string; values: number[] }> {
  const mainKeys = new Set(mainViewStateKeys(state));
  const panels = state.panels.filter(p =>
    p.contentType === 'dataset' && p.datasetId && mainKeys.has(p.stateKey ?? p.datasetId));
  const out: Array<{ label: string; values: number[] }> = [];
  for (const src of sources) {
    if (src.ref.kind !== 'metaprofile') continue;
    const ruleId = src.ref.ruleId;
    const name = ruleId === 'mod' ? 'm6a' : ruleId;
    const wanted = src.ref.datasetId;
    const targets = panels.filter(p => !wanted || p.datasetId === wanted);
    if (targets.length === 0) {
      const dsId = wanted ?? state.datasets[0]?.id;
      out.push({ label: name, values: profileValues(dsId ? state.datasetProfiles[dsId] : undefined, ruleId) });
      continue;
    }
    for (const p of targets) {
      const key = p.stateKey ?? p.datasetId!;
      const dsLabel = state.datasets.find(d => d.id === p.datasetId)?.label ?? p.datasetId!;
      const label = targets.length > 1 || panels.length > 1
        ? `${dsLabel}${p.stateKey && p.stateKey !== p.datasetId ? ` (${p.stateKey})` : ''}:${name}`
        : name;
      out.push({ label, values: profileValues(state.datasetProfiles[key], ruleId) });
    }
  }
  return out;
}
