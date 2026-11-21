/**
 * The region heatmap's clusters as BED region sets (Save cluster as BED set): each becomes a set in Where = BED region
 * sets, so other plots can take the clusters as their groups (a set is a group there). Exact regions (the BED lines,
 * or the selected peaks), strand and name kept.
 */
import { useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { HeatmapFigure } from './heatmapData';
import type { BedRegion, RegionSet } from './bedRegions';

export function clusterRegionSets(fig: HeatmapFigure, base: string, only?: string): RegionSet[] {
  return (fig.clusters ?? []).filter(c => !only || c.id === only).map(c => {
    const regions: BedRegion[] = c.features.map(f => [f.chrom, f.region?.[0] ?? f.start, f.region?.[1] ?? f.end, f.strand ?? '.', f.label]);
    return { id: `bed-${base.replace(/[^\w]+/g, '_').slice(0, 24)}-${c.id}-${Date.now().toString(36)}`, name: `${base} · ${c.label}`, path: '', color: c.color, regions, total: regions.length };
  });
}

export function RegionHeatmapActions({ figure, base }: { figure: HeatmapFigure | null; base: string }) {
  const [note, setNote] = useState<string | null>(null);
  if (!figure?.clusters?.length) return null;
  const save = (only?: string) => {
    const sets = clusterRegionSets(figure, base, only);
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, regionSets: [...ws.regionSets, ...sets].slice(-20) }));
    setNote(`Saved ${sets.map(s => `${s.name} (${s.regions.length})`).join(', ')}: in Where › BED region sets, as groups for other plots.`);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-heatmap-clusters">
      <span className="font-medium">Clusters</span>
      {figure.clusters.map(c => (
        <button key={c.id} type="button" data-testid={`plots-heatmap-save-${c.id}`} onClick={() => save(c.id)}
          title={`Save cluster ${c.id} (${c.features.length} regions) as a BED region set`}
          className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: c.color }} aria-hidden="true" />Save {c.id} as BED set ({c.features.length})
        </button>
      ))}
      <button type="button" data-testid="plots-heatmap-save-all" onClick={() => save()} className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700"
        title="Every cluster as its own BED region set">Save all</button>
      {note && <span className="text-ink-secondary" role="status" data-testid="plots-heatmap-clusters-note">{note}</span>}
    </div>
  );
}
