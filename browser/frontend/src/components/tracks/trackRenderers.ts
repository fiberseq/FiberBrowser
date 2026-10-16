/**
 * Rows a plugin pack draws in dataset panels (SubTrackDispatch): the pack registers the row's kind
 * (trackRegistry.registerTrackKind, with a `defaultPlacement`) and how to draw it here.
 *
 * `useHeight` is a hook: SubTrackDispatch calls every registered one, in registration order, on each render, so
 * packs register before the app renders (plugins/packs.ts). It returns the row's height in a panel, or null when the
 * row has nothing to show there; render and layout use the same answer.
 */
import type { ReactNode } from 'react';
import type { PanelConfig, SubTrackConfig } from '../../types';

export interface PluginTrackArgs {
  panel: PanelConfig;
  track: SubTrackConfig;
  /** The panel's dataset (null: a genome-only panel). */
  datasetId: string | null;
  /** The region the panel shows (its own view, else the main view). */
  view: { chrom: string; start: number; end: number };
}

export interface PluginTrackRenderArgs extends PluginTrackArgs {
  width: number;
  height: number;
  /** The cluster sidebar's width at the left of the row. */
  sidebarWidth: number;
}

export interface PluginTrackRenderer {
  type: string;
  useHeight: () => (args: PluginTrackArgs) => number | null;
  render: (args: PluginTrackRenderArgs) => ReactNode;
}

const renderers: PluginTrackRenderer[] = [];

export function registerTrackRenderer(renderer: PluginTrackRenderer): void {
  const at = renderers.findIndex(r => r.type === renderer.type);
  if (at >= 0) renderers[at] = renderer;
  else renderers.push(renderer);
}

/** The registered renderers, in registration order (a stable list once the app renders). */
export function trackRenderers(): readonly PluginTrackRenderer[] {
  return renderers;
}
