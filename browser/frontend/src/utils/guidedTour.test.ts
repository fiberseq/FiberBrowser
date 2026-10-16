import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prerequisitesFor, setToolbarGroupOpen, toolbarGroupInMore, tourOutline, tourSteps } from './guidedTour';
import { tutorialAnchorById } from './tutorialAnchors';
import { TOUR_CHECKED, TOUR_PANEL_STEPS, TOUR_SANDBOX_HIDDEN, TOUR_WALKED_TITLES } from '../../tests/e2e/fixtures/tourTitles';

const demo = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };
const sv = {
  id: 'sv', available: true, label: 'H1 insertion demo (Fiber-seq)', genome: 'hg38', dataset_id: null,
  region: { chrom: 'chr1', start: 23_273_500, end: 23_281_000 }, insertion: { chrom: 'chr1', ref: 23_277_272, len: 7_471 },
};

const SRC = resolve(__dirname, '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
/** What the UI renders: the components, plus the utils that build DOM (the popover, the tour bar). */
const SOURCE = [...sourceFiles(join(SRC, 'components')), ...sourceFiles(join(SRC, 'plugins')), ...sourceFiles(join(SRC, 'features')), ...sourceFiles(join(SRC, 'lab'))]
  .map(f => readFileSync(f, 'utf8')).join('\n');

/** `${prefix}${expr}${suffix}` template attribute values, e.g. `toolbar-group-${testId}`. */
const TEMPLATES = [...SOURCE.matchAll(/`([a-z0-9.-]*)\$\{[^}`]+\}([a-z0-9.-]*)`/g)]
  .map(m => ({ prefix: m[1], suffix: m[2] }))
  .filter(t => t.prefix || t.suffix);

const SOURCE_LOWER = SOURCE.toLowerCase();

/** Rendered literally, by a template with a literal middle, or (a `^=` selector) as the start of a literal. */
function rendered(value: string, prefixOnly = false): boolean {
  const quotes = ['"', "'", '`'];
  if (quotes.some(q => SOURCE.includes(prefixOnly ? `${q}${value}` : `${q}${value}${q}`))) return true;
  return TEMPLATES.some(({ prefix, suffix }) => {
    if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length <= prefix.length + suffix.length) return false;
    const middle = value.slice(prefix.length, value.length - suffix.length).toLowerCase();
    return SOURCE_LOWER.includes(`"${middle}"`) || SOURCE_LOWER.includes(`'${middle}'`);
  });
}

