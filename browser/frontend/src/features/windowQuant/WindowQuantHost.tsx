/**
 * The metaprofile track's Quantify card: floating at the bottom right while the window was quantified from the track
 * (the cluster profiles show their own card in the Clusters panel). Comparison defaults stay the user's spec.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { usePlotTargets } from '../plots/usePlotTargets';
import { QuantifyCard, QuantWindowBar } from './QuantifyCard';

export function WindowQuantHost() {
  const openIn = useBrowserStore(s => s.windowQuant?.openIn ?? null);
  if (openIn !== 'track') return null;
  return <WindowQuantHostOpen />;
}

function WindowQuantHostOpen() {
  // The view the card quantifies (the active panel's, as useWindowQuant reads it), so a typed window lands on it.
  const view = usePlotTargets().allReads;
  return (
    <div className="fixed bottom-3 right-3 z-40 max-h-[80vh] w-[640px] max-w-[calc(100vw-24px)] overflow-auto rounded-lg border border-gray-200 bg-white p-2 shadow-xl dark:border-gray-700 dark:bg-gray-900"
      data-testid="quant-host" role="dialog" aria-label="Quantify window">
      <QuantWindowBar view={{ chrom: view.chrom, start: view.start, end: view.end }} origin="track" testId="quant-host-window-bar" />
      <QuantifyCard origin="track" width={600} testId="quant-host-card" />
    </div>
  );
}
