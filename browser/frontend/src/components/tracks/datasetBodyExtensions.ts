/**
 * Another body for a dataset panel in place of its sub-tracks (graph primary: a dataset panel in graph mode draws the
 * graph of its members' reads, DESIGN_GRAPH_PRIMARY §1.1). The panel keeps its header, dataset frame, site bar,
 * menus and PanelDisplayContext; only the sub-track loop is replaced. The first registered body that shows wins.
 */
import type { ComponentType } from 'react';
import type { PanelConfig } from '../../types';

export interface DatasetBodyProps { panel: PanelConfig; width: number; height: number }

export interface DatasetBodyExtension {
  id: string;
  /** Whether this body replaces the panel's sub-tracks now (pure; called on every render). */
  shows: (panel: PanelConfig) => boolean;
  component: ComponentType<DatasetBodyProps>;
}

const bodies: DatasetBodyExtension[] = [];

export function registerDatasetBody(def: DatasetBodyExtension): void {
  if (!bodies.some(b => b.id === def.id)) bodies.push(def);
}

export function datasetBodyFor(panel: PanelConfig): DatasetBodyExtension | null {
  return bodies.find(b => b.shows(panel)) ?? null;
}
