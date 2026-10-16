/**
 * Troubleshooting context for Copilot ("why are no reads visible?").
 *
 * The browser works out concrete causes itself (a filter that matched nothing,
 * a view wider than the read limit, a collapsed panel, ...) and sends them as
 * diagnostics, each with the UI anchor that fixes it. When none of them
 * explains the problem, the compact raw state lets the model reason instead.
 * Copilot only teaches: the fix anchor is what it points the user at.
 */
import type { BrowserState } from '../stores/browserStore';
import type { PanelConfig } from '../types';
import { sameChrom } from './chromAliases';
import { formatBp } from './coordinates';
import { branchScopesPanel, hasActiveClusterFocus, readIdSetForClusterRenderScope, readIdsForClusterFocus } from './readScopes';

export type CopilotDiagnosticSeverity = 'blocking' | 'warning' | 'info';

/** UI anchors a diagnostic can point at (defined in data/tutorialAnchors.json). */
export type CopilotFixAnchor =
  | 'search-bar' | 'genome-selector' | 'load-dataset' | 'load-gtf' | 'load-fasta'
  | 'zoom-out' | 'read-window-setting' | 'clear-filter' | 'cluster-focus-bar'
  | 'panel-expand' | 'layout-rows' | 'quality-filters' | 'spanning-toggle'
  | 'strand-chip' | 'layer-toggles' | 'scan-peaks-button' | 'cluster-button';

export interface CopilotDiagnostic {
  code: string;
  severity: CopilotDiagnosticSeverity;
  message: string;
  panel_id?: string;
  dataset_id?: string;
  fix_anchor?: CopilotFixAnchor;
}

export interface CopilotDiagnosticExtras {
  /** Chromosome names each dataset's files contain, when known. */
  datasetChroms?: Record<string, string[]>;
  /** Whether a gene annotation (GTF) is loaded, when known. */
  gtfLoaded?: boolean;
}

/** The store fields the diagnostics read (a BrowserState satisfies it). */
export type DiagnosticState = Pick<BrowserState,
  | 'chrom' | 'start' | 'end' | 'chroms' | 'hasFasta' | 'currentGenome'
  | 'datasets' | 'panels' | 'collapsedRows' | 'fullViewPanelId'
  | 'maxRegionForReads' | 'readTrackStatus' | 'filteredReadIds'
  | 'clusterAssignments' | 'clusterFocus' | 'activeClusterTreeNodeId' | 'clusterTreeNodes'
  | 'spanningOnly' | 'minFootprints' | 'minFpQuality' | 'activeColormap' | 'enabledModTypes'
>;

const MAX_DIAGNOSTICS = 16;
const SEVERITY_RANK: Record<CopilotDiagnosticSeverity, number> = { blocking: 0, warning: 1, info: 2 };

const rowOf = (panel: PanelConfig) => panel.layoutRow ?? (panel.layoutPosition === 'column' ? 1 : 0);

function datasetPanels(state: DiagnosticState): PanelConfig[] {
  return state.panels.filter(p => p.contentType === 'dataset' && p.datasetId);
}

function qualitySettingsActive(state: DiagnosticState): boolean {
  const filters = state.activeColormap?.qualityFilters ?? [];
  return state.minFootprints > 0 || state.minFpQuality > 0
    || filters.some(f => f.enabled && f.minValue > 0);
}

function panelHidden(state: DiagnosticState, panel: PanelConfig): boolean {
  return panel.collapsed
    || state.collapsedRows.has(rowOf(panel))
    || (state.fullViewPanelId != null && state.fullViewPanelId !== panel.id);
}

