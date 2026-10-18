import { datasetPanelView } from '../../utils/panelScope';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
/**
 * The insertion lens's Identify tab: candidates for what the insertion's consensus is (with how sure: best candidate,
 * ambiguous, or no confident match; docs/identify.md).
 * One click, no setup: local searches only (the genome, indexed on first use,
 * and the assembly's TE library, set up by the first Identify: bundled for
 * D. melanogaster, one download of public data otherwise; progress and Stop
 * in the job). RepeatMasker naming sends hit coordinates to UCSC when its box
 * is ticked; Dfam online is a separate, explicitly confirmed "Send to Dfam".
 */
import { JobStatus } from '../../components/controls/shared/JobStatus';
import { closeReferenceCopies, openCopyPanels, openReferenceCopies } from './referenceCopies';
import { SPLIT_DEFAULT_TOP, SPLIT_HARD_LIMIT, splitVerdict } from '../variants/variantSplit';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { downloadTextFile, safeFilenamePart } from '../../utils/analysisExport';
import { copyText } from '../../utils/clipboard';
import { getLayerColor } from '../../utils/layerColors';
import { AnalysisButton } from '../../components/controls/shared';
import { InsertionCartoon, cartoonPngBlob, cartoonSvgText, type CartoonChromatin } from './InsertionCartoon';
import {
  CLASS_COLORS, cartoonModel, classKey, formatSize, insertProfile, locusLabel, sha256Hex,
  type IdentifyResult, type LibraryStatus, type SavedIdentify,
  insertFamilyName, referenceCopies, identifyVerdict, verdictLabel, candidateEvidence,
} from './identifyModel';
import {
  cancelIdentify, hydrateIdentify, setVisibleIdentifyKey, startDfamSearch, startIdentify, useIdentifyStore,
} from './identifyStore';
import { insertionName, type LensAxis, type LensProfile, type LensResponse } from './insertionLensModel';

const RMSK_PREF = 'fb.identify.rmsk';

/** RepeatMasker naming (sends hit coordinates, never the sequence, to UCSC): on unless the
 * user turned it off; the choice is remembered per user. */
export function readRmskPref(): boolean {
  try { return window.localStorage.getItem(RMSK_PREF) !== '0'; } catch { return true; }
}

function writeRmskPref(value: boolean): void {
  try { window.localStorage.setItem(RMSK_PREF, value ? '1' : '0'); } catch { /* private window */ }
}

/** The reference of the panel supplying this consensus. */
export function insertionReference(datasetId: string): string | null {
  return datasetPanelView(useBrowserStore.getState(), datasetId).genome ?? usePanelGenomeStore.getState().assignments[datasetId] ?? null;
}

/** The cluster an identification belongs to. */
export function lensIdentifyKey(response: Pick<LensResponse, 'chrom' | 'cluster'>, datasetId: string, genome = insertionReference(datasetId)): string {
  return `${datasetId}|${response.chrom}|${response.cluster.ref}|${response.cluster.len}${genome ? `|${genome}` : ""}`;
}

/** Start identifying the lens's consensus (the toolbar button and the tab use this). */
export function identifyLens(response: LensResponse, datasetId: string, opts: { genome?: string | null; force?: boolean; restart?: boolean; libraryId?: string | null; key?: string } = {}): boolean {
  const seq = response.consensus?.seq;
  if (!seq) return false;
  const genome = opts.genome !== undefined ? opts.genome : insertionReference(datasetId);
  void startIdentify(opts.key ?? lensIdentifyKey(response, datasetId, genome), {
    genome, seq, chrom: response.chrom, ref: response.cluster.ref, length: response.cluster.len,
    rmsk: readRmskPref(), libraryId: opts.libraryId ?? null, force: opts.force, restart: opts.restart,
  });
  return true;
}

