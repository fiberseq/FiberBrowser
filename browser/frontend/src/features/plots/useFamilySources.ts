/**
 * The feature families a plot can draw as sources in a view (hub/familySources.ts), recomputed when the hub's
 * providers change (Find classes finishing, an NFR run, the hub's own sets), as Plots › Differential follows them.
 */
import { useEffect, useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { hubProviders, onHubProvidersChanged, type HubSelected } from '../hub/hubState';
import { FAMILY_KINDS, familyHits, familyMeasureId, type FamilyKind } from '../hub/familySources';

/** The family kinds Plots offers as metaprofile sources (geometries are per-molecule patterns, not spans to profile). */
export const PLOT_FAMILY_KINDS: readonly FamilyKind[] = FAMILY_KINDS.filter(k => k.source === 'fp-families' || k.source === 'nfr-families');

export interface FamilyOption { id: string; label: string; kind: FamilyKind; hit: HubSelected }

/** Bumps when the hub providers' sets may have changed. */
export function useProviderVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV(x => x + 1);
    const subs = hubProviders().flatMap(p => (p.subscribe ? [p.subscribe(bump)] : []));
    const off = onHubProvidersChanged(bump);
    return () => { subs.forEach(u => u()); off(); };
  }, []);
  return v;
}

/** Families with per-read states overlapping the view, per kind (in PLOT_FAMILY_KINDS order). */
export function familyOptionsIn(view: { chrom: string; start: number; end: number } | null): Array<{ kind: FamilyKind; options: FamilyOption[] }> {
  if (!view || !(view.end > view.start)) return PLOT_FAMILY_KINDS.map(kind => ({ kind, options: [] }));
  const state = useBrowserStore.getState();
  return PLOT_FAMILY_KINDS.map(kind => ({
    kind,
    options: familyHits(state, view, kind.typeIds).map(hit => ({ id: familyMeasureId(hit), label: hit.label ?? hit.hitId, kind, hit })),
  }));
}

/** familyOptionsIn, kept current (providers, peaks, saved NFR variants, datasets). */
export function useFamilyOptions(view: { chrom: string; start: number; end: number } | null): Array<{ kind: FamilyKind; options: FamilyOption[] }> {
  const version = useProviderVersion();
  const groups = useBrowserStore(s => s.footprintGroups);
  const nfr = useBrowserStore(s => s.savedNfrVariants);
  const datasets = useBrowserStore(s => s.datasets);
  const hub = useBrowserStore(s => s.featureHub);
  return useMemo(() => familyOptionsIn(view),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, view?.chrom, view?.start, view?.end, groups, nfr, datasets, hub]);
}
