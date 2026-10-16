import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/tracks', () => ({
  addTrack: vi.fn(),
  addMotifFileTracks: vi.fn(),
  removeTrack: vi.fn(),
  getTracks: vi.fn(),
  updateTrackFilter: vi.fn(),
}));
vi.mock('../api/recentTracks', () => ({ rememberRecentTrack: vi.fn() }));

import { addTrack, getTracks, removeTrack, updateTrackFilter } from '../api/tracks';
import { useBrowserStore } from '../stores/browserStore';
import { inferCatalogKind } from '../stores/catalogSlice';
import { registerTrack, removeBackendTrack, removeTrackAtIndex, setTrackNameFilter } from './trackLoader';

describe('removing a backend track', () => {
  it('moves name filters with the tracks the backend shifts down', async () => {
    vi.mocked(removeTrack).mockResolvedValue({ success: true });
    useBrowserStore.setState({ trackFilters: { 0: ['CTCF'], 2: ['REST'] } } as never);
    await removeBackendTrack(0);
    expect(useBrowserStore.getState().trackFilters).toEqual({ 1: ['REST'] });
  });

  it('leaves filters alone when the backend refuses', async () => {
    vi.mocked(removeTrack).mockResolvedValue({ success: false, message: 'no such track' });
    useBrowserStore.setState({ trackFilters: { 1: ['REST'] } } as never);
    await expect(removeBackendTrack(0)).rejects.toThrow('no such track');
    expect(useBrowserStore.getState().trackFilters).toEqual({ 1: ['REST'] });
  });

  it('keeps labeling rules and saved footprints pointing at their own tracks', async () => {
    vi.mocked(removeTrack).mockResolvedValue({ success: true });
    const st = useBrowserStore.getState();
    const rule = { ...st.activeColormap.rules[0], id: 'in-b',
      conditions: [{ target: 'track' as const, trackId: '1' }, { target: 'track' as const, trackId: '0' }] };
    useBrowserStore.setState({
      activeColormap: { ...st.activeColormap, rules: [rule] },
      footprintGroups: [{ id: 'g', name: 'G', color: '#f00', enabled: true, sourceIndex: -1, sizeMin: 1, sizeMax: 50,
        overlapFraction: 0, conditions: [{ target: 'track', trackId: '2' }, { target: 'gene' }] }],
    } as never);
    await removeBackendTrack(0);
    const after = useBrowserStore.getState();
    // B (was 1) is now 0; the removed track's condition matches nothing.
    expect(after.activeColormap.rules[0].conditions.map(c => c.trackId)).toEqual(['0', 'removed']);
    expect(after.footprintGroups[0].conditions?.map(c => c.trackId)).toEqual(['1', undefined]);
  });
});

describe('registering a track', () => {
  beforeEach(() => {
    useBrowserStore.setState({ catalog: [], compositeTracks: [] } as never);
    vi.mocked(addTrack).mockReset();
  });

  it('shows a BED file as intervals, not a signal curve', async () => {
    vi.mocked(addTrack).mockResolvedValue({ success: true, track_index: 0, label: 'peaks.bed', render_mode: 'annotation' });
    const res = await registerTrack({ pathOrUrl: '/data/peaks.bed', source: 'local' });
    expect(res.success).toBe(true);
    const st = useBrowserStore.getState();
    expect(st.catalog.find(e => e.id === res.catalogEntryId)?.kind).toBe('bigbed');
    expect(st.compositeTracks.find(c => c.id === res.compositeId)?.kind).toBe('annotation');
  });

  it('follows the server when it reads an unrecognised URL as intervals', async () => {
    vi.mocked(addTrack).mockResolvedValue({ success: true, track_index: 1, label: 'sites', render_mode: 'annotation' });
    const res = await registerTrack({ pathOrUrl: 'https://example.org/track?id=7', source: 'online' });
    expect(useBrowserStore.getState().compositeTracks.find(c => c.id === res.compositeId)?.kind).toBe('annotation');
  });

  it('keeps a bigWig a signal track', async () => {
    vi.mocked(addTrack).mockResolvedValue({ success: true, track_index: 2, label: 'cov.bw', render_mode: 'signal' });
    const res = await registerTrack({ pathOrUrl: '/data/cov.bw', source: 'local' });
    expect(useBrowserStore.getState().compositeTracks.find(c => c.id === res.compositeId)?.kind).toBe('signal');
  });

  it('classifies BED paths as annotation sources', () => {
    expect(inferCatalogKind('/data/peaks.bed')).toBe('bigbed');
    expect(inferCatalogKind('/data/peaks.bed.gz')).toBe('bigbed');
    expect(inferCatalogKind('/data/cov.bigwig')).toBe('bigwig');
  });
});

