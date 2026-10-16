import { LayoutColumns, Link, Merge, Split, Unlink } from '../../../ui/Icons';

interface DatasetToolbarProps {
  selectedDatasetsCount: number;
  anyLinked: boolean;
  canLink: boolean;
  canMerge: boolean;
  selectedDatasetPanelCount: number;
  canUnmerge: boolean;
  unmergeCount: number;
  /** Arranging panels (reset sizes, equal widths, link groups) is the Layout panel's job. */
  onOpenLayoutPanel: () => void;
  onLinkToggle: () => void;
  onMerge: () => void;
  onUnmerge: () => void;
}

export function DatasetToolbar({
  selectedDatasetsCount,
  anyLinked,
  canLink,
  canMerge,
  selectedDatasetPanelCount,
  canUnmerge,
  unmergeCount,
  onOpenLayoutPanel,
  onLinkToggle,
  onMerge,
  onUnmerge,
}: DatasetToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={onOpenLayoutPanel}
        className="px-2.5 py-1 rounded text-[12px] font-medium inline-flex items-center gap-1 bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-700 dark:text-gray-300"
        title="Open the Layout panel: arrange, link and merge the dataset panels"
        data-testid="sidebar-open-layout-panel"
      >
        <LayoutColumns size={12} /> Arrange panels…
      </button>

      {selectedDatasetsCount > 0 && (
        <button
          onClick={onLinkToggle}
          disabled={!canLink && !anyLinked}
          className={`px-2.5 py-1 rounded text-[13px] font-medium inline-flex items-center gap-1 ${
            anyLinked
              ? 'bg-red-500 text-white hover:bg-red-600'
              : canLink
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-white/10 dark:text-gray-500'
          }`}
          title={anyLinked ? 'Unlink' : canLink ? 'Link selected panels' : 'Select 2+'}
        >
          {anyLinked ? <><Unlink size={12} /> Unlink</> : <><Link size={12} /> Link ({selectedDatasetsCount})</>}
        </button>
      )}

      {canMerge && (
        <button
          onClick={onMerge}
          className="px-2.5 py-1 rounded text-[13px] font-medium inline-flex items-center gap-1 bg-emerald-500 text-white hover:bg-emerald-600"
          title="Merge selected datasets into one multi-file dataset"
        >
          <Merge size={12} /> Merge ({selectedDatasetPanelCount})
        </button>
      )}

      {canUnmerge && (
        <button
          onClick={onUnmerge}
          className="px-2.5 py-1 rounded text-[13px] font-medium inline-flex items-center gap-1 bg-orange-500 text-white hover:bg-orange-600"
          title="Split merged dataset back into individual datasets"
        >
          <Split size={12} /> Unmerge ({unmergeCount} files)
        </button>
      )}

    </div>
  );
}
