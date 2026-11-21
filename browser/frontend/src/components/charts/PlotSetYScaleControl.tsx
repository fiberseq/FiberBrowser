/**
 * The y-scale control for a set of small plots (cluster metaprofiles, Hub overlay facets, pooled/member peak
 * profiles): Own y per plot / Shared y, and (where it applies) Raw / Enrichment, with the enrichment baseline, its
 * form, the shared scope and the small-series threshold under "Options". One control for every panel; the maths is
 * utils/plotSetYScale.ts and usePlotSetYScale below.
 */
import { useMemo } from 'react';
import { AnalysisToggleGroup } from '../controls/shared';
import {
  plotSetDomains, yScaleSummary, type EnrichmentBaseline, type EnrichmentForm, type PlotSetMember, type PlotSetYScale,
  type SharedScope,
} from '../../utils/plotSetYScale';

const BASELINE_OPTIONS: { value: EnrichmentBaseline; label: string; title: string }[] = [
  { value: 'region', label: 'All reads in the region', title: 'Per position: the profile of every read in this region, clustered or not (the dataset\'s metaprofile for the view)' },
  { value: 'flank', label: 'Own flank mean', title: 'One number per plot: the mean of the plot\'s own outer flanks' },
  { value: 'dataset', label: 'Dataset mean', title: 'One number per dataset: the mean level of the dataset\'s metaprofile across this view' },
];
const FORM_OPTIONS: { value: EnrichmentForm; label: string }[] = [
  { value: 'percent', label: '% (100% = baseline)' },
  { value: 'ratio', label: 'Ratio (1 = baseline)' },
  { value: 'log2', label: 'log2 (0 = baseline)' },
];

export interface PlotSetYScaleControlProps {
  value: PlotSetYScale;
  onChange: (patch: Partial<PlotSetYScale>) => void;
  testId?: string;
  /** What the raw values are ("Fraction", "Density"). */
  rawLabel?: string;
  /** Enrichment offered (true), not offered (false: hidden), or offered-but-off with this reason (tooltip). */
  enrichment?: boolean | string;
  /** The baselines this set can use (default: all three). */
  baselines?: readonly EnrichmentBaseline[];
  /** Scope offered (true), hidden (false) or disabled with this reason. */
  scope?: boolean | string;
  /** Offer "share across channels with the same unit". */
  shareChannels?: boolean;
  /** Offer the small-series threshold (series carry read counts). */
  smallReads?: boolean;
  /** Extra tooltip on Shared y (e.g. "clusters in one chart already share its axis"). */
  sharedHint?: string;
  /** A short note under the control (e.g. "baseline empty: gaps"). */
  note?: string | null;
}

