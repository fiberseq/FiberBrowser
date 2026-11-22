/**
 * Footprint size plots' settings: the two view presets, older V-plot settings read as the new ones (the single
 * smooth sigma in bins becomes a sigma in bp per axis); 3.0.4–3.1.0 sessions with the retired Clusters › Footprint
 * sizes tab's settings load cleanly; the entry points (read menu, ⌘K, the Clusters panel) open Plots.
 */
import '../features/testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { applyImportedState, collectFrontendState } from '../api/session';
import {
  DEFAULT_FOOTPRINT_SIZE_SETTINGS, FOOTPRINT_SIZE_VIEW_PRESETS, footprintSizeCaption, normalizeFootprintSizeSettings, withView,
  type FootprintSizeSettings,
} from './footprintSizeSettings';
import { openFootprintSizes } from './footprintSizeEntry';
import { APP_COMMAND_INFO, runAppCommand } from './appCommands';
import { closePlots, useWorkspaceStore } from '../features/plots/workspace';

const isPreset = (s: FootprintSizeSettings, view: 'enrichment' | 'vplot') => {
  const p = FOOTPRINT_SIZE_VIEW_PRESETS[view];
  return s.mode === p.mode && s.normalization === p.normalization && s.sigmaSizeBp === p.sigmaSizeBp && s.sigmaPosBp === p.sigmaPosBp;
};

describe('footprint size settings', () => {
  it('defaults to the Size enrichment view: full footprint, per size row, Gaussian smoothing, guard 20', () => {
    const d = DEFAULT_FOOTPRINT_SIZE_SETTINGS;
    expect(isPreset(d, 'enrichment')).toBe(true);
    expect(d).toMatchObject({ mode: 'span', normalization: 'row', minFootprints: 20, scale: 'shared', log: true, layer: 'all_footprints' });
    // Every footprint by default. Older sources: the calls only (null / '') are the Nuc layer; msp is the
    // accessibility layer's key; TF and All footprints are kept.
    expect(normalizeFootprintSizeSettings({}).layer).toBe('all_footprints');
    expect(normalizeFootprintSizeSettings({ layer: null }).layer).toBe('nuc');
    expect(normalizeFootprintSizeSettings({ layer: '' }).layer).toBe('nuc');
    expect(normalizeFootprintSizeSettings({ layer: 'tf' }).layer).toBe('tf');
    expect(normalizeFootprintSizeSettings({ layer: 'all_footprints' }).layer).toBe('all_footprints');
    expect(normalizeFootprintSizeSettings({ layer: 'msp' }).layer).toBe('fire');
    expect(normalizeFootprintSizeSettings({ layer: 7 }).layer).toBe('all_footprints');
    expect(d.sigmaSizeBp).toBeGreaterThan(0);
    expect(d.sigmaPosBp).toBeGreaterThan(0);
  });

  it('one click switches between the two views and keeps the other settings', () => {
    const custom = { ...DEFAULT_FOOTPRINT_SIZE_SETTINGS, sizeBin: 5, sizeMax: 400, minFootprints: 50 };
    const v = withView(custom, 'vplot');
    expect(v).toMatchObject({ view: 'vplot', mode: 'midpoint', normalization: 'raw', sizeBin: 5, sizeMax: 400, minFootprints: 50 });
    expect(isPreset(v, 'vplot')).toBe(true);
    const e = withView(v, 'enrichment');
    expect(e).toMatchObject(FOOTPRINT_SIZE_VIEW_PRESETS.enrichment);
    expect(isPreset({ ...e, sigmaPosBp: 55 }, 'enrichment')).toBe(false);
  });

  it('reads the older single smooth (sigma in bins, both axes) as sigma in bp per axis', () => {
    const s = normalizeFootprintSizeSettings({ smooth: 1.5, sizeBin: 5, posBin: 20, rowNormalize: true, logNorm: false });
    expect(s.sigmaSizeBp).toBe(7.5);
    expect(s.sigmaPosBp).toBe(30);
    expect(s.normalization).toBe('row');
    expect(s.log).toBe(false);
    // Explicit sigmas win over smooth; 0 turns an axis off.
    const t = normalizeFootprintSizeSettings({ smooth: 2, sigmaSizeBp: 0, sigmaPosBp: 40 });
    expect([t.sigmaSizeBp, t.sigmaPosBp]).toEqual([0, 40]);
    // Malformed values fall back to the defaults.
    const bad = normalizeFootprintSizeSettings({ normalization: 'zscore', sizeBin: 'x', sigmaPosBp: -3, ratio: ['a', 'a'] });
    expect(bad.normalization).toBe(DEFAULT_FOOTPRINT_SIZE_SETTINGS.normalization);
    expect(bad.sizeBin).toBe(DEFAULT_FOOTPRINT_SIZE_SETTINGS.sizeBin);
    expect(bad.sigmaPosBp).toBe(0);
    expect(bad.ratio).toBeNull();
    expect(normalizeFootprintSizeSettings(null)).toEqual(DEFAULT_FOOTPRINT_SIZE_SETTINGS);
  });

  it('the caption names the guard it applies', () => {
    expect(footprintSizeCaption(DEFAULT_FOOTPRINT_SIZE_SETTINGS)).toMatch(/Full footprint.*enrichment.*under 20 footprints/);
    expect(footprintSizeCaption({ ...DEFAULT_FOOTPRINT_SIZE_SETTINGS, minFootprints: 5, normalization: 'column' }))
      .toMatch(/positions with under 5 footprints/);
    expect(footprintSizeCaption(withView(DEFAULT_FOOTPRINT_SIZE_SETTINGS, 'vplot'))).toMatch(/Midpoint.*footprint count\.$/);
  });

  it('a 3.0.4–3.1.0 session carrying the retired tab\'s settings loads cleanly; they are not kept or saved again', () => {
    const saved = collectFrontendState();
    expect('footprintSizeSettings' in saved).toBe(false);
    const legacy = { ...saved, footprintSizeSettings: { ...withView(DEFAULT_FOOTPRINT_SIZE_SETTINGS, 'vplot'), groupBy: 'clusters' } };
    expect(() => applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: legacy })).not.toThrow();
    expect('footprintSizeSettings' in useBrowserStore.getState()).toBe(false);
    expect('footprintSizeSettings' in collectFrontendState()).toBe(false);
  });
});

