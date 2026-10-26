import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import type { Dataset } from '../../types';
import type { DifferenceSelection } from '../liveLift/inspectionStore';
import { comparisonFor, comparisonKey, compareWithAssembly, LABEL_TEXT, linkText, useComparisonStore } from './comparison';

const LOCAL = ['insertion', 'deletion', 'replacement', 'snv', 'mnv'];

/** The lifted dataset a native dataset's inspector compares with, when the user picked one (native dataset id -> it). */
export const useMapChoice = create<{ byDataset: Record<string, string>; choose: (datasetId: string, mapId: string) => void }>(set => ({
  byDataset: {},
  choose: (datasetId, mapId) => set(s => ({ byDataset: { ...s.byDataset, [datasetId]: mapId } })),
}));

export interface MapOptions {
  /** The lifted dataset to compare with (null: none open, or the user has to pick). */
  map: Dataset | null;
  /** The lifted datasets the user can pick from (more than one: a picker is shown). */
  options: Dataset[];
  /** Why there is a choice: several lifted datasets of this sample, or none of this sample (only others). */
  reason: 'one' | 'several_of_sample' | 'none_of_sample' | 'unknown_samples' | 'none';
}

/** Which open lifted dataset's map is the assembly for a native dataset: the one of the same sample (its BAM read
 * groups), else the only one open when the samples can't be told; with several candidates the user picks. */
export function mapOptionsFor(dataset: Pick<Dataset, 'id' | 'data_type' | 'read_group_samples'>, datasets: Dataset[], chosen?: string): MapOptions {
  if (dataset.data_type === 'bam_livelift') {
    const own = datasets.find(d => d.id === dataset.id) ?? (dataset as Dataset);
    return { map: own, options: [own], reason: 'one' };
  }
  const lifted = datasets.filter(d => d.data_type === 'bam_livelift');
  if (!lifted.length) return { map: null, options: [], reason: 'none' };
  const mine = new Set(dataset.read_group_samples ?? []);
  const same = mine.size ? lifted.filter(d => (d.read_group_samples ?? []).some(s => mine.has(s))) : [];
  const known = mine.size > 0 && lifted.every(d => (d.read_group_samples ?? []).length > 0);
  const options = same.length ? same : lifted;
  const reason: MapOptions['reason'] = same.length === 1 ? 'one' : same.length > 1 ? 'several_of_sample'
    : known ? 'none_of_sample' : lifted.length === 1 ? 'one' : 'unknown_samples';
  const picked = chosen ? options.find(d => d.id === chosen) ?? lifted.find(d => d.id === chosen) : undefined;
  if (picked) return { map: picked, options: lifted.length > 1 || reason === 'none_of_sample' ? lifted : options, reason };
  return { map: reason === 'one' ? options[0] : null, options: reason === 'none_of_sample' ? lifted : options, reason };
}

export function useMapOptions(dataset: Dataset): MapOptions {
  const chosen = useMapChoice(s => s.byDataset[dataset.id]);
  const datasets = useBrowserStore(useShallow(s => s.datasets.filter(d => d.data_type === 'bam_livelift' || d.id === dataset.id)));
  return mapOptionsFor(datasets.find(d => d.id === dataset.id) ?? dataset, datasets, chosen);
}

/** The lifted dataset whose map is the assembly for this selection: the panel's own; for a native panel, the lifted
 * dataset of its sample (or the one the user picked). */
export function useMapDataset(dataset: Dataset): Dataset | null {
  return useMapOptions(dataset).map;
}

