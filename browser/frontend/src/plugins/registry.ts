import { isPublicServerPage } from '../utils/publicServerFlag';
import { previewHidden } from '../utils/previewFeatures';
import { declareContribution } from './packRegistry';
import type { AnalysisPanelPlugin, AnalysisPanelGroup } from './types';

const registry = new Map<string, AnalysisPanelPlugin>();

interface PanelLike {
  id: string;
  contentType: string;
  collapsed?: boolean;
}

/**
 * Panel types that were renamed: the old name opens, restores and remembers the new panel (sessions, snapshots,
 * remembered rail tiles and links from before the rename). Filled by `registerPanelAlias`.
 */
const panelAliases: Record<string, string> = {};
export const PANEL_ALIASES: Readonly<Record<string, string>> = panelAliases;

/** An old name of a panel type (its sessions, links and remembered tiles open the new one). */
export function registerPanelAlias(from: string, to: string): void {
  panelAliases[from] = to;
  declareContribution('panels', from);
}

/** The current name of a panel type (an old name is redirected). */
export function canonicalPanelType<T extends string>(contentType: T): T | string {
  return PANEL_ALIASES[contentType] ?? contentType;
}

type MigratedPanel = Record<string, unknown> & { contentType: string };
/** A migration's answer: the panel as this build has it, the panels it becomes (one keeps its id), or null (no change). */
type PanelMigration = (panel: MigratedPanel) => MigratedPanel | MigratedPanel[] | null;
const panelMigrations: PanelMigration[] = [];

/**
 * A panel type's own older formats (a panel that moved to another type, say): `migrate` returns the panel as this
 * build has it, or null when it has nothing to change. Runs after the renames, wherever they run.
 */
export function registerPanelMigration(migrate: PanelMigration): void {
  panelMigrations.push(migrate);
}

/**
 * Panels restored from a session, snapshot or crash recovery, with renamed types redirected (and the registered
 * migrations applied). Panel ids stay as they were: the full view, the selection and the drawer refer to panels by id.
 */
export function migratePanelAliases<T extends { contentType: string }>(panels: T[]): T[] {
  if (!Array.isArray(panels)) return panels;
  return panels.flatMap(panel => {
    const to = panel && typeof panel.contentType === 'string' ? PANEL_ALIASES[panel.contentType] : undefined;
    let out: T[] = [to ? { ...panel, contentType: to } : panel];
    for (const migrate of panelMigrations) {
      out = out.flatMap(p => {
        if (!p || typeof p.contentType !== 'string') return [p];
        const next = migrate(p as unknown as MigratedPanel);
        return next == null ? [p] : (Array.isArray(next) ? next : [next]) as unknown as T[];
      });
    }
    return out;
  });
}

export function registerAnalysisPanel(plugin: AnalysisPanelPlugin): void {
  if (registry.has(plugin.contentType)) {
    console.warn(`[plugins] Overwriting analysis panel "${plugin.contentType}"`);
  }
  // Default singleton to true
  if (plugin.singleton === undefined) {
    plugin.singleton = true;
  }
  registry.set(plugin.contentType, plugin);
  declareContribution('panels', plugin.contentType);
}

export function getAnalysisPanel(contentType: string): AnalysisPanelPlugin | undefined {
  return registry.get(contentType) ?? registry.get(canonicalPanelType(contentType));
}

export function getAllAnalysisPanels(): AnalysisPanelPlugin[] {
  return Array.from(registry.values());
}

export function isAnalysisPanel(contentType: string): boolean {
  return registry.has(contentType) || registry.has(canonicalPanelType(contentType));
}

export function normalizeAnalysisPanelContentTypes(contentTypes: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of contentTypes) {
    if (typeof raw !== 'string') continue;
    const contentType = canonicalPanelType(raw);
    if (!registry.has(contentType) || seen.has(contentType)) continue;
    seen.add(contentType);
    normalized.push(contentType);
  }
  return normalized;
}

export function getAnalysisPanelLabel(contentType: string, compact = false): string {
  const plugin = getAnalysisPanel(contentType);
  if (!plugin) return contentType;
  return compact ? (plugin.shortLabel || plugin.label) : plugin.label;
}

export function findOpenAnalysisPanel<T extends PanelLike>(
  panels: readonly T[],
  contentType: string,
): T | undefined {
  const type = canonicalPanelType(contentType);
  if (!registry.has(type)) return undefined;
  return panels.find(panel => canonicalPanelType(panel.contentType) === type && !panel.collapsed);
}

export function describePanelProvenance(contentType: string): string {
  const plugin = getAnalysisPanel(contentType);
  if (!plugin) return contentType;
  const parts = [plugin.description].filter(Boolean) as string[];
  if (plugin.settingsTargets?.length) {
    parts.push(`Settings: ${plugin.settingsTargets.join(', ')}`);
  }
  if (plugin.sessionKeys?.length) {
    parts.push(`Session: ${plugin.sessionKeys.join(', ')}`);
  }
  if (plugin.apiEndpoints?.length) {
    parts.push(`API: ${plugin.apiEndpoints.join(', ')}`);
  }
  return parts.join(' · ');
}

