import type { ClusterFeatureRuleTerm, ColorRule } from '../types';
import { qualityGatesPayload, ruleHasNucConditions, type QualityGatePayload } from '../utils/ruleMatching';

/**
 * A rule term's count payload for Filter/Sort (`rule` of /api/sort_reads and /api/filter_by_analysis_rule; the
 * backend's read_metrics.compute_rule_metric): size bounds, conditions, quality gates and, for a labeling rule that
 * sets them, its nucleosome conditions, so a count matches what the rule paints.
 */
export interface RuleTermPayload {
  size_min: number;
  size_max: number | null;
  conditions: any[];
  quality_gates: QualityGatePayload[];
  nuc_coarse?: number[];
  nuc_named?: number[];
  z_min?: number;
  z_max?: number;
  nuc_tf?: boolean;
}

/** A labeling rule's nucleosome conditions as the payload spells them; nothing for a rule that sets none. */
export function nucConditionsPayload(rule: ColorRule | undefined): Partial<RuleTermPayload> {
  if (!rule || !ruleHasNucConditions(rule)) return {};
  return {
    ...((rule.nucCoarse?.length ?? 0) > 0 ? { nuc_coarse: [...rule.nucCoarse!] } : {}),
    ...((rule.nucNamed?.length ?? 0) > 0 ? { nuc_named: [...rule.nucNamed!] } : {}),
    ...(rule.zMin != null && Number.isFinite(rule.zMin) ? { z_min: rule.zMin } : {}),
    ...(rule.zMax != null && Number.isFinite(rule.zMax) ? { z_max: rule.zMax } : {}),
    ...(typeof rule.nucTf === 'boolean' ? { nuc_tf: rule.nucTf } : {}),
  };
}

/** The Filter/Sort count payload of a rule term (shared by the Sort/Filter buttons and the action runner). */
export function ruleTermPayload(term: ClusterFeatureRuleTerm | undefined): RuleTermPayload {
  const base = term?.source === 'label_rule'
    ? term.rule
    : term?.source === 'footprint_group'
      ? term.group
      : term;
  const rawSizeMax = (base as any)?.sizeMax ?? term?.sizeMax;
  return {
    size_min: Math.max(0, Number((base as any)?.sizeMin ?? term?.sizeMin ?? 0) || 0),
    size_max: rawSizeMax == null ? null : Math.max(0, Number(rawSizeMax) || 0),
    conditions: [...((base as any)?.conditions ?? [])],
    // The labeling rule's quality gates too, so a count matches what it paints.
    quality_gates: qualityGatesPayload((base as any)?.qualityGates ?? term?.qualityGates),
    ...(term?.source === 'label_rule' ? nucConditionsPayload(term.rule) : {}),
  };
}
