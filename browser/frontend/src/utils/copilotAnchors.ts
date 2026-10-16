/**
 * Copilot UI tutorial — maps each browser action to the panel / button it
 * corresponds to in the UI, then highlights those elements as the action runs.
 *
 * Three layers:
 *   1. **Panel flash** — the analysis panel that owns this action briefly
 *      pulses its header and auto-opens if collapsed.
 *   2. **Button ring** — any UI element marked with
 *      `data-copilot-anchor="<key>"` gets a green ring + pulse for ~600 ms.
 *   3. **Tutorial popover** — when tutorial mode is on, a small bubble
 *      shows up next to the highlighted element with the action's
 *      description (and optionally the model's `<think>` text). The
 *      executor pauses for the configured per-step delay before continuing.
 *
 * Keep the registry deliberately central so adding a new action type only
 * requires one edit to slot it into the tutorial story.
 */
import { useBrowserStore } from '../stores/browserStore';
import { sameChrom } from './chromAliases';
import { readStoredFlag, writeStoredFlag } from './copilotSettings';
import { revealTutorialAnchor, showPanelTab, tutorialAnchorById } from './tutorialAnchors';
import { watchCondition, watchMilestone, type Watch } from './tutorialMilestones';

/** How a tutorial popover closed: Next, the user reached the step's goal, Skip, timeout, End, or the extra button. */
export type PopoverOutcome = 'next' | 'done' | 'skip' | 'timeout' | 'end' | 'extra' | 'auto';

/** Default wait for a `try_it` step before moving on anyway. */
export const TRY_IT_DEFAULT_TIMEOUT_S = 120;

export type CopilotAnchorKey =
  | 'search-bar'
  | 'scan-peaks-button'
  | 'cluster-button'
  | 'cluster-mode-select'
  | 'cluster-k-input'
  | 'cluster-auto-cull-button'
  | 'accessibility-threshold-input'
  | 'subnuc-threshold-input'
  | 'spanning-only-toggle'
  | 'min-footprints-input'
  | 'quality-filter-input'
  | 'peaks-lock-toggle'
  | 'analysis-rules-add-cluster-rule'
  | 'analysis-rules-add-sort-rule'
  | 'analysis-rules-add-filter-rule'
  | 'analysis-rules-cluster-tab'
  | 'colormap-add-rule'
  | 'capture-add-region'
  | 'footprint-add-group'
  | 'primer-design-button'
  // v2.11 merge — Layout panel
  | 'dataset-merge-button'
  | 'dataset-unmerge-button'
  | 'dataset-link-button'
  | 'dataset-unlink-button'
  // v2.11 merge — Cluster selection + merge
  | 'cluster-merge-button'
  | 'cluster-order-lock-toggle'
  // v2.11 merge — Read display toolbar
  | 'read-row-height'
  | 'read-fill-height'
  | 'read-separator-mode'
  | 'read-separator-min-height'
  | 'read-separator-width'
  // v2.11 merge — Motif tools
  | 'jaspar-name-input'
  // v2.12 merge — Cluster trees / dynamic reassignment
  | 'cluster-dynamic-toggle'
  | 'cluster-dynamic-overlap'
  | 'cluster-branch-map';

export interface AnchorDef {
  /** Built-in panel content type to flash (and auto-open) for this action. */
  panelType?: string;
  /** data-copilot-anchor key of a button/control to ring. Use the callback
   *  form when the anchor depends on the action payload (e.g. cluster id). */
  buttonAnchor?: CopilotAnchorKey | string;
  resolveAnchor?: (action: Record<string, unknown>) => string | undefined;
  /** Human-readable description for the tutorial popover. */
  describe: (action: Record<string, unknown>) => string;
  /** Optional "how to do this manually" text — surfaces modifier-key
   *  shortcuts (Cmd+click, Shift+click), context-menu paths, etc. that
   *  aren't otherwise discoverable. Rendered as a separate hint section
   *  in the tutorial popover. Return null to omit for a particular action. */
  manualHow?: (action: Record<string, unknown>) => string | null;
  /** When true, the run loop skips the executor entirely and treats this
   *  as a "do it yourself" step: open the panel, flash the anchor, show
   *  the manualHow popover, wait for the user to advance. Used for
   *  actions that don't have a clean executor path (drag-to-draw,
   *  precise slider drags, footprint-by-eye selection, etc.). Surfaced
   *  in the panel UI with a "Manual step" badge so the user knows
   *  Copilot is pointing rather than acting. */
  manualOnly?: boolean;
}

const _asStr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const _asInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Mac-aware modifier label. Most users on this app are Mac (the project
 *  ships MLX-only Copilot tiers) but the read-track mouse handler also
 *  honors Ctrl on Windows/Linux, so render the right one for the platform. */
const _modKey = (): string => {
  if (typeof navigator === 'undefined') return 'Cmd';
  return /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
};

