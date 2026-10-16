import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisStatus } from './shared';
import { getTracks } from '../../api/tracks';
import {
  getUcscCurated, browseUcscTracks,
  getEncodeFacets, searchEncode,
  getChipAtlasFacets, searchChipAtlas,
  type UcscTrack, type UcscBrowseResponse,
  type EncodeFacetsResponse, type EncodeTrack,
  type ChipAtlasFacetsResponse, type ChipAtlasTrack,
} from '../../api/externalTracks';
import { registerTrack, removeBackendTrack, unloadCatalogEntries } from '../../utils/trackLoader';
import {
  filterUcscTrackGroups,
  getDefaultExpandedUcscGroups,
  supportsEncodeGenome,
} from '../../utils/trackBrowserCatalog';
import { useBrowserStore } from '../../stores/browserStore';
import { CartTab } from './track-browser/CartTab';
import { TrackTypeBadge } from './track-browser/TrackTypeBadge';
import { ArrowLeft, CheckCircle, Circle, X } from '../ui/Icons';
import { useRememberedState } from '../../hooks/useRememberedState';
import { isPublicHostPage } from '../../utils/publicServerFlag';

type TabId = 'curated' | 'ucsc' | 'encode' | 'chipatlas';
const TAB_KEYS: TabId[] = ['curated', 'ucsc', 'encode', 'chipatlas'];
const TAB_LABELS: Record<TabId, string> = { curated: 'Curated', ucsc: 'UCSC', encode: 'ENCODE', chipatlas: 'ChIP-Atlas' };

/** My tracks (with the add box) is the panel; hubs are browsed on demand. */
type ViewId = 'tracks' | 'hubs';

interface TrackBrowserPanelProps {
  isFullView?: boolean;
}

