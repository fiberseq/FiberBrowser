/**
 * The Saved list of shared geometries (the NFR panel's starred NFRs and the Footprints cart): every saved geometry with
 * what it was when saved (kind, span, shares per dataset), matched to the current analysis by its edges (same kind and
 * chromosome, both ends within the grouping tolerance). A matched entry acts as that geometry: a click focuses it,
 * shift-click selects it for Cluster, Sort and Filter, and its current shares show beside the saved ones. An entry
 * without a match says so, and Go to shows its span.
 */
import { useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { featureKey } from '../../stores/featureStore';
import { sameChrom } from '../../utils/chromAliases';
import { formatTsv, downloadTextFile, exportTimestamp } from '../../utils/analysisExport';
import { AnalysisButton, AnalysisCard, AnalysisExportGroup } from '../../components/controls/shared/AnalysisControls';
import { clickGeometry } from './geoActions';
import { geoDatasetCounts, geoFeatureRef } from './geoHub';
import type { NucGeoRun } from './geoRuns';
import { matchSaved, type SavedGeometry } from './savedGeometries';
import type { NucGeometryResult } from './types';

const NO_SAVED: import('./savedGeometries').SavedGeometry[] = [];

/** The grouping tolerance an analysis used (bp): 0 (exact grouping) is a value, only a missing or invalid one falls
 * back to the default. */
export function geometryTolerance(res: Pick<NucGeometryResult, 'params'> | null | undefined, fallback = 500): number {
  const v = res?.params?.geometry?.tol_bp;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${Math.round(100 * v)}%`);

function savedTsv(list: SavedGeometry[], dsLabel: (id: string) => string): string {
  const ds = [...new Set(list.flatMap(e => Object.keys(e.shares)))];
  const head = ['name', 'label', 'kind', 'chrom', 'start', 'end', 'open_left', 'open_right', 'tol_bp',
    ...ds.flatMap(d => [`${dsLabel(d)} full`, `${dsLabel(d)} density matched`]), 'saved_at', 'note'];
  const rows = list.map(e => [e.name, e.label, e.kind, e.chrom, e.start, e.end, Number(e.openLeft), Number(e.openRight), e.tolBp,
    ...ds.flatMap(d => [e.shares[d]?.full ?? '', e.shares[d]?.densityMatched ?? '']), new Date(e.savedAt).toISOString(), e.note ?? '']);
  // escaped cells: a name or note with a tab or newline never breaks the columns
  return formatTsv([head, ...rows]);
}

export function SavedGeometries({ res, run, pos, embedded = false }: { res: NucGeometryResult | null; run: NucGeoRun | null; pos: (v: number) => string;
  /** Drawn inside the geometry card's Saved view (no card of its own). */
  embedded?: boolean }) {
  const saved = useBrowserStore(s => s.savedNucGeometries ?? NO_SAVED);
  const selected = useBrowserStore(s => s.selectedFeatures);
  const datasets = useBrowserStore(s => s.datasets);
  const view = useBrowserStore(s => s.chrom);
  const [editing, setEditing] = useState<string | null>(null);
  if (!saved.length) return embedded ? <p className="text-[11px] text-ink-secondary" data-testid="nuc-geo-saved-empty">No saved geometries yet: the star on a geometry saves it.</p> : null;
  const dsLabel = (id: string) => datasets.find(d => d.id === id)?.label ?? id;
  const G = res?.geometries ?? [];
  const tol = geometryTolerance(res);
  const keys = new Set(selected.map(featureKey));
  const matches = saved.map(e => (res ? matchSaved(e, res.window?.chrom, G, tol) : null));
  const here = saved.filter(e => sameChrom(e.chrom, view)).length;
  const exportButton = <AnalysisExportGroup><AnalysisButton variant="neutral" data-testid="nuc-geo-saved-export"
    onClick={() => downloadTextFile(savedTsv(saved, dsLabel), `nucleosome_saved_geometries_${exportTimestamp()}.tsv`, 'text/tab-separated-values')}
    title="Every saved geometry: kind, span, the shares when saved per dataset (raw and m6A density matched)">TSV</AnalysisButton></AnalysisExportGroup>;
  const note = <p className="text-[11px] text-ink-secondary" title={`A saved geometry matches one of this analysis when it is of the same kind and both ends lie within the grouping tolerance (${tol} bp); a match acts as that geometry: click to highlight its carriers, shift-click to select it for Cluster, Sort and Filter.`}>
    {here} on this chromosome · matched by kind and both ends within {tol} bp</p>;
  const body = (
      <div className="max-h-72 overflow-auto rounded border border-gray-200 dark:border-gray-700" data-testid="nuc-geo-saved-list">
        {saved.map((e, k) => {
          const mi = matches[k];
          const g = mi != null ? G[mi] : null;
          const ref = g && run && mi != null ? geoFeatureRef(useBrowserStore.getState(), run, g, mi) : null;
          const picked = !!ref && keys.has(featureKey(ref));
          // Each molecule once (overlapping panels of a dataset never double-count).
          const now: Record<string, { full: number; molecules: number }> = g && run ? geoDatasetCounts(g, run.seriesDataset) : {};
          return (
            <div key={e.id} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-l-4 border-b-gray-100 px-2 py-0.5 text-[11px] last:border-b-0 dark:border-b-gray-800 ${picked ? 'border-l-gray-800 dark:border-l-gray-200' : 'border-l-transparent'}`}
              data-testid="nuc-geo-saved-row" data-saved={e.label} data-kind={e.kind} data-match={g?.id ?? undefined} data-feature-selected={picked || undefined}>
              <button type="button" className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[13px] text-amber-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                data-testid="nuc-geo-saved-remove" aria-label={`Remove ${e.name}`} title="Remove from the saved geometries"
                onClick={() => useBrowserStore.getState().removeSavedNucGeometry(e.id)}>★</button>
              {editing === e.id
                ? <input autoFocus defaultValue={e.name} className="input-tool w-28 rounded px-1 py-0.5 text-[11px]" data-testid="nuc-geo-saved-name-input"
                  onBlur={ev => { useBrowserStore.getState().updateSavedNucGeometry(e.id, { name: ev.target.value.trim() || e.label }); setEditing(null); }}
                  onKeyDown={ev => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setEditing(null); }} />
                // Not `disabled` when unmatched: a disabled button swallows the double-click that renames it.
                : <button type="button" className={`flex w-[8rem] flex-shrink-0 items-center gap-1 whitespace-nowrap text-left ${g && res ? '' : 'cursor-default opacity-80'}`} data-testid="nuc-geo-saved-name"
                  aria-disabled={!g || !res} onClick={ev => { if (g && res && mi != null) clickGeometry(run, res, mi, ev); }}
                  onDoubleClick={() => setEditing(e.id)}
                  title={g ? `Matches ${g.id} now: click to highlight its carriers; shift-click selects it for Cluster, Sort and Filter. Double-click renames`
                    : 'Not in this analysis (another locus, other settings, or not shared enough here). Double-click renames'}>
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: e.color }} />
                  <span className={`font-medium text-gray-800 dark:text-gray-100 ${picked ? 'underline decoration-2 underline-offset-2' : ''}`}>{e.name}</span>
                  {e.name !== e.label && <span className="text-[10px] text-ink-muted">({e.label})</span>}
                </button>}
              <span className={`flex-shrink-0 rounded px-1 text-[10px] leading-4 ${e.kind === 'low' ? 'bg-sky-50 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' : 'bg-rose-50 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200'}`}>{e.kind}</span>
              <span className="w-[11rem] flex-shrink-0 truncate tabular-nums text-gray-600 dark:text-gray-300" title={`${e.chrom}:${e.start.toLocaleString()}-${e.end.toLocaleString()}`}>
                {sameChrom(e.chrom, view) ? `${e.openLeft ? '≤ ' : ''}${pos(e.start)} to ${pos(e.end)}${e.openRight ? ' +' : ''}` : `${e.chrom}:${(e.start / 1000).toFixed(1)}k–${(e.end / 1000).toFixed(1)}k`}</span>
              <span className="order-last w-full pl-7 text-[10px] tabular-nums text-gray-600 dark:text-gray-300" data-testid="nuc-geo-saved-shares">
                {Object.entries(e.shares).map(([ds, v]) => {
                  const cur = now[ds];
                  return <span key={ds} className="mr-3 inline-block whitespace-nowrap" title={`${dsLabel(ds)}: ${pct(v.full)} carried it in full when saved`
                    + `${v.densityMatched != null ? ` (${pct(v.densityMatched)} of callable molecules, m6A density matched)` : ''}${cur ? `; ${pct(cur.molecules ? cur.full / cur.molecules : null)} now` : ''}`}>
                    {dsLabel(ds)} {pct(v.full)}{cur ? <span className="text-ink-muted"> → {pct(cur.molecules ? cur.full / cur.molecules : null)}</span> : null}</span>;
                })}
              </span>
              <span className="ml-auto flex-shrink-0 text-[10px] text-ink-muted" data-testid="nuc-geo-saved-match">{g ? `= ${g.id}` : 'not in this analysis'}</span>
              <AnalysisButton theme="emerald" variant="quiet" data-testid="nuc-geo-saved-go" title="Show its span in the read panels"
                onClick={() => { const pad = Math.round((e.end - e.start) * 0.25); useBrowserStore.getState().setViewport(e.chrom, Math.max(0, e.start - pad), e.end + pad); }}>Go to</AnalysisButton>
            </div>
          );
        })}
      </div>
  );
  if (embedded) return <div className="space-y-1.5" data-testid="nuc-geo-saved"><div className="flex flex-wrap items-center gap-2">{note}<span className="ml-auto">{exportButton}</span></div>{body}</div>;
  return (
    <AnalysisCard title={`Saved geometries (${saved.length})`} data-testid="nuc-geo-saved" actions={exportButton}>
      {note}
      {body}
    </AnalysisCard>
  );
}
