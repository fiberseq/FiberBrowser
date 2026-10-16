/**
 * The motif parameters every motif view shares (the Footprints panel's Saved classes, plugin packs' motif views): one
 * search box where Enter pins a motif, the threshold and its mode inline (the shared motif scoring), the pinned motifs
 * as chips to unpin, and one message line. A pinned or searched motif with no site at the threshold says so once, with
 * "Relax to p ≤ 0.001" (one step looser), instead of a dead end. The threshold's scope is said on screen ("shared across
 * motif views"): relaxing it in one view changes every view (N23).
 *
 * Presentational: the caller resolves what a typed text pins (a name, a consensus, a matrix) and which motifs have no
 * site; the threshold lives in the browser store (motifScoreMode, motifPValue, motifThreshold) so every view agrees.
 */
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { formatP, MOTIF_P_MAX } from '../../../utils/motifSettings';
import { Pin, X } from '../../ui/Icons';
import { MotifScoringControl } from './MotifScoringControl';

/** The threshold in words: "p ≤ 1e−4" or "score ≥ 80%". */
export function motifThresholdText(mode: 'p' | 'relative', p: number, relative: number): string {
  return mode === 'relative' ? `score ≥ ${Math.round(relative * 100)}%` : `p ≤ ${formatP(p)}`;
}

/** One step looser: p ten times larger (at most 1e−2), or the relative score 5 points lower (at least 50%). Null when
 * already at the loosest. */
export function relaxedThreshold(mode: 'p' | 'relative', p: number, relative: number): { p?: number; relative?: number } | null {
  if (mode === 'p') {
    const next = Math.min(MOTIF_P_MAX, Number((p * 10).toPrecision(2)));
    return next > p ? { p: next } : null;
  }
  const next = Math.max(0.5, Math.round((relative - 0.05) * 100) / 100);
  return next < relative ? { relative: next } : null;
}

/** The shared threshold, its text, and "Relax threshold" (a hook). */
export function useMotifThreshold() {
  const { mode, p, relative, setP, setRelative } = useBrowserStore(useShallow(s => ({
    mode: s.motifScoreMode, p: s.motifPValue, relative: s.motifThreshold, setP: s.setMotifPValue, setRelative: s.setMotifThreshold,
  })));
  const next = relaxedThreshold(mode, p, relative);
  return {
    mode, p, relative, text: motifThresholdText(mode, p, relative),
    relax: next ? () => { if (next.p != null) setP(next.p); if (next.relative != null) setRelative(next.relative); } : null,
    relaxedText: next ? motifThresholdText(mode, next.p ?? p, next.relative ?? relative) : null,
  };
}

export interface MotifPinBarProps {
  /** The pinned motifs, in order (chips). */
  pinned: string[];
  /** Search + Enter: pin what was typed (the caller resolves it). */
  onPin: (text: string) => void;
  onUnpin?: (name: string) => void;
  /** Back to the species' default pins (shown when the list is the user's own). */
  onReset?: () => void;
  /** The search box, when the caller also filters by it (controlled); else it is local to the box. */
  query: string;
  onQuery: (text: string) => void;
  /** Motifs (pinned or searched) with no site at the threshold: one line, with Relax threshold. */
  zeroHits?: string[];
  /** What was just done, said before the zero-hit line ("Added CAGGTAG (7 bp), pinned"). */
  zeroLead?: string | null;
  /** The one message about the last action (pinned, not found, scanning…); shown in place of the zero-hit line. */
  notice?: { ok: boolean; text: string } | null;
  /** Default factors JASPAR CORE lacks: said plainly. */
  unavailable?: string[];
  /** What the pins are for, after the chips. */
  pinsNote?: string;
  /** After "Pinned (N)": how many have a site here, say. */
  pinnedSummary?: string;
  /** The chips start open (default: closed behind "Pinned (N)"). */
  pinnedOpen?: boolean;
  /** Chip details (a site count, a substitution) by name. */
  chipTitle?: (name: string) => string | undefined;
  /** Chips drawn faint (no site here). */
  chipFaint?: (name: string) => boolean;
  /** Show the scoring control inline (default true). */
  scoring?: boolean;
  placeholder?: string;
  testIdPrefix?: string;
  /** Extra controls at the end of the first row (a summary, a count). */
  extra?: React.ReactNode;
  /** Paste of several lines (a matrix): pinned as it is. */
  onPasteBlock?: (text: string) => void;
}