export const COPILOT_ANCHORS: Record<string, AnchorDef> = {
  navigate_region: {
    buttonAnchor: 'search-bar',
    describe: (a) => {
      const gene = (a.gene as Record<string, unknown> | undefined)?.name;
      const label = _asStr(a.label);
      if (gene) return `Navigating to ${gene} ${label ? `(${label})` : ''}`;
      if (label) return `Navigating to ${label}`;
      return `Navigating to ${_asStr(a.chrom)}:${a.start}-${a.end}`;
    },
    manualHow: () => 'Type a gene name or coords (chr3R:6,749,000-6,761,000) in the search bar and press Enter.',
  },
  scan_peaks: {
    buttonAnchor: 'scan-peaks-button',
    describe: () => 'Re-scanning peaks against the active rules in this viewport.',
    manualHow: () => 'Click the “Scan” button next to the search bar.',
  },
  set_peaks_locked: {
    buttonAnchor: 'peaks-lock-toggle',
    describe: (a) => (a.locked ? 'Locking peaks for reproducibility.' : 'Unlocking peaks so they can rescan.'),
    manualHow: () => 'Click Lock next to the Scan button (Peaks, in the toolbar).',
  },
  select_peak_at: {
    panelType: 'cluster-detail',
    buttonAnchor: 'scan-peaks-button',
    describe: (a) => `Selecting the nearest peak (${_asStr(a.label, 'target')}).`,
    manualHow: () => `Click a peak in the read track. ${_modKey()}+click adds to the selection; Shift+click also picks the underlying read.`,
  },
  cluster_by_saved_footprints: {
    panelType: 'footprint-analysis',
    describe: () => 'Clustering reads by which saved footprints they carry.',
    manualHow: () => 'Footprints panel → Co-occupancy → tick the footprints under Cluster by → "Cluster reads by N footprints" (needs saved footprints at positions in view).',
  },
  cluster_selected_peaks: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-button',
    describe: () => 'Clustering reads on the selected peaks.',
    manualHow: () => 'With peaks selected, click the “Cluster Reads” button in the Cluster panel.',
  },
  cluster_peak_at_gene_tss: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-button',
    describe: (a) => `Clustering on the ${_asStr(a.gene_name, 'gene')} TSS peak.`,
    manualHow: () => 'Navigate to the gene, scan peaks, click the TSS peak, then click “Cluster Reads”.',
  },
  add_region_label_rule: {
    panelType: 'colormap',
    buttonAnchor: 'colormap-add-rule',
    describe: (a) => `Adding "${_asStr(a.region_label, 'label')}" color rule (${_asStr(a.color)}).`,
    manualHow: () => 'Open the Colormap panel, click “+ Add rule”, then pick the layer, size range, and color.',
  },
  query_motif_overlaps: {
    panelType: 'footprint-analysis',
    describe: (a) => `Querying motif overlaps in ${_asStr(a.chrom)}:${a.start}-${a.end}.`,
  },
  api_call: {
    describe: (a) => `${_asStr(a.method, 'GET').toUpperCase()} ${_asStr(a.path, '/api/...')}`,
  },
  set_panel_strand: {
    describe: (a) => {
      const s = _asStr(a.strand).toUpperCase();
      return s === 'CT' || s === 'GA' ? `Showing only ${s}-strand reads in the DAF-seq panel.` : 'Showing both strands again.';
    },
    manualHow: () => 'Click the strand chip ("Both strands") in the DAF-seq panel header and pick CT, GA or both.',
  },
  split_panel_by_strand: {
    describe: () => 'Splitting the DAF-seq panel into CT and GA side by side.',
    manualHow: () => 'Click the strand chip in the panel header and choose "Split: CT | GA".',
  },
  open_panel_copy: {
    describe: (a) => (typeof a.chrom === 'string'
      ? `Opening a copy of the panel at ${a.chrom}:${a.start}-${a.end}.`
      : 'Opening a linked copy of the panel next to it.'),
    manualHow: () => 'Hover the panel header and click +. The copy follows the main view until you click Unlink in its location bar.',
  },
  set_panel_linked: {
    describe: (a) => (a.linked === false ? 'Unlinking the panel copy so it navigates on its own.' : 'Linking the panel copy to move with the main view.'),
    manualHow: (a) => (a.linked === false ? 'Click Unlink in the copy\'s location bar.' : 'Click Link in the copy\'s location bar.'),
  },
  try_it: {
    // The user's turn: point at a control, wait until they have used it (or Skip).
    manualOnly: true,
    describe: (a) => _asStr(a.text, 'Your turn: try it.'),
  },
  open_sidebar: {
    describe: (a) => `Opening the ${_asStr(a.section, 'settings')} section of the sidebar.`,
  },
  close_panel: {
    describe: (a) => `Closing the ${_asStr(a.panel_type ?? (a as { panelType?: unknown }).panelType, 'analysis')} panel.`,
  },
  zoom_view: {
    describe: (a) => (_asStr(a.direction) === 'in' ? 'Zooming in.' : 'Zooming out.'),
    manualHow: () => 'Use the − / + buttons next to the search box (or the up/down arrow keys).',
  },
  pan_view: {
    describe: (a) => (_asStr(a.direction) === 'left' ? 'Panning left.' : 'Panning right.'),
    manualHow: () => 'Use the ◀ / ▶ buttons next to the search box (or the left/right arrow keys).',
  },
  go_to_top_locus: {
    describe: () => 'Going to the next best-covered locus at this zoom.',
    manualHow: () => 'Click the crosshair next to the zoom buttons; each click goes to the next locus, deepest first.',
  },
  explain: {
    // Pure narration. The popover renders `action.text` (the runner already
    // prefers `action.label` over describe()) and the optional panel_type
    // becomes the flash target. manualOnly so the executor doesn't try to
    // mutate state — the whole point of `explain` is to point + narrate.
    manualOnly: true,
    describe: (a) => _asStr(a.text, 'Explanation step.'),
    manualHow: (a) => _asStr(a.text) ? null : 'Read the popover; click Next to continue.',
  },
  open_panel: {
    // Panel itself is the highlight target — the handler reads action.panel_type
    // and the highlightForAction code picks the panel header by content type.
    describe: (a) => {
      const panel = _asStr(a.panel_type ?? (a as { panelType?: unknown }).panelType, 'panel');
      const tab = _asStr(a.tab);
      return tab ? `Opening ${panel} panel on the ${tab} tab.` : `Opening ${panel} panel.`;
    },
  },
  add_cluster_rule: {
    panelType: 'cluster-features',
    buttonAnchor: 'analysis-rules-add-cluster-rule',
    describe: (a) => `Adding cluster rule "${_asStr(a.name, 'New cluster rule')}".`,
    manualHow: () => 'Open the Rules panel → Cluster tab → click “+ Add cluster rule”.',
  },
  add_sort_rule: {
    panelType: 'cluster-features',
    buttonAnchor: 'analysis-rules-add-sort-rule',
    describe: (a) => {
      const metric = _asStr(a.metric, 'count');
      const dir = a.descending === false ? 'low to high' : 'high to low';
      return `Adding sort rule "${_asStr(a.name, 'New sort rule')}" (${metric}, ${dir}).`;
    },
    manualHow: () => 'Open the Rules panel → Sort tab → click “+ Add sort rule”.',
  },
  add_filter_rule: {
    panelType: 'cluster-features',
    buttonAnchor: 'analysis-rules-add-filter-rule',
    describe: (a) => {
      const metric = _asStr(a.metric, 'count');
      const op = _asStr(a.operator, 'gte');
      const threshold = _asInt(a.threshold);
      return `Adding filter rule "${_asStr(a.name, 'New filter rule')}" (${metric} ${op} ${threshold ?? '?'}).`;
    },
    manualHow: () => 'Open the Rules panel → Filter tab → click “+ Add filter rule”.',
  },
  hide_cluster: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const id = _asInt(a.cluster_id);
      return id != null ? `cluster-row-${id}` : undefined;
    },
    describe: (a) => `Hiding cluster ${_asInt(a.cluster_id) ?? '?'} from the current cluster view.`,
    manualHow: () => 'Click the cluster row or read-track cluster stripe to select it, then click “Hide” in the Clusters panel.',
  },
  focus_cluster: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const id = _asInt(a.cluster_id);
      return id != null ? `cluster-row-${id}` : undefined;
    },
    describe: (a) => `Focusing on cluster ${_asInt(a.cluster_id) ?? '?'}; other clusters hidden.`,
    manualHow: () => 'Click the cluster row or read-track cluster stripe to select it, then click “Hide others” in the Clusters panel.',
  },
  dissolve_cluster: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const id = _asInt(a.cluster_id);
      return id != null ? `cluster-row-${id}` : undefined;
    },
    describe: (a) => `Dissolving cluster ${_asInt(a.cluster_id) ?? '?'} — reads reassigned to nearest cluster.`,
    manualHow: () => 'Click the cluster row or read-track cluster stripe to select it, then click “Delete” in the Clusters panel.',
  },
  remove_cluster_rule: {
    panelType: 'cluster-features',
    describe: (a) => `Removing cluster rule "${_asStr(a.rule_name ?? (a as { ruleName?: unknown }).ruleName, _asStr(a.rule_id, '?'))}".`,
    manualHow: () => 'Open the Rules panel → Cluster tab → click the trash icon next to the rule.',
  },
  remove_sort_rule: {
    panelType: 'cluster-features',
    describe: (a) => `Removing sort rule "${_asStr(a.rule_name ?? (a as { ruleName?: unknown }).ruleName, _asStr(a.rule_id, '?'))}".`,
    manualHow: () => 'Open the Rules panel → Sort tab → click the trash icon next to the rule.',
  },
  remove_filter_rule: {
    panelType: 'cluster-features',
    describe: (a) => `Removing filter rule "${_asStr(a.rule_name ?? (a as { ruleName?: unknown }).ruleName, _asStr(a.rule_id, '?'))}".`,
    manualHow: () => 'Open the Rules panel → Filter tab → click the trash icon next to the rule.',
  },
  clear_filter: {
    // Anchor to the Analysis Rules panel header so the popover lands on
    // a real DOM element instead of floating centered. The actual
    // clear-filter affordance is the trash icon next to the active
    // filter rule there, plus the Sidebar's "Clear filter" button.
    panelType: 'cluster-features',
    describe: (a) => {
      const ds = _asStr(a.dataset_id ?? (a as { datasetId?: unknown }).datasetId);
      return ds ? `Clearing read filter on ${ds}.` : 'Clearing read filter on all datasets.';
    },
    manualHow: () => 'Rules panel → Filter tab → trash icon next to the active filter, or Sidebar → "Clear filter".',
  },
  // ── Layer / display toggles ─────────────────────────────────────
  toggle_layer: {
    // Resolve to the specific layer checkbox in the sidebar (LayerToggles.tsx
    // emits data-copilot-anchor="layer-toggle-<modType>"). Without this, the
    // spotlight had nothing to anchor to and fell back to a tooltip floating
    // at the top of the window — which the user explicitly called out as
    // confusing because it didn't point at the actual UI.
    resolveAnchor: (a) => {
      const layer = _asStr(a.layer);
      return layer ? `layer-toggle-${layer}` : undefined;
    },
    manualHow: (a) =>
      `Sidebar → Layers → tick "${_asStr(a.layer, 'layer')}" checkbox.`,
    describe: (a) => `${a.enabled === false ? 'Hiding' : 'Showing'} ${_asStr(a.layer, 'layer')} layer.`,
  },
  set_quality_filter: {
    buttonAnchor: 'quality-filter-input',
    manualHow: () => 'Sidebar → View → Min footprint quality (legacy panel; only shows when a quality filter is active).',
    describe: (a) => `Min FP quality set to ${_asInt(a.value) ?? '?'}.`,
  },
  set_min_footprints: {
    buttonAnchor: 'min-footprints-input',
    manualHow: () => 'Sidebar → View → Min footprints field.',
    describe: (a) => `Min footprints per read set to ${_asInt(a.value) ?? '?'}.`,
  },
  set_spanning_only: {
    buttonAnchor: 'spanning-only-toggle',
    manualHow: () => 'Top toolbar → "Span" checkbox next to the zoom controls.',
    describe: (a) => `${a.enabled === false ? 'Disabling' : 'Enabling'} spanning-only filter.`,
  },
  set_subnucleosomal_threshold: {
    panelType: 'cluster-detail',
    buttonAnchor: 'subnuc-threshold-input',
    manualHow: () => 'Cluster panel → "Small FP" input (bp threshold for small-footprint signal).',
    describe: (a) => `Sub-nucleosomal threshold set to ${_asInt(a.value) ?? '?'} bp.`,
  },
  set_accessibility_threshold: {
    panelType: 'cluster-detail',
    buttonAnchor: 'accessibility-threshold-input',
    manualHow: () => 'Cluster panel → accessibility % input next to the cluster-mode dropdown.',
    describe: (a) => `Accessibility threshold = ${_asInt(a.value) ?? '?'}%.`,
  },

  // ── Color rules ─────────────────────────────────────────────────
  remove_color_rule: {
    panelType: 'colormap',
    resolveAnchor: (a) => {
      const id = _asStr(a.rule_id);
      return id ? `color-rule-${id}` : undefined;
    },
    describe: (a) => `Removing color rule "${_asStr(a.rule_name, _asStr(a.rule_id, '?'))}".`,
    manualHow: () => 'Colormap panel → click the trash icon on the rule row.',
  },
  toggle_color_rule: {
    panelType: 'colormap',
    resolveAnchor: (a) => {
      const id = _asStr(a.rule_id);
      return id ? `color-rule-${id}` : undefined;
    },
    describe: (a) => `${a.enabled === false ? 'Disabling' : 'Enabling'} color rule "${_asStr(a.rule_name, _asStr(a.rule_id, '?'))}".`,
    manualHow: () => 'Colormap panel → toggle the checkbox at the left of the rule row.',
  },
  clear_color_rules: {
    panelType: 'colormap',
    describe: () => 'Clearing all color rules.',
  },

  // ── Tracks ──────────────────────────────────────────────────────
  // All three anchor onto the Tracks panel panel header so the popover
  // has a real DOM target. No specific button anchors yet — track ops
  // live in the analysis-panel-plugin Tracks panel which has its own
  // internal layout.
  add_track_from_url: {
    panelType: 'track-browser',
    describe: (a) => `Adding track from ${_asStr(a.path, '...')}.`,
    manualHow: () => 'Open the Tracks panel panel → URL input → paste the remote BigBed/BigWig URL.',
  },
  remove_track: {
    panelType: 'track-browser',
    describe: (a) => `Removing track #${_asInt(a.track_index) ?? '?'}.`,
    manualHow: () => 'Open the Tracks panel panel → click the trash icon next to the track row.',
  },
  set_track_filter: {
    panelType: 'track-browser',
    describe: (a) => {
      const names = Array.isArray(a.filter_names) ? (a.filter_names as unknown[]).length : 0;
      return `Setting track #${_asInt(a.track_index) ?? '?'} filter to ${names} name(s).`;
    },
    manualHow: () => 'Tracks panel → click the track → set the filter expression.',
  },

  // ── Apply saved rules / cluster ops ──────────────────────────────
  apply_cluster_rule: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-button',
    describe: (a) => `Applying cluster rule "${_asStr(a.rule_name, _asStr(a.rule_id, '?'))}" (switches cluster mode + runs cluster).`,
  },
  apply_sort_rule: {
    // FIX (audit B ❌): previously referenced buttonAnchor 'sort-control'
    // which doesn't exist anywhere in src/. The popover floated with no
    // panel flash either. Anchor to the Analysis Rules panel header
    // (where saved sort rules live) so users see the right place.
    panelType: 'cluster-features',
    describe: (a) => `Sorting reads by saved rule "${_asStr(a.rule_name, _asStr(a.rule_id, '?'))}".`,
    manualHow: () => 'Rules panel → Sort tab → click the play arrow next to the saved rule.',
  },
  apply_filter_rule: {
    panelType: 'cluster-features',
    describe: (a) => `Filtering reads by saved rule "${_asStr(a.rule_name, _asStr(a.rule_id, '?'))}"${a.pin === false ? '' : ' and pinning the result'}.`,
    manualHow: () => 'Rules panel → Filter tab → click the play arrow next to the saved rule.',
  },
  select_cluster_reads: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const id = _asInt(a.cluster_id);
      return id != null ? `cluster-row-${id}` : undefined;
    },
    describe: (a) => `Selecting all reads in cluster ${_asInt(a.cluster_id) ?? '?'}.`,
  },
  auto_cull_clusters: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-auto-cull-button',
    describe: (a) => {
      const mf = a.min_fraction as number | undefined;
      return `Merging similar clusters${typeof mf === 'number' ? ` (clusters under ${Math.round(mf * 100)}% of reads first)` : ''}.`;
    },
    manualHow: () => 'Clusters panel → "Merge similar clusters" (also in the toolbar\'s Cluster group); its settings are in the Projection tab.',
  },

  // ── Annotations / Capture ───────────────────────────────────────
  toggle_annotation_visibility: {
    panelType: 'annotations',
    resolveAnchor: (a) => {
      const name = _asStr(a.name);
      return name ? `annotation-toggle-${name}` : undefined;
    },
    describe: (a) => `${a.enabled === false ? 'Hiding' : 'Showing'} ${_asStr(a.name, 'annotation')} annotations.`,
    manualHow: () => 'Annotations panel → Types tab → toggle the checkbox next to the annotation type.',
  },
  add_capture_region: {
    panelType: 'capture',
    buttonAnchor: 'capture-add-region',
    describe: (a) => `Capturing ${_asStr(a.chrom)}:${_asInt(a.start) ?? '?'}-${_asInt(a.end) ?? '?'}.`,
    manualHow: () => 'Capture panel → "+ Add region" button → enter coordinates.',
  },
  clear_capture_regions: {
    panelType: 'capture',
    describe: () => 'Clearing all capture regions.',
  },

  // ── Footprint Analysis ──────────────────────────────────────────
  // analyze_footprints fires automatically when the panel opens with
  // groups + a region selected; there's no dedicated button to anchor.
  // The panel header flash is the right spotlight target.
  analyze_footprints: {
    panelType: 'footprint-analysis',
    describe: () => 'Running Footprint Analysis with current settings.',
    manualHow: () => 'Footprint Analysis runs automatically on the active region. Use Sizes / Co-occ tabs to refine groups.',
  },
  add_footprint_group: {
    panelType: 'footprint-analysis',
    buttonAnchor: 'footprint-add-group',
    describe: (a) => `Adding footprint class "${_asStr(a.name, '?')}" on ${_asStr(a.layer, '?')} layer.`,
    manualHow: () => 'Cmd-click a footprint → Footprints panel → drag a size range on the histogram → Save.',
  },
  remove_footprint_group: {
    panelType: 'footprint-analysis',
    resolveAnchor: (a) => {
      const id = _asStr(a.group_id);
      return id ? `footprint-group-${id}` : undefined;
    },
    describe: (a) => `Removing footprint class "${_asStr(a.group_name, _asStr(a.group_id, '?'))}".`,
    manualHow: () => 'Footprint Analysis → Sizes tab → Cart → click the trash icon next to the group.',
  },

  // ── Reproducibility settings ────────────────────────────────────
  set_cluster_method: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-mode-select',
    manualHow: (a) => `Cluster panel → method dropdown → pick "${_asStr(a.method, 'a method')}".`,
    describe: (a) => `Cluster method = ${_asStr(a.method, '?')}.`,
  },
  set_cluster_k: {
    panelType: 'cluster-detail',
    // The k input was previously anchored as "k-input" but the actual DOM
    // attribute on ClusterPanel is "cluster-k-input". Fix the mismatch so
    // the spotlight actually finds the field. Old key kept as a fallback
    // anchor for any old training records that referenced it explicitly.
    buttonAnchor: 'cluster-k-input',
    manualHow: () => 'Cluster panel → "K:" number input (only shows when method needs k, e.g. k-means).',
    describe: (a) => `k = ${_asInt(a.k) ?? '?'}.`,
  },
  set_sample_seed: {
    panelType: 'cluster-features',
    describe: (a) => `Sample seed = ${_asStr(a.seed, '?')}.`,
    manualHow: () => 'Settings → Analysis & Reproducibility → Sample seed.',
  },

  // ── Selection / reset ───────────────────────────────────────────
  clear_selected_peaks: {
    panelType: 'cluster-detail',
    describe: () => 'Clearing selected peaks.',
    manualHow: () => 'Cluster panel → "Clear selection" (or click outside any peak in the read track).',
  },
  clear_selected_reads: {
    panelType: 'read-stats',
    describe: () => 'Clearing selected reads.',
    manualHow: () => 'Read Stats panel → "Clear" (or click outside any read in the read track).',
  },
  reset_view: {
    // Anchor on the search bar where the user typed the original viewport;
    // reset returns to that input's resting state. Avoiding a dedicated
    // reset-view-button anchor for now since the actual reset path is the
    // back-arrow / search re-submit, not a single button.
    buttonAnchor: 'search-bar',
    describe: () => 'Resetting viewport to default.',
    manualHow: () => 'Click the search bar back-arrow or re-submit the original gene/coords.',
  },

  design_primers_for_region: {
    panelType: 'primer-design',
    buttonAnchor: 'primer-design-button',
    describe: (a) => {
      const chrom = _asStr(a.chrom);
      const start = _asInt(a.start);
      const end = _asInt(a.end);
      const mode = _asStr(a.mode, 'standard');
      if (chrom && start != null && end != null) {
        return `Designing ${mode} primers for ${chrom}:${start.toLocaleString()}-${end.toLocaleString()}.`;
      }
      return `Designing ${mode} primers for the current region.`;
    },
  },

  // ── Layout panel (v2.11 merge) ──────────────────────────
  set_dataset_label: {
    panelType: 'dataset-layout',
    resolveAnchor: (a) => {
      const id = _asStr(a.dataset_id);
      return id ? `dataset-label-input-${id}` : undefined;
    },
    describe: (a) => `Renaming dataset to "${_asStr(a.label_text, '…')}".`,
    manualHow: () => 'Layout panel → edit the dataset’s name field inline.',
  },
  merge_datasets: {
    panelType: 'dataset-layout',
    buttonAnchor: 'dataset-merge-button',
    describe: () => 'Merging the selected datasets into one stacked view.',
    manualHow: () => 'Layout panel → select two or more datasets → “Merge selected”.',
  },
  unmerge_dataset: {
    panelType: 'dataset-layout',
    buttonAnchor: 'dataset-unmerge-button',
    describe: () => 'Splitting a merged dataset back into separate panels.',
    manualHow: () => 'Layout panel → select the merged dataset → “Split”.',
  },
  link_datasets: {
    panelType: 'dataset-layout',
    buttonAnchor: 'dataset-link-button',
    describe: (a) => `Linking ${Array.isArray(a.panel_ids) ? (a.panel_ids as unknown[]).length : ''} datasets so their viewports stay in sync.`,
    manualHow: () => 'Layout panel → select datasets → “Link”.',
  },
  unlink_dataset: {
    panelType: 'dataset-layout',
    buttonAnchor: 'dataset-unlink-button',
    describe: () => 'Unlinking a dataset so it scrolls independently.',
    manualHow: () => 'Layout panel → select the linked dataset → “Unlink”.',
  },

  // ── Cluster selection + merge (v2.11 merge) ─────────────────────
  toggle_cluster_selection: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const id = _asInt(a.cluster_id);
      return id != null ? `cluster-row-${id}` : undefined;
    },
    describe: (a) => `Toggling selection of cluster ${_asInt(a.cluster_id) ?? '?'}.`,
    manualHow: () => `${_modKey()}+click cluster rows in the Clusters panel to multi-select them.`,
  },
  set_cluster_selection: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const ids = Array.isArray(a.cluster_ids) ? a.cluster_ids : [];
      const first = _asInt(ids[0]);
      return first != null ? `cluster-row-${first}` : undefined;
    },
    describe: (a) => `Selecting ${Array.isArray(a.cluster_ids) ? (a.cluster_ids as unknown[]).length : 0} cluster(s).`,
    manualHow: () => `${_modKey()}+click each cluster row in the Clusters panel.`,
  },
  clear_cluster_selection: {
    panelType: 'cluster-detail',
    describe: () => 'Clearing the cluster selection.',
    manualHow: () => 'Click empty space in the Clusters panel to deselect.',
  },
  merge_clusters: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-merge-button',
    describe: () => 'Merging the selected clusters into one.',
    manualHow: () => 'Select 2+ clusters in the Clusters panel, then click “Merge selected”.',
  },
  set_cluster_order_lock: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-order-lock-toggle',
    describe: (a) => (a.locked === false ? 'Unlocking cluster order.' : 'Locking cluster order so re-sorts keep it.'),
    manualHow: () => 'Cluster panel → toggle the “Lock order” button in the toolbar.',
  },

  // ── Read display controls (v2.11 merge) ─────────────────────────
  set_read_row_height: {
    buttonAnchor: 'read-row-height',
    describe: (a) => `Setting read row height to ${_asStr(String(a.value), '?')}.`,
    manualHow: () => 'Read toolbar → row-height stepper, or press [ and ] to shrink / grow rows.',
  },
  set_fill_read_height: {
    buttonAnchor: 'read-fill-height',
    describe: (a) => (a.enabled === false ? 'Turning off fill — reads use a fixed row height.' : 'Filling the track — sparse reads expand to fit.'),
    manualHow: () => 'Read toolbar → “Fill” toggle.',
  },
  set_read_separator_mode: {
    buttonAnchor: 'read-separator-mode',
    describe: (a) => `Read separators: ${_asStr(a.mode, 'auto')}.`,
    manualHow: () => 'Read toolbar → separator dropdown (Auto / Fixed / Off).',
  },
  set_read_separator_min_height: {
    buttonAnchor: 'read-separator-min-height',
    describe: (a) => `Separator min height = ${_asInt(a.value) ?? '?'}px.`,
    manualHow: () => 'Read toolbar → separator settings → min height.',
  },
  set_read_separator_width: {
    buttonAnchor: 'read-separator-width',
    describe: (a) => `Separator width = ${_asInt(a.value) ?? '?'}px.`,
    manualHow: () => 'Read toolbar → separator settings → fixed width.',
  },
  set_layer_background_opacity: {
    panelType: 'colormap',
    resolveAnchor: (a) => {
      const layer = _asStr(a.layer);
      return layer ? `layer-toggle-${layer}` : undefined;
    },
    describe: (a) => `${_asStr(a.layer, 'layer')} background opacity = ${typeof a.opacity === 'number' ? (a.opacity as number).toFixed(2) : '?'}.`,
    manualHow: (a) => `Colormap / Labeling panel → ${_asStr(a.layer, 'layer')} → background-opacity slider.`,
  },

  // ── Motif tools (v2.11 merge) ───────────────────────────────────
  set_motif_threshold: {
    panelType: 'track-browser',
    describe: (a) => `Motif score threshold = ${typeof a.value === 'number' ? (a.value as number).toFixed(2) : '?'}.`,
    manualHow: () => 'Tracks panel → Motif options → Match threshold.',
  },
  load_jaspar_motifs: {
    panelType: 'track-browser',
    buttonAnchor: 'jaspar-name-input',
    describe: (a) => `Loading JASPAR motif track(s): ${Array.isArray(a.names) ? (a.names as unknown[]).join(', ') : ''}.`,
    manualHow: () => 'Tracks panel → type a TF name in the Add box and press Enter.',
  },

  // ── Cluster trees / branches + dynamic reassignment (v2.12 merge) ─
  subcluster_clusters: {
    panelType: 'cluster-detail',
    resolveAnchor: (a) => {
      const ids = Array.isArray(a.cluster_ids) ? a.cluster_ids : [];
      const first = _asInt(ids[0]);
      return first != null ? `cluster-row-${first}` : undefined;
    },
    describe: (a) => `Drilling into cluster(s) ${Array.isArray(a.cluster_ids) ? (a.cluster_ids as unknown[]).join(', ') : '?'} — re-clustering just those reads into a new branch.`,
    manualHow: () => 'Select the cluster(s) in the Clusters panel, then click "Cluster" — the run branches into a subcluster.',
  },
  set_dynamic_clustering: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-dynamic-toggle',
    describe: (a) => (a.enabled === false ? 'Turning off dynamic reassignment.' : 'Turning on dynamic reassignment — reads re-assign to the nearest cluster as you navigate.'),
    manualHow: () => 'Clusters panel → tick "Dynamic reassignment".',
  },
  set_dynamic_overlap_mode: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-dynamic-overlap',
    describe: (a) => `Dynamic overlap mode: ${_asStr(a.mode, 'aggressive')} (${a.mode === 'conservative' ? 'must overlap every peak' : 'overlap any peak'}).`,
    manualHow: () => 'Clusters panel → Dynamic reassignment → Conservative / Aggressive dropdown.',
  },
  capture_cluster_branch: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-branch-map',
    describe: (a) => `Saving the current clustering as a branch${a.name ? ` "${_asStr(a.name)}"` : ''}.`,
    manualHow: () => 'Clusters panel → the branch tree records each clustering; subclustering auto-saves the parent.',
  },
  switch_cluster_branch: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-branch-map',
    describe: (a) => `Switching to cluster branch "${_asStr(a.name)}".`,
    manualHow: () => 'Clusters panel → click a branch in the cluster tree to jump back to it.',
  },
  rename_cluster_branch: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-branch-map',
    describe: (a) => `Renaming cluster branch to "${_asStr(a.new_name)}".`,
    manualHow: () => 'Clusters panel → edit the branch name inline in the cluster tree.',
  },
  delete_cluster_branch: {
    panelType: 'cluster-detail',
    buttonAnchor: 'cluster-branch-map',
    describe: (a) => `Deleting cluster branch "${_asStr(a.name)}".`,
    manualHow: () => 'Clusters panel → click Delete on the branch in the cluster tree.',
  },
};

