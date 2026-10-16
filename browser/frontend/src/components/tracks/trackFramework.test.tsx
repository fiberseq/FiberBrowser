/**
 * The per-panel track framework (fb-n11-tracks): registration, resize limits,
 * delete / restore and its persistence, the "Tracks in this panel" menu, the
 * right-click menu every track gets, and which header actions fit.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useTrackMenuStore } from '../../stores/trackMenuStore';
import { createDefaultSubTracks, ensureBuiltinSubTracks, migratePanelTracks, SV_COLLAPSED_MIGRATION_HEIGHT } from '../../stores/utils';
import { deserializeSavedState, serializeState } from '../../stores/historySlice';
import type { PanelConfig, SubTrackConfig } from '../../types';
import {
  builtinTrackTypes, clampTrackHeight, isDeletableTrack, isResizableTrack, registerTrackKind, rowHeight, trackKind,
} from './trackRegistry';
import { buildTrackMenu, commonTrackMenuEntries, runTrackMenuAction, TrackContextMenuHost } from './TrackContextMenuHost';
import { addableTracks, SubTrackMenu } from './SubTrackMenu';
import { restoreTrack } from './trackActions';
import { feedHasCoverage, feedHasSv } from '../../stores/trackFeedStore';
import { fitHeaderActions } from '../../hooks/useHeaderActionsFit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const panel = (subTracks: SubTrackConfig[] = createDefaultSubTracks([], [{ id: 'meta' }])): PanelConfig => ({
  id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks, collapsed: false, linkGroup: null, layoutRow: 0,
} as PanelConfig);
const track = (type: string) => useBrowserStore.getState().panels.find(p => p.id === 'p1')!.subTracks.find(t => t.type === type);

beforeEach(() => {
  useBrowserStore.setState({
    datasets: [{ id: 'ds1', label: 'numb', color: '#3b82f6', data_type: 'bam' }],
    panels: [panel()], compositeTracks: [{ id: 'meta', label: 'Metaprofile', visible: true, sources: [] }],
    orthogonalTracks: [], exportInProgress: false,
  } as never);
  useTrackMenuStore.setState({ menu: null, heightEdit: null, tracksMenuFor: null });
});

describe('track registry', () => {
  it('knows every built-in row, with sensible limits; families by prefix', () => {
    for (const type of createDefaultSubTracks().map(t => t.type)) {
      const kind = trackKind(type);
      expect(kind.label, type).not.toBe(type);
      if (type !== 'reads') expect(kind.minHeight, type).toBeLessThan(kind.defaultHeight);
      if (type !== 'reads') expect(kind.maxHeight, type).toBeGreaterThan(kind.defaultHeight);
    }
    expect(trackKind('composite-abc').type).toBe('composite-');
    expect(trackKind('ortho-3').type).toBe('ortho-');
    expect(isResizableTrack('sv')).toBe(true);
    expect(isResizableTrack('reads')).toBe(false);
    expect(isDeletableTrack('reads')).toBe(false);
    expect(isDeletableTrack('sv')).toBe(true);
    expect(builtinTrackTypes()).toEqual(expect.arrayContaining(['sv', 'coverage', 'fire', 'gene']));
  });

  it('a sibling registers its own kind and the framework uses it', () => {
    registerTrackKind({ type: 'test-channel', label: 'Test channel', defaultHeight: 50, minHeight: 20, maxHeight: 90,
      menu: () => [{ id: 'x', label: 'Open X', icon: 'panel:accessibility', panel: 'accessibility' }] });
    expect(trackKind('test-channel').label).toBe('Test channel');
    expect(clampTrackHeight('test-channel', 500)).toBe(90);
    expect(rowHeight({ type: 'test-channel' as never })).toBe(50);
  });

  it('clamps heights to the kind (bad values give the default)', () => {
    expect(clampTrackHeight('sv', 5)).toBe(trackKind('sv').minHeight);
    expect(clampTrackHeight('sv', 10_000)).toBe(trackKind('sv').maxHeight);
    expect(clampTrackHeight('sv', Number.NaN)).toBe(trackKind('sv').defaultHeight);
    expect(rowHeight({ type: 'sv', heightOverride: 1000 })).toBe(trackKind('sv').maxHeight);
    expect(rowHeight({ type: 'composite-x', heightOverride: undefined }, 60)).toBe(60);
  });
});

describe('resize, delete and restore (store)', () => {
  it('hides and restores all panels, preserves local exceptions, and saves visibility and the strip preference', () => {
    const s = () => useBrowserStore.getState();
    const visible = () => s().panels.map(p => p.subTracks.find(t => t.type === 'sv')?.visible);
    useBrowserStore.setState({ panels: [panel(), { ...panel(), id: 'p2' }], _historyStack: [], _historyPointer: -1 });
    s().toggleSubTrack('p1', 'sv', true);
    expect(visible()).toEqual([false, true]);
    s().toggleSubTrack('p2', 'sv');
    expect(visible()).toEqual([false, false]);
    s().undo();
    expect(visible()).toEqual([false, true]);
    s().redo();
    expect(visible()).toEqual([false, false]);
    s().setShowHiddenTrackStrip(false);
    const saved = serializeState(s());
    s().toggleSubTrack('p1', 'sv');
    expect(visible()).toEqual([true, true]);
    useBrowserStore.setState(deserializeSavedState(saved));
    expect(visible()).toEqual([false, false]);
    expect(s().showHiddenTrackStrip).toBe(false);
    s().toggleSubTrack('p2', 'sv');
    expect(visible()).toEqual([true, true]);
  });

  it('sets a height within the limits, and back to the default', () => {
    useBrowserStore.getState().setSubTrackHeight('p1', 'sv', 120);
    expect(track('sv')!.heightOverride).toBe(120);
    useBrowserStore.getState().setSubTrackHeight('p1', 'sv', 4);
    expect(track('sv')!.heightOverride).toBe(trackKind('sv').minHeight);
    useBrowserStore.getState().setSubTrackHeight('p1', 'sv', null);
    expect(track('sv')!.heightOverride).toBeUndefined();
  });

  it('deletes a built-in in place (not minimized), restores it there, and never deletes the reads', () => {
    const order = () => useBrowserStore.getState().panels[0].subTracks.map(t => t.type);
    const before = order();
    useBrowserStore.getState().removeSubTrack('p1', 'sv');
    expect(track('sv')).toMatchObject({ removed: true, visible: true });
    expect(order()).toEqual(before);
    // A track sync (ensureBuiltinSubTracks) does not bring it back.
    expect(ensureBuiltinSubTracks(useBrowserStore.getState().panels[0].subTracks).find(t => t.type === 'sv')?.removed).toBe(true);
    useBrowserStore.getState().restoreSubTrack('p1', 'sv');
    expect(track('sv')!.removed).toBeUndefined();
    expect(order()).toEqual(before);
    useBrowserStore.getState().removeSubTrack('p1', 'reads');
    expect(track('reads')!.removed).toBeUndefined();
  });

  it('puts a built-in the panel lacks back at its default place', () => {
    useBrowserStore.setState({ panels: [panel(createDefaultSubTracks().filter(t => t.type !== 'sequence' && t.type !== 'sv'))] } as never);
    useBrowserStore.getState().restoreSubTrack('p1', 'sv');
    const types = useBrowserStore.getState().panels[0].subTracks.map(t => t.type);
    expect(types.indexOf('sv')).toBe(types.indexOf('coverage') - 1);
    useBrowserStore.getState().restoreSubTrack('p1', 'sequence');
    expect(useBrowserStore.getState().panels[0].subTracks.map(t => t.type).indexOf('sequence')).toBeGreaterThan(types.indexOf('reads'));
  });

  it('restoring a row behind a global switch turns the switch on too', () => {
    useBrowserStore.setState({ showCoverageHistogram: false } as never);
    useBrowserStore.getState().removeSubTrack('p1', 'coverage');
    restoreTrack('p1', 'coverage');
    expect(useBrowserStore.getState().showCoverageHistogram).toBe(true);
    expect(track('coverage')!.removed).toBeUndefined();
  });

  it('the SV / coverage rows draw only for the view their reads are on', () => {
    const feed = { datasetId: 'ds1', chrom: 'chr2L', start: 0, end: 100, isReversed: false, sidebarWidth: 0, linkedOffset: 0,
      reads: [], dataChrom: 'chr2L', dataStart: 0, dataEnd: 100, zoomedOut: false, panScope: 'main', linked: false,
      sv: { min_len: 50, margin: 100, scope: 'all' as const, n_reads: 1, clusters: [], clips: [{ side: 'L' as const, ref: 5, n: 2 }] } };
    expect(feedHasSv(feed)).toBe(true);
    expect(feedHasCoverage(feed)).toBe(true);
    expect(feedHasSv({ ...feed, chrom: 'chr3R' })).toBe(false);
    expect(feedHasCoverage({ ...feed, chrom: 'chr3R' })).toBe(false);
    expect(feedHasCoverage({ ...feed, zoomedOut: true })).toBe(false);
  });

  it('is saved with the panel (sessions, snapshots), and undoable', () => {
    useBrowserStore.getState().removeSubTrack('p1', 'coverage');
    useBrowserStore.getState().setSubTrackHeight('p1', 'sv', 90);
    const saved = serializeState(useBrowserStore.getState()) as unknown as { panels: PanelConfig[] };
    const rows = saved.panels[0].subTracks;
    expect(rows.find(t => t.type === 'coverage')?.removed).toBe(true);
    expect(rows.find(t => t.type === 'sv')?.heightOverride).toBe(90);
  });

  it('migrates older saves: the new rows appear; a collapsed SV summary opens small', () => {
    const old = [{ ...panel(createDefaultSubTracks().filter(t => t.type !== 'sv' && t.type !== 'coverage')) }];
    const [migrated] = migratePanelTracks(old, true);
    const types = migrated.subTracks.map(t => t.type);
    expect(types.slice(types.indexOf('sv'), types.indexOf('reads') + 1)).toEqual(['sv', 'coverage', 'reads']);
    expect(migrated.subTracks.find(t => t.type === 'sv')?.heightOverride).toBe(SV_COLLAPSED_MIGRATION_HEIGHT);
    expect(migratePanelTracks(old, false)[0].subTracks.find(t => t.type === 'sv')?.heightOverride).toBeUndefined();
    // Panels without reads (a genome panel) are left as they are.
    const genome = { ...panel([{ type: 'axis', visible: true }]), datasetId: null };
    expect(migratePanelTracks([genome])[0]).toBe(genome);
  });
});

describe('"Tracks in this panel"', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = () => act(() => root.render(
    <SubTrackMenu panelId="p1" subTracks={useBrowserStore.getState().panels[0].subTracks} anchorRect={new DOMRect(10, 10, 20, 20)} onClose={() => {}} />,
  ));

  it('lists every row with ×, and removed / missing built-ins under "Add to this panel"', () => {
    useBrowserStore.getState().removeSubTrack('p1', 'sv');
    render();
    const menu = document.querySelector('[data-testid="panel-tracks-menu-p1"]')!;
    const rows = [...menu.querySelectorAll('[data-track-row]')].map(r => r.getAttribute('data-track-row'));
    expect(rows).toContain('composite-meta');
    expect(rows).toContain('coverage');
    expect(rows).not.toContain('sv');
    expect(menu.querySelector('[data-testid="panel-track-remove-reads"]')).toBeNull();
    expect(menu.querySelector('[data-testid="panel-track-remove-coverage"]')).not.toBeNull();
    act(() => menu.querySelector<HTMLButtonElement>('[data-testid="panel-track-restore-sv"]')!.click());
    expect(track('sv')!.removed).toBeUndefined();
    // The global Tracks panel and Library are one click away.
    expect(menu.querySelector('[data-testid="panel-tracks-open-tracks-panel"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="panel-tracks-open-library"]')).not.toBeNull();
  });

  it('removes a row with × and offers it back', () => {
    render();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="panel-track-remove-sv"]')!.click());
    expect(track('sv')!.removed).toBe(true);
    expect(addableTracks(useBrowserStore.getState().panels[0].subTracks, true)).toContain('sv');
    expect(addableTracks(createDefaultSubTracks(), true)).toEqual([]);
  });
});

describe('the right-click menu every track gets', () => {
  const ctx = () => ({ panel: useBrowserStore.getState().panels[0], type: 'composite-meta' as const, datasetId: 'ds1', stateKey: 'ds1' });
  const labels = (entries: ReturnType<typeof buildTrackMenu>) => entries.map(e => (e.kind === 'item' ? e.label : e.kind === 'separator' ? '—' : `# ${e.label}`));

  it('metaprofile: open Rules / Labeling / Tracks / Library, then the common section', () => {
    expect(labels(buildTrackMenu('composite-meta', ctx()))).toEqual([
      'Rules', 'Labeling', 'Tracks panel', 'Library', '—', 'Set height…', 'Remove this track', 'Tracks in this panel…',
    ]);
  });

  it('own items first (the SV track), then the kind, and the common items under Track options (SV-5)', () => {
    const own = [{ kind: 'item' as const, action: 'sv-split-this', label: 'Group in this panel by this SV', icon: 'split' }];
    const menu = buildTrackMenu('sv', { ...ctx(), type: 'sv' }, own);
    const out = labels(menu);
    expect(out[0]).toBe('Group in this panel by this SV');
    expect(out).not.toContain('Set height…');
    expect(out.at(-1)).toBe('# Track options');
    const admin = menu.at(-1)!;
    expect(admin.kind === 'submenu' && admin.entries.map(e => e.label)).toEqual(['Set height…', 'Remove this track', 'Tracks in this panel…', 'Track settings']);
  });

  it('the reads get the common section without resize/remove', () => {
    expect(commonTrackMenuEntries('reads').map(e => (e.kind === 'item' ? e.action : ''))).toEqual(['track:tracks', 'track:settings']);
  });

  it('every built-in has at least one item pointing somewhere besides the common ones (or settings)', () => {
    for (const type of createDefaultSubTracks().map(t => t.type)) {
      if (type === 'sequence' || type === 'reads') continue;
      const kind = trackKind(type);
      expect((kind.menu?.({ ...ctx(), type }) ?? []).length + (kind.settingId ? 1 : 0), type).toBeGreaterThan(0);
    }
  });

  it('runs: a panel item opens it; Remove deletes; Tracks in this panel asks the header; Set height opens the box', () => {
    const opened: string[] = [];
    const openAnalysisPanel = useBrowserStore.getState().openAnalysisPanel;
    useBrowserStore.setState({ openAnalysisPanel: (type: string) => { opened.push(type); } } as never);
    expect(runTrackMenuAction('kind:open-cluster-features', 'p1', 'composite-meta', { x: 0, y: 0 })).toBe(true);
    expect(opened).toEqual(['cluster-features']);
    useBrowserStore.setState({ openAnalysisPanel } as never);
    runTrackMenuAction('track:remove', 'p1', 'coverage', { x: 0, y: 0 });
    expect(track('coverage')!.removed).toBe(true);
    runTrackMenuAction('track:tracks', 'p1', 'gene', { x: 0, y: 0 });
    expect(useTrackMenuStore.getState().tracksMenuFor).toBe('p1');
    runTrackMenuAction('track:set-height', 'p1', 'gene', { x: 5, y: 5 });
    expect(useTrackMenuStore.getState().heightEdit).toMatchObject({ panelId: 'p1', type: 'gene' });
  });

  it('the host draws the open menu and the Set height box (typed px are clamped)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<TrackContextMenuHost />));
    act(() => useTrackMenuStore.getState().openMenu({ panelId: 'p1', type: 'composite-meta', x: 20, y: 20 }));
    const menu = document.querySelector('[data-testid="track-context-menu"]')!;
    expect(menu.textContent).toContain('Rules');
    act(() => menu.querySelector<HTMLButtonElement>('[data-action="track:set-height"]')!.click());
    expect(document.querySelector('[data-testid="track-context-menu"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('[data-testid="track-height-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, '9999'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(document.querySelector('[data-testid="track-height-box"]')!.textContent).toContain('→ 400');
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="track-height-apply"]')!.click());
    expect(track('composite-meta')!.heightOverride).toBe(trackKind('composite-meta').maxHeight);
    act(() => root.unmount());
    container.remove();
  });
});

describe('header actions that fit (ResizeObserver widths)', () => {
  const actions = ['close', 'minimize', 'fullview', 'tracks', 'cleanview', 'copy', 'haplotypes'].map(key => ({ key, width: 22 }));

  it('everything with room, the Tracks label too; no layout: everything', () => {
    expect(fitHeaderActions(400, actions, { gap: 6, moreWidth: 24, labelExtra: 40 })).toEqual({ shown: actions.map(a => a.key), overflow: [], labelled: true });
    expect(fitHeaderActions(undefined, actions).overflow).toEqual([]);
  });

  it('drops the least important first into "…", keeping close / minimize / expand', () => {
    const fit = fitHeaderActions(150, actions, { gap: 6, moreWidth: 24, labelExtra: 40 });
    expect(fit.shown.slice(0, 3)).toEqual(['close', 'minimize', 'fullview']);
    expect(fit.shown).toEqual(['close', 'minimize', 'fullview', 'tracks']);
    expect(fit.overflow).toEqual(['cleanview', 'copy', 'haplotypes']);
    expect(fit.labelled).toBe(false);
    expect(fitHeaderActions(80, actions, { gap: 6, moreWidth: 24 }).shown).toEqual(['close', 'minimize']);
    // All fit but the label: no "…", icon only.
    expect(fitHeaderActions(7 * 22 + 6 * 6 + 10, actions, { gap: 6, moreWidth: 24, labelExtra: 40 })).toMatchObject({ overflow: [], labelled: false });
  });
});
