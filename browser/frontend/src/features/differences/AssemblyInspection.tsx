import { expandableAltBlock } from './capabilities';
import { MoleculeCalls } from './MoleculeCalls';
import { AssemblyComparisonPanel } from './AssemblyComparisonPanel';
import { useAutoLoadBound } from './autoLoad';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Dataset, PanelConfig } from '../../types';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { useBrowserStore } from '../../stores/browserStore';
import { getDifferenceReads } from '../liveLift/api';
import { useDifferenceSelection, expandDifference } from '../liveLift/inspectionStore';
import { carrierHighlight, differenceDescription, haplotypeSummary, inspectionModel } from '../liveLift/differencesModel';
import type { DifferenceReadsResponse } from '../liveLift/differenceTypes';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { IdentifyTab, identifyLens } from '../insertion/IdentifyTab';
import type { LensResponse } from '../insertion/insertionLensModel';
import { openSourceView } from '../liveLift/sourceView';

export const LIFT_SPLIT_REASON = 'Split by carrier is unavailable: /api/sv/split does not accept live-lift datasets yet.';
const bases = (s: string | null, length = s?.length ?? 0) => s === null ? 'unknown' : s === '' ? '∅'
  : length > s.length ? `${s}… (${length.toLocaleString()} bp)` : s.length > 60 ? `${s.slice(0, 28)}…${s.slice(-12)} (${s.length.toLocaleString()} bp)` : s;

