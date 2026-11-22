import { beforeEach, describe, expect, it } from 'vitest';
import { registerInsertionFeatures } from '../features/register';
import { useBrowserStore } from '../stores/browserStore';
import { ensureBuiltinPanelsRegistered } from '../stores/__tests__/helpers';
import { applyJupyterStateToBrowser } from './jupyterStateBridge';
import { mergeLayerColors, paritySnapshot } from './jupyterParityBridge';
import { useWorkspaceStore } from '../features/plots/workspace';
import { executeNotebookAction, metaLocusSpecFromAction } from '../actions/notebookActions';
import { setPreviewsEnabled } from '../utils/previewFeatures';

registerInsertionFeatures();

const DEFAULT_ID = '__default_metaprofile__';
const track = () => useBrowserStore.getState().compositeTracks.find(c => c.id === DEFAULT_ID)!;
const shown = () => track().sources.filter(s => s.visible).map(s => (s.ref as { ruleId: string }).ruleId).sort();
const apply = (settings_update: Record<string, unknown>) => applyJupyterStateToBrowser({ settings_update } as never);

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  useBrowserStore.setState({
    datasets: [{ id: 'ds1', label: 'Dataset 1', data_type: 'bam', available_layers: { nuc: true, tf: true, fire: true } }] as never,
    compositeTracks: [], enabledModTypes: { nuc: true, tf: true },
    minFootprints: 5, minFpQuality: 0, showDuplicateReads: false, showQcFailReads: false,
    layerColorOverrides: {}, userLayerColors: {},
  } as never);
  useWorkspaceStore.setState({ view: 'browser' });
});

describe('notebook read filters', () => {
  it('min_footprints -1 is "All reads, including uncalled"; quality and the toggles apply', () => {
    apply({ min_footprints: -1, min_fp_quality: 300, show_duplicate_reads: true, show_qc_fail_reads: true });
    const s = useBrowserStore.getState();
    expect(s.minFootprints).toBe(-1);
    expect(s.minFpQuality).toBe(255);
    expect(s.showDuplicateReads).toBe(true);
    expect(s.showQcFailReads).toBe(true);
    const snap = paritySnapshot();
    expect(snap).toMatchObject({ min_footprints: -1, min_fp_quality: 255, show_duplicate_reads: true, show_qc_fail_reads: true });
  });

  it('leaves settings the update does not name alone', () => {
    apply({ show_qc_fail_reads: true });
    expect(useBrowserStore.getState().minFootprints).toBe(5);
    expect(useBrowserStore.getState().showDuplicateReads).toBe(false);
  });
});

describe('default metaprofile follow mode', () => {
  it('set_metaprofile_layers makes it manual; follow=true makes it follow the layer toggles again', () => {
    useBrowserStore.getState().seedDefaultMetaprofile();
    apply({ enabled_meta_profiles: { tf: false } });
    expect(track().followActiveLayers).toBe(false);
    expect(shown()).toEqual(['nuc']);
    expect(paritySnapshot().metaprofile_follow_active_layers).toBe(false);

    apply({ metaprofile_follow_active_layers: true });
    expect(track().followActiveLayers).toBe(true);
    expect(shown()).toEqual(['nuc', 'tf']);
    expect(paritySnapshot().metaprofile_follow_active_layers).toBe(true);
  });

  it('calls queued between two polls apply one by one, in order (settings_updates)', () => {
    useBrowserStore.getState().seedDefaultMetaprofile();
    // TF source off -> follow on -> nuc layer off: following, TF visible again, nuc hidden by its layer.
    applyJupyterStateToBrowser({ settings_updates: [
      { enabled_meta_profiles: { tf: false } },
      { metaprofile_follow_active_layers: true },
      { enabled_mod_types: { nuc: false } },
    ] } as never);
    expect(track().followActiveLayers).toBe(true);
    expect(shown()).toEqual(['tf']);
    // nuc off -> follow off -> TF off: frozen with TF shown (the layer went off after the freeze).
    applyJupyterStateToBrowser({ settings_updates: [
      { enabled_mod_types: { nuc: true } },
      { enabled_mod_types: { nuc: false } },
      { metaprofile_follow_active_layers: false },
      { enabled_mod_types: { tf: false } },
    ] } as never);
    expect(track().followActiveLayers).toBe(false);
    expect(shown()).toEqual(['tf']);
  });

  it('a merged summary with the follow-first hint freezes before its layer toggles', () => {
    useBrowserStore.getState().seedDefaultMetaprofile();
    apply({ metaprofile_follow_active_layers: false, enabled_mod_types: { nuc: false }, metaprofile_follow_first: true });
    expect(track().followActiveLayers).toBe(false);
    expect(shown()).toEqual(['nuc', 'tf']);
  });

  it('follow=false keeps the current sources', () => {
    useBrowserStore.getState().seedDefaultMetaprofile();
    apply({ metaprofile_follow_active_layers: false });
    expect(track().followActiveLayers).toBe(false);
    expect(shown()).toEqual(['nuc', 'tf']);
  });
});

