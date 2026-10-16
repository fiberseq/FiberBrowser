/**
 * Basecaller provenance in words (FiberHMM 3.0: outputs.json ``settings.basecaller``, the
 * BAM's @PG DS tokens, read by the server into a Library entry's ``basecaller``).
 *
 * "dorado 2.0.1 · sup v5.2.0 · 6mA v1"; ``modbase_models`` null = unknown, [] = none.
 */

export interface BasecallerInfo {
  available?: boolean;
  program?: string | null;
  version?: string | null;
  basecall_model?: string | null;
  modbase_models?: string[] | null;
  platform?: string | null;
  sources?: Record<string, string>;
  /** Where FiberBrowser read it: outputs.json or the BAM header. */
  source?: string;
  /** A field came from --basecaller-info / --modbase-model (now or in an earlier run). */
  overridden?: boolean;
}

const SPEED = /(?:^|_)(fast|hac|sup)@v(\d+(?:\.\d+)*)$/;
const MODBASE = /^(.+?)@v(\d+(?:\.\d+)*)$/;

/** ``dna_r10.4.1_e8.2_400bps_sup@v5.2.0`` -> ``sup v5.2.0``; anything else as it is. */
export function shortModel(model: string): string {
  const m = model.trim().match(SPEED);
  return m ? `${m[1]} v${m[2]}` : model.trim();
}

/** ``dna_r10.4.1_e8.2_400bps_sup@v5.2.0_6mA@v1`` -> ``6mA v1`` (the part after its basecall model). */
export function shortModbase(model: string, basecallModel?: string | null): string {
  let rest = model.trim();
  if (basecallModel && rest.startsWith(`${basecallModel}_`)) rest = rest.slice(basecallModel.length + 1);
  else {
    const speed = rest.match(/^(?:.*_)?(?:fast|hac|sup)@v\d+(?:\.\d+)*_(.+)$/);
    if (speed) rest = speed[1];
  }
  const m = rest.match(MODBASE);
  return m ? `${m[1]} v${m[2]}` : rest;
}

/** One line: program and version, basecall model, modification model(s); "unknown" when nothing is known. */
export function basecallerLabel(info: BasecallerInfo | null | undefined): string {
  if (!info || !info.available) return 'unknown';
  const parts: string[] = [];
  const head = [info.program, info.version].filter(Boolean).join(' ');
  parts.push(head || 'basecaller unknown');
  if (info.basecall_model) parts.push(info.basecall_model.split(',').map(shortModel).join(', '));
  if (info.modbase_models === null || info.modbase_models === undefined) parts.push('modbase model unknown');
  else if (info.modbase_models.length === 0) parts.push('no modbase model');
  else parts.push(info.modbase_models.map(m => shortModbase(m, info.basecall_model)).join(', '));
  return parts.join(' · ');
}

const SOURCE_WORDS: Record<string, string> = {
  override: 'given with --basecaller-info / --modbase-model',
  'recorded-override': 'given to an earlier FiberHMM run',
  rg_ds: '@RG DS',
  pg: "the basecaller's @PG",
  pg_cl: "the basecaller's command line",
  read_rg: 'read groups',
  recorded: "FiberHMM's @PG",
};

/** The full names and where each field came from (a tooltip). */
export function basecallerTitle(info: BasecallerInfo | null | undefined): string {
  if (!info || !info.available) {
    return 'The basecaller is not recorded (FASTQ input, or a BAM without the basecaller\'s @PG/@RG lines). '
      + 'Give it to fiberhmm-pipeline with --basecaller-info / --modbase-model.';
  }
  const lines: string[] = [];
  if (info.program) lines.push(`Program: ${[info.program, info.version].filter(Boolean).join(' ')}`);
  if (info.basecall_model) lines.push(`Basecall model: ${info.basecall_model}`);
  if (info.modbase_models) lines.push(`Modification model: ${info.modbase_models.length ? info.modbase_models.join(', ') : 'none'}`);
  const sources = Object.entries(info.sources ?? {}).map(([field, code]) => `${field.replace(/_/g, ' ')}: ${SOURCE_WORDS[code] ?? code}`);
  if (sources.length) lines.push(`From ${sources.join('; ')}`);
  if (info.source) lines.push(`Read from ${info.source}`);
  return lines.join('\n');
}
