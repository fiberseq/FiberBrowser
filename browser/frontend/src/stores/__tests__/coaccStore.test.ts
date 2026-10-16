import { beforeEach, describe, expect, it } from 'vitest';
import { applyCoaccSettings, coaccViewpointPosition, serializeCoaccSettings, useCoaccStore } from '../coaccStore';

function resetCoaccStore() {
  useCoaccStore.setState({
    coaccTrackMode: null,
    coaccSignalType: 'accessibility',
    coaccLayer: null,
    coaccNormalization: 'correlation',
    coaccScaling: 'linear',
    coaccColormap: 'fall',
    coaccMinCoverage: 20,
    coaccBinSize: 0,
    coaccArcThreshold: 1.5,
    coaccArcMaxArcs: 200,
    coaccArcMinDistance: 2,
    coaccV4cViewpoint: null,
  });
}

beforeEach(() => {
  resetCoaccStore();
});

describe('coaccessibility settings store', () => {
  it('serializes signal, layer, and virtual-4C settings for sessions/Jupyter', () => {
    useCoaccStore.setState({
      coaccTrackMode: 'virtual4c',
      coaccSignalType: 'all_fp',
      coaccLayer: 'fire',
      coaccV4cViewpoint: { start: 100, end: 120, label: 'vp' },
    });

    expect(serializeCoaccSettings()).toMatchObject({
      coaccTrackMode: 'virtual4c',
      coaccSignalType: 'all_fp',
      coaccLayer: 'fire',
      coaccV4cViewpoint: { start: 100, end: 120, label: 'vp' },
    });
  });

  it('preserves omitted fields during partial notebook settings updates', () => {
    useCoaccStore.setState({
      coaccSignalType: 'small_fp',
      coaccLayer: 'tf',
      coaccV4cViewpoint: { start: 250, end: 250 },
    });

    applyCoaccSettings({ coaccTrackMode: 'arc', coaccBinSize: 500 });

    expect(useCoaccStore.getState()).toMatchObject({
      coaccTrackMode: 'arc',
      coaccBinSize: 500,
      coaccSignalType: 'small_fp',
      coaccLayer: 'tf',
      coaccV4cViewpoint: { start: 250, end: 250 },
    });
  });

  it('honors explicit clears for layer and virtual-4C viewpoint', () => {
    useCoaccStore.setState({
      coaccLayer: 'tf',
      coaccV4cViewpoint: { start: 250, end: 250 },
    });

    applyCoaccSettings({ coaccLayer: null, coaccV4cViewpoint: null });

    expect(useCoaccStore.getState()).toMatchObject({
      coaccLayer: null,
      coaccV4cViewpoint: null,
    });
  });

  it('normalizes legacy MSP layer settings to FIRE', () => {
    useCoaccStore.getState().setCoaccLayer('msp');
    expect(useCoaccStore.getState().coaccLayer).toBe('fire');

    applyCoaccSettings({ coaccLayer: 'msp' });
    expect(useCoaccStore.getState().coaccLayer).toBe('fire');
  });
});

describe('coacc track mode switching', () => {
  beforeEach(resetCoaccStore);

  it('a direct mode change wins over a pending toggle switch', async () => {
    useCoaccStore.setState({ coaccTrackMode: 'heatmap' });
    useCoaccStore.getState().toggleCoaccTrackMode('arc');
    useCoaccStore.getState().setCoaccTrackMode('virtual4c');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useCoaccStore.getState().coaccTrackMode).toBe('virtual4c');
  });

  it('the last of two quick toggles is the mode that sticks', async () => {
    useCoaccStore.setState({ coaccTrackMode: 'heatmap' });
    useCoaccStore.getState().toggleCoaccTrackMode('arc');
    useCoaccStore.getState().toggleCoaccTrackMode('virtual4c');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useCoaccStore.getState().coaccTrackMode).toBe('virtual4c');
  });
});

describe('coaccViewpointPosition', () => {
  it('uses a viewpoint only on its chromosome and inside the window', () => {
    expect(coaccViewpointPosition({ start: 1500, end: 1500, chrom: 'chr1' }, 'chr1', 1000, 2000)).toBe(1500);
    expect(coaccViewpointPosition({ start: 1200, end: 1200, chrom: 'chr1' }, '1', 1000, 2000)).toBe(1200);
    expect(coaccViewpointPosition({ start: 1200, end: 1200, chrom: 'chr1' }, 'chr2', 1000, 2000)).toBe(1500);
    expect(coaccViewpointPosition({ start: 5000, end: 5000, chrom: 'chr1' }, 'chr1', 1000, 2000)).toBe(1500);
    expect(coaccViewpointPosition({ start: 1200, end: 1200 }, 'chr2', 1000, 2000)).toBe(1200);
    expect(coaccViewpointPosition(null, 'chr1', 1000, 2000)).toBe(1500);
  });

  it('keeps the viewpoint reference through sessions and ignores it on another reference', () => {
    applyCoaccSettings({ coaccV4cViewpoint: { start: 120, end: 120, chrom: 'copy', genome: 'own' } });
    const vp = useCoaccStore.getState().coaccV4cViewpoint;
    expect(vp?.genome).toBe('own');
    expect(coaccViewpointPosition(vp, 'copy', 100, 500, 'own')).toBe(120);
    expect(coaccViewpointPosition(vp, 'copy', 100, 500, 'other')).toBe(300);
  });

  it('keeps a saved viewpoint chromosome through serialization', () => {
    applyCoaccSettings({ coaccV4cViewpoint: { start: 10, end: 20, chrom: 'chr3' } });
    expect(useCoaccStore.getState().coaccV4cViewpoint).toEqual({ start: 10, end: 20, chrom: 'chr3' });
    applyCoaccSettings({ coaccV4cViewpoint: null });
  });
});
