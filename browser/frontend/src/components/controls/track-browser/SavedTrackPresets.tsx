import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import type { SavedTrack } from '../../../stores/savedTracksSlice';
import { AnalysisButton, AnalysisSettingsSection } from '../shared';

function SavedRow({ saved }: { saved: SavedTrack }) {
  const loadSavedTrackToCart = useBrowserStore(s => s.loadSavedTrackToCart);
  const removeSavedTrack = useBrowserStore(s => s.removeSavedTrack);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const summary = `${saved.composite.kind} · ${saved.composite.sources.length} src`;

  return (
    <div className="px-2 py-1.5 rounded text-xs hover:bg-gray-100 dark:hover:bg-white/5">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
          preset
        </span>
        <span className="flex-1 truncate" title={`Saved ${new Date(saved.savedAt).toLocaleString()}`}>
          {saved.name}
        </span>
        <span className="text-[11px] text-ink-secondary whitespace-nowrap flex-shrink-0">{summary}</span>
        <AnalysisButton
          onClick={() => loadSavedTrackToCart(saved.id)}
          theme="blue"
          variant="outline"
          className="flex-shrink-0"
          title="Add a copy of this track to the cart"
        >
          Load
        </AnalysisButton>
        <AnalysisButton
          onClick={() => setConfirmingDelete(true)}
          variant="dangerOutline"
          className="px-1 py-0 text-base leading-none flex-shrink-0"
          title="Confirm deleting this saved preset"
        >
          ×
        </AnalysisButton>
      </div>
      {confirmingDelete && (
        <div className="mt-1 flex items-center justify-between gap-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          <span>Delete saved track "{saved.name}"?</span>
          <span className="flex items-center gap-1">
            <AnalysisButton
              onClick={() => removeSavedTrack(saved.id)}
              variant="danger"
            >
              Delete
            </AnalysisButton>
            <AnalysisButton
              onClick={() => setConfirmingDelete(false)}
              theme="red"
              variant="outline"
            >
              Cancel
            </AnalysisButton>
          </span>
        </div>
      )}
    </div>
  );
}

/** Track presets saved from a track's menu ("Save preset…"); Load adds a copy. */
export function SavedTrackPresets() {
  const savedTracks = useBrowserStore(useShallow(s => s.savedTracks));
  const [open, setOpen] = useState(false);
  if (savedTracks.length === 0) return null;
  return (
    <AnalysisSettingsSection
      open={open}
      onOpenChange={setOpen}
      theme="blue"
      title="Saved presets"
      summary={`${savedTracks.length}`}
    >
      <div className="space-y-0.5">
        {savedTracks.map(s => <SavedRow key={s.id} saved={s} />)}
      </div>
    </AnalysisSettingsSection>
  );
}
