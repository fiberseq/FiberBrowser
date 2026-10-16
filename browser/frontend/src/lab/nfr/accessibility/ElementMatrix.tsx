import { useMemo } from 'react';
import type { AccessibilityPair, AccessibilityResult } from '../api';
import { effectColor, elementColor, inFocus, pairEffect, pairKey, pairTooltip, pct, shortElement } from '../accessibilityView';
import { shownElements, shownIdOf, type ShownElement } from '../nfrPairsLayout';

/** A cell's pairs: the run's pairs between the two drawn elements, the passing ones first, strongest first. */
function cellPairs(pairs: readonly AccessibilityPair[], row: ShownElement, col: ShownElement, passing: Set<string> | null | undefined): AccessibilityPair[] {
  const A = new Set(row.members), B = new Set(col.members);
  const pass = (p: AccessibilityPair) => !passing || passing.has(pairKey(p.a, p.b));
  return pairs.filter(p => (A.has(p.a) && B.has(p.b)) || (A.has(p.b) && B.has(p.a)))
    .sort((x, y) => Number(pass(y)) - Number(pass(x)) || Math.abs(pairEffect(y) ?? -1) - Math.abs(pairEffect(x) ?? -1) || x.q - y.q);
}

/**
 * Element x element matrix, square and mirrored (a pair's test is symmetric: the same cell above and below the
 * diagonal): the openness-adjusted log2 OR of each tested pair (red: open together, blue: apart), * for q <= 0.1, ×
 * for overlapping elements (one opening cannot be two elements), · for pairs too sparse to test. The diagonal holds
 * each element's own open share (its prevalence), muted. An NFR folded to one (nfrPairsLayout) has one row: its cells show the
 * strongest of its variants' pairs; ▸ unfolds it into its variants, here and on the arcs and the NFR track alike.
 * Hover a cell for the 2x2 table and the pooled value.
 */