/** Attribute values a step's selectors (selector, click) name, worked out with a stand-in session. */
function selectorValues(step: ReturnType<typeof tourSteps>[number]): Array<[string, boolean]> {
  const session = { minimizedPanelId: 'p1', createdFootprintGroupIds: [], panelId: 'p1' } as never;
  const selectors = [
    typeof step.selector === 'function' ? step.selector(session) : step.selector,
    step.click,
  ].filter((s): s is string => Boolean(s));
  return selectors.flatMap(s => [...s.matchAll(/\[([a-z-]+)([\^$*]?)="([^"$]+)"\]/g)]
    // Ids filled in at run time (a panel, a saved group) aren't in the source.
    .filter(m => !['data-panel-id', 'data-saved-group-id', 'data-panel-restore-id'].includes(m[1]))
    .map(m => [m[3], m[2] === '^'] as [string, boolean]));
}

describe('guided tour steps', () => {
  it('have unique ids, and the same ids with or without the demo', () => {
    const ids = tourOutline().map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tourSteps(demo as never, false).map(s => s.id)).toEqual(ids);
    expect(tourSteps(demo as never, true).map(s => s.id)).toEqual(ids);
  });

  // tour.spec.ts only sees titles: a renamed step ("Projection" -> "The read map")
  // failed the e2e walk minutes in, on a list that read as the class steps being skipped.
  it('still have every title the e2e walk keys on', () => {
    const titles = new Set(tourSteps(demo as never, false).map(s => s.title));
    const keyed = [...TOUR_WALKED_TITLES, ...TOUR_PANEL_STEPS, ...TOUR_SANDBOX_HIDDEN, ...Object.values(TOUR_CHECKED)];
    expect(keyed.filter(t => !titles.has(t))).toEqual([]);
  });

  it('keep each section together, and end with the final choice', () => {
    const steps = tourSteps(null, false);
    const seen = new Set<string>();
    let previous = '';
    for (const step of steps) {
      if (step.section !== previous) {
        expect(seen.has(step.section)).toBe(false);
        seen.add(step.section);
        previous = step.section;
      }
    }
    expect(steps[steps.length - 1].final).toBe(true);
    expect(steps.filter(s => s.final)).toHaveLength(1);
  });

  it('replay what later steps need: the demo, peaks, clusters and a saved footprint', () => {
    const steps = tourSteps(demo as never, false);
    expect(steps.filter(s => s.prereq === true).map(s => s.id))
      .toEqual(['welcome', 'peaks', 'select-peaks', 'clustering', 'cmd-click', 'save-footprint']);
  });

  it('replay the footprint classes (a minute of work) only for the steps of their own section', () => {
    const steps = tourSteps(demo as never, false);
    expect(steps.filter(s => s.prereq === 'section').map(s => s.id)).toEqual([
      'footprint-classes', 'save-class',
      'sv-demo', 'variants-panel', 'snp-table', 'split-by-haplotype', 'insert-expanded',
    ]);
    const before = (id: string) => steps.slice(0, steps.findIndex(s => s.id === id));
    const replayed = (id: string) => prerequisitesFor(before(id), steps.find(s => s.id === id)!.section).map(s => s.id);
    expect(replayed('saved-class')).toContain('footprint-classes');
    expect(replayed('saved-class')).toContain('save-class');
    expect(replayed('labeling')).not.toContain('footprint-classes');
    expect(replayed('labeling')).toEqual(['welcome', 'peaks', 'select-peaks', 'clustering', 'cmd-click', 'save-footprint']);
  });

  it('walk the footprint-class workflow: find, table, save a class, its plot', () => {
    const ids = tourOutline().map(s => s.id);
    const at = (id: string) => ids.indexOf(id);
    expect(at('footprint-classes')).toBeGreaterThan(at('save-footprint'));
    expect([at('footprint-classes'), at('class-table'), at('save-class'), at('saved-class'), at('co-occupancy')])
      .toEqual([...[at('footprint-classes'), at('class-table'), at('save-class'), at('saved-class'), at('co-occupancy')]].sort((a, b) => a - b));
    expect(at('compare-haplotypes')).toBe(at('regions') + 1);
  });

  // The owner found the tour "a lot of text": one or two plain sentences a step (docs/guide.md has the rest).
  it('keep each step to one or two sentences', () => {
    const long = tourSteps(demo as never, true).filter(s => !s.final).flatMap(step => {
      const sentences = step.text.split(/(?<=[.!?])\s+(?=[A-Z0-9⌘])/).filter(Boolean).length;
      return sentences > 2 || step.text.length > 300 ? [`${step.id}: ${sentences} sentences, ${step.text.length} chars`] : [];
    });
    expect(long).toEqual([]);
  });

  it('show the 3.0 workflows: the command palette, the read menu, regions, highlights, genomes, t-SNE, Export data', () => {
    const ids = tourOutline().map(s => s.id);
    expect(ids).toEqual(expect.arrayContaining(['command-palette', 'read-actions', 'regions', 'highlight', 'navigation', 'projection', 'export-data']));
    const text = tourSteps(demo as never, false).map(s => `${s.text} ${s.how ?? ''}`).join(' ');
    expect(text).toMatch(/t-SNE/);
    expect(text).toMatch(/Per panel/);
    expect(text).toMatch(/Right-click/);
    // Removed: click modes and the V key, Bookmarks.
    expect(text).not.toMatch(/click mode|\bV key|\bpress V\b|Bookmark/i);
  });

  it('point only at elements the components render', () => {
    const missing: string[] = [];
    for (const step of tourSteps(demo as never, false)) {
      for (const [value, prefixOnly] of selectorValues(step)) if (!rendered(value, prefixOnly)) missing.push(`${step.id}: ${value}`);
      if (step.anchor && !tutorialAnchorById(step.anchor) && !rendered(step.anchor)) missing.push(`${step.id}: anchor ${step.anchor}`);
    }
    expect(missing).toEqual([]);
  });

  it('name no retired feature (site consensus, targeted families, CR buttons, the staged engine)', () => {
    const retired = /site[- ]consensus|targeted famil|famil(y|ies)\b|\bRefine\b|Cross-CR|\bX?CR\b|staged|Monte Carlo|Assignment stringency|footprint states?\b|Strict to Loose/i;
    const offending = tourSteps(demo as never, true)
      .flatMap(s => [s.title, s.text, s.how ?? ''].filter(t => retired.test(t)).map(t => `${s.id}: ${t.match(retired)?.[0]}`));
    expect(offending).toEqual([]);
  });
});

