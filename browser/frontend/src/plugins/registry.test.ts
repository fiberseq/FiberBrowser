import { describe, expect, it } from 'vitest';
import './builtinPanels';
import {
  describePanelProvenance,
  findOpenAnalysisPanel,
  getAnalysisPanel,
  getAnalysisPanelLabel,
  getGroupedAnalysisPanels,
  getPanelSettingsLinks,
  getSettingsTargetLink,
  normalizeAnalysisPanelContentTypes,
} from './registry';

describe('analysis panel registry metadata', () => {
  it('exposes reproducibility metadata for core panels', () => {
    const cluster = getAnalysisPanel('cluster-detail');
    const clusterFeatures = getAnalysisPanel('cluster-features');
    const peaks = getAnalysisPanel('peak-detection');
    const tracks = getAnalysisPanel('track-browser');

    expect(cluster?.sessionKeys).toContain('clusterAssignments');
    expect(clusterFeatures?.sessionKeys).toContain('clusterFeatureRules');
    expect(peaks?.sessionKeys).toContain('peaksLocked');
    expect(tracks?.apiEndpoints).toContain('/api/catalog');
  });

  it('includes provenance details in strip tooltips', () => {
    const description = describePanelProvenance('footprint-analysis');

    expect(description).toContain('Settings:');
    expect(description).toContain('Session:');
    expect(description).toContain('/api/footprint/analyze');
  });

  it('groups panels as Analyze, View and Tools in a fixed order', () => {
    const groups = getGroupedAnalysisPanels();

    expect(groups.map(group => group.group)).toEqual(['analysis', 'view', 'tools']);
    expect(groups.map(group => group.label)).toEqual(['Analyze', 'View', 'Tools']);
    const ids = (g: string) => groups.find(group => group.group === g)!.plugins.map(plugin => plugin.contentType);
    expect(ids('analysis').slice(0, 5)).toEqual(['cluster-detail', 'footprint-analysis', 'transcription-state', 'read-stats', 'co-accessibility']);
    expect(ids('view').slice(0, 5)).toEqual(['track-browser', 'colormap', 'cluster-features', 'dataset-layout', 'circular-genome']);
    expect(groups.flatMap(group => group.plugins.map(plugin => plugin.contentType))).toContain('colormap');
  });

  it('routes settings provenance chips to panels or sidebar sections', () => {
    const clusterLinks = getPanelSettingsLinks('cluster-detail');
    const peakLink = clusterLinks.find(link => link.label === 'Peak Detection');
    const reproducibilityLink = getSettingsTargetLink('Analysis & Reproducibility');
    const unknownLink = getSettingsTargetLink('Experimental Controls');

    expect(clusterLinks.map(link => link.label)).toEqual([
      'Clustering',
      'Peak Detection',
      'Labeling & Quality',
    ]);
    expect(peakLink?.panelType).toBe('cluster-features');
    expect(peakLink?.sectionId).toBe('analysis');
    expect(reproducibilityLink).toMatchObject({
      sectionId: 'analysis',
      subsectionId: 'analysis.reproducibility',
    });
    expect(unknownLink).toMatchObject({
      label: 'Experimental Controls',
      sectionId: 'analysis',
      title: 'Open settings related to Experimental Controls',
    });
  });

  it('normalizes panel ids for saved settings and notebook commands', () => {
    expect(normalizeAnalysisPanelContentTypes([
      'history',
      'dataset',
      'not-real',
      'history',
      null,
      'annotations',
    ])).toEqual(['history', 'annotations']);

    expect(getAnalysisPanelLabel('cluster-detail')).toBe('Clusters');
    expect(getAnalysisPanelLabel('cluster-detail', true)).toBe('Clusters');
    expect(getAnalysisPanelLabel('not-real')).toBe('not-real');

    const panel = findOpenAnalysisPanel([
      { id: 'closed', contentType: 'history', collapsed: true },
      { id: 'open', contentType: 'history', collapsed: false },
      { id: 'dataset', contentType: 'dataset', collapsed: false },
    ], 'history');

    expect(panel?.id).toBe('open');
    expect(findOpenAnalysisPanel([], 'not-real')).toBeUndefined();
  });
});
