/**
 * The shared geometries each nucleosome panel shows (transient; one entry per panel): the result and the exact request
 * that produced it. The feature hub's provider (geoHub.ts), the geometry track above the reads
 * (GeometryFeatureTrack.tsx) and the Saved list read them; the panel's patch section writes them.
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import type { NucGeometryRequest } from './api';
import type { NucGeometryResult } from './types';

export interface NucGeoRun {
  panelId: string;
  request: NucGeometryRequest;
  result: NucGeometryResult;
  /** Datasets of the series the result pooled (their columns in the hub). */
  datasets: string[];
  /** Series id -> dataset (per-dataset shares sum their series). */
  seriesDataset: Record<string, string>;
  /** Position formatting of the panel (genomic or relative to its origin). */
  origin: number | null;
  updatedAt: number;
}

interface NucGeoRunsState {
  runs: Record<string, NucGeoRun>;
  setRun: (run: NucGeoRun) => void;
  dropRun: (panelId: string) => void;
  clear: () => void;
}

export const useNucGeoRuns = create<NucGeoRunsState>(set => ({
  runs: {},
  setRun: run => set(s => ({ runs: { ...s.runs, [run.panelId]: run } })),
  dropRun: panelId => set(s => {
    if (!s.runs[panelId]) return {};
    const runs = { ...s.runs };
    delete runs[panelId];
    return { runs };
  }),
  clear: () => set({ runs: {} }),
}));

/** A geometry's chromosome: its own, else its run's window's (older answers). */
export const runGeoChrom = (g: { chrom?: string | null }, r: NucGeoRun) =>
  (typeof g.chrom === 'string' && g.chrom) ? g.chrom : r.result.window?.chrom ?? '';

/** The newest run that pooled the dataset and has a geometry on the view's chromosome overlapping the view (each
 * geometry on its own chromosome: a run over several chromosomes is drawn on each of them; null: none). */
export function geoRunFor(runs: Record<string, NucGeoRun>, datasetId: string | null | undefined,
  chrom: string, start: number, end: number, same: (a: string, b: string) => boolean): NucGeoRun | null {
  if (!datasetId) return null;
  return Object.values(runs).filter(r => r.result.window && r.datasets.includes(datasetId)
    && r.result.geometries.some(g => same(runGeoChrom(g, r), chrom) && g.start < end && g.end > start))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/**
 * A panel's run outlives its components while the panel stays open: an export of a maximised panel lays the hidden
 * panels out of the figure (unmounting them) while the visible dataset panel's geometry track still draws their run.
 * A component unmounting drops its panel's run only when the panel itself is gone (closed) or no longer shows the
 * geometries (patch calling switched off); `pruneGeoRuns` drops runs of panels that were closed.
 */
export function releaseGeoRun(panelId: string, still: (panel: { nucleosomes?: { mode?: string; regularity?: { patches?: { open?: boolean } } } }) => boolean,
  panels: ReadonlyArray<{ id: string; nucleosomes?: { mode?: string; regularity?: { patches?: { open?: boolean } } } }>): void {
  const panel = panels.find(p => p.id === panelId);
  if (panel && still(panel)) return;
  useNucGeoRuns.getState().dropRun(panelId);
}

/** The panel still shows its geometries: patch calling is on (every tab keeps them; an older session's `mode` is
 * ignored, as the panel ignores it). */
export const showsGeometries = (panel: { nucleosomes?: { mode?: string; regularity?: { patches?: { open?: boolean } } } }) =>
  panel.nucleosomes?.regularity?.patches?.open ?? true;

/** An unmount that keeps the run: the panel still shows its geometries and is only laid out of a figure export (it
 * mounts again when the export ends). Any other unmount (no columns, the panel closed) drops it, as before. */
export const keepsGeometriesOutOfView = (panel: Parameters<typeof showsGeometries>[0]) =>
  showsGeometries(panel) && Boolean(useBrowserStore.getState().exportInProgress);

/** Drop the runs of panels no longer open. */
export function pruneGeoRuns(panelIds: ReadonlyArray<string>): void {
  const keep = new Set(panelIds);
  const st = useNucGeoRuns.getState();
  for (const id of Object.keys(st.runs)) if (!keep.has(id)) st.dropRun(id);
}

