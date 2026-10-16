import type { Dataset, PanelConfig } from '../../../../types';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../../../utils/datasetLabels';

interface CollapsedPanelChipsProps {
  panels: PanelConfig[];
  datasets: Dataset[];
  onRestore: (panelId: string) => void;
}

export function CollapsedPanelChips({ panels, datasets, onRestore }: CollapsedPanelChipsProps) {
  if (panels.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {panels.map(panel => {
        const dataset = datasets.find(d => d.id === panel.datasetId);
        const label = dataset ? getDatasetDisplayLabel(dataset, 28) : panel.datasetId;
        return (
          <button
            key={panel.id}
            onClick={() => onRestore(panel.id)}
            className="px-2 py-0.5 rounded text-[11px] font-medium text-white hover:opacity-80"
            style={{ backgroundColor: dataset?.color || '#666' }}
            title={`Restore ${dataset ? getDatasetHoverLabel(dataset) : panel.datasetId}`}
            data-tour="panel-expand"
          >
            {label} +
          </button>
        );
      })}
    </div>
  );
}