interface Props {
  /** Live-lift insertions additionally scope jobs by map/settings and haplotype.
   * Equal target boundaries and lengths do not imply equal source sequences. */
  identifyKey?: string;
  response: LensResponse;
  datasetId: string;
  genome?: string | null;
  reversed: boolean;
  visible: boolean;
  dark: boolean;
  saved?: Record<string, SavedIdentify>;
  carrierProfile?: { axis: LensAxis; profile: LensProfile; n: number } | null;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export function IdentifyTab({ response, datasetId, genome = insertionReference(datasetId), reversed, visible, dark, saved, carrierProfile, identifyKey }: Props) {
  // Follows the panel's width, also when this tab's body is mounted later (no consensus yet at first).
  const [rootRef, width] = useElementWidth(320, 640);
  const key = identifyKey ?? lensIdentifyKey(response, datasetId, genome);
  const entry = useIdentifyStore(s => s.entries[key]);
  const dfam = useIdentifyStore(s => s.dfam[key]);
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [rmsk, setRmsk] = useState(readRmskPref);
  const [confirmDfam, setConfirmDfam] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const seq = response.consensus?.seq ?? '';

  useEffect(() => { hydrateIdentify(key, saved?.[key]); }, [key, saved]);
  useEffect(() => {
    setVisibleIdentifyKey(visible ? key : null);
    return () => setVisibleIdentifyKey(null);
  }, [key, visible]);

  // A result for another consensus (the reads changed) or another reference/annotation: say so.
  const result = entry?.result ?? null;
  const [staleSeq, setStaleSeq] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!result || !seq) { setStaleSeq(false); return; }
    sha256Hex(seq).then(h => { if (!cancelled) setStaleSeq(h !== result.seq_sha256); }).catch(() => {});
    return () => { cancelled = true; };
  }, [result, seq]);

  // A genome declared for a FASTA changes the library offered and the reference id (staleness): look again,
  // also when a request is still pending (its reply is dropped and a new one is made).
  const referenceRevision = useBrowserStore(s => s.referenceRevision);
  const libraryToken = useRef(0);
  const loadLibrary = useCallback((refresh = false) => {
    const token = ++libraryToken.current;
    // The revision is part of the request: a GET pending for an earlier declaration is shared by fetchJson
    // (same URL), so without it a replacement request would receive the pre-declaration library.
    const params = new URLSearchParams({ ...(refresh ? { refresh: 'true' } : {}), ...(genome ? { panel_genome: genome } : {}),
      ...(referenceRevision ? { reference_revision: String(referenceRevision) } : {}) });
    fetchJson<LibraryStatus>(`/api/insertions/te_library${params.size ? `?${params}` : ''}`)
      .then(r => { if (token === libraryToken.current) setLibrary(r); })
      .catch(err => { if (token === libraryToken.current) setLibraryError(String((err as Error)?.message ?? err)); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genome, key, referenceRevision]);
  useEffect(() => { libraryToken.current++; setLibrary(null); setLibraryError(null); }, [key, referenceRevision]);
  useEffect(() => { if (visible && !library) loadLibrary(); }, [visible, library, loadLibrary]);
  // A finished job may have set the library up: look again, once per job (keyed by the job,
  // so a status reply that arrives after the job finished still gets its refresh).
  const entryStatus = entry?.status;
  const entryJob = entry?.jobId;
  const libraryActive = library?.active ?? null;
  const refreshedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible || !library || libraryActive || !entryJob || entryStatus === 'running') return;
    if (refreshedFor.current === entryJob) return;
    refreshedFor.current = entryJob;
    loadLibrary();
  }, [visible, entryStatus, entryJob, library, libraryActive, loadLibrary]);

  const say = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(n => (n === text ? null : n)), 2500);
  };

  const run = (force = false) => {
    identifyLens(response, datasetId, { genome, force, libraryId: library?.active ?? null, key });
  };


  const model = useMemo(() => (result ? cartoonModel(result, reversed) : null), [result, reversed]);
  const chromatin: CartoonChromatin | null = useMemo(() => {
    if (!carrierProfile) return null;
    const n = Math.max(20, Math.min(240, Math.round((width - 108) / 3)));
    return {
      nuc: insertProfile(carrierProfile.profile.nuc, carrierProfile.axis, n),
      msp: insertProfile(carrierProfile.profile.msp, carrierProfile.axis, n),
      nucColor: getLayerColor('nuc'), mspColor: getLayerColor('msp'),
      label: `Carriers (${carrierProfile.n})`,
    };
  }, [carrierProfile, width]);

  const stem = safeFilenamePart(insertionName(response));
  const saveSvg = () => { if (svgRef.current) downloadTextFile(cartoonSvgText(svgRef.current), `${stem}_cartoon.svg`, 'image/svg+xml'); };
  const savePng = async () => {
    if (!svgRef.current) return;
    const blob = await cartoonPngBlob(svgRef.current);
    if (!blob) { say('Could not render the PNG'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}_cartoon.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyReport = async () => { if (result) say(await copyText(result.report) ? 'Report copied' : 'Could not copy'); };
  const go = (chrom: string, start: number, end: number) => {
    const pad = Math.max(500, Math.round((end - start) * 0.2));
    useBrowserStore.getState().setViewport(chrom, Math.max(0, start - pad), end + pad);
  };

  const staleRef = Boolean(result?.reference_id && library?.reference_id && result.reference_id !== library.reference_id);
  const stale = staleSeq || staleRef;
  const recommended = library?.libraries.find(l => !l.installed);
  const installed = library?.libraries.find(l => l.id === library.active);
  const tools = library?.tools;
  const running = entry?.status === 'running';

  if (!response.consensus) {
    return <div className="text-ink-muted" data-testid="identify-no-consensus">No consensus for this insertion yet: it needs carriers with the inserted bases.</div>;
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-2" data-testid="insertion-identify">
      {/* Status / summary */}
      {!entry && (
        <div className="text-ink-muted">
          Search the {response.consensus.length.toLocaleString()}-bp consensus against the genome{installed || recommended ? ' and the TE library' : ''} on this computer.
        </div>
      )}
      {running && (
        // The shared job status (stage, elapsed time), as the other long analyses show it; Stop is beside Run.
        <JobStatus compact title="Identify" state="running" stage={`${entry.message || 'Working'}… (keeps going if you switch away)`}
          startedAt={entry.startedAt ?? null} progress={entry.progress ? { fraction: entry.progress } : null} testId="identify-progress" />
      )}
      {entry?.status === 'error' && (
        <div className="text-red-600 dark:text-red-400" role="alert" data-testid="identify-error">{entry.error}</div>
      )}
      {entry?.status === 'cancelled' && <div className="text-ink-muted">Stopped.</div>}
      {result && (
        <div className="text-[13px] font-semibold text-ink leading-snug" data-testid="identify-summary">{result.summary}</div>
      )}
      {result && <VerdictLine result={result} />}
      {result?.library_note && (
        <div className="text-amber-600 dark:text-amber-400 text-[11px]" data-testid="identify-library-note">{result.library_note}</div>
      )}
      {stale && (
        <div className="text-amber-600 dark:text-amber-400 text-[11px]" data-testid="identify-stale">
          {staleRef
            ? 'This result was computed against another reference genome or annotation: run it again.'
            : 'This result is for an earlier consensus of this insertion: run it again.'}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {!running && (
          <AnalysisButton variant="primary" theme="violet" onClick={() => run(Boolean(result))} data-testid="identify-run">
            {result ? 'Run again' : 'Identify insertion'}
          </AnalysisButton>
        )}
        {running && <AnalysisButton onClick={() => void cancelIdentify(key)}>Stop</AnalysisButton>}
        {result && <AnalysisButton onClick={copyReport} title="The full report as text" data-testid="identify-copy-report">Copy report</AnalysisButton>}
        {result && <AnalysisButton onClick={saveSvg}>Save SVG</AnalysisButton>}
        {result && <AnalysisButton onClick={() => void savePng()}>Save PNG</AnalysisButton>}
        {/* What the next run sends anywhere, next to Run (audit VAR-9): RepeatMasker naming is on by default (the
            owner's choice) but visibly online. */}
        <span data-testid="identify-online-state" data-online={rmsk ? 'true' : 'false'}
          className={`ml-1 rounded-full border px-1.5 py-px text-[10.5px] ${rmsk ? 'border-sky-400/60 text-sky-800 dark:text-sky-300' : 'border-slate-300 text-ink-secondary dark:border-slate-600'}`}
          title={rmsk ? 'The search runs on this computer; naming its genome hits asks UCSC (only the hits\' coordinates are sent, never the sequence)' : 'Everything runs on this computer: nothing is sent'}>
          {rmsk ? 'Online: RepeatMasker names (UCSC)' : 'Local only'}
        </span>
        {notice && <span className="text-ink-muted ml-1">{notice}</span>}
      </div>
      {/* The local search and the online naming, apart. */}
      <div className="flex flex-col gap-0.5 text-[11px]" data-testid="identify-sources">
        <div className="text-ink-secondary" data-testid="identify-local">
          <span className="font-medium text-ink">Local search</span> · on this computer: the genome{installed || recommended ? ' and the TE library' : ''} (nothing is sent)
        </div>
        <label className="flex cursor-pointer flex-wrap items-center gap-x-1"
          title="Names the genome hits from UCSC's RepeatMasker track. Sends only the hits' reference coordinates to UCSC, never your sequence.">
          <span className="font-medium text-ink">Online naming</span> ·
          <input type="checkbox" checked={rmsk} onChange={e => { setRmsk(e.target.checked); writeRmskPref(e.target.checked); }}
            data-testid="identify-rmsk" />
          RepeatMasker names <span className="text-ink-secondary">(sends hit coordinates to UCSC, never the sequence)</span>
        </label>
      </div>

      {/* TE library */}
      {library && (
        <div className="text-[11px] text-ink-muted flex flex-wrap items-center gap-1.5" data-testid="identify-library">
          {installed ? (
            <span>
              TE library: <span className="text-ink">{installed.label}</span>
              {' '}(<a className="underline" href={installed.licence_url} target="_blank" rel="noreferrer">{installed.licence}</a>
              , <a className="underline" href={installed.homepage} target="_blank" rel="noreferrer">{installed.source}</a>)
            </span>
          ) : recommended ? (
            <span data-testid="identify-library-auto"
              title={`${recommended.label}: ${recommended.source}. Kept in ~/.fiberhmm/te_libraries. Nothing about your data is sent.`}>
              TE library: <span className="text-ink">{recommended.label}</span>
              {recommended.bundled
                ? ', bundled with FiberBrowser: set up on the first Identify'
                : `, downloaded once on the first Identify (${formatSize(recommended.size_bytes)}, from ${recommended.homepage.replace(/^https?:\/\//, '')}; nothing about your data is sent)`}
              {' '}(<a className="underline" href={recommended.licence_url} target="_blank" rel="noreferrer">{recommended.licence}</a>)
            </span>
          ) : (
            <span>No TE library is offered for this genome{library.genome ? ` (${library.genome})` : ''}; genome hits and RepeatMasker names still work.</span>
          )}
          {libraryError && <span className="text-red-600 dark:text-red-400">{libraryError}</span>}
          {tools && !tools.blastn && !tools.minimap2 && (
            <span className="text-red-600 dark:text-red-400" data-testid="identify-tools-missing">
              Neither BLAST+ nor minimap2 was found (looked in the app, PATH, Homebrew and conda folders). {tools.hint || "Install BLAST+ with 'brew install blast' or 'conda install -c bioconda blast'."}
            </span>
          )}
          {tools && !tools.blastn && tools.minimap2 && (
            <span>BLAST+ not found: searching with minimap2 (no e-values). {tools.hint}</span>
          )}
          {tools?.blastn && tools.blast_label && <span data-testid="identify-blast-now">Search: {tools.blast_label}.</span>}
          {tools && !tools.blastn && (
            <button type="button" className="underline" onClick={() => loadLibrary(true)}>Check again</button>
          )}
        </div>
      )}

      {/* Cartoon */}
      {result && model && (
        <div className="overflow-x-auto">
          <InsertionCartoon ref={svgRef} model={model} width={width} dark={dark} chrom={response.chrom} chromatin={chromatin} />
        </div>
      )}

      {result && <IdentifyTables result={result} go={go} datasetId={datasetId} />}

      {/* Dfam online: explicit, per query */}
      {result && (
        <div className="text-[11px] flex flex-wrap items-center gap-1.5" data-testid="identify-dfam">
          {!confirmDfam && dfam?.status !== 'running' && (
            <AnalysisButton onClick={() => setConfirmDfam(true)} data-testid="identify-dfam-open"
              title="Search Dfam's profile HMMs on dfam.org (sends the sequence; asks first)">Search Dfam online…</AnalysisButton>
          )}
          {confirmDfam && (
            <span className="flex flex-wrap items-center gap-1.5 rounded border border-amber-400/60 px-2 py-1" data-testid="identify-dfam-confirm">
              <span>This sends the {seq.length.toLocaleString()}-bp consensus to <span className="font-medium">dfam.org</span>, a public service. Send it?</span>
              <AnalysisButton variant="warning" data-testid="identify-dfam-send"
                onClick={() => { setConfirmDfam(false); void startDfamSearch(key, seq, true); }}>Send to Dfam</AnalysisButton>
              <AnalysisButton onClick={() => setConfirmDfam(false)}>Cancel</AnalysisButton>
            </span>
          )}
          {dfam?.status === 'running' && <span className="text-ink-muted">Dfam: {dfam.message || 'searching'}…</span>}
          {dfam?.status === 'error' && <span className="text-red-600 dark:text-red-400">Dfam: {dfam.error}</span>}
          {dfam?.status === 'done' && (
            <span className="text-ink-muted">
              Dfam: {dfam.hits?.length ? dfam.hits.slice(0, 4).map(h => `${h.family} (${h.type}, ${h.qstart}–${h.qend} ${h.strand}, E=${h.evalue})`).join('; ') : 'no hits'}
              {dfam.url && <> · <a className="underline" href={dfam.url} target="_blank" rel="noreferrer">results on dfam.org</a></>}
            </span>
          )}
        </div>
      )}
      {result && (
        <div className="text-[10px] text-ink-muted">
          {result.engine} · {result.masking} · {result.seconds ?? '?'} s
          {result.tool && <span data-testid="identify-blast-tool"> · {result.tool.label}</span>}
          {result.genome.rmsk === 'ok' && ' · RepeatMasker names: UCSC rmsk track'}
          {result.genome.rmsk === 'unavailable' && ' · RepeatMasker names unavailable (UCSC unreachable)'}
        </div>
      )}
    </div>
  );
}

const VERDICT_TONE = {
  candidate: 'border-emerald-500/50 text-emerald-800 dark:text-emerald-300',
  ambiguous: 'border-amber-500/60 text-amber-800 dark:text-amber-300',
  no_match: 'border-slate-400/60 text-ink-muted',
} as const;

/**
 * How sure the result is: Best candidate / Ambiguous / No confident match (identifyModel.identifyVerdict), why, the
 * best candidate's coverage and identity, and the databases and search program it was measured against.
 */
function VerdictLine({ result }: { result: IdentifyResult }) {
  const v = identifyVerdict(result);
  const t = v.thresholds;
  const rules = `A candidate needs ≥ ${t.min_identity}% identity over ≥ ${Math.round(t.min_query_coverage * 100)}% of the insert; `
    + `ambiguous: another family within ${Math.round(t.ambiguous_bitscore_fraction * 100)}% of the best bitscore over the same bases. `
    + 'Identify offers candidates from local searches, not identifications: check the alignments before naming the insertion.';
  return (
    <div className="flex flex-col gap-0.5 text-[11px]" data-testid="identify-verdict" data-status={v.status} title={rules}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded border px-1.5 py-px font-semibold ${VERDICT_TONE[v.status]}`} data-testid="identify-verdict-status">
          {verdictLabel(v.status)}
        </span>
        <span className="text-ink-muted">{v.reason}</span>
      </div>
      {candidateEvidence(result).map(line => (
        <div key={line} className="text-ink-muted tabular-nums" data-testid="identify-evidence">{line}</div>
      ))}
    </div>
  );
}

/**
 * "Open the reference copies": the insert's best genome copies as read panels of this dataset beside its
 * carriers (utils/referenceCopies.ts), top N (4), a second click to confirm above 8, at most 16.
 */
function ReferenceCopiesControl({ result, datasetId }: { result: IdentifyResult; datasetId: string }) {
  const [top, setTop] = useState(SPLIT_DEFAULT_TOP);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const available = referenceCopies(result.genome, SPLIT_HARD_LIMIT);
  const family = insertFamilyName(result);
  const n = Math.min(Math.max(1, top), available.length);
  const verdict = splitVerdict(n);
  // The copies open now (from here or an earlier Identify): closed again from here, where they were opened (VAR-10).
  const openCopies = useBrowserStore(s => openCopyPanels(s.panels, datasetId).length);
  if (!available.length) return null;
  const open = () => {
    if (verdict.kind === 'refuse' || verdict.kind === 'none') { setMessage(verdict.message); return; }
    if (verdict.kind === 'confirm' && !armed) { setArmed(true); setMessage(`${verdict.message} Click again to open them.`); return; }
    const res = openReferenceCopies(datasetId, referenceCopies(result.genome, n), family);
    setArmed(false);
    setMessage('error' in res ? res.error : `Opened ${res.opened} ${family} cop${res.opened === 1 ? 'y' : 'ies'} beside the carriers.`);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="identify-reference-copies">
      <button type="button" className="fb-btn-secondary h-7 px-2 text-[11.5px]" onClick={open} data-testid="identify-open-copies"
        title={`The insert's best ${family} copies in the reference genome (covering at least half of it, away from this site), as read panels of this dataset beside its carriers: compare their chromatin with the new insertion's`}>
        {armed ? `Open ${n} panels` : `Open the reference copies (${n})`}
      </button>
      <label className="flex items-center gap-1 text-ink-muted">top
        <input type="number" min={1} max={Math.min(SPLIT_HARD_LIMIT, available.length)} value={top} className="input-tool h-6 w-12 text-[11.5px]"
          onChange={e => { setTop(Math.max(1, Math.min(SPLIT_HARD_LIMIT, Number(e.target.value) || 1))); setArmed(false); setMessage(null); }}
          aria-label="How many reference copies" data-testid="identify-copies-top" />
        of {available.length}</label>
      {openCopies > 0 && (
        <button type="button" className="fb-btn-secondary h-7 px-2 text-[11.5px]" data-testid="identify-close-copies"
          onClick={() => { const closed = closeReferenceCopies(datasetId); setArmed(false); setMessage(`Closed ${closed} reference ${closed === 1 ? 'copy' : 'copies'}.`); }}
          title="Close every reference-copy panel opened from here (Undo brings them back)">
          Close reference copies ({openCopies})
        </button>
      )}
      {message && <span className="text-ink-muted" data-testid="identify-copies-message">{message}</span>}
    </div>
  );
}

function IdentifyTables({ result, go, datasetId }: { result: IdentifyResult; go: (chrom: string, start: number, end: number) => void; datasetId: string }) {
  const g = result.genome;
  const near = g.loci.filter(l => l.near_site !== null);
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <ReferenceCopiesControl result={result} datasetId={datasetId} />
      <details open={result.te.calls.length > 0} data-testid="identify-te-table">
        <summary className="cursor-pointer font-semibold text-ink">
          Candidate TE families ({result.te.calls.filter(c => !c.related).length}{result.te.calls.some(c => c.related) ? ` + ${result.te.calls.filter(c => c.related).length} related` : ''})
        </summary>
        {result.te.calls.length === 0 ? (
          <div className="text-ink-muted pl-3">{result.te.library ? 'No library family matches.' : 'No TE library downloaded.'}</div>
        ) : (
          <table className="w-full text-left tabular-nums mt-1">
            <thead className="text-ink-muted"><tr>
              <th className="font-medium">Family</th><th className="font-medium">Class</th><th className="font-medium">Identity</th>
              <th className="font-medium" title="Share of the element the insert covers">Element</th>
              <th className="font-medium" title="Share of the insert this family's alignment covers">Insert covered</th><th className="font-medium">Shape</th>
              <th className="font-medium">Strand</th><th className="font-medium">Insert bases</th>
            </tr></thead>
            <tbody>
              {result.te.calls.map(c => (
                <tr key={`${c.family}${c.strand}`} className={`border-t border-slate-200 dark:border-slate-700 ${c.related ? 'text-ink-muted' : ''}`}
                  title={c.related ? 'Below 80% identity: a related family, not called' : c.description || undefined}>
                  <td><span className="inline-block w-2 h-2 rounded-sm mr-1 align-middle" style={{ background: CLASS_COLORS[classKey(c.class)] }} />{c.family}</td>
                  <td>{c.class_label}</td>
                  <td>{c.identity.toFixed(1)}%</td>
                  <td>{(c.element_start + 1).toLocaleString()}–{c.element_end.toLocaleString()} of {c.element_length.toLocaleString()} ({pct(c.element_coverage)})</td>
                  <td>{pct(c.query_coverage)}</td>
                  <td>{c.related ? 'related' : c.completeness}</td>
                  <td>{c.strand === '-' ? '−' : '+'}</td>
                  <td>{c.query.map(([a, b]) => `${(a + 1).toLocaleString()}–${b.toLocaleString()}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result.te.library && (
          <div className="text-[10px] text-ink-muted pl-3" data-testid="identify-library-version">
            {result.te.library.label}{result.te.library.version && !result.te.library.label.includes(result.te.library.version) ? ` (${result.te.library.version})` : ''} · {result.te.library.licence} · {result.te.library.citation}
          </div>
        )}
      </details>

      {g.genes.length > 0 && (
        <details open data-testid="identify-gene-table">
          <summary className="cursor-pointer font-semibold text-ink">Genes ({g.genes.length})</summary>
          <ul className="pl-3 mt-1 flex flex-col gap-0.5">
            {g.genes.map(gene => (
              <li key={gene.transcript}>
                <button type="button" className="underline text-ink" onClick={() => go(gene.chrom, gene.gene_start, gene.gene_end)}
                  title="Show the gene">{gene.gene}</button>
                {' '}({gene.transcript}): insert bases {gene.query.map(([a, b]) => `${(a + 1).toLocaleString()}–${b.toLocaleString()}`).join(', ')}
                {' '}match {gene.region === 'gene'
                  ? 'the gene body (the annotation has no exons)'
                  : <>{gene.region === 'exon'
                    ? (gene.exons.length === 1 ? `exon ${gene.exons[0]}` : `exons ${gene.exons.join(', ')}`)
                    : 'an intron'} of {gene.n_exons}</>} at {gene.identity.toFixed(1)}%
                {gene.orientation && <span className="text-ink-muted"> ({gene.orientation === '+' ? 'sense' : 'antisense'} along the insert)</span>}
                {gene.spliced && <span className="text-violet-600 dark:text-violet-400"> · introns missing: a spliced copy (retrocopy/cDNA)</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details data-testid="identify-genome-table">
        <summary className="cursor-pointer font-semibold text-ink">
          Genome hits{g.assembly ? ` (${g.assembly})` : ''}: {g.n_loci.toLocaleString()} loci{g.capped ? '+' : ''}, {g.copies.toLocaleString()} covering ≥ 50% of the insert
          {near.length > 0 && <span className="text-teal-700 dark:text-teal-400"> · {near.length} near the site</span>}
          {g.rmsk_family && <span className="font-normal text-ink-muted"> · RepeatMasker: {g.rmsk_family.name} ({g.rmsk_family.class_label})</span>}
        </summary>
        {g.loci.length === 0 ? <div className="text-ink-muted pl-3">No match in the genome.</div> : (
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-left tabular-nums mt-1">
              <thead className="text-ink-muted"><tr>
                <th className="font-medium">Location</th><th className="font-medium">Strand</th><th className="font-medium">Identity</th>
                <th className="font-medium">Insert covered</th><th className="font-medium">E-value</th><th className="font-medium">RepeatMasker</th>
              </tr></thead>
              <tbody>
                {g.loci.map(l => (
                  <tr key={`${l.chrom}:${l.start}:${l.strand}`} className="border-t border-slate-200 dark:border-slate-700">
                    <td>
                      <button type="button" className="underline" onClick={() => go(l.chrom, l.start, l.end)} title="Go there">{locusLabel(l)}</button>
                      {l.near_site !== null && <span className="text-teal-700 dark:text-teal-400"> {l.near_site === 0 ? 'at the site' : `${l.near_site.toLocaleString()} bp from the site`}</span>}
                    </td>
                    <td>{l.strand === '-' ? '−' : '+'}</td>
                    <td>{l.identity.toFixed(1)}%</td>
                    <td>{pct(l.qcov)} ({(l.qstart + 1).toLocaleString()}–{l.qend.toLocaleString()})</td>
                    <td>{l.evalue === null || l.evalue === undefined ? '—' : l.evalue === 0 ? '0' : l.evalue.toExponential(0)}</td>
                    <td>{l.rmsk ? `${l.rmsk.name} (${l.rmsk.class_label})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {g.n_loci > g.loci.length && <div className="text-ink-muted pl-1">Showing the best {g.loci.length} of {g.n_loci.toLocaleString()}.</div>}
          </div>
        )}
      </details>
      {result.tsd && (
        <div className="text-ink-muted" title="The reference bases at the site, found again at the insert's edge: duplicated when the element inserted">
          Target-site duplication: <span className="font-mono text-ink">{result.tsd.seq}</span> ({result.tsd.length} bp){result.tsd.confident ? '' : ', too short to be sure'}
        </div>
      )}
    </div>
  );
}

export default IdentifyTab;
