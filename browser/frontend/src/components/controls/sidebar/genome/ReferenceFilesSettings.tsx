import { ReferencePairs } from './ReferencePairs';
import { useReferenceFastaLoader, type ReferenceFileStatus } from '../../../../hooks/useReferenceFastaLoader';
import { SidebarSubSection } from '../../SidebarSubSection';
import { FastaReferenceRow } from './FastaReferenceRow';
import { GtfReferenceRow } from './GtfReferenceRow';
import { PlasmidReferenceRows } from './PlasmidReferenceRows';
import { X } from '../../../ui/Icons';

interface ReferenceFilesSettingsProps {
  publicMode: boolean;
  loading: boolean;
  status: ReferenceFileStatus | null;
  handleLoadGtf: () => void;
  handleRemoveGtf: () => void;
}

export function ReferenceFilesSettings({
  publicMode,
  loading,
  status,
  handleLoadGtf,
  handleRemoveGtf,
}: ReferenceFilesSettingsProps) {
  const {
    fastaLoading,
    fastaError,
    fastaPath,
    hasFasta,
    handleLoadFasta,
    setFastaError,
  } = useReferenceFastaLoader(status, handleRemoveGtf);

  if (publicMode) {
    return null;
  }

  return (
    <SidebarSubSection
      id="genome.reference"
      label="Reference Files"
      defaultOpen
      persist
      helpText="Load local reference files for genes, sequence, motif scanning, and primer design, and plasmid maps as extra contigs"
    >
      <div className="space-y-1">
        <GtfReferenceRow
          hasGtf={Boolean(status?.has_gtf)}
          geneCount={status?.gene_count ?? 0}
          loading={loading}
          onLoad={handleLoadGtf}
          onRemove={handleRemoveGtf}
        />

        <FastaReferenceRow
          hasFasta={hasFasta}
          fastaPath={fastaPath}
          loading={fastaLoading}
          onLoad={handleLoadFasta}
        />

        <PlasmidReferenceRows />

        <ReferencePairs/>

        {fastaError && (
          <div className="text-red-500 dark:text-red-400 text-[11px] bg-red-50 dark:bg-red-950/30 p-1.5 rounded">
            {fastaError}
            <button onClick={() => setFastaError(null)} className="ml-1 inline-flex align-[-2px] text-gray-500 hover:text-gray-700" aria-label="Dismiss"><X size={11} /></button>
          </div>
        )}
      </div>
    </SidebarSubSection>
  );
}
