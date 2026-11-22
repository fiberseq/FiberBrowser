/** Axis words, reference lines and the "what it measures" line of a quantification (one place for the card and Plots). */
import { BASELINE_WORDS, type QuantMeasureInfo, type QuantResult } from './engine';
import type { QuantSpec } from './spec';
import { getLayerColor } from '../../utils/layerColors';

/** The raw value's words on its displayed scale. */
export function rawUnitOf(m: Pick<QuantMeasureInfo, 'kind' | 'unit'>, spec: Pick<QuantSpec, 'stat'>): string {
  if (m.kind === 'fraction') return spec.stat === 'area' ? 'layer bp per read (mean fraction × bounds bp)' : 'fraction of covered bp';
  if (m.kind === 'rate') return spec.stat === 'area' ? 'marks per read (rate × bounds bp)' : 'marks per kb';
  return m.unit;
}

/** The y-axis label: the measure and scale (raw, enrichment over its baseline, or versus the reference). */
export function axisLabelOf(m: Pick<QuantMeasureInfo, 'kind' | 'unit' | 'baseline'>, spec: Pick<QuantSpec, 'stat' | 'compare' | 'value' | 'form'>): string {
  const raw = rawUnitOf(m, spec);
  if (spec.compare === 'diff') return `difference vs reference (${raw})`;
  if (spec.compare === 'log2ratio') return `log2 ratio vs reference (${raw})`;
  if (spec.value === 'enrichment' && m.baseline) {
    const b = BASELINE_WORDS[m.baseline as keyof typeof BASELINE_WORDS] ?? m.baseline;
    return spec.form === 'percent' ? `% of ${b}` : spec.form === 'ratio' ? `ratio to ${b}` : `log2 vs ${b}`;
  }
  return raw;
}

/** Where bars grow from and the dashed line sits: 100 for %, 1 for a ratio, else 0. */
export function referenceOf(m: Pick<QuantMeasureInfo, 'baseline'>, spec: Pick<QuantSpec, 'compare' | 'value' | 'form'>): number {
  if (spec.compare !== 'off') return 0;
  if (spec.value === 'enrichment' && m.baseline) return spec.form === 'percent' ? 100 : spec.form === 'ratio' ? 1 : 0;
  return 0;
}

export function intervalText(r: QuantResult): string {
  const methods = new Set(r.measures.map(m => m.method));
  const parts: string[] = [];
  if (methods.has('wilson')) parts.push('Wilson 95% for shares of reads');
  if (methods.has('bootstrap') || r.measures.some(m => m.baseline)) parts.push(`bootstrap 95% (${r.resamples.toLocaleString('en-US')} Poisson resamples of reads, seed ${r.seed})`);
  if (r.measures.some(m => m.kind === 'group')) parts.push('no interval for group-level series');
  return parts.join('; ') || 'no interval';
}

const COMPARISON_WORDS: Record<QuantSpec['comparison'], string> = {
  clusters: 'clusters', datasets: 'datasets', 'clusters-datasets': 'clusters × datasets', pools: 'meta-locus pools',
};

/** "Mean over chr19:… per cluster; Wilson 95% …; reads per dataset: …". */
/** One line on the layers' units, so a difference from the curve is never read as an error. */
export function unitsText(r: QuantResult, binBp?: number | null): string {
  const curve = r.measures.some(m => m.units === 'curve'), exact = r.measures.some(m => m.units === 'exact');
  const parts: string[] = [];
  if (curve) parts.push(`layers in curve units: the profile's own ${binBp ? `${+binBp.toFixed(1)} bp ` : ''}bins and its mean over the window, so the card matches the curve`);
  if (exact) parts.push('layers in exact bp: short calls read lower than the curve, which counts a call in every bin it touches (TF about 20–30% lower on the demo)');
  const reduced = r.measures.filter(m => m.resamplesUsed).map(m => m.resamplesUsed!);
  if (reduced.length) parts.push(`curve-unit bootstrap reduced to ${Math.min(...reduced).toLocaleString('en-US')} resamples for this wide window`);
  return parts.join('; ');
}

export function measuresLine(r: QuantResult, spec: QuantSpec, o: { boundsText: string; sampled: Record<string, { used: number }>; datasetLabel: (id: string) => string; windowMissing?: boolean;
  readSource?: 'panel' | 'fetch' | null; binBp?: number | null }): string {
  const stat = spec.stat === 'area' ? 'Area' : 'Mean';
  const where = `${o.boundsText}${o.windowMissing ? ' (no window set: the whole view)' : ''}`;
  const ref = r.reference ? r.groups.find(g => g.id === r.reference)?.title : null;
  const cmp = spec.compare === 'off' ? '' : `; ${spec.compare === 'diff' ? 'difference' : 'log2 ratio'} vs ${ref ?? 'the first group'}`;
  const notes = [...new Set(r.measures.map(m => m.note).filter(Boolean))];
  const reads = Object.entries(o.sampled).map(([ds, s]) => `${o.datasetLabel(ds)} ${s.used.toLocaleString('en-US')}`).join(', ');
  const units = unitsText(r, o.binBp);
  const readWords = !reads ? '' : o.readSource === 'panel' ? `; reads: the panel's curve reads (${reads})` : `; reads used: ${reads} (up to ${spec.readCap.toLocaleString('en-US')} per dataset, seed ${spec.seed})`;
  return `${stat} over ${where} per ${COMPARISON_WORDS[spec.comparison].replace(/s$/, '')}${cmp}; ${intervalText(r)}${units ? `; ${units}` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}${readWords}.`;
}

export function pText(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '–';
  return p < 1e-4 ? p.toExponential(1) : p < 0.01 ? p.toFixed(4) : p.toFixed(3);
}

/** A measure's colour: a layer measure resolves its layer's colour now (getLayerColor: the session's colour, the
 *  saved default, else the built-in), so it follows Labels → Layer colours; other measures keep their own. */
export function measureColor(m: { id: string; color?: string }): string | undefined {
  return m.id.startsWith('layer:') ? getLayerColor(m.id.slice('layer:'.length)) : m.color;
}
