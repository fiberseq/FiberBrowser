import type { PanelConfig } from '../../../types';
import { closeSplitPanels } from '../../../utils/splitPanels';
import { goToSplitLocus, setSplitShowAll, splitLocusText } from '../../../utils/splitLocus';
import { panelTraits } from '../../../utils/panelExtensions';

/**
 * A split panel whose view has left the split's locus (utils/splitLocus.ts): its reads were classified
 * there, so here none of the reads in view are in a group. Says so, with Go back, Show all reads here
 * (unfiltered, labelled in the header) and Close split, instead of an empty panel.
 *
 * `pinned`: a split panel on a contig of its own (an insert-expanded Carriers panel) stays on it while the split's
 * other panels moved away (audit bug 4 / SV-2): it says so, with Go back, its way back to the reference and Close split.
 */
export function SplitAwayBanner({ panel, pinned = false }: { panel: PanelConfig; pinned?: boolean }) {
  const subset = panel.readSubset!;
  // "Reference", not "INS 9.2 kb @ chr2L:9,467,039 · Reference" (the first line names the split).
  const prefix = subset.locus?.label ? `${subset.locus.label} · ` : '';
  const groupName = prefix && subset.label.startsWith(prefix) ? subset.label.slice(prefix.length) : subset.label;
  const back = pinned ? panelTraits(panel).backToReference : undefined;
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-2" data-render-hide="true" data-testid="split-away-banner"
      data-pinned={pinned || undefined}>
      <div role="status" className="max-w-[min(560px,100%)] rounded-fb border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-ink shadow-md dark:border-amber-700/70 dark:bg-amber-950 dark:text-gray-100">
        <div className="font-medium" data-testid="split-away-text">
          {pinned
            ? <>Pinned to the insertion: this split is for {splitLocusText(subset)}, and its other panels have moved away.</>
            : <>This split is for {splitLocusText(subset)}; the reads here aren&apos;t classified.</>}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-muted dark:text-gray-300">
          {pinned
            ? <>{groupName} stays on the insertion&apos;s own coordinates (the insert expanded); the main view doesn&apos;t move it.</>
            : <>Its groups ({groupName} is one) were made from the reads in that view.</>}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button type="button" className="fb-btn-primary h-7 px-2.5 text-[12px]" onClick={() => goToSplitLocus(panel)} data-testid="split-away-go-back">Go back</button>
          {!pinned && (
            <button type="button" className="fb-btn-secondary h-7 px-2.5 text-[12px]" onClick={() => setSplitShowAll(subset.groupId, true)}
              title="Show every read in this view in these panels (not split; the header says so). Back at the split's locus they show their groups again."
              data-testid="split-away-show-all">Show all reads here</button>
          )}
          {back && (
            <button type="button" className="fb-btn-secondary h-7 px-2.5 text-[12px]" onClick={back.run} data-testid="split-away-reference"
              title="Show this panel on the reference again (its reads as they align there)">{back.label}</button>
          )}
          <button type="button" className="fb-btn-secondary h-7 px-2.5 text-[12px]" onClick={() => void closeSplitPanels(subset.groupId)}
            data-testid="split-away-close">Close split</button>
        </div>
      </div>
    </div>
  );
}