describe('entry points: Plots', () => {
  beforeEach(() => {
    closePlots();
    useBrowserStore.setState({ clusterAssignments: {}, datasets: [{ id: 'd' }] } as never);
  });

  it('with no clusters: Size enrichment by dataset, following the view', () => {
    expect(openFootprintSizes()).toBe(true);
    expect(useWorkspaceStore.getState().view).toBe('plots');
    const plot = useBrowserStore.getState().plotsWorkspace.current;
    expect(plot).toMatchObject({ type: 'size-enrichment', where: 'view', groupBy: 'dataset', pinned: null });
    expect(isPreset(plot.size, 'enrichment')).toBe(true);
  });

  it('with clusters: by cluster, pinned to the clustered locus (given, or the store\'s clustered view)', () => {
    useBrowserStore.setState({ clusterAssignments: { d: { r1: 0, r2: 1 } }, chrom: 'chrT', start: 100, end: 900 } as never);
    openFootprintSizes({ view: 'vplot' });
    let plot = useBrowserStore.getState().plotsWorkspace.current;
    expect(plot).toMatchObject({ type: 'vplot', groupBy: 'cluster', pinned: { chrom: 'chrT', start: 100, end: 900, genome: null } });
    expect(isPreset(plot.size, 'vplot')).toBe(true);
    openFootprintSizes({ clusterLocus: { chrom: 'chrT', start: 200, end: 400, genome: null } });
    plot = useBrowserStore.getState().plotsWorkspace.current;
    expect(plot).toMatchObject({ type: 'size-enrichment', groupBy: 'cluster', pinned: { chrom: 'chrT', start: 200, end: 400 } });
  });

  it('groups by cluster only when the panels in focus are clustered (as Plots does); byDataset forces datasets', () => {
    const panel = (id: string, datasetId: string) => ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 });
    useBrowserStore.setState({
      datasets: [{ id: 'a', data_type: 'bam' }, { id: 'b', data_type: 'bam' }], panels: [panel('pa', 'a'), panel('pb', 'b')],
      clusterAssignments: { a: { r1: 0, r2: 1 } }, selectedDatasets: new Set(['pb']), chrom: 'chrT', start: 100, end: 900,
    } as never);
    openFootprintSizes();
    expect(useBrowserStore.getState().plotsWorkspace.current.groupBy).toBe('dataset');
    useBrowserStore.setState({ selectedDatasets: new Set() } as never);
    openFootprintSizes();
    expect(useBrowserStore.getState().plotsWorkspace.current.groupBy).toBe('cluster');
    openFootprintSizes({ byDataset: true });
    expect(useBrowserStore.getState().plotsWorkspace.current).toMatchObject({ groupBy: 'dataset', pinned: null });
  });

  it('are found by name in the command palette and need a dataset, not clusters', () => {
    const info = APP_COMMAND_INFO['footprint-size-enrichment']!;
    expect(info.label).toBe('Footprint size enrichment');
    expect(info.keywords).toEqual(expect.arrayContaining(['size enrichment', 'footprint sizes', 'v-plot']));
    useBrowserStore.setState({ datasets: [], clusterAssignments: {} } as never);
    expect(info.disabledReason?.()).toMatch(/dataset/);
    useBrowserStore.setState({ datasets: [{ id: 'd' }] } as never);
    expect(info.disabledReason?.()).toBeNull();
    expect(runAppCommand('footprint-vplot')).toBe(true);
    expect(useBrowserStore.getState().plotsWorkspace.current.type).toBe('vplot');
    expect(runAppCommand('footprint-size-enrichment')).toBe(true);
    expect(useBrowserStore.getState().plotsWorkspace.current.type).toBe('size-enrichment');
    expect(useWorkspaceStore.getState().view).toBe('plots');
  });
});
