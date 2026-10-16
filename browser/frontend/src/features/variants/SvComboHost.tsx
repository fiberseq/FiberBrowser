import { useSvComboStore } from './svFeatures';
import { VariantSplitDialog } from './VariantSplitDialog';
import { scanFor, useVariantsPanelState, useVariantsStore } from './variantsState';

/** The combined-SV genotype split's panel-count dialog, opened from the feature chip or the SV row (utils/svFeatures.ts). */
export function SvComboHost() {
  const pending = useSvComboStore(s => s.pending);
  const scans = useVariantsStore(s => s.scans), latest = useVariantsStore(s => s.latest);
  const panelState = useVariantsPanelState();
  if (!pending) return null;
  // (The scan's calls: the reference allele of the SNPs combined with the SVs.)
  const snps = scanFor(pending.grouping.dataset_id, { scans, latest }, panelState)?.snps;
  return (
    <VariantSplitDialog grouping={pending.grouping} datasetId={pending.grouping.dataset_id} title={pending.title} snps={snps}
      onClose={() => useSvComboStore.getState().close()}
      key={pending.grouping.scan_key + pending.title}
      note={(pending.grouping.svs?.length ?? 0) > 1
        ? 'With several SVs the panels stay on the reference; a panel whose reads all carry an insertion can show it expanded: “Expand …” in its header, or in its “…” menu when the panel is narrow.'
        : undefined} />
  );
}
