/**
 * Several sources in one profile plot (Metaprofile): one line per source per group.
 *
 * - Sources: every layer the Layers toolbar lists (custom MA-tag groups included), All footprints, m6A, and the
 *   feature families with per-read states in the plot's view (Find classes' footprint classes, NFR runs' variants and
 *   regions: hub/familySources.ts, Quantify a window's registry ids). A family's line is the share of the reads scored
 *   on it that are members, over the family's span (its per-read state is member or not; there is no per-base extent).
 * - Groups: each source is accumulated on its own (the same fetched reads, so the lines are comparable and the
 *   bootstrap units pair), then the groups are combined base group × source, base-major. A combined group carries its
 *   `source` and its `base` group as fields; its id is `<source>::<base id>` only to stay unique (nothing parses it).
 * - One source keeps everything as before: ids, titles, colours, request keys (old cards and sessions seed).
 * - Colour is the source's layer colour (getLayerColor: Labels › Layer colours overrides apply) when there are several
 *   sources; dash stays with what it meant (size bands, the state at the anchor, BED datasets), and groups go to panels.
 */
import { getLayerColor } from '../../utils/layerColors';
import { ALL_FOOTPRINTS } from '../../utils/footprintSizeSettings';
import { sourceLabel } from './plotModel';
import type { ProfileGroup } from './useProfileData';

/** The colour of a source's lines (the resolver: user colours apply). */
export function sourceColor(src: string): string {
  return getLayerColor(src === ALL_FOOTPRINTS ? 'all_footprints' : src);
}

/** A combined group's id (unique; never parsed: use the fields). */
export const combinedId = (src: string, baseId: string): string => `${src}::${baseId}`;

/** Combine per-source groups into base group × source (base-major, sources in chip order). One source: as given. */
export function combineSourceGroups(bySource: Array<{ source: string; groups: ProfileGroup[] }>, labels?: Record<string, string>): ProfileGroup[] {
  if (bySource.length === 1) return bySource[0].groups;
  const order: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  for (const { groups } of bySource) for (const g of groups) if (!seen.has(g.id)) { seen.add(g.id); order.push({ id: g.id, title: g.title }); }
  const out: ProfileGroup[] = [];
  for (const base of order) {
    for (const { source, groups } of bySource) {
      const g = groups.find(x => x.id === base.id);
      if (!g) continue;
      out.push({ ...g, id: combinedId(source, g.id), title: `${g.title} · ${sourceLabel(source, labels)}`, color: sourceColor(source),
        source, base: g.id, baseTitle: g.title });
    }
  }
  return out;
}

/** Whether these groups are several sources' (combined): combineSourceGroups tags groups with a source only when several
 *  were asked for, so one source with reads among several is still drawn as sources (its colour, its legend). */
export const isMultiSourceGroups = (groups: Array<{ source?: string }>): boolean => groups.some(g => Boolean(g.source));

/** The base groups (one per group, in order) of combined groups; the groups themselves otherwise. */
export function baseGroupsOf<T extends { id: string; title: string; base?: string; baseTitle?: string }>(groups: T[]): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const id = g.base ?? g.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: g.baseTitle ?? g.title });
  }
  return out;
}

/** The sources of combined groups, in order. */
export function sourcesOfGroups(groups: Array<{ source?: string }>): string[] {
  return [...new Set(groups.map(g => g.source).filter((s): s is string => !!s))];
}
