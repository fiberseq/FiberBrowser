/**
 * The command palette finds everything the menu bar, the toolbar and the
 * settings can do, by the words people use.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { ensureBuiltinPanelsRegistered } from '../stores/__tests__/helpers';
import { APP_COMMANDS, APP_COMMAND_INFO, COMPONENT_COMMANDS, registerAppCommand, type AppCommandName } from './appCommands';
import { KEYBOARD_SHORTCUTS } from './shortcuts';
import { buildPaletteItems, gotoItems, paletteSections, toggleItem, type PaletteItem } from './commandPaletteItems';
import { allSettings, findSetting } from './settingsRegistry';
import { getGroupedAnalysisPanels } from '../plugins/registry';

const MENU_PY = path.resolve(__dirname, '../../../../fiberbrowser/app_menu.py');

/** The menu bar's page commands: `_cmd("Title…", "name", …)` in fiberbrowser/app_menu.py. */
function menuCommands(): Array<{ title: string; name: string }> {
  const source = readFileSync(MENU_PY, 'utf8');
  return [...source.matchAll(/_cmd\("([^"]+)",\s*"([a-z0-9-]+)"/g)].map(m => ({ title: m[1], name: m[2] }));
}

const results = (query: string, items: PaletteItem[], recent: string[] = []) =>
  paletteSections(query, items, recent).flatMap(section => section.items);
const rankOf = (query: string, id: string, items: PaletteItem[]) => results(query, items).findIndex(item => item.id === id);

describe('command palette registry', () => {
  const initial = useBrowserStore.getState();
  const unregister: Array<() => void> = [];

  beforeAll(() => ensureBuiltinPanelsRegistered());
  beforeEach(() => {
    // Components register these while mounted (NavBar, Browser, ClusterPanel).
    for (const name of COMPONENT_COMMANDS) unregister.push(registerAppCommand(name, () => true));
    useBrowserStore.setState({ publicMode: false });
  });
  afterEach(() => {
    while (unregister.length) unregister.pop()!();
    useBrowserStore.setState(initial, true);
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('every menu-bar command is findable by its menu title', () => {
    const items = buildPaletteItems();
    const commands = menuCommands();
    expect(commands.length).toBeGreaterThan(20);
    for (const { title, name } of commands) {
      if (name === 'command-palette') continue;  // the palette itself
      expect(APP_COMMAND_INFO[name as AppCommandName], name).toBeTruthy();
      const query = title.replace(/…$/, '');
      const rank = rankOf(query, `cmd:${name}`, items);
      expect(rank, `"${query}" finds ${name}`).toBeGreaterThanOrEqual(0);
      expect(rank, `"${query}" ranks ${name} near the top`).toBeLessThan(5);
    }
  });

  it('every command the palette may list has a label; internal ones are left out', () => {
    // Give selection, group and highlight commands something to act on.
    useBrowserStore.setState({ peakRules: [{ ...initial.peakRules[0], id: 'group', source: 'matched' }], selectedPeaks: new Set(['p1']), highlights: [{ id: 'h', genome: 'hg38', chrom: 'chr1', start: 1, end: 2, color: '#fde047' }] } as never);
    const internal = APP_COMMANDS.filter(name => APP_COMMAND_INFO[name] === null);
    expect(internal.sort()).toEqual(['command-palette', 'locus', 'native-drop']);
    const items = buildPaletteItems();
    for (const name of APP_COMMANDS) {
      const listed = items.some(item => item.id === `cmd:${name}`);
      expect(listed, name).toBe(APP_COMMAND_INFO[name] !== null);
    }
  });

  it('the toolbar actions are commands too', () => {
    const items = buildPaletteItems();
    for (const [query, id] of [
      ['scan peaks', 'cmd:scan-peaks'], ['cluster', 'cmd:cluster-reads'], ['sort reads', 'cmd:sort-reads'],
      ['filter reads', 'cmd:filter-reads'], ['reset view', 'cmd:reset-view'], ['undo', 'cmd:undo'],
      ['redo', 'cmd:redo'], ['navigation', 'cmd:toggle-navigation-mode'], ['theme', 'cmd:appearance-dark'],
      ['ui size', 'cmd:ui-size-larger'], ['export', 'cmd:export-figure'], ['open file', 'cmd:open-file'],
      ['save', 'cmd:save-session'], ['highlight view', 'cmd:highlight-view'], ['highlight ruler', 'cmd:toggle-highlight-mode'],
      ['next region', 'cmd:next-region'], ['previous region', 'cmd:previous-region'], ['amplicon', 'cmd:next-region'],
    ] as const) {
      expect(rankOf(query, id, items), `${query} → ${id}`).toBeGreaterThanOrEqual(0);
      expect(rankOf(query, id, items), `${query} → ${id}`).toBeLessThan(6);
    }
  });

  it('commands show their keyboard shortcuts', () => {
    const items = buildPaletteItems();
    const byId = new Map(items.map(item => [item.id, item]));
    expect(byId.get('cmd:reset-view')?.shortcut).toBe('R');
    expect(byId.get('cmd:scan-peaks')?.shortcut).toBe('S');
    expect(byId.get('cmd:toggle-genome-map')?.shortcut).toBe('G');
    expect(byId.get('cmd:next-region')?.shortcut).toBe('N');
    expect(byId.get('cmd:previous-region')?.shortcut).toBe('P');
    expect(byId.get('cmd:undo')?.shortcut).toMatch(/\+Z$/);
    // Every command a shortcut names exists.
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      for (const name of Object.keys(shortcut.commands ?? {})) expect(APP_COMMANDS, name).toContain(name);
    }
    // Shortcuts that run no command are listed as shortcuts.
    expect(items.some(item => item.kind === 'shortcut' && /Pan left/.test(item.title))).toBe(true);
  });

  it('every analysis panel can be opened', () => {
    const items = buildPaletteItems();
    const panels = getGroupedAnalysisPanels().flatMap(group => group.plugins);
    expect(panels.length).toBeGreaterThan(8);
    for (const plugin of panels) {
      expect(rankOf(plugin.label, `panel:${plugin.contentType}`, items), plugin.label).toBeGreaterThanOrEqual(0);
    }
    const footprints = items.find(item => item.id === 'panel:footprint-analysis')!;
    footprints.run();
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'footprint-analysis' && !p.collapsed)).toBe(true);
  });

  it('every setting is findable by its label', () => {
    const items = buildPaletteItems();
    for (const setting of allSettings()) {
      const rank = rankOf(setting.label, `setting:${setting.id}`, items);
      expect(rank, setting.label).toBeGreaterThanOrEqual(0);
      expect(rank, setting.label).toBeLessThan(4);
    }
  });

  it.each([
    ['row height', 'setting:toolbar.row-height'],
    ['terminal gaps', 'setting:view.hide-terminal-gaps'],
    ['terminal', 'setting:view.hide-terminal-gaps'],
    ['read-end footprints', 'setting:view.hide-short-end-footprints'],
    ['dark mode', 'setting:chrome.dark-mode'],
    ['edges', 'setting:toolbar.footprint-edges'],
    ['duplicates', 'setting:view.show-duplicate-reads'],
    ['seed', 'setting:analysis.seed'],
    ['ui size', 'setting:view.ui-size'],
  ])('"%s" finds %s near the top', (query, id) => {
    const rank = rankOf(query, id, buildPaletteItems());
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(4);
  });

  it('an on/off setting is followed by its Turn on/off item, which flips it', () => {
    useBrowserStore.setState({ hideTerminalGaps: false });
    const list = results('terminal gaps', buildPaletteItems());
    const at = list.findIndex(item => item.id === 'setting:view.hide-terminal-gaps');
    expect(list[at + 1]?.id).toBe('toggle:view.hide-terminal-gaps');
    expect(list[at + 1].title).toBe('Turn on: Hide terminal gaps');
    expect(list[at + 1].keepOpen).toBe(true);
    list[at + 1].run();
    expect(useBrowserStore.getState().hideTerminalGaps).toBe(true);
    expect(toggleItem(findSetting('view.hide-terminal-gaps')!)!.title).toBe('Turn off: Hide terminal gaps');
  });

  it('recent picks come first, before anything is typed and among matches', () => {
    const items = buildPaletteItems();
    const empty = paletteSections('', items, ['setting:view.fill-gaps', 'cmd:undo']);
    expect(empty[0].label).toBe('Recent');
    expect(empty[0].items.map(item => item.id)).toEqual(['setting:view.fill-gaps', 'cmd:undo']);
    expect(empty[1].label).toBe('Suggested');
    // Two equally good matches: the recently picked one goes first.
    const twin = (id: string): PaletteItem => ({ id, kind: 'action', title: 'Alpha thing', tag: 'Action', run: () => {} });
    const pair = [twin('cmd:a'), twin('cmd:b')];
    expect(results('alpha', pair).map(item => item.id)).toEqual(['cmd:a', 'cmd:b']);
    expect(results('alpha', pair, ['cmd:b']).map(item => item.id)).toEqual(['cmd:b', 'cmd:a']);
  });

  it('hides commands that cannot run here (public server)', () => {
    useBrowserStore.setState({ publicMode: true });
    const ids = buildPaletteItems().map(item => item.id);
    expect(ids).not.toContain('cmd:open-file');
    expect(ids).not.toContain('cmd:library');
    expect(ids).toContain('cmd:undo');
  });

  it('puts a strong Go to first and weak ones last', () => {
    const run = vi.fn();
    const provider = { id: 'gene', kind: 'gene', label: 'Genes', search: () => [] };
    const goto = gotoItems([{
      provider,
      suggestions: [
        { id: 'NAPA', kind: 'gene', label: 'NAPA', score: 900, run },
        { id: 'NAPB', kind: 'gene', label: 'NAPB', score: 150, run },
      ],
    }]);
    const list = paletteSections('napa', buildPaletteItems(), [], goto).flatMap(s => s.items);
    expect(list[0].id).toBe('goto:gene:NAPA');
    expect(list[0].tag).toBe('Gene');
    expect(list[0].title).toBe('Go to NAPA');
    expect(list[list.length - 1].id).toBe('goto:gene:NAPB');
  });

  it('strong Go to hits are ordered by score across providers (an exact gene before a region of that name)', () => {
    const run = vi.fn();
    const regions = gotoItems([{
      provider: { id: 'regions', kind: 'region', label: 'Regions', search: () => [] },
      suggestions: [{ id: 'r', kind: 'region', label: 'NAPA', score: 700, run }],
    }]);
    const genes = gotoItems([{
      provider: { id: 'gene', kind: 'gene', label: 'Genes', search: () => [] },
      suggestions: [{ id: 'NAPA', kind: 'gene', label: 'NAPA', score: 900, run }],
    }]);
    const list = paletteSections('napa', buildPaletteItems(), [], [...regions, ...genes]).flatMap(s => s.items);
    expect(list.slice(0, 2).map(item => [item.id, item.tag])).toEqual([['goto:gene:NAPA', 'Gene'], ['goto:regions:r', 'Region']]);
  });

  it('the Highlight group is findable; commands with nothing to act on are left out (fb-r4-regions)', () => {
    // Peaks selected and a highlight drawn: every highlight command is offered.
    useBrowserStore.setState({ selectedPeaks: new Set(['p1']), highlights: [{ id: 'h', genome: 'hg38', chrom: 'chr1', start: 1, end: 2, color: '#fde047' }] } as never);
    const items = buildPaletteItems();
    for (const [query, id] of [
      ['highlight selected peaks', 'cmd:highlight-peaks'], ['clear highlights', 'cmd:clear-highlights'],
    ] as const) {
      expect(rankOf(query, id, items), `${query} → ${id}`).toBeGreaterThanOrEqual(0);
      expect(rankOf(query, id, items), `${query} → ${id}`).toBeLessThan(6);
    }
    // Nothing to act on: left out.
    useBrowserStore.setState({ selectedPeaks: new Set(), highlights: [] } as never);
    const none = buildPaletteItems().map(item => item.id);
    expect(none).not.toContain('cmd:highlight-peaks');
    expect(none).not.toContain('cmd:clear-highlights');
  });
});

