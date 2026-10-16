/**
 * "Merge by" (fb-n5-projection): how Merge similar clusters decides that two
 * clusters are alike, after the small clusters are merged away. The server
 * implements each (services/cluster_analysis.py run_autocull_on); this is the
 * one place for their names, plain-language help, threshold ranges and
 * defaults. Cosine stays the default.
 */

export type MergeStrategy = 'cosine' | 'correlation' | 'difference' | 'js' | 'connectivity';

export interface MergeStrategyInfo {
  value: MergeStrategy;
  /** Short name for the selector. */
  label: string;
  /** What the threshold is called next to its input. */
  thresholdLabel: string;
  /** How to read the threshold ("higher merges less"). */
  thresholdHint: string;
  /** Plain-language description (selector and input titles). */
  help: string;
  min: number;
  max: number;
  step: number;
  defaultThreshold: number;
  /** Shown as a percentage (difference test). */
  percent?: boolean;
}

export const MERGE_STRATEGIES: MergeStrategyInfo[] = [
  {
    value: 'cosine',
    label: 'Profile similarity (cosine)',
    thresholdLabel: 'Similarity cutoff',
    thresholdHint: '0.5–1; higher merges less',
    help: 'Merges two clusters whose average profiles point the same way (cosine similarity above the cutoff). '
      + 'Coarse: two clusters that differ at one peak can still look alike overall.',
    min: 0.5, max: 1, step: 0.005, defaultThreshold: 0.95,
  },
  {
    value: 'difference',
    label: 'No position differs (test)',
    thresholdLabel: 'Smallest difference',
    thresholdHint: '% of reads; lower merges less',
    help: 'Merges two clusters only when no position at the clustered peaks differs between them: a position '
      + 'differs when the share of accessible reads differs by at least this much and the difference is '
      + 'significant (two-proportion test, Benjamini–Hochberg q < 0.01). "They don’t differ anywhere."',
    min: 0.02, max: 0.8, step: 0.01, defaultThreshold: 0.2, percent: true,
  },
  {
    value: 'connectivity',
    label: 'Neighbours on the map',
    thresholdLabel: 'Connectivity',
    thresholdHint: 'higher merges less',
    help: 'Merges two clusters whose reads are each other’s nearest neighbours (each read’s 15 most similar reads) '
      + 'more often than chance, like the neighbour graph the t-SNE map is drawn from: clusters that touch on the map '
      + 'tend to merge, separate islands stay apart. 1 = as linked as random reads would be (above it, joining the two '
      + 'clusters alone would raise the graph’s modularity).',
    min: 0.1, max: 3, step: 0.05, defaultThreshold: 1,
  },
  {
    value: 'js',
    label: 'Profile distance (Jensen–Shannon)',
    thresholdLabel: 'Largest distance',
    thresholdHint: '0–1; lower merges less',
    help: 'Merges two clusters whose per-position accessibility differs little on average (Jensen–Shannon '
      + 'distance below the cutoff). Small clusters are pulled toward the pair’s average first, so a few '
      + 'reads cannot look very different by chance.',
    min: 0.01, max: 0.6, step: 0.01, defaultThreshold: 0.1,
  },
  {
    value: 'correlation',
    label: 'Profile correlation',
    thresholdLabel: 'Correlation cutoff',
    thresholdHint: '0–1; higher merges less',
    help: 'Merges two clusters whose average profiles rise and fall together (Pearson correlation above the '
      + 'cutoff). Like cosine, but ignores how accessible both are overall.',
    min: 0, max: 1, step: 0.005, defaultThreshold: 0.95,
  },
];

export const DEFAULT_MERGE_STRATEGY: MergeStrategy = 'cosine';

export function mergeStrategyInfo(strategy: string | null | undefined): MergeStrategyInfo {
  return MERGE_STRATEGIES.find(s => s.value === strategy) ?? MERGE_STRATEGIES[0];
}

export function isMergeStrategy(value: unknown): value is MergeStrategy {
  return typeof value === 'string' && MERGE_STRATEGIES.some(s => s.value === value);
}

/** Thresholds per strategy (cosine's is mergeMaxSimilarity, kept apart for older sessions). */
export type MergeThresholds = Partial<Record<MergeStrategy, number>>;

export function clampMergeThreshold(strategy: MergeStrategy, value: number): number {
  const info = mergeStrategyInfo(strategy);
  return Math.min(info.max, Math.max(info.min, value));
}

/** The settings Merge similar clusters runs with (what the preview shows is what merges). */
export interface MergeSettings {
  minFraction: number;
  strategy: MergeStrategy;
  threshold: number;
  /** Sent as max_cosine_similarity (the cosine cutoff; older servers read only it). */
  maxSimilarity: number;
}

export function currentMergeSettings(s: {
  mergeMinFraction: number;
  mergeMaxSimilarity: number;
  mergeStrategy?: MergeStrategy;
  mergeThresholds?: MergeThresholds;
}): MergeSettings {
  const strategy = isMergeStrategy(s.mergeStrategy) ? s.mergeStrategy : DEFAULT_MERGE_STRATEGY;
  const threshold = strategy === 'cosine'
    ? s.mergeMaxSimilarity
    : (s.mergeThresholds?.[strategy] ?? mergeStrategyInfo(strategy).defaultThreshold);
  return { minFraction: s.mergeMinFraction, strategy, threshold, maxSimilarity: s.mergeMaxSimilarity };
}

/** "cosine > 0.95", "no position differs by ≥ 20%" — for titles, results and exports. */
export function describeMergeSettings(settings: { strategy: string; threshold: number; minFraction: number }): string {
  const t = settings.threshold;
  const rule = (() => {
    switch (settings.strategy) {
      case 'difference': return `no position differs by ${Math.round(t * 100)}% or more`;
      case 'connectivity': return `neighbour connectivity above ${t.toFixed(2)}`;
      case 'js': return `Jensen–Shannon distance below ${t.toFixed(2)}`;
      case 'correlation': return `correlation above ${t.toFixed(2)}`;
      default: return `similarity above ${t.toFixed(2)}`;
    }
  })();
  return `under ${Math.round(settings.minFraction * 100)}% of reads, then ${rule}`;
}
