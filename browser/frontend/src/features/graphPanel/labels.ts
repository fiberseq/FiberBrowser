/**
 * Member labels in graph mode (graph follow-ups item 7). A split lifted member is labelled by its haplotype (MAT,
 * PAT); a lifted dataset with one haplotype (a strain or generic package against its reference, G8) has no
 * haplotype of its own on the panel, so it is labelled by the PanSN name of the one path it binds (`SAMPLE#1`)
 * rather than by the dataset's label.
 */
import type { PanelConfig } from '../../types';
import { graphBindingFor, type DatasetGraphBinding } from './bindingsStore';

/** The PanSN name (`sample#haplotype`) of the one haplotype path a single-haplotype lifted dataset binds; null for a
 * panel with its own haplotype, a native dataset, or a dataset binding several haplotypes. `targetKey`: the host's
 * target, to prefer the path mapped to it when the dataset binds that haplotype on several contigs. */
export function singleHapPathName(bound: DatasetGraphBinding | null | undefined, liftHap: string | null | undefined,
  targetKey: string | null = null): string | null {
  if (!bound || liftHap || bound.binding.kind !== 'lifted') return null;
  const haps = bound.binding.haps ?? {};
  const keys = Object.keys(haps).length ? Object.keys(haps) : Object.keys(bound.binding.paths);
  if (!keys.length) return null;
  if (new Set(keys.map(k => (haps[k] ?? k).toUpperCase())).size !== 1) return null;
  const mapped = new Set(bound.registration.maps.filter(m => m.target === targetKey).map(m => m.source));
  const key = keys.find(k => mapped.has(k)) ?? keys[0];
  const path = bound.registration.bindings.find(b => b.key === key)?.path;
  if (path?.sample) return path.haplotype != null && String(path.haplotype) !== '' ? `${path.sample}#${path.haplotype}` : path.sample;
  return haps[key] ?? null;
}

/** A member's label: its title, else its haplotype, else (one haplotype) its PanSN path name, else the dataset's. */
export function memberLabel(p: PanelConfig, datasetLabel: string, targetKey: string | null = null,
  bound: DatasetGraphBinding | null = graphBindingFor(p.datasetId)): string {
  return p.title || p.liftHap || singleHapPathName(bound, p.liftHap, targetKey) || datasetLabel;
}
