/** Presentation semantics for FiberHMM consensus-refinement shadow layers.
 *
 * `nuc_sr` and `tf_sr` contain a complete post-pass call set. Targeted
 * responses carry structured refinement kinds; legacy BAM layers encode
 * actions in annotation names. Intervals without either are baseline shadows.
 * Legacy FiberHMM names actions introduced by a consensus pass:
 *   - fhsr_..._R<number>  newly rescued call
 *   - fhsr_..._O<number>_H  harmonized/refined boundary
 *   - fhlt_...  family-aware latent TF+nucleosome configuration
 */

export const STRAND_RESCUE_LAYERS = ['nuc_sr', 'tf_sr'] as const;

export type StrandRescueLayer = typeof STRAND_RESCUE_LAYERS[number];
export type StrandRescueAction = 'unchanged' | 'rescued' | 'harmonized' | 'configuration' | 'annotated';

export const STRAND_RESCUE_ACTION_COLORS: Record<
  StrandRescueLayer,
  Record<Exclude<StrandRescueAction, 'unchanged'>, string>
> = {
  nuc_sr: {
    rescued: '#0f766e',
    harmonized: '#0891b2',
    configuration: '#0369a1',
    annotated: '#0f766e',
  },
  tf_sr: {
    rescued: '#7c3aed',
    harmonized: '#4f46e5',
    configuration: '#c026d3',
    annotated: '#7c3aed',
  },
};

export function isStrandRescueLayer(name: string | null | undefined): name is StrandRescueLayer {
  return name === 'nuc_sr' || name === 'tf_sr';
}

export function strandRescueBaseLayer(name: StrandRescueLayer): 'nuc' | 'tf' {
  return name === 'nuc_sr' ? 'nuc' : 'tf';
}

export function classifyStrandRescueAnnotation(
  annotationName: string | null | undefined,
): StrandRescueAction {
  const name = (annotationName ?? '').trim();
  if (!name || name === '.') return 'unchanged';
  if (/^fhlt_[0-9a-f]+_/i.test(name)) return 'configuration';
  if (/_R\d+$/i.test(name)) return 'rescued';
  if (/_H$/i.test(name)) return 'harmonized';
  return 'annotated';
}

/** Targeted SR supplies aligned structured provenance even when annotation
 * names are empty. Prefer that action; BAM-tagged legacy layers still use
 * annotation names when structured provenance is absent. */
export function classifyStrandRescueAction(
  refinementKind: string | null | undefined,
  annotationName?: string | null,
): StrandRescueAction {
  const kind = (refinementKind ?? '').trim().toLowerCase();
  if (!kind || kind === '.') return classifyStrandRescueAnnotation(annotationName);
  if (kind === 'baseline' || kind === 'unchanged') return 'unchanged';
  if (kind === 'rescued') return 'rescued';
  if (kind === 'edge_refined' || kind === 'harmonized') return 'harmonized';
  if (kind === 'configuration') return 'configuration';
  return 'annotated';
}

export function strandRescueActionColor(
  layer: StrandRescueLayer,
  action: StrandRescueAction,
  baselineColor: string,
): string {
  return action === 'unchanged'
    ? baselineColor
    : STRAND_RESCUE_ACTION_COLORS[layer][action];
}

/** Once either structural consensus layer is needed, retain both available
 *  shadow payloads. This makes individual visibility toggles display-only and
 *  prevents a sibling layer from disappearing during a narrow refetch. */
export function expandStrandRescueLayerRequest(
  requested: Iterable<string>,
  available: Iterable<string>,
): string[] {
  const names = new Set(requested);
  const availableNames = new Set(available);
  if (names.has('nuc_sr') || names.has('tf_sr')) {
    for (const layer of STRAND_RESCUE_LAYERS) {
      if (availableNames.has(layer)) names.add(layer);
    }
  }
  return Array.from(names).sort();
}

/** Preserve the established custom-before-TF order, refinement, then families. */
export function annotationLayerRenderRank(name: string): number {
  const consensusRanks: Record<string,number> = {tf_native_replay:2.5,tf_sr_lattice:3.5,
    tf_cr:5.5,tf_rc:5.6,tf_recall:6,tf_cr_recalled:6.5,tf_cr_manual:6.75,nuc_cr_split:7,cr_split_gap:7.5,tf_xcr:9};
  if (name in consensusRanks) return consensusRanks[name];
  if (name === 'msp' || name === 'fire') return 0;
  if (name === 'tf_consensus') return 4;
  if (name === 'tf_cross_consensus') return 5;
  if (isStrandRescueLayer(name)) return 3;
  if (name === 'tf') return 2;
  return 1;
}