export function ElementMatrix({ result, includeClasses, qMax = 0.1, onPick, selected, passing, focus = null, expanded = [], onToggle }: {
  result: AccessibilityResult; includeClasses: boolean; qMax?: number;
  /** The pairs that pass the panel's filters (pairKey): only they are coloured; null: every tested pair. */
  passing?: Set<string> | null;
  /** Only the rows and columns of the selected element or NFR and its partners. */
  focus?: string | null;
  /** Click a cell: inspect that pair (a folded NFR: its strongest; overlapping pairs have none). */
  onPick?: (a: string, b: string) => void;
  selected?: string | null;
  /** The NFRs unfolded into their variants. */
  expanded?: readonly string[];
  onToggle?: (nfrId: string, open: boolean) => void;
}) {
  const byId = useMemo(() => new Map(result.elements.map(e => [e.id, e])), [result]);
  const elements = useMemo(() => {
    const all = shownElements(result, expanded, includeClasses);
    if (!focus) return all;
    const of = shownIdOf(all);
    const keep = new Set(all.filter(e => e.id === focus || e.members.some(m => inFocus(m, focus, byId))).map(e => e.id));
    for (const p of result.pairs) {
      if (passing && !passing.has(pairKey(p.a, p.b))) continue;
      const a = of.get(p.a), b = of.get(p.b);
      if (!a || !b) continue;
      if (keep.has(a) || keep.has(b)) { keep.add(a); keep.add(b); }
    }
    return all.filter(e => keep.has(e.id));
  }, [result, includeClasses, focus, passing, byId, expanded]);
  const skipped = useMemo(() => new Map(result.family.skipped.map(s => [pairKey(s.a, s.b), s.reason])), [result]);
  const [selA, selB] = selected ? selected.split('|') : [];
  // one folded NFR alone still shows (its open share, and ▸ to compare its variants)
  if (elements.length === 0 || (elements.length === 1 && !elements[0].group)) return <p className="text-[11px] text-gray-500">Fewer than two elements: nothing to compare.</p>;
  const head = (e: ShownElement, vertical: boolean) => {
    const name = <span className={`inline-block max-w-[3.2rem] truncate ${vertical ? '[writing-mode:vertical-rl] rotate-180' : ''}`}>{e.group && !e.group.expanded ? e.id : shortElement(e, e.id)}</span>;
    if (!onToggle || !e.group) return name;
    const open = e.group.expanded;
    return (
      <button type="button" onClick={() => onToggle(e.group!.nfr, !open)} aria-expanded={open} data-testid="nfr-matrix-toggle" data-nfr={e.group.nfr}
        title={open ? `Fold ${e.group.nfr} to one row` : `Show ${e.group.nfr}'s ${e.group.size} variants`}
        className={`inline-flex items-center gap-0.5 hover:underline ${vertical ? 'flex-col-reverse' : ''}`}>
        {name}<span aria-hidden="true" className="text-[9px] text-ink-muted">{open ? '▾' : '▸'}</span>
      </button>
    );
  };
  return (
    <div className="overflow-auto" data-testid="nfr-matrix">
      <table className="border-collapse text-[10px] tabular-nums">
        <thead>
          <tr>
            <th />
            {elements.map(e => (
              <th key={e.id} className="px-0.5 pb-1 align-bottom font-medium" style={{ color: elementColor(e) }} title={e.label}>{head(e, true)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {elements.map((row, ri) => (
            <tr key={row.id}>
              <th className="whitespace-nowrap pr-1 text-right font-medium" style={{ color: elementColor(row) }} title={row.label}>{head(row, false)}</th>
              {elements.map((col, ci) => {
                if (ci === ri) {
                  const p = row.prevalence;
                  return (
                    <td key={col.id} data-testid="nfr-matrix-diag" data-element={row.id}
                      className="h-6 w-7 border border-white text-center text-[9px] text-gray-500 dark:border-gray-900 dark:text-gray-400"
                      style={{ background: p == null ? 'transparent' : `rgba(107, 114, 128, ${(0.08 + 0.3 * Math.max(0, Math.min(1, p))).toFixed(3)})` }}
                      title={p == null ? `${row.label}: open share not known` : `${row.label}: open on ${pct(p, 1)} of its reads${row.group && !row.group.expanded ? ' (any of its variants)' : ''}`} />
                  );
                }
                const single = row.members.length === 1 && col.members.length === 1;
                const pairs = cellPairs(result.pairs, row, col, passing);
                const pair = pairs[0] ?? null;
                const reason = single ? skipped.get(pairKey(row.id, col.id)) : undefined;
                const key = pair ? pairKey(pair.a, pair.b) : null;
                const pass = !!pair && (!passing || passing.has(key!));
                const effect = pair && pass ? pairEffect(pair) : null;
                const sig = pass && pair!.q <= qMax && (pair!.class === 'co-accessible' || pair!.class === 'anti');
                const pickable = !!onPick && reason !== 'overlap' && (single || !!pair);
                const isSelected = !!selected && ((row.members.includes(selA) && col.members.includes(selB)) || (row.members.includes(selB) && col.members.includes(selA)));
                const several = pairs.length > 1 ? `\n(strongest of ${pairs.length} variant pairs here; unfold ${[row, col].filter(e => e.group && !e.group.expanded).map(e => e.id).join(' or ')} for each)` : '';
                return (
                  <td key={col.id} data-testid="nfr-matrix-cell" data-pair={pair ? `${pair.a}|${pair.b}` : undefined} data-cell={`${row.id}|${col.id}`}
                    data-mirror={ci > ri ? 'true' : undefined}
                    data-selected={isSelected ? 'true' : undefined}
                    onClick={pickable ? () => onPick!(pair ? pair.a : col.id, pair ? pair.b : row.id) : undefined}
                    className={`h-6 w-7 border border-white text-center dark:border-gray-900 ${pickable ? 'cursor-pointer hover:outline hover:outline-1 hover:outline-fuchsia-400' : ''} ${isSelected ? 'outline outline-2 outline-fuchsia-500' : ''}`}
                    style={{ background: effectColor(effect) }}
                    title={pair ? pairTooltip(pair, byId) + several : reason === 'overlap' ? 'These elements overlap: one opening cannot be two elements, so the pair is not tested.' : reason ? `Not tested: ${reason}` : 'Not tested'}>
                    {pair ? (sig ? '*' : pass ? '' : <span className="text-gray-300 dark:text-gray-700">·</span>) : reason === 'overlap' ? '×' : '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
