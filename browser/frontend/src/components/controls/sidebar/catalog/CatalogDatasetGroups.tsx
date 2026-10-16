import type { CatalogGroup } from '../../../../api/catalog';
import { DisclosureChevron } from '../../../ui/Disclosure';
import { defineSettings, settingAnchor } from '../../../../utils/settingsCatalog';

export const CATALOG_DATASET_SETTINGS = defineSettings({
  groups: {
    id: 'file.catalog-datasets',
    label: 'Dataset catalog: load a group',
    keywords: ['catalog', 'review deployment', 'dataset groups', 'public datasets'],
    location: { kind: 'sidebar', section: 'file' },
  },
});

interface CatalogDatasetGroupsProps {
  groups: CatalogGroup[];
  loading: Record<string, boolean>;
  expandedIndex: number | null;
  onExpandedChange: (index: number | null) => void;
  onGroupToggle: (index: number, loaded: boolean) => void;
}

export function CatalogDatasetGroups({
  groups,
  loading,
  expandedIndex,
  onExpandedChange,
  onGroupToggle,
}: CatalogDatasetGroupsProps) {
  return (
    <>
      {groups.map((grp, index) => {
        const isLoading = loading[`g${index}`];
        const isExpanded = expandedIndex === index;

        return (
          <div key={`g${index}`} className="rounded border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-1.5 px-2 py-1.5" {...settingAnchor(CATALOG_DATASET_SETTINGS.groups)}>
              <input
                type="checkbox"
                checked={grp.loaded}
                disabled={isLoading}
                onChange={() => onGroupToggle(index, grp.loaded)}
                className="rounded border-gray-300 dark:border-white/20 flex-shrink-0"
              />
              <button
                onClick={() => onExpandedChange(isExpanded ? null : index)}
                className="flex-1 min-w-0 text-left flex items-center gap-1 text-[12px]"
              >
                <span className="inline-flex w-3 text-gray-400"><DisclosureChevron open={isExpanded} /></span>
                <span className={`truncate ${grp.loaded ? 'text-gray-800 dark:text-gray-200 font-medium' : 'text-gray-600 dark:text-gray-400'}`} title={grp.name}>
                  {grp.name}
                </span>
              </button>
              <span className="text-[11px] text-ink-secondary whitespace-nowrap flex-shrink-0">
                {isLoading ? (
                  <span className="text-blue-500">loading...</span>
                ) : (
                  <>
                    {grp.dataset_count} file{grp.dataset_count !== 1 ? 's' : ''}
                    {grp.merge && <span className="ml-1 text-violet-500">merged</span>}
                  </>
                )}
              </span>
            </div>

            {isExpanded && (
              <div className="px-3 pb-2 text-[11px] text-gray-500 dark:text-gray-400 space-y-0.5 border-t border-gray-100 dark:border-gray-700/50 pt-1">
                {grp.description && <div className="italic mb-1">{grp.description}</div>}
                {grp.dataset_labels.map((label, labelIndex) => (
                  <div key={labelIndex} className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${grp.loaded ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                    <span className="truncate" title={label}>{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
