import { scrollIntoViewWithin } from '../../../utils/scrollWithin';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessibilityElement, AccessibilitySplit, SplitGroup } from '../api';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import { useBrowserStore } from '../../../stores/browserStore';
import { bp, DIRECTION, formatQ, Q_HELP, signed } from '../accessibilityView';
import { getClusterColor } from '../../../components/tracks/read-track/constants';
import { OverlayProfileChart } from '../../../components/charts/OverlayProfileChart';
import { AnalysisButton } from '../../../components/controls/shared';
import { DisclosureChevron } from '../../../components/ui/Disclosure';

const VERDICT: Record<string, { text: string; cls: string }> = {
  'co-accessible': { text: DIRECTION['co-accessible'], cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200' },
  anti: { text: DIRECTION.anti, cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200' },
  'independence-compatible': { text: DIRECTION['independence-compatible'], cls: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300' },
  unresolved: { text: DIRECTION.unresolved, cls: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400' },
};

function GroupChip({ group, onFocus, focused }: { group: SplitGroup; onFocus?: () => void; focused?: boolean }) {
  return (
    <button type="button" onClick={onFocus} disabled={!onFocus} data-testid="nfr-split-group" data-group={group.key}
      title={onFocus ? 'Show only this group in the read panels (click again for all)' : undefined}
      className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors ${focused ? 'bg-fuchsia-100 ring-1 ring-fuchsia-300 dark:bg-fuchsia-900/30 dark:ring-fuchsia-700' : 'hover:bg-gray-100 dark:hover:bg-white/5'}`}>
      <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: getClusterColor(group.id) }} />
      <span className="min-w-0 truncate">{group.label}</span>
      <span className="ml-auto tabular-nums font-semibold">{group.molecules.toLocaleString()}</span>
    </button>
  );
}

/**
 * The drill-down card of an arc, a matrix cell or a pair row: the pair's reads as A+B+, A+B−, A−B+, A−B− (the test's
 * 2x2 table) and the reads the test could not use, with the openness-adjusted effect, the breakdown per stratum, the
 * spacing on molecules carrying both, and each group's accessibility. Inspecting leaves the read panels as they are;
 * "Group reads by this pair" puts the groups there, and "Restore previous grouping" takes them back.
 */
export function PairDetail({ split, byId, mode, onGroup, onClear, onReapply, onClose, focusKeys }: {
  split: AccessibilitySplit; byId: Map<string, AccessibilityElement>;
  /** inspect: not in the read panels; grouped: the read panels hold these groups; replaced: they did, not now. */
  mode: 'inspect' | 'grouped' | 'replaced';
  onGroup: () => void; onClear: () => void; onReapply: () => void; onClose: () => void; focusKeys: string[];
}) {
  const current = mode === 'grouped';
  const [strata, setStrata] = useState(false);
  // A new split: bring the card into view (it sits under the arcs or the matrix).
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => { scrollIntoViewWithin(cardRef.current, { block: 'nearest', behavior: 'smooth' }); }, [split]);
  const [width, ref] = useContainerWidth(320);
  const focus = useBrowserStore(s => (focusKeys[0] ? s.clusterFocus[focusKeys[0]] : null));
  const toggleFocus = (id: number) => {
    const store = useBrowserStore.getState();
    const on = focus?.size === 1 && focus.has(id);
    for (const key of focusKeys) store.setClusterFocus(key, on ? null : new Set([id]));
  };
  const pair = split.pair ?? null;
  const verdict = pair ? VERDICT[pair.class] : null;
  const groups = split.groups;
  const cells = groups.filter(g => g.key !== 'na').slice(0, 4);
  const na = groups.find(g => g.key === 'na');
  const [sa, sb] = split.short;
  const series = useMemo(() => {
    if (!split.profiles) return [];
    return groups.filter(g => (split.profiles![g.key]?.reads ?? 0) > 0).map(g => ({
      data: split.profiles![g.key].accessibility.map(v => v ?? 0), color: getClusterColor(g.id), label: g.label, n: split.profiles![g.key].reads,
    }));
  }, [split, groups]);
  const win = split.window;
  return (
    <section ref={cardRef} className="fb-panel-card space-y-2 text-[12px]" data-testid="nfr-pair-detail" data-mode={mode}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
            {split.kind === 'pair' ? `${sa} × ${sb}` : `Combination of ${split.short.join(', ')}`}
          </h3>
          <p className="text-[11px] text-gray-500">
            {split.kind === 'pair'
              ? `${(byId.get(split.a!)?.label ?? split.a)} · ${(byId.get(split.b!)?.label ?? split.b)}`
              : `${split.n?.toLocaleString()} reads span every element (shared openings left out)`}
          </p>
        </div>
        {verdict && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${verdict.cls}`}>{verdict.text}</span>}
      </div>

      {split.kind === 'pair' ? (
        <div className="grid grid-cols-[auto_1fr_1fr] gap-1 text-[11px]" data-testid="nfr-split-2x2">
          <span />
          <span className="text-center font-medium text-gray-500">{sb} open</span>
          <span className="text-center font-medium text-gray-500">{sb} closed</span>
          <span className="self-center pr-1 font-medium text-gray-500">{sa} open</span>
          <GroupChip group={cells[0]} onFocus={current ? () => toggleFocus(cells[0].id) : undefined} focused={focus?.has(cells[0].id) && focus.size === 1} />
          <GroupChip group={cells[1]} onFocus={current ? () => toggleFocus(cells[1].id) : undefined} focused={focus?.has(cells[1].id) && focus.size === 1} />
          <span className="self-center pr-1 font-medium text-gray-500">{sa} closed</span>
          <GroupChip group={cells[2]} onFocus={current ? () => toggleFocus(cells[2].id) : undefined} focused={focus?.has(cells[2].id) && focus.size === 1} />
          <GroupChip group={cells[3]} onFocus={current ? () => toggleFocus(cells[3].id) : undefined} focused={focus?.has(cells[3].id) && focus.size === 1} />
        </div>
      ) : (
        <div className="space-y-0.5" data-testid="nfr-split-patterns">
          {groups.filter(g => g.key !== 'na').map(g => (
            <div key={g.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <GroupChip group={g} onFocus={current ? () => toggleFocus(g.id) : undefined} focused={focus?.has(g.id) && focus.size === 1} />
              <span className="text-[10px] tabular-nums text-ink-secondary" title="Expected under the fixed-margin (curveball) null: median and 95% range; q: BH over the patterns">
                {g.expected ? `exp ${g.expected.null_median.toFixed(0)} [${g.expected.null_lo.toFixed(0)}–${g.expected.null_hi.toFixed(0)}] · q ${formatQ(g.expected.q)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {na && (
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-split-na"
          title="A read counts for the test when it has an open or closed state at both elements (it spans them with nucleosome-bounded coverage, on one channel) and no single opening covers both. The others are listed here by reason.">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: getClusterColor(na.id) }} />
          <span>Not informative: <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-300">{na.molecules.toLocaleString()}</span></span>
          <span className="text-ink-muted">{Object.entries(split.excluded).map(([k, n]) => `${n.toLocaleString()} ${split.excluded_text[k] ?? k}`).join(' · ')}</span>
        </div>
      )}

      {split.kind === 'pair' && (
        pair ? (
          <p className="tabular-nums" data-testid="nfr-split-effect"
            title={`Pooled log₂ OR (unadjusted) ${signed(pair.log2or)} [${signed(pair.lo)}, ${signed(pair.hi)}], Fisher p ${formatQ(pair.fisher_p)}; null centre of the pooled OR under the openness-preserving permutation ${signed(pair.null_median)}`}>
            <span className="text-gray-600 dark:text-gray-300">Adjusted log₂ OR (openness strata pooled): </span>
            {pair.mh != null
              ? <span className="font-semibold">{signed(pair.mh)} <span className="font-normal text-gray-600 dark:text-gray-300">[{signed(pair.mh_lo)}, {signed(pair.mh_hi)}]</span></span>
              : <span className="font-semibold">not defined (complete separation within strata)</span>}
            <span className="text-gray-600 dark:text-gray-300"> · <span title={Q_HELP}>q {formatQ(pair.q)}</span> · {pair.n.toLocaleString()} reads{pair.shared ? ` · ${pair.shared.toLocaleString()} shared left out` : ''}</span>
            <span className="ml-1 text-[10px] text-ink-muted">(pooled log₂ OR, unadjusted: {signed(pair.log2or)})</span>
          </p>
        ) : (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">Not tested{split.skipped ? `: ${split.skipped}` : ''}. The groups are the reads as the test would have split them.</p>
        )
      )}
      {split.spacing && <p className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-split-spacing">{split.spacing.note}</p>}

      {series.length > 0 && win && (
        <div ref={ref} data-testid="nfr-split-profiles">
          <p className="mb-0.5 text-[11px] text-gray-500">Accessibility per group (share of reads outside nucleosomes), {bp(win[0])}–{bp(win[1])}</p>
          <OverlayProfileChart series={series} width={Math.max(220, width)} height={120} windowBp={win[1] - win[0]} yLabel="open" filename="nfr-split-profiles" />
        </div>
      )}

      {split.strata && split.strata.length > 0 && (
        <div>
          <button type="button" onClick={() => setStrata(s => !s)} aria-expanded={strata} data-testid="nfr-split-strata-toggle"
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
            <DisclosureChevron open={strata} /> Per stratum (strand × read openness)
          </button>
          {strata && (
            <table className="mt-1 w-full text-[11px] tabular-nums" data-testid="nfr-split-strata">
              <thead className="text-left text-gray-500">
                <tr><th className="font-medium">Strand</th><th className="font-medium" title="Quintile of per-read openness outside the two elements">Openness</th><th className="font-medium">Reads</th>
                  <th className="font-medium" title={`${sa}+${sb}+ · ${sa}+${sb}− · ${sa}−${sb}+ · ${sa}−${sb}−`}>2×2</th><th className="font-medium">log2 OR</th></tr>
              </thead>
              <tbody>
                {split.strata.map(r => (
                  <tr key={`${r.channel}|${r.quintile}`} className="border-t border-gray-100 dark:border-white/5">
                    <td className="pr-2">{r.channel.split('::').pop()}</td>
                    <td className="pr-2 text-gray-500">Q{r.quintile} ({(r.openness[0] * 100).toFixed(0)}–{(r.openness[1] * 100).toFixed(0)}%)</td>
                    <td className="pr-2">{r.n}</td>
                    <td className="pr-2 text-gray-500">{r.table.join(' · ')}</td>
                    <td><StratumBar value={r.log2or} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {strata && <p className="mt-0.5 text-[10px] text-ink-secondary">The test itself uses finer strata of about 50 reads; these quintiles only show whether the association holds across openness and strands.</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {mode === 'inspect' ? (
          <>
            <AnalysisButton theme="fuchsia" variant="soft" onClick={onGroup} data-testid="nfr-split-group-reads"
              title="Colour the read panels by these groups (one undo step); Restore previous grouping takes them back">Group reads by this pair</AnalysisButton>
            <span className="text-[11px] text-ink-muted" data-testid="nfr-split-inspect-note">Inspecting: the read panels are unchanged.</span>
          </>
        ) : current ? (
          <AnalysisButton theme="fuchsia" variant="outline" onClick={onClear} data-testid="nfr-split-clear"
            title="Put back the read grouping you had before this one (also an undo step)">Restore previous grouping</AnalysisButton>
        ) : (
          <>
            <span className="text-[11px] text-amber-700 dark:text-amber-400">The read panels show another grouping now (undo or a new clustering).</span>
            <AnalysisButton theme="fuchsia" variant="soft" onClick={onReapply} data-testid="nfr-split-reapply">Group the reads again</AnalysisButton>
          </>
        )}
        <span className="text-[10px] text-ink-muted">Groups count molecules; the read panels group read names{Object.values(split.ambiguous_reads).some(Boolean) ? ` (${Object.values(split.ambiguous_reads).reduce((a, b) => a + b, 0)} names whose molecules disagree are left out)` : ''}.</span>
        <button type="button" onClick={onClose} className="ml-auto text-[11px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200" data-testid="nfr-split-close">Close</button>
      </div>
    </section>
  );
}

function StratumBar({ value }: { value: number }) {
  const v = Math.max(-4, Math.min(4, value));
  const w = Math.abs(v) / 4 * 36;
  return (
    <span className="inline-flex items-center gap-1">
      <svg width={76} height={8} aria-hidden="true">
        <line x1={38} x2={38} y1={0} y2={8} stroke="currentColor" strokeOpacity={0.25} />
        <rect x={v >= 0 ? 38 : 38 - w} y={1.5} width={w} height={5} rx={1} fill={v >= 0 ? '#c2410c' : '#1d4ed8'} fillOpacity={0.75} />
      </svg>
      {signed(value, 1)}
    </span>
  );
}
