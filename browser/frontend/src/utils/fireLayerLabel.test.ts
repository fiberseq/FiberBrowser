import { afterEach, describe, expect, it } from 'vitest';
import {
  accessibilityLabel, accessibilityMode, datasetHasFireScores, getCanonicalLayerEntries, getDatasetLayerLabel,
  getLayerLabel, getMetaprofileSourceEntries, setAccessibilityLabelSource,
} from './layerColors';
import { useBrowserStore } from '../stores/browserStore';
import { getDatasetHoverLabel } from './datasetLabels';

// Owner (18 Nov): the accessibility (MSP) layer reads "FIRE" when the file's MSP
// scores are FIRE scores. Label only: the layer ids stay msp/fire.
const FIRE_BAM = { available_layers: { nuc: true, fire: true, msp: false } };
const PLAIN_BAM = { available_layers: { nuc: true, fire: false, msp: true } };
const FIRE_BB = { layer_type: 'fire', available_layers: {} };
const NUC_ONLY = { available_layers: { nuc: true } };

describe('accessibility layer label', () => {
  afterEach(() => setAccessibilityLabelSource([]));

  it('decides FIRE per dataset from the backend verdict (available_layers.fire) or a FIRE bigBed', () => {
    expect(datasetHasFireScores(FIRE_BAM)).toBe(true);
    expect(datasetHasFireScores(FIRE_BB)).toBe(true);
    expect(datasetHasFireScores(PLAIN_BAM)).toBe(false);
    expect(datasetHasFireScores(null)).toBe(false);
  });

  it('names the layer for the datasets that have it: all FIRE, none, or a mix', () => {
    expect(accessibilityMode([FIRE_BAM, FIRE_BB])).toBe('fire');
    expect(accessibilityMode([PLAIN_BAM])).toBe('accessibility');
    expect(accessibilityMode([FIRE_BAM, PLAIN_BAM])).toBe('mixed');
    // A dataset without the layer doesn't make the session "mixed".
    expect(accessibilityMode([FIRE_BAM, NUC_ONLY])).toBe('fire');
    expect(accessibilityMode([])).toBe('accessibility');
    expect(accessibilityLabel('fire')).toBe('FIRE');
    expect(accessibilityLabel('fire', { long: true })).toBe('FIRE elements');
    expect(accessibilityLabel('mixed')).toBe('Accessibility / FIRE');
    expect(accessibilityLabel('accessibility')).toBe('Accessibility');
  });

  it('getLayerLabel names msp and fire alike, for given datasets; other layers are unchanged', () => {
    for (const key of ['msp', 'fire']) {
      expect(getLayerLabel(key, [FIRE_BAM])).toBe('FIRE');
      expect(getLayerLabel(key, [PLAIN_BAM])).toBe('Accessibility');
      expect(getLayerLabel(key, [FIRE_BAM, PLAIN_BAM])).toBe('Accessibility / FIRE');
    }
    expect(getLayerLabel('nuc', [FIRE_BAM])).toBe('Nuc');
  });

  it('per-dataset label: FIRE for a FIRE file, Accessibility otherwise, even in a mixed session', () => {
    setAccessibilityLabelSource([FIRE_BAM, PLAIN_BAM]);
    expect(getDatasetLayerLabel('msp', FIRE_BAM)).toBe('FIRE');
    expect(getDatasetLayerLabel('fire', PLAIN_BAM)).toBe('Accessibility');
    expect(getDatasetLayerLabel('tf', FIRE_BAM)).toBe('TF');
  });

  it('global controls (layer toggles, metaprofile sources) say FIRE, Accessibility or both; keys stay "fire"', () => {
    const fireEntry = (datasets: any[]) => getCanonicalLayerEntries(datasets).find(e => e.key === 'fire');
    expect(fireEntry([FIRE_BAM])?.label).toBe('FIRE');
    expect(fireEntry([PLAIN_BAM])?.label).toBe('Accessibility');
    expect(fireEntry([FIRE_BAM, PLAIN_BAM])?.label).toBe('Accessibility / FIRE');
    expect(getCanonicalLayerEntries([FIRE_BAM, PLAIN_BAM]).some(e => e.key === 'msp')).toBe(false);
    // One panel's own sources are named for that dataset.
    expect(getMetaprofileSourceEntries([FIRE_BAM]).find(e => e.key === 'fire')?.label).toBe('FIRE');
    expect(getMetaprofileSourceEntries([PLAIN_BAM]).find(e => e.key === 'fire')?.label).toBe('Accessibility');
  });

  it('without datasets at hand, follows the loaded datasets (kept in step by the store)', () => {
    useBrowserStore.setState({ datasets: [FIRE_BAM] } as any);
    expect(getLayerLabel('msp')).toBe('FIRE');
    useBrowserStore.setState({ datasets: [FIRE_BAM, PLAIN_BAM] } as any);
    expect(getLayerLabel('fire')).toBe('Accessibility / FIRE');
    useBrowserStore.setState({ datasets: [PLAIN_BAM] } as any);
    expect(getLayerLabel('fire')).toBe('Accessibility');
  });

  it("a panel's hover text says what its accessibility layer is", () => {
    expect(getDatasetHoverLabel({ id: 'a', label: 'a', ...FIRE_BAM })).toBe('a\n\nAccessibility layer: FIRE (FIRE elements; FIRE scores found)');
    expect(getDatasetHoverLabel({ id: 'b', label: 'b', ...PLAIN_BAM })).toBe('b\n\nAccessibility layer: Accessibility (MSPs; no FIRE scores)');
    expect(getDatasetHoverLabel({ id: 'c', label: 'c', ...NUC_ONLY })).toBe('c');
  });
});
