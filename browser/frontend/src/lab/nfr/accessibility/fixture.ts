// Test fixture: an Accessibility (preview) result shaped like fiberhmm-nfr's result.json (NAPA secondary NFR + a class).
import type { AccessibilityJob, AccessibilityResult, NfrVariant } from '../api';

const variant = (name: string, L: number, R: number, relation: string, prevalence: number, strict: number, ct: number, ga: number): NfrVariant => ({
  id: `N1:${name}`, nfr: 'N1', name, start: L, end: R, L, R, Lsd: 40, Rsd: 40, width: R - L, depth: R - L >= 175 ? 'pioneered' : 'sub-pioneered',
  relation, prevalence, strict, ci: [prevalence - 0.015, prevalence + 0.015], only: prevalence * 0.6, with_ref: 0, gain_nats: 900, stability: 0.99,
  exp_reads: 400, robust: null,
  by_channel: { 'ds1::CT': { n: 1455, em: ct, strict: ct - 0.02 }, 'ds1::GA': { n: 1206, em: ga, strict: ga - 0.02 } },
});

export const NFR_RESULT: AccessibilityResult = {
  schema: 'fiberhmm.accessibility.preview.v0', experimental: true, note: 'EXPERIMENTAL preview',
  region: { chrom: 'chr19', start: 47517650, end: 47518985 },
  datasets: [{ dataset_id: 'ds1', chemistry: 'ddda', molecules: 2753 }],
  parameters: { stringency: 0.9, mode: 'variants', elements: 'variants', min_fraction: 0.05 },
  detection: { method: 'enrichment', note: '', background: 0.0272, background_raw: 0.0272, enrichment_test: true, min_fraction: 0.05, min_fold: 2, q: 0.01, min_open_reads: 10 },
  nfrs: [{
    id: 'N1', start: 47518170, end: 47518510, source: 'detected', profile_peak: 0.3733, reads: 2753,
    detection: { peak: 0.3733, peak_at: 47518400, open_reads: 996, peak_callable: 2668, background: 0.0272, fold: 13.72, q: 0 }, callable: 2661, censored: 92, overflow_reads: 0,
    mode: 'variants', status: 'ok', message: '', k: 3, ps_curve: [[1, 1], [2, 0.95], [3, 0.93]], gaps: 2197, merges: [], dropped: [],
    closed: 0.2694, other: { em: 0.1658, strict: 0.11, ci: [0.15, 0.18] },
    variants: [
      variant('V1', 47518152.1, 47518247.1, 'alternative-left', 0.1811, 0.1593, 0.1653, 0.2002),
      variant('V2', 47518219.3, 47518458.9, 'full', 0.2907, 0.2679, 0.2966, 0.2837),
      variant('V3', 47518412.7, 47518513.7, 'alternative-right', 0.1876, 0.1524, 0.18, 0.19),
    ],
    configurations: [
      { label: 'V2', display_label: 'V2', weight: 0.2902, internal_footprint: null },
      { label: 'closed', display_label: 'closed', weight: 0.2694, internal_footprint: null },
      { label: 'V1+V3', display_label: 'V1+V3: full NFR with internal footprint (class_008)', weight: 0.0712, internal_footprint: ['class_008'] },
    ],
    depth_states: [],
  }],
  elements: [
    { id: 'N1:V1', kind: 'nfr', subtype: 'variant', nfr: 'N1', start: 47518152.1, end: 47518247.1, label: 'N1 V1 alternative-left', prevalence: 0.18, n: 2661 },
    { id: 'N1:V2', kind: 'nfr', subtype: 'variant', nfr: 'N1', start: 47518219.3, end: 47518458.9, label: 'N1 V2 full', prevalence: 0.29, n: 2661 },
    { id: 'class_008', kind: 'tf', subtype: 'class', class_id: 'class_008', start: 47518363, end: 47518386, label: 'class 008', prevalence: 0.3, n: 1100, channels: ['ds1::CT'] },
    { id: 'N1:V3', kind: 'nfr', subtype: 'variant', nfr: 'N1', start: 47518412.7, end: 47518513.7, label: 'N1 V3 alternative-right', prevalence: 0.19, n: 2661 },
  ],
  pairs: [
    { a: 'N1:V1', b: 'N1:V3', kind_a: 'nfr', kind_b: 'nfr', n: 2389, shared: 272, table: [198, 283, 288, 1620], log2or: 1.69, lo: 1.3, hi: 2.1,
      fisher_p: 1e-22, mh: 1.61, mh_lo: 1.3, mh_hi: 1.93, p_exact: 1e-22, q: 1.8e-21, class: 'co-accessible', adjust: 'openness x channel',
      null_median: 0.1, exp11: 120, nested: '', dist: 263 },
    { a: 'N1:V2', b: 'class_008', kind_a: 'nfr', kind_b: 'tf', n: 1081, shared: 0, table: [200, 100, 150, 631], log2or: 1.98, lo: 1.5, hi: 2.4,
      fisher_p: 1e-17, mh: 1.92, mh_lo: 1.49, mh_hi: 2.35, p_exact: 1e-17, q: 7.9e-17, class: 'co-accessible', adjust: 'openness x channel',
      null_median: 0.11, exp11: 110, nested: 'inside', dist: 35 },
    { a: 'N1:V1', b: 'class_008', kind_a: 'nfr', kind_b: 'tf', n: 1081, shared: 0, table: [10, 190, 300, 581], log2or: -2.4, lo: -3.3, hi: -1.5,
      fisher_p: 1e-9, mh: -2.44, mh_lo: -3.35, mh_hi: -1.53, p_exact: 1e-9, q: 6.7e-9, class: 'anti', adjust: 'openness x channel',
      null_median: -0.06, exp11: 40, nested: '', dist: 175 },
    { a: 'class_008', b: 'N1:V3', kind_a: 'tf', kind_b: 'nfr', n: 1000, shared: 0, table: [60, 240, 140, 560], log2or: 0.1, lo: -0.4, hi: 0.6,
      fisher_p: 0.6, mh: 0.05, mh_lo: -0.45, mh_hi: 0.55, p_exact: 0.6, q: 0.7, class: 'independence-compatible', adjust: 'openness x channel',
      null_median: 0, exp11: 60, nested: 'edge', dist: 88 },
  ],
  family: { tested: 4, scope: 'nfr', skipped: [{ a: 'N1:V1', b: 'N1:V2', reason: 'overlap' }, { a: 'N1:V2', b: 'N1:V3', reason: 'overlap' }], bh: 'all tested pairs of this run' },
  combos: null,
  class_join: { classes: 1, class_molecules: 2600, joined_molecules: 2600, molecules: 2753 },
  within_clusters: null,
  warnings: [],
};

export const COMPLETE_JOB: AccessibilityJob = {
  job_id: 'job12345abcdef', status: 'complete', stage: 'complete', message: 'NFR variants ready', class_job_id: 'class9876abcd',
  request: { dataset_ids: ['ds1'], chrom: 'chr19', start: 47517650, end: 47518985 }, payload_source: 'loaded', result: NFR_RESULT,
};
