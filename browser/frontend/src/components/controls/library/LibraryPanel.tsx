import { useMemo, useRef, useState } from 'react';
import {
  addLibraryFiles, addWatchedFolder, createLibraryGroup, deleteLibraryGroup, editLibraryGroup, exportLibraryCatalog,
  removeLibraryEntries, removeWatchedFolder, scanWatchedFolders, type LibraryEntry, type LibraryPayload,
} from '../../../api/library';
import { pickDataset, pickFolder } from '../../../api/files';
import {
  KIND_LABELS, basename, chemistryFilterLabel, facetValues, filterEntries, referenceFilterLabel, sortEntries,
  LIBRARY_SCOPE_TEXT, suggestedGroups, toggleSort, type SuggestedGroup,
} from '../../../utils/library';
import { openLibraryEntries } from '../../../utils/libraryOpen';
import { openConnectCluster } from '../../../utils/connectCluster';
import { isLabServerPage } from '../../../utils/labServer';
import { useBrowserStore } from '../../../stores/browserStore';
import { LibraryDetails } from './LibraryDetails';
import { LibraryTable } from './LibraryTable';
import { SuggestionReview, type SuggestionAction } from './SuggestionReview';
import { useLibraryStore } from './libraryStore';
import { Library } from '../../ui/Icons';

const BUTTON = 'px-2 py-1 rounded border border-gray-300 dark:border-white/15 text-[11.5px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';
const SELECT = 'w-full text-[11.5px] px-1.5 py-1 border rounded dark:bg-gray-900 dark:border-gray-600';
const HEADING = 'text-[11px] font-semibold text-gray-500 dark:text-gray-400';

function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'library';
}

