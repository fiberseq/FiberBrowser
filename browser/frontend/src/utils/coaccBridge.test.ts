import { beforeEach, describe, expect, it } from 'vitest';
import { useCoaccStore } from '../stores/coaccStore';
import { coaccSettingsForFootprintLayer, configureCoaccFromFootprintLayer } from './coaccBridge';

beforeEach(() => {
  useCoaccStore.setState({
    coaccTrackMode: null,
    coaccSignalType: 'accessibility',
    coaccLayer: null,
  });
});

describe('coaccBridge', () => {
  it('maps all/default footprint scopes to all-FP coaccessibility signal', () => {
    expect(coaccSettingsForFootprintLayer(null)).toEqual({
      signalType: 'all_fp',
      layer: null,
    });
    expect(coaccSettingsForFootprintLayer('all_fp')).toEqual({
      signalType: 'all_fp',
      layer: null,
    });
  });

  it('maps explicit footprint layers to coaccessibility layer overrides', () => {
    expect(coaccSettingsForFootprintLayer('tf')).toEqual({
      signalType: 'accessibility',
      layer: 'tf',
    });
    expect(coaccSettingsForFootprintLayer('msp')).toEqual({
      signalType: 'accessibility',
      layer: 'fire',
    });
  });

  it('primes the coaccessibility store for a matrix handoff', () => {
    configureCoaccFromFootprintLayer('fire');

    expect(useCoaccStore.getState()).toMatchObject({
      coaccTrackMode: 'heatmap',
      coaccSignalType: 'accessibility',
      coaccLayer: 'fire',
    });
  });
});
