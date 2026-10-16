/**
 * Motif scoring, shared by the motif views (the Footprints panel's, and plugin packs'): p-value (default; comparable across motifs)
 * or relative score % (the older per-matrix share of the score range). Each mode keeps its own threshold; the p-value
 * is set on a log slider (1e-2 to 1e-8, 0.1 log10 steps) or typed. Changes are committed once the control rests.
 */
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { formatP, MOTIF_P_MAX, MOTIF_P_MIN, parseP, type MotifScoreMode } from '../../../utils/motifSettings';

const LOG_MIN = Math.log10(MOTIF_P_MIN);
const LOG_MAX = Math.log10(MOTIF_P_MAX);
export const MODE_HELP: Record<MotifScoreMode, string> = {
  p: 'p-value: a site passes when its score is this unlikely by chance for its own matrix, so motifs of any length are comparable.',
  relative: 'Relative score %: the older per-matrix share of the maximum score; short motifs pass more often than long ones.',
};

export function MotifScoringControl({ compact = false, testIdPrefix = 'motif-scoring' }: { compact?: boolean; testIdPrefix?: string }) {
  const { mode, p, relative, setMode, setP, setRelative } = useBrowserStore(useShallow(s => ({
    mode: s.motifScoreMode, p: s.motifPValue, relative: s.motifThreshold,
    setMode: s.setMotifScoreMode, setP: s.setMotifPValue, setRelative: s.setMotifThreshold,
  })));
  const [logDraft, setLogDraft] = useState(Math.log10(p));
  const [text, setText] = useState(formatP(p));
  const [relDraft, setRelDraft] = useState(relative);
  useEffect(() => { setLogDraft(Math.log10(p)); setText(formatP(p)); }, [p]);
  useEffect(() => { setRelDraft(relative); }, [relative]);
  // commit once the slider rests
  useEffect(() => {
    const next = Number((10 ** logDraft).toPrecision(2));
    if (Math.abs(Math.log10(next) - Math.log10(p)) < 1e-9) return;
    const t = window.setTimeout(() => setP(next), 350);
    return () => window.clearTimeout(t);
  }, [logDraft, p, setP]);
  useEffect(() => {
    if (relDraft === relative) return;
    const t = window.setTimeout(() => setRelative(relDraft), 350);
    return () => window.clearTimeout(t);
  }, [relDraft, relative, setRelative]);
  const commitText = () => {
    const v = parseP(text);
    if (v == null) { setText(formatP(p)); return; }
    setP(Number(v.toPrecision(2)));
  };
  return (
    <div className={`flex flex-wrap items-center gap-2 text-[11px] ${compact ? '' : 'py-0.5'}`} data-testid={testIdPrefix}>
      <span className="inline-flex overflow-hidden rounded border border-gray-200 dark:border-gray-700" role="radiogroup" aria-label="Motif scoring mode">
        {(['p', 'relative'] as const).map(m => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} title={MODE_HELP[m]} data-testid={`${testIdPrefix}-mode-${m}`}
            onClick={() => setMode(m)}
            className={`px-1.5 py-px ${mode === m ? 'bg-fuchsia-100 font-semibold text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}>
            {m === 'p' ? 'p-value' : 'relative %'}
          </button>
        ))}
      </span>
      {mode === 'p' ? (
        <label className="flex items-center gap-1" title={MODE_HELP.p}>
          p ≤
          <input type="range" min={LOG_MIN} max={LOG_MAX} step={0.1} value={logDraft} aria-label="Motif p-value (log scale)"
            data-testid={`${testIdPrefix}-p-slider`}
            onChange={e => { const v = Number(e.target.value); setLogDraft(v); setText(formatP(Number((10 ** v).toPrecision(2)))); }}
            className="w-28 accent-fuchsia-600" style={{ direction: 'rtl' }} />
          <input type="text" value={text} onChange={e => setText(e.target.value)} onBlur={commitText}
            onKeyDown={e => { if (e.key === 'Enter') commitText(); }} aria-label="Motif p-value" data-testid={`${testIdPrefix}-p-input`}
            className="w-16 rounded border border-gray-200 bg-white px-1 py-px tabular-nums dark:border-gray-700 dark:bg-gray-900" />
        </label>
      ) : (
        <label className="flex items-center gap-1" title={MODE_HELP.relative}>
          score ≥
          <input type="range" min={0.5} max={0.99} step={0.01} value={relDraft} aria-label="Motif relative score"
            data-testid={`${testIdPrefix}-relative-slider`} onChange={e => setRelDraft(Number(e.target.value))} className="w-24 accent-fuchsia-600" />
          <span className="w-9 tabular-nums">{Math.round(relDraft * 100)}%</span>
        </label>
      )}
      {!compact && <span className="text-[10px] text-gray-400">{MODE_HELP[mode]}</span>}
    </div>
  );
}
