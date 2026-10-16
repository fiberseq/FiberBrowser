import { useRef, useEffect, useCallback, useLayoutEffect, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { SubTrackConfig, SubTrackType } from '../../types';
import { GripVertical, Library, Plus, X } from '../ui/Icons';
import { PanelIcon } from '../ui/panelIcons';
import { createDefaultSubTracks, createGenomeSubTracks } from '../../stores/utils';
import { isTrackListed, trackKind } from './trackRegistry';
import { canDeleteTrack, deleteTrack, restoreTrack } from './trackActions';
import { openLibrary } from '../controls/library/libraryStore';

/** Whether "Tracks in this panel" offers × for this row (the reads stay). */
export function isRemovableSubTrack(type: SubTrackType): boolean {
  return type !== 'reads' && canDeleteTrack(type);
}

export function getTrackLabel(type: SubTrackType): string {
  if (type.startsWith('composite-')) {
    const id = type.slice('composite-'.length);
    const composite = useBrowserStore.getState().compositeTracks.find(c => c.id === id);
    return composite?.label || 'Track';
  }
  if (type.startsWith('ortho-')) {
    const idx = parseInt(type.replace('ortho-', ''), 10);
    const tracks = useBrowserStore.getState().orthogonalTracks;
    const track = tracks.find(t => t.index === idx);
    return track?.label || `Track ${idx}`;
  }
  return trackKind(type).label;
}

/** When a built-in row draws (the menu says so beside rows that may be empty now). */
const SHOWN_WHEN_BUILTIN: Partial<Record<SubTrackType, string>> = {
  consensus: 'after Find classes',
  microc: 'with Micro-C loaded',
  coacc: 'with co-accessibility on',
  capture: 'while Capture Regions is open',
  primer: 'while Primers is open',
  sv: 'when SVs are in view (BAM)',
  coverage: 'with Coverage histogram on',
  sequence: 'at 2 kb or less',
};

/** When a row draws: a built-in's, else its kind's (a plugin pack's row). */
const shownWhen = (type: SubTrackType): string | undefined => SHOWN_WHEN_BUILTIN[type] ?? trackKind(type).shownWhen;

/** The rows a panel can have that it does not show: removed ones and built-ins it lacks (restorable). */
export function addableTracks(subTracks: SubTrackConfig[], datasetPanel: boolean): SubTrackType[] {
  const present = new Set(subTracks.filter(t => !t.removed).map(t => t.type));
  const builtins = (datasetPanel ? createDefaultSubTracks() : createGenomeSubTracks()).map(t => t.type).filter(t => t !== 'reads');
  const removed = subTracks.filter(t => t.removed).map(t => t.type);
  return [...new Set([...builtins.filter(t => !present.has(t)), ...removed])].filter(isTrackListed);
}

interface Props {
  panelId: string;
  subTracks: SubTrackConfig[];
  anchorRect: DOMRect;
  onClose: () => void;
}

/**
 * "Tracks in this panel" (the panel header's Tracks button, or a track's
 * right-click menu): every row of the panel, in order (drag to reorder), shown
 * or minimized, removed with ×; then the removed and missing ones to put back.
 */
export function SubTrackMenu({ panelId, subTracks, anchorRect, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleSubTrack = useBrowserStore(s => s.toggleSubTrack);
  const updateComposite = useBrowserStore(s => s.updateComposite);
  const reorderSubTracks = useBrowserStore(s => s.reorderSubTracks);
  const compositeTracks = useBrowserStore(s => s.compositeTracks);
  const isDatasetPanel = useBrowserStore(s => Boolean(s.panels.find(p => p.id === panelId)?.datasetId));
  const [pos, setPos] = useState({ top: anchorRect.bottom + 2, left: Math.max(4, Math.min(anchorRect.left, window.innerWidth - 300)) });

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep it in the window (a right-aligned button near the edge, a short window).
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(4, Math.min(anchorRect.left, window.innerWidth - rect.width - 4));
    const below = anchorRect.bottom + 2;
    const top = below + rect.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - rect.height - 4) : below;
    setPos(prev => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [anchorRect, subTracks.length]);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('text/plain', String(idx));
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIdx) && fromIdx !== targetIdx) {
      reorderSubTracks(panelId, fromIdx, targetIdx);
    }
  }, [panelId, reorderSubTracks]);

  const addable = addableTracks(subTracks, isDatasetPanel);

  return (
    <div
      ref={menuRef}
      role="dialog"
      aria-label="Tracks in this panel"
      data-testid={`panel-tracks-menu-${panelId}`}
      className="fb-menu !fixed !z-50 max-h-[70vh] w-[17.5rem] overflow-y-auto !py-1"
      style={{ top: pos.top, left: pos.left, right: 'auto', marginTop: 0 }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-3 pb-1 pt-0.5 text-[12px] font-semibold text-ink dark:text-gray-100">Tracks in this panel</div>
      {subTracks.map((track, idx) => {
        // A Preview feature's row while previews are off: kept in the panel, not listed.
        if (!isTrackListed(track.type)) return null;
        if (track.removed) return null;
        const compositeId = track.type.startsWith('composite-') ? track.type.slice('composite-'.length) : null;
        const composite = compositeId ? compositeTracks.find(c => c.id === compositeId) : undefined;
        if (compositeId && !composite) return null;
        const checked = composite ? composite.visible && track.visible : track.visible;
        const handleToggle = () => {
          if (composite && compositeId) {
            if (!track.visible) toggleSubTrack(panelId, track.type);
            else updateComposite(compositeId, { visible: !composite.visible });
          } else {
            toggleSubTrack(panelId, track.type);
          }
        };
        const label = getTrackLabel(track.type);
        const when = shownWhen(track.type);
        return (
          <div
            key={track.type}
            draggable
            className="group flex items-center gap-2 px-2.5 py-1 text-[12.5px] cursor-grab hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.06]"
            data-track-row={track.type}
            onDragStart={e => handleDragStart(e, idx)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => handleDrop(e, idx)}
          >
            <span className="text-ink-muted opacity-60"><GripVertical size={12} /></span>
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={`${checked ? `Minimize ${label} in all panels` : `Show ${label} in all panels`}${when ? ` (it draws ${when})` : ''}`}>
              <input type="checkbox" checked={checked} onChange={handleToggle} className="h-3.5 w-3.5 shrink-0" aria-label={`Show ${label}`} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate">{label}</span>
                {when && <span className="block truncate text-[10.5px] text-ink-muted">{when}</span>}
              </span>
            </label>
            {isRemovableSubTrack(track.type) && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); deleteTrack(panelId, track.type); }}
                className="rounded p-0.5 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-300"
                title={composite || track.type.startsWith('ortho-') ? `Delete ${label} (the Library brings it back)` : `Remove ${label} from this panel`}
                aria-label={`Remove ${label}`}
                data-testid={`panel-track-remove-${track.type}`}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      {addable.length > 0 && (
        <>
          <div className="fb-menu-sep" />
          <div className="px-3 pb-0.5 pt-0.5 text-[11px] text-ink-muted">Add to this panel</div>
          {addable.map(type => (
            <button
              key={type}
              type="button"
              className="fb-menu-item w-full"
              onClick={() => restoreTrack(panelId, type)}
              title={`Put ${getTrackLabel(type)} back in this panel${shownWhen(type) ? ` (it draws ${shownWhen(type)})` : ''}`}
              data-testid={`panel-track-restore-${type}`}
            >
              <span className="flex w-4 justify-center text-ink-muted" aria-hidden="true"><Plus size={12} /></span>
              <span className="flex-1 truncate">{getTrackLabel(type)}</span>
            </button>
          ))}
        </>
      )}
      <div className="fb-menu-sep" />
      <div className="flex items-center gap-1 px-2 pb-0.5">
        <button type="button" className="fb-btn-ghost flex items-center gap-1 px-2 py-0.5 text-[11.5px]"
          onClick={() => { useBrowserStore.getState().openAnalysisPanel('track-browser'); onClose(); }}
          title="Every loaded track: show, hide, colour and combine" data-testid="panel-tracks-open-tracks-panel">
          <PanelIcon contentType="track-browser" size={13} /> Tracks panel
        </button>
        <button type="button" className="fb-btn-ghost flex items-center gap-1 px-2 py-0.5 text-[11.5px]"
          onClick={() => { openLibrary(); onClose(); }} title="Load more tracks (signal, peaks, motifs, genes)"
          data-testid="panel-tracks-open-library">
          <Library size={13} /> Library
        </button>
      </div>
    </div>
  );
}
