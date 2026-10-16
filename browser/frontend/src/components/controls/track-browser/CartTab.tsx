import { useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import type { CompositeTrack, CatalogEntry } from '../../../types/dataset';
import { AnalysisButton, AnalysisSettingsSection, AnalysisStatus } from '../shared';
import { CompositeRow } from './CompositeRow';
import { AddTrackBox } from './AddTrackBox';
import { SavedTrackPresets } from './SavedTrackPresets';
import { isPublicHostPage } from '../../../utils/publicServerFlag';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------------------------------------------------------------
// CartTab
// ----------------------------------------------------------------------
export function CartTab({ onBrowseHubs }: { onBrowseHubs: () => void }) {
  const composites = useBrowserStore(useShallow(s => s.compositeTracks));
  const addComposite = useBrowserStore(s => s.addComposite);
  const setAllCompositesVisible = useBrowserStore(s => s.setAllCompositesVisible);
  const applyGroupAutoscale = useBrowserStore(s => s.applyGroupAutoscale);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [showCartActions, setShowCartActions] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedCount = composites.filter(c => c.groupAutoscaleSelected).length;
  const visibleCount = composites.filter(c => c.visible).length;

  const handleSaveCart = useCallback(() => {
    const state = useBrowserStore.getState();
    const payload = {
      version: 1,
      kind: 'fiberbrowser.cart',
      timestamp: new Date().toISOString(),
      catalog: state.catalog,
      compositeTracks: state.compositeTracks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(
      blob,
      `fiberbrowser_cart_${new Date().toISOString().slice(0, 10)}.json`,
    );
  }, []);

  const handleLoadCartClick = useCallback(() => {
    setImportMsg(null);
    fileRef.current?.click();
  }, []);

  const handleLoadCartFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data?.kind !== 'fiberbrowser.cart' || !Array.isArray(data.catalog) || !Array.isArray(data.compositeTracks)) {
        setImportMsg('Not a FiberBrowser cart JSON.');
        return;
      }
      const store = useBrowserStore.getState();
      // Replace catalog and cart wholesale. Preserve incoming entry IDs so
      // SourceRef.catalogEntryId continues to resolve.
      store.setCatalog(data.catalog as CatalogEntry[]);
      store.setCompositeTracks(data.compositeTracks as CompositeTrack[]);
      useBrowserStore.getState().triggerRefresh();
      setImportMsg(
        `Imported ${data.compositeTracks.length} track(s). Sources will load when visible.`
      );
    } catch (err) {
      setImportMsg(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed.');
    }
  }, []);

  const handleNewTrack = useCallback((kind: 'signal' | 'metaprofile') => {
    const id = addComposite({
      label: kind === 'metaprofile' ? 'New metaprofile' : 'New track',
      kind,
      sources: [],
      scaleMode: kind === 'metaprofile' ? 'per-source' : 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    });
    // Auto-expand newly created entries so the user sees the editor.
    setExpandedId(id);
  }, [addComposite]);

  return (
    <div className="p-2 flex flex-col gap-2">
      <AddTrackBox onBrowseHubs={onBrowseHubs} onNewTrack={handleNewTrack} />

      <AnalysisSettingsSection
        open={showCartActions}
        onOpenChange={setShowCartActions}
        theme="blue"
        title="Track actions"
        tourId="tracks-cart-actions"
        summary={composites.length === 0 ? 'Empty' : `${visibleCount}/${composites.length} visible`}
      >
        <div className="flex flex-wrap gap-1.5">
        <AnalysisButton
          onClick={() => setAllCompositesVisible(true)}
          variant="outline"
          size="sm"
          title="Show every track in the cart"
        >
          Show all
        </AnalysisButton>
        <AnalysisButton
          onClick={() => setAllCompositesVisible(false)}
          variant="outline"
          size="sm"
          title="Hide every track in the cart (kept in cart, not rendered)"
        >
          Hide all
        </AnalysisButton>
        <AnalysisButton
          onClick={() => applyGroupAutoscale(true)}
          disabled={selectedCount < 2}
          variant="outline"
          size="sm"
          title={selectedCount < 2 ? 'Select 2+ tracks via the checkbox first' : `Apply common min/max to ${selectedCount} selected tracks`}
        >
          Group autoscale ({selectedCount})
        </AnalysisButton>
        <AnalysisButton
          onClick={handleSaveCart}
          disabled={composites.length === 0}
          variant="outline"
          size="sm"
          title="Save cart + catalog as JSON"
        >
          Save…
        </AnalysisButton>
        {!isPublicHostPage() && (
        <AnalysisButton
          onClick={handleLoadCartClick}
          theme="blue"
          variant="soft"
          size="sm"
          title="Load cart + catalog from a JSON file (replaces the current cart)"
        >
          Load…
        </AnalysisButton>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleLoadCartFile}
        />
        </div>
      </AnalysisSettingsSection>
      {importMsg && (
        <div className="text-xs text-gray-500 dark:text-gray-400 px-2">
          {importMsg}
          <AnalysisButton
            onClick={() => setImportMsg(null)}
            variant="outline"
            className="ml-2 px-1 py-0 leading-none"
            aria-label="Dismiss cart import message"
          >
            ×
          </AnalysisButton>
        </div>
      )}

      {composites.length === 0 ? (
        <AnalysisStatus kind="empty" compact center>
          {isPublicHostPage()
            ? 'No tracks yet. Add a motif above, or a reference track from the catalog.'
            : 'No tracks yet. Add one above: a file, a motif name, or something you used before.'}
        </AnalysisStatus>
      ) : (
        <div className="space-y-1">
          {composites.map(c => (
            <CompositeRow
              key={c.id}
              composite={c}
              expanded={expandedId === c.id}
              onToggleExpand={() => setExpandedId(expandedId === c.id ? null : c.id)}
            />
          ))}
        </div>
      )}

      <SavedTrackPresets />
    </div>
  );
}
