import type { ComponentType, SVGProps } from 'react';
import {
  AccessibleColumn, BarChart, Compass, ContactMap, Footprint, LayoutColumns, NucleosomeFree, Peaks, Plasmid,
  Primers, ReadClusters, SignalTrack, Sliders, Tag, Target, Transcription,
} from './Icons';
import { canonicalPanelType, getAnalysisPanel } from '../../plugins/registry';

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/** The icon of each analysis panel (analysis strip chips and panel headers). */
const PANEL_ICONS: Record<string, Icon> = {
  'cluster-detail': ReadClusters,
  'footprint-analysis': Footprint,
  'transcription-state': Transcription,
  'read-stats': BarChart,
  'co-accessibility': NucleosomeFree,
  'track-browser': SignalTrack,
  colormap: Tag,
  'cluster-features': Sliders,
  'dataset-layout': LayoutColumns,
  'circular-genome': Plasmid,
  'primer-design': Primers,
  history: Compass,
  'contact-map': ContactMap,
  'peak-detection': Peaks,
  capture: Target,
  annotations: AccessibleColumn,
};

/** A panel's icon: the built-in one, else the one its plugin (or plugin pack) registered with it. */
function panelIcon(contentType: string): Icon | undefined {
  const type = canonicalPanelType(contentType);
  return PANEL_ICONS[contentType] ?? PANEL_ICONS[type] ?? (getAnalysisPanel(type)?.icon as Icon | undefined);
}

/** Whether a panel type has a built-in icon (plugins may bring their own instead). */
export function hasPanelIcon(contentType: string): boolean {
  return panelIcon(contentType) !== undefined;
}

export function PanelIcon({ contentType, size = 16, className }: { contentType: string; size?: number; className?: string }) {
  const Icon = panelIcon(contentType);
  if (!Icon) return null;
  return <Icon size={size} className={className} aria-hidden="true" focusable="false" />;
}
