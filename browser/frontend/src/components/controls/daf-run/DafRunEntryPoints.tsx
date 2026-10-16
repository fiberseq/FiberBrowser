import { useBrowserStore } from '../../../stores/browserStore';
import { isSandboxPage } from '../../../utils/sandbox';
import { SidebarSubSection } from '../SidebarSubSection';
import { DafRunJobList } from './DafRunJobList';
import { openDafRunDialog, useDafRunStore } from './dafRunStore';
import { labRunsAvailable } from '../../../utils/labServer';
import { WelcomeTile } from '../WelcomeLoadFileButton';
import { Dna } from '../../ui/Icons';

function useLocalOnly(): boolean {
  const publicMode = useBrowserStore(s => s.publicMode);
  return !publicMode && !isSandboxPage() && labRunsAvailable();
}

/** Sidebar > Data & Sessions: start a run from raw reads, and the latest runs. */
export function DafRunSidebarSection() {
  const local = useLocalOnly();
  const jobs = useDafRunStore(s => s.jobs);
  if (!local) return null;
  return (
    <SidebarSubSection
      id="file.dafrun"
      label="DAF-seq runs"
      helpText="Align and call raw DAF-seq reads (e.g. a Plasmidsaurus Nanopore run) with fiberhmm-pipeline, then open the results and their QC here."
      defaultOpen
      persist
    >
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => openDafRunDialog('new')}
            className="px-2 py-1 rounded bg-blue-500 text-white text-[11.5px] hover:bg-blue-600"
            data-testid="daf-run-open"
          >
            New DAF-seq run…
          </button>
          {jobs.length > 0 && (
            <button
              type="button"
              onClick={() => openDafRunDialog('runs')}
              className="px-2 py-1 rounded border border-gray-300 dark:border-white/15 text-[11.5px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10"
            >
              All runs
            </button>
          )}
          <button
            type="button"
            onClick={() => openDafRunDialog('qc')}
            className="px-2 py-1 rounded border border-gray-300 dark:border-white/15 text-[11.5px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10"
            title="fiberhmm-qc on a loaded BAM"
            data-testid="daf-run-open-qc"
          >
            QC a dataset
          </button>
        </div>
        {jobs.length > 0 && <DafRunJobList compact limit={2} />}
      </div>
    </SidebarSubSection>
  );
}

/** Welcome screen: from raw reads to footprints. */
export function WelcomeDafRunButton() {
  const local = useLocalOnly();
  if (!local) return null;
  return (
    <WelcomeTile
      icon={Dna}
      accent="fuchsia"
      title="New DAF-seq run"
      detail="From FASTQ reads (e.g. Plasmidsaurus) to footprints"
      testId="welcome-daf-run-cta"
      onClick={() => openDafRunDialog('new')}
    />
  );
}