export function PlotSetYScaleControl({
  value, onChange, testId = 'plot-yscale', rawLabel = 'Raw', enrichment = true, baselines, scope = true,
  shareChannels = false, smallReads = false, sharedHint, note,
}: PlotSetYScaleControlProps) {
  const enrichmentOff = typeof enrichment === 'string' ? enrichment : null;
  const form = value.form;
  const enrichmentShown = enrichment !== false;
  const enriched = value.value === 'enrichment' && enrichmentShown;
  const baselineOptions = BASELINE_OPTIONS.filter(o => !baselines || baselines.includes(o.value));
  const scopeOff = typeof scope === 'string' ? scope : null;
  const optionsShown = enriched || (value.mode === 'shared' && (scope !== false || shareChannels || smallReads));
  return (
    <div className="space-y-0.5 text-[11px]" data-testid={testId} data-y-mode={value.mode} data-y-value={enriched ? 'enrichment' : 'raw'}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium text-ink-secondary">Y</span>
        <AnalysisToggleGroup
          value={value.mode}
          onChange={v => { if (v) onChange({ mode: v }); }}
          theme="cyan"
          options={[
            { value: 'perPlot', label: 'Own y', title: 'Each plot autoscales to its own range, for visibility (each shows its own max)' },
            { value: 'shared', label: 'Shared y', title: `One y range for the plots of a channel, so heights compare directly${sharedHint ? `. ${sharedHint}` : ''}` },
          ]}
        />
        {enrichmentShown && (
          <AnalysisToggleGroup
            value={enriched ? 'enrichment' : 'raw'}
            onChange={v => { if (v) onChange({ value: v }); }}
            theme="cyan"
            options={[
              { value: 'raw', label: rawLabel, title: `${rawLabel}: the plotted values as they are` },
              { value: 'enrichment', label: form === 'percent' ? '% enrichment' : 'Enrichment', disabled: !!enrichmentOff,
                title: enrichmentOff ?? 'Each profile relative to a baseline (100% = baseline); pick the baseline under Options' },
            ]}
          />
        )}
        <span className="text-ink-muted" data-testid={`${testId}-summary`}>{yScaleSummary({ ...value, value: enriched ? 'enrichment' : 'raw' }, rawLabel.toLowerCase())}</span>
      </div>
      {optionsShown && (
        <details className="pl-3" data-testid={`${testId}-options`}>
          <summary className="cursor-pointer text-ink-secondary">Options</summary>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {enriched && (
              <>
                <label className="inline-flex items-center gap-1">Baseline
                  <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={value.baseline} data-testid={`${testId}-baseline`}
                    onChange={e => onChange({ baseline: e.target.value as EnrichmentBaseline })}>
                    {baselineOptions.map(o => <option key={o.value} value={o.value} title={o.title}>{o.label}</option>)}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">Show as
                  <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={value.form} data-testid={`${testId}-form`}
                    onChange={e => onChange({ form: e.target.value as EnrichmentForm })}>
                    {FORM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                {value.baseline === 'flank' && (
                  <label className="inline-flex items-center gap-1" title="The share of the plot at each end that makes up the flank">Flank
                    <input type="number" min={2} max={45} step={1} className="input-tool w-12 text-[11px]" value={Math.round(value.flankFraction * 100)}
                      onChange={e => onChange({ flankFraction: Math.max(0.02, Math.min(0.45, (Number(e.target.value) || 10) / 100)) })} />%
                  </label>
                )}
                <label className="inline-flex items-center gap-1" title="Positions whose baseline is below this share of the baseline's maximum are left as gaps (0 = only where it is zero)">Min baseline
                  <input type="number" min={0} max={50} step={0.5} className="input-tool w-12 text-[11px]" value={+(value.minBaselineFraction * 100).toFixed(1)}
                    onChange={e => onChange({ minBaselineFraction: Math.max(0, Math.min(0.5, (Number(e.target.value) || 0) / 100)) })} />% of max
                </label>
              </>
            )}
            {value.mode === 'shared' && scope !== false && (
              <label className="inline-flex items-center gap-1" title={scopeOff ?? 'Share one range within each dataset, or across every dataset on show'}>Shared
                <select className="input-tool min-h-0 rounded px-1 py-0.5 text-[11px]" value={value.scope} disabled={!!scopeOff} data-testid={`${testId}-scope`}
                  onChange={e => onChange({ scope: e.target.value as SharedScope })}>
                  <option value="dataset">per dataset</option>
                  <option value="all">across all datasets</option>
                </select>
              </label>
            )}
            {value.mode === 'shared' && shareChannels && (
              <label className="inline-flex items-center gap-1" title="Channels with the same unit (every layer fraction) share one range too">
                <input type="checkbox" checked={value.shareChannels} onChange={e => onChange({ shareChannels: e.target.checked })} data-testid={`${testId}-share-channels`} />
                across channels
              </label>
            )}
            {value.mode === 'shared' && smallReads && (
              <label className="inline-flex items-center gap-1" title="Series from fewer reads are still drawn (clipped at the top) but don't set the shared range">Ignore under
                <input type="number" min={0} max={1000} step={1} className="input-tool w-12 text-[11px]" value={value.smallReads}
                  onChange={e => onChange({ smallReads: Math.max(0, Math.round(Number(e.target.value) || 0)) })} /> reads
              </label>
            )}
          </div>
        </details>
      )}
      {note && <div className="pl-3 text-ink-muted" data-testid={`${testId}-note`}>{note}</div>}
    </div>
  );
}

/** The y domain of each plot in a set under these settings (memoised). */
export function usePlotSetYScale(members: readonly PlotSetMember[], settings: PlotSetYScale) {
  return useMemo(() => plotSetDomains(members, settings), [members, settings]);
}
