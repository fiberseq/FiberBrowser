import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { pickAnyFile, uploadFile } from '../../../api/files';
import { getUcscCurated, type UcscTrack } from '../../../api/externalTracks';
import { searchJasparMotifs, type JasparSearchResult } from '../../../api/tracks';
import { forgetRecentTrack, getRecentTracks, recentTracksOffered, type RecentTrack } from '../../../api/recentTracks';
import { isLocalPage } from '../../../utils/serverFileBrowser';
import { isPublicHostPage } from '../../../utils/publicServerFlag';
import {
  IUPAC_MOTIF_RE, addJasparMotifs, addMotifFile, addMotifUpload, addPwmMotif, addSequenceMotif, motifSearchReference, parsePwmText,
  type MotifAddResult,
} from '../../../utils/motifLoader';
import { addRecentSource, looksLikeMotifFile, registerTrack, showRecentSource } from '../../../utils/trackLoader';
import type { CatalogEntry } from '../../../types/dataset';
import { AnalysisButton } from '../shared';

const TRACK_FILE_RE = /\.(bw|bigwig|bb|bigbed|bed|bed\.gz|jaspar|meme|pfm|motif|homer)$/i;
const MAX_PER_GROUP = 6;

/** Looks like something to open directly rather than search for. */
function looksLikeLocation(text: string): boolean {
  return /^(https?|s3):\/\//i.test(text) || /^[~/]/.test(text) || /^[A-Za-z]:[\\/]/.test(text) || TRACK_FILE_RE.test(text);
}

interface RecentItem {
  key: string;
  label: string;
  detail: string;
  kind: CatalogEntry['kind'];
  available: boolean;
  /** Present when the server remembers it. */
  serverKey?: string;
  /** Present when it is in this session's source list. */
  catalogEntryId?: string;
  entry: Parameters<typeof showRecentSource>[0];
}

function entryKey(entry: { source: string; path?: string; url?: string; filterNames?: string[] }): string {
  return `${entry.source}|${entry.path ?? entry.url ?? ''}|${[...(entry.filterNames ?? [])].sort().join(',')}`;
}

function describe(entry: { path?: string; url?: string }): string {
  const where = entry.path ?? entry.url ?? '';
  if (where.startsWith('motif://jaspar/')) return `JASPAR ${decodeURIComponent(where.slice('motif://jaspar/'.length))}`;
  if (where.startsWith('motif://sequence/')) return 'sequence motif';
  return where.split(/[\\/]/).pop() || where;
}

/** Add to an existing track instead of creating new ones ("+ Add source"). */
export interface AddTrackTarget {
  /** Which kinds of source this track can show. */
  accepts: (kind: CatalogEntry['kind']) => boolean;
  /** Called with the sources that were loaded or picked. */
  onAdded: (catalogEntryIds: string[]) => void;
}

interface AddTrackBoxProps {
  onBrowseHubs?: () => void;
  onNewTrack?: (kind: 'signal' | 'metaprofile') => void;
  target?: AddTrackTarget;
}

type AddResult = { success: boolean; message?: string; catalogEntryIds?: string[]; catalogEntryId?: string };

