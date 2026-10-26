import { useEffect, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { Dataset } from '../../types';
import type { DifferenceSelection } from '../liveLift/inspectionStore';
import { comparisonFor, comparisonKey, compareWithAssembly, LABEL_TEXT, linkText, useComparisonStore } from './comparison';

const LOCAL = ['insertion', 'deletion', 'replacement', 'snv', 'mnv'];

/** The lifted dataset whose map is the assembly for this selection: the panel's own, else the first open one. */
export function useMapDataset(dataset: Dataset): Dataset | null {
  return useBrowserStore(s => dataset.data_type === 'bam_livelift' ? dataset
    : s.datasets.find(d => d.data_type === 'bam_livelift') ?? null);
}

export const inspectKey = (mapId: string, s: DifferenceSelection) => comparisonKey(mapId, s.chrom, `inspect:${s.difference.id}`);

/** Compare the inspected difference (and, with a consensus, its read sequence) and store the result. */
export async function runInspectComparison(selection: DifferenceSelection, map: Dataset, readSequences?: Record<string, string>, signal?: AbortSignal) {
  const d = selection.difference;
  const reads = d.source === 'reads' ? [{ id: d.id, ref_start: d.t_start, ref_end: d.t_end, alt_bp: d.alt_bp,
    geometry_members: (d.target as { geometry_members?: { ref_start: number; ref_end: number; alt_bp: number }[] } | undefined)
      ?.geometry_members?.map(m => [m.ref_start, m.ref_end, m.alt_bp]) }] : [];
  const r = await compareWithAssembly({ dataset_id: map.id, chrom: selection.chrom, start: d.t_start - 2000, end: d.t_end + 2000,
    reads, read_sequences: readSequences }, signal);
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
  const map = useMapDataset(dataset);
  const { entry, error, busy, supported } = useInspectComparison(selection, map);
  const assembly = entry?.response.assembly ?? {};
  if (!supported) return <p data-testid="assembly-comparison">Assembly comparison: not available for this topology (geometry stays inspectable).</p>;
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
