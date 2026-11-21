import { useEffect, useState, type DragEvent } from 'react';
import type { RecentGenome } from '../../../../api/recentGenomes';
import { fetchJson } from '../../../../api/sharedFetch';
import { useBrowserStore } from '../../../../stores/browserStore';
import { recentGenomeLabel, useRecentGenomesStore } from '../../../../stores/recentGenomesStore';
import { formatTimeAgo } from '../../../../utils/time';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';
import { X } from '../../../ui/Icons';

const PREFS = '/api/preferences/analysis';

export const RECENT_GENOME_SETTINGS = defineSettings({
  max: {
    id: 'genome.recent-max',
    label: 'Recent genomes listed',
    keywords: ['recent genomes', 'custom genome', 'history'],
    location: inSidebar('genome.recent'),
  },
});

/** The entry's tooltip: its full path(s). */
function entryTitle(e: RecentGenome): string {
  if (e.kind === 'registry') return `${e.name ?? e.genome_id} (online genome${e.cached ? ', downloaded' : ''})`;
  return [e.fasta, e.gtf ? `annotation: ${e.gtf}${e.gtf_exists ? '' : ' (not found)'}` : null].filter(Boolean).join('\n');
}

function Row({ entry, draggable, onDragStart, onDrop }: {
  entry: RecentGenome;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}) {
  const { open, remove, setPinned, opening } = useRecentGenomesStore();
  const currentGenome = useBrowserStore(s => s.currentGenome);
  const fastaPath = useBrowserStore(s => s.fastaPath);
  const current = entry.kind === 'registry' ? currentGenome === entry.genome_id && !fastaPath : !!fastaPath && fastaPath === entry.fasta;
  const missing = !entry.exists;
  const label = recentGenomeLabel(entry);
  const busy = opening === entry.key;
  return (
    <div
      className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[12px] ${missing ? 'opacity-60' : 'hover:bg-gray-100 dark:hover:bg-white/5'}`}
      data-testid={`recent-genome-${entry.pinned ? 'pinned' : 'recent'}`}
      data-key={entry.key}
      data-missing={missing ? 'true' : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={draggable ? e => e.preventDefault() : undefined}
      onDrop={onDrop}
    >
      <button
        type="button"
        disabled={missing || opening !== null}
        onClick={() => { void open(entry.key); }}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
        title={entryTitle(entry)}
        data-testid="recent-genome-open"
      >
        <span className={`block truncate ${current ? 'font-semibold text-green-700 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}>
          {label}{busy && <span className="ml-1 text-[11px] text-blue-500 animate-pulse">loading…</span>}
        </span>
        <span className="block truncate text-[11px] text-ink-secondary">
          {missing ? <span className="text-red-500" data-testid="recent-genome-missing">file not found</span>
            : <>
              {entry.kind === 'fasta' ? entry.fasta_name : 'online genome'}
              {entry.gtf_name && <> + {entry.gtf_name}{entry.gtf_exists ? '' : ' (not found)'}</>}
            </>}
          {entry.last_used ? <> · {formatTimeAgo(entry.last_used * 1000)}</> : null}
        </span>
      </button>
      <button
        type="button"
        onClick={() => { void setPinned(entry.key, !entry.pinned); }}
        className={`rounded px-1 text-[11px] ${entry.pinned ? 'text-amber-600' : 'text-gray-400 opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
        title={entry.pinned ? 'Unpin (back to Recent)' : 'Pin: always listed, never dropped'}
        aria-label={entry.pinned ? `Unpin ${label}` : `Pin ${label}`}
        aria-pressed={entry.pinned}
        data-testid="recent-genome-pin"
      >
        {entry.pinned ? '★' : '☆'}
      </button>
      <button
        type="button"
        onClick={() => { void remove(entry.key); }}
        className={`rounded p-0.5 text-gray-400 hover:text-red-500 ${missing ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
        title="Remove from the list"
        aria-label={`Remove ${label}`}
        data-testid="recent-genome-remove"
      >
        {missing ? <span className="text-[11px]">Remove</span> : <X size={11} />}
      </button>
    </div>
  );
}

/**
 * Reference & Tracks → Recent genomes: pinned genomes (in pin order, drag to reorder), then the last N the user
 * loaded (custom FASTA and annotation pairs, online and catalog genomes). One click loads one with its annotation.
 * Kept by the server (services/recent_genomes.py), so every port and browser sees the same list.
 */
export function RecentGenomes() {
  const { pinned, recent, max, loaded, error, refresh, clear, reorder } = useRecentGenomesStore();
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  const [dragKey, setDragKey] = useState<string | null>(null);
  useEffect(() => { void refresh(); }, [refresh, refreshGeneration]);
  const savePref = (patch: Record<string, unknown>) =>
    fetchJson(PREFS, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      .then(() => refresh()).catch(() => {});
  const dropOn = (target: string) => {
    if (!dragKey || dragKey === target) return;
    const keys = pinned.map(e => e.key).filter(k => k !== dragKey);
    keys.splice(keys.indexOf(target), 0, dragKey);
    setDragKey(null);
    void reorder(keys);
  };
  if (loaded && pinned.length === 0 && recent.length === 0) {
    return <div className="px-1 text-[11px] text-ink-secondary" data-testid="recent-genomes-empty">Genomes you load are listed here.</div>;
  }
  return (
    <div className="space-y-1" data-testid="recent-genomes">
      {pinned.length > 0 && (
        <div data-testid="recent-genomes-pinned">
          <div className="px-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">Pinned</div>
          {pinned.map(e => (
            <Row key={e.key} entry={e} draggable onDragStart={() => setDragKey(e.key)} onDrop={() => dropOn(e.key)} />
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div data-testid="recent-genomes-recent">
          <div className="flex items-center px-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
            <span className="flex-1">Recent</span>
            <button type="button" onClick={() => { void clear(); }} className="font-normal text-gray-500 hover:text-red-500"
              title="Forget the recent genomes (pinned ones stay)" data-testid="recent-genomes-clear">Clear recent</button>
          </div>
          {recent.map(e => <Row key={e.key} entry={e} />)}
        </div>
      )}
      {error && <div className="px-1 text-[11px] text-red-500" role="alert">{error}</div>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 pt-0.5 text-[11px] text-ink-secondary">
        <label className="inline-flex items-center gap-1" title="How many recent genomes are listed (pinned ones are always listed)"
          {...settingAnchor(RECENT_GENOME_SETTINGS.max)}>
          Show
          <input type="number" min={1} max={50} value={max} data-testid="recent-genomes-max"
            onChange={e => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 1 && v <= 50) void savePref({ recent_genomes_max: v }); }}
            className="w-10 rounded border border-gray-300 bg-transparent px-1 dark:border-gray-600" />
        </label>
      </div>
    </div>
  );
}
