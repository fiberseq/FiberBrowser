import type { ComponentType } from 'react';

/** 'tracks' is the old name for 'view' and is shown there. */
export type AnalysisPanelGroup = 'analysis' | 'view' | 'tracks' | 'tools';

export interface AnalysisPanelProps {
  isFullView?: boolean;
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
}
