import type { CompactRead } from './types';
import { normalizeAnnotationLayer } from '../../../utils/layerAliases';
import { consensusPrimaryFamily } from '../../../utils/consensusVisual';

export interface FootprintHit {
  intervalIndex: number;
  interval: [number, number, number];
  layer: string | null;
}

export function layerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return a === b || (a === 'fire' && b === 'msp') || (a === 'msp' && b === 'fire');
}

interface EdgeAmbiguityHitConfig {
  mode: 'soft' | 'strict' | 'loose';
  applyNuc: boolean;
  applyTf: boolean;
  maxGapBp: number;
}

interface HitTestOptions {
  assignedClassesOnly?: boolean;
  relPos: number;
  bpTolerance: number;
  linkedOffset?: number;
  clickTargetLayer?: string | null;
  enabledModTypes: Record<string, boolean>;
  /** In 'soft' (faded band) and 'loose' (solid extension) edge modes the
   *  rendered footprint grows outward to its liberal boundary; expand the click
   *  target by the same amount so clicks on the visually-extended edge still
   *  register. 'strict' and omitting both keep conservative bounds. */
  edgeAmbiguity?: EdgeAmbiguityHitConfig;
  /** Optional renderer-specific geometry. This keeps hit testing aligned with
   * normalized TF-family spans while the returned interval remains the raw
   * single-molecule call used by selection and analysis. */
  displayBounds?: (
    layerName: string,
    intervalIndex: number,
    interval: [number, number, number],
  ) => { start: number; end: number } | null;
}

type LayerHit = FootprintHit & { width: number };

// Edge-sharpness dim indices: el/lq = genomic-left, er/rq = genomic-right.
function edgeDimIndices(names: string[] | undefined): { l: number; r: number } {
  const n = names ?? [];
  return {
    l: n.indexOf('el') >= 0 ? n.indexOf('el') : n.indexOf('lq'),
    r: n.indexOf('er') >= 0 ? n.indexOf('er') : n.indexOf('rq'),
  };
}