// ──────────────────────────────────────────────────────────────────────
// CSS classes are defined in src/index.css alongside the rest of the
// app styles. Keeping the class names here so callers don't need to
// hard-code them.
// ──────────────────────────────────────────────────────────────────────

const BUTTON_HIGHLIGHT_CLASS = 'copilot-highlight';
const PANEL_FLASH_CLASS = 'copilot-panel-flash';
const REGION_FLASH_CLASS = 'copilot-region-flash';
const DEFAULT_HIGHLIGHT_MS = 700;
const REGION_FLASH_MS = 1800;

function _delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function _findSelector(selector: string): HTMLElement | null {
  if (!selector) return null;
  try {
    // The first one on screen (a hidden duplicate would place the popover off screen).
    const all = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    return all.find(el => el.getClientRects().length > 0) ?? all[0] ?? null;
  } catch {
    return null;
  }
}

function _findAnchor(key: string | undefined): HTMLElement | null {
  if (!key) return null;
  return document.querySelector(`[data-copilot-anchor="${key}"]`) as HTMLElement | null;
}

function _findPanelHeader(panelType: string): HTMLElement | null {
  const header = document.querySelector(`[data-panel-content-type="${panelType}"] [data-panel-header]`);
  if (header) return header as HTMLElement;
  return document.querySelector(`[data-panel-content-type="${panelType}"]`) as HTMLElement | null;
}

