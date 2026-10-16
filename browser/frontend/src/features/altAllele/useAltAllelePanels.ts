import { useEffect } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { healAltAllelePanels } from './altAllelePanel';

/**
 * Alt-allele panels (utils/altAllelePanel.ts) whose built dataset did not come back
 * with a restored session or crash recovery are rebuilt from the insertion they record.
 */
export function useAltAllelePanels(): void {
  const orphans = useBrowserStore(s => {
    const open = new Set(s.datasets.map(d => d.id));
    return s.panels.filter(p => p.altAllele && p.datasetId && !open.has(p.datasetId) && open.has(p.altAllele.cluster.datasetId))
      .map(p => p.id).join('\n');
  });
  useEffect(() => {
    if (orphans) void healAltAllelePanels();
  }, [orphans]);
}
