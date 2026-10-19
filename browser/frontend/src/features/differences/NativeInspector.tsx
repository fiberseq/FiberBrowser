import { useEffect, useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Dataset, PanelConfig } from '../../types';
import { fetchJson } from '../../api/sharedFetch';
import { useDifferenceSelection, expandDifference, type DifferenceSelection } from '../liveLift/inspectionStore';
import { expandableAltBlock } from './capabilities';
import { frozenTarget } from './selection';
import { getAlternateBlocks, type AlternateBlock, type WorkspaceQuery } from './api';
import { MoleculeCalls } from './MoleculeCalls';
import { IdentifyTab, identifyLens } from '../insertion/IdentifyTab';
import type { LensResponse } from '../insertion/insertionLensModel';

export function NativeInspector({ selection, panel: _panel, dataset, anchor }: {
  selection: DifferenceSelection; panel: PanelConfig; dataset: Dataset; anchor: RefObject<HTMLDivElement | null>;
}) {
  const d = selection.difference;
  const target = useMemo(() => frozenTarget(selection), [selection]);
  const [blocks, setBlocks] = useState<AlternateBlock[] | null>(null);
  const [sequence, setSequence] = useState<string | null>(null);
  const [identify, setIdentify] = useState(false);
  const [load, setLoad] = useState(selection.action === 'identify' ? 1 : 0);
  const [error, setError] = useState('');
  const q = useMemo<WorkspaceQuery>(() => ({ dataset_id: dataset.id, chrom: selection.chrom,
    start: Math.max(0, d.t_start-1000), end: d.t_end+1000, target }), [dataset.id, selection.chrom, d, target]);
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController(); setBlocks(null); setError('');
    void getAlternateBlocks(q, undefined, ['nuc', 'tf', 'msp', 'm6a'], selection.evidencePolicy?.include_duplicates ?? false, controller.signal, true)
      .then(r => { if (!controller.signal.aborted) r.complete ? setBlocks(r.blocks ?? []) : setError(`${r.status}: ${r.reason}`); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [q, load, selection.evidencePolicy]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') useDifferenceSelection.getState().select(null); };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  const [sequenceRequest, setSequenceRequest] = useState<AlternateBlock | null>(null);
  useEffect(() => {
    if(selection.action === 'identify' && blocks?.length && !sequenceRequest) setSequenceRequest(blocks.find(b => b.coverage==='full') ?? null);
  },[blocks,selection.action,sequenceRequest]);
  useEffect(() => {
    if (!sequenceRequest) return;
    const controller = new AbortController();
    void fetchJson<{ sequence: string; complete: boolean }>('/api/differences/sequence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ ...q, row_ids: [sequenceRequest.row_id], record_id: sequenceRequest.record_id, limit: 50_000,
        include_duplicates: selection.evidencePolicy?.include_duplicates ?? false }),
    }).then(r => { if (!controller.signal.aborted && r.complete) { setSequence(r.sequence); if(selection.action === 'identify') setIdentify(true); } })
      .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [q, sequenceRequest, selection.evidencePolicy]);
  const lens = useMemo<LensResponse | null>(() => sequence === null ? null : ({ success: true, chrom: selection.chrom, flank: 0,
    site: { pos: d.t_start, tolerance: 0, len_min: d.alt_bp, len_max: d.alt_bp }, cluster: { ref: d.t_start, len: d.alt_bp, len_lo: d.alt_bp, len_hi: d.alt_bp, carriers: 1, reference: 0 },
    carriers: [], reference: [], excluded: { other_insert: 0, not_informative: 0 }, truncated: { carriers: 0, reference: 0 },
    consensus: { seq: sequence, length: sequence.length, n_reads: 1, seconds: 0, method_label: 'one observed read' },
  }), [sequence, selection.chrom, d]);
  const identifyKey = `${dataset.id}|${d.id}|${target.revision}|${sequenceRequest?.record_id ?? ''}`;
  useEffect(() => { if (identify && lens) identifyLens(lens, dataset.id, { key: identifyKey }); }, [identify, lens, dataset.id, identifyKey]);
  const rect = anchor.current?.getBoundingClientRect();
  return createPortal(<div role="dialog" aria-label="Inspect difference" data-testid="difference-inspector"
    className="fixed z-[100] p-3 border rounded shadow-xl bg-white dark:bg-slate-900 text-xs overflow-auto"
    style={{ left: Math.max(8, rect?.left ?? 8), top: 60, width: Math.min(760, window.innerWidth-16), maxHeight: '85vh' }}>
    <button className="float-right" aria-label="Close difference inspection" onClick={() => useDifferenceSelection.getState().select(null)}>×</button>
    <strong>{d.kind} · {d.ref_bp}→{d.alt_bp} bp · reads</strong>
    <p>{selection.chrom}:{d.t_start}–{d.t_end} · provisional identity · sequence unavailable until loaded · reads only</p>
    <p>Reference [{d.t_start}, {d.t_end}) · alternate {d.alt_bp} bp · net {d.alt_bp-d.ref_bp} bp</p>
    <p>Boundary aligned · unaligned interior · observed bases retain their own offsets.</p>
    {expandableAltBlock(d) && <><button onClick={() => expandDifference(selection)}>Expand alternate</button>{' '}
      </>}<button onClick={() => setLoad(n => n+1)}>Load observed bases and chromatin</button>
    {selection.alternateHit && <p>Alternate-local {selection.alternateHit.layer ?? 'footprint'} [{selection.alternateHit.start}, {selection.alternateHit.end}) · read {selection.alternateHit.readId}</p>}
    <MoleculeCalls selection={selection} native />
    {error && <p role="status">{error}</p>}
    {blocks && <table className="w-full text-left"><thead><tr><th>Read / record</th><th>Observed bases</th><th>Coverage / chromatin</th><th>Sequence</th></tr></thead>
      <tbody>{blocks.map(b => <tr key={b.record_id}><td>{b.row_id} · {b.record_id.slice(0, 8)}</td><td className="font-mono break-all">{b.read_bases}{b.read_bases_length > 60 && '…'} ({b.read_bases_length} bp)</td>
        <td>{b.coverage} · {b.intervals?.length ?? 0} calls · {b.methyl_m6a?.length ?? 0} m6A</td>
        <td><button disabled={b.coverage !== 'full'} onClick={() => { setSequence(null); setSequenceRequest(b); }}>Load full observed sequence</button></td></tr>)}</tbody></table>}
    {sequence !== null && <><p className="font-mono break-all">{sequence.slice(0, 60)}{sequence.length > 60 && '…'} · {sequence.length} bp · one observed read</p>
      <button disabled={!sequence.length || !expandableAltBlock(d)} onClick={() => setIdentify(true)}>Identify observed alternate</button></>}
    {identify && lens && <IdentifyTab response={lens} datasetId={dataset.id} identifyKey={identifyKey} reversed={false} visible dark={false} />}
  </div>, document.body);
}