describe('layer colours from a notebook', () => {
  it('merges the session colours (aliases canonical, null forgets, bad colours skipped)', () => {
    apply({ layer_color_overrides: { msp: '#ABC', nuc: '#112233', tf: 'not-a-colour' } });
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ fire: '#aabbcc', nuc: '#112233' });
    apply({ layer_color_overrides: { nuc: null } });
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ fire: '#aabbcc' });
    apply({ replace_layer_color_overrides: true, layer_color_overrides: { tf: '#000000' } });
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({ tf: '#000000' });
    expect(paritySnapshot().layer_color_overrides).toEqual({ tf: '#000000' });
  });

  it('sets the saved defaults separately from the session', () => {
    apply({ user_layer_colors: { nuc: '#123456' } });
    expect(useBrowserStore.getState().userLayerColors).toEqual({ nuc: '#123456' });
    expect(useBrowserStore.getState().layerColorOverrides).toEqual({});
    expect(paritySnapshot().user_layer_colors).toEqual({ nuc: '#123456' });
  });

  it('mergeLayerColors replace starts from none', () => {
    expect(mergeLayerColors({ nuc: '#111111' }, { tf: '#222222' }, true)).toEqual({ tf: '#222222' });
  });
});

describe('Quantify a window, Plots and the workspace', () => {
  it('window_quant merges the window, spec and axis and reports them back', () => {
    apply({ window_quant: { window: { chrom: 'chr2L', from: 100, to: 200 }, spec: { comparison: 'datasets', measures: ['nuc'] }, axis: { mode: 'relative', anchor: 'centre' }, open_in: 'track' } });
    const wq = useBrowserStore.getState().windowQuant;
    expect(wq.window).toMatchObject({ chrom: 'chr2L', from: 100, to: 200 });
    expect(wq.spec.comparison).toBe('datasets');
    expect(wq.spec.measures).toEqual(['nuc']);
    expect(wq.axis).toMatchObject({ mode: 'relative', anchor: 'centre' });
    expect(wq.openIn).toBe('track');
    // A later spec patch keeps the rest.
    apply({ window_quant: { spec: { stat: 'area' } } });
    expect(useBrowserStore.getState().windowQuant.spec.comparison).toBe('datasets');
    expect((paritySnapshot().window_quant as { spec: { stat: string } }).spec.stat).toBe('area');
  });

  it('plot opens Plots with that plot in the builder (normalised); workspace switches back', () => {
    apply({ plot: { type: 'metaprofile', name: 'From Python', groupBy: 'cluster' } });
    expect(useWorkspaceStore.getState().view).toBe('plots');
    const current = (useBrowserStore.getState() as unknown as { plotsWorkspace: { current: { type: string; name: string; groupBy: string } } }).plotsWorkspace.current;
    expect(current).toMatchObject({ type: 'metaprofile', name: 'From Python', groupBy: 'cluster' });
    expect(paritySnapshot().workspace).toBe('plots');
    apply({ workspace: 'browser' });
    expect(useWorkspaceStore.getState().view).toBe('browser');
    apply({ workspace: 'nowhere' });
    expect(useWorkspaceStore.getState().view).toBe('browser');
  });

  it('a multi-source PlotSpec from Python keeps its sources (one line per source)', () => {
    apply({ plot: { type: 'metaprofile', sources: ['nuc', 'tf'] } });
    const current = (useBrowserStore.getState() as unknown as { plotsWorkspace: { current: { sources: string[] } } }).plotsWorkspace.current;
    expect(current.sources).toEqual(['nuc', 'tf']);
  });

  it('open_in null closes the Quantify card', () => {
    apply({ window_quant: { open_in: 'track' } });
    expect(useBrowserStore.getState().windowQuant.openIn).toBe('track');
    apply({ window_quant: { open_in: null } });
    expect(useBrowserStore.getState().windowQuant.openIn).toBeNull();
  });

  it('a replayed snapshot restores the BED region sets before its plot', () => {
    apply({ plots_region_sets: [{ id: 'set1', path: '/data/sites.bed', name: 'sites', regions: [['chr1', 10, 20, '+', 'a']] }],
            plot: { type: 'metaprofile', where: 'bed', bed: { setIds: ['set1'] } } });
    const ws = (useBrowserStore.getState() as unknown as { plotsWorkspace: { regionSets: Array<{ id: string }> } }).plotsWorkspace;
    expect(ws.regionSets.map(s => s.id)).toContain('set1');
  });

  it('reversed sets Reverse (Flip to gene direction) and reports it', () => {
    useBrowserStore.setState({ isReversed: false } as never);
    apply({ reversed: true });
    expect(useBrowserStore.getState().isReversed).toBe(true);
    apply({ reversed: true });
    expect(useBrowserStore.getState().isReversed).toBe(true);   // not a toggle
    expect(paritySnapshot().reversed).toBe(true);
    apply({ reversed: false });
    expect(useBrowserStore.getState().isReversed).toBe(false);
  });
});