export function computeCopilotDiagnostics(
  state: DiagnosticState,
  extras: CopilotDiagnosticExtras = {},
): CopilotDiagnostic[] {
  const out: CopilotDiagnostic[] = [];
  const labelOf = (datasetId: string) => state.datasets.find(d => d.id === datasetId)?.label ?? datasetId;

  if (state.datasets.length === 0) {
    out.push({ code: 'no_datasets', severity: 'blocking', message: 'No dataset is loaded, so there are no reads to show.', fix_anchor: 'load-dataset' });
  }
  if (!state.hasFasta && !state.currentGenome) {
    const nothing = state.chroms.length === 0 && state.datasets.length === 0;
    out.push({
      code: 'no_reference',
      severity: nothing ? 'blocking' : 'info',
      message: nothing
        ? 'No genome or reference is loaded, so there are no chromosomes to browse.'
        : 'No reference genome/FASTA is loaded; sequence, primers and motif scans need one.',
      fix_anchor: 'genome-selector',
    });
  }
  if (extras.gtfLoaded === false) {
    out.push({ code: 'no_gtf', severity: 'info', message: 'No gene annotation (GTF) is loaded, so genes can\'t be searched or drawn.', fix_anchor: 'load-gtf' });
  }
  const layers = state.enabledModTypes ?? {};
  if (state.datasets.length > 0 && layers.footprint === false && layers.nuc === false) {
    out.push({
      code: 'layers_hidden',
      severity: layers.tf === false ? 'blocking' : 'warning',
      message: layers.tf === false
        ? 'The footprint, nucleosome and TF layers are all switched off, so reads show no footprints.'
        : 'The footprint and nucleosome layers are switched off, so reads show only TF calls.',
      fix_anchor: 'layer-toggles',
    });
  }

  const panels = datasetPanels(state);
  const allHidden = panels.length > 0 && panels.every(p => panelHidden(state, p));
  const branch = state.activeClusterTreeNodeId ? state.clusterTreeNodes[state.activeClusterTreeNodeId] : null;
  const qualityActive = qualitySettingsActive(state);

  for (const panel of panels) {
    const datasetId = panel.datasetId!;
    const key = panel.stateKey ?? datasetId;
    const label = labelOf(datasetId);
    const at = { panel_id: panel.id, dataset_id: datasetId };

    if (panel.collapsed) {
      out.push({ code: 'panel_collapsed', severity: allHidden ? 'blocking' : 'info', message: `The "${label}" panel is minimized.`, fix_anchor: 'panel-expand', ...at });
      continue;
    }
    if (state.collapsedRows.has(rowOf(panel))) {
      out.push({ code: 'row_collapsed', severity: allHidden ? 'blocking' : 'info', message: `The layout row holding "${label}" is collapsed.`, fix_anchor: 'layout-rows', ...at });
      continue;
    }
    if (state.fullViewPanelId != null && state.fullViewPanelId !== panel.id) {
      out.push({ code: 'panel_collapsed', severity: allHidden ? 'blocking' : 'info', message: `Another panel is maximized, so "${label}" is hidden.`, fix_anchor: 'panel-expand', ...at });
      continue;
    }

    const v = panel.viewportOverride;
    const view = v ?? { chrom: state.chrom, start: state.start, end: state.end };
    if (v && (!sameChrom(v.chrom, state.chrom) || v.start !== state.start || v.end !== state.end)) {
      out.push({ code: 'panel_at_other_locus', severity: 'info', message: `The "${label}" panel shows its own region (a copy), not the main view.`, ...at });
    }
    const width = view.end - view.start;
    if (width > state.maxRegionForReads && !panel.linkedSessionId) {
      out.push({
        code: 'zoomed_out_past_reads',
        severity: 'blocking',
        message: `"${label}" shows ${formatBp(width)}; reads are drawn only up to ${formatBp(state.maxRegionForReads)}, so it shows coverage instead. Zoom in or raise the read window.`,
        fix_anchor: 'read-window-setting',
        ...at,
      });
      continue;
    }
    const known = extras.datasetChroms?.[datasetId];
    if (known && known.length > 0 && view.chrom && !known.some(c => sameChrom(c, view.chrom))) {
      out.push({ code: 'chrom_missing_in_dataset', severity: 'blocking', message: `"${label}" has no reads on ${view.chrom} (its files don't contain that chromosome).`, fix_anchor: 'search-bar', ...at });
      continue;
    }

    const status = state.readTrackStatus?.[key];
    if (!status) continue;
    if (status.fetchFailed) {
      out.push({ code: 'fetch_failed', severity: 'blocking', message: `Reads for "${label}" failed to load${status.warning ? `: ${status.warning}` : '.'}`, ...at });
      continue;
    }
    if (status.loading || status.stale) {
      out.push({ code: 'still_loading', severity: 'info', message: `Reads for "${label}" are still loading.`, ...at });
      continue;
    }

    const filter = state.filteredReadIds[key];
    if (filter != null && filter.size === 0) {
      out.push({ code: 'filter_matches_none', severity: 'blocking', message: `A read filter on "${label}" matched no reads, so none are shown.`, fix_anchor: 'clear-filter', ...at });
    } else if (filter != null && status.displayed < status.working) {
      out.push({ code: 'filter_active', severity: 'warning', message: `A read filter on "${label}" shows ${status.displayed} of ${status.working} reads.`, fix_anchor: 'clear-filter', ...at });
    }

    const assignments = state.clusterAssignments[key];
    const focus = state.clusterFocus[key];
    if (hasActiveClusterFocus(focus)) {
      const focused = readIdsForClusterFocus(assignments, focus) ?? [];
      if (focused.length === 0 || (status.displayed === 0 && filter == null && status.working > 0)) {
        out.push({ code: 'focus_hides_all', severity: 'blocking', message: `The cluster focus on "${label}" leaves no reads visible.`, fix_anchor: 'cluster-focus-bar', ...at });
      }
    }
    if (branchScopesPanel(branch, key)) {
      const scoped = readIdSetForClusterRenderScope(assignments, focus, true);
      if (!scoped || scoped.size === 0) {
        out.push({ code: 'branch_scope_empty', severity: 'blocking', message: `The active cluster branch holds no reads for "${label}".`, fix_anchor: 'cluster-focus-bar', ...at });
      }
    }

    if (panel.strand && status.inScope === 0) {
      out.push({ code: 'strand_panel_empty', severity: 'blocking', message: `The ${panel.strand}-strand panel of "${label}" has no reads of that strand here.`, fix_anchor: 'strand-chip', ...at });
      continue;
    }
    if (!panel.strand && status.inScope === 0 && status.overlapping === 0) {
      out.push({ code: 'no_reads_in_region', severity: 'blocking', message: `"${label}" has no reads in this region.`, fix_anchor: 'search-bar', ...at });
      continue;
    }
    if (state.spanningOnly && status.overlapping > 0) {
      if (status.spanning === 0) {
        out.push({ code: 'spanning_only_hides', severity: 'blocking', message: `Spanning-only is on and none of the ${status.overlapping} reads in "${label}" span the whole view.`, fix_anchor: 'spanning-toggle', ...at });
      } else if (status.spanning < status.overlapping * 0.25) {
        out.push({ code: 'spanning_only_hides', severity: 'warning', message: `Spanning-only is on: ${status.spanning} of ${status.overlapping} reads in "${label}" span the whole view.`, fix_anchor: 'spanning-toggle', ...at });
      }
    }
    if (qualityActive && status.inScope > 0) {
      if (status.working === 0) {
        out.push({ code: 'quality_filter_hides_all', severity: 'blocking', message: `The read quality settings remove every read in "${label}".`, fix_anchor: 'quality-filters', ...at });
      } else if (!panel.strand && status.working < status.inScope * 0.5) {
        out.push({ code: 'quality_filter_hides_all', severity: 'warning', message: `The read quality settings remove ${status.inScope - status.working} of ${status.inScope} reads in "${label}".`, fix_anchor: 'quality-filters', ...at });
      }
    }
  }

  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => SEVERITY_RANK[a.d.severity] - SEVERITY_RANK[b.d.severity] || a.i - b.i)
    .slice(0, MAX_DIAGNOSTICS)
    .map(({ d }) => d);
}

