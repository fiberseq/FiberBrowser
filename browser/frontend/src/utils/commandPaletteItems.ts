/**
 * What the command palette lists, built from the app's own definitions (one
 * registry, no hand-kept copy):
 *
 * - actions: the command bus (utils/appCommands: APP_COMMANDS and their
 *   APP_COMMAND_INFO), with each command's keys from utils/shortcuts;
 * - panels: the analysis panel registry (plugins/registry);
 * - settings: utils/settingsRegistry (each setting defined next to its control);
 *   on/off settings also get a "Turn on / Turn off" item;
 * - keyboard shortcuts that run no command (pan, cluster focus, ...);
 * - "Go to …": the search providers (utils/search/providers: coordinates,
 *   genes, saved regions, read names; the locus boxes ask the same ones).
 */
import { APP_COMMANDS, APP_COMMAND_INFO, hasAppCommand, runAppCommand, type AppCommandName } from './appCommands';
import { KEYBOARD_SHORTCUTS, shortcutForCommand } from './shortcuts';
import { allSettings } from './settingsRegistry';
import { settingPath, type SettingDef } from './settingsCatalog';
import { getGroupedAnalysisPanels, findOpenAnalysisPanel } from '../plugins/registry';
import { useBrowserStore } from '../stores/browserStore';
import { rankItems, type MatchFields } from './search/fuzzy';
import { runFromPalette, SEARCH_SCORE, type SearchGroup } from './search/providers';
import type { NavigationTarget } from './search/navigationIntent';
import { revealSetting } from './revealSetting';

export type PaletteKind = 'goto' | 'action' | 'panel' | 'setting' | 'toggle' | 'shortcut';

export interface PaletteItem {
  /** Unique: 'cmd:undo', 'panel:footprint-analysis', 'setting:view.fill-gaps', 'toggle:view.fill-gaps', 'key:…', 'goto:gene:NAPA'. */
  id: string;
  kind: PaletteKind;
  title: string;
  /** Second line: where it lives, what it does, coordinates. */
  detail?: string;
  /** The small tag at the right: Action, Panel, Setting, Gene, ... */
  tag: string;
  keywords?: readonly string[];
  /** Keys that do the same, shown beside it. */
  shortcut?: string;
  /** Shown instead of running. */
  disabledReason?: string;
  /** The palette stays open after it runs (a flipped toggle shows its new state). */
  keepOpen?: boolean;
  /** For panels: the panel's colour (its landmark) and type. */
  color?: string;
  panelType?: string;
  /** For go-to items: the provider's kind ('locus', 'gene', 'region', 'read'). */
  gotoKind?: string;
  /** For go-to items: the view it moves (a panel's own, else the main view; a read: wherever it is). */
  navTarget?: NavigationTarget;
  /** For go-to items: the providers' score (SEARCH_SCORE). */
  score?: number;
  /** For settings and toggles: the setting. */
  setting?: SettingDef;
  run: () => unknown;
}

const GOTO_TAGS: Record<string, string> = { locus: 'Locus', gene: 'Gene', region: 'Region', category: 'Regions', read: 'Read' };

function commandItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const name of APP_COMMANDS) {
    const info = APP_COMMAND_INFO[name];
    if (!info || !hasAppCommand(name)) continue;
    if (info.available && !info.available()) continue;
    const blocked = info.disabledReason?.() ?? null;
    items.push({
      id: `cmd:${name}`,
      kind: 'action',
      title: info.label,
      detail: info.detail,
      tag: 'Action',
      keywords: info.keywords,
      shortcut: shortcutForCommand(name as AppCommandName),
      ...(blocked ? { disabledReason: blocked } : {}),
      run: () => runAppCommand(name),
    });
  }
  return items;
}

function panelItems(): PaletteItem[] {
  const panels = useBrowserStore.getState().panels;
  return getGroupedAnalysisPanels().flatMap(group => group.plugins.map(plugin => {
    const open = Boolean(findOpenAnalysisPanel(panels, plugin.contentType));
    return {
      id: `panel:${plugin.contentType}`,
      kind: 'panel' as const,
      title: `${plugin.label} panel`,
      detail: `${open ? 'Open: show it' : 'Open it'}${plugin.description ? ` · ${plugin.description}` : ''}`,
      tag: plugin.preview ? 'Panel · Preview' : 'Panel',
      keywords: [plugin.shortLabel ?? '', plugin.contentType.replace(/-/g, ' '), group.label, plugin.description ?? ''].filter(Boolean),
      color: plugin.headerColor,
      panelType: plugin.contentType,
      run: () => useBrowserStore.getState().openAnalysisPanel(plugin.contentType as never),
    };
  }));
}

function settingItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const setting of allSettings()) {
    const path = settingPath(setting);
    const hidden = setting.hiddenReason?.() ?? null;
    items.push({
      id: `setting:${setting.id}`,
      kind: 'setting',
      title: setting.label,
      detail: hidden ? `${path} (${hidden})` : path,
      tag: setting.toggle ? (setting.toggle.get() ? 'Setting: on' : 'Setting: off') : 'Setting',
      keywords: setting.keywords,
      setting,
      run: () => revealSetting(setting),
    });
  }
  return items;
}

/** The "Turn on / Turn off" item of an on/off setting. */
export function toggleItem(setting: SettingDef): PaletteItem | null {
  if (!setting.toggle) return null;
  const on = setting.toggle.get();
  return {
    id: `toggle:${setting.id}`,
    kind: 'toggle',
    title: `Turn ${on ? 'off' : 'on'}: ${setting.label}`,
    detail: `${settingPath(setting)} · now ${on ? 'on' : 'off'}`,
    tag: on ? 'On' : 'Off',
    keywords: setting.keywords,
    keepOpen: true,
    setting,
    run: () => setting.toggle!.set(!on),
  };
}

