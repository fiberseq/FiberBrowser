/**
 * Chromatin styles for molecules on the graph panel, from FiberBrowser's own read-track rules (ReadTrackCanvas):
 * the active colormap's rules over whole calls (nucleosomes green from 90 bp, TF/subnucleosome rules), FIRE/MSP in
 * the FIRE colour with opacity from `aq` (gated FIRE rules repaint the calls that pass), m6A in the m6A purple, and
 * the colormap's edge-ambiguity setting for nucleosome/TF edges. A call is always styled by its **whole** size and
 * qualities, never by the slice of it a node or a coverage hole leaves on screen.
 *
 * Rules that need target coordinates (genes, peaks, tracks) never match here: an alternate path has no target
 * coordinates of its own (DESIGN_GRAPH_PANEL.md §5, coordinate-dependent landmarks stay unapplied). Nucleosome class
 * rules (coarse code, named class, z, TF bit) are not coordinate-dependent: they read the class bytes the call
 * carries, and never match a call without them (the read track's rule).
 */
import { MOD_COLORS } from '../../components/tracks/read-track/constants';
import { buildRuleMatchContext, footprintMatchesRule, ruleTargetsLayer, type RuleMatchContext } from '../../utils/ruleMatching';
import { buildRuleColorResolver } from '../../utils/ruleColors';
import { getLayerColor } from '../../utils/layerColors';
import { NUC_NAMED_MISSING, NUC_Z_MISSING, type NucSizeMark } from '../../utils/nucLayers';
import type { Colormap } from '../../types';

export type CallLayer = string;

export interface CallStyle { color: string; opacity: number }

export interface ChromatinStyle {
  /** `nucMark`: the call's nucsz mark (null or absent: none, so nucleosome class rules do not match). */
  call(layer: CallLayer, size: number, qualities: Record<string, number>, nucMark?: NucSizeMark | null, annotationName?: string | null): CallStyle | null;
  m6a: string;
  body: string;
  /** bp an edge of confidence q (0–255) may extend outward (0: crisp), and how edges are drawn. */
  edgeGapBp(q: number): number;
  edgeMode: 'soft' | 'strict' | 'loose';
  applyNuc: boolean;
  applyTf: boolean;
}

/** A graph call's nucsz mark from its class, z and named bytes, in the shape the rule matcher reads (no posterior on
 * the graph wire). A missing named byte (a payload before wire version 10) is no named evidence, which no named
 * rule matches, never "unnamed" (0). Null without a class byte. */
export function graphNucMark(cls: number | null | undefined, zb: number | null | undefined, nb?: number | null,
  start = 0, end = 0): NucSizeMark | null {
  if (cls == null || !Number.isFinite(cls)) return null;
  return { start, end, coarse: cls, named: nb != null && Number.isFinite(nb) ? nb : NUC_NAMED_MISSING, posterior: 0,
    z: zb != null && Number.isFinite(zb) ? zb : NUC_Z_MISSING };
}

const clamp01 = (v: unknown, fallback = 1) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : fallback));
};