describe('removing a track by index', () => {
  const entry = (id: string, filterNames?: string[], trackIndex?: number) => ({
    id, label: id, source: 'local' as const, kind: 'bigbed' as const, path: '/data/jaspar.bb',
    addedAt: 0, ...(filterNames ? { filterNames } : {}), ...(trackIndex != null ? { trackIndex } : {}),
  });

  beforeEach(() => {
    vi.mocked(removeTrack).mockReset();
    vi.mocked(removeTrack).mockResolvedValue({ success: true });
    vi.mocked(getTracks).mockReset();
    useBrowserStore.setState({ trackFilters: {}, compositeTracks: [] } as never);
  });

  it('removes only the entry stamped with that index, not a sibling from the same file', async () => {
    useBrowserStore.setState({ catalog: [entry('ctcf', ['CTCF'], 0), entry('max', ['MAX'], 1)] } as never);
    await removeTrackAtIndex(0);
    expect(vi.mocked(removeTrack).mock.calls.map(call => call[0])).toEqual([0]);
    expect(useBrowserStore.getState().catalog.map(e => e.id).sort()).toEqual(['ctcf', 'max']);
  });

  it('without stamped indices, removes only an entry with the same file and filter', async () => {
    vi.mocked(getTracks).mockResolvedValue({ tracks: [{ path: '/data/jaspar.bb', filter_names: ['CTCF'] }] } as never);
    useBrowserStore.setState({ catalog: [entry('ctcf', ['CTCF']), entry('max', ['MAX'])] } as never);
    await removeTrackAtIndex(0);
    expect(vi.mocked(removeTrack).mock.calls.map(call => call[0])).toEqual([0]);
  });
});

describe('changing a track\'s name filter', () => {
  const entry = (id: string, filterNames?: string[], trackIndex?: number) => ({
    id, label: id, source: 'local' as const, kind: 'bigbed' as const, path: '/data/jaspar.bb',
    addedAt: 0, ...(filterNames ? { filterNames } : {}), ...(trackIndex != null ? { trackIndex } : {}),
  });

  beforeEach(() => {
    vi.mocked(updateTrackFilter).mockReset();
    vi.mocked(updateTrackFilter).mockResolvedValue({ success: true } as never);
    vi.mocked(getTracks).mockReset();
    useBrowserStore.setState({ trackFilters: {} } as never);
  });

  it('keeps the catalog entry in step, so a later re-registration uses the new filter', async () => {
    useBrowserStore.setState({ catalog: [entry('motifs', ['CTCF'], 0), entry('other', ['REST'], 1)] } as never);
    await setTrackNameFilter(0, ['MAX']);
    const catalog = useBrowserStore.getState().catalog;
    expect(catalog.find(e => e.id === 'motifs')?.filterNames).toEqual(['MAX']);
    expect(catalog.find(e => e.id === 'other')?.filterNames).toEqual(['REST']);
    expect(useBrowserStore.getState().trackFilters[0]).toEqual(['MAX']);
    await setTrackNameFilter(0, null);
    expect(useBrowserStore.getState().catalog.find(e => e.id === 'motifs')?.filterNames).toBeUndefined();
  });

  it('finds an unstamped entry by its file and current filter', async () => {
    vi.mocked(getTracks).mockResolvedValue({ tracks: [{ path: '/data/jaspar.bb', filter_names: ['CTCF'] }] } as never);
    useBrowserStore.setState({ catalog: [entry('ctcf', ['CTCF']), entry('max', ['MAX'])] } as never);
    await setTrackNameFilter(0, ['YY1']);
    const catalog = useBrowserStore.getState().catalog;
    expect(catalog.find(e => e.id === 'ctcf')?.filterNames).toEqual(['YY1']);
    expect(catalog.find(e => e.id === 'max')?.filterNames).toEqual(['MAX']);
  });
});
