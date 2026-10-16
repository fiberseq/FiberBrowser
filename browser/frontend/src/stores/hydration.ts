/**
 * Store-state hydration helpers for JSON-loaded sessions and snapshots.
 *
 * Zustand state contains Sets, but session JSON stores those fields as arrays.
 * Normalizing them in one place prevents `.has(...)` crashes after import.
 */
import { coerceSidebarSection } from './utils';

export function toArray<T>(value: unknown): T[] {
  if (value instanceof Set) return [...value] as T[];
  if (Array.isArray(value)) return [...value] as T[];
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const arrayLike = record.values ?? record.value ?? record.items ?? record.data;
  if (arrayLike instanceof Set) return [...arrayLike] as T[];
  if (Array.isArray(arrayLike)) return [...arrayLike] as T[];

  // Some older/debug snapshots encoded Sets as objects with numeric keys.
  const numericEntries = Object.entries(record).filter(([key]) => /^\d+$/.test(key));
  if (numericEntries.length > 0) {
    return numericEntries
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => v as T);
  }

  return [];
}

export function toSet<T>(value: unknown): Set<T> {
  return new Set<T>(toArray<T>(value));
}

export function deserializeSetRecord<T>(value: unknown): Record<string, Set<T> | null> | null {
  if (!value || typeof value !== 'object') return null;
  const restored: Record<string, Set<T> | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    restored[k] = v == null ? null : toSet<T>(v);
  }
  return restored;
}

export function deserializeSets(batch: Record<string, unknown>): void {
  const clusterFocus = deserializeSetRecord<number>(batch.clusterFocus);
  if (clusterFocus) {
    batch.clusterFocus = clusterFocus;
  }

  const selectedClusters = deserializeSetRecord<number>(batch.selectedClusters);
  if (selectedClusters) {
    batch.selectedClusters = selectedClusters;
  }

  const filteredReadIds = deserializeSetRecord<string>(batch.filteredReadIds);
  if (filteredReadIds) {
    batch.filteredReadIds = filteredReadIds;
  }

  const selectedReadIds = deserializeSetRecord<string>(batch.selectedReadIds);
  if (selectedReadIds) {
    batch.selectedReadIds = Object.fromEntries(
      Object.entries(selectedReadIds).map(([k, v]) => [k, v ?? new Set<string>()]),
    );
  }

  if (batch.selectedPeaks !== undefined) {
    batch.selectedPeaks = toSet<number>(batch.selectedPeaks);
  }

  if (batch.selectedDatasets !== undefined) {
    batch.selectedDatasets = toSet<string>(batch.selectedDatasets);
  }

  if (batch.collapsedRows !== undefined) {
    batch.collapsedRows = toSet<number>(batch.collapsedRows);
  }

  if (batch.hiddenStripPanels !== undefined) {
    batch.hiddenStripPanels = toSet<string>(batch.hiddenStripPanels);
  }

  // Defensive hydration for older local snapshots/imports.
  if (batch.selectedPanelIds !== undefined) {
    batch.selectedPanelIds = toSet<string>(batch.selectedPanelIds);
  }
  if (batch.dismissedPanelTypes !== undefined) {
    batch.dismissedPanelTypes = toSet<string>(batch.dismissedPanelTypes);
  }
  // Older snapshots: the accordion's open sections become the page shown (its first).
  if (batch.openSections !== undefined) {
    const legacy = coerceSidebarSection(batch.openSections);
    if (legacy && batch.activeSection === undefined) batch.activeSection = legacy;
    delete batch.openSections;
  }
  if (batch.activeSection !== undefined) {
    const active = coerceSidebarSection(batch.activeSection);
    if (active) batch.activeSection = active;
    else delete batch.activeSection;
  }
}
