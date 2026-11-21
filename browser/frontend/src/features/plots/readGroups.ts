/**
 * Read groups for Plots' Group by (Plots Phase 2): sets of reads per dataset, from
 * - Read groups: the split panels (Split into panels: SNP alleles, SV carriers, patterns), each panel's reads;
 * - Selected classes: the selected footprint classes (or other selected features), the reads that are members
 *   ('1' in /api/features/states).
 * A read can be in several groups (classes overlap). Size plots ask the server once per group (its reads as a
 * one-cluster assignment); profiles and heatmaps put each member read in each of its groups.
 */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { getFeatureStates } from '../../api/features';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import type { PlotGroupBy } from './plotModel';

export interface ReadGroupDef {
  id: string;
  title: string;
  color: string;
  /** dataset id -> member read names */
  members: Record<string, Set<string>>;
}

export interface ReadGroupsState {
  groups: ReadGroupDef[];
  loading: boolean;
  /** Why there are no groups (nothing split, nothing selected, an error); null when there are. */
  blocker: string | null;
  /** Identity for request keys: ids and member counts. */
  signature: string;
}

const EMPTY: ReadGroupsState = { groups: [], loading: false, blocker: null, signature: '' };

export const readGroupsSignature = (groups: ReadGroupDef[]): string =>
  groups.map(g => `${g.id}:${Object.entries(g.members).map(([d, s]) => `${d}=${s.size}`).join(',')}`).join(';');

/** The read groups of a Group by choice (empty for the others). */
export function useReadGroups(groupBy: PlotGroupBy): ReadGroupsState {
  const panels = useBrowserStore(s => s.panels);
  const splitReads = useSplitPanelStore(s => s.reads);
  const selectedFeatures = useBrowserStore(useShallow(s => s.selectedFeatures));
  const datasets = useBrowserStore(s => s.datasets);
  const [classes, setClasses] = useState<{ key: string; state: ReadGroupsState } | null>(null);
  const featureKey = JSON.stringify(selectedFeatures.map(f => [f.kind, f.source, f.id, f.datasetId ?? '']));

  const split = useMemo<ReadGroupsState>(() => {
    if (groupBy !== 'read-groups') return EMPTY;
    const subsets = panels.filter(p => p.contentType === 'dataset' && p.readSubset && p.datasetId && p.stateKey);
    if (!subsets.length) return { ...EMPTY, blocker: 'No read groups yet: split a dataset into panels (Split into panels on the read menu or the Variants panel), then group by read groups.' };
    const loading = subsets.some(p => splitReads[p.stateKey!]?.state === 'loading' || !splitReads[p.stateKey!]);
    const groups = subsets.map(p => ({
      id: p.stateKey!, title: p.readSubset!.label, color: p.readSubset!.colour,
      members: { [p.datasetId!]: new Set(splitReads[p.stateKey!]?.ids ?? []) },
    })).filter(g => Object.values(g.members).some(s => s.size));
    return { groups, loading, blocker: !groups.length && !loading ? 'The split panels have no reads here.' : null, signature: readGroupsSignature(groups) };
  }, [groupBy, panels, splitReads]);

  useEffect(() => {
    if (groupBy !== 'classes') return;
    if (!selectedFeatures.length) { setClasses({ key: featureKey, state: { ...EMPTY, blocker: 'No classes selected: pick footprint classes (Footprints › Classes or the Feature hub), then group by selected classes.' } }); return; }
    let live = true;
    setClasses(c => ({ key: featureKey, state: { ...(c?.state ?? EMPTY), loading: true } }));
    getFeatureStates(selectedFeatures)
      .then(r => {
        if (!live) return;
        const groups: ReadGroupDef[] = r.features.map((f, i) => {
          const members: Record<string, Set<string>> = {};
          for (const [ds, reads] of Object.entries(r.by_dataset ?? {})) {
            const set = new Set<string>();
            for (const [name, states] of Object.entries(reads)) if (states[i] === '1') set.add(name);
            if (set.size) members[ds] = set;
          }
          const ds = f.dataset_id ? datasets.find(d => d.id === f.dataset_id)?.label : null;
          return { id: `class:${f.kind}:${f.source}:${f.id}`, title: ds && datasets.length > 1 ? `${f.label} (${ds})` : f.label, color: getClusterColor(i), members };
        }).filter(g => Object.keys(g.members).length);
        setClasses({ key: featureKey, state: { groups, loading: false, blocker: groups.length ? null : 'The selected classes have no member reads here.', signature: readGroupsSignature(groups) } });
      })
      .catch(err => { if (live) setClasses({ key: featureKey, state: { ...EMPTY, blocker: `Classes could not be read: ${err instanceof Error ? err.message : String(err)}` } }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, featureKey]);

  if (groupBy === 'read-groups') return split;
  if (groupBy === 'classes') return classes && classes.key === featureKey ? classes.state : { ...EMPTY, loading: true };
  return EMPTY;
}

export const isReadGroupBy = (g: PlotGroupBy): boolean => g === 'read-groups' || g === 'classes';