// 3.0: Variants is a released panel; the tour shows it on the structural-variant demo (H1, a 7,471-bp insertion).
describe('the Variants section', () => {
  const ids = (steps: ReturnType<typeof tourSteps>) => steps.filter(s => s.section === 'Variants').map(s => s.id);
  const VARIANT_STEPS = ['sv-demo', 'variants-panel', 'snp-table', 'split-by-haplotype', 'svs-tab', 'sv-flag', 'insert-expanded', 'insert-ctcf'];

  it('walks SNPs, a split by allele, the SVs tab and the insert expanded, before Around the browser', () => {
    const steps = tourSteps(demo as never, false, sv as never);
    expect(ids(steps)).toEqual(VARIANT_STEPS);
    const sections = [...new Set(steps.map(s => s.section))];
    expect(sections.indexOf('Variants')).toBe(sections.indexOf('Around the browser') - 1);
    expect(steps.length).toBeLessThanOrEqual(60);
  });

  it('has the same steps with or without the SV demo; only with it does the first step load it', () => {
    const withSv = tourSteps(demo as never, false, sv as never);
    const without = tourSteps(demo as never, false, null);
    expect(without.map(s => s.id)).toEqual(withSv.map(s => s.id));
    expect(withSv.find(s => s.id === 'sv-demo')!.run).toBeTypeOf('function');
    expect(without.find(s => s.id === 'sv-demo')!.run).toBeUndefined();
    expect(withSv.find(s => s.id === 'sv-demo')!.text).toMatch(/7,471-bp insertion/);
  });

  it('opens the Variants panel on its rail tile, and names the insert-expanded panels as Preview', () => {
    const steps = tourSteps(demo as never, false, sv as never);
    const panelStep = steps.find(s => s.id === 'variants-panel')!;
    expect(panelStep.panel).toBe('variants');
    expect(typeof panelStep.selector === 'function' ? panelStep.selector({} as never) : panelStep.selector).toMatch(/variants/);
    expect(steps.find(s => s.id === 'insert-expanded')!.text).toMatch(/Preview/);
    expect(steps.find(s => s.id === 'svs-tab')!.text).not.toMatch(/Preview/);
  });

  it('skips the steps whose result is not there (no split, no insert-expanded panel)', () => {
    const steps = tourSteps(demo as never, false, sv as never);
    const session = { svInsertion: null, altPanelId: null } as never;
    expect(steps.find(s => s.id === 'split-by-haplotype')!.when!(session)).toBe(false);
    expect(steps.find(s => s.id === 'insert-expanded')!.when!(session)).toBe(false);
    expect(steps.find(s => s.id === 'insert-ctcf')!.when!(session)).toBe(false);
  });

  // The demo's SNPs sit at the insertion's breakpoint (alignment artifacts of the insert): the tour splits by HP tag.
  it('splits the reads by haplotype, not by a breakpoint SNP, and says Split works on any SNP', () => {
    const steps = tourSteps(demo as never, false, sv as never);
    expect(steps.find(s => s.id === 'split-by-haplotype')!.title).toBe('Reads split by haplotype');
    expect(steps.find(s => s.id === 'snp-table')!.text).toMatch(/HP tags/);
    expect(steps.find(s => s.id === 'snp-table')!.text).toMatch(/any SNP/);
    expect(steps.find(s => s.id === 'insert-ctcf')!.text).toMatch(/sorted by accessibility/);
  });

  it('lists the SV demo texts in the Tutorial panel when the server has it', () => {
    expect(tourOutline(demo as never, sv as never).find(s => s.id === 'svs-tab')!.text).toMatch(/7,471-bp/);
    expect(tourOutline(demo as never, null).find(s => s.id === 'svs-tab')!.text).not.toMatch(/7,471/);
  });
});