export function chromatinStyle(colormap: Colormap, layerColors?: Record<string, string>): ChromatinStyle {
  const rules = colormap.rules ?? [];
  const resolvers = new Map(rules.map(r => [r, buildRuleColorResolver(r)] as const));
  const ctx: RuleMatchContext = buildRuleMatchContext([], [], [], 0, 1, rules);
  const layerOpacity = (name: string, fallback: number) => clamp01(colormap.layerOpacities?.[name === 'msp' ? 'fire' : name] ?? fallback, fallback);
  const background = (name: string) => clamp01(colormap.layerBackgroundOpacities?.[name === 'msp' ? 'fire' : name] ?? 1);
  const targeted = (name: string) => rules.some(r => (r.targetLayers ?? []).length > 0 && ruleTargetsLayer(r, name));
  const edge = colormap.edgeAmbiguity ?? { mode: 'strict' as const, applyNuc: true, applyTf: true, maxGapBp: 30 };

  const call = (layer: CallLayer, size: number, q: Record<string, number>, nucMark?: NucSizeMark | null, annotationName?: string | null): CallStyle | null => {
    if (size <= 0) return null;
    if (!['nuc', 'tf', 'msp'].includes(layer)) {
      // Generic layers retain their own colour/opacity and use only explicitly targeted rules.
      for (const rule of rules) {
        if (!(rule.targetLayers ?? []).length || !ruleTargetsLayer(rule, layer)) continue;
        if (footprintMatchesRule(0, size, size, rule, ctx, layer, q, annotationName ?? undefined, nucMark ?? null))
          return { color: resolvers.get(rule)!(size), opacity: clamp01(rule.opacity) * layerOpacity(layer, 0.65) };
      }
      return { color: layerColors?.[layer] ?? getLayerColor(layer),
        opacity: layerOpacity(layer, 0.65) * (targeted(layer) ? background(layer) : 1) };
    }
    if (layer === 'nuc') {
      // The primary (nucleosome) stream: the first matching rule, else grey; layer-targeted rules gate it.
      for (const rule of rules) {
        const gated = (rule.qualityGates?.length ?? 0) > 0;
        if (footprintMatchesRule(0, size, size, rule, ctx, 'nuc', gated ? q : undefined, annotationName ?? undefined, nucMark ?? null)) {
          return { color: resolvers.get(rule)!(size), opacity: clamp01(rule.opacity) * layerOpacity('nuc', 1) };
        }
      }
      if (targeted('nuc')) return { color: layerColors?.nuc ?? getLayerColor('nuc'), opacity: background('nuc') * layerOpacity('nuc', 1) };
      return { color: '#cccccc', opacity: layerOpacity('nuc', 1) };
    }
    // Overlays: TF evaluates every rule; FIRE/MSP only the rules that target it (a size rule never repaints FIRE).
    const display = layer === 'msp' ? 'fire' : layer;
    const qName = layer === 'msp' ? 'aq' : 'tq';
    const raw = q[qName];
    // Legacy files that declare aq but write 0/128 everywhere carry no quality: full opacity (as the read track).
    const quality = raw === undefined || (layer === 'msp' && (raw === 0 || raw === 128)) ? 255 : raw;
    const tfCfg = colormap.tfOverlay;
    const isTf = layer === 'tf';
    if (isTf && tfCfg && quality < (tfCfg.minTq ?? 0)) return null;
    const maxOpacity = layerOpacity(display, isTf && tfCfg ? tfCfg.maxOpacity : 0.65);
    const minOpacity = Math.min(isTf && tfCfg ? tfCfg.minOpacity : 0.25, maxOpacity);
    let color = isTf && tfCfg?.color ? tfCfg.color : (layerColors?.[display] ?? getLayerColor(display));
    let opacity = 1;
    let matched = false;
    for (const rule of rules) {
      if (!isTf && ((rule.targetLayers ?? []).length === 0 || !ruleTargetsLayer(rule, layer))) continue;
      const gated = (rule.qualityGates?.length ?? 0) > 0;
      if (footprintMatchesRule(0, size, size, rule, ctx, layer, gated ? q : undefined, annotationName ?? undefined, nucMark ?? null)) {
        color = resolvers.get(rule)!(size);
        opacity = clamp01(rule.opacity);
        matched = true;
        break;
      }
    }
    if (!matched && targeted(layer)) opacity = background(display);
    if (opacity <= 0) return null;
    return { color, opacity: opacity * (minOpacity + (maxOpacity - minOpacity) * (quality / 255)) };
  };
  return {
    call,
    m6a: MOD_COLORS.m6a,
    body: colormap.readBackgroundColor ?? '#f1f5f9',
    edgeGapBp: (q: number) => edge.maxGapBp * (1 - Math.max(0, Math.min(255, q)) / 255),
    edgeMode: edge.mode,
    applyNuc: edge.applyNuc,
    applyTf: edge.applyTf,
  };
}
