/**
 * Settings metadata for the command palette and the settings search: each
 * setting's label, the words people search for it by, where it lives, and,
 * for an on/off setting, how to read and flip it.
 *
 * Each settings component defines its settings next to its controls
 * (`defineSettings` in the same file) and tags the control with
 * `{...settingAnchor(SETTING)}`, so the palette can open the sidebar at it and
 * highlight it. utils/settingsRegistry gathers them; its test fails when a
 * control in the settings sidebar has no setting (no label to find it by).
 */
import { useBrowserStore } from '../stores/browserStore';

type BrowserState = ReturnType<typeof useBrowserStore.getState>;

/** The settings sidebar's sections (components/controls/Sidebar). */
export const SIDEBAR_SECTIONS = {
  file: {
    label: 'Data & Sessions',
    description: 'Load local or remote data, manage panels, and save or export sessions.',
  },
  genome: {
    label: 'Reference & Tracks',
    description: 'Load reference FASTA/GTF files and browse genome or track resources.',
  },
  view: {
    label: 'Reads & Display',
    description: 'Control read rendering, navigation, display limits, and read filters.',
  },
  analysis: {
    label: 'Analysis & Reproducibility',
    description: 'Set reproducible analysis sampling, peak behavior, specialized analysis tools, and which FiberHMM runs and the update check.',
  },
} as const;

export type SidebarSectionId = keyof typeof SIDEBAR_SECTIONS;

/**
 * The sidebar's subsections (SidebarSubSection id → its label and section).
 * settingsRegistry.test checks these labels against the components.
 */
export const SIDEBAR_SUBSECTIONS: Record<string, { label: string; section: SidebarSectionId }> = {
  'file.loadpath': { label: 'Load by path', section: 'file' },
  'file.remote': { label: 'Load Remote URL', section: 'file' },
  'file.cluster': { label: 'Connect to cluster', section: 'file' },
  'file.library': { label: 'Library', section: 'file' },
  'file.dafrun': { label: 'DAF-seq runs', section: 'file' },
  'file.panels': { label: 'Loaded Datasets', section: 'file' },
  'file.session': { label: 'Session', section: 'file' },
  'genome.reference': { label: 'Reference Files', section: 'genome' },
  'genome.online': { label: 'Online Genome & Tracks', section: 'genome' },
  'view.display': { label: 'Read Display', section: 'view' },
  'view.navigation': { label: 'Navigation', section: 'view' },
  'view.advanced': { label: 'Read Filters', section: 'view' },
  'analysis.reproducibility': { label: 'Reproducibility', section: 'analysis' },
  'analysis.peaks': { label: 'Peak Detection', section: 'analysis' },
  'analysis.app': { label: 'FiberHMM & Updates', section: 'analysis' },
};

/** Where a setting's control is. */
export type SettingLocation =
  /** In the settings sidebar: its section and (usually) subsection. */
  | { kind: 'sidebar'; section: SidebarSectionId; subsection?: string }
  /** In a group of the read toolbar (ToolbarGroups): the group is opened, `selector` highlighted. */
  | { kind: 'toolbar'; group: string; groupLabel: string; selector: string }
  /** Elsewhere in the window chrome (the side rail, the top bar's More menu); `selector` when it is on show. */
  | { kind: 'chrome'; place: string; selector?: string };

export interface SettingToggle {
  get: () => boolean;
  set: (on: boolean) => void;
}

export interface SettingDef {
  /** Stable id, also the control's data-setting-id ("view.hide-terminal-gaps"). */
  id: string;
  /** As the control says it. */
  label: string;
  /** Other words people search for it by (synonyms, what it affects). */
  keywords?: readonly string[];
  location: SettingLocation;
  /** On/off settings: the palette offers to flip it directly. */
  toggle?: SettingToggle;
  /** Why the control isn't on show right now (e.g. "with a BAM loaded"); null when it is. */
  hiddenReason?: () => string | null;
}

/** Define a component's settings, keyed by a short name for its JSX. */
export function defineSettings<K extends string>(settings: Record<K, SettingDef>): Record<K, SettingDef> {
  return settings;
}

/** The attributes that tag a setting's control (palette highlight, settings search filter). */
export function settingAnchor(setting: SettingDef): { 'data-setting-id': string } {
  return { 'data-setting-id': setting.id };
}

/**
 * The attributes of a block holding several settings under a heading of its own
 * ("CIGAR Display", "Read separators"): the settings search hides the block
 * when none of them matches.
 */
export function settingGroupAnchor(...settings: SettingDef[]): { 'data-setting-group': string } {
  return { 'data-setting-group': settings.map(s => s.id).join(' ') };
}

type BooleanKey = { [K in keyof BrowserState]: BrowserState[K] extends boolean ? K : never }[keyof BrowserState];
type SetterKey = { [K in keyof BrowserState]: BrowserState[K] extends (value: boolean) => void ? K : never }[keyof BrowserState];

/** An on/off setting kept in the browser store: its value and its setter. */
export function storeToggle(key: BooleanKey, setter: SetterKey): SettingToggle {
  return {
    get: () => Boolean(useBrowserStore.getState()[key]),
    set: on => (useBrowserStore.getState()[setter] as (value: boolean) => void)(on),
  };
}

/** "Reads & Display › Read Filters", "Toolbar › Reads", ... */
export function settingPath(setting: SettingDef): string {
  const where = setting.location;
  if (where.kind === 'sidebar') {
    const section = SIDEBAR_SECTIONS[where.section].label;
    const sub = where.subsection ? SIDEBAR_SUBSECTIONS[where.subsection]?.label : undefined;
    return sub ? `${section} › ${sub}` : section;
  }
  if (where.kind === 'toolbar') return `Toolbar › ${where.groupLabel}`;
  return where.place;
}

/** A sidebar location helper: `inSidebar('view.advanced')`. */
export function inSidebar(subsection: string): SettingLocation {
  const sub = SIDEBAR_SUBSECTIONS[subsection];
  if (!sub) throw new Error(`Unknown sidebar subsection ${subsection}`);
  return { kind: 'sidebar', section: sub.section, subsection };
}
