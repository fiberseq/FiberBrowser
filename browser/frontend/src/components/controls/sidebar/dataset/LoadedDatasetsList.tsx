import type { Dataset } from '../../../../types';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../../../utils/datasetLabels';

interface LoadedDatasetsListProps {
  datasets: Dataset[];
}

export function LoadedDatasetsList({ datasets }: LoadedDatasetsListProps) {
  if (datasets.length === 0) {
    return (
      <div className="text-gray-400 dark:text-gray-500 italic text-[13px]">
        No datasets loaded.
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {datasets.map(dataset => (
        <div key={dataset.id} className="flex items-center gap-1.5 text-[13px]">
          <span className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: dataset.color }} />
          <span className="truncate flex-1 text-gray-700 dark:text-gray-300" title={getDatasetHoverLabel(dataset)}>
            {getDatasetDisplayLabel(dataset)}
          </span>
          <span className="text-[11px] text-ink-secondary">{dataset.data_type === 'bam_livelift' ? 'live lift' : (dataset.data_type || 'bam')}</span>
        </div>
      ))}
    </div>
  );
}