// Codex integration review (fb24, M4): groups the toolbar row has no room for are in its
// More menu (no fold toggle of their own); the tour opens More to show them.
describe('tour and the toolbar More menu', () => {
  it('a group in More is shown by opening More, and folded by closing it', async () => {
    document.body.innerHTML = '<button data-testid="toolbar-groups-more" aria-expanded="false" data-toolbar-overflow="sort filter quality"></button>'
      + '<button data-tour="reads-controls-expand" aria-expanded="false"></button>';
    const more = document.querySelector('[data-testid="toolbar-groups-more"]') as HTMLElement;
    more.addEventListener('click', () => more.setAttribute('aria-expanded', String(more.getAttribute('aria-expanded') !== 'true')));
    expect(toolbarGroupInMore('quality')).toBe(true);
    expect(toolbarGroupInMore('reads')).toBe(false);
    await setToolbarGroupOpen('sort', true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await setToolbarGroupOpen('quality', true);  // already open: left open
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await setToolbarGroupOpen('sort', false);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    document.body.innerHTML = '';
  });

  it('steps about controls inside a toolbar group name it', () => {
    const groups = Object.fromEntries(tourSteps(null, false).filter(s => s.toolbarGroup).map(s => [s.id, s.toolbarGroup]));
    expect(groups).toEqual({ layers: 'layers', peaks: 'peaks', clustering: 'cluster', 'sort-filter': 'sort', highlight: 'highlight' });
  });
});

// Codex review (fb-tutorial, P1): the tour removes the category it made for its saved
// view when the tour ends; removing a category also removes its subheadings and their
// regions, so one the user has since added to (or put a subheading under) must stay.
describe('the regions the tour saved', () => {
  it('go when the tour ends, but never the user\'s own regions or subheadings', async () => {
    const { useRegionCatalogStore, setRegionCatalogPersistence } = await import('../stores/regionCatalogStore');
    const { removeCreatedRegions } = await import('./guidedTour');
    setRegionCatalogPersistence(() => false);
    const genome = 'tour-test-genome';
    const store = useRegionCatalogStore.getState();
    const region = { chrom: 'chr1', start: 100, end: 200, label: 'r', source: 'saved' as const };

    // Only the tour's region in the tour's category: both go.
    const alone = store.addCategory(genome, { name: 'Saved regions', source: 'saved' });
    const [tourOnly] = store.addEntries(genome, alone, [region]);
    removeCreatedRegions({ createdRegions: [{ genome, entryIds: [tourOnly], categoryIds: [alone] }] });
    let catalog = useRegionCatalogStore.getState().catalogFor(genome);
    expect(catalog.categories.some(c => c.id === alone)).toBe(false);
    expect(catalog.entries.some(e => e.id === tourOnly)).toBe(false);

    // The user put a subheading with a region of their own under the tour's category: it all stays.
    const made = useRegionCatalogStore.getState().addCategory(genome, { name: 'Saved regions', source: 'saved' });
    const [tourEntry] = useRegionCatalogStore.getState().addEntries(genome, made, [region]);
    const sub = useRegionCatalogStore.getState().addCategory(genome, { name: 'Mine', parent: made, source: 'user' });
    const [mine] = useRegionCatalogStore.getState().addEntries(genome, sub, [{ ...region, label: 'mine' }]);
    removeCreatedRegions({ createdRegions: [{ genome, entryIds: [tourEntry], categoryIds: [made] }] });
    catalog = useRegionCatalogStore.getState().catalogFor(genome);
    expect(catalog.entries.some(e => e.id === tourEntry)).toBe(false);
    expect(catalog.entries.some(e => e.id === mine)).toBe(true);
    expect(catalog.categories.map(c => c.id)).toEqual(expect.arrayContaining([made, sub]));
  });
});
