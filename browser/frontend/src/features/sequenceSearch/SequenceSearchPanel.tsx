/**
 * Find sequence in genome: paste a sequence, find where it is in the loaded genome. Short queries (and any with
 * IUPAC codes) are scanned exactly on both strands; longer ones go to BLAST with the genome database the primer
 * designer uses (built once, in the background, with Cancel). Every threshold is a setting with a default.
 * Clicking a hit shows it, highlighted; the hits can be added as a temporary track or saved as BED.
 */
import { useEffect, useMemo, useState } from 'react';
import { AnalysisButton, AnalysisSelect } from '../../components/controls/shared';
import { JobStatus } from '../../components/controls/shared/JobStatus';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { downloadTextFile } from '../../utils/analysisExport';
import {
  EXACT_HARD_MAX, IUPAC_MASKS, clampSetting, formatEvalue, hitLocus, hitMatchText, hitsToBed, parseSequence, plannedMode,
  resultSummary, type BlastTask, type SearchMode, type SearchResult, type SequenceHit,
} from './model';
import {
  addHitsTrack, cancelSearch, goToHit, isStaleResult, refreshStatus, STALE_REFERENCE_MESSAGE, resetSettings, setNotice, setQuery, setSettings, startSearch,
  useSequenceSearch,
} from './store';

const MODE_OPTIONS: Array<{ value: SearchMode; label: string }> = [
  { value: 'auto', label: 'Auto (exact if short, else BLAST)' },
  { value: 'exact', label: 'Exact / IUPAC' },
  { value: 'blast', label: 'BLAST (approximate)' },
];

const TASK_OPTIONS: Array<{ value: BlastTask; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'megablast', label: 'megablast' },
  { value: 'blastn', label: 'blastn' },
  { value: 'blastn-short', label: 'blastn-short' },
];

const SEQ_SHOWN = 60;

function NumberSetting({ label, value, onChange, step, title, testId }: {
  label: string; value: number; onChange: (v: number) => void; step?: number | 'any'; title: string; testId: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-ink-secondary" title={title}>
      <span>{label}</span>
      <input
        type="number" step={step ?? 1} value={text} data-testid={testId}
        className="input-tool w-20 rounded px-1.5 py-0.5 text-right text-[11px] tabular-nums"
        onChange={e => setText(e.target.value)}
        onBlur={() => onChange(Number(text))}
        onKeyDown={e => { if (e.key === 'Enter') onChange(Number(text)); }}
      />
    </label>
  );
}

/** The matched bases, with the ones that don't match the query marked (exact hits; BLAST hits show as they are). */
function MatchedSequence({ hit, query, mode }: { hit: SequenceHit; query: string; mode: SearchResult['mode'] }) {
  const shown = hit.matched.slice(0, SEQ_SHOWN);
  const cut = hit.matched.length > SEQ_SHOWN || hit.matched_truncated;
  if (mode !== 'exact' || !hit.mismatches) {
    return <span title={hit.matched}>{shown}{cut ? '…' : ''}</span>;
  }
  return (
    <span title={hit.matched}>
      {[...shown].map((base, i) => {
        const ok = ((IUPAC_MASKS[query[i]] ?? 0) & (IUPAC_MASKS[base] ?? 0)) !== 0 && base !== 'N';
        return ok ? base : <span key={i} className="text-red-600 dark:text-red-400 font-semibold" data-testid="seqsearch-mismatch">{base.toLowerCase()}</span>;
      })}
      {cut ? '…' : ''}
    </span>
  );
}