/** The compact state the model gets when no diagnostic explains the problem. */
export function computeCopilotRawState(
  state: DiagnosticState & Partial<Pick<BrowserState, 'clusterMethod' | 'clusterK'>>,
  extras: CopilotDiagnosticExtras = {},
): Record<string, unknown> {
  const layers = Object.fromEntries(
    Object.entries(state.enabledModTypes ?? {}).filter(([, on]) => typeof on === 'boolean').slice(0, 10),
  );
  const branch = state.activeClusterTreeNodeId ? state.clusterTreeNodes[state.activeClusterTreeNodeId] : null;
  return {
    viewport: { chrom: state.chrom, start: state.start, end: state.end },
    genome: state.currentGenome ?? null,
    reference_loaded: Boolean(state.hasFasta || state.currentGenome),
    ...(extras.gtfLoaded !== undefined ? { gtf_loaded: extras.gtfLoaded } : {}),
    datasets: state.datasets.slice(0, 6).map(d => ({
      id: d.id,
      label: d.label,
      type: d.data_type ?? 'unknown',
      ...(extras.datasetChroms?.[d.id] ? { chroms: extras.datasetChroms[d.id].slice(0, 8) } : {}),
    })),
    panels: datasetPanels(state).slice(0, 6).map(p => {
      const key = p.stateKey ?? p.datasetId!;
      const status = state.readTrackStatus?.[key];
      const filter = state.filteredReadIds[key];
      const focus = state.clusterFocus[key];
      const v = p.viewportOverride;
      return {
        id: p.id,
        dataset_id: p.datasetId,
        hidden: panelHidden(state, p),
        ...(p.strand ? { strand: p.strand } : {}),
        ...(v ? { own_view: { chrom: v.chrom, start: v.start, end: v.end } } : {}),
        filter: filter == null ? 'none' : filter.size,
        ...(hasActiveClusterFocus(focus) ? { focus: [...focus].slice(0, 8) } : {}),
        clustered: Object.keys(state.clusterAssignments[key] ?? {}).length > 0,
        ...(status ? {
          reads: {
            shown: status.displayed, working: status.working, in_scope: status.inScope,
            overlapping: status.overlapping, spanning: status.spanning,
            ...(status.loading ? { loading: true } : {}),
            ...(status.fetchFailed ? { failed: true } : {}),
            ...(status.zoomedOut ? { zoomed_out: true } : {}),
          },
        } : {}),
      };
    }),
    settings: {
      spanning_only: state.spanningOnly,
      read_window_bp: state.maxRegionForReads,
      min_footprints: state.minFootprints,
      min_fp_quality: state.minFpQuality,
      quality_filters: (state.activeColormap?.qualityFilters ?? [])
        .filter(f => f.enabled).slice(0, 4)
        .map(f => `${f.layer}:${f.qualityName}>=${f.minValue}`),
      layers,
    },
    clustering: {
      ...(state.clusterMethod ? { method: state.clusterMethod } : {}),
      ...(state.clusterK ? { k: state.clusterK } : {}),
      ...(branch ? { active_branch: Boolean(branch.parentId) } : {}),
    },
  };
}