describe('palette ranking and analysis commands (fb-n3-search)', () => {
  const initial = useBrowserStore.getState();
  const unregister: Array<() => void> = [];
  beforeAll(() => ensureBuiltinPanelsRegistered());
  beforeEach(() => {
    for (const name of COMPONENT_COMMANDS) unregister.push(registerAppCommand(name, () => true));
    useBrowserStore.setState({ publicMode: false, datasets: [{ id: 'ds1', label: 'x' }] as never } as never);
  });
  afterEach(() => {
    while (unregister.length) unregister.pop()!();
    useBrowserStore.setState(initial, true);
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('"eve": the gene first, and commands found only inside other words are cut (M7)', () => {
    const run = vi.fn();
    const goto = gotoItems([{
      provider: { id: 'gene', kind: 'gene', label: 'Genes', search: () => [] },
      suggestions: [{ id: 'eve', kind: 'gene', label: 'eve', score: 900, run }],
    }]);
    const list = paletteSections('eve', buildPaletteItems(), [], goto).flatMap(s => s.items);
    expect(list[0].id).toBe('goto:gene:eve');
    // Undo ("revert"), the read-name shortcut ("several"): weak matches, left out when a real answer exists.
    expect(list.map(i => i.id)).not.toContain('cmd:undo');
    expect(list.some(i => /Paste a read name/.test(i.title))).toBe(false);
    for (const item of list.filter(i => i.kind !== 'goto')) {
      const words = `${item.title} ${(item.keywords ?? []).join(' ')} ${item.detail ?? ''} ${item.tag}`.toLowerCase().split(/[^a-z0-9]+/);
      expect(words.some(w => w.startsWith('eve')), item.title).toBe(true);
    }
  });

  it('with nothing better, weak matches are still offered (a typo still finds something)', () => {
    const list = results('shortcts', buildPaletteItems());
    expect(list.map(i => i.id)).toContain('cmd:keyboard-shortcuts');
  });

  it('a prefix of a word beats a match inside another word', () => {
    const items = buildPaletteItems();
    expect(rankOf('zoom', 'cmd:zoom-in', items)).toBeLessThan(3);
    expect(rankOf('undo', 'cmd:undo', items)).toBe(0);
  });

  it.each([
    ['proj', 'cmd:open-projection'],
    ['t-sne', 'cmd:open-projection'],
    ['tsne', 'cmd:open-projection'],
    ['footprint classes', 'cmd:find-classes'],
    ['find classes', 'cmd:find-classes'],
    ['find classes in this view', 'cmd:find-classes-view'],
    ['neighbourhoods', 'cmd:cluster-neighbourhoods'],
    ['sort by projection', 'cmd:sort-by-projection'],
    ['export projection', 'cmd:export-projection-table'],
    ['scan peaks', 'cmd:scan-peaks'],
    ['co-occupancy', 'cmd:co-occupancy'],
  ])('"%s" finds the analysis %s near the top', (query, id) => {
    const items = buildPaletteItems();
    const rank = rankOf(query, id, items);
    expect(rank, `${query} → ${id}: ${results(query, items).slice(0, 5).map(i => i.id).join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
  });

  it('analyses that need clusters are listed with why, and run once there are clusters', () => {
    const before = buildPaletteItems();
    const projection = before.find(i => i.id === 'cmd:open-projection')!;
    expect(projection.disabledReason).toMatch(/Cluster reads first/);
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 0 } } } as never);
    const after = buildPaletteItems().find(i => i.id === 'cmd:open-projection')!;
    expect(after.disabledReason).toBeUndefined();
  });

  it('Cluster with Neighbourhoods runs the Cluster button with that method; Sort by projection the Sort option', async () => {
    const { runAppCommand } = await import('./appCommands');
    const cluster = vi.fn(() => true);
    const sort = vi.fn((_args?: unknown) => true);
    while (unregister.length) unregister.pop()!();
    unregister.push(registerAppCommand('cluster-reads', cluster), registerAppCommand('sort-reads', sort));
    useBrowserStore.setState({ clusterMethod: 'kmeans' } as never);
    expect(runAppCommand('cluster-neighbourhoods')).toBe(true);
    expect(cluster).toHaveBeenCalled();
    expect(useBrowserStore.getState().clusterMethod).toBe('graph');
    // Nothing to cluster (the button would be disabled): the method is left as it was.
    unregister.pop()!(); unregister.pop()!();
    unregister.push(registerAppCommand('cluster-reads', () => false));
    useBrowserStore.setState({ clusterMethod: 'kmeans' } as never);
    expect(runAppCommand('cluster-neighbourhoods')).toBe(false);
    expect(useBrowserStore.getState().clusterMethod).toBe('kmeans');
    unregister.push(registerAppCommand('sort-reads', sort));
    expect(runAppCommand('sort-by-projection')).toBe(false);  // no clusters yet
    useBrowserStore.setState({ clusterAssignments: { ds1: { r1: 0 } } } as never);
    expect(runAppCommand('sort-by-projection')).toBe(true);
    expect(sort).toHaveBeenCalledWith({ by: 'projection' });
  });
});
