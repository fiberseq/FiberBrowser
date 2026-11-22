/**
 * A quantification in Plots: a card whose PlotSpec records the spec, the window, the bounds and the sampling
 * (`sampling { mode, n, seed }`), with the values in the card (SuppliedData.quant). Keep puts a frozen copy in the
 * Gallery; Open in Plots shows it there. Plots draws it with the same result component (QuantResultView); the card's
 * panel recomputes it.
 */
import { captureBrowserState, keepPlotEntry, openEntry } from '../plots/galleryActions';
import { recordInGallery, useGalleryStore, hashText, type GalleryEntry } from '../plots/gallery';
import { setWorkspace } from '../plots/workspace';
import { newPlot, type PlotSpec, type QuantRecord } from '../plots/plotModel';
import type { QuantResult } from './engine';
import type { QuantSpec, QuantWindow } from './spec';

export interface QuantCardInput {
  result: QuantResult;
  spec: QuantSpec;
  window: QuantWindow | null;
  bounds: QuantRecord['bounds'];
  axis?: QuantRecord['axis'];
  anchor?: QuantRecord['anchor'];
  name: string;
  measures: string;
  yLabel: string;
  datasets: string[];
  genome: string | null;
  /** The origin words ("Clusters › Profiles", "Metaprofile track"). */
  origin: string;
}

export const QUANT_PLOT_ID = 'window-quant';

export function quantPlotSpec(input: QuantCardInput): PlotSpec {
  const base = newPlot({ type: 'metaprofile' });
  const groupBy = input.spec.comparison === 'datasets' || input.spec.comparison === 'pools' ? 'dataset' : 'cluster';
  return {
    ...base, id: `${QUANT_PLOT_ID}:${hashText(JSON.stringify([input.origin, input.bounds.chrom]))}`, name: input.name, where: 'view', groupBy, compare: 'off',
    pinned: { chrom: input.bounds.chrom, start: input.bounds.from, end: input.bounds.to, genome: input.genome },
    sampling: { mode: 'random', n: input.spec.readCap, seed: input.spec.seed },
    supplied: { origin: input.origin, x0: 0, dx: 1, xLabel: 'group', yLabel: input.yLabel, measures: input.measures,
      quant: { spec: input.spec, window: input.window, bounds: input.bounds, ...(input.axis ? { axis: input.axis } : {}), ...(input.anchor ? { anchor: input.anchor } : {}) } },
  };
}

export const quantRequestKey = (input: QuantCardInput): string => JSON.stringify({ kind: 'fiberbrowser.window_quant.v1', bounds: input.bounds, spec: input.spec,
  hash: hashText(JSON.stringify(input.result.cells.map(c => [c.measure, c.group, c.value, c.lo, c.hi, c.n, c.enrich, c.cmp]))) });

function record(input: QuantCardInput): GalleryEntry | null {
  const plot = quantPlotSpec(input);
  const { gallery, entry } = recordInGallery(useGalleryStore.getState(), {
    plot, computedFor: plot.pinned!, requestKey: quantRequestKey(input), byPanel: {},
    items: input.result.groups.map(g => ({ id: g.id, title: g.title, color: g.color })), thumb: '', datasets: input.datasets, name: input.name,
    supplied: { series: [], quant: input.result },
  }, captureBrowserState());
  if (gallery !== useGalleryStore.getState()) useGalleryStore.setState(gallery, true);
  return entry;
}

/** Keep: a frozen copy in the Gallery (the explicit Keep, as for any plot). Returns the kept card. */
export function keepQuant(input: QuantCardInput): GalleryEntry | null {
  const e = record(input);
  return e ? keepPlotEntry(e.id, input.name) : null;
}

/** Open in Plots: the working card, shown in the Plots workspace. */
export function openQuantInPlots(input: QuantCardInput): string | null {
  const e = record(input);
  if (!e) return null;
  openEntry(e.id);
  setWorkspace('plots');
  return e.id;
}