export function findFootprintHit(
  read: CompactRead,
  {
    relPos,
    bpTolerance,
    linkedOffset = 0,
    clickTargetLayer = null,
    enabledModTypes,
    edgeAmbiguity,
    displayBounds,
    assignedClassesOnly = false,
  }: HitTestOptions,
): FootprintHit | null {
  const layers = read.layers ?? {};
  let bestHit: LayerHit | null = null;

  // Both loose (solid extension) and soft (faded uncertainty band) draw the
  // footprint out to its liberal boundary, so the click target expands to match
  // in both. strict draws the conservative span only — no expansion.
  const edgeExtends = edgeAmbiguity?.mode === 'loose' || edgeAmbiguity?.mode === 'soft';
  // bp the el/er byte spans at confidence 0, shrinking to 0 (crisp) at 255.
  const gapBp = (q: number) =>
    edgeExtends ? edgeAmbiguity!.maxGapBp * (1 - Math.max(0, Math.min(255, q)) / 255) : 0;

  for (const [layerName, layer] of Object.entries(layers)) {
    if (clickTargetLayer && !layerNamesMatch(clickTargetLayer, layerName)) continue;
    const layerEnabled = layerName === 'msp'
      ? !!(enabledModTypes.fire || enabledModTypes.msp)
      : (enabledModTypes[layerName] ?? true);
    if (!layerEnabled) continue;
    const ivs = layer?.intervals;
    if (!ivs || ivs.length === 0) continue;
    // Skip the primary layer unless the user explicitly scoped clicks to it.
    if (!clickTargetLayer && (layerName === 'nuc' || layerName === 'footprint')) continue;
    // TF edges grow outward in soft/loose mode (nuc is handled in the primary loop).
    const layerExtends = edgeExtends && layerName === 'tf' && !!edgeAmbiguity?.applyTf;
    const { l: eL, r: eR } = layerExtends ? edgeDimIndices(layer?.quality_names) : { l: -1, r: -1 };
    for (let idx = 0; idx < ivs.length; idx++) {
      if (assignedClassesOnly && (!layer.consensus_workflow || !layer.job_id || !layer.consensus_records?.[idx] || !consensusPrimaryFamily(layer.consensus_records[idx]))) continue;
      const [intStart, intEnd, size] = ivs[idx];
      if (size <= 0) continue;
      const rendered = displayBounds?.(layerName, idx, ivs[idx]);
      let adjStart = (rendered?.start ?? intStart) + linkedOffset;
      let adjEnd = (rendered?.end ?? intEnd) + linkedOffset;
      const w = adjEnd - adjStart;  // conservative width drives smallest-hit-wins
      if (layerExtends) {
        const qL = eL >= 0 ? (layer?.qualities?.[eL]?.[idx] ?? 255) : 255;
        const qR = eR >= 0 ? (layer?.qualities?.[eR]?.[idx] ?? 255) : 255;
        adjStart -= gapBp(qL);
        adjEnd += gapBp(qR);
      }
      if (relPos >= adjStart - bpTolerance && relPos < adjEnd + bpTolerance) {
        if (!bestHit || w < bestHit.width) {
          bestHit = { intervalIndex: idx, interval: ivs[idx], layer: normalizeAnnotationLayer(layerName), width: w };
        }
      }
    }
  }
  if (bestHit) return bestHit;
  if (assignedClassesOnly) return null;

  // Backward compatibility: some payloads draw FIRE from read.fire without a
  // named msp/fire layer. Make those intervals selectable by the same target.
  if (
    (!clickTargetLayer || layerNamesMatch(clickTargetLayer, 'fire')) &&
    !layers.msp &&
    read.fire &&
    read.fire.length > 0 &&
    !!(enabledModTypes.fire || enabledModTypes.msp)
  ) {
    let bestFireHit: LayerHit | null = null;
    for (let idx = 0; idx < read.fire.length; idx++) {
      const [fireStart, fireEnd] = read.fire[idx];
      const adjStart = fireStart + linkedOffset;
      const adjEnd = fireEnd + linkedOffset;
      if (relPos >= adjStart - bpTolerance && relPos < adjEnd + bpTolerance) {
        const w = adjEnd - adjStart;
        if (!bestFireHit || w < bestFireHit.width) {
          bestFireHit = {
            intervalIndex: idx,
            interval: [fireStart, fireEnd, Math.max(0, fireEnd - fireStart)],
            layer: 'fire',
            width: w,
          };
        }
      }
    }
    if (bestFireHit) return bestFireHit;
  }

  if (clickTargetLayer && clickTargetLayer !== 'nuc' && clickTargetLayer !== 'footprint') {
    return null;
  }

  const primaryLayer = layers.nuc ?? layers.footprint;
  const primaryIntervals = primaryLayer?.intervals ?? read.intervals;
  const primaryLayerName = layers.nuc ? 'nuc' : (layers.footprint ? 'footprint' : null);

  // Nucleosome edges grow outward in soft/loose mode; expand the click target to match.
  const primaryExtends = edgeExtends && primaryLayerName === 'nuc' && !!edgeAmbiguity?.applyNuc;
  const { l: peL, r: peR } = primaryExtends ? edgeDimIndices(primaryLayer?.quality_names) : { l: -1, r: -1 };
  for (let idx = 0; idx < primaryIntervals.length; idx++) {
    const [intStart, intEnd, size] = primaryIntervals[idx];
    if (size <= 0) continue;
    let adjStart = intStart + linkedOffset;
    let adjEnd = intEnd + linkedOffset;
    if (primaryExtends) {
      const qL = peL >= 0 ? (primaryLayer?.qualities?.[peL]?.[idx] ?? 255) : 255;
      const qR = peR >= 0 ? (primaryLayer?.qualities?.[peR]?.[idx] ?? 255) : 255;
      adjStart -= gapBp(qL);
      adjEnd += gapBp(qR);
    }
    if (relPos >= adjStart && relPos < adjEnd) {
      return {
        intervalIndex: idx,
        interval: primaryIntervals[idx],
        layer: primaryLayerName,
      };
    }
  }

  return null;
}
