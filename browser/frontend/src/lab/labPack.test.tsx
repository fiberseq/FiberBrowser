/**
 * The lab pack's contributions through the core extension points: the NFR Accessibility (preview) panel, its rows and
 * its feature kinds. The insertion and variant features are core's (features/), not the pack's.
 */
import './testSetup';
import { afterEach, describe, expect, it } from 'vitest';
import { getAnalysisPanel } from '../plugins/registry';
import { buildFlavor, loadedPacks, packDeclarations } from '../plugins/packRegistry';
import { featureKindDef } from '../stores/featureStore';
import { previewHidden, resetPreviewsForTests } from '../utils/previewFeatures';
import { trackMenuItems } from '../components/tracks/trackRegistry';

describe('the lab pack', () => {
  afterEach(() => resetPreviewsForTests());

  it('ships in the public build with the legacy session declarations', () => {
    expect(loadedPacks().map(p => p.name)).toEqual(['lab']);
    expect(buildFlavor()).toBe('public');
    const decl = packDeclarations().find(d => d.name === 'lab')!;
    expect(decl.panels).toEqual(['accessibility', 'sync-regions']);
    // the NFR pair arcs are drawn on the NFR track: no row of their own (sessions with the old 'nfr' row drop it)
    expect(decl.tracks).toEqual(['nfr-variants', 'sync-anchor']);
    expect(decl.tracks).not.toContain('snps');
    expect(decl.features).toEqual(expect.arrayContaining(['nfr', 'nfr-variant']));
    expect(decl.features).not.toContain('sv');
    expect(decl.panelFields).toEqual([]);
    expect(decl.panelOwners).toEqual([]);
  });

  it('the NFR panel', () => {
    expect(getAnalysisPanel('accessibility')?.label).toBe('NFRs');
    expect(featureKindDef('nfr-variant')?.layerLabel).toBe('accessibility');
  });

  it('keeps NFRs, Synchronise and matched-region actions available with previews off', () => {
    resetPreviewsForTests(false);
    for (const type of ['accessibility', 'sync-regions']) {
      const panel = getAnalysisPanel(type)!;
      expect(panel).toBeDefined();
      expect(previewHidden(panel.preview)).toBe(false);
    }
    const items = trackMenuItems('fire', { panel: {} as never, type: 'fire', datasetId: null, stateKey: null });
    expect(items.find(item => item.id === 'sync-link-matched')?.label).toBe('Link as matched');
  });
});
