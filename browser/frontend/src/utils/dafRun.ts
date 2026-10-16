/**
 * "New DAF-seq run" wizard state: reads -> samples, reference, enzyme and
 * options, output folder. Pure functions (tested in dafRun.test.ts); the
 * server validates again before anything runs (routers/pipeline.py).
 */
import type {
  BasecallSettings, DetectedSample, Enzyme, InputKind, PipelineOptions, PipelineStatus, ReadFileEntry, RunRequest,
  ScanResult,
} from '../api/pipeline';

export const WIZARD_STEPS = ['Reads', 'Reference', 'Run'] as const;
export type WizardStep = 0 | 1 | 2;

/** The wizard's chemistries. ``rawOnly``: offered for raw Nanopore (POD5) input only. */
export const ENZYME_INFO: Record<Enzyme, { label: string; line: string; rawOnly?: boolean }> = {
  dddb: {
    label: 'DddB',
    line: 'Deaminates C on both strands; the recommended DAF-seq enzyme (e.g. a Plasmidsaurus Nanopore run).',
  },
  ddda: {
    label: 'DddA',
    line: 'Deaminates C in a TC context, one strand per molecule; for DddA/SsDddA libraries.',
  },
  hia5: {
    label: 'Hia5 (Fiber-seq)',
    line: 'm6A Fiber-seq on Nanopore: basecalled with dorado sup and the 6mA modification model.',
    rawOnly: true,
  },
};

/** The enzymes offered for this input. */
export function enzymesFor(inputKind: InputKind): Enzyme[] {
  return (Object.keys(ENZYME_INFO) as Enzyme[]).filter(id => inputKind === 'pod5' || !ENZYME_INFO[id].rawOnly);
}

/** The pipeline's own basecalling defaults: no --dorado-* flag is passed for them. */
export const DEFAULT_BASECALL: BasecallSettings = { model: 'sup', modified_bases: 'auto', device: 'auto', batchsize: null };

export const BASECALL_MODELS = [
  { id: 'sup', label: 'sup: most accurate (default)' },
  { id: 'hac', label: 'hac: faster' },
  { id: 'fast', label: 'fast: fastest, least accurate' },
];
export const BASECALL_DEVICES = [
  { id: 'auto', label: 'Automatic (default)' },
  { id: 'metal', label: 'Apple GPU (metal)' },
  { id: 'cuda:all', label: 'NVIDIA GPUs (cuda:all)' },
  { id: 'cpu', label: 'CPU (very slow)' },
];

/** What dorado will call besides the bases, in words (for the summary line). */
export function basecallSummary(basecall: BasecallSettings, enzyme: Enzyme | ''): string {
  const [model, complex] = basecall.model.split(',', 2);
  const extra = [basecall.device !== 'auto' ? basecall.device : '', basecall.batchsize ? `batch ${basecall.batchsize}` : '']
    .filter(Boolean).join(', ');
  const tail = extra ? ` · ${extra}` : '';
  let mods: string | null;
  if (complex) mods = complex;
  else if (basecall.modified_bases === 'auto') {
    if (!enzyme) return `dorado ${model || 'sup'} (+ 6mA for Hia5)${tail}`;
    mods = enzyme === 'hia5' ? '6mA' : null;
  } else mods = basecall.modified_bases === 'none' ? null : basecall.modified_bases;
  return `dorado ${model || 'sup'}${mods ? ` + ${mods}` : ' (no modification model)'}${tail}`;
}

/** DAF-seq's calling options: not shown (nor sent) for Hia5. */
export const DAF_ONLY_OPTIONS: (keyof PipelineOptions)[] = [
  'dedup', 'dedup_mode', 'snp_screen', 'snp_mask', 'chimera_filter', 'use_m5c', 'cpg_mask_policy',
];

export const DEFAULT_OPTIONS: PipelineOptions = {
  dedup: 'auto',
  dedup_mode: 'flag',
  snp_screen: 'auto',
  snp_mask: '',
  chimera_filter: true,
  alignments: 'primary-supplementary',
  prob_threshold: null,
  use_m5c: 'auto',
  cpg_mask_policy: 'unmethylated-only',
};

export interface WizardSample {
  key: string;
  name: string;
  include: boolean;
  files: ReadFileEntry[];
  order: string | null;
  barcode: string | null;
  size: number;
}

export interface WizardState {
  step: WizardStep;
  /** reads: FASTQ/BAM; pod5: raw Nanopore, basecalled with dorado first. */
  inputKind: InputKind;
  basecall: BasecallSettings;
  inputPaths: string[];
  samples: WizardSample[];
  scanWarnings: string[];
  referenceMode: 'genome' | 'file';
  genomeId: string;
  referencePath: string;
  regionsText: string;
  enzyme: Enzyme | '';
  outputRoot: string;
  /** The user edited the output folder: stop deriving it from the sample names. */
  outputTouched: boolean;
  cores: number;
  options: PipelineOptions;
  autoOpen: boolean;
}