export interface SettingsTargetLink {
  label: string;
  sectionId?: string;
  subsectionId?: string;
  panelType?: string;
  title: string;
}

const SETTINGS_TARGET_LINKS: Record<string, Omit<SettingsTargetLink, 'label'>> = {
  'Analysis & Reproducibility': {
    sectionId: 'analysis',
    subsectionId: 'analysis.reproducibility',
    title: 'Open Settings > Analysis & Reproducibility',
  },
  'Labeling & Quality': {
    panelType: 'colormap',
    title: 'Open Labeling',
  },
  Clustering: {
    panelType: 'cluster-detail',
    title: 'Open Clusters panel',
  },
  'Cluster Detail': {
    panelType: 'cluster-detail',
    title: 'Open Clusters panel',
  },
  'Peak Detection': {
    panelType: 'cluster-features',
    sectionId: 'analysis',
    subsectionId: 'analysis.peaks',
    title: 'Open peak rules',
  },
  'Cluster Feature Rules': {
    panelType: 'cluster-features',
    title: 'Open Rules panel',
  },
  'Analysis Rules': {
    panelType: 'cluster-features',
    title: 'Open Rules panel',
  },
  'Footprint Analysis': {
    panelType: 'footprint-analysis',
    title: 'Open Footprints panel',
  },
  'Selected Genes': {
    panelType: 'transcription-state',
    title: 'Open Transcription panel',
  },
  'Read Selection': {
    panelType: 'read-stats',
    title: 'Open Read Stats panel',
  },
  Genome: {
    sectionId: 'genome',
    subsectionId: 'genome.reference',
    title: 'Open Settings > Reference & Tracks',
  },
  'DAF-C': {
    panelType: 'contact-map',
    title: 'Open Contacts panel',
  },
  'Primer Design': {
    panelType: 'primer-design',
    title: 'Open Primers panel',
  },
  'Capture Regions': {
    panelType: 'primer-design',
    title: 'Open Primers > Capture',
  },
  'Capture Design': {
    panelType: 'primer-design',
    title: 'Open Primers > Capture',
  },
  Session: {
    sectionId: 'file',
    subsectionId: 'file.session',
    title: 'Open Settings > Data & Sessions',
  },
  Tracks: {
    panelType: 'track-browser',
    sectionId: 'genome',
    subsectionId: 'genome.online',
    title: 'Open Tracks panel',
  },
  'Track Browser': {
    panelType: 'track-browser',
    title: 'Open Tracks panel',
  },
  Annotations: {
    panelType: 'annotations',
    title: 'Open Annotations panel',
  },
};

export function getSettingsTargetLink(label: string): SettingsTargetLink {
  const mapped = SETTINGS_TARGET_LINKS[label];
  if (mapped) return { label, ...mapped };
  return {
    label,
    sectionId: 'analysis',
    title: `Open settings related to ${label}`,
  };
}

export function getPanelSettingsLinks(contentType: string): SettingsTargetLink[] {
  const plugin = getAnalysisPanel(contentType);
  if (!plugin?.settingsTargets?.length) return [];
  const seen = new Set<string>();
  const links: SettingsTargetLink[] = [];
  for (const target of plugin.settingsTargets) {
    if (seen.has(target)) continue;
    seen.add(target);
    links.push(getSettingsTargetLink(target));
  }
  return links;
}

const GROUP_ORDER: AnalysisPanelGroup[] = ['analysis', 'view', 'tools'];
export const GROUP_LABELS: Record<AnalysisPanelGroup, string> = {
  analysis: 'Analyze',
  view: 'View',
  tracks: 'View',
  tools: 'Tools',
};

const stripGroup = (plugin: AnalysisPanelPlugin): AnalysisPanelGroup | undefined =>
  plugin.group === 'tracks' ? 'view' : plugin.group;

export interface GroupedPlugins {
  group: AnalysisPanelGroup | 'other';
  label: string;
  plugins: AnalysisPanelPlugin[];
}

export function getGroupedAnalysisPanels(): GroupedPlugins[] {
  // The server marks public pages before any script runs (see utils/publicMode).
  const publicServer = isPublicServerPage();
  // A Preview feature's panel has no launcher (rail, strip, palette) while previews are off; a session's stays open.
  const all = getAllAnalysisPanels().filter(p => !(publicServer && p.hostOnly) && !previewHidden(p.preview));
  const groups: GroupedPlugins[] = [];
  for (const g of GROUP_ORDER) {
    const plugins = all
      .map((plugin, index) => ({ plugin, index }))
      .filter(({ plugin }) => stripGroup(plugin) === g)
      .sort((a, b) => (a.plugin.stripOrder ?? 1e6) - (b.plugin.stripOrder ?? 1e6) || a.index - b.index)
      .map(({ plugin }) => plugin);
    if (plugins.length > 0) groups.push({ group: g, label: GROUP_LABELS[g], plugins });
  }
  const ungrouped = all.filter(p => !p.group);
  if (ungrouped.length > 0) groups.push({ group: 'other', label: 'Other', plugins: ungrouped });
  return groups;
}