export function AssemblyInspection({ panel, dataset, anchor }: { panel: PanelConfig; dataset: Dataset; anchor: RefObject<HTMLDivElement | null> }) {
  const selection = useDifferenceSelection(s => s.selection);
  const current = selection?.panelId === panel.id && selection.inspect !== false ? selection : null;
  const d = current?.difference;
  const dark = useBrowserStore(s => s.darkMode);
  // Observations load on open within the auto-load bound; beyond it, "Load" says why it waits.
  const bound = useAutoLoadBound(panel);
  const [readRequested, setReadRequested] = useState(current?.action === 'identify' || bound.auto);
  useEffect(() => { if (bound.auto) setReadRequested(true); }, [bound.auto]);
  const [data, setData] = useState<DifferenceReadsResponse | null>(null);
  const [error, setError] = useState('');
  const [identify, setIdentify] = useState(false);
  const [opening, setOpening] = useState(false);
  const [fetchingSequence, setFetchingSequence] = useState(false);
  const sequenceRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    sequenceRequest.current?.abort();
    setData(null); setError(''); setIdentify(false); setFetchingSequence(false);
    if (!current || !d || !readRequested) return;
    const controller = new AbortController();
    void getDifferenceReads({ datasetId: dataset.id, liftKey: dataset.live_lift?.key ?? '', chrom: current.chrom,
      pos: d.t_start, end: d.t_end, liftHap: panel.liftHap ?? d.hap_label, itemId: d.source === 'assembly' ? d.id : undefined, includeSequence: current.action === 'identify' }, controller.signal)
      .then(r => { if (!controller.signal.aborted) setData(r); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => { controller.abort(); sequenceRequest.current?.abort(); };
  }, [current, d, dataset.id, dataset.live_lift?.key, panel.liftHap, readRequested]);
  const preferredHap = data?.preferred_hap ?? d?.hap_label;
  const model = useMemo(() => inspectionModel(data?.rows ?? [], preferredHap, d), [data, preferredHap, d]);
  useEffect(() => {
    if (!current) return;
    // Reuse the read action outline without pinning a cohort (pins would fetch
    // reads again on expand). Preserve the user's previous highlight on close.
    const prior = useReadActionsStore.getState().highlight;
    const { ids, scopedRows } = carrierHighlight(model.carrierRows, dataset.id);
    const put = () => useReadActionsStore.setState({ highlight: { ids: new Set(ids), ...(scopedRows ? { scopedRows } : {}),
      pulseUntil: null, scrollTo: null, scrolled: new Set(), nonce: Date.now() } });
    if (model.carriers.length) put();

    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); useDifferenceSelection.getState().select(null); } };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); useReadActionsStore.setState({ highlight: prior }); };
  }, [current, model, readRequested, dataset.id]);
  const candidate = data?.rows.find(r => (d?.source === 'reads' ? r.hap_label === preferredHap && r.ins_id : r.ins_id === d?.id)
    && r.carries_insertion && (!r.alignment_ins_id || r.alignment_ins_id === r.ins_id) && (r.read_bases_length ?? r.read_bases.length) <= 50_000);
  const sequence = data?.sequence?.ins_id === (d?.source === 'reads' ? candidate?.ins_id : d?.id) ? data?.sequence?.sequence : undefined;
  const identifyKey = `${dataset.id}|${dataset.live_lift?.key ?? ''}|${current?.chrom ?? ''}|${d?.id ?? ''}`;
  const lens = useMemo<LensResponse | null>(() => !d || !sequence || !current ? null : ({ success: true, dataset_id: dataset.id, chrom: current.chrom, flank: 0,
    site: { pos: d.t_start, tolerance: 0, len_min: d.alt_bp, len_max: d.alt_bp },
    cluster: { ref: d.t_start, len: d.alt_bp, len_lo: d.alt_bp, len_hi: d.alt_bp, carriers: model.carriers.length, reference: 0 },
    carriers: [], reference: [], excluded: { other_insert: 0, not_informative: 0 }, truncated: { carriers: 0, reference: 0 },
    consensus: { seq: sequence, length: sequence.length, n_reads: 1, seconds: 0, method_label: 'one full carrier (read sequence)' },
  }), [d, sequence, current, dataset.id, model]);
  useEffect(() => {
    if (lens && current?.action === 'identify') setIdentify(true);
  }, [lens, current?.action, dataset.id, identifyKey]);
  const requestIdentification = async () => {
    if (!current || !d) return;
    if (lens) { setIdentify(true); return; }
    const controller = new AbortController();
    sequenceRequest.current?.abort(); sequenceRequest.current = controller;
    setFetchingSequence(true); setError('');
    try {
      const result = await getDifferenceReads({ datasetId: dataset.id, liftKey: dataset.live_lift?.key ?? '',
        chrom: current.chrom, pos: d.t_start, end: d.t_end, liftHap: panel.liftHap ?? d.hap_label,
        itemId: d.source === 'assembly' ? d.id : undefined, includeSequence: true }, controller.signal);
      if (!controller.signal.aborted) { setData(result); setIdentify(true); }
    } catch (e) { if (!controller.signal.aborted) setError(String((e as Error).message ?? e)); }
    finally { if (!controller.signal.aborted) setFetchingSequence(false); }
  };
  useEffect(() => {
    if (identify && lens) identifyLens(lens, dataset.id, { key: identifyKey });
  }, [identify, lens, dataset.id, identifyKey]);
  if (!current || !d) return null;
  // Map geometry is available without a source FASTA. MD-backed inspection can
  // supply the selected parent's assembly bases later; never use the other
  // parent's allele to fill a missing map string.
  const ownAllele = model.rows.find(r => r.hap_label === d.hap_label && r.hg002 !== null
    && (!['insertion', 'replacement'].includes(d.kind) || r.ins_id === d.id));
  const described = d.source === 'assembly' && ownAllele
    ? { ...d, alt: d.alt ?? ownAllele.hg002, grch38: d.grch38 ?? ownAllele.grch38 } : d;
  const rect = anchor.current?.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect?.bottom ?? 80, window.innerHeight - 410));
  return createPortal(<div role="dialog" aria-label="Inspect assembly difference" data-testid="live-lift-diff-popover"
    className="fixed z-[100] rounded border border-slate-400 shadow-xl bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 p-3 text-xs"
    style={{ left: Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 750)), top, width: Math.min(730, window.innerWidth - 16), maxHeight: Math.max(160, window.innerHeight - top - 12), overflow: 'auto' }}>
    <div className="flex justify-between gap-4"><strong style={{ color: liveLiftHaplotypeColor(d.hap_label, dark) }}>{d.hap_label} · {d.kind.replace(/_/g, ' ')} · {Math.max(d.alt_bp, d.ref_bp).toLocaleString()} bp</strong>
      <button aria-label="Close difference inspection" onClick={() => useDifferenceSelection.getState().select(null)}>×</button></div>
    <p className="whitespace-pre-line text-[11px] my-2">{differenceDescription(described, current.chrom)}</p>
    <div className="flex gap-3 my-2 items-center">
      {(d.kind === 'insertion' || d.kind === 'replacement') && <span title={d.alt_bp < 50 ? 'Insertion-local read payloads start at 50 bp.' : d.alt_bp > 50_000 ? 'Insertion payload is too large (over 50 kb).' : 'Open the insertion across this view'}>
        <button disabled={!expandableAltBlock(d) || d.source==='reads'&&d.src.start===null} onClick={() => expandDifference(current)}>{d.kind === 'replacement' ? 'Expand alternate' : 'Expand insertion'}</button></span>}

      {(d.kind === 'insertion' || d.kind === 'replacement') && <>
        <span title={candidate ? 'Identify one full carrier’s sequence; this is not an assembly consensus.' : 'No full insertion sequence is available from the inspected reads.'}>
          <button disabled={!candidate || fetchingSequence} onClick={() => { void requestIdentification(); }}>{fetchingSequence ? 'Loading sequence…' : 'Identify'}</button></span>
      </>}
      {['insertion', 'deletion', 'replacement'].includes(d.kind) &&
        <button disabled={opening || !d.src.contig || d.src.start === null} title="Open the source BAM on its own header-contig reference; locally linked at this difference"
          onClick={() => { setOpening(true); void openSourceView(current).finally(() => setOpening(false)); }}>{opening ? 'Opening…' : 'Open in HG002 view'}</button>
      }
    </div>
    <AssemblyComparisonPanel selection={current} dataset={dataset} />
    <p>Reference [{d.t_start}, {d.t_end}) · {d.ref_bp} bp → alternate {d.alt_bp} bp · net {d.alt_bp-d.ref_bp} bp</p>
    <MoleculeCalls selection={current} />
    {!readRequested && <p data-testid="difference-load-reason">{bound.reason}{' '}
      <button onClick={() => setReadRequested(true)}>Load observed bases and chromatin</button></p>}
    {(current.action === 'identify' || identify) && data && !lens && <p role="status">Identify unavailable: no full insertion sequence is available from the inspected reads.</p>}
    {identify && lens && <IdentifyTab response={lens} datasetId={dataset.id} identifyKey={identifyKey} reversed={false} visible dark={dark} />}
    <div className="my-2 flex gap-3 flex-wrap">{Object.entries(model.summary).map(([hap, alleles]) => <span key={hap}
      data-testid={hap !== preferredHap ? 'live-lift-other-hap-summary' : 'live-lift-selected-hap-summary'}>
      <span style={{ color: liveLiftHaplotypeColor(hap, dark) }}>{hap}</span>: {haplotypeSummary(alleles)}</span>)}</div>
    {model.misphased.length > 0 && <p className="text-amber-700 dark:text-amber-300 font-semibold" data-testid="live-lift-misphased">{model.misphased.length} GRCh38-allele reads · possible mis-phasing / mismapping</p>}
    {data && error && <p role="status">{error}</p>}
    {readRequested && !data && <p role="status">{error || 'Loading reads and alleles…'}</p>}
    {data && <><p>Source alignment observations (carriage is shown in the molecule-call table).</p><table className="w-full text-left text-[10px] mt-2"><thead><tr>{['Read', 'Hap / strand', 'Allele', 'Read bases', 'HG002', 'GRCh38', ...(['insertion', 'replacement'].includes(d.kind) ? ['Identity'] : []), 'Chromatin / nearby m6A'].map(h => <th key={h} className="px-1">{h}</th>)}</tr></thead>
      <tbody>{model.rows.map((r, i) => <tr key={`${r.id}-${r.record}-${i}`} data-hap={r.hap_label} data-allele={r.allele} className={r.allele === 'grch38' ? 'bg-amber-100 dark:bg-amber-950' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}
        onMouseEnter={() => useReadActionsStore.setState({ highlight: { ids: new Set([r.row_id ?? r.id]), scopedRows:{[dataset.id]:new Set([r.row_id ?? r.id])}, pulseUntil: null, scrollTo: null, scrolled: new Set(), nonce: Date.now() } })}
        onMouseLeave={() => useReadActionsStore.getState().clearHighlight()}>
        <td className="max-w-40 truncate px-1" title={`${r.molecule}\n${r.record}\n${r.source_pos.contig}:${r.source_pos.start}-${r.source_pos.end}`}>{r.molecule}{r.supplementary ? ' · supp' : ''}</td>
        <td style={{ color: liveLiftHaplotypeColor(r.hap_label, dark) }}>● {r.hap_label}{r.strand ? ` / ${r.strand}` : ''}</td><td>{r.allele.toUpperCase().replace(/_/g, ' ')}</td>
        <td title={r.read_bases} className="font-mono max-w-28 break-all">{bases(r.read_bases, r.read_bases_length)}</td><td title={r.hg002 ?? undefined} className="font-mono max-w-24 break-all">{bases(r.hg002, r.hg002_length)}</td><td className="font-mono">{bases(r.grch38, r.grch38_length)}</td>
        {(d.kind === 'insertion' || d.kind === 'replacement') && <td>{r.identity == null ? '—' : `${r.identity.toFixed(1)}%`}</td>}
        <td>{r.chromatin.state === 'accessible' ? 'MSP / accessible' : r.chromatin.state}{r.chromatin.layer ? ` (${r.chromatin.layer})` : ''}{r.chromatin.nearest_m6a_bp !== null ? ` · m6A ${r.chromatin.nearest_m6a_bp} bp` : ''}</td>
      </tr>)}</tbody></table>{data.capped && <p>Showing at most {data.max_records} source records.</p>}{!data.rows.length && <p>No reads cover this difference.</p>}</>}
  </div>, document.body);
}
