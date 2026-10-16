import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { previewFeaturesInUse, setPreviewsEnabled, usePreviewsEnabled } from '../../utils/previewFeatures';

/**
 * One line while previews are off and what is open uses a Preview feature (a session, an undo step or a recovered
 * state brought it: utils/previewFeatures): nothing of it was dropped; one click turns previews on. Dismissed for as
 * long as the same features are in use.
 */
export function PreviewSessionPrompt() {
  const on = usePreviewsEnabled();
  const { panels, selectedFeatures } = useBrowserStore(useShallow(s => ({ panels: s.panels, selectedFeatures: s.selectedFeatures })));
  const inUse = useMemo(
    () => (on ? [] : previewFeaturesInUse({ panels: panels as never, selectedFeatures: selectedFeatures as never })),
    [on, panels, selectedFeatures],
  );
  const key = inUse.map(f => f.id).join(',');
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!inUse.length || dismissed === key) return null;
  return (
    <div role="status" data-testid="preview-session-prompt"
      className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12px] dark:border-amber-700 dark:bg-amber-900/30">
      <span className="flex-1 text-amber-800 dark:text-amber-200">
        This session uses Preview features ({inUse.map(f => f.label).join(', ')}): everything is kept. Turn previews on to work with them.
      </span>
      <button type="button" data-testid="preview-session-enable" onClick={() => setPreviewsEnabled(true)}
        className="rounded bg-amber-500 px-3 py-0.5 text-xs font-medium text-white hover:bg-amber-600">
        Turn on previews
      </button>
      <button type="button" aria-label="Dismiss" data-testid="preview-session-dismiss" onClick={() => setDismissed(key)}
        className="text-xs text-amber-700 hover:underline dark:text-amber-300">
        Not now
      </button>
    </div>
  );
}
