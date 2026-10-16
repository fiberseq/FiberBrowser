import { ESTIMATORS } from '../../../utils/denominators';
import { useState } from 'react';
import type { FootprintAnalysisResult, CoOccupancyPair, PerGroupOccupancy } from '../../../api/footprints';
import type { FootprintGroup } from '../../../types';
import type { Dataset } from '../../../types/dataset';
import { useBrowserStore } from '../../../stores/browserStore';
import { configureCoaccFromFootprintLayer } from '../../../utils/coaccBridge';
import { downloadTextFile, exportTimestamp, safeFilenamePart } from '../../../utils/analysisExport';
import { formatFootprintCooccurrenceTsv } from '../../../utils/cooccurrenceExport';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../../utils/datasetLabels';
import { AnalysisStatus } from '../shared';
import { DisclosureChevron } from '../../ui/Disclosure';
import { HowItWorks } from '../../ui/HowItWorks';
import { Check, Download, GridIcon, ReadClusters } from '../../ui/Icons';
import { MAX_READABLE_PATTERNS, membershipPatternCount, resolveClusterSelection } from '../../../utils/footprintClusterSelection';

/** Statistics can be missing (0/0 when two definitions never co-occur) or infinite. */
function formatOdds(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return '\u221E';
  return value.toFixed(2);
}

function formatP(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value < 0.001 ? value.toExponential(1) : value.toFixed(3);
}

/** A saved class belongs to the dataset it was found in; size/position rules apply to every dataset. */
const belongs = (g: FootprintGroup, datasetId: string) => !g.sourceDatasetId || g.sourceDatasetId === datasetId;

/** Heatmap colour for a log2 odds ratio (blue avoidance, red co-occupancy). */
function orColor(or: number | null | undefined): string {
  if (or == null || Number.isNaN(or)) return 'transparent';
  const x = Math.max(-3, Math.min(3, Math.log2(Math.max(or, 1e-3))));
  const a = Math.abs(x) / 3 * .55;
  return x >= 0 ? `rgba(220, 38, 38, ${a})` : `rgba(37, 99, 235, ${a})`;
}

/** Compact label for the heatmap axes: "C3" (plus the strand for a one-strand class), else the rule name. */
function shortName(g: FootprintGroup): string {
  if (g.savedClass) return g.savedClass.id + (g.consensusStrand ? ` ${g.consensusStrand}` : '');
  if (g.consensusStateId) {
    const m = g.name.match(/^Class (\d+)/);
    return (m ? `C${m[1]}` : g.name.slice(0, 6)) + (g.consensusStrand ? ` ${g.consensusStrand}` : '');
  }
  return g.name.length > 9 ? `${g.name.slice(0, 8)}…` : g.name;
}

interface CoOccurrenceTabProps {
  result: FootprintAnalysisResult | null;
  footprintGroups: FootprintGroup[];
  targetDatasets: Dataset[];
  coOccLoading: boolean;
  clusterLoading: boolean;
  footprintFilterKey: string | null;
  currentLayer: string | null;
  handleCellClick: (dsId: string, pairIndex: number, cellName: string, ids?: string[]) => void;
  /** Cluster the reads by the chosen footprints (their ids, in the groups' order). */
  handleClusterByGroups: (groupIds: string[]) => void;
  /** Clusters from the last Cluster run: which footprints each one has. */
  membershipLegend?: { id: number; count: number; label: string }[] | null;
  /** Which footprints "Cluster reads by…" uses (ids); default: all of up to three, else the first three. */
  clusterSelection?: string[];
  onClusterSelectionChange?: (groupIds: string[]) => void;
}

/** Classes that overlap on the reference: a read rarely carries both, so their avoidance is largely by construction. */
function overlapping(gi: FootprintGroup, gj: FootprintGroup): boolean {
  return !!gi.consensusStateId && !!gj.consensusStateId && gi.referenceAbsStart != null && gi.referenceAbsEnd != null
    && gj.referenceAbsStart != null && gj.referenceAbsEnd != null
    && Math.min(gi.referenceAbsEnd, gj.referenceAbsEnd) > Math.max(gi.referenceAbsStart, gj.referenceAbsStart);
}