/**
 * Flash a genomic region on every visible ReadTrack canvas. Solves the
 * "no DOM anchor for canvas-rendered footprints/reads" problem: the
 * spotlight can't ring a footprint via classList because footprints are
 * pixels, not elements. Instead we spawn a transient absolutely-positioned
 * div over the canvas at the computed pixel coordinates and pulse it.
 *
 * Each ReadTrack canvas advertises its viewport via data-track-* attrs
 * (see ReadTrack.tsx). We scan them, filter by chrom + overlap with the
 * requested range, then position one flash div per matching canvas.
 *
 * Returns the number of canvases flashed — callers can use this to decide
 * whether to also fall back to a panel-header flash (when 0 canvases
 * matched, e.g. the user is on a different chromosome).
 */
export function flashReadRegion(chrom: string, start: number, end: number): number {
  if (typeof document === 'undefined') return 0;
  const canvases = Array.from(
    document.querySelectorAll('canvas[data-copilot-track="reads"]'),
  ) as HTMLCanvasElement[];
  let flashed = 0;
  for (const canvas of canvases) {
    const trackChrom = canvas.dataset.trackChrom;
    if (trackChrom && !sameChrom(trackChrom, chrom)) continue;
    const trackStart = Number(canvas.dataset.trackStart);
    const trackEnd = Number(canvas.dataset.trackEnd);
    if (!Number.isFinite(trackStart) || !Number.isFinite(trackEnd) || trackEnd <= trackStart) continue;
    // No overlap → skip this panel.
    if (end <= trackStart || start >= trackEnd) continue;

    const sidebar = Number(canvas.dataset.trackSidebar) || 0;
    const regionWidth = Number(canvas.dataset.trackRegionWidth) || (canvas.clientWidth - sidebar);
    if (regionWidth <= 0) continue;
    const bpPerPx = (trackEnd - trackStart) / regionWidth;
    const clampedStart = Math.max(trackStart, start);
    const clampedEnd = Math.min(trackEnd, end);
    const pxStart = sidebar + Math.floor((clampedStart - trackStart) / bpPerPx);
    const pxWidth = Math.max(4, Math.ceil((clampedEnd - clampedStart) / bpPerPx));

    const rect = canvas.getBoundingClientRect();
    const flash = document.createElement('div');
    flash.className = REGION_FLASH_CLASS;
    // Fixed-position so it follows the canvas regardless of scroll
    // container; pointer-events:none so it never intercepts clicks.
    flash.style.position = 'fixed';
    flash.style.left = `${rect.left + pxStart}px`;
    flash.style.top = `${rect.top}px`;
    flash.style.width = `${pxWidth}px`;
    flash.style.height = `${rect.height}px`;
    flash.style.pointerEvents = 'none';
    flash.style.zIndex = '40';
    document.body.appendChild(flash);
    window.setTimeout(() => flash.remove(), REGION_FLASH_MS);
    flashed += 1;
  }
  return flashed;
}

