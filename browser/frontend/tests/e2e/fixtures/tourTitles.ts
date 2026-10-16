/**
 * The guided-tour step titles tour.spec.ts keys on. The spec only sees a step's
 * title (the popover shows no id), so a renamed step dropped out of its checks:
 * fb-n5-projection renamed "Projection" to "The read map" and the walk failed on
 * a list that no longer matched, three minutes into an e2e run. The unit test
 * (src/utils/guidedTour.test.ts) checks every title here against tourSteps(), so
 * a rename now fails in vitest, next to the change that made it.
 */

/** Steps the walk must reach (the class steps are reached only when Find classes works). */
export const TOUR_WALKED_TITLES = [
  'Footprint classes', 'The class table', 'Saving a class', 'Saved classes and their prevalence', 'Comparing haplotypes',
  // 3.0 workflows
  'Search commands and settings', 'Acting on reads: right-click', 'Highlight', 'Regions', 'Genomes and navigation', 'The read map', 'Export data',
  // Variants (released in 3.0), on the structural-variant demo
  'The Variants panel', 'SNPs in view', 'Reads split by haplotype', 'Structural variants', 'Insertions on the reads', 'The insert, expanded',
  'Inside the insert: a CTCF site',
];

/** Steps about a whole panel: the panel's header flashes, no control is ringed. */
export const TOUR_PANEL_STEPS = ['Welcome to FiberBrowser', 'Read Stats', 'The Clusters panel', 'A structural-variant demo', "That's the tour"];

/** Host-only controls a sandbox tab hides: explained with a note instead of a spotlight. */
export const TOUR_SANDBOX_HIDDEN = ['Loading data', 'Primers', 'Save', 'Copilot'];

/** Steps the walk checks something at. */
export const TOUR_CHECKED = {
  welcome: 'Welcome to FiberBrowser',
  classTable: 'The class table',
  regions: 'Regions',
  haplotypes: 'Comparing haplotypes',
  tutorialPanel: 'The Tutorial panel',
  analysisPanels: 'Analysis panels',
  sortFilter: 'Sort and filter',
  svDemo: 'A structural-variant demo',
  splitByHaplotype: 'Reads split by haplotype',
  svsTab: 'Structural variants',
  insertCtcf: 'Inside the insert: a CTCF site',
} as const;
