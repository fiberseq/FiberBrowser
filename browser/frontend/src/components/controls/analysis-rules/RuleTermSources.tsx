/**
 * The layer-free rule term sources shared by the Cluster, Sort and Filter rule editors:
 * - molecule metric: a per-molecule scalar (nucmol / nfrmol), picked from GET /api/nuc/metrics;
 * - hub hits: a snapshot of the feature hub's selection, counted where each read is in the chosen state.
 */
import { useEffect, useState } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import type { AnalysisRuleScope, ClusterFeatureRuleTerm } from '../../../types';
import type { HubSelected } from '../../../features/hub/hubState';
import { normalizeAnalysisRuleScope } from '../../../utils/analysisRules';
import {
  DEFAULT_MOLECULE_METRIC,
  MOLECULE_METRICS,
  MOLECULE_METRIC_GROUPS,
  fetchMoleculeMetrics,
  moleculeMetricInfo,
  type MoleculeMetric,
} from '../../../utils/moleculeMetrics';
import { AnalysisButton } from '../shared';

type HubHit = NonNullable<ClusterFeatureRuleTerm['hubHits']>[number];

const NO_SELECTION: HubSelected[] = [];

/** The server's metric list (the static one until it answers, or when it fails). */
export function useMoleculeMetrics(): readonly MoleculeMetric[] {
  const [metrics, setMetrics] = useState<readonly MoleculeMetric[]>(MOLECULE_METRICS);
  useEffect(() => {
    let live = true;
    void fetchMoleculeMetrics().then(list => { if (live) setMetrics(list); });
    return () => { live = false; };
  }, []);
  return metrics;
}

/** The hub selection's hits with per-read states (the rest cannot be counted), and how many are selected. */
export function useHubSelectionHits(): { hits: HubHit[]; selected: number } {
  const selected = useBrowserStore(s => s.featureHub?.selected ?? NO_SELECTION);
  return { hits: hubHitsSnapshot(selected), selected: selected.length };
}

export function hubHitsSnapshot(selected: readonly HubSelected[]): HubHit[] {
  return selected.filter(h => h.hasStates).map(h => ({
    setId: h.setId, hitId: h.hitId, chrom: h.chrom, start: h.start, end: h.end, ...(h.label ? { label: h.label } : {}),
  }));
}

/** Why the hub source is unavailable ('' when it is). */
export function hubSourceNote(hub: { hits: HubHit[]; selected: number }): string {
  if (hub.selected === 0) return 'select hits in the feature hub first';
  if (hub.hits.length === 0) return 'the selected hits have no per-read states';
  return '';
}

const clearedLayerFields = { layer: null, sizeMin: 0, sizeMax: null, qualityGates: [] };

export function moleculeMetricTerm(term: ClusterFeatureRuleTerm, metric?: string): ClusterFeatureRuleTerm {
  return { ...term, ...clearedLayerFields, source: 'molecule_metric', moleculeMetric: metric || term.moleculeMetric || DEFAULT_MOLECULE_METRIC };
}

export function hubHitsTerm(term: ClusterFeatureRuleTerm, hits: HubHit[], state?: '1' | '0'): ClusterFeatureRuleTerm {
  return { ...term, ...clearedLayerFields, source: 'feature_hub', hubHits: hits, hubState: state ?? term.hubState ?? '1' };
}

/** A peak scope finds no region without selected peaks; these terms read the whole view instead. */
export function layerFreeScope(scope: AnalysisRuleScope | undefined): AnalysisRuleScope {
  const current = normalizeAnalysisRuleScope(scope);
  return current.kind === 'selectedPeaks' || current.kind === 'allPeaks'
    ? normalizeAnalysisRuleScope({ ...current, kind: 'currentWindow', peakLevelMin: null, peakLevelMax: null })
    : current;
}

export function MoleculeMetricSelect({ value, onChange }: { value: string | undefined; onChange: (metric: string) => void }) {
  const metrics = useMoleculeMetrics();
  const current = value || DEFAULT_MOLECULE_METRIC;
  const known = metrics.some(metric => metric.id === current);
  return (
    <select
      value={current}
      onChange={event => onChange(event.target.value)}
      className="input-tool max-w-[220px] text-xs"
      title="Per-molecule metric from a nucleosome or NFR scan"
    >
      {!known && <option value={current}>{moleculeMetricInfo(current)?.label ?? current}</option>}
      {MOLECULE_METRIC_GROUPS.map(({ group, label }) => {
        const options = metrics.filter(metric => metric.group === group);
        if (options.length === 0) return null;
        return (
          <optgroup key={group} label={label}>
            {options.map(metric => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
          </optgroup>
        );
      })}
    </select>
  );
}

/** The metric's unit, shown where the metric select is for other sources. */
export function MoleculeMetricUnit({ metric }: { metric: string | undefined }) {
  const metrics = useMoleculeMetrics();
  const id = metric || DEFAULT_MOLECULE_METRIC;
  const unit = metrics.find(m => m.id === id)?.unit ?? moleculeMetricInfo(id)?.unit ?? '';
  return <span className="text-[11px] text-gray-500" title="The molecule metric's value, in its unit">{unit ? `value (${unit})` : 'value'}</span>;
}

export function HubHitsControls({
  term,
  hub,
  onSnapshot,
  onState,
}: {
  term: ClusterFeatureRuleTerm;
  hub: { hits: HubHit[]; selected: number };
  onSnapshot: () => void;
  onState: (state: '1' | '0') => void;
}) {
  const note = hubSourceNote(hub);
  const count = term.hubHits?.length ?? 0;
  return (
    <>
      <span className="text-[11px] text-gray-500">{count} hit{count === 1 ? '' : 's'}</span>
      <select
        value={term.hubState === '0' ? '0' : '1'}
        onChange={event => onState(event.target.value === '0' ? '0' : '1')}
        className="input-tool text-xs"
        title="The per-read state that counts at each hit"
      >
        <option value="1">member / open (1)</option>
        <option value="0">not (0)</option>
      </select>
      <AnalysisButton
        variant="outline"
        onClick={onSnapshot}
        disabled={!!note}
        title={note || 'Replace the hits with the feature hub\'s current selection'}
      >
        Use hub selection
      </AnalysisButton>
      {note && <span className="text-[11px] text-gray-400">{note}</span>}
    </>
  );
}