function _ensurePanelOpen(panelType: string): void {
  const state = useBrowserStore.getState() as unknown as {
    openAnalysisPanel?: (type: string) => void;
    panels?: Array<{ contentType?: string }>;
  };
  const alreadyOpen = (state.panels ?? []).some(p => p.contentType === panelType);
  if (!alreadyOpen) state.openAnalysisPanel?.(panelType);
}

export interface HighlightOptions {
  tutorial?: boolean;
  /** Override the default 700 ms ring time. Set higher in tutorial mode. */
  durationMs?: number;
  /** Tutorial popover description text. Pulled from `describe()` when omitted. */
  description?: string;
  /** Optional model reasoning to surface beneath the description (italic
   *  blockquote). Truncated server-side; we just render whatever's passed. */
  thinking?: string;
  /** Whether the popover advances on click (tutorial mode) or auto. */
  waitForClick?: boolean;
  /** Guided tour: a bold heading, "Step 3 of 20", and an End tour button. */
  title?: string;
  progress?: string;
  onEnd?: () => void;
  /** "Do it yourself" text in place of the action's own. */
  manualHow?: string;
  /** A second button beside Next (e.g. the tour's "Back to my data"); it closes the popover. */
  extraAction?: { label: string; onClick: () => void };
  /** The Next button's label (e.g. the tour's last step: "Keep exploring"). */
  nextLabel?: string;
  /**
   * One step of a multi-step walkthrough: after Next the popover stays up
   * (dimmed) and the next step's popover reuses it, sliding to the new target,
   * so it doesn't vanish while the next control is revealed. Call
   * endPopoverSequence() when the walkthrough ends.
   */
  sequence?: boolean;
}