export function MotifPinBar({
  pinned, onPin, onUnpin, onReset, query, onQuery, zeroHits = [], zeroLead, notice, unavailable = [], pinsNote, pinnedSummary, pinnedOpen = false,
  chipTitle, chipFaint, scoring = true, placeholder = 'Find a motif (Enter pins it)', testIdPrefix = 'motif-pins', extra, onPasteBlock,
}: MotifPinBarProps) {
  const t = useMotifThreshold();
  const [open, setOpen] = useState(pinnedOpen);
  const id = (s: string) => `${testIdPrefix}-${s}`;
  return (
    <div className="space-y-1 text-[11px]" data-testid={testIdPrefix}>
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" value={query} onChange={e => onQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && query.trim()) { e.preventDefault(); onPin(query.trim()); } }}
          onPaste={onPasteBlock ? e => { const text = e.clipboardData.getData('text'); if (/\n/.test(text.trim())) { e.preventDefault(); onPasteBlock(text); } } : undefined}
          placeholder={placeholder} aria-label="Find or pin a motif" data-testid={id('search')}
          title="Type a motif name to find it; Enter pins it (always reported, besides the best matches). A consensus in capitals (e.g. CAGGTAG) or a pasted matrix is added as your own motif."
          className="min-w-[10rem] flex-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 dark:border-gray-700 dark:bg-gray-900" />
        <span className="whitespace-nowrap text-gray-600 dark:text-gray-300" data-testid={id('threshold')} title="The threshold sites are called at. It is one setting for every motif view: changing it here changes them all.">
          Sites at <span className="font-medium tabular-nums text-gray-800 dark:text-gray-100">{t.text}</span>
          <span className="ml-1 text-[10px] text-ink-muted" data-testid={id('threshold-scope')}>· shared across motif views</span>
        </span>
        {extra}
      </div>
      {scoring && <MotifScoringControl compact testIdPrefix={id('scoring')} />}
      {notice ? (
        <p className={notice.ok ? 'text-gray-700 dark:text-gray-200' : 'text-red-600 dark:text-red-400'} role="status" data-testid={id('notice')}>{notice.text}</p>
      ) : zeroHits.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-gray-700 dark:text-gray-200" role="status" data-testid={id('zero')} data-names={zeroHits.join(',')}>
          {zeroLead && <span>{zeroLead} ·</span>}
          <span><span className="font-medium">{zeroHits.slice(0, 6).join(', ')}{zeroHits.length > 6 ? ` +${zeroHits.length - 6} more` : ''}</span>: no site at {t.text}</span>
          {t.relax && (
            <button type="button" onClick={t.relax} data-testid={id('relax')}
              title={`Call sites at ${t.relaxedText} instead, in every motif view (the threshold is shared)`}
              className="rounded px-1 font-medium text-fuchsia-700 underline-offset-2 hover:underline dark:text-fuchsia-300">· Relax to {t.relaxedText}</button>
          )}
        </p>
      ) : null}
      {(pinned.length > 0 || onReset) && (
        <div className="flex flex-wrap items-center gap-1" data-testid={id('pinned')}>
          <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} data-testid={id('pinned-toggle')}
            className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
            title="Pinned motifs are always reported when they have a site here, besides the best matches; shared by the motif views and kept per species">
            <Pin size={11} aria-hidden="true" /> Pinned ({pinned.length}){pinnedSummary ? ` · ${pinnedSummary}` : ''} {open ? '▴' : '▾'}
          </button>
          {open && pinned.map(name => (
            <span key={name} data-testid={id('chip')} data-name={name}
              className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-px ${unavailable.includes(name) ? 'bg-gray-100 text-gray-500 line-through dark:bg-white/5'
                : chipFaint?.(name) ? 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400' : 'bg-fuchsia-50 text-fuchsia-900 dark:bg-fuchsia-900/30 dark:text-fuchsia-100'}`}
              title={unavailable.includes(name) ? `${name}: default factor unavailable in JASPAR CORE` : chipTitle?.(name)}>
              {name}
              {onUnpin && (
                <button type="button" onClick={() => onUnpin(name)} aria-label={`Unpin ${name}`} className="ml-0.5 opacity-60 hover:opacity-100">
                  <X size={10} aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
          {open && onReset && <button type="button" onClick={onReset} data-testid={id('reset')} className="text-[10px] text-fuchsia-700 hover:underline dark:text-fuchsia-300">defaults</button>}
          {open && pinsNote && <span className="text-[10px] text-ink-muted">{pinsNote}</span>}
        </div>
      )}
      {unavailable.length > 0 && (
        <p className="text-[10px] text-ink-muted" data-testid={id('unavailable')}>Default factor{unavailable.length === 1 ? '' : 's'} unavailable in JASPAR CORE: {unavailable.join(', ')}</p>
      )}
    </div>
  );
}