/** "Compared with: [lifted dataset ▾]" when a native dataset could use more than one lifted dataset's assembly. */
function MapPicker({ dataset, options }: { dataset: Dataset; options: MapOptions }) {
  const choose = useMapChoice(s => s.choose);
  if (dataset.data_type === 'bam_livelift' || options.options.length < 2 && options.reason !== 'none_of_sample') return null;
  const note = options.reason === 'several_of_sample' ? 'several live-lift datasets of this sample are open'
    : options.reason === 'none_of_sample' ? 'no live-lift dataset of this sample is open; another sample\'s assembly may differ'
      : 'the samples could not be told apart';
  return <p className="my-1 text-xs" data-testid="assembly-map-picker">
    <label>Compare with{' '}
      <select className="rounded border border-slate-300 bg-white px-1 text-xs dark:border-slate-600 dark:bg-slate-800" value={options.map?.id ?? ''}
        onChange={e => { if (e.target.value) choose(dataset.id, e.target.value); }} aria-label="Live-lift dataset to compare with">
        {!options.map && <option value="">choose a live-lift dataset…</option>}
        {options.options.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select></label>
    <span className="text-slate-500"> · {note}</span></p>;
}

export const inspectKey = (mapId: string, s: DifferenceSelection) => comparisonKey(mapId, s.chrom, `inspect:${s.difference.id}`);

/** Compare the inspected difference (and, with a consensus, its read sequence) and store the result. */
/** The read-discovery scope a comparison runs under: the same dataset/analysis namespace as the row's (so
 * identities and lineage match), and complete only when the caller's loaded calls say so. */
export function readScopeFor(selection: DifferenceSelection, map: Dataset, searchComplete = false) {
  const native = selection.datasetId !== map.id;
  return { search_complete: searchComplete, dataset_id: selection.datasetId, analysis_scope: native ? 'native_only' : 'lifted_only' };
}

export async function runInspectComparison(selection: DifferenceSelection, map: Dataset, readSequences?: Record<string, string>, signal?: AbortSignal,
  searchComplete = false) {
  const d = selection.difference;
  const reads = d.source === 'reads' ? [{ id: d.id, ref_start: d.t_start, ref_end: d.t_end, alt_bp: d.alt_bp,
    geometry_members: (d.target as { geometry_members?: { ref_start: number; ref_end: number; alt_bp: number }[] } | undefined)
      ?.geometry_members?.map(m => [m.ref_start, m.ref_end, m.alt_bp]) }] : [];
  const r = await compareWithAssembly({ dataset_id: map.id, chrom: selection.chrom, start: d.t_start - 2000, end: d.t_end + 2000,
    reads, read_sequences: readSequences, read_scope: readScopeFor(selection, map, searchComplete) }, signal);
  if (signal?.aborted) return r;
  if (!r.status) useComparisonStore.getState().put(inspectKey(map.id, selection), r);
  return r;
}

export function useInspectEntry(selection: DifferenceSelection, map: Dataset | null) {
  return useComparisonStore(s => map ? comparisonFor(s.byKey, `${map.id}|${selection.chrom}|`, selection.difference) : null);
}

/** One comparison for the inspected difference; a row comparison already covering it is reused. */
export function useInspectComparison(selection: DifferenceSelection, map: Dataset | null) {
  const d = selection.difference;
  const key = map ? inspectKey(map.id, selection) : '';
  const entry = useInspectEntry(selection, map);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = LOCAL.includes(d.kind);
  useEffect(() => {
    if (!map || entry || !supported) return;
    const controller = new AbortController();
    setBusy(true); setError('');
    runInspectComparison(selection, map, undefined, controller.signal)
      .then(r => { if (!controller.signal.aborted && r.status) setError(`${r.status}: ${r.reason}`); })
      .catch(e => { if (!controller.signal.aborted) setError(String((e as Error).message ?? e)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
    // Once per inspected difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { entry, error, busy, supported };
}

/** Inspector header section: the design's assembly labels, typed links and novelty reasons. */
export function AssemblyComparisonPanel({ selection, dataset }: { selection: DifferenceSelection; dataset: Dataset }) {
  const options = useMapOptions(dataset);
  const picker = <MapPicker dataset={dataset} options={options} />;
  return <>{picker}<AssemblyComparisonBody selection={selection} dataset={dataset} map={options.map} pick={options.options.length > 1 || options.reason === 'none_of_sample'} /></>;
}

function AssemblyComparisonBody({ selection, map, pick }: { selection: DifferenceSelection; dataset: Dataset; map: Dataset | null; pick: boolean }) {
  const { entry, error, busy, supported } = useInspectComparison(selection, map);
  const assembly = entry?.response.assembly ?? {};
  if (!supported) return <p data-testid="assembly-comparison">Assembly comparison: not available for this topology (geometry stays inspectable).</p>;
  if (!map && pick) return <p data-testid="assembly-comparison"><strong data-testid="assembly-comparison-label">{LABEL_TEXT.reads_only}</strong>
    {' '}· choose the live-lift dataset of this sample above to compare with its assembly.</p>;
  if (!map) return <p data-testid="assembly-comparison"><strong data-testid="assembly-comparison-label">{LABEL_TEXT.reads_only}</strong>
    {' '}· open a live-lift dataset on this genome to compare with its assembly.</p>;
  const d = selection.difference;
  if (!entry && !busy && !error && Math.max(d.ref_bp, d.alt_bp) < 10)
    return <p data-testid="assembly-comparison">Assembly comparison: not assessed under 10 bp (the read-evidence floor); the assembly bases are shown below.</p>;
  if (!entry) return <p data-testid="assembly-comparison" role="status">{error || (busy ? 'Comparing with the assembly…' : 'Assembly comparison: not available for this difference here.')}</p>;
  if (entry.kind === 'assembly') {
    const v = entry.value;
    const shared = v.shared_with.map(id => assembly[id]?.hap_label).filter(Boolean);
    const counts = { exact: 0, approximate: 0, candidate: 0 };
    for (const l of v.read_links) counts[l.relation]++;
    return <div data-testid="assembly-comparison" className="my-1">
      <p>Assembly observation · <span data-testid="assembly-identity-state">{v.identity_state}</span> identity
        {v.exact_allele_id && <span title={v.exact_allele_id}> · allele {v.exact_allele_id.slice(-10)}</span>}
        {' '}· {v.sequence_status === 'available' ? 'full sequence' : 'sequence unavailable (no source FASTA)'}
        {shared.length > 0 && <> · <span data-testid="assembly-shared">same allele as {shared.join(', ')} (exact)</span></>}</p>
      {v.read_links.length > 0 && <p data-testid="assembly-read-links">Read differences: {counts.exact} confirmed by assembly · {counts.approximate} assembly-supported (approximate) · {counts.candidate} candidates</p>}
      {entry.response.reasons.length > 0 && <p className="text-slate-500">Comparison notes: {entry.response.reasons.join(', ').replace(/_/g, ' ')}</p>}
    </div>;
  }
  const v = entry.value;
  return <div data-testid="assembly-comparison" className="my-1">
    <p><strong data-testid="assembly-comparison-label" data-label={v.label}>{v.label_text}</strong>
      {v.identity_state && <> · {v.identity_state} identity</>}
      {v.sequence_source === 'consensus' && <> · compared using the reads' consensus</>}</p>
    {v.links.length > 0 && <ul className="list-disc ml-4">{v.links.map((l, i) => <li key={i} data-relation={l.relation}>{linkText(l)}</li>)}</ul>}
    {v.label !== 'confirmed_by_assembly' && v.novelty.reasons.length > 0 &&
      <p className="text-slate-500" data-testid="assembly-novelty">Why not more: {v.novelty.reasons.join(', ').replace(/_/g, ' ')}</p>}
  </div>;
}