function guessKind(url: string): CatalogEntry['kind'] {
  return /\.(bb|bigbed)$/i.test(url.split(/[?#]/, 1)[0] ?? url) ? 'bigbed' : 'bigwig';
}

/**
 * The one place to add a track: type a file path or URL to open it, or a
 * name to search what you used before, JASPAR motifs and curated UCSC tracks
 * together. Faceted catalogues (ENCODE, ChIP-Atlas, full UCSC) are under
 * "Browse hubs".
 */
export function AddTrackBox({ onBrowseHubs, onNewTrack, target }: AddTrackBoxProps) {
  // With a target, results become sources of that track rather than new tracks.
  const standalone = !target;
  const addOpts = { standalone };
  const { currentGenome, catalog, motifThreshold, setMotifThreshold, publicMode } = useBrowserStore(useShallow(s => ({
    publicMode: s.publicMode,
    currentGenome: s.currentGenome,
    catalog: s.catalog,
    motifThreshold: s.motifThreshold,
    setMotifThreshold: s.setMotifThreshold,
  })));
  // Motif search ranks for the analysed panels' reference (an expanded insert's genome, ...), not the main one.
  const motifReference = useBrowserStore(s => motifSearchReference(s));
  const referenceRevision = useBrowserStore(s => s.referenceRevision);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [serverRecent, setServerRecent] = useState<RecentTrack[]>([]);
  const [curated, setCurated] = useState<UcscTrack[]>([]);
  const [motifs, setMotifs] = useState<{ query: string; results: JasparSearchResult[] }>({ query: '', results: [] });
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const [pwmText, setPwmText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  // A --public server offers motifs only: no files, uploads, URLs or hubs.
  const catalogOnly = isPublicHostPage();

  const hasRecent = recentTracksOffered(publicMode);
  const loadRecent = useCallback(() => {
    if (!hasRecent) { setServerRecent([]); return; }
    getRecentTracks().then(setServerRecent).catch(() => setServerRecent([]));
  }, [hasRecent]);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  useEffect(() => {
    if (!currentGenome || catalogOnly) { setCurated([]); return; }
    const controller = new AbortController();
    getUcscCurated(currentGenome, { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setCurated(res.tracks.filter(t => t.render_mode !== 'annotation')); })
      .catch(() => {});
    return () => controller.abort();
  }, [currentGenome, catalogOnly]);

  // JASPAR search (skipped for paths and sequences).
  useEffect(() => {
    if (trimmed.length < 2 || looksLikeLocation(trimmed)) {
      setMotifs({ query: trimmed, results: [] });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchJasparMotifs(trimmed, motifReference, controller.signal)
        .then(res => setMotifs({ query: trimmed, results: res.available ? res.results : [] }))
        .catch(() => { if (!controller.signal.aborted) setMotifs({ query: trimmed, results: [] }); });
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  // The main genome (a load, a declaration) changes the ranking even when no panel reference is sent.
  }, [trimmed, motifReference, currentGenome, referenceRevision]);

  // Close the result list on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const recent: RecentItem[] = useMemo(() => {
    const items = new Map<string, RecentItem>();
    for (const row of serverRecent) {
      const entry = { source: row.source, kind: row.kind, label: row.label, path: row.path, url: row.url,
        catalogId: row.catalogId, filterNames: row.filterNames, meta: row.meta };
      items.set(entryKey(entry), { key: entryKey(entry), label: row.label, detail: describe(entry), kind: row.kind,
        available: row.available, serverKey: row.key, entry });
    }
    for (const c of catalog) {
      const key = entryKey(c);
      if (c.kind === 'metaprofile-rule') continue;
      const known = items.get(key);
      if (known) { known.catalogEntryId = c.id; continue; }
      items.set(key, { key, label: c.label, detail: describe(c), kind: c.kind, available: !c.unavailable, catalogEntryId: c.id,
        entry: { source: c.source, kind: c.kind, label: c.label, path: c.path, url: c.url, catalogId: c.catalogId,
          filterNames: c.filterNames, meta: c.meta } });
    }
    return [...items.values()];
  }, [serverRecent, catalog]);

  const matches = (text: string) => !lower || text.toLowerCase().includes(lower);
  const fits = (kind: CatalogEntry['kind']) => !target || target.accepts(kind);
  const recentMatches = recent.filter(item => fits(item.kind) && (matches(item.label) || matches(item.detail))).slice(0, lower ? MAX_PER_GROUP : 8);
  const motifMatches = motifs.query === trimmed && fits('motif') ? motifs.results.slice(0, MAX_PER_GROUP) : [];
  const curatedMatches = lower ? curated.filter(t => fits(guessKind(t.url)) && (matches(t.label) || matches(t.id))).slice(0, MAX_PER_GROUP) : [];
  const asLocation = trimmed && !catalogOnly && looksLikeLocation(trimmed) ? trimmed : null;
  const asSequence = trimmed && !asLocation && IUPAC_MOTIF_RE.test(trimmed) ? trimmed.toUpperCase() : null;

  const run = async (action: () => Promise<MotifAddResult | AddResult>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setMessage({ ok: result.success, text: result.message ?? (result.success ? done ?? 'Added' : 'Could not add the track') });
      if (result.success) {
        const ids = (result as AddResult).catalogEntryIds ?? ((result as AddResult).catalogEntryId ? [(result as AddResult).catalogEntryId!] : []);
        if (target && ids.length) {
          // A pasted path or file can be of a kind this track can't draw.
          const catalog = useBrowserStore.getState().catalog;
          const fitting = ids.filter(id => { const e = catalog.find(c => c.id === id); return !e || target.accepts(e.kind); });
          if (fitting.length) target.onAdded(fitting);
          if (fitting.length < ids.length) {
            const kinds = [...new Set(ids.filter(id => !fitting.includes(id)).map(id => catalog.find(c => c.id === id)?.kind ?? 'file'))];
            setMessage({ ok: false, text: `This track can't show ${kinds.join('/')} sources; add it as a track of its own instead.` });
            return;
          }
        }
        setQuery('');
        setOpen(false);
        useBrowserStore.getState().triggerRefresh();
        loadRecent();
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Could not add the track' });
    } finally {
      setBusy(false);
    }
  };

  const openLocation = (location: string) => run(() => (
    looksLikeMotifFile(location)
      ? addMotifFile(location, addOpts)
      : registerTrack({ pathOrUrl: location, autoCreateComposite: standalone })
  ), 'Track added');
  const addRecent = (item: RecentItem) => {
    if (!item.available) return;
    void run(async () => {
      if (target) {
        const id = item.catalogEntryId ?? addRecentSource(item.entry);
        return { success: true, message: `Added ${item.label}`, catalogEntryIds: [id] };
      }
      showRecentSource(item.entry);
      return { success: true, message: `Showing ${item.label}` };
    });
  };
  const addCurated = (track: UcscTrack) => run(() => registerTrack({
    pathOrUrl: track.url, label: track.label, source: 'online', catalogId: track.id, autoCreateComposite: standalone,
  }), `Added ${track.label}`);
  /** Remove from the server history and, when no track uses it, from this session's list. */
  const forget = async (item: RecentItem) => {
    const store = useBrowserStore.getState();
    if (item.catalogEntryId && store.getCatalogRefCount(item.catalogEntryId) === 0) store.removeCatalogEntry(item.catalogEntryId);
    if (item.serverKey) await forgetRecentTrack(item.serverKey).catch(() => {});
    loadRecent();
  };
  const canForget = (item: RecentItem) => !!item.serverKey
    || (!!item.catalogEntryId && useBrowserStore.getState().getCatalogRefCount(item.catalogEntryId) === 0);

  const addFirst = () => {
    if (asLocation) void openLocation(asLocation);
    else if (asSequence && fits('motif')) void run(() => addSequenceMotif(asSequence, addOpts));
    else if (lower && recentMatches.find(item => item.available)) addRecent(recentMatches.find(item => item.available)!);
    else if (motifMatches[0]) void run(() => addJasparMotifs([motifMatches[0].matrix_id], addOpts));
    else if (curatedMatches[0]) void addCurated(curatedMatches[0]);
  };

  const browseFiles = async () => {
    const picked = await pickAnyFile();
    if (!picked.success || !picked.path) return;
    const paths = picked.paths?.length ? picked.paths : [picked.path];
    for (const path of paths) await openLocation(path);
  };

  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      await run(async () => {
        if (looksLikeMotifFile(file.name)) return addMotifUpload(file, addOpts);
        const uploaded = await uploadFile(file);
        if (!uploaded.success) return { success: false, message: `Upload failed: ${file.name}` };
        return registerTrack({ pathOrUrl: uploaded.path, label: file.name, source: 'local', autoCreateComposite: standalone });
      }, `Added ${file.name}`);
    }
  };

  const pwm = pwmText.trim() ? parsePwmText(pwmText) : null;
  const hasResults = !!asLocation || (!!asSequence && fits('motif')) || recentMatches.length > 0 || motifMatches.length > 0 || curatedMatches.length > 0;
  const rowClass = 'flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-950/40';
  const groupClass = 'px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-gray-400';

  return (
    <div ref={rootRef} className="space-y-1.5" data-testid="add-track-box">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={event => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={event => { if (event.key === 'Enter') addFirst(); }}
          disabled={busy}
          placeholder={catalogOnly
            ? (target ? 'Add a source: TF or motif name, or a DNA sequence' : 'Add a motif track: TF or motif name, or a DNA sequence')
            : target ? 'Add a source: path or URL, TF or motif name, or search' : 'Add a track: file path or URL, TF or motif name, or search'}
          aria-label={target ? 'Add a source' : 'Add a track'}
          data-copilot-anchor={target ? undefined : 'jaspar-name-input'}
          className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-[13px] dark:border-gray-600 dark:bg-gray-900"
        />
        {(open || !!target) && hasResults && (
          <div role="listbox" className={`${target ? 'mt-1 max-h-60' : 'absolute left-0 right-0 top-full z-30 mt-1 max-h-80 shadow-lg'} overflow-y-auto rounded border border-gray-200 bg-white text-[12px] dark:border-gray-700 dark:bg-gray-900`}>
            {asLocation && (
              <button type="button" role="option" className={rowClass} onClick={() => void openLocation(asLocation)}>
                Open <span className="truncate font-mono">{asLocation}</span>
              </button>
            )}
            {asSequence && fits('motif') && (
              <button type="button" role="option" className={rowClass} onClick={() => void run(() => addSequenceMotif(asSequence, addOpts))}>
                Add sequence motif <span className="font-mono">{asSequence}</span>
              </button>
            )}
            {recentMatches.length > 0 && <div className={groupClass}>Recent</div>}
            {recentMatches.map(item => (
              <div key={item.key} className="group flex items-center">
                <button type="button" role="option" disabled={!item.available} className={rowClass}
                  onClick={() => addRecent(item)}
                  title={item.available ? item.entry.path ?? item.entry.url : 'File not found at its saved location'}>
                  <span className="truncate font-medium text-gray-800 dark:text-gray-100">{item.label}</span>
                  <span className="truncate text-gray-500">{item.available ? item.detail : 'missing'}</span>
                </button>
                {canForget(item) && (
                  <button type="button" onClick={() => void forget(item)} title="Remove from recent"
                    className="mr-1 hidden rounded px-1 text-gray-400 hover:text-red-500 group-hover:block">×</button>
                )}
              </div>
            ))}
            {motifMatches.length > 0 && <div className={groupClass}>Motifs · JASPAR</div>}
            {motifMatches.map(result => (
              <button key={result.matrix_id} type="button" role="option" className={rowClass}
                onClick={() => void run(() => addJasparMotifs([result.matrix_id], addOpts))}>
                <span className="font-medium text-gray-800 dark:text-gray-100">{result.name}</span>
                <span className="text-gray-500">{result.matrix_id} · {result.tax_group} · {result.length} bp</span>
              </button>
            ))}
            {curatedMatches.length > 0 && <div className={groupClass}>Online · UCSC</div>}
            {curatedMatches.map(track => (
              <button key={track.id} type="button" role="option" className={rowClass} onClick={() => void addCurated(track)}
                title={track.description}>
                <span className="truncate font-medium text-gray-800 dark:text-gray-100">{track.label}</span>
                <span className="text-gray-500">{track.loaded ? 'shown' : 'signal'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {!catalogOnly && <>
        <AnalysisButton onClick={() => void browseFiles()} disabled={busy} theme="blue" variant="primary" size="sm" data-tour="tracks-browse-files"
          title={isLocalPage()
            ? 'BigWig, BigBed, BED or motif file (JASPAR, MEME, HOMER, PFM)'
            : 'Files on the server running FiberBrowser'}>
          Browse files…
        </AnalysisButton>
        <AnalysisButton onClick={() => uploadRef.current?.click()} disabled={busy} theme="blue" variant="soft" size="sm"
          title="Upload a track or motif file from this computer">
          Upload…
        </AnalysisButton>
        <input ref={uploadRef} type="file" multiple className="hidden" data-testid="add-track-upload"
          accept=".bw,.bigwig,.bb,.bigbed,.bed,.gz,.jaspar,.meme,.pfm,.motif,.homer,.txt"
          onChange={event => { const files = event.target.files; void uploadFiles(files).finally(() => { event.target.value = ''; }); }} />
        </>}
        {!target && onBrowseHubs && onNewTrack && <>
        {!catalogOnly && (
        <AnalysisButton onClick={onBrowseHubs} theme="blue" variant="soft" size="sm" data-tour="track-browse-hubs"
          title="UCSC, ENCODE and ChIP-Atlas catalogues with filters">
          Browse hubs…
        </AnalysisButton>
        )}
        <AnalysisButton onClick={() => onNewTrack('metaprofile')} theme="amber" variant="soft" size="sm" data-tour="track-add-metaprofile"
          title="Average profile of your reads' layers or colour rules">
          + Metaprofile
        </AnalysisButton>
        <AnalysisButton onClick={() => onNewTrack('signal')} variant="outline" size="sm"
          title="An empty track to combine several sources as overlays">
          + Combined track
        </AnalysisButton>
        </>}
      </div>

      {message && (
        <div className={`text-[11px] ${message.ok ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{message.text}</div>
      )}

      <details className="text-[12px]" data-tour="tracks-motif-options">
        <summary className="cursor-pointer text-gray-500">Motif options</summary>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2" title="Minimum relative PWM score (0–1) for a motif hit, used for every motif track and footprint motif scan">
            <span className="text-gray-600 dark:text-gray-300">Match threshold</span>
            <input
              type="number" min={0.5} max={1} step={0.05}
              value={thresholdDraft ?? motifThreshold}
              onChange={event => setThresholdDraft(event.target.value)}
              onBlur={() => {
                if (thresholdDraft !== null && thresholdDraft.trim() !== '') setMotifThreshold(Number(thresholdDraft));
                setThresholdDraft(null);
              }}
              onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
              className="w-16 rounded border border-gray-300 px-1 py-0.5 text-right dark:border-gray-600 dark:bg-gray-900"
            />
            <span className="text-[11px] text-gray-400">applies to motifs added next</span>
          </label>
          <textarea
            value={pwmText}
            onChange={event => setPwmText(event.target.value)}
            placeholder={'Paste a count matrix:\n>MyTF\nA 1 0 9 0\nC 8 0 0 1\nG 0 9 0 8\nT 0 0 0 0'}
            rows={5}
            aria-label="Paste a count matrix"
            className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-[11px] dark:border-gray-600 dark:bg-gray-900"
          />
          {pwm?.error && <div className="text-[11px] text-red-600 dark:text-red-400">{pwm.error}</div>}
          <AnalysisButton size="sm" variant="outline" disabled={busy || !pwm?.counts}
            onClick={() => pwm?.counts && void run(async () => {
              const result = await addPwmMotif(pwm.name || 'Custom matrix', pwm.counts!, addOpts);
              if (result.success) setPwmText('');
              return result;
            })}>
            Add matrix
          </AnalysisButton>
        </div>
      </details>
    </div>
  );
}
