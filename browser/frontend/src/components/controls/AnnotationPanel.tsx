import { useState, useEffect } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { getAnnotationFiles } from '../../api/annotations';
import { AnalysisPanelHeader, AnalysisPanelShell } from './shared';
import { FilesTab } from './annotation-panel/FilesTab';
import { TypesTab } from './annotation-panel/TypesTab';
import { FilterTab } from './annotation-panel/FilterTab';
import { ClusterTab } from './annotation-panel/ClusterTab';
import { ProfileTab } from './annotation-panel/ProfileTab';
import type { TabKey } from './annotation-panel/constants';
import { consumeRequestedTab } from '../../utils/requestedTabs';

interface Props {
  isFullView?: boolean;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'files', label: 'Files' },
  { key: 'types', label: 'Types' },
  { key: 'filter', label: 'Filter' },
  { key: 'cluster', label: 'Cluster' },
  { key: 'profile', label: 'Profile' },
];
const TAB_KEYS = TABS.map(tab => tab.key);
const ANNOTATION_TAB_STORAGE_KEY = 'fiberbrowser_annotation_tab';

function initialAnnotationTab(): TabKey {
  return consumeRequestedTab(ANNOTATION_TAB_STORAGE_KEY, TAB_KEYS, 'files');
}

export function AnnotationPanel({ isFullView }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>(initialAnnotationTab);

  const {
    annotationFiles,
    enabledAnnotationTypes,
    annotationOverlays,
    setAnnotationFiles,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    enabledAnnotationTypes: s.enabledAnnotationTypes,
    annotationOverlays: s.annotationOverlays,
    setAnnotationFiles: s.setAnnotationFiles,
  })));

  // Fetch annotation files on mount
  useEffect(() => {
    const controller = new AbortController();
    getAnnotationFiles({ signal: controller.signal })
      .then(res => setAnnotationFiles(res.files))
      .catch(err => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // Silently fail if no annotations endpoint.
      });
    return () => controller.abort();
  }, [setAnnotationFiles]);

  useEffect(() => {
    const handler = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: TabKey }>).detail?.tab;
      if (tab && TAB_KEYS.includes(tab)) setActiveTab(tab);
    };
    window.addEventListener('fiberbrowser:open-annotation-tab', handler);
    return () => window.removeEventListener('fiberbrowser:open-annotation-tab', handler);
  }, []);

  const fileCount = annotationFiles.length;
  const activeFileCount = annotationFiles.filter(file => file.active).length;
  const typeCount = new Set(
    annotationFiles.flatMap(file => (file.annotationTypes ?? []).map(type => type.name))
  ).size;
  const enabledTypeCount = Object.values(enabledAnnotationTypes).filter(Boolean).length;
  const overlayReadCount = Object.keys(annotationOverlays).length;

  return (
    <AnalysisPanelShell
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      theme="violet"
      isFullView={isFullView}
      className={`flex flex-col gap-2 p-2 ${isFullView ? 'h-full min-h-0' : ''}`}
      bodyMode={isFullView ? 'fill' : 'panel'}
      bodyClassName="space-y-2"
      header={
        <AnalysisPanelHeader
          title="Annotations"
          detail={`${fileCount} annotation file${fileCount !== 1 ? 's' : ''} available`}
          theme="violet"
        />
      }
    >
      {activeTab === 'files' && <FilesTab />}
      {activeTab === 'types' && <TypesTab />}
      {activeTab === 'filter' && <FilterTab />}
      {activeTab === 'cluster' && <ClusterTab />}
      {activeTab === 'profile' && <ProfileTab />}
    </AnalysisPanelShell>
  );
}
