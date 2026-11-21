/**
 * The meta-locus in the page's address (so a reload, or a copied link, opens it again): the BED's path and content
 * hash, anchor, flank, datasets, seed, working-set size and the real locus Back returns to. Pure helpers on
 * URLSearchParams; the store restores from them (restoreMetaLocusFromUrl).
 */
import type { MetaLocusSpec } from './api';

export const META_URL_KEYS = ['ml_bed', 'ml_sha', 'ml_anchor', 'ml_flank', 'ml_ds', 'ml_seed', 'ml_count', 'ml_back'] as const;

export interface MetaUrlState {
  spec: MetaLocusSpec;
  sha?: string;
  seed: number;
  count: number;
  back?: { chrom: string; start: number; end: number } | null;
}

/** `params` with the meta-locus written in (or every meta key removed, for null). */
export function withMetaUrlParams(params: URLSearchParams, state: MetaUrlState | null): URLSearchParams {
  for (const key of META_URL_KEYS) params.delete(key);
  if (!state) return params;
  params.set('ml_bed', state.spec.bed_path);
  if (state.sha) params.set('ml_sha', state.sha);
  params.set('ml_anchor', state.spec.anchor);
  params.set('ml_flank', String(state.spec.flank_bp));
  if (state.spec.dataset_ids?.length) params.set('ml_ds', state.spec.dataset_ids.join(','));
  params.set('ml_seed', String(state.seed));
  params.set('ml_count', String(state.count));
  if (state.back) params.set('ml_back', `${state.back.chrom}:${state.back.start}-${state.back.end}`);
  return params;
}

function parseLocus(text: string | null): { chrom: string; start: number; end: number } | null {
  const m = text?.match(/^(.+):(\d+)-(\d+)$/);
  if (!m) return null;
  const start = Number(m[2]);
  const end = Number(m[3]);
  return end > start ? { chrom: m[1], start, end } : null;
}

/** The address's seed (0 kept); 1 only when missing or not a number. */
function parseUrlSeed(raw: string | null): number {
  if (raw == null || raw === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
}

/** The meta-locus an address names, or null (no BED path in it). */
export function parseMetaUrl(params: URLSearchParams): MetaUrlState | null {
  const bed = params.get('ml_bed');
  if (!bed) return null;
  const anchor = params.get('ml_anchor');
  const flank = Number(params.get('ml_flank'));
  const ds = params.get('ml_ds');
  return {
    spec: {
      bed_path: bed,
      anchor: anchor === 'start' || anchor === 'end' ? anchor : 'centre',
      flank_bp: Number.isFinite(flank) && flank > 0 ? flank : 10_000,
      ...(ds ? { dataset_ids: ds.split(',').filter(Boolean) } : {}),
    },
    sha: params.get('ml_sha') || undefined,
    seed: parseUrlSeed(params.get('ml_seed')),
    count: Number(params.get('ml_count')) || 2000,
    back: parseLocus(params.get('ml_back')),
  };
}
