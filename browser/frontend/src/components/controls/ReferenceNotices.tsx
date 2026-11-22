import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGenomeCheckStore, visibleProblems } from '../../stores/genomeCheckStore';
import { useReferenceNoticeStore } from '../../stores/referenceNoticeStore';
import { useLaunchUiStore } from '../../utils/launchSession';
import { resetRegistryAnnotation } from '../../utils/annotationReset';
import { AlertTriangle, Info, X } from '../ui/Icons';
import { useRecentGenomesStore } from '../../stores/recentGenomesStore';
import { useBrowserStore } from '../../stores/browserStore';
import { GenesPromptControls, useGenesPrompt } from '../../features/genesPrompt/GenesPromptControls';
import { dismissGenesNotice, genesNoticeDismissed, mainGenesTrackShown } from '../../features/genesPrompt/genesPrompt';

const BUTTON = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-[9px] py-[3px] rounded-fb border text-xs font-medium disabled:opacity-50';

/**
 * Under the genome-mismatch banner: the one line about a saved reference the page did not restore
 * (utils/startupReference.ts), and a gene annotation that is not on the reference's contigs, with its reset.
 */
export function ReferenceNotices() {
  const { notice, setNotice } = useReferenceNoticeStore(useShallow(s => ({ notice: s.notice, setNotice: s.setNotice })));
  const { check, dismissed, customGenomes } = useGenomeCheckStore(useShallow(s => ({
    check: s.check, dismissed: s.dismissed, customGenomes: s.customGenomes })));
  const restoring = useLaunchUiStore(s => s.restoring);
  const [hidden, setHidden] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The banner's menus list the pinned and recent genomes.
  const hasCheckProblems = (check?.problems?.length ?? 0) > 0;
  useEffect(() => { if (hasCheckProblems) void useRecentGenomesStore.getState().refresh(); }, [hasCheckProblems]);
  const annotation = check?.annotation;
  const target = annotation?.target;
  // A dataset on the wrong genome is the banner's (switching the genome switches its genes too).
  const datasetProblem = visibleProblems(check, dismissed, customGenomes).some(p => p.severity === 'error');
  const key = annotation ? `${annotation.genome_id ?? ''}:${annotation.gene_count}:${target?.genome_id ?? ''}` : null;
  const foreign = !restoring && !datasetProblem && annotation?.loaded && annotation.fits === false
    && !!target && annotation.can_reset && !annotation.current && hidden !== key;
  // No genes on the reference and no main Genes track to say so in place: a small notice here instead.
  const genesPrompt = useGenesPrompt();
  const genesTrackShown = useBrowserStore(s => mainGenesTrackShown(s.panels, { collapsedRows: s.collapsedRows, fullViewPanelId: s.fullViewPanelId }));
  const [genesDismissed, setGenesDismissed] = useState<string | null>(null);
  const showGenes = !restoring && !datasetProblem && !!genesPrompt && !genesTrackShown
    && genesDismissed !== genesPrompt.key && !genesNoticeDismissed(genesPrompt.key);
  if (!notice && !foreign && !showGenes) return null;
  return (
    <>
      {notice && (
        <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-3 py-1 text-[12px] text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
          role="status" data-testid="reference-notice">
          <Info size={14} className="flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1" data-testid="reference-notice-text">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded p-0.5 hover:bg-sky-100 dark:hover:bg-sky-900/40"
            aria-label="Dismiss" data-testid="reference-notice-dismiss"><X size={12} /></button>
        </div>
      )}
      {showGenes && genesPrompt && (
        <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-3 py-1 text-[12px] text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
          role="status" data-testid="genes-notice">
          <Info size={14} className="flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1"><GenesPromptControls key={genesPrompt.key} prompt={genesPrompt} testId="genes-notice-prompt" /></span>
          <button type="button" onClick={() => { dismissGenesNotice(genesPrompt.key); setGenesDismissed(genesPrompt.key); }}
            className="rounded p-0.5 hover:bg-sky-100 dark:hover:bg-sky-900/40" aria-label="Dismiss" data-testid="genes-notice-dismiss">
            <X size={12} />
          </button>
        </div>
      )}
      {foreign && target && (
        <div role="alert" data-testid="annotation-mismatch-banner"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
          <div className="flex min-w-0 flex-[1_1_320px] items-center gap-2">
            <AlertTriangle size={16} className="flex-shrink-0" aria-hidden="true" />
            <span className="flex-shrink-0 whitespace-nowrap font-semibold">Gene annotation mismatch</span>
            <span className="min-w-0 flex-1">
              The loaded genes ({annotation!.gene_count.toLocaleString()}{annotation!.genome_id ? `, ${annotation!.genome_id}` : ''}) are not on {target.genome_id}&apos;s contigs.
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" disabled={busy} data-testid="annotation-mismatch-reset"
              className={`${BUTTON} border-transparent bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600`}
              title={`Replace them with ${target.name}'s annotation${target.gtf_label ? ` (${target.gtf_label})` : ''}`}
              onClick={() => {
                setBusy(true);
                setError(null);
                void resetRegistryAnnotation(target.genome_id).then(res => { setBusy(false); if (!res.success) setError(res.error ?? null); });
              }}>
              {busy ? `Loading ${target.genome_id} genes…` : `Reset to ${target.genome_id} genes`}
            </button>
            <button type="button" onClick={() => setHidden(key)} data-testid="annotation-mismatch-dismiss"
              className={`${BUTTON} border-transparent bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`}>
              <X size={12} />Dismiss
            </button>
          </div>
          {error && <span className="basis-full text-[11px] text-rose-700 dark:text-rose-300" role="alert">{error}</span>}
        </div>
      )}
    </>
  );
}
