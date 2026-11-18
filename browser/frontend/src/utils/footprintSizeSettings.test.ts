/**
 * Footprint size plots' settings: the two one-click views, older V-plot settings read as the new ones (the single
 * smooth sigma in bins becomes a sigma in bp per axis), session save and restore (older sessions: the defaults),
 * and the entry points that open the Size enrichment view.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { applyImportedState, collectFrontendState } from '../api/session';
import {
  DEFAULT_FOOTPRINT_SIZE_SETTINGS, FOOTPRINT_SIZE_VIEW_HELP, FOOTPRINT_SIZE_VIEW_PRESETS, footprintSizeCaption, matchingView,
  normalizeFootprintSizeSettings, withView,
} from './footprintSizeSettings';
import { openFootprintSizes, useFootprintSizesInvokedFrom } from './footprintSizeEntry';
import { APP_COMMAND_INFO, runAppCommand } from './appCommands';

describe('footprint size settings', () => {
  beforeEach(() => {
    useBrowserStore.setState({ footprintSizeSettings: DEFAULT_FOOTPRINT_SIZE_SETTINGS } as never);
  });

  it('defaults to the Size enrichment view: full footprint, per size row, Gaussian smoothing, guard 20', () => {
    const d = DEFAULT_FOOTPRINT_SIZE_SETTINGS;
    expect(matchingView(d)).toBe('enrichment');
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
    expect(matchingView(v)).toBe('vplot');
    const e = withView(v, 'enrichment');
    expect(e).toMatchObject(FOOTPRINT_SIZE_VIEW_PRESETS.enrichment);
    // Edited away from both presets: no view is shown as current.
    expect(matchingView({ ...e, sigmaPosBp: 55 })).toBeNull();
  });

  it('each view has a one-sentence tooltip', () => {
    for (const text of Object.values(FOOTPRINT_SIZE_VIEW_HELP)) {
      expect(text.split(/\.\s/).length).toBe(1);
      expect(text.length).toBeGreaterThan(40);
    }
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

  it('saves with the session and restores; an older session without them restores the defaults', () => {
    useBrowserStore.getState().setFootprintSizeSettings({ normalization: 'oe', sigmaSizeBp: 0, sigmaPosBp: 35, sizeBin: 5, ratio: ['a|all', 'b|all'] });
    const saved = collectFrontendState();
    expect((saved.footprintSizeSettings as Record<string, unknown>).sigmaPosBp).toBe(35);
    useBrowserStore.getState().setFootprintSizeSettings({ normalization: 'raw', sigmaPosBp: 10 });
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved });
    expect(useBrowserStore.getState().footprintSizeSettings).toMatchObject({
      normalization: 'oe', sigmaSizeBp: 0, sigmaPosBp: 35, sizeBin: 5, ratio: ['a|all', 'b|all'],
    });
    const older = { ...saved };
    delete older.footprintSizeSettings;
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: older });
    expect(useBrowserStore.getState().footprintSizeSettings).toEqual(DEFAULT_FOOTPRINT_SIZE_SETTINGS);
  });
});

describe('entry points', () => {
  beforeEach(() => {
    useBrowserStore.setState({ footprintSizeSettings: withView(DEFAULT_FOOTPRINT_SIZE_SETTINGS, 'vplot') } as never);
    window.sessionStorage.clear();
  });

  it('open the Clusters panel on Footprint sizes in the Size enrichment view, for the panel asked from', async () => {
    const open = vi.spyOn(useBrowserStore.getState(), 'openAnalysisPanel');
    useBrowserStore.setState({ openAnalysisPanel: open } as never);
    const events: string[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail.tab);
    window.addEventListener('fiberbrowser:open-cluster-detail-tab', listener);
    openFootprintSizes({ panelId: 'p2' });
    await Promise.resolve();
    window.removeEventListener('fiberbrowser:open-cluster-detail-tab', listener);
    expect(matchingView(useBrowserStore.getState().footprintSizeSettings)).toBe('enrichment');
    expect(open).toHaveBeenCalledWith('cluster-detail');
    expect(window.sessionStorage.getItem('fiberbrowser_cluster_detail_tab')).toBe('vplot');
    expect(events).toEqual(['vplot']);
    expect(useFootprintSizesInvokedFrom.getState().panelId).toBe('p2');
  });

  it('are found by name in the command palette and need a dataset, not clusters', () => {
    const info = APP_COMMAND_INFO['footprint-size-enrichment']!;
    expect(info.label).toBe('Footprint size enrichment');
    expect(info.keywords).toEqual(expect.arrayContaining(['size enrichment', 'footprint sizes', 'v-plot']));
    useBrowserStore.setState({ datasets: [], clusterAssignments: {} } as never);
    expect(info.disabledReason?.()).toMatch(/dataset/);
    useBrowserStore.setState({ datasets: [{ id: 'd' }] } as never);
    expect(info.disabledReason?.()).toBeNull();
    useBrowserStore.setState({ openAnalysisPanel: vi.fn() } as never);
    expect(runAppCommand('footprint-vplot')).toBe(true);
    expect(matchingView(useBrowserStore.getState().footprintSizeSettings)).toBe('vplot');
    expect(runAppCommand('footprint-size-enrichment')).toBe(true);
    expect(matchingView(useBrowserStore.getState().footprintSizeSettings)).toBe('enrichment');
  });
});