/** Add entries to an existing group or a new one. */
function AddToGroup({ ids, payload, onDone, onCancel }: { ids: string[]; payload: LibraryPayload; onDone: (message: string) => void; onCancel: () => void }) {
  const [target, setTarget] = useState(payload.groups[0]?.id ?? '__new');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-1 rounded border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-900/20 p-1.5" data-testid="library-add-to-group">
      <span className="text-[11.5px]">Add {ids.length} to</span>
      <select className="text-[11.5px] px-1 py-0.5 border rounded dark:bg-gray-900 dark:border-gray-600" value={target} onChange={e => setTarget(e.target.value)}>
        {payload.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        <option value="__new">New group…</option>
      </select>
      {target === '__new' && (
        <input autoFocus className="text-[11.5px] px-1.5 py-0.5 border rounded dark:bg-gray-900 dark:border-gray-600" placeholder="Group name"
          value={name} onChange={e => setName(e.target.value)} data-testid="library-new-group-name" />
      )}
      <button type="button" className={BUTTON} data-testid="library-add-to-group-confirm" onClick={async () => {
        const res = target === '__new' ? await createLibraryGroup(name, ids) : await editLibraryGroup(target, { add: ids });
        if (!res.success) setError(res.error || 'Could not add to the group');
        else onDone(`Added to ${res.group?.name}.`);
      }}>Add</button>
      <button type="button" className={BUTTON} onClick={onCancel}>Cancel</button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}

export function LibraryPanel({ onClose }: { onClose: () => void }) {
  const payload = useLibraryStore(s => s.payload);
  const error = useLibraryStore(s => s.error);
  const filters = useLibraryStore(s => s.filters);
  const setFilters = useLibraryStore(s => s.setFilters);
  const resetFilters = useLibraryStore(s => s.resetFilters);
  const sort = useLibraryStore(s => s.sort);
  const setSort = useLibraryStore(s => s.setSort);
  const selectedId = useLibraryStore(s => s.selectedId);
  const select = useLibraryStore(s => s.select);
  const checked = useLibraryStore(s => s.checked);
  const setChecked = useLibraryStore(s => s.setChecked);
  const toggleChecked = useLibraryStore(s => s.toggleChecked);
  const refresh = useLibraryStore(s => s.refresh);
  const status = useLibraryStore(s => s.status);
  const setStatus = useLibraryStore(s => s.setStatus);
  const [groupTarget, setGroupTarget] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  // A folder suggestion being scanned and reviewed, and what each folder's scan found.
  const [review, setReview] = useState<{ suggestion: SuggestedGroup & { folder: string }; action: SuggestionAction } | null>(null);
  const scanned = useLibraryStore(s => s.scanned);  // kept when the window closes on Open
  const setScanned = useLibraryStore(s => s.setScanned);
  const reviewRef = useRef(review);
  reviewRef.current = review;

  const entries = payload?.entries ?? [];
  const groups = payload?.groups ?? [];
  const facets = useMemo(() => facetValues(entries), [entries]);
  const shown = useMemo(() => sortEntries(filterEntries(entries, filters, groups), sort), [entries, filters, groups, sort]);
  const suggestions = useMemo(() => suggestedGroups(entries, groups, scanned).slice(0, 12), [entries, groups, scanned]);
  const selected = entries.find(e => e.id === selectedId) ?? null;
  const byId = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);
  const scanning = payload?.scan.running;
  const anyRerun = entries.some(e => e.rerun);

  const act = async (work: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const message = await work();
      if (message) setStatus(message);
    } catch (err) {
      // Said where it is seen: the Library window may have closed already (an open shows its panel at once).
      const message = err instanceof Error ? err.message : String(err);
      setStatus(message);
      useBrowserStore.getState().setError(message);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const open = (list: LibraryEntry[], all: LibraryEntry[] = entries, genomes = payload?.genomes_downloaded ?? []) => act(async () => {
    setStatus(`Opening ${list.length === 1 ? list[0].label : `${list.length} files`}…`);
    // The files' placeholder panels show at once (name, progress, any error): the window closes then,
    // not after the reference and the server's checks.
    let closed = false;
    const res = await openLibraryEntries(list, all, genomes, {
      onStarted: () => { closed = true; onClose(); },
    });
    if (res.error) useBrowserStore.getState().setError(res.error);
    if (res.success && !closed) onClose();
    if (!res.success && !res.error) useBrowserStore.getState().setError(res.message || 'Nothing was opened.');
    return res.message || res.error;
  });

  /** A folder suggestion scans its folder first (review, then open or save); a run's opens as is. */
  const scannable = (s: SuggestedGroup): s is SuggestedGroup & { folder: string } =>
    s.source === 'folder' && Boolean(s.folder) && !s.folder!.includes('://');

  const openScanned = async (ids: string[], note: string) => {
    const asked = reviewRef.current;
    const fresh = (await refresh()) ?? payload;
    if (reviewRef.current !== asked) return;  // cancelled or replaced meanwhile
    const all = fresh?.entries ?? entries;
    const freshById = new Map(all.map(e => [e.id, e]));
    setReview(null);
    if (note) setStatus(`Added from the folder${note}.`);
    await open(ids.map(id => freshById.get(id)).filter((e): e is LibraryEntry => Boolean(e)), all,
      fresh?.genomes_downloaded ?? payload?.genomes_downloaded ?? []);
  };

  if (!payload) {
    return <div className="p-6 text-[12px] text-gray-500">{error ?? 'Reading the Library…'}</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="library-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-50">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-fb bg-brand-50 text-brand-700 ring-1 ring-brand-100 dark:bg-brand-400/15 dark:text-brand-300 dark:ring-brand-400/20" aria-hidden="true"><Library size={15} /></span>
          Library
        </div>
        <div className="text-[11.5px] text-gray-500" data-testid="library-count">{shown.length} of {entries.length} files</div>
        <input
          type="search"
          className="ml-2 flex-1 min-w-[180px] px-2.5 py-1 text-[12px] border border-line rounded-fb shadow-[inset_0_1px_1px_rgb(15_23_42/0.04)] focus:outline-none focus:border-brand-400 focus:ring-[3px] focus:ring-brand-500/20 dark:bg-dark-bg dark:border-white/10"
          placeholder="Search name, sample, tag, note, path…"
          value={filters.text}
          onChange={e => setFilters({ text: e.target.value })}
          data-testid="library-search"
        />
        {!useBrowserStore.getState().publicMode && !isLabServerPage() && (
          <button type="button" className={BUTTON} data-testid="library-connect-cluster" onClick={() => openConnectCluster()}
            title="Open files that stay on a cluster (an HPC login node) over your own SSH">Connect to cluster…</button>
        )}
        <button type="button" className={BUTTON} disabled={busy} data-testid="library-add-files" onClick={() => act(async () => {
          const picked = await pickDataset();
          const paths = picked.paths?.length ? picked.paths : picked.path ? [picked.path] : [];
          if (!picked.success || !paths.length) return;
          const res = await addLibraryFiles(paths);
          return [res.ids.length ? `Added ${res.ids.length} file(s).` : '', ...res.errors].filter(Boolean).join('\n');
        })}>Add files…</button>
        <button type="button" className={BUTTON} disabled={busy} data-testid="library-watch-folder" onClick={() => act(async () => {
          const picked = await pickFolder('Choose a folder to watch');
          if (!picked.success || !picked.path) return;
          await addWatchedFolder(picked.path);
          return `Watching ${picked.path}: scanning (headers only; nothing is written there).`;
        })}>Watch a folder…</button>
        {payload.watched.length > 0 && (
          <button type="button" className={BUTTON} disabled={busy || Boolean(scanning)} onClick={() => act(async () => {
            await scanWatchedFolders();
            return 'Re-scanning the watched folders…';
          })} data-testid="library-rescan-all">{scanning ? 'Scanning…' : 'Re-scan folders'}</button>
        )}
        <button type="button" aria-label="Close" onClick={onClose} className="w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 text-lg leading-none">×</button>
      </div>
      {(status || scanning || payload.unreadable) && (
        <div className="px-3 py-1 text-[11.5px] border-b border-gray-100 dark:border-white/5 text-gray-600 dark:text-gray-300 whitespace-pre-line" data-testid="library-status">
          {payload.unreadable && <div className="text-red-600">{payload.library_file} was written by a newer FiberBrowser or is damaged; it is shown empty and left untouched.</div>}
          {scanning && <div>Scanning {payload.watched.find(w => w.id === scanning.folder_id)?.path ?? 'a folder'}: {scanning.progress.files ?? 0} files seen, {scanning.progress.candidates ?? 0} datasets…</div>}
          {status && <div>{status}</div>}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Filters, groups, suggestions, watched folders */}
        <div className="w-56 shrink-0 overflow-y-auto border-r border-gray-200 dark:border-white/10 p-2 space-y-3 text-[11.5px]">
          <div className="space-y-1.5" data-testid="library-filters">
            <div className="flex items-center"><div className={HEADING}>Filter</div>
              <button type="button" className="ml-auto text-[11px] text-blue-600 hover:underline" onClick={resetFilters}>Reset</button>
            </div>
            <select className={SELECT} value={filters.kind} onChange={e => setFilters({ kind: e.target.value as typeof filters.kind })} aria-label="Kind">
              <option value="">All kinds</option>
              {facets.kinds.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
            <select className={SELECT} value={filters.chemistry} onChange={e => setFilters({ chemistry: e.target.value })} aria-label="Chemistry" data-testid="library-filter-chemistry">
              <option value="">Any chemistry</option>
              {facets.chemistries.map(c => <option key={c} value={c}>{chemistryFilterLabel(c)}</option>)}
            </select>
            <select className={SELECT} value={filters.reference} onChange={e => setFilters({ reference: e.target.value })} aria-label="Genome or plasmid">
              <option value="">Any genome / plasmid</option>
              {facets.references.map(r => <option key={r} value={r}>{referenceFilterLabel(r)}</option>)}
            </select>
            <select className={SELECT} value={filters.qc} onChange={e => setFilters({ qc: e.target.value })} aria-label="QC verdict" data-testid="library-filter-qc">
              <option value="">Any QC</option>
              {facets.verdicts.map(v => <option key={v} value={v}>QC {v}</option>)}
              <option value="none">No QC</option>
            </select>
            {facets.tags.length > 0 && (
              <select className={SELECT} value={filters.tag} onChange={e => setFilters({ tag: e.target.value })} aria-label="Tag">
                <option value="">Any tag</option>
                {facets.tags.map(t => <option key={t} value={t}>#{t}</option>)}
              </select>
            )}
            <select className={SELECT} value={filters.folder} onChange={e => setFilters({ folder: e.target.value })} aria-label="Folder">
              <option value="">Any folder</option>
              {facets.folders.map(f => <option key={f} value={f} title={f}>{f.split(/[\\/]/).slice(-2).join('/')}</option>)}
            </select>
            {(anyRerun || payload.advisories_available) && (
              <label className="flex items-center gap-1"><input type="checkbox" checked={filters.rerunOnly} onChange={e => setFilters({ rerunOnly: e.target.checked })} data-testid="library-filter-rerun" /> Needs re-run</label>
            )}
            <label className="flex items-center gap-1"><input type="checkbox" checked={filters.showAligned} onChange={e => setFilters({ showAligned: e.target.checked })} /> Aligned (uncalled) BAMs</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={filters.showUnavailable} onChange={e => setFilters({ showUnavailable: e.target.checked })} /> Include missing files</label>
          </div>

          <div className="space-y-1" data-testid="library-groups">
            <div className={HEADING}>Groups</div>
            {groups.length === 0 && <div className="text-gray-400">Select files, then Add to group.</div>}
            {groups.map(group => {
              const members = group.entry_ids.map(id => byId.get(id)).filter((e): e is LibraryEntry => Boolean(e));
              const active = filters.group === group.id;
              return (
                <div key={group.id} className={`rounded p-1 ${active ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`} data-testid="library-group">
                  <button type="button" className="w-full text-left font-medium truncate hover:underline" title={group.description}
                    onClick={() => setFilters({ group: active ? '' : group.id })}>{group.name} <span className="text-gray-400 font-normal">({members.length})</span></button>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    <button type="button" className="text-blue-600 hover:underline" disabled={busy || !members.length} onClick={() => open(members)} data-testid="library-open-group">Open group</button>
                    <button type="button" className="text-blue-600 hover:underline" disabled={busy} onClick={() => act(async () => {
                      const res = await exportLibraryCatalog([group.id], true);
                      downloadJson(`${safeFileName(group.name)}.catalog.json`, res.catalog);
                      const skipped = res.skipped.length ? ` (${res.skipped.length} non-dataset file(s) left out)` : '';
                      return `Catalog saved as ${safeFileName(group.name)}.catalog.json${skipped}. Put it in ${res.base_dir ?? 'the data folder'} and serve with: python browser.py --public --catalog ${safeFileName(group.name)}.catalog.json`;
                    })} data-testid="library-export-catalog" title="A --catalog JSON for a public or reviewer deployment">Export catalog</button>
                    <button type="button" className="text-red-600 hover:underline" disabled={busy} onClick={() => act(async () => {
                      await deleteLibraryGroup(group.id);
                      if (active) setFilters({ group: '' });
                      return `Deleted group ${group.name} (its files stay in the Library).`;
                    })}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>

          {suggestions.length > 0 && (
            <div className="space-y-1" data-testid="library-suggested">
              <div className={HEADING}>Suggested experiments</div>
              {suggestions.map(s => (
                <div key={s.key} className={`rounded p-1 hover:bg-gray-50 dark:hover:bg-white/5 ${review?.suggestion.key === s.key ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
                  data-testid="library-suggestion">
                  <div className="truncate" title={scannable(s) ? `${s.description}\n${s.scanned ? 'Scanned: every file of the folder the Library lists' : 'Files the Library lists so far; Open or Save scans the folder first'}` : s.description}>
                    {s.name} <span className="text-gray-400" data-testid="library-suggestion-count">({s.entryIds.length}{s.scanned ? ', scanned' : ''})</span>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="text-blue-600 hover:underline" disabled={busy} data-testid="library-open-suggestion"
                      onClick={() => scannable(s) ? setReview({ suggestion: s, action: 'open' })
                        : open(s.entryIds.map(id => byId.get(id)).filter((e): e is LibraryEntry => Boolean(e)))}>Open</button>
                    <button type="button" className="text-blue-600 hover:underline" disabled={busy}
                      onClick={() => scannable(s) ? setReview({ suggestion: s, action: 'group' }) : act(async () => {
                        const res = await createLibraryGroup(s.name, s.entryIds, s.description);
                        return res.success ? `Saved group ${s.name}.` : res.error;
                      })} data-testid="library-save-suggestion">Save as group</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1" data-testid="library-watched">
            <div className={HEADING}>Watched folders</div>
            {payload.watched.length === 0 && <div className="text-gray-400">Watch a folder to list its BAMs, BigBeds and plasmid maps automatically.</div>}
            {payload.watched.map(folder => {
              const scan = folder.last_scan;
              return (
                <div key={folder.id} className="rounded p-1" title={folder.path}>
                  <div className="truncate font-medium">{basename(folder.path)}</div>
                  <div className="text-gray-400 truncate">{folder.path}</div>
                  {scan && (
                    <div className="text-gray-500"
                      title={scan.big_dir_examples?.length ? `Not scanned (over 20,000 entries):\n${scan.big_dir_examples.join('\n')}` : undefined}>
                      {scan.error ? `Last scan: ${scan.error}` : `${scan.candidates ?? 0} datasets · ${scan.elapsed_s ?? 0}s${scan.truncated ? ` · ${scan.truncated}` : ''}${scan.big_dirs ? ` · ${scan.big_dirs} huge folder${scan.big_dirs === 1 ? '' : 's'} skipped` : ''}`}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => setFilters({ folder: folder.path })}>Show</button>
                    <button type="button" className="text-blue-600 hover:underline" disabled={busy} onClick={() => act(async () => { await scanWatchedFolders([folder.id]); return 'Scanning…'; })}>Re-scan</button>
                    <button type="button" className="text-red-600 hover:underline" disabled={busy} onClick={() => act(async () => {
                      await removeWatchedFolder(folder.id);
                      return `Stopped watching ${folder.path} (its files stay listed until removed).`;
                    })}>Stop watching</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {/* Keep the toolbar in flow even with no checks: inserting it on the
              first check moves every row down beneath a stationary pointer. */}
          <div className="shrink-0 flex flex-wrap items-center gap-1 px-2 py-1 border-b border-gray-100 dark:border-white/5" data-testid="library-bulk">
            <span className="w-24 shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-gray-600 dark:text-gray-300">{checked.length} selected</span>
            <button type="button" className={BUTTON} disabled={busy || !checked.length} data-testid="library-open-selected"
              onClick={() => open(checked.map(id => byId.get(id)).filter((e): e is LibraryEntry => Boolean(e)))}>Open</button>
            <button type="button" className={BUTTON} disabled={!checked.length} onClick={() => setGroupTarget(checked)} data-testid="library-bulk-group">Add to group…</button>
            <button type="button" className={`${BUTTON} text-red-600`} disabled={busy || !checked.length} onClick={() => act(async () => {
              const res = await removeLibraryEntries(checked);
              setChecked([]);
              return `Removed ${res.removed} from the Library (files were not touched).`;
            })}>Remove</button>
            <button type="button" className={BUTTON} disabled={!checked.length} onClick={() => setChecked([])}>Clear</button>
          </div>
          {review && (
            <div className="px-2 py-1">
              <SuggestionReview
                key={`${review.suggestion.key}|${review.action}`}
                suggestion={review.suggestion}
                action={review.action}
                onCancel={() => setReview(null)}
                onScanned={setScanned}
                onFinished={message => { setReview(null); setStatus(message); void refresh(); }}
                onOpen={openScanned}
                onWatched={() => void refresh()}
              />
            </div>
          )}
          {groupTarget && (
            <div className="px-2 py-1">
              <AddToGroup ids={groupTarget} payload={payload} onCancel={() => setGroupTarget(null)}
                onDone={message => { setGroupTarget(null); setStatus(message); void refresh(); }} />
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-auto">
            <LibraryTable
              entries={shown}
              sort={sort}
              onSort={key => setSort(toggleSort(sort, key))}
              selectedId={selectedId}
              onSelect={select}
              checked={checked}
              onToggle={toggleChecked}
              onToggleAll={(ids, on) => setChecked(on ? [...checked, ...ids] : checked.filter(id => !ids.includes(id)))}
              onOpen={entry => open([entry])}
            />
            {entries.length === 0 && (
              <div className="p-6 text-[12px] text-gray-500 space-y-1" data-testid="library-empty">
                <div>The Library lists your datasets: {LIBRARY_SCOPE_TEXT}.</div>
                <div>It is kept in {payload.library_file} and shared by every workspace on this computer.</div>
              </div>
            )}
          </div>
        </div>

        {/* Reserve details width before selection. Otherwise the first click
            narrows the table, wraps badges and changes row heights before the
            second click of a double click can reach the same visible row. */}
        <div className="w-[360px] shrink-0 min-h-0 overflow-y-auto border-l border-gray-200 dark:border-white/10 p-3" data-testid="library-details-slot">
          {selected ? (
            <LibraryDetails
              entry={selected}
              groups={groups}
              fiberhmmVersion={payload.fiberhmm_version}
              onOpen={open}
              onChanged={message => { if (message) setStatus(message); void refresh(); }}
              onAddToGroup={ids => setGroupTarget(ids)}
            />
          ) : (
            <div className="text-[12px] text-gray-500">Select a file to see its details.</div>
          )}
        </div>
      </div>
    </div>
  );
}
