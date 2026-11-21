/**
 * The only meta-locus controls outside the normal browser:
 * - MetaLocusProgressStrip: a thin strip while the pool builds (fraction, ETA, Cancel); gone when ready.
 * - MetaLocusControls: on the meta contig, the working set (N of pool, More reads, Resample, seed), Back to the real
 *   locus, and the honest-frequency line of the latest "Find more like this" with the enriched badge.
 */
import { useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import {
  PROVISIONAL_AT, backToRealLocus, cancelMetaLocus, clearExtra, dismissMetaNotice, moreReads, resample, returnToMetaLocus, useMetaLocusStore,
} from './metaLocusStore';
import { isMetaChrom, metaLabel } from './metaChrom';
import { META_LOCUS_PREVIEW } from './preview';
import { PreviewBadge } from '../../components/ui/PreviewBadge';

export const ENRICHED_TEXT = 'enriched — counts shown are not frequencies';

const pct = (value: number | null | undefined) => {
  const x = Number(value);
  return Number.isFinite(x) ? `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%` : '–';
};

function etaWords(eta: number | null | undefined): string {
  if (eta == null || !Number.isFinite(eta)) return '';
  if (eta < 60) return `${Math.max(1, Math.round(eta))} s left`;
  return `${Math.round(eta / 60)} min left`;
}

export function MetaLocusProgressStrip() {
  const status = useMetaLocusStore(s => s.status);
  const view = useMetaLocusStore(s => s.view);
  const error = useMetaLocusStore(s => s.error);
  const notice = useMetaLocusStore(s => s.notice);
  if (notice) {
    return (
      <div data-testid="meta-locus-notice" role="status" className="flex items-center gap-2 border-b border-line/80 bg-amber-50/90 px-2 py-0.5 text-[11px] text-amber-900 dark:border-white/10 dark:bg-amber-500/10 dark:text-amber-200">
        <span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span>
        <button type="button" className="shrink-0 rounded px-1.5 hover:bg-black/5 dark:hover:bg-white/10" data-testid="meta-locus-notice-dismiss" onClick={() => dismissMetaNotice()} aria-label="Dismiss">×</button>
      </div>
    );
  }
  if (!status || (status.status !== 'building' && !(status.status === 'error' && error))) return null;
  const p = status.progress ?? {};
  const fraction = Math.max(0, Math.min(1, Number(p.fraction ?? 0)));
  return (
    <div data-testid="meta-locus-progress" role="status"
      className="flex min-h-[28px] w-full items-center gap-3 border-b border-blue-200 bg-blue-50 px-3 py-1 text-xs text-gray-700 dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-gray-200">
      <span className="shrink-0 font-semibold">Building meta-locus · {metaLabel(status)}</span>
      {status.status === 'building' ? (
        <>
          <div className="h-2 min-w-[8rem] flex-1 overflow-hidden rounded bg-blue-100 dark:bg-white/10" role="progressbar" aria-label="Pool build progress"
            aria-valuenow={Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${fraction * 100}%` }} data-testid="meta-locus-progress-bar" />
          </div>
          <span className="shrink-0 tabular-nums" data-testid="meta-locus-progress-text">
            {Math.round(fraction * 100)}%{p.sites_total ? ` · ${(p.sites_done ?? 0).toLocaleString()} of ${p.sites_total.toLocaleString()} sites` : ''}{etaWords(p.eta_s) ? ` · ${etaWords(p.eta_s)}` : ''}
            {view ? ' · provisional reads shown' : ` · first reads at ~${Math.round(PROVISIONAL_AT * 100)}%`}
          </span>
          <button type="button" className="shrink-0 rounded border border-blue-300 px-2 py-0.5 font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-400/40 dark:text-blue-200 dark:hover:bg-blue-500/20"
            data-testid="meta-locus-cancel" onClick={() => void cancelMetaLocus()}>Cancel</button>
        </>
      ) : (
        <span className="text-red-600 dark:text-red-400" data-testid="meta-locus-error">{error}</span>
      )}
    </div>
  );
}

/** In a read panel on the meta contig while the pool builds and no reads are shown yet: say what is happening. */
export function MetaReadsPending({ chrom }: { chrom: string | null | undefined }) {
  const status = useMetaLocusStore(s => s.status);
  const view = useMetaLocusStore(s => s.view);
  if (!isMetaChrom(chrom) || status?.status !== 'building' || view) return null;
  const fraction = Math.max(0, Math.min(1, Number(status.progress?.fraction ?? 0)));
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-2 pointer-events-none" data-testid="meta-reads-pending" data-render-hide="true">
      <div className="rounded-lg border border-blue-200 bg-white/95 px-4 py-3 text-center text-xs text-gray-600 shadow-sm dark:border-blue-400/30 dark:bg-gray-800/95 dark:text-gray-300">
        <div className="font-medium text-gray-700 dark:text-gray-200">Building pool… {Math.round(fraction * 100)}%</div>
        <div>First reads appear at ~{Math.round(PROVISIONAL_AT * 100)}%; the final working set when the pool is ready.</div>
      </div>
    </div>
  );
}

export function MetaLocusControls() {
  const chrom = useBrowserStore(s => s.chrom);
  const status = useMetaLocusStore(s => s.status);
  const view = useMetaLocusStore(s => s.view);
  const seed = useMetaLocusStore(s => s.seed);
  const busy = useMetaLocusStore(s => s.busy);
  const findMore = useMetaLocusStore(s => s.findMore);
  const lastRealLocus = useMetaLocusStore(s => s.lastRealLocus);
  const [seedText, setSeedText] = useState<string | null>(null);
  const onMeta = isMetaChrom(chrom);
  if (!onMeta) {
    // Off the meta contig (an opened site): one way back in.
    if (status?.status !== 'ready' || !view) return null;
    return (
      <button type="button" data-testid="meta-locus-return" onClick={() => returnToMetaLocus()}
        className="rounded px-1.5 py-1 text-[11px] text-blue-600 hover:bg-blue-500/10 dark:text-blue-300" title="Back to the meta-locus">
        ↩ {metaLabel(status)}
      </button>
    );
  }
  const shown = (view?.count ?? 0) + (view?.extra_count ?? 0);
  const pool = view?.pool_total ?? 0;
  const commitSeed = () => {
    if (seedText == null) return;
    const value = Number(seedText);
    setSeedText(null);
    if (Number.isFinite(value) && value !== seed) void resample(Math.round(value));
  };
  return (
    <div className="flex flex-nowrap items-center gap-1 whitespace-nowrap text-[11px] text-gray-600 dark:text-gray-300" data-testid="meta-locus-controls">
      <PreviewBadge feature={META_LOCUS_PREVIEW} />
      {lastRealLocus && (
        <button type="button" data-testid="meta-locus-back" onClick={() => backToRealLocus()}
          className="rounded px-1.5 py-1 hover:bg-black/5 dark:hover:bg-white/10" title={`Back to ${lastRealLocus.chrom}:${lastRealLocus.start.toLocaleString()}-${lastRealLocus.end.toLocaleString()}`}>
          ← Back
        </button>
      )}
      <span className="tabular-nums" data-testid="meta-locus-count" title="Reads shown (read-site observations) of the pool">
        {Math.min(shown, pool || shown).toLocaleString()} of {pool.toLocaleString()}
      </span>
      <button type="button" className="rounded px-1.5 py-1 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10" data-testid="meta-locus-more"
        disabled={busy || (pool > 0 && shown >= pool)} onClick={() => void moreReads()} title="The next reads of the pool's sampling order (the shown ones stay)">More reads</button>
      <button type="button" className="rounded px-1.5 py-1 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10" data-testid="meta-locus-resample"
        disabled={busy} onClick={() => void resample()} title="Another sample of the pool (next seed)">Resample</button>
      <label className="flex items-center gap-1" title="The sampling seed: the same seed shows the same reads">
        seed
        <input data-testid="meta-locus-seed-input" className="input-tool w-12 py-0 text-[11px]" value={seedText ?? String(seed)}
          onChange={e => setSeedText(e.target.value)} onBlur={commitSeed} onKeyDown={e => { if (e.key === 'Enter') commitSeed(); }} />
      </label>
      {(view?.enriched || findMore) && <FindMoreChip summary={findMore} enriched={!!view?.enriched} />}
    </div>
  );
}

/**
 * The latest "Find more like this" answer and the enriched state, as one compact chip (it never wraps the top bar):
 * "enriched · 12.5%"; its popover has the honest frequency in full (matches / read-site observations scanned, Wilson
 * 95%), what enriched means, and Clear.
 */
export function FindMoreChip({ summary, enriched }: { summary: { found: number; scanned: number; freq: number; wilson: [number, number] } | null; enriched: boolean }) {
  const [open, setOpen] = useState(false);
  const label = [enriched ? 'enriched' : null, summary ? pct(summary.freq) : null].filter(Boolean).join(' · ');
  return (
    <span className="relative inline-flex shrink-0">
      <button type="button" data-testid="meta-locus-enriched" aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen(o => !o)} title={summary ? findMoreWords(summary) : ENRICHED_TEXT}
        className="whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200">
        {label}
      </button>
      {open && (
        <span role="dialog" data-testid="meta-locus-find-more-popover"
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded border border-line bg-white p-2 text-[11px] text-gray-700 shadow-lg dark:border-white/10 dark:bg-dark-bg dark:text-gray-200">
          {summary && <span className="block" data-testid="meta-locus-find-more">{findMoreWords(summary)}</span>}
          {enriched && <span className="mt-1 block text-amber-800 dark:text-amber-200" data-testid="meta-locus-enriched-text">{ENRICHED_TEXT}</span>}
          <span className="mt-2 flex justify-end gap-2">
            {enriched && (
              <button type="button" className="rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-500/10 dark:text-blue-300" data-testid="meta-locus-clear-extra"
                onClick={() => { setOpen(false); void clearExtra(); }}>Clear added reads</button>
            )}
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setOpen(false)}>Close</button>
          </span>
        </span>
      )}
    </span>
  );
}

/** "found X of Y read-site observations scanned · freq Z% (Wilson 95% a–b%)". */
export function findMoreWords(f: { found: number; scanned: number; freq: number; wilson: [number, number] }): string {
  return `found ${f.found.toLocaleString()} of ${f.scanned.toLocaleString()} read-site observations scanned · freq ${pct(f.freq)} (Wilson 95% ${pct(f.wilson[0])}–${pct(f.wilson[1])})`;
}

