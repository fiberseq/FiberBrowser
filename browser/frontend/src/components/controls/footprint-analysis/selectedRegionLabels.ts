import { peakReference } from '../../../stores/clusterSlice';
import type { PanelConfig } from '../../../types';

/**
 * The Footprints panel's "N regions selected" list (fb-n3-clusters, audit M4):
 * each footprint or peak on its own chromosome and, on another assembly, with
 * its reference ("dm6 chr2L:6,356,930-6,357,166 (236bp)"), never the main
 * view's chromosome for a peak picked in another panel.
 */
interface RegionLabelContext {
  /** The main view's chromosome (a peak without one is the main view's). */
  chrom: string;
  start: number;
  end: number;
  panels: PanelConfig[];
  /** A reference key's name ("dm6"). */
  referenceName: (key: string) => string;
}

interface LabelledFootprint { chrom: string; absStart: number; absEnd: number; size: number; stateKey?: string; datasetId: string }
interface LabelledPeak { absStart: number; absEnd: number; size: number; chrom?: string | null; genome?: string | null }

const label = (genome: string | null | undefined, chrom: string, start: number, end: number, size: number, name: (key: string) => string) =>
  `${genome ? `${name(genome)} ` : ''}${chrom}:${start.toLocaleString()}-${end.toLocaleString()} (${size}bp)`;

export function selectedRegionLabels(footprints: LabelledFootprint[], peaks: LabelledPeak[], ctx: RegionLabelContext): string[] {
  const panelOf = (fp: LabelledFootprint) => ctx.panels.find(p => p.contentType === 'dataset'
    && (fp.stateKey ? (p.stateKey ?? p.datasetId) === fp.stateKey : p.datasetId === fp.datasetId));
  return [
    ...footprints.map(fp => label(panelOf(fp)?.genome, fp.chrom, fp.absStart, fp.absEnd, fp.size, ctx.referenceName)),
    ...peaks.map(p => {
      const chrom = p.chrom ?? ctx.chrom;
      const genome = peakReference(ctx, { start: p.absStart, end: p.absEnd, chrom, genome: p.genome });
      return label(genome, chrom, p.absStart, p.absEnd, p.size, ctx.referenceName);
    }),
  ];
}
