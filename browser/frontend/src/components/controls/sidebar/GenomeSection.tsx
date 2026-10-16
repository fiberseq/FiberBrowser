import { SidebarSubSection } from '../SidebarSubSection';
import { useDatasetActions } from '../../../hooks/useDatasetActions';
import { useBrowserStore } from '../../../stores/browserStore';
import { GenomeSelector } from './genome/GenomeSelector';
import { ReferenceFilesSettings } from './genome/ReferenceFilesSettings';
import { X } from '../../ui/Icons';

export function GenomeSection() {
  const publicMode = useBrowserStore(s => s.publicMode);
  const openAnalysisPanel = useBrowserStore(s => s.openAnalysisPanel);
  const {
    loading, error, setError,
    status,
    handleLoadGtf, handleRemoveGtf,
  } = useDatasetActions();

  return (
    <div>
      <ReferenceFilesSettings
        publicMode={publicMode}
        loading={loading}
        status={status}
        handleLoadGtf={handleLoadGtf}
        handleRemoveGtf={handleRemoveGtf}
      />

      {!publicMode && (
        <SidebarSubSection
          id="genome.online"
          label="Online Genome & Tracks"
          helpText="Select a bundled reference genome and browse UCSC, ENCODE, and ChIP-Atlas tracks"
          persist
        >
          <div className="space-y-1.5">
            <GenomeSelector />
            <button
              data-tour="sidebar-open-tracks"
              onClick={() => openAnalysisPanel('track-browser')}
              className="w-full text-left px-2 py-1.5 text-[12px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded transition-colors"
            >
              Open Tracks…
            </button>
          </div>
        </SidebarSubSection>
      )}

      {error && (
        <div className="mt-1 text-red-500 dark:text-red-400 text-xs bg-red-50 dark:bg-red-950/30 p-1.5 rounded mx-1">
          {error}
          <button onClick={() => setError('')} className="ml-2 inline-flex align-[-2px] text-gray-500 hover:text-gray-700" aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
    </div>
  );
}
