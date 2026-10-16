/**
 * The settings sidebar's live filter (its search field): which sections,
 * subsections and settings match, by the same matching as the command palette
 * (utils/search/fuzzy) over the same settings (utils/settingsRegistry).
 */
import { createContext, useContext } from 'react';
import { matchScore } from '../../../utils/search/fuzzy';
import { rankItems } from '../../../utils/search/fuzzy';
import { allSettings } from '../../../utils/settingsRegistry';
import { SIDEBAR_SECTIONS, SIDEBAR_SUBSECTIONS, settingPath, type SettingDef } from '../../../utils/settingsCatalog';

export interface SettingsFilter {
  /** A query is typed: only what matches is shown. */
  active: boolean;
  query: string;
  /** Matching settings, best first (in the sidebar or elsewhere). */
  matches: SettingDef[];
  /** Sidebar setting ids to show (the rest are hidden). */
  shownIds: Set<string>;
  sections: Set<string>;
  subsections: Set<string>;
}

export const INACTIVE_FILTER: SettingsFilter = {
  active: false, query: '', matches: [], shownIds: new Set(), sections: new Set(), subsections: new Set(),
};

export const SettingsFilterContext = createContext<SettingsFilter>(INACTIVE_FILTER);

export const useSettingsFilter = () => useContext(SettingsFilterContext);

export function settingFields(setting: SettingDef) {
  return { title: setting.label, keywords: setting.keywords, context: settingPath(setting) };
}

/**
 * What a query shows: a setting that matches; every setting of a subsection or
 * section whose name matches; and the subsections and sections they are in.
 */
export function computeSettingsFilter(query: string, settings: readonly SettingDef[] = allSettings()): SettingsFilter {
  if (!query.trim()) return INACTIVE_FILTER;
  const matches = rankItems(query, settings, settingFields).map(r => r.item);
  const sections = new Set<string>();
  const subsections = new Set<string>();
  const shownIds = new Set<string>();

  const sectionHit = new Set(Object.entries(SIDEBAR_SECTIONS)
    .filter(([, s]) => matchScore(query, { title: s.label }) > 0).map(([id]) => id));
  const subsectionHit = new Set(Object.entries(SIDEBAR_SUBSECTIONS)
    .filter(([, s]) => sectionHit.has(s.section) || matchScore(query, { title: s.label }) > 0).map(([id]) => id));
  for (const id of subsectionHit) {
    subsections.add(id);
    sections.add(SIDEBAR_SUBSECTIONS[id].section);
  }
  for (const id of sectionHit) sections.add(id);

  const matched = new Set(matches.map(s => s.id));
  for (const setting of settings) {
    const where = setting.location;
    if (where.kind !== 'sidebar') continue;
    const inHit = sectionHit.has(where.section) || (where.subsection ? subsectionHit.has(where.subsection) : false);
    if (!matched.has(setting.id) && !inHit) continue;
    shownIds.add(setting.id);
    sections.add(where.section);
    if (where.subsection) subsections.add(where.subsection);
  }
  return { active: true, query, matches, shownIds, sections, subsections };
}

/** CSS that hides the sidebar's settings that don't match and tints the ones that do. */
export function settingsFilterCss(filter: SettingsFilter, settings: readonly SettingDef[] = allSettings()): string {
  if (!filter.active) return '';
  const rules: string[] = [];
  const sel = (id: string) => `.fb-sidebar [data-setting-id="${id.replace(/["\\]/g, '\\$&')}"]`;
  const hidden = settings.filter(s => s.location.kind === 'sidebar' && !filter.shownIds.has(s.id)).map(s => sel(s.id));
  if (hidden.length) rules.push(`${hidden.join(',\n')} { display: none !important; }`);
  // A block of settings under its own heading: hidden when none of its settings is shown.
  const shown = [...filter.shownIds].map(id => `:not([data-setting-group~="${id.replace(/["\\]/g, '\\$&')}"])`).join('');
  rules.push(`.fb-sidebar [data-setting-group]${shown} { display: none !important; }`);
  const hits = filter.matches.filter(s => s.location.kind === 'sidebar').map(s => sel(s.id));
  if (hits.length) rules.push(`${hits.join(',\n')} { background-color: rgb(var(--fb-brand-500) / 0.08); border-radius: 4px; }`);
  return rules.join('\n');
}
