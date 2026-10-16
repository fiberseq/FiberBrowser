export const READ_DEPTH_NAMES = ['max_discovery_molecules', 'max_quantification_molecules', 'sample_seed'] as const;
export type ReadDepth = Partial<Record<typeof READ_DEPTH_NAMES[number], number>>;

/** Only send supported, active budgets; zero preserves the original engine call. */
export function readDepthParameters(values: ReadDepth, supported: boolean): ReadDepth {
  return supported && (values.max_discovery_molecules || values.max_quantification_molecules)
    ? { max_discovery_molecules: values.max_discovery_molecules ?? 0,
      max_quantification_molecules: values.max_quantification_molecules ?? 0, sample_seed: values.sample_seed ?? 1 } : {};
}

export interface MoleculeSampling {
  phase?: string; window?: unknown; group?: string | number;
  max_discovery_molecules?: number; max_quantification_molecules?: number;
  strata: { stratum: string; available: number; discovery: number | null; quantification: number | null }[];
}

export interface LoaderSampling {
  dataset_id: string; reads_seen: number; eligible_reads: number; reads_decoded: number;
}

/** Report each engine window separately: overlapping read populations must not be added. */
export function readDepthNotes<T extends MoleculeSampling>(records: T[] = [], labels: Record<string, string> = {},
  loader: LoaderSampling[] = [], describe: (record: T) => { discoveryPurpose?: string; detail?: string } = () => ({})): string[] {
  const notes = records.flatMap(r => r.strata.flatMap(s => {
    const [dataset, channel] = s.stratum.split('::');
    const sampled = loader.some(l => l.dataset_id === dataset);
    const context = describe(r);
    return (['discovery', 'quantification'] as const).flatMap(phase => {
      const used = s[phase];
      const cap = r[phase === 'discovery' ? 'max_discovery_molecules' : 'max_quantification_molecules'] ?? 0;
      if (!cap || s.available <= cap || used == null || used >= s.available || (r.phase && r.phase !== phase)) return [];
      const window = r.window == null ? '' : ` · window ${typeof r.window === 'string' ? r.window : JSON.stringify(r.window)}`;
      return [`Used ${used.toLocaleString('en-US')} of ${s.available.toLocaleString('en-US')} ${sampled ? 'eligible reads in the decoded subset' : 'reads'} in ${labels[dataset] ?? dataset}${channel ? ` (${channel})` : ''} for ${phase === 'discovery' ? (context.discoveryPurpose ?? 'finding classes') : 'scoring'}${window}${context.detail ? ` · ${context.detail}` : ''}${r.group ? ` · ${r.group}` : ''}.`];
    });
  }));
  notes.push(...loader.map(l => `Loader sampling in ${labels[l.dataset_id] ?? l.dataset_id}: decoded ${l.reads_decoded.toLocaleString('en-US')} of ${l.eligible_reads.toLocaleString('en-US')} eligible reads (${l.reads_seen.toLocaleString('en-US')} reads seen). Read-cap denominators count eligible decoded molecules, not all reads in the dataset.`));
  return [...new Set(notes)];
}
