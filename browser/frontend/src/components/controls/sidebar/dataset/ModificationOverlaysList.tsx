import type { ModificationOverlay } from '../../../../types';
import { X } from '../../../ui/Icons';

interface ModificationOverlaysListProps {
  overlays: ModificationOverlay[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (overlayId: string) => void;
}

export function ModificationOverlaysList({
  overlays,
  open,
  onOpenChange,
  onRemove,
}: ModificationOverlaysListProps) {
  if (overlays.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => onOpenChange(!open)}
        className="px-2 py-0.5 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 rounded text-[13px]"
      >
        Overlays ({overlays.length}) {'\u25BE'}
      </button>

      {open && (
        <div className="mt-1 space-y-0.5">
          {overlays.map(overlay => (
            <div key={overlay.id} className="flex items-center justify-between text-[13px]">
              <span className="truncate flex-1" style={{ color: overlay.color }} title={overlay.label}>
                {overlay.label}
              </span>
              <button
                onClick={() => onRemove(overlay.id)}
                className="text-gray-400 hover:text-red-500 ml-1"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