function shortcutItems(showShortcuts: () => void): PaletteItem[] {
  return KEYBOARD_SHORTCUTS
    .filter(shortcut => !shortcut.commands)
    .map(shortcut => ({
      id: `key:${shortcut.key}:${shortcut.description}`,
      kind: 'shortcut' as const,
      title: shortcut.description,
      detail: `Keyboard shortcut · ${shortcut.category}`,
      tag: 'Shortcut',
      keywords: ['keyboard', 'key', shortcut.key],
      shortcut: shortcut.key,
      run: showShortcuts,
    }));
}

/** Everything the palette can find, now (commands registered by mounted components, panels registered by plugins). */
export function buildPaletteItems(showShortcuts: () => void = () => runAppCommand('keyboard-shortcuts')): PaletteItem[] {
  return [...commandItems(), ...panelItems(), ...settingItems(), ...shortcutItems(showShortcuts)];
}

/**
 * The search providers' suggestions as palette items. With several references
 * on screen, each says which ("Go to eve (dm6)"): it goes to that reference's panel.
 */
export function gotoItems(groups: readonly SearchGroup[]): PaletteItem[] {
  return groups.flatMap(group => group.suggestions.map((suggestion): PaletteItem => {
    const target = suggestion.runIn;
    return {
      id: `goto:${group.provider.id}:${suggestion.id}`,
      kind: 'goto' as const,
      title: `Go to ${suggestion.label}${suggestion.kind === 'category' ? ' (category)' : ''}${suggestion.referenceLabel ? ` (${suggestion.referenceLabel})` : ''}`,
      detail: suggestion.detail,
      tag: GOTO_TAGS[suggestion.kind] ?? group.provider.label,
      gotoKind: suggestion.kind,
      disabledReason: suggestion.disabledReason,
      score: suggestion.score,
      navTarget: target ? (target.panelId ? { panelId: target.panelId } : 'main') : undefined,
      // In that panel's (or the main) locus box: its progress, Cancel and outcome (a read search takes a while).
      run: () => runFromPalette(suggestion),
    };
  }));
}

/** A "Go to" this good is a real answer: commands that match the text only weakly are left out then. */
const GOOD_GOTO = 200;

const fieldsOf = (item: PaletteItem): MatchFields => ({
  title: item.title,
  keywords: item.keywords,
  context: item.kind === 'setting' || item.kind === 'toggle' ? `${item.detail ?? ''} setting settings` : `${item.tag} ${item.detail ?? ''}`,
});

/** Common actions, offered before anything is typed (after the recent picks). */
export const SUGGESTED_IDS = [
  'cmd:go-to-locus', 'cmd:open-file', 'cmd:scan-peaks', 'cmd:cluster-reads', 'cmd:export-figure',
  'cmd:settings', 'cmd:start-tour', 'cmd:keyboard-shortcuts',
];

export interface PaletteSection {
  label: string;
  items: PaletteItem[];
}

/**
 * The palette's list for a query: with nothing typed, the recent picks and some
 * common actions; else every match, best first (recent picks a little higher),
 * the strong "Go to" hits (a locus, the gene named so) first, each on/off
 * setting followed by its Turn on/off item.
 */
export function paletteSections(
  query: string,
  items: readonly PaletteItem[],
  recent: readonly string[],
  goto: readonly PaletteItem[] = [],
  limit = 60,
): PaletteSection[] {
  const byId = new Map(items.map(item => [item.id, item]));
  if (!query.trim()) {
    const recentItems = recent.map(id => byId.get(id)).filter((item): item is PaletteItem => Boolean(item)).slice(0, 6);
    const seen = new Set(recentItems.map(item => item.id));
    const suggested = SUGGESTED_IDS.map(id => byId.get(id)).filter((item): item is PaletteItem => Boolean(item) && !seen.has(item!.id));
    return [
      ...(recentItems.length ? [{ label: 'Recent', items: recentItems }] : []),
      ...(suggested.length ? [{ label: 'Suggested', items: suggested }] : []),
    ];
  }
  const recentBoost = (item: PaletteItem) => {
    const at = recent.indexOf(item.id);
    return at < 0 ? 0 : Math.max(10, 40 - at * 5);
  };
  const score = (item: PaletteItem) => item.score ?? 0;
  const rankedAll = rankItems(query, items, fieldsOf, recentBoost);
  // Weak matches ("eve" inside "revert", "several") only when nothing matches well:
  // a command, setting or panel named so, or a real place (a gene, a locus, a region).
  const goodGoto = goto.some(item => !item.disabledReason && score(item) >= GOOD_GOTO);
  const anyStrong = goodGoto || rankedAll.some(r => !r.weak);
  const ranked = rankedAll.filter(r => !anyStrong || !r.weak).map(r => r.item);
  const out: PaletteItem[] = [];
  for (const item of ranked) {
    out.push(item);
    if (item.kind === 'setting' && item.setting) {
      const flip = toggleItem(item.setting);
      if (flip) out.push(flip);
    }
  }
  // Best first across providers (an exact gene before a region of that name).
  const byScore = [...goto].sort((a, b) => score(b) - score(a));
  const strong = byScore.filter(item => score(item) >= SEARCH_SCORE.strong);
  const weak = byScore.filter(item => score(item) < SEARCH_SCORE.strong);
  const list = [...strong, ...out, ...weak].slice(0, limit);
  return list.length ? [{ label: 'Results', items: list }] : [];
}