export function initialWizardState(status?: Pick<PipelineStatus, 'default_cores' | 'current_genome' | 'genomes'> | null,
  autoOpen = true): WizardState {
  const loadedGenome = status?.genomes?.find(g => g.id === status.current_genome);
  return {
    step: 0,
    inputKind: 'reads',
    basecall: { ...DEFAULT_BASECALL },
    inputPaths: [],
    samples: [],
    scanWarnings: [],
    referenceMode: loadedGenome ? 'genome' : 'file',
    genomeId: loadedGenome?.id ?? '',
    referencePath: '',
    regionsText: '',
    enzyme: '',
    outputRoot: '',
    outputTouched: false,
    cores: status?.default_cores ?? 4,
    options: { ...DEFAULT_OPTIONS },
    autoOpen,
  };
}

export function samplesFromScan(scan: ScanResult, previous: WizardSample[] = []): WizardSample[] {
  const renamed = new Map(previous.map(s => [s.key, s]));
  return (scan.samples ?? []).map((s: DetectedSample) => ({
    key: s.key,
    name: renamed.get(s.key)?.name ?? s.name,
    include: renamed.get(s.key)?.include ?? true,
    files: s.files,
    order: s.order,
    barcode: s.barcode,
    size: s.size,
  }));
}

const SAMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function sampleNameError(name: string, others: string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the sample a name.';
  if (!SAMPLE_NAME.test(trimmed)) return 'Letters, digits, . _ - only (no spaces), up to 80 characters.';
  if (others.some(o => o.trim().toLowerCase() === trimmed.toLowerCase())) return 'Another sample has this name.';
  return null;
}

/** "chr2L:1,000-5,000" lines (or comma/space separated) -> normalized regions and errors. */
export function parseRegionsText(text: string): { regions: string[]; errors: string[] } {
  const regions: string[] = [];
  const errors: string[] = [];
  // Regions never contain spaces; commas inside numbers are thousands separators.
  for (const raw of text.split(/[\s;]+/)) {
    const item = raw.trim().replace(/,+$/, '');
    if (!item) continue;
    const m = item.match(/^([^\s:]+):([\d,]+)-([\d,]+)$/);
    if (!m) {
      errors.push(`"${item}" is not chrom:start-end`);
      continue;
    }
    const start = Number(m[2].replace(/,/g, ''));
    const end = Number(m[3].replace(/,/g, ''));
    if (!(end > start)) {
      errors.push(`"${item}" ends before it starts`);
      continue;
    }
    regions.push(`${m[1]}:${start}-${end}`);
  }
  return { regions, errors };
}

export function includedSamples(state: WizardState): WizardSample[] {
  return state.samples.filter(s => s.include);
}

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'run';
}

/** ~/FiberHMM runs/<date>_<sample> (one sample) or <date>_<order id | run> (several). */
export function defaultOutputRoot(parent: string, samples: WizardSample[], date: Date = new Date()): string {
  const included = samples.filter(s => s.include);
  let name = 'run';
  if (included.length === 1) name = included[0].name;
  else if (included.length > 1) {
    const orders = new Set(included.map(s => s.order).filter(Boolean));
    name = orders.size === 1 ? `${[...orders][0]}` : 'run';
  }
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${sep}${isoDate(date)}_${safeName(name)}`;
}

/** Where each sample's results go (as the server lays them out). */
export function sampleOutdir(root: string, sample: string, nSamples: number): string {
  if (nSamples <= 1) return root;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${sample}`;
}

/** One thing that keeps the user on a step. ``missing``: a required input not
 * given yet (shown as neutral help until the user tries to go on); otherwise
 * an input that is wrong (always shown as an error). */
export interface StepIssue { message: string; missing: boolean }

