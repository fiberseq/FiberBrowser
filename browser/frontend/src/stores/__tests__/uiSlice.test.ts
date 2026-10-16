import { describe, expect, it, beforeEach } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

describe('read display defaults', () => {
  it('defaults to Fit, auto sample, 1px rows, capped display, and capped profile pool', () => {
    const state = store.getState();

    expect(state.readDisplayMode).toBe('sample');
    expect(state.downsampleCount).toBeNull();
    expect(state.readRowHeight).toBe(1);
    expect(state.readSeparatorMode).toBe('auto');
    expect(state.readSeparatorMinHeight).toBe(3);
    expect(state.readSeparatorWidth).toBe(1);
    expect(state.allReadsDisplayCap).toBe(2_000);
    expect(state.backgroundReadCap).toBe(1_000);
    expect(state.exportMatchedReadCount).toBeNull();
    expect(state.exportMatchedReadFetchCount).toBeNull();

    state.setBackgroundReadCap(25_000);
    expect(store.getState().backgroundReadCap).toBe(25_000);
    store.getState().setBackgroundReadCap(0);
    expect(store.getState().backgroundReadCap).toBeNull();
  });

  it('clamps read separator display settings', () => {
    store.getState().setReadSeparatorMode('fixed');
    store.getState().setReadSeparatorMinHeight(0);
    store.getState().setReadSeparatorWidth(50);

    expect(store.getState().readSeparatorMode).toBe('fixed');
    expect(store.getState().readSeparatorMinHeight).toBe(0.5);
    expect(store.getState().readSeparatorWidth).toBe(10);
  });

  it('refreshes reads immediately when duplicate visibility changes', () => {
    const initialGeneration = store.getState().refreshGeneration;

    store.getState().setShowDuplicateReads(true);
    expect(store.getState().showDuplicateReads).toBe(true);
    expect(store.getState().refreshGeneration).toBe(initialGeneration + 1);

    store.getState().setShowDuplicateReads(false);
    expect(store.getState().showDuplicateReads).toBe(false);
    expect(store.getState().refreshGeneration).toBe(initialGeneration + 2);
  });

  it('keeps matched-export display and fetch counts transiently coordinated', () => {
    store.getState().setExportMatchedReadCounts(1_000, 1_700);
    expect(store.getState().exportMatchedReadCount).toBe(1_000);
    expect(store.getState().exportMatchedReadFetchCount).toBe(1_700);

    store.getState().setExportMatchedReadCounts(800, 1_700);
    expect(store.getState().exportMatchedReadCount).toBe(800);
    expect(store.getState().exportMatchedReadFetchCount).toBe(1_700);

    store.getState().setExportMatchedReadCounts(null);
    expect(store.getState().exportMatchedReadCount).toBeNull();
    expect(store.getState().exportMatchedReadFetchCount).toBeNull();
  });
});

describe('layer visibility defaults', () => {
  it('starts with nuc and TF visible, with secondary layers off', () => {
    const enabled = store.getState().enabledModTypes as Record<string, boolean>;
    const enabledMeta = store.getState().enabledMetaProfiles as Record<string, boolean>;

    expect(enabled.footprint).toBe(true);
    expect(enabled.nuc).toBe(true);
    expect(enabled.tf).toBe(true);
    expect(enabled.deam).toBe(false);
    expect(enabled.deam_opportunity).toBe(false);
    expect(enabled.msp).toBe(false);
    expect(enabled.fire).toBe(false);
    expect(enabled.m6a).toBe(false);
    expect(enabled.m5c).toBe(false);
    expect(enabledMeta.nuc).toBe(true);
    expect(enabledMeta.tf).toBe(true);
    expect(enabledMeta.subnuc).toBeUndefined();
  });

  it('keeps TF as a primary default when datasets expose all DAF layers', () => {
    store.setState({
      datasets: [{
        id: 'primary',
        label: 'primary',
        path: '/tmp/primary.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: {
          footprint: true,
          nuc: true,
          tf: true,
          deam: true,
          msp: true,
          fire: true,
        },
      }],
    });

    store.getState().initModTypeDefaults();
    const enabled = store.getState().enabledModTypes as Record<string, boolean>;

    expect(enabled.footprint).toBe(true);
    expect(enabled.nuc).toBe(true);
    expect(enabled.tf).toBe(true);
    expect(enabled.deam).toBe(false);
    expect(enabled.msp).toBe(false);
    expect(enabled.fire).toBe(false);
  });

  it('clears the retired live C/G opportunity toggle from old sessions', () => {
    store.setState({
      datasets: [{
        id: 'daf',
        label: 'DAF',
        path: '/tmp/daf.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: {
          nuc: true,
          tf: true,
          nuc_sr: true,
          tf_sr: true,
          deam: true,
          deam_opportunity: true,
        },
      }],
      enabledModTypes: {
        ...store.getState().enabledModTypes,
        deam_opportunity: true,
      },
    });

    store.getState().initModTypeDefaults();

    expect(store.getState().enabledModTypes.deam_opportunity).toBe(false);
  });

  it('defaults detected TF metaprofiles on for old sessions missing the key', () => {
    store.setState({
      datasets: [{
        id: 'daf',
        label: 'DAF',
        path: '/tmp/daf.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: {
          nuc: true,
          tf: true,
          fire: true,
          deam: true,
        },
      }],
      enabledMetaProfiles: { nuc: true, fire: false, deam: false },
    });

    store.getState().initModTypeDefaults();
    const enabledMeta = store.getState().enabledMetaProfiles as Record<string, boolean>;

    expect(enabledMeta.nuc).toBe(true);
    expect(enabledMeta.tf).toBe(true);
    expect(enabledMeta.fire).toBe(false);
    expect(enabledMeta.deam).toBe(false);
  });

  it('preserves an explicit user-disabled TF metaprofile', () => {
    store.setState({
      datasets: [{
        id: 'daf',
        label: 'DAF',
        path: '/tmp/daf.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: { nuc: true, tf: true },
      }],
      enabledMetaProfiles: { nuc: true, tf: false },
    });

    store.getState().initModTypeDefaults();

    expect(store.getState().enabledMetaProfiles.tf).toBe(false);
  });
});