export function SequenceSearchPanel() {
  const st = useSequenceSearch();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => { void refreshStatus(); }, []);

  const parsed = useMemo(() => (st.query.trim() ? parseSequence(st.query, st.settings.min_length) : null), [st.query, st.settings.min_length]);
  const blastAvailable = Boolean(st.status?.blast.available);
  const plan = parsed?.ok ? plannedMode(parsed.seq, st.settings, blastAvailable) : null;
  const running = st.run === 'running';
  const problem = st.status?.problem ?? null;
  const result = st.result;
  const stale = isStaleResult(st);

  const find = () => { void startSearch(); };
  const exportBed = () => {
    if (!result?.hits.length) return;
    const stem = `sequence_hits_${(result.genome || 'genome').replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    downloadTextFile(hitsToBed(result.hits, stem), `${stem}.bed`, 'text/plain');
    setNotice(`Saved ${result.hits.length.toLocaleString()} hits as ${stem}.bed.`);
  };

  return (
    <div className="flex flex-col gap-2 p-2 text-[12px]" data-testid="sequence-search">
      {problem && (
        <div className="rounded border border-amber-400/60 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
          role="status" data-testid="seqsearch-problem" data-code={problem.code}>
          {problem.message}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-ink-secondary">Sequence</span>
        <textarea
          value={st.query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); find(); } }}
          rows={3}
          spellCheck={false}
          placeholder="Paste DNA (A, C, G, T; IUPAC codes such as N or R are fine; a FASTA record too)"
          className="input-tool w-full resize-y rounded px-2 py-1 font-mono text-[11px] leading-snug"
          data-testid="seqsearch-input"
          aria-label="Sequence to find in the genome"
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="seqsearch-plan">
        {parsed && !parsed.ok && <span className="text-red-600 dark:text-red-400" data-testid="seqsearch-parse-error">{parsed.error}</span>}
        {parsed?.ok && plan && (
          <span className="text-ink-muted">
            {parsed.seq.length.toLocaleString()} bases · {plan.mode === 'exact'
              ? `exact${/[^ACGT]/.test(parsed.seq) ? ' / IUPAC' : ''} search, both strands${st.settings.max_mismatches ? `, up to ${st.settings.max_mismatches} mismatch${st.settings.max_mismatches === 1 ? '' : 'es'}` : ''}`
              : 'BLAST against the genome database'}
            {plan.fallback && ' (BLAST is not available here)'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {!running && (
          <AnalysisButton variant="primary" theme="blue" onClick={find} disabled={!parsed?.ok || Boolean(problem)}
            title={problem ? problem.message : 'Find this sequence in the genome (Ctrl/Cmd+Enter)'} data-testid="seqsearch-find">
            Find in genome
          </AnalysisButton>
        )}
        {running && <AnalysisButton onClick={() => void cancelSearch()} data-testid="seqsearch-cancel">Cancel</AnalysisButton>}
        <AnalysisSelect<SearchMode> value={st.settings.mode} onChange={mode => setSettings({ mode })} options={MODE_OPTIONS}
          title="Which search: Auto uses the exact scan for short queries and any with IUPAC codes, BLAST for longer ones" />
      </div>

      <div>
        <button type="button" className="flex items-center gap-1 text-[11px] text-ink-secondary hover:text-ink"
          aria-expanded={settingsOpen} onClick={() => setSettingsOpen(o => !o)} data-testid="seqsearch-settings-toggle">
          <DisclosureChevron open={settingsOpen} /> Settings
        </button>
        {settingsOpen && (
          <div className="mt-1 flex flex-col gap-1 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="seqsearch-settings">
            <NumberSetting label="Exact search below (bp)" value={st.settings.exact_max_length} testId="seqsearch-exact-max"
              title="Auto: queries shorter than this (and any with IUPAC codes) use the exact scan; longer ones use BLAST"
              onChange={v => setSettings({ exact_max_length: clampSetting('exact_max_length', v) })} />
            <NumberSetting label="Max mismatches (exact)" value={st.settings.max_mismatches} testId="seqsearch-mismatches"
              title="Exact scan: hits may differ from the query at up to this many bases (an N in the genome never matches)"
              onChange={v => setSettings({ max_mismatches: clampSetting('max_mismatches', v) })} />
            <NumberSetting label="E-value (BLAST)" value={st.settings.evalue} step="any" testId="seqsearch-evalue"
              title="BLAST: report hits at or below this e-value"
              onChange={v => setSettings({ evalue: clampSetting('evalue', v) })} />
            <NumberSetting label="Max hits" value={st.settings.max_hits} testId="seqsearch-max-hits"
              title="Hits listed (fewest mismatches / best e-value first). The exact scan counts every hit; BLAST keeps at most this many per contig, so its total can be a lower bound"
              onChange={v => setSettings({ max_hits: clampSetting('max_hits', v) })} />
            <NumberSetting label="Shortest query (bp)" value={st.settings.min_length} testId="seqsearch-min-length"
              title="Shorter queries are refused: they match too many places"
              onChange={v => setSettings({ min_length: clampSetting('min_length', v) })} />
            <label className="flex items-center justify-between gap-2 text-[11px] text-ink-secondary"
              title="BLAST program: Auto uses blastn-short under 50 bp, megablast for longer queries (blastn when BLAST is chosen for approximate matches)">
              <span>BLAST task</span>
              <AnalysisSelect<BlastTask> value={st.settings.blast_task} onChange={blast_task => setSettings({ blast_task })} options={TASK_OPTIONS} />
            </label>
            <div className="flex justify-end">
              <button type="button" className="text-[11px] underline text-ink-secondary" onClick={resetSettings} data-testid="seqsearch-reset">
                Reset to defaults
              </button>
            </div>
          </div>
        )}
      </div>

      {st.status && !problem && (
        <div className="text-[10.5px] text-ink-muted" data-testid="seqsearch-blast-state">
          {!st.status.blast.available
            ? <>BLAST+ was not found, so searches use the exact scan (queries up to {EXACT_HARD_MAX.toLocaleString()} bases). {st.status.blast.hint}</>
            : st.status.blast.db_ready
              ? 'BLAST database for this genome: ready.'
              : 'The first BLAST search indexes this genome once (a few minutes for a large genome); you can cancel it.'}
          {st.status.plasmids.length > 0 && <> Loaded plasmid sequences are searched too (exact search).</>}
        </div>
      )}
      {st.statusError && <div className="text-[11px] text-red-600 dark:text-red-400">{st.statusError}</div>}

      {running && (
        <JobStatus compact title="Find sequence" state="running" stage={st.message || 'Searching'}
          startedAt={st.startedAt} progress={st.progress ? { fraction: st.progress } : null}
          onCancel={() => void cancelSearch()} testId="seqsearch-progress" />
      )}
      {st.run === 'error' && st.error && (
        <div className="text-[11px] text-red-600 dark:text-red-400" role="alert" data-testid="seqsearch-error" data-code={st.errorCode ?? ''}>{st.error}</div>
      )}
      {st.run === 'cancelled' && <div className="text-[11px] text-ink-muted" data-testid="seqsearch-cancelled">Stopped.</div>}

      {result && (
        <div className="flex flex-col gap-1.5" data-testid="seqsearch-results">
          <div className="text-[12px] font-semibold text-ink" data-testid="seqsearch-summary">{resultSummary(result)}</div>
          {result.notes.map(note => <div key={note} className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="seqsearch-note">{note}</div>)}
          {stale && <div className="text-[11px] text-amber-700 dark:text-amber-400" role="status" data-testid="seqsearch-stale">{STALE_REFERENCE_MESSAGE}</div>}
          {result.hits.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <AnalysisButton onClick={() => void addHitsTrack()} disabled={st.trackJobId === st.jobId || stale || st.referencePending}
                title="Show every hit as a temporary annotation track (this session only)" data-testid="seqsearch-add-track">
                {st.trackJobId === st.jobId ? 'Added as track' : 'Add hits as track'}
              </AnalysisButton>
              <AnalysisButton onClick={exportBed} title="Save the hits as a BED file (BED6)" data-testid="seqsearch-export-bed">Export BED</AnalysisButton>
            </div>
          )}
          {st.notice && <div className="text-[11px] text-ink-muted" data-testid="seqsearch-notice">{st.notice}</div>}
          {result.hits.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[11px]" data-testid="seqsearch-hits">
                <thead>
                  <tr className="text-left text-ink-secondary">
                    <th className="px-1 py-0.5 font-medium">#</th>
                    <th className="px-1 py-0.5 font-medium">Location</th>
                    <th className="px-1 py-0.5 font-medium">Strand</th>
                    <th className="px-1 py-0.5 font-medium">Match</th>
                    {result.mode === 'blast' && <th className="px-1 py-0.5 font-medium">E-value</th>}
                    <th className="px-1 py-0.5 font-medium">Matched sequence</th>
                  </tr>
                </thead>
                <tbody>
                  {result.hits.map((hit, i) => (
                    <tr key={`${hit.chrom}:${hit.start}:${hit.strand}:${i}`}
                      className={`cursor-pointer border-t border-slate-100 hover:bg-sky-50 dark:border-slate-800 dark:hover:bg-sky-900/20 ${st.activeHit === i ? 'bg-sky-100 dark:bg-sky-900/40' : ''}`}
                      onClick={() => { const why = goToHit(i); if (why) setNotice(why); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const why = goToHit(i); if (why) setNotice(why); } }}
                      tabIndex={0} aria-selected={st.activeHit === i} title={`Go to ${hitLocus(hit)}`}
                      data-testid="seqsearch-hit" data-locus={`${hit.chrom}:${hit.start}-${hit.end}`}>
                      <td className="px-1 py-0.5 tabular-nums text-ink-muted">{i + 1}</td>
                      <td className="px-1 py-0.5 tabular-nums whitespace-nowrap text-ink">{hitLocus(hit)}</td>
                      <td className="px-1 py-0.5 text-center">{hit.strand === '.' ? '±' : hit.strand}</td>
                      <td className="px-1 py-0.5 whitespace-nowrap">{hitMatchText(hit)}{result.mode === 'blast' ? ` · ${hit.identity}%` : ''}</td>
                      {result.mode === 'blast' && <td className="px-1 py-0.5 tabular-nums whitespace-nowrap">{formatEvalue(hit.evalue)}</td>}
                      <td className="px-1 py-0.5 font-mono text-[10.5px] whitespace-nowrap"><MatchedSequence hit={hit} query={result.query} mode={result.mode} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SequenceSearchPanel;