/** Problems that keep the user on this step (the server re-checks everything). */
export function stepIssues(state: WizardState, step: WizardStep, status?: Pick<PipelineStatus, 'cores' | 'genomes'> | null): StepIssue[] {
  const issues: StepIssue[] = [];
  const missing = (message: string) => issues.push({ message, missing: true });
  const invalid = (message: string) => issues.push({ message, missing: false });
  if (step === 0) {
    const included = includedSamples(state);
    if (included.length === 0) {
      missing(state.inputKind === 'pod5'
        ? 'Add raw Nanopore data: a POD5 folder (e.g. MinKNOW\'s pod5/) or POD5 files.'
        : 'Add reads: FASTQ files, a folder or a Plasmidsaurus .zip.');
    }
    included.forEach((s, i) => {
      const others = included.filter((_, j) => j !== i).map(o => o.name);
      const problem = sampleNameError(s.name, others);
      if (problem) invalid(`${s.name || `Sample ${i + 1}`}: ${problem}`);
      if (s.files.length === 0) invalid(`${s.name}: no read files.`);
    });
  } else if (step === 1) {
    if (state.referenceMode === 'genome') {
      if (!state.genomeId) missing('Choose a genome.');
      else {
        const genome = status?.genomes?.find(g => g.id === state.genomeId);
        if (genome && !genome.downloaded) invalid(`${genome.name} is not downloaded yet: click Download first.`);
      }
    } else if (!state.referencePath.trim()) {
      missing('Choose a reference FASTA or a plasmid map.');
    } else if (!/\.(fa|fasta|fna)(\.gz)?$|\.(dna|gb|gbk|genbank|embl)$/i.test(state.referencePath.trim())) {
      invalid('The reference is a FASTA (.fa, .fasta, .fna) or a plasmid map (.dna, .gb, .gbk, .embl).');
    }
    parseRegionsText(state.regionsText).errors.forEach(invalid);
  } else {
    if (!state.enzyme) missing('Choose the enzyme.');
    else if (!enzymesFor(state.inputKind).includes(state.enzyme)) {
      invalid(`${ENZYME_INFO[state.enzyme].label} runs start from raw Nanopore (POD5) here; choose DddB or DddA.`);
    }
    if (state.inputKind === 'pod5') {
      const batch = state.basecall.batchsize;
      if (batch !== null && (!Number.isInteger(batch) || batch < 1 || batch > 100000)) invalid('Batch size: a whole number from 1 to 100000 (blank: dorado chooses).');
      if (!state.basecall.model.trim() || state.basecall.model.trim().startsWith('-')) invalid('Basecalling model: fast, hac or sup, or a dorado model folder.');
    }
    if (!state.outputRoot.trim()) missing('Choose an output folder.');
    const maxCores = status?.cores ?? 64;
    if (!Number.isInteger(state.cores) || state.cores < 1 || state.cores > maxCores) {
      invalid(`Cores: 1 to ${maxCores}.`);
    }
    const t = state.options.prob_threshold;
    if (t !== null && (!Number.isInteger(t) || t < 0 || t > 255)) invalid('ML threshold: 0 to 255.');
    if (state.options.snp_mask && !/\.bed(\.gz)?$/i.test(state.options.snp_mask)) invalid('The SNP mask is a BED file.');
  }
  return issues;
}

export function stepErrors(state: WizardState, step: WizardStep, status?: Pick<PipelineStatus, 'cores' | 'genomes'> | null): string[] {
  return stepIssues(state, step, status).map(issue => issue.message);
}

export function buildRunRequest(state: WizardState): RunRequest {
  let reference: RunRequest['reference'] = {};
  if (state.referenceMode === 'genome' && state.genomeId) reference = { kind: 'genome', genome_id: state.genomeId };
  else if (state.referenceMode === 'file' && state.referencePath.trim()) reference = { kind: 'file', path: state.referencePath.trim() };
  return {
    samples: includedSamples(state).map(s => ({ name: s.name.trim(), files: s.files })),
    reference,
    regions: parseRegionsText(state.regionsText).regions,
    enzyme: (state.enzyme || 'dddb') as Enzyme,
    output_root: state.outputRoot.trim(),
    cores: state.cores,
    options: state.enzyme === 'hia5'
      ? { ...state.options, ...Object.fromEntries(DAF_ONLY_OPTIONS.map(k => [k, DEFAULT_OPTIONS[k]])) } as PipelineOptions
      : state.options,
    auto_open: state.autoOpen,
    input_kind: state.inputKind,
    ...(state.inputKind === 'pod5' ? { basecall: { ...state.basecall, model: state.basecall.model.trim() || 'sup' } } : {}),
  };
}

/** The options that differ from fiberhmm-call's defaults, in words. */
export function changedOptionLabels(options: PipelineOptions, enzyme: Enzyme | ''): string[] {
  const labels: string[] = [];
  if (enzyme === 'hia5') {  // DAF-seq's options do not apply
    if (options.alignments === 'primary') labels.push('primary alignments only');
    else if (options.alignments === 'all') labels.push('all alignments');
    if (options.prob_threshold !== null) labels.push(`ML threshold ${options.prob_threshold}`);
    return labels;
  }
  if (options.dedup !== 'auto') labels.push(`duplicates ${options.dedup}`);
  if (options.dedup_mode === 'collapse' && options.dedup !== 'off') labels.push('collapse duplicates');
  if (options.snp_screen !== 'auto') labels.push(`SNP screen ${options.snp_screen}`);
  if (options.snp_mask) labels.push('SNP mask');
  if (!options.chimera_filter) labels.push('keep chimeras');
  if (options.alignments === 'primary') labels.push('primary alignments only');
  else if (options.alignments === 'all') labels.push('all alignments');
  if (options.prob_threshold !== null) labels.push(`ML threshold ${options.prob_threshold}`);
  if (enzyme === 'ddda' && options.use_m5c !== 'auto') labels.push(`CpG-aware recall ${options.use_m5c}`);
  if (enzyme === 'ddda' && options.cpg_mask_policy !== 'unmethylated-only') labels.push(`CpG mask ${options.cpg_mask_policy}`);
  return labels;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
