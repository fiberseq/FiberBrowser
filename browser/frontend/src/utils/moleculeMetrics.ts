/**
 * Per-molecule scalars a `molecule_metric` rule term can name (the scan modules' scalar groups nucmol / nfrmol;
 * GET /api/nuc/metrics). The static list is the fallback when the call fails, and the source of the short names
 * auto names use (they must not wait on the network).
 */
import { fetchJson } from '../api/sharedFetch';

export type MoleculeMetricGroup = 'nucmol' | 'nfrmol';

export interface MoleculeMetric {
  id: string;
  group: MoleculeMetricGroup;
  module: 'nuc' | 'nfr';
  name: string;
  label: string;
  unit: string;
}

const nuc = (name: string, label: string, unit: string): MoleculeMetric =>
  ({ id: `nuc.${name}`, group: 'nucmol', module: 'nuc', name, label, unit });
const nfr = (name: string, label: string, unit: string): MoleculeMetric =>
  ({ id: `nfr.${name}`, group: 'nfrmol', module: 'nfr', name, label, unit });

export const MOLECULE_METRICS: readonly MoleculeMetric[] = [
  nuc('nrl', 'Repeat length (NRL)', 'bp'),
  nuc('regularity', 'Regularity S', 'acf'),
  nuc('spectral_snr', 'Spectral SNR', 'ratio'),
  nuc('gap_cv', 'Dyad gap CV', 'ratio'),
  nuc('lambda_acc', 'Accessible marking rate λ', 'fraction'),
  nuc('rho_read', 'Marks per site (read)', 'fraction'),
  nuc('n_dyads', 'Dyads', 'count'),
  nuc('n_short', 'Short footprints', 'count'),
  nuc('n_mono', 'Mono footprints', 'count'),
  nuc('n_long', 'Long footprints', 'count'),
  nuc('n_multi', 'Multi footprints', 'count'),
  nuc('n_cant_tell', "Can't-tell footprints", 'count'),
  nuc('reg_fraction', 'Regular fraction', 'fraction'),
  nuc('disordered_fraction', 'Disordered fraction', 'fraction'),
  nuc('undetermined_fraction', 'Undetermined fraction', 'fraction'),
  nuc('undersized_fraction', 'Undersized fraction', 'fraction'),
  nuc('n_missing', 'Missing nucleosomes', 'count'),
  nfr('openness', 'Openness', 'fraction'),
  nfr('n_nfr', 'NFRs (linkers ≥ 175 bp)', 'count'),
  nfr('longest_linker', 'Longest linker', 'bp'),
];

export const MOLECULE_METRIC_GROUPS: ReadonlyArray<{ group: MoleculeMetricGroup; label: string }> = [
  { group: 'nucmol', label: 'Nucleosome' },
  { group: 'nfrmol', label: 'NFR' },
];

export const DEFAULT_MOLECULE_METRIC = 'nuc.nrl';

/** Short names for rule names ("NRL between 185 and 195 bp"). */
const SHORT_NAMES: Record<string, string> = {
  'nuc.nrl': 'NRL',
  'nuc.regularity': 'Regularity S',
  'nuc.spectral_snr': 'Spectral SNR',
  'nuc.gap_cv': 'Dyad gap CV',
  'nuc.lambda_acc': 'λ acc',
  'nuc.rho_read': 'Marks per site',
  'nuc.n_dyads': 'Dyads',
  'nuc.n_short': 'Short FPs',
  'nuc.n_mono': 'Mono FPs',
  'nuc.n_long': 'Long FPs',
  'nuc.n_multi': 'Multi FPs',
  'nuc.n_cant_tell': "Can't-tell FPs",
  'nuc.reg_fraction': 'Regular fraction',
  'nuc.disordered_fraction': 'Disordered fraction',
  'nuc.undetermined_fraction': 'Undetermined fraction',
  'nuc.undersized_fraction': 'Undersized fraction',
  'nuc.n_missing': 'Missing nucs',
  'nfr.openness': 'Openness',
  'nfr.n_nfr': 'NFRs',
  'nfr.longest_linker': 'Longest linker',
};

export function moleculeMetricInfo(id: string | null | undefined): MoleculeMetric | undefined {
  return id ? MOLECULE_METRICS.find(metric => metric.id === id) : undefined;
}

export function moleculeMetricShortName(id: string | null | undefined): string {
  if (!id) return 'Molecule metric';
  return SHORT_NAMES[id] ?? moleculeMetricInfo(id)?.label ?? id.split('.').slice(-1)[0] ?? id;
}

export function moleculeMetricUnit(id: string | null | undefined): string {
  return moleculeMetricInfo(id)?.unit ?? '';
}

/** The unit a value is written with in a name: lengths only (counts and fractions read as plain numbers). */
export function moleculeMetricUnitSuffix(id: string | null | undefined): string {
  return moleculeMetricUnit(id) === 'bp' ? ' bp' : '';
}

/** The metrics from a /api/nuc/metrics payload (null when malformed). */
export function normalizeMoleculeMetrics(payload: unknown): MoleculeMetric[] | null {
  const list = payload && typeof payload === 'object' ? (payload as { metrics?: unknown }).metrics : undefined;
  if (!Array.isArray(list)) return null;
  const out: MoleculeMetric[] = [];
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const group: MoleculeMetricGroup = m.group === 'nfrmol' ? 'nfrmol' : 'nucmol';
    out.push({
      id: m.id,
      group,
      module: m.module === 'nfr' || group === 'nfrmol' ? 'nfr' : 'nuc',
      name: typeof m.name === 'string' ? m.name : m.id.split('.').slice(-1)[0],
      label: typeof m.label === 'string' && m.label ? m.label : moleculeMetricInfo(m.id)?.label ?? m.id,
      unit: typeof m.unit === 'string' ? m.unit : moleculeMetricUnit(m.id),
    });
  }
  return out.length ? out : null;
}

let pending: Promise<MoleculeMetric[]> | null = null;

/** The server's metric list, once per page; the static list when the call fails. */
export function fetchMoleculeMetrics(): Promise<MoleculeMetric[]> {
  if (!pending) {
    pending = fetchJson<unknown>('/api/nuc/metrics')
      .then(payload => normalizeMoleculeMetrics(payload) ?? [...MOLECULE_METRICS])
      .catch(() => {
        // Asked again next time (the server may come up later).
        pending = null;
        return [...MOLECULE_METRICS];
      });
  }
  return pending;
}
