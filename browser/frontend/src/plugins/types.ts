import type { ComponentType } from 'react';

/** 'tracks' is the old name for 'view' and is shown there. */
export type AnalysisPanelGroup = 'analysis' | 'view' | 'tracks' | 'tools';

export interface AnalysisPanelProps {
  isFullView?: boolean;
  /** The panel's id (several panels of a non-singleton type each know their own config). */
  panelId?: string;
  /** The panel body's usable size in CSS px (below the header). */
  width?: number;
  height?: number;
}

export interface AnalysisPanelPlugin {
  contentType: string;                          // unique key, used as PanelConfig.contentType
  label: string;                                // human-readable (header, chips)
  headerColor: string;                          // hex color for header bar
  component: ComponentType<AnalysisPanelProps>;  // React component to render
  icon?: ComponentType<{ size?: number }>;      // optional icon for chips
  description?: string;                         // tooltip text
  singleton?: boolean;                          // default true — only one instance allowed
  shortLabel?: string;                          // compact label for strip buttons
  group?: AnalysisPanelGroup;                   // grouping in AnalysisStrip
  stripOrder?: number;                          // position within its group (unset: after, in registration order)
  hostOnly?: boolean;                           // needs the host machine (BLAST, local LLM): hidden on public servers
  minUsableWidth?: number;                      // narrower than this, the panel offers Maximize instead (default 240px)
  sessionKeys?: string[];                       // frontend-state keys needed to restore this panel
  apiEndpoints?: string[];                      // primary backend/Jupyter endpoints backing the panel
  settingsTargets?: string[];                   // settings/provenance sections that feed the panel
  preview?: string;                             // a Preview feature's id (utils/previewFeatures): its launchers hidden while previews are off
  /** 'scroll' (default): the host scrolls the body. 'fill': the body is exactly the panel's height and the panel
   * scrolls inside itself (a canvas that sizes itself to its body: the graph view). */
  bodyLayout?: 'scroll' | 'fill';
  /** Stacked with other panels in a column, take the natural height the panel reports
   * (stores/panelContentHeightStore.ts) rather than an equal share. */
  sizeToContent?: boolean;
  /** Where a newly opened panel goes: 'stack-below-reads' stacks it under the first reads (or genome) panel of the
   * top row, at its natural height, unless the user pinned this kind of panel to the side. Default: beside. */
  opens?: 'beside' | 'stack-below-reads';
}