describe('notebook actions: meta-locus and Plots', () => {
  it('reads the meta-locus spec from an action, with defaults and checks', () => {
    expect(metaLocusSpecFromAction({ type: 'open_meta_locus' })).toEqual({ error: expect.stringContaining('bed_path') });
    expect(metaLocusSpecFromAction({ type: 'open_meta_locus', bed_path: '/data/tss.bed', anchor: 'middle' })).toEqual({ error: expect.stringContaining('anchor') });
    expect(metaLocusSpecFromAction({ type: 'open_meta_locus', bed_path: '/data/tss.bed', flank_bp: 2000.4, dataset_ids: ['ds1', 3] }))
      .toEqual({ bed_path: '/data/tss.bed', anchor: 'centre', flank_bp: 2000, dataset_ids: ['ds1'] });
  });

  it('meta-locus actions need Preview features (enable_preview turns them on)', async () => {
    setPreviewsEnabled(false);
    expect(await executeNotebookAction({ type: 'meta_locus_more_reads' })).toContain('Preview');
    expect(await executeNotebookAction({ type: 'meta_locus_more_reads', enable_preview: true })).toContain('no meta-locus is open');
  });

  it('queued browser actions reach the notebook actions', async () => {
    const { executeBrowserActions } = await import('../actions/browserActions');
    const [message] = await executeBrowserActions([{ type: 'plots_keep' }]);
    expect(message).toContain('no result yet');
  });

  it('plots_keep without a drawn plot says so; other types are not notebook actions', async () => {
    expect(await executeNotebookAction({ type: 'plots_keep' })).toContain('no result yet');
    expect(await executeNotebookAction({ type: 'zoom_view' })).toBeNull();
  });
});