export function TrackBrowserPanel({ isFullView }: TrackBrowserPanelProps) {
  const isPublic = isPublicHostPage();
  const currentGenome = useBrowserStore(s => s.currentGenome);
  const setTrackFilter = useBrowserStore(s => s.setTrackFilter);
  const cartTrackCount = useBrowserStore(s => s.compositeTracks.length);
  const visibleCartTrackCount = useBrowserStore(s => s.compositeTracks.filter(track => track.visible).length);
  const savedTrackCount = useBrowserStore(s => s.savedTracks.length);

  const [view, setView] = useRememberedState<ViewId>('track-browser:view', () => 'tracks');
  const [activeTab, setActiveTab] = useRememberedState<TabId>('track-browser:tab', () => 'curated');
  const [error, setError] = useState<string | null>(null);

  // Curated / UCSC state
  const [curatedTracks, setCuratedTracks] = useState<UcscTrack[]>([]);
  const [browseData, setBrowseData] = useState<UcscBrowseResponse | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [trackLoading, setTrackLoading] = useState<string | null>(null);

  // ENCODE state
  const [encodeFacets, setEncodeFacets] = useState<EncodeFacetsResponse | null>(null);
  const [encodeAssay, setEncodeAssay] = useState('');
  const [encodeTarget, setEncodeTarget] = useState('');
  const [encodeBiosample, setEncodeBiosample] = useState('');
  const [encodeQuery, setEncodeQuery] = useState('');
  const [encodeResults, setEncodeResults] = useState<EncodeTrack[]>([]);
  const [encodeSearching, setEncodeSearching] = useState(false);
  const [encodeTotal, setEncodeTotal] = useState(0);

  // ChIP-Atlas state
  const [chipAtlasFacets, setChipAtlasFacets] = useState<ChipAtlasFacetsResponse | null>(null);
  const [chipAtlasAntigenClass, setChipAtlasAntigenClass] = useState('');
  const [chipAtlasAntigen, setChipAtlasAntigen] = useState('');
  const [chipAtlasCellTypeClass, setChipAtlasCellTypeClass] = useState('');
  const [chipAtlasCellType, setChipAtlasCellType] = useState('');
  const [chipAtlasResults, setChipAtlasResults] = useState<ChipAtlasTrack[]>([]);
  const [chipAtlasSearching, setChipAtlasSearching] = useState(false);
  const [chipAtlasTotal, setChipAtlasTotal] = useState(0);
  const encodeSearchSeqRef = useRef(0);
  const encodeSearchAbortRef = useRef<AbortController | null>(null);
  const chipAtlasSearchSeqRef = useRef(0);
  const chipAtlasSearchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setBrowseData(null);
    setBrowseLoading(false);
    setEncodeFacets(null);
    setChipAtlasFacets(null);
    setEncodeResults([]);
    setChipAtlasResults([]);
    encodeSearchSeqRef.current += 1;
    encodeSearchAbortRef.current?.abort();
    encodeSearchAbortRef.current = null;
    setEncodeSearching(false);
    chipAtlasSearchSeqRef.current += 1;
    chipAtlasSearchAbortRef.current?.abort();
    chipAtlasSearchAbortRef.current = null;
    setChipAtlasSearching(false);
  }, [currentGenome]);

  // Fetch curated when genome changes
  useEffect(() => {
    if (!currentGenome || isPublic) { setCuratedTracks([]); return; }
    const controller = new AbortController();
    getUcscCurated(currentGenome, { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setCuratedTracks(res.tracks); })
      .catch(err => { if ((err as { name?: string })?.name !== 'AbortError') setCuratedTracks([]); });
    return () => controller.abort();
  }, [currentGenome, isPublic]);

  const refreshCurated = useCallback(() => {
    if (!currentGenome) return;
    getUcscCurated(currentGenome).then(res => setCuratedTracks(res.tracks)).catch(() => {});
  }, [currentGenome]);

  const refreshBrowse = useCallback(() => {
    if (!currentGenome) return;
    browseUcscTracks(currentGenome).then(res => setBrowseData(res)).catch(() => {});
  }, [currentGenome]);

  // Fetch browse data when switching to UCSC tab
  useEffect(() => {
    if (activeTab !== 'ucsc' || !currentGenome) return;
    if (browseData && browseData.genome === currentGenome) return;
    const controller = new AbortController();
    setBrowseLoading(true);
    browseUcscTracks(currentGenome, { signal: controller.signal })
      .then(res => {
        if (controller.signal.aborted) return;
        setBrowseData(res);
        setExpandedGroups(getDefaultExpandedUcscGroups(res.groups));
      })
      .catch(e => {
        if ((e as { name?: string })?.name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Failed to browse tracks');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setBrowseLoading(false); });
    return () => controller.abort();
  }, [activeTab, currentGenome, browseData]);

  // Fetch ENCODE facets
  useEffect(() => {
    if (activeTab !== 'encode' || !supportsEncodeGenome(currentGenome)) return;
    if (encodeFacets && encodeFacets.genome === currentGenome) return;
    const controller = new AbortController();
    getEncodeFacets(currentGenome, { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setEncodeFacets(res); })
      .catch(() => {});
    return () => controller.abort();
  }, [activeTab, currentGenome, encodeFacets]);

  // Fetch ChIP-Atlas facets. On first use the server is still downloading its
  // metadata ({loading: true}): ask again every few seconds until it's ready.
  useEffect(() => {
    if (activeTab !== 'chipatlas' || !currentGenome) return;
    const sameGenome = chipAtlasFacets?.genome === currentGenome;
    if (sameGenome && !chipAtlasFacets?.loading) return;
    const controller = new AbortController();
    const fetchFacets = () => {
      getChipAtlasFacets(currentGenome, { signal: controller.signal })
        .then(res => { if (!controller.signal.aborted) setChipAtlasFacets(res); })
        .catch(e => {
          if (controller.signal.aborted || (e as { name?: string })?.name === 'AbortError') return;
          // Polling stops here (nothing changed); reopening the tab retries.
          setError(e instanceof Error ? e.message : 'Failed to load ChIP-Atlas metadata');
        });
    };
    const timer = sameGenome ? setTimeout(fetchFacets, 3000) : null;
    if (!timer) fetchFacets();
    return () => {
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, currentGenome, chipAtlasFacets]);

  useEffect(() => () => {
    encodeSearchSeqRef.current += 1;
    encodeSearchAbortRef.current?.abort();
    chipAtlasSearchSeqRef.current += 1;
    chipAtlasSearchAbortRef.current?.abort();
  }, []);

  const filteredGroups = useMemo(() => {
    return filterUcscTrackGroups(browseData?.groups, filterQuery);
  }, [browseData, filterQuery]);

  const visibleCuratedTracks = useMemo(
    () => curatedTracks.filter(t => t.render_mode !== 'annotation'),
    [curatedTracks],
  );

  const handleAddTrack = async (track: UcscTrack, filterNames?: string[]) => {
    setTrackLoading(track.id);
    try {
      const res = await registerTrack({
        pathOrUrl: track.url,
        label: track.label,
        filterNames,
        source: 'online',
        catalogId: track.id,
      });
      if (res.success) {
        if (filterNames && filterNames.length > 0 && res.trackIndex !== undefined) {
          setTrackFilter(res.trackIndex, filterNames);
        }
        refreshCurated();
        if (activeTab === 'ucsc') refreshBrowse();
        useBrowserStore.getState().triggerRefresh();
      } else {
        setError(res.message || 'Failed to add track');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add track');
    } finally {
      setTrackLoading(null);
    }
  };

  const handleAddExternalTrack = async (url: string, label: string) => {
    setTrackLoading(url);
    try {
      const res = await registerTrack({ pathOrUrl: url, label, source: 'online' });
      if (res.success) {
        useBrowserStore.getState().triggerRefresh();
      } else {
        setError(res.message || 'Failed to add track');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add track');
    } finally {
      setTrackLoading(null);
    }
  };

  const handleRemoveTrack = async (track: UcscTrack) => {
    setTrackLoading(track.id);
    try {
      const tracksRes = await getTracks();
      const normalize = (p: string) => decodeURIComponent(p).replace(/\/+$/, '');
      const trackUrl = normalize(track.url);
      let idx = tracksRes.tracks.findIndex(t => normalize(t.path) === trackUrl);
      if (idx < 0) idx = tracksRes.tracks.findIndex(t => t.label === track.label);
      // Its cart entries go too, or the still-shown track registers it again.
      const entries = useBrowserStore.getState().catalog.filter(entry =>
        entry.catalogId === track.id || normalize(entry.url ?? entry.path ?? '') === trackUrl);
      if (entries.length > 0) {
        if (idx >= 0 && !entries.some(entry => typeof entry.trackIndex === 'number')) await removeBackendTrack(idx);
        await unloadCatalogEntries(entries.map(entry => entry.id));
      } else if (idx >= 0) {
        await removeBackendTrack(idx);
        useBrowserStore.getState().triggerRefresh();
      }
      if (entries.length > 0 || idx >= 0) {
        refreshCurated();
        if (activeTab === 'ucsc') refreshBrowse();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove track');
    } finally {
      setTrackLoading(null);
    }
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  };

  const handleEncodeSearch = async () => {
    if (!currentGenome) return;
    encodeSearchAbortRef.current?.abort();
    const controller = new AbortController();
    encodeSearchAbortRef.current = controller;
    const searchSeq = encodeSearchSeqRef.current + 1;
    encodeSearchSeqRef.current = searchSeq;
    setEncodeSearching(true);
    try {
      const res = await searchEncode(
        currentGenome,
        encodeAssay || undefined,
        encodeTarget || undefined,
        encodeBiosample || undefined,
        encodeQuery || undefined,
        25,
        { signal: controller.signal },
      );
      if (encodeSearchSeqRef.current !== searchSeq || controller.signal.aborted) return;
      setEncodeResults(res.tracks || []);
      setEncodeTotal(res.total || 0);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || encodeSearchSeqRef.current !== searchSeq) return;
      setError('ENCODE search failed');
    } finally {
      if (encodeSearchSeqRef.current === searchSeq) {
        encodeSearchAbortRef.current = null;
        setEncodeSearching(false);
      }
    }
  };

  const handleChipAtlasSearch = async () => {
    if (!currentGenome) return;
    chipAtlasSearchAbortRef.current?.abort();
    const controller = new AbortController();
    chipAtlasSearchAbortRef.current = controller;
    const searchSeq = chipAtlasSearchSeqRef.current + 1;
    chipAtlasSearchSeqRef.current = searchSeq;
    setChipAtlasSearching(true);
    try {
      const res = await searchChipAtlas(
        currentGenome,
        chipAtlasAntigenClass || undefined,
        chipAtlasAntigen || undefined,
        chipAtlasCellTypeClass || undefined,
        chipAtlasCellType || undefined,
        25,
        { signal: controller.signal },
      );
      if (chipAtlasSearchSeqRef.current !== searchSeq || controller.signal.aborted) return;
      setChipAtlasResults(res.tracks || []);
      setChipAtlasTotal(res.total || 0);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || chipAtlasSearchSeqRef.current !== searchSeq) return;
      setError('ChIP-Atlas search failed');
    } finally {
      if (chipAtlasSearchSeqRef.current === searchSeq) {
        chipAtlasSearchAbortRef.current = null;
        setChipAtlasSearching(false);
      }
    }
  };

  const panelHeader = (
    <div className="space-y-1">
      <AnalysisPanelHeader
        detail="Tracks drawn beside the reads: your own files, online hubs, TF motifs and combined tracks."
        theme="blue"
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-gray-700 dark:text-gray-200" data-testid="tracks-status">
        {currentGenome ? (
          <>
            <span className="rounded-full bg-gray-100 px-1.5 py-px text-[11px] font-medium text-gray-500 dark:bg-white/10 dark:text-gray-400">{currentGenome}</span>
            <span>{visibleCartTrackCount} of {cartTrackCount} tracks shown</span>
          </>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">Select a genome before browsing online catalogs or loading genome-scoped tracks.</span>
        )}
      </div>
    </div>
  );
  const showEncodeTab = supportsEncodeGenome(currentGenome);
  const visibleTabs = TAB_KEYS.filter(t => t !== 'encode' || showEncodeTab);

  return (
    <AnalysisPanelShell
      tabs={[]}
      activeTab=""
      onTabChange={() => {}}
      theme="blue"
      isFullView={isFullView}
      header={panelHeader}
      layout="standard"
      className="flex flex-col h-full"
      bodyMode="none"
      bodyClassName="flex flex-col min-h-0 flex-1"
    >
      {view === 'tracks' && (
        <div className="flex-1 overflow-y-auto"><CartTab onBrowseHubs={() => setView('hubs')} /></div>
      )}
      {view === 'hubs' && (
        <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-1 text-[12px] dark:border-white/10">
          <button type="button" onClick={() => setView('tracks')} className="rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40" data-testid="hubs-back">
            <span className="inline-flex items-center gap-1"><ArrowLeft size={12} aria-hidden="true" />My tracks</span>
          </button>
          <span className="text-gray-500">Browse hubs: pick a track to add it</span>
        </div>
      )}
      {view === 'hubs' && !currentGenome && (
        <AnalysisStatus kind="empty" center title="Select a genome">
          Online hubs are genome-specific: choose a genome in the sidebar's Genome section.
          Files, motifs and recent tracks work without one.
        </AnalysisStatus>
      )}
      {view === 'hubs' && currentGenome && (
        <AnalysisPanelShell
          tabs={visibleTabs.map(k => ({ key: k, label: TAB_LABELS[k] }))}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          theme="blue"
          className="flex flex-col min-h-0 flex-1"
          bodyMode="fill"
          bodyClassName="p-2"
        >
          {/* Curated tab */}
          {activeTab === 'curated' && (
            <div className="space-y-0.5">
              {visibleCuratedTracks.map(track => (
              <button
                key={track.id}
                onClick={() => track.loaded ? handleRemoveTrack(track) : handleAddTrack(track)}
                disabled={trackLoading === track.id}
                className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-gray-100 dark:hover:bg-white/5 flex items-center gap-1.5"
                title={track.description ? `${track.label}: ${track.description}` : track.label}
              >
                <span className={track.loaded ? 'text-green-500' : 'text-gray-300 dark:text-gray-600'}>
                  {track.loaded ? <CheckCircle size={12} aria-label="Loaded" /> : <Circle size={12} aria-hidden="true" />}
                </span>
                <span className="flex-1 truncate">{track.label}</span>
                {trackLoading === track.id && <span className="text-[11px] text-blue-500 animate-pulse">...</span>}
              </button>
            ))}
            {visibleCuratedTracks.length === 0 && (
              <AnalysisStatus kind="empty" compact center title={`No curated tracks for ${currentGenome}`}>
                Use Catalog or Online search to add tracks.
              </AnalysisStatus>
            )}
          </div>
        )}

        {/* UCSC Browse tab */}
        {activeTab === 'ucsc' && (
          <div>
            <input
              type="text"
              value={filterQuery}
              onChange={e => setFilterQuery(e.target.value)}
              placeholder="Filter tracks..."
              className="w-full px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200 outline-none focus:border-blue-400 mb-1.5"
              autoFocus
            />
            {browseData && !browseLoading && (
              <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">
                {browseData.total} tracks ({browseData.loadable_count} loadable)
              </div>
            )}
            {browseLoading && (
              <AnalysisStatus kind="loading" compact center>
                Loading tracks from UCSC...
              </AnalysisStatus>
            )}
            {!browseLoading && browseData && (
              <div className="rounded border border-gray-200 dark:border-white/10">
                {Object.entries(filteredGroups).map(([group, tracks]) => {
                  const loadableCount = tracks.filter(t => t.loadable).length;
                  const isExpanded = expandedGroups.has(group);
                  return (
                    <div key={group}>
                      <button
                        onClick={() => toggleGroup(group)}
                        className="w-full text-left px-2 py-1.5 text-xs font-medium bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 border-b border-gray-200 dark:border-white/10 flex items-center gap-1.5 sticky top-0 z-10"
                      >
                        <span className="text-[11px] text-gray-400">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                        <span className="flex-1 text-gray-700 dark:text-gray-300">{group}</span>
                        <span className="text-[11px] text-gray-400 dark:text-gray-500">
                          {tracks.length}
                          {loadableCount > 0 && <span className="text-blue-500 dark:text-blue-400 ml-0.5">({loadableCount} loadable)</span>}
                        </span>
                      </button>
                      {isExpanded && tracks.map(track => (
                        <button
                          key={track.id}
                          onClick={() => { if (!track.loadable) return; track.loaded ? handleRemoveTrack(track) : handleAddTrack(track); }}
                          disabled={!track.loadable || trackLoading === track.id}
                          className={`w-full text-left px-2 py-1 text-xs border-b border-gray-100 dark:border-white/5 last:border-b-0 flex items-center gap-1.5 ${
                            track.loadable ? 'hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer' : 'opacity-40 cursor-default'
                          }`}
                          title={track.description ? `${track.label}: ${track.description}` : track.label}
                        >
                          <span className={`flex-shrink-0 ${track.loaded ? 'text-green-500' : track.loadable ? 'text-gray-300 dark:text-gray-600' : 'text-gray-200 dark:text-gray-700'}`}>
                            {track.loaded ? <CheckCircle size={12} aria-label="Loaded" /> : <Circle size={12} aria-hidden="true" />}
                          </span>
                          <span className={`flex-1 truncate ${track.loadable ? 'text-gray-800 dark:text-gray-200' : 'text-gray-400 dark:text-gray-600'}`}>
                            {track.label}
                          </span>
                          <TrackTypeBadge type={track.type || ''} />
                          {!track.loadable && <span className="text-[11px] text-gray-400 dark:text-gray-600 flex-shrink-0">(not loadable)</span>}
                          {trackLoading === track.id && <span className="text-[11px] text-blue-500 animate-pulse flex-shrink-0">loading</span>}
                        </button>
                      ))}
                    </div>
                  );
                })}
                {Object.keys(filteredGroups).length === 0 && filterQuery && (
                  <AnalysisStatus kind="empty" compact center>
                    No tracks match "{filterQuery}"
                  </AnalysisStatus>
                )}
              </div>
            )}
          </div>
        )}

        {/* ENCODE tab */}
        {activeTab === 'encode' && showEncodeTab && (
          <div>
            {!encodeFacets ? (
              <AnalysisStatus kind="loading" compact center>
                Loading ENCODE facets...
              </AnalysisStatus>
            ) : encodeFacets.error ? (
              <AnalysisStatus kind="error" compact>
                {encodeFacets.error}
              </AnalysisStatus>
            ) : (
              <>
                <div className="space-y-1 mb-2">
                  <select value={encodeAssay} onChange={e => setEncodeAssay(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200">
                    <option value="">All assays</option>
                    {(encodeFacets.assays || []).map(a => <option key={a.key} value={a.key}>{a.key} ({a.count})</option>)}
                  </select>
                  <select value={encodeTarget} onChange={e => setEncodeTarget(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200">
                    <option value="">All targets</option>
                    {(encodeFacets.targets || []).map(t => <option key={t.key} value={t.key}>{t.key} ({t.count})</option>)}
                  </select>
                  <select value={encodeBiosample} onChange={e => setEncodeBiosample(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200">
                    <option value="">All biosamples</option>
                    {(encodeFacets.biosamples || []).map(b => <option key={b.key} value={b.key}>{b.key} ({b.count})</option>)}
                  </select>
                  <div className="flex gap-1">
                    <input type="text" value={encodeQuery} onChange={e => setEncodeQuery(e.target.value)}
                      placeholder="Search term..."
                      className="flex-1 px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200 outline-none focus:border-blue-400"
                      onKeyDown={e => e.key === 'Enter' && handleEncodeSearch()} />
                    <AnalysisButton
                      onClick={handleEncodeSearch}
                      disabled={encodeSearching}
                      theme="blue"
                      variant="primary"
                      size="sm"
                      className="px-3"
                    >
                      {encodeSearching ? '...' : 'Search'}
                    </AnalysisButton>
                  </div>
                </div>
                {encodeResults.length > 0 && (
                  <div className="rounded border border-gray-200 dark:border-white/10">
                    <div className="text-[11px] text-gray-400 px-2 py-1 bg-gray-50 dark:bg-white/5 border-b dark:border-white/10">
                      {encodeTotal} results (showing {encodeResults.length})
                    </div>
                    {encodeResults.map((track, i) => (
                      <button key={i} onClick={() => handleAddExternalTrack(track.url, track.label)}
                        disabled={trackLoading === track.url}
                        title={track.label}
                        className="w-full text-left px-2 py-1 text-xs border-b border-gray-100 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 flex items-center gap-1.5">
                        <span className="text-gray-300"><Circle size={12} aria-hidden="true" /></span>
                        <span className="flex-1 truncate text-gray-800 dark:text-gray-200">{track.label}</span>
                        {track.file_size > 0 && <span className="text-[11px] text-gray-400">{(track.file_size / 1048576).toFixed(1)}MB</span>}
                        {trackLoading === track.url && <span className="text-[11px] text-blue-500 animate-pulse">loading</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ChIP-Atlas tab */}
        {activeTab === 'chipatlas' && (
          <div>
            {!chipAtlasFacets ? (
              <AnalysisStatus kind="loading" compact center>
                Loading ChIP-Atlas metadata...
              </AnalysisStatus>
            ) : chipAtlasFacets.loading ? (
              <AnalysisStatus kind="loading" compact center>
                Downloading metadata (first time only)...
              </AnalysisStatus>
            ) : !chipAtlasFacets.supported ? (
              <AnalysisStatus kind="empty" compact center>
                ChIP-Atlas is not available for {currentGenome}.
              </AnalysisStatus>
            ) : (
              <>
                <div className="space-y-1 mb-2">
                  <select value={chipAtlasAntigenClass} onChange={e => setChipAtlasAntigenClass(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200">
                    <option value="">All antigen classes</option>
                    {(chipAtlasFacets.antigen_classes || []).map(a => <option key={a.key} value={a.key}>{a.key} ({a.count})</option>)}
                  </select>
                  <input type="text" value={chipAtlasAntigen} onChange={e => setChipAtlasAntigen(e.target.value)}
                    placeholder="Antigen name (e.g. CTCF)..."
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200 outline-none focus:border-blue-400" />
                  <select value={chipAtlasCellTypeClass} onChange={e => setChipAtlasCellTypeClass(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200">
                    <option value="">All cell type classes</option>
                    {(chipAtlasFacets.cell_type_classes || []).map(c => <option key={c.key} value={c.key}>{c.key} ({c.count})</option>)}
                  </select>
                  <div className="flex gap-1">
                    <input type="text" value={chipAtlasCellType} onChange={e => setChipAtlasCellType(e.target.value)}
                      placeholder="Cell type..."
                      className="flex-1 px-2 py-1 text-xs rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-black/30 text-gray-800 dark:text-gray-200 outline-none focus:border-blue-400"
                      onKeyDown={e => e.key === 'Enter' && handleChipAtlasSearch()} />
                    <AnalysisButton
                      onClick={handleChipAtlasSearch}
                      disabled={chipAtlasSearching}
                      theme="blue"
                      variant="primary"
                      size="sm"
                      className="px-3"
                    >
                      {chipAtlasSearching ? '...' : 'Search'}
                    </AnalysisButton>
                  </div>
                  {chipAtlasFacets.total_experiments && (
                    <div className="text-[11px] text-gray-400">{chipAtlasFacets.total_experiments.toLocaleString()} experiments for {currentGenome}</div>
                  )}
                </div>
                {chipAtlasResults.length > 0 && (
                  <div className="rounded border border-gray-200 dark:border-white/10">
                    <div className="text-[11px] text-gray-400 px-2 py-1 bg-gray-50 dark:bg-white/5 border-b dark:border-white/10">
                      {chipAtlasTotal} results (showing {chipAtlasResults.length})
                    </div>
                    {chipAtlasResults.map((track, i) => (
                      <button key={i} onClick={() => handleAddExternalTrack(track.url, track.label)}
                        disabled={trackLoading === track.url}
                        title={track.label}
                        className="w-full text-left px-2 py-1 text-xs border-b border-gray-100 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 flex items-center gap-1.5">
                        <span className="text-gray-300"><Circle size={12} aria-hidden="true" /></span>
                        <span className="flex-1 truncate text-gray-800 dark:text-gray-200">{track.label}</span>
                        <span className="text-[11px] text-gray-400 flex-shrink-0">{track.id}</span>
                        {trackLoading === track.url && <span className="text-[11px] text-blue-500 animate-pulse">loading</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && (
          <AnalysisStatus kind="error" compact className="mt-2">
            {error}
            <AnalysisButton
              onClick={() => setError(null)}
              variant="dangerOutline"
              className="ml-2 px-1 py-0 leading-none"
              aria-label="Dismiss track browser error"
            >
              <X size={11} />
            </AnalysisButton>
          </AnalysisStatus>
        )}
        </AnalysisPanelShell>
      )}
    </AnalysisPanelShell>
  );
}
