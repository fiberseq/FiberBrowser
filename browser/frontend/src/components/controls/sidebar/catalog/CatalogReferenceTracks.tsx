import type { CatalogTrack } from '../../../../api/catalog';
import { DisclosureChevron } from '../../../ui/Disclosure';
import { defineSettings, settingAnchor } from '../../../../utils/settingsCatalog';

export const CATALOG_TRACK_SETTINGS = defineSettings({
  tracks: {
    id: 'file.catalog-tracks',
    label: 'Dataset catalog: reference tracks',
    keywords: ['catalog', 'annotation tracks', 'reference tracks'],
    location: { kind: 'sidebar', section: 'file' },
  },
});

interface CatalogReferenceTracksProps {
  tracks: CatalogTrack[];
  loading: Record<string, boolean>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTrackToggle: (index: number, loaded: boolean) => void;
}

export function CatalogReferenceTracks({
  tracks,
  loading,
  open,
  onOpenChange,
  onTrackToggle,
}: CatalogReferenceTracksProps) {
  if (tracks.length === 0) return null;

  return (
    <div className="rounded border border-gray-200 dark:border-gray-700" {...settingAnchor(CATALOG_TRACK_SETTINGS.tracks)}>
      <button
        onClick={() => onOpenChange(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-left"
      >
        <span className="inline-flex w-3 text-gray-400"><DisclosureChevron open={open} /></span>
        <span className="text-gray-600 dark:text-gray-400 font-medium">Reference Tracks</span>
        <span className="text-[11px] text-ink-secondary ml-auto">{tracks.filter(track => track.loaded).length}/{tracks.length}</span>
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-0.5 border-t border-gray-100 dark:border-gray-700/50 pt-1">
          {tracks.map((track, index) => (
            <label key={index} className="flex items-center gap-1.5 text-[11px] cursor-pointer py-0.5">
              <input
                type="checkbox"
                checked={track.loaded}
                disabled={loading[`t${index}`]}
                onChange={() => onTrackToggle(index, track.loaded)}
                className="rounded border-gray-300 dark:border-white/20"
              />
              <span className={track.loaded ? 'text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-400'}>
                {track.label}
              </span>
              {loading[`t${index}`] && <span className="text-[11px] text-blue-500">...</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