/** A read count that filters the reads to those it counts (a toggle, not a disclosure). */
function FilterCount({ value, active, onClick, title, muted = false, bold = false, testId }: {
  value: number; active: boolean; onClick: () => void; title: string; muted?: boolean; bold?: boolean; testId?: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} data-testid={testId} aria-label={title}
      title={active ? 'Filtering to these reads: click to show all reads again' : title}
      className={`w-full rounded-fb border px-1 py-[3px] text-center tabular-nums transition-colors
        ${bold ? 'font-medium' : ''} ${muted && !active ? 'text-ink-muted' : 'text-gray-800 dark:text-gray-100'}
        ${active
          ? 'border-emerald-500 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
          : 'border-line bg-white hover:border-emerald-400 hover:bg-emerald-50 dark:border-white/10 dark:bg-transparent dark:hover:border-emerald-600 dark:hover:bg-emerald-900/20'}`}>
      {value}
    </button>
  );
}

export function CoOccurrenceTab({
  result, footprintGroups, targetDatasets,
  coOccLoading, clusterLoading, footprintFilterKey, currentLayer,
  handleCellClick, handleClusterByGroups, membershipLegend,
  clusterSelection, onClusterSelectionChange,
}: CoOccurrenceTabProps) {
  const enabledGroups = footprintGroups.filter(g => g.enabled);
  const enabledIds = enabledGroups.map(g => g.id);
  // Without a controlling panel (tests, other hosts) the choice lives here.
  const [localSelection, setLocalSelection] = useState<string[] | null>(null);
  const chosen = clusterSelection ?? resolveClusterSelection(enabledIds, localSelection);
  const chosenSet = new Set(chosen);
  const chosenIds = enabledIds.filter(id => chosenSet.has(id));
  const setChosen = (ids: string[]) => {
    const ordered = enabledIds.filter(id => ids.includes(id));
    if (onClusterSelectionChange) onClusterSelectionChange(ordered);
    else setLocalSelection(ordered);
  };
  const toggleChosen = (id: string) => setChosen(chosenSet.has(id) ? chosenIds.filter(x => x !== id) : [...chosenIds, id]);
  const patternCount = membershipPatternCount(chosenIds.length);
  const clusterBlocked = chosenIds.length === 0
    ? 'Tick at least one footprint to cluster by'
    : !result?.co_occupancy ? 'Waiting for the co-occupancy counts' : null;
  // undefined: the user has not opened or closed a pair yet (a lone pair is then shown open).
  const [openPairChoice, setOpenPair] = useState<string | null | undefined>(undefined);
  const openAnalysisPanel = useBrowserStore(s => s.openAnalysisPanel);
  const hasCooccurrence = !!result?.co_occupancy && Object.keys(result.co_occupancy).length > 0;
  const pairKeys = enabledGroups.length >= 2 && result?.co_occupancy
    ? targetDatasets.flatMap(ds => (result.co_occupancy?.[ds.id]?.pairs ?? []).map((_: CoOccupancyPair, pi: number) => `${ds.id}:${pi}`))
    : [];
  const openPair = openPairChoice === undefined ? (pairKeys.length === 1 ? pairKeys[0] : null) : openPairChoice;
  const togglePair = (key: string) => setOpenPair(openPair === key ? null : key);

  const handleExportTsv = () => {
    if (!hasCooccurrence) return;
    const filename = [
      'footprint_cooccurrence',
      targetDatasets.map(ds => safeFilenamePart(getDatasetDisplayLabel(ds) || ds.id)).join('_') || 'datasets',
      exportTimestamp(),
    ].filter(Boolean).join('_') + '.tsv';
    downloadTextFile(
      formatFootprintCooccurrenceTsv(result, footprintGroups, targetDatasets),
      filename,
      'text/tab-separated-values',
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">Co-occupancy</div>
          <div className="text-[12px] text-ink-muted">
            {enabledGroups.length} group{enabledGroups.length !== 1 ? 's' : ''} · {targetDatasets.length} dataset{targetDatasets.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={handleExportTsv}
            disabled={!hasCooccurrence}
            className="fb-btn-secondary px-2 py-[3px] text-[11px]"
            title="Export per-group and pairwise occupancy counts, statistics, and read IDs as TSV"
          >
            <Download size={13} aria-hidden="true" />
            Export TSV
          </button>
          <button
            type="button"
            onClick={() => {
              configureCoaccFromFootprintLayer(currentLayer);
              openAnalysisPanel('co-accessibility');
            }}
            disabled={targetDatasets.length === 0}
            className="fb-btn-ghost px-2 py-[3px] text-[11px]"
            data-tour="footprints-open-coacc"
            title={
              footprintFilterKey
                ? 'Open Co-accessibility (the position-by-position matrix) with this footprint layer and the active occupancy-filtered reads'
                : 'Open Co-accessibility (the position-by-position matrix) using this footprint layer/signal for the current datasets'
            }
          >
            <GridIcon size={13} aria-hidden="true" />
            Layer matrix
          </button>
        </div>
      </div>
      <p className="text-[12px] leading-[18px] text-ink-muted" data-testid="coocc-intro">
        Which saved footprints and classes sit on the same reads, and whether pairs co-occur more or less than chance.
      </p>
      <p className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="coocc-subtitle">
        Pairs of saved footprint classes (and size rules), bound together on the reads in view. Not the Co-accessibility
        panel, which correlates openness position by position.
      </p>
      <HowItWorks summary="How classes are counted" testId="coocc-counting-note">
        <p>Counts come from the saved footprints and classes ticked in Saved.</p>
        {footprintGroups.some(g=>g.consensusStateId)&&(<>
          <p>Classes use exact primary assignments from their saved analysis, not interval overlap or compatible alternatives. Counts are dataset-specific and exclude reads whose analysis identity cannot be matched. Manual rules still use their interval criteria. Pairwise counts use the shared eligible reads.</p>
          <p data-testid="coocc-vs-saved">
            <strong>Why the % here differs from Saved.</strong> Here the % is the <em>{ESTIMATORS.confidentReadFraction.toLowerCase()}</em>: every read in view counts once: <em>with</em> if the class is
            confidently called on it, <em>without</em> otherwise (uncertain calls count as without), and reads that don&apos;t cover
            the class and the DNA on both sides of it are not scored. Saved shows the <em>{ESTIMATORS.moleculePrevalence.toLowerCase()}</em>, the run&apos;s estimate per molecule: each molecule counts by how likely it is to
            carry the class, and duplicate reads of one molecule count once.
          </p>
        </>)}
      </HowItWorks>

      {targetDatasets.map(ds=>result?.co_occupancy?.[ds.id]?.error ? <AnalysisStatus key={ds.id} kind="error" compact>
        {getDatasetDisplayLabel(ds)}: {result.co_occupancy[ds.id].error}
      </AnalysisStatus> : null)}
      {enabledGroups.length < 1 ? (
        <AnalysisStatus kind="empty" center>
          Save footprint classes (Classes tab) or footprints, and tick them in Saved, to see which occur together on the same reads.
        </AnalysisStatus>
      ) : (
        <>
          {enabledGroups.length === 1 && (
            <div className="text-[11px] text-ink-muted">Tick two or more in Saved to compare pairs.</div>
          )}

          {coOccLoading && (
            <AnalysisStatus kind="loading" compact>
              Computing occupancy...
            </AnalysisStatus>
          )}

          {/* Per-group single occupancy */}
          {result?.co_occupancy && targetDatasets.map(ds => {
            const coOcc = result.co_occupancy?.[ds.id];
            if (!coOcc?.per_group?.length) return null;
            return (
              <div key={`sg-${ds.id}`} className="fb-panel-card space-y-1.5" data-testid="coocc-per-group">
                {targetDatasets.length > 1 && (
                  <div className="text-[11px] font-medium" style={{ color: ds.color }}>
                    <span title={getDatasetHoverLabel(ds)}>{getDatasetDisplayLabel(ds)}</span> ({coOcc.total_reads} reads)
                  </div>
                )}
                <div className="text-[12px] font-semibold text-gray-900 dark:text-gray-100">
                  Per-group occupancy <span className="text-[11px] font-normal text-ink-muted">· reads in view · click a count to show only those reads</span>
                </div>
                <p className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="coocc-estimator">% = {ESTIMATORS.confidentReadFraction} (with ÷ scored reads); Saved shows the {ESTIMATORS.moleculePrevalence.toLowerCase()}.</p>
                <div className="grid items-center gap-x-1.5 gap-y-1 text-[12px]"
                     style={{ gridTemplateColumns: 'minmax(0,1fr) 4rem 4rem 2.75rem' }}>
                  <div />
                  <div className="text-center text-[11px] text-emerald-600 dark:text-emerald-400">with</div>
                  <div className="text-center text-[11px] text-ink-muted">without</div>
                  <div className="text-right text-[11px] text-ink-muted" data-testid="coocc-pct-head"
                    title={`${ESTIMATORS.confidentReadFraction}: reads with a confident call of the class over the reads scored. Saved shows the ${ESTIMATORS.moleculePrevalence.toLowerCase()} instead (per molecule, uncertain ones in part).`}>%</div>
                  {coOcc.per_group.map((pg: PerGroupOccupancy, gi: number) => {
                    const g = enabledGroups[gi];
                    if (!g || !belongs(g, ds.id)) return null;
                    if (pg.unavailable) return <div key={gi} data-testid="coocc-group-unavailable" className="col-span-4 p-1 text-amber-700 dark:text-amber-400" title={pg.unavailable}>{g.name}: run unavailable, left out.</div>;
                    if (pg.eligible_reads === 0) return <div key={gi} className="col-span-4 p-1 text-gray-500">{g.name}: no eligible reads.</div>;
                    const pairIdx = -1 - gi;
                    return (
                      <div key={gi} className="contents">
                        <div className="flex min-w-0 items-center gap-1.5 text-gray-800 dark:text-gray-100"
                          title={`${pg.not_evaluated_reads ? `${g.name}: ${pg.not_evaluated_reads} more read${pg.not_evaluated_reads === 1 ? ' is' : 's are'} not scored: a read is scored only when it covers the class and the DNA on both sides of it that the call needs` : `${g.name}${!g.consensusStateId ? ` (${g.sizeMin}-${g.sizeMax ?? '∞'} bp)` : ''}`}${g.consensusStateId ? `\nWith: reads with a confident call of the class; without: the other reads that were scored. Saved shows the run's per-molecule estimate instead (see How classes are counted).` : ''}`}>
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: g.color }} />
                          <span className="min-w-0"><span className="block truncate">{g.name}</span>{pg.not_evaluated_reads ? <span className="block text-[11px] leading-tight text-ink-muted" data-testid="coocc-group-not-spanning">{pg.not_evaluated_reads.toLocaleString()} more read{pg.not_evaluated_reads === 1 ? '' : 's'} not scored: {pg.not_evaluated_reads === 1 ? 'it doesn\'t' : 'they don\'t'} cover the class and its flanks</span> : null}</span></div>
                        <FilterCount value={pg.n_with} active={footprintFilterKey === `${ds.id}:${pairIdx}:with`} testId="coocc-group-with"
                          title={`Show only the ${pg.n_with} reads with ${g.name}`}
                          onClick={() => handleCellClick(ds.id, pairIdx, 'with', pg.ids_with)} />
                        <FilterCount value={pg.n_without} active={footprintFilterKey === `${ds.id}:${pairIdx}:without`} testId="coocc-group-without" muted
                          title={`Show only the ${pg.n_without} reads without ${g.name}`}
                          onClick={() => handleCellClick(ds.id, pairIdx, 'without', pg.ids_without)} />
                        <div className="text-right tabular-nums text-gray-700 dark:text-gray-300">{(100 * pg.n_with / Math.max(1, pg.n_with + pg.n_without)).toFixed(1)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Pairwise results (only when 2+ groups) */}
          {enabledGroups.length >= 2 && result?.co_occupancy && targetDatasets.map(ds => {
            const coOcc = result.co_occupancy?.[ds.id];
            if (!coOcc?.pairs?.length) return null;
            return (
              <div key={ds.id} className="fb-panel-card space-y-2">
                <div className="text-[12px] font-semibold text-gray-900 dark:text-gray-100">
                  Pairwise co-occupancy{targetDatasets.length > 1 ? <span style={{ color: ds.color }}> · {getDatasetDisplayLabel(ds)}</span> : null}
                  <span className="text-[11px] font-normal text-ink-muted"> · click a cell to open its 2×2 table</span>
                </div>
                {(() => {
                  const idx = enabledGroups.map((_, i) => i).filter(i => belongs(enabledGroups[i], ds.id));
                  if (idx.length < 2) return null;
                  const pairAt = new Map(coOcc.pairs.map((p: CoOccupancyPair, pi: number) => [`${p.group_i}:${p.group_j}`, pi]));
                  return (
                    <div className="overflow-x-auto" data-testid="cooccupancy-heatmap">
                      <table className="border-collapse text-[11px] font-mono">
                        <thead><tr><th />{idx.slice(1).map(j => <th key={j} className="px-1 font-normal whitespace-nowrap" style={{ color: enabledGroups[j].color }} title={enabledGroups[j].name}>{shortName(enabledGroups[j])}</th>)}</tr></thead>
                        <tbody>
                          {idx.slice(0, -1).map((i, ri) => (
                            <tr key={i}>
                              <th className="pr-1 text-right font-normal whitespace-nowrap" style={{ color: enabledGroups[i].color }} title={enabledGroups[i].name}>{shortName(enabledGroups[i])}</th>
                              {idx.slice(1).map((j, ci) => {
                                if (ci < ri) return <td key={j} />;
                                const pi = pairAt.get(`${i}:${j}`) ?? pairAt.get(`${j}:${i}`);
                                if (pi == null) return <td key={j} />;
                                const p = coOcc.pairs[pi];
                                const q = p.q_value ?? p.p_value;
                                const sig = q != null && Number.isFinite(q) && q < 0.05;
                                const never = p.odds_ratio == null && p.n_both === 0;
                                const key = `${ds.id}:${pi}`;
                                const open = openPair === key;
                                const gi = enabledGroups[i], gj = enabledGroups[j];
                                const exclusive = overlapping(gi, gj);
                                const action = `${open ? 'Hide' : 'Show'} the 2×2 table of ${gi.name} × ${gj.name}`;
                                return (
                                  <td key={j} className="p-0">
                                    <button type="button" onClick={() => togglePair(key)}
                                      aria-expanded={open} aria-controls={`coocc-pair-${key}`} data-testid="coocc-pair-cell"
                                      title={exclusive
                                        ? `${action}.\nThe classes overlap on the reference, so a read rarely carries both (not a measured avoidance).`
                                        : `${action}.\nodds ratio ${never ? 'n/a (never together)' : formatOdds(p.odds_ratio)} · both ${p.n_both} · q ${formatP(q)}`}
                                      className={`m-px flex min-w-[3.2rem] items-center justify-center gap-0.5 rounded px-1 py-0.5 tabular-nums transition-shadow
                                        hover:ring-1 hover:ring-emerald-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500
                                        ${open ? 'ring-1 ring-emerald-600' : ''}
                                        ${exclusive || never ? 'text-ink-secondary' : 'text-gray-800 dark:text-gray-100'}`}
                                      style={{ backgroundColor: exclusive || never ? 'transparent' : orColor(p.odds_ratio) }}>
                                      <span>{exclusive ? '×' : never ? '–' : formatOdds(p.odds_ratio)}{!exclusive && sig ? '*' : ''}</span>
                                      <DisclosureChevron open={open} size={8} className="text-gray-500 dark:text-gray-400" />
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">Odds ratio: red together more often, blue less; * q &lt; 0.05</div>
                    </div>
                  );
                })()}
                {coOcc.pairs.map((pair: CoOccupancyPair, pi: number) => {
                  const gA = enabledGroups[pair.group_i];
                  const gB = enabledGroups[pair.group_j];
                  const key = `${ds.id}:${pi}`;
                  if (!gA || !gB || openPair !== key) return null;
                  const qValue = pair.q_value ?? pair.p_value;
                  const stars = qValue == null || !Number.isFinite(qValue) ? '' : qValue < 0.001 ? '***' : qValue < 0.01 ? '**' : qValue < 0.05 ? '*' : '';
                  const a = shortName(gA), b = shortName(gB);
                  const cell = (name: 'both' | 'i_only' | 'j_only' | 'neither', value: number, ids: string[] | undefined, what: string, opts: { bold?: boolean; muted?: boolean } = {}) => (
                    <FilterCount key={name} value={value} active={footprintFilterKey === `${ds.id}:${pi}:${name}`} testId={`coocc-pair-${name}`}
                      title={`Show only the ${value} reads ${what}`} bold={opts.bold} muted={opts.muted}
                      onClick={() => handleCellClick(ds.id, pi, name, ids)} />
                  );
                  return (
                    <div key={pi} id={`coocc-pair-${key}`} role="region" aria-label={`2×2 table: ${gA.name} × ${gB.name}`}
                      data-testid="coocc-pair-detail" className="space-y-1.5 rounded-fb border border-line p-2.5 dark:border-white/10">
                      <div className="flex items-start gap-1 text-[12px] font-semibold text-gray-800 dark:text-gray-200">
                        <button type="button" onClick={() => {
                          // Its header unmounts with it: keyboard focus goes back to the matrix cell.
                          const cell = [...document.querySelectorAll<HTMLElement>('[data-testid="coocc-pair-cell"]')]
                            .find(el => el.getAttribute('aria-controls') === `coocc-pair-${key}`);
                          togglePair(key);
                          cell?.focus();
                        }} aria-expanded="true" aria-controls={`coocc-pair-${key}`}
                          title="Hide this 2×2 table" className="flex min-w-0 flex-1 items-baseline gap-1 text-left hover:text-gray-900 dark:hover:text-white">
                          <DisclosureChevron open size={10} className="mr-0.5 self-center text-gray-500" />
                          <span className="min-w-0">
                            <span style={{ color: gA.color }}>{gA.name}</span>
                            {' × '}
                            <span style={{ color: gB.color }}>{gB.name}</span>
                          </span>
                        </button>
                        <span className="whitespace-nowrap font-mono text-[11px] font-normal tabular-nums">
                          OR={pair.odds_ratio == null && pair.n_both === 0 ? 'n/a (never seen together)' : formatOdds(pair.odds_ratio)}
                          {' '}p={formatP(pair.p_value)}
                          {' '}q={formatP(qValue)}
                          {stars && <span className="text-amber-500 ml-0.5">{stars}</span>}
                        </span>
                      </div>
                      {overlapping(gA, gB) && (
                        <div className="text-[11px] text-ink-secondary">These classes overlap on the reference, so a read rarely carries both: the odds ratio is not a measured avoidance.</div>
                      )}
                      {/* 2x2 contingency grid; each count filters the reads */}
                      <div className="grid items-center gap-x-1.5 gap-y-1 text-[12px]"
                           style={{ gridTemplateColumns: 'auto 1fr 1fr' }}>
                        <div />
                        <div className="p-1 text-center truncate" style={{ color: gB.color }} title={`reads with ${gB.name}`}>with {b}</div>
                        <div className="p-1 text-center truncate text-ink-secondary" title={`reads without ${gB.name}`}>without {b}</div>
                        <div className="p-1 truncate" style={{ color: gA.color }} title={`reads with ${gA.name}`}>with {a}</div>
                        {cell('both', pair.n_both, pair.ids_both, `with both ${gA.name} and ${gB.name}`, { bold: true })}
                        {cell('i_only', pair.n_i_only, pair.ids_i_only, `with ${gA.name} but not ${gB.name}`)}
                        <div className="p-1 truncate text-ink-secondary" title={`reads without ${gA.name}`}>without {a}</div>
                        {cell('j_only', pair.n_j_only, pair.ids_j_only, `with ${gB.name} but not ${gA.name}`)}
                        {cell('neither', pair.n_neither, pair.ids_neither, `with neither ${gA.name} nor ${gB.name}`, { muted: true })}
                      </div>
                      <div className="text-[11px] text-ink-muted">Click a count to show only those reads.</div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Cluster reads by which of the chosen saved footprints they carry. */}
          <div className="space-y-2" data-testid="coocc-cluster-by">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Footprints to cluster reads by">
              <span className="mr-0.5 text-[12px] font-medium text-gray-700 dark:text-gray-300">Cluster by</span>
              {enabledGroups.map(g => {
                const on = chosenSet.has(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleChosen(g.id)}
                    data-testid="coocc-cluster-pick"
                    data-group-id={g.id}
                    title={on ? `Leave ${g.name} out of the clustering` : `Cluster by ${g.name} too`}
                    className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border py-[2px] pl-1.5 pr-2 text-[11px] font-medium transition-colors ${on
                      ? 'border-gray-400 bg-white text-gray-800 shadow-chip dark:border-white/30 dark:bg-white/10 dark:text-gray-100'
                      : 'border-dashed border-gray-300 text-ink-muted hover:border-gray-400 dark:border-white/15'}`}
                  >
                    <span className={`flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-sm ${on ? '' : 'opacity-40'}`} style={{ backgroundColor: g.color }}>
                      {on && <Check size={9} strokeWidth={3.5} className="text-white" aria-hidden="true" />}
                    </span>
                    <span className="truncate">{g.name}</span>
                  </button>
                );
              })}
            </div>
            {patternCount > MAX_READABLE_PATTERNS && (
              <div data-testid="coocc-cluster-warning">
                <AnalysisStatus kind="warning" compact>
                  {chosenIds.length} footprints can split the reads into up to {patternCount} patterns; more than {MAX_READABLE_PATTERNS} are hard to read as clusters. Tick 3 or fewer.
                </AnalysisStatus>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { if (!clusterBlocked && !clusterLoading && !coOccLoading) handleClusterByGroups(chosenIds); }}
                disabled={clusterLoading || coOccLoading}
                aria-disabled={clusterBlocked ? true : undefined}
                className="fb-btn-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                title={clusterBlocked ?? `Group reads by which of these ${chosenIds.length} footprint${chosenIds.length === 1 ? '' : 's'} they have (e.g. both, one, neither)`}
                data-tour="footprints-cluster-by-groups"
                data-testid="coocc-cluster-button"
              >
                <ReadClusters size={14} aria-hidden="true" />
                Cluster reads by {chosenIds.length} footprint{chosenIds.length === 1 ? '' : 's'}
              </button>
              <HowItWorks summary="About the statistics">
                <p>Matrix cells show the odds ratio of co-occupancy on the same reads (red: together more often, blue: less often; * q &lt; 0.05; × overlapping classes, which rarely share a read). Click a cell to open its 2×2 table.</p>
                <p>Pairwise Fisher exact tests use reads as units; q-values are Benjamini–Hochberg corrected across every displayed dataset/group pair.</p>
                <p>Cluster reads by… groups the reads by which of the ticked footprints each carries (n footprints give up to 2ⁿ patterns), using only reads evaluated for all of them.</p>
              </HowItWorks>
            </div>
          </div>
          {membershipLegend && membershipLegend.length > 0 && (
            <div className="space-y-0.5 text-[11px]" data-testid="membership-cluster-legend">
              {membershipLegend.map(entry => (
                <div key={entry.id} className="flex gap-2">
                  <span className="w-6 shrink-0 font-medium text-gray-600 dark:text-gray-300">C{entry.id}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-gray-300" title={entry.label}>{entry.label}</span>
                  <span className="tabular-nums text-ink-secondary">{entry.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