/**
 * Highlight the UI for one action. Resolves once the highlight finishes
 * (and, in tutorial mode, once the user has clicked through the popover).
 */
export async function highlightForAction(
  action: Record<string, unknown>,
  opts: HighlightOptions = {},
): Promise<PopoverOutcome | undefined> {
  const type = _asStr(action.type);
  let def = COPILOT_ANCHORS[type];
  // `open_panel` is special: the panel-flash target lives in the action
  // payload, not in the def. Synthesize a def that points panelType at
  // the requested panel so the existing flash + popover machinery
  // anchors to the right header. Without this the popover floated at
  // top-of-window even though the action carried a perfectly good
  // panel_type field.
  if ((type === 'open_panel' || type === 'explain' || type === 'try_it') && def) {
    const panelType = _asStr(action.panel_type) || _asStr((action as { panelType?: unknown }).panelType);
    if (panelType) {
      def = { ...def, panelType };
    }
  }
  // Hybrid-tutorial fallback: when the planner emits an action type we
  // don't have a built-in spotlight for, still surface SOMETHING in
  // tutorial mode so the user understands what the model wanted and
  // can decide whether to do it themselves. Without this the spotlight
  // is a no-op and the step appears to skip silently.
  if (!def) {
    if (opts.tutorial && type) {
      await _showPopover(null, {
        description: `Copilot wants to "${type}", but there's no built-in driver yet.`,
        manualHow: 'Review the action payload in the plan above and run it manually if it makes sense.',
        thinking: opts.thinking,
      }, { waitForClick: opts.waitForClick ?? false });
    }
    return undefined;
  }

  // 1. Panel flash + auto-open.
  if (def.panelType) {
    _ensurePanelOpen(def.panelType);
    // The panel may not be mounted on the very same tick — wait a frame
    // before reaching for the header.
    await _delay(60);
    const header = _findPanelHeader(def.panelType);
    if (header) {
      header.classList.add(PANEL_FLASH_CLASS);
      window.setTimeout(() => header.classList.remove(PANEL_FLASH_CLASS), 1600);
    }
    // explain / open_panel can name a tab of that panel to show.
    const tab = _asStr(action.tab);
    if (tab && (type === 'explain' || type === 'open_panel' || type === 'try_it')) await showPanelTab(def.panelType, tab);
  }

  // 2. Button ring. Dynamic resolver wins so per-row anchors (cluster id,
  // rule id, etc.) can light up the specific control the action targets.
  // Any step can also name its element: `anchor` (a data-copilot-anchor
  // key) or `selector` (CSS), e.g. the guided tour pointing at a button.
  const dynamicAnchor = def.resolveAnchor?.(action);
  // A tutorial-catalog anchor (see data/tutorialAnchors.json) first opens
  // whatever hides it (panel, tab, sidebar section, toolbar group).
  const tutorialAnchor = tutorialAnchorById(_asStr(action.anchor));
  const revealed = tutorialAnchor ? await revealTutorialAnchor(tutorialAnchor) : null;
  const button = _findSelector(_asStr(action.selector))
    ?? revealed
    ?? _findAnchor(_asStr(action.anchor) || (dynamicAnchor ?? def.buttonAnchor));
  if (button) {
    button.classList.add(BUTTON_HIGHLIGHT_CLASS);
    try { button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch {}
  }
  // Whatever happens below, the ring comes off again.
  try {

    // 2b. Canvas-region flash. When the action carries genomic coordinates
    // (footprint relabel, select_read, pan_to_region, etc.) we also flash
    // the matching region on every ReadTrack so the user sees where the
    // change applied — a button ring on a tooltip is meaningless if the
    // visible change is on the canvas. Cheap no-op when coords are absent.
    const flashChrom = _asStr(action.chrom) || _asStr((action as { chromosome?: unknown }).chromosome);
    const flashStart = _asInt(action.start);
    const flashEnd = _asInt(action.end);
    if (flashChrom && flashStart !== null && flashEnd !== null && flashEnd > flashStart) {
      flashReadRegion(flashChrom, flashStart, flashEnd);
    }

    // 3. Tutorial popover (only in tutorial mode; a try_it step always shows one).
    // A try_it step waits for the user: for its milestone (wait_for) or, for a
    // prerequisite note, for a condition to hold (wait_condition). The watch
    // starts only now, after the reveal, so opening the panel doesn't count.
    const isTryIt = type === 'try_it';
    let watch: Watch<void> | null = null;
    let timer: number | undefined;
    let until: Promise<'done' | 'timeout'> | undefined;
    if (isTryIt) {
      const waitFor = _asStr(action.wait_for);
      const waitCondition = _asStr(action.wait_condition);
      watch = waitCondition ? watchCondition(waitCondition) : waitFor ? watchMilestone(waitFor) : null;
      const timeoutS = Math.max(5, Math.min(900, _asInt(action.timeout_s) ?? TRY_IT_DEFAULT_TIMEOUT_S));
      const timeout = new Promise<'timeout'>(resolve => { timer = window.setTimeout(() => resolve('timeout'), timeoutS * 1000); });
      until = watch ? Promise.race([watch.promise.then(() => 'done' as const), timeout]) : timeout;
    }
    let popoverPromise: Promise<PopoverOutcome> | null = null;
    if (opts.tutorial || isTryIt) {
      const text = opts.description ?? def.describe(action);
      const manualHow = opts.manualHow ?? def.manualHow?.(action) ?? null;
      const target = button ?? (def.panelType ? _findPanelHeader(def.panelType) : null);
      popoverPromise = _showPopover(target, {
        description: text,
        manualHow,
        thinking: opts.thinking,
        title: opts.title,
        progress: opts.progress,
        badge: isTryIt ? 'Your turn' : undefined,
      }, {
        waitForClick: isTryIt ? true : (opts.waitForClick ?? false),
        nextLabel: isTryIt ? 'Skip' : opts.nextLabel,
        until,
        onEnd: opts.onEnd,
        extraAction: opts.extraAction,
        sequence: opts.sequence,
      });
    }
    try {
      const duration = Math.max(200, opts.durationMs ?? DEFAULT_HIGHLIGHT_MS);
      await _delay(duration);
      return popoverPromise ? await popoverPromise : undefined;
    } finally {
      watch?.cancel();
      if (timer !== undefined) window.clearTimeout(timer);
    }
  } finally {
    if (button) button.classList.remove(BUTTON_HIGHLIGHT_CLASS);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Lightweight imperative popover. Avoids the React tree entirely so it
// can live atop any panel and follow scrolling/resizing simply.
// ──────────────────────────────────────────────────────────────────────

interface PopoverContent {
  description: string;
  manualHow?: string | null;
  thinking?: string;
  title?: string;
  progress?: string;
  /** A small label above the text, e.g. "Your turn" on a try_it step. */
  badge?: string;
}

/** The previous walkthrough step's popover, kept up until the next step replaces it. */
let lingeringPopover: { host: HTMLDivElement; timer: number } | null = null;

/** End a walkthrough: remove the popover its last step left up. */
export function endPopoverSequence(): void {
  if (!lingeringPopover) return;
  window.clearTimeout(lingeringPopover.timer);
  lingeringPopover.host.remove();
  lingeringPopover = null;
}

function _showPopover(
  target: HTMLElement | null,
  content: PopoverContent,
  opts: {
    waitForClick: boolean;
    onEnd?: () => void;
    extraAction?: { label: string; onClick: () => void };
    sequence?: boolean;
    /** The main button's label (default "Next →"; a try_it step uses "Skip"). */
    nextLabel?: string;
    /** Closes the popover by itself when it settles (a try_it goal reached, or its timeout). */
    until?: Promise<'done' | 'timeout'>;
  },
): Promise<PopoverOutcome> {
  if (!content.description) return Promise.resolve('auto');
  // A walkthrough's next step reuses the popover the previous step left up.
  const reused = opts.sequence && lingeringPopover ? lingeringPopover.host : null;
  if (lingeringPopover) {
    window.clearTimeout(lingeringPopover.timer);
    if (!reused) lingeringPopover.host.remove();
    lingeringPopover = null;
  }
  const host = reused ?? document.createElement('div');
  if (reused) {
    host.replaceChildren();
    host.classList.remove('copilot-tutorial-waiting');
    host.classList.add('copilot-tutorial-moving');
  } else {
    host.className = 'copilot-tutorial-popover';
    host.setAttribute('role', 'dialog');
  }
  const inner = document.createElement('div');
  inner.className = 'copilot-tutorial-popover-inner';

  if (content.badge) {
    const badge = document.createElement('div');
    badge.className = 'copilot-tutorial-badge';
    badge.textContent = content.badge;
    inner.appendChild(badge);
    host.classList.add('copilot-tutorial-your-turn');
  } else {
    host.classList.remove('copilot-tutorial-your-turn');
  }

  if (content.title) {
    const title = document.createElement('div');
    title.className = 'copilot-tutorial-popover-title';
    title.textContent = content.title;
    inner.appendChild(title);
  }

  // 1. Main description — always present.
  const body = document.createElement('div');
  body.className = 'copilot-tutorial-popover-body';
  body.textContent = content.description;
  inner.appendChild(body);

  // 2. Manual-how hint — modifier-key shortcuts / where-to-click. Rendered
  //    as a smaller secondary line below the action description so the
  //    user learns the "without Copilot" path too.
  if (content.manualHow) {
    const how = document.createElement('div');
    how.className = 'copilot-tutorial-popover-how';
    how.textContent = `Do it yourself: ${content.manualHow}`;
    inner.appendChild(how);
  }

  // 3. Model thinking — surfaces WHY the planner chose this step. Italic,
  //    deemphasized, with a "thinking:" prefix so the user knows it's
  //    machine reasoning vs an instruction.
  if (content.thinking && content.thinking.trim()) {
    const think = document.createElement('div');
    think.className = 'copilot-tutorial-popover-thinking';
    // Strip <think> tags if the model emitted raw markup.
    const cleaned = content.thinking.replace(/<\/?think>/gi, '').trim();
    think.textContent = cleaned;  // labelled "Model thinking" by CSS
    inner.appendChild(think);
  }

  if (opts.waitForClick || content.progress || opts.onEnd) {
    const footer = document.createElement('div');
    footer.className = 'copilot-tutorial-footer';
    const progress = document.createElement('span');
    progress.className = 'copilot-tutorial-progress';
    progress.textContent = content.progress ?? '';
    footer.appendChild(progress);
    if (opts.onEnd) {
      const end = document.createElement('button');
      end.textContent = 'End tour';
      end.className = 'copilot-tutorial-end';
      footer.appendChild(end);
    }
    if (opts.extraAction) {
      const extra = document.createElement('button');
      extra.textContent = opts.extraAction.label;
      extra.className = 'copilot-tutorial-extra';
      footer.appendChild(extra);
    }
    if (opts.waitForClick) {
      const btn = document.createElement('button');
      btn.textContent = opts.nextLabel ?? 'Next →';
      btn.className = 'copilot-tutorial-next';
      footer.appendChild(btn);
    }
    inner.appendChild(footer);
  }
  host.appendChild(inner);
  if (!reused) document.body.appendChild(host);

  // Below the target, else above it, else (a large target such as the reads)
  // over its top; always inside the window.
  const place = () => {
    const w = host.offsetWidth || 320;
    const h = host.offsetHeight || 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    host.style.transform = '';
    host.classList.remove('copilot-tutorial-above', 'copilot-tutorial-floating');
    if (!target || target.getClientRects().length === 0) {
      host.classList.add('copilot-tutorial-floating');
      host.style.left = `${Math.max(8, (vw - w) / 2)}px`;
      host.style.top = `${Math.max(8, vh * 0.28 - h / 2)}px`;
      return;
    }
    const r = target.getBoundingClientRect();
    // About a whole panel (its header, or a whole read panel): beside the panel, so its content stays in view.
    const isPanelHeader = target.hasAttribute('data-panel-header') || target.hasAttribute('data-panel-content-type')
      || target.hasAttribute('data-panel-id');
    if (isPanelHeader && r.left - w - 12 >= 8) {
      host.classList.add('copilot-tutorial-floating');
      host.style.left = `${r.left - w - 12}px`;
      host.style.top = `${Math.min(Math.max(8, r.top + 8), vh - h - 8)}px`;
      return;
    }
    let top = r.bottom + 8;
    if (top + h > vh - 8) {
      if (r.top - h - 8 >= 8) {
        top = r.top - h - 8;
        host.classList.add('copilot-tutorial-above');
      } else {
        top = Math.min(Math.max(8, r.top + 12), vh - h - 8);
        host.classList.add('copilot-tutorial-floating');
      }
    }
    host.style.left = `${Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8))}px`;
    host.style.top = `${top}px`;
  };
  place();
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);

  return new Promise<PopoverOutcome>(resolve => {
    let settled = false;
    // `finished`: the walkthrough is over (End, extra action), so nothing lingers.
    const cleanup = (outcome: PopoverOutcome, finished = false) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (opts.sequence && !finished) {
        // Stay up, dimmed, until the next step (or endPopoverSequence) takes over.
        host.classList.add('copilot-tutorial-waiting');
        host.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = true; });
        lingeringPopover = { host, timer: window.setTimeout(endPopoverSequence, 8000) };
      } else {
        host.remove();
      }
      resolve(outcome);
    };
    host.querySelector('.copilot-tutorial-extra')?.addEventListener('click', () => {
      opts.extraAction?.onClick();
      cleanup('extra', true);
    });
    host.querySelector('.copilot-tutorial-end')?.addEventListener('click', () => {
      opts.onEnd?.();
      cleanup('end', true);
    });
    // A try_it step moves on by itself once the user has done it.
    opts.until?.then(result => cleanup(result));
    if (opts.waitForClick) {
      const btn = host.querySelector('.copilot-tutorial-next');
      btn?.addEventListener('click', () => cleanup(opts.nextLabel === 'Skip' ? 'skip' : 'next'));
      (btn as HTMLButtonElement | null)?.focus();
    } else {
      // Auto-dismiss after the popover-visible window in non-click mode.
      window.setTimeout(() => cleanup('auto'), 1400);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Tutorial-mode flag (localStorage so it persists across reloads).
// ──────────────────────────────────────────────────────────────────────

export const TUTORIAL_MODE_KEY = 'fiberhmm_copilot_tutorial_mode';

export function readTutorialMode(): boolean {
  return readStoredFlag(TUTORIAL_MODE_KEY);
}

export function writeTutorialMode(value: boolean): void {
  writeStoredFlag(TUTORIAL_MODE_KEY, value);
}
