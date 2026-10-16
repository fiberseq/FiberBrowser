import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Dataset, PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { addDataset as addDatasetApi, getDatasets, removeDataset as removeDatasetApi } from '../../api/datasets';
import { getDatasetDisplayLabel, getDatasetHoverLabel, getDatasetSourceNames } from '../../utils/datasetLabels';
import { Check, GridIcon, LayoutColumns, Link, Merge, Refresh, Split, Trash, Unlink } from '../ui/Icons';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisStatus } from './shared';
import { seedHistoryBaseline } from '../../stores/historySlice';

const PRESET_STORAGE_KEY = 'fiberbrowser_dataset_layout_presets';

interface DatasetArrangementGroup {
  label: string;
  paths: string[];
}

interface DatasetArrangementPreset {
  name: string;
  createdAt: number;
  groups: DatasetArrangementGroup[];
}

interface LayoutTreeBucket {
  panel: PanelConfig & { datasetId: string };
  dataset: Dataset;
  paths: string[];
  sourceNames: string[];
  merged: boolean;
}

interface LayoutTreeGroup {
  id: string;
  kind: 'linked' | 'unlinked';
  buckets: LayoutTreeBucket[];
}

function datasetPaths(dataset: Dataset): string[] {
  if (dataset.paths?.length) return dataset.paths;
  return dataset.path ? [dataset.path] : [];
}

function filename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function loadPresets(): DatasetArrangementPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
    const rawPresets: unknown[] = Array.isArray(parsed) ? parsed : [];
    return rawPresets
      .map((rawPreset: unknown): DatasetArrangementPreset | null => {
        if (!rawPreset || typeof rawPreset !== 'object') return null;
        const preset = rawPreset as { name?: unknown; createdAt?: unknown; groups?: unknown };
        const name = typeof preset.name === 'string' ? preset.name.trim() : '';
        const rawGroups: unknown[] = Array.isArray(preset.groups) ? preset.groups : [];
        const groups = rawGroups
          .map((group: unknown): DatasetArrangementGroup | null => {
            if (!group || typeof group !== 'object') return null;
            const candidate = group as { label?: unknown; paths?: unknown };
            const paths = Array.isArray(candidate.paths)
              ? candidate.paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
              : [];
            if (paths.length === 0) return null;
            const label = typeof candidate.label === 'string' && candidate.label.trim()
              ? candidate.label.trim()
              : filename(paths[0]);
            return { label, paths };
          })
          .filter((group: DatasetArrangementGroup | null): group is DatasetArrangementGroup => group !== null);
        if (!name || groups.length === 0) return null;
        const createdAt = Number.isFinite(Number(preset.createdAt)) ? Number(preset.createdAt) : Date.now();
        return { name, createdAt, groups };
      })
      .filter((preset): preset is DatasetArrangementPreset => preset !== null);
  } catch {
    return [];
  }
}

function savePresets(presets: DatasetArrangementPreset[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

function makePresetFromCurrent(
  name: string,
  datasets: Dataset[],
  panels: PanelConfig[],
): DatasetArrangementPreset | null {
  const panelOrderedIds = panels
    .filter((panel): panel is PanelConfig & { datasetId: string } =>
      panel.contentType === 'dataset' && !!panel.datasetId
    )
    .map(panel => panel.datasetId);
  const orderedIds = [...panelOrderedIds, ...datasets.map(dataset => dataset.id)];
  const seen = new Set<string>();
  const groups: DatasetArrangementGroup[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dataset = datasets.find(candidate => candidate.id === id);
    if (!dataset) continue;
    const paths = datasetPaths(dataset);
    if (paths.length === 0) continue;
    groups.push({ label: dataset.label || getDatasetDisplayLabel(dataset, 80), paths });
  }
  if (groups.length === 0) return null;
  return { name: name.trim(), createdAt: Date.now(), groups };
}

export function DatasetLayoutPanel({ isFullView = false }: { isFullView?: boolean }) {
  const {
    datasets,
    panels,
    linkPanels,
    unlinkPanel,
    setPanelCollapsed,
    resetPanelLayout,
    mergeSelectedPanels,
    unmergeSelectedPanel,
    clearPanelSelection,
    setDatasets,
    setDatasetLabel,
    triggerRefresh,
    equalizePanelWidths,
  } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    panels: s.panels,
    linkPanels: s.linkPanels,
    unlinkPanel: s.unlinkPanel,
    setPanelCollapsed: s.setPanelCollapsed,
    resetPanelLayout: s.resetPanelLayout,
    mergeSelectedPanels: s.mergeSelectedPanels,
    unmergeSelectedPanel: s.unmergeSelectedPanel,
    clearPanelSelection: s.clearPanelSelection,
    setDatasets: s.setDatasets,
    setDatasetLabel: s.setDatasetLabel,
    triggerRefresh: s.triggerRefresh,
    equalizePanelWidths: s.equalizePanelWidths,
  })));

  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<string>>(() => new Set());
  const [editingDatasetId, setEditingDatasetId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const skipRenameCommitRef = useRef(false);
  const [presetName, setPresetName] = useState('');
  const [presets, setPresets] = useState<DatasetArrangementPreset[]>(() => loadPresets());
  const [status, setStatus] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [busyPreset, setBusyPreset] = useState<string | null>(null);

  const datasetPanels = useMemo(
    () => panels.filter((panel): panel is PanelConfig & { datasetId: string } =>
      panel.contentType === 'dataset' && !!panel.datasetId
    ),
    [panels],
  );
  const datasetsById = useMemo(() => new Map(datasets.map(dataset => [dataset.id, dataset])), [datasets]);
  const layoutBuckets = useMemo(() => datasetPanels
    .map((panel): LayoutTreeBucket | null => {
      const dataset = datasetsById.get(panel.datasetId);
      if (!dataset) return null;
      const paths = datasetPaths(dataset);
      const sourceNames = getDatasetSourceNames(dataset);
      return {
        panel,
        dataset,
        paths,
        sourceNames,
        merged: paths.length > 1,
      };
    })
    .filter((bucket): bucket is LayoutTreeBucket => bucket !== null),
    [datasetPanels, datasetsById],
  );
  const layoutGroups = useMemo(() => {
    const linked = new Map<string, LayoutTreeBucket[]>();
    const unlinked: LayoutTreeGroup[] = [];
    for (const bucket of layoutBuckets) {
      const groupId = bucket.panel.linkGroup;
      if (!groupId) {
        unlinked.push({ id: `unlinked-${bucket.panel.id}`, kind: 'unlinked', buckets: [bucket] });
        continue;
      }
      const groupBuckets = linked.get(groupId) ?? [];
      groupBuckets.push(bucket);
      linked.set(groupId, groupBuckets);
    }
    const linkedGroups: LayoutTreeGroup[] = [...linked.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, buckets]) => ({ id, kind: 'linked', buckets }));
    return [...linkedGroups, ...unlinked];
  }, [layoutBuckets]);
  const selectedPanels = datasetPanels.filter(panel => selectedPanelIds.has(panel.id));
  const selectedMergedPanels = selectedPanels.filter(panel => {
    const dataset = datasetsById.get(panel.datasetId);
    return dataset ? datasetPaths(dataset).length > 1 : false;
  });
  const anyLinked = selectedPanels.some(panel => panel.linkGroup !== null);
  const canLink = selectedPanels.length >= 2;
  const canMerge = selectedPanels.length >= 2;
  const canUnmerge = selectedMergedPanels.length > 0;
  const linkedPanelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const bucket of layoutBuckets) {
      if (bucket.panel.linkGroup) ids.add(bucket.panel.id);
    }
    return ids;
  }, [layoutBuckets]);
  const linkedGroupCount = layoutGroups.filter(group => group.kind === 'linked').length;
  const unlinkedPanelCount = layoutBuckets.length - linkedPanelIds.size;
  const mergedBucketCount = layoutBuckets.filter(bucket => bucket.merged).length;
  // Only the actions that can apply now are shown (M20): linking and merging
  // need two dataset panels; Unmerge needs a merged one; Unlink a linked one.
  const multiplePanels = datasetPanels.length >= 2;
  const canTick = multiplePanels || mergedBucketCount > 0;
  // Rows that hold dataset panels, top to bottom: "row 2 of 2" counts these,
  // not the layout's own row index (an analysis panel can sit in a row too).
  const datasetRows = [...new Set(datasetPanels.map(panel => panel.layoutRow ?? 0))].sort((a, b) => a - b);
  const rowCount = datasetRows.length;
  const allInOneGroup = multiplePanels && linkedGroupCount === 1 && linkedPanelIds.size === datasetPanels.length;
  const tickHint = 'Tick two or more panels below first';

  const persistPresetList = (next: DatasetArrangementPreset[]) => {
    setPresets(next);
    savePresets(next);
  };

  const clearLocalSelection = () => setSelectedPanelIds(new Set());

  const togglePanelSelection = (panelId: string) => {
    setSelectedPanelIds(prev => {
      const next = new Set(prev);
      if (next.has(panelId)) next.delete(panelId);
      else next.add(panelId);
      return next;
    });
  };

  const toggleGroupSelection = (panelIds: string[]) => {
    setSelectedPanelIds(prev => {
      const next = new Set(prev);
      const allSelected = panelIds.every(id => next.has(id));
      for (const id of panelIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const selectAllPanels = () => {
    setSelectedPanelIds(new Set(datasetPanels.map(panel => panel.id)));
  };

  const beginRename = (dataset: Dataset) => {
    if (editingDatasetId === dataset.id) return;
    skipRenameCommitRef.current = false;
    setEditingDatasetId(dataset.id);
    setEditingLabel(dataset.label || getDatasetDisplayLabel(dataset, 80));
  };

  const commitRename = () => {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false;
      setEditingDatasetId(null);
      setEditingLabel('');
      return;
    }
    if (!editingDatasetId) return;
    const label = editingLabel.trim();
    const currentDataset = datasetsById.get(editingDatasetId);
    if (label && currentDataset && label !== currentDataset.label) {
      seedHistoryBaseline(useBrowserStore.getState(), 'Before dataset rename', 'layout');
      setDatasetLabel(editingDatasetId, label);
      useBrowserStore.getState().pushSnapshot('Rename dataset display label', { kind: 'layout' });
      setStatus({ kind: 'success', message: `Renamed display label to ${label}.` });
    }
    setEditingDatasetId(null);
    setEditingLabel('');
  };

  const cancelRename = () => {
    skipRenameCommitRef.current = true;
    setEditingDatasetId(null);
    setEditingLabel('');
  };

  const handleSavePreset = () => {
    const name = presetName.trim() || `Layout ${presets.length + 1}`;
    const preset = makePresetFromCurrent(name, datasets, panels);
    if (!preset) {
      setStatus({ kind: 'error', message: 'No dataset paths are available to save.' });
      return;
    }
    persistPresetList([preset, ...presets.filter(existing => existing.name !== name)]);
    setPresetName(name);
    setStatus({ kind: 'success', message: `Saved ${name}.` });
  };

  const handleDeletePreset = (name: string) => {
    persistPresetList(presets.filter(preset => preset.name !== name));
    setStatus({ kind: 'info', message: `Deleted ${name}.` });
  };

  const handleApplyPreset = async (preset: DatasetArrangementPreset) => {
    setBusyPreset(preset.name);
    setStatus({ kind: 'info', message: `Loading ${preset.name}...` });
    // Load the preset's datasets first: if one fails (a moved or missing file),
    // those loaded so far are removed again and the current workspace stays as
    // it was. Only once all of them load are the current datasets replaced.
    // A dataset already open with exactly a group's files is kept as it is
    // (loading it again would only make a second copy under a new ID).
    const fileKey = (paths: readonly string[]) => [...paths].sort().join('\n');
    const openByFiles = new Map(datasets.map(d => [fileKey(datasetPaths(d)), d]));
    const kept = new Set<string>();
    const toLoad = preset.groups.filter(group => {
      const open = openByFiles.get(fileKey(group.paths));
      if (open && !kept.has(open.id)) { kept.add(open.id); return false; }
      return true;
    });
    const previous = datasets.filter(d => !kept.has(d.id));
    const added: string[] = [];
    try {
      try {
        for (const group of toLoad) {
          const res = await addDatasetApi(group.paths.length === 1 ? group.paths[0] : group.paths, group.label);
          if (!res.success || !res.dataset) throw new Error(res.error || `Failed to load ${group.label}`);
          added.push(res.dataset.id);
        }
      } catch (error) {
        for (const id of added) await removeDatasetApi(id).catch(() => undefined);
        throw error;
      }
      for (const dataset of previous) {
        const res = await removeDatasetApi(dataset.id);
        if (!res.success) throw new Error(res.error || `Failed to remove ${dataset.label}`);
        useBrowserStore.getState().removeDataset(dataset.id);
      }
      const loaded = await getDatasets();
      for (const id of added) {
        const dataset = loaded.datasets.find(d => d.id === id);
        if (dataset) useBrowserStore.getState().addDataset(dataset);
      }
      const refreshed = loaded;
      setDatasets(refreshed.datasets);
      clearLocalSelection();
      clearPanelSelection();
      triggerRefresh();
      setStatus({ kind: 'success', message: `Loaded ${preset.name}.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: 'error', message });
    } finally {
      setBusyPreset(null);
    }
  };

  const handleMerge = async () => {
    if (!canMerge) return;
    useBrowserStore.setState({ selectedPanelIds: new Set(selectedPanels.map(panel => panel.id)) });
    await mergeSelectedPanels();
    clearPanelSelection();
    clearLocalSelection();
    setStatus({ kind: 'success', message: 'Merged selected datasets.' });
  };

  const handleUnmerge = async () => {
    if (!canUnmerge) return;
    for (const panel of selectedMergedPanels) {
      useBrowserStore.setState({ selectedPanelIds: new Set([panel.id]) });
      await unmergeSelectedPanel();
    }
    clearPanelSelection();
    clearLocalSelection();
    setStatus({ kind: 'success', message: 'Split selected merged datasets.' });
  };

  const handleLinkSelected = () => {
    if (!canLink) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before dataset link change', 'layout');
    linkPanels(selectedPanels.map(panel => panel.id));
    useBrowserStore.getState().pushSnapshot('Link selected datasets', { kind: 'layout' });
    setStatus({ kind: 'success', message: `Linked ${selectedPanels.length} selected panels.` });
  };

  const handlePairLinkSelected = () => {
    if (selectedPanels.length < 2) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before dataset pair links', 'layout');
    let linkedPairs = 0;
    for (let i = 0; i + 1 < selectedPanels.length; i += 2) {
      linkPanels([selectedPanels[i].id, selectedPanels[i + 1].id]);
      linkedPairs += 1;
    }
    useBrowserStore.getState().pushSnapshot('Pair-link selected datasets', { kind: 'layout' });
    const leftover = selectedPanels.length % 2 === 1 ? ' One selected panel was left unpaired.' : '';
    setStatus({ kind: 'success', message: `Created ${linkedPairs} pair link${linkedPairs === 1 ? '' : 's'}.${leftover}` });
  };

  const handleLinkAll = () => {
    if (datasetPanels.length < 2) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before link all datasets', 'layout');
    linkPanels(datasetPanels.map(panel => panel.id));
    useBrowserStore.getState().pushSnapshot('Link all datasets', { kind: 'layout' });
    setStatus({ kind: 'success', message: `Linked all ${datasetPanels.length} panels.` });
  };

  const handleUnlinkSelected = () => {
    if (!anyLinked) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before dataset unlink change', 'layout');
    for (const panel of selectedPanels) unlinkPanel(panel.id);
    useBrowserStore.getState().pushSnapshot('Unlink selected datasets', { kind: 'layout' });
    setStatus({ kind: 'info', message: 'Unlinked selected panels.' });
  };

  const handleUnlinkAll = () => {
    if (linkedPanelIds.size === 0) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before unlink all datasets', 'layout');
    for (const panelId of linkedPanelIds) unlinkPanel(panelId);
    useBrowserStore.getState().pushSnapshot('Unlink all datasets', { kind: 'layout' });
    setStatus({ kind: 'info', message: 'Removed all dataset links.' });
  };

  const renderBucket = (bucket: LayoutTreeBucket) => {
    const { panel, dataset, paths, sourceNames, merged } = bucket;
    const sourceSummary = sourceNames.length === 0
      ? ''
      : sourceNames.length === 1
        ? sourceNames[0]
        : `${sourceNames.slice(0, 2).join(' + ')}${sourceNames.length > 2 ? ` + ${sourceNames.length - 2} more` : ''}`;
    const selected = selectedPanelIds.has(panel.id);
    const isEditing = editingDatasetId === dataset.id;
    const labelValue = isEditing ? editingLabel : dataset.label || getDatasetDisplayLabel(dataset, 80);

    return (
      <div
        key={panel.id}
        onClick={event => {
          if (!canTick) return;
          const target = event.target as HTMLElement;
          if (target.closest('button,input')) return;
          togglePanelSelection(panel.id);
        }}
        className={`rounded border p-2 transition-colors ${
          selected
            ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20'
            : 'border-gray-200 bg-white hover:border-gray-300 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20'
        }`}
      >
        <div className="flex items-start gap-2">
          {canTick && <button
            onClick={() => togglePanelSelection(panel.id)}
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
              selected
                ? 'border-blue-500 bg-blue-500 text-white'
                : 'border-gray-300 bg-white text-transparent hover:border-blue-400 dark:border-white/20 dark:bg-black/20'
            }`}
            title={selected ? 'Untick this panel' : 'Tick this panel to link or merge it'}
            aria-pressed={selected}
            data-tour="layout-select-panel"
          >
            <Check size={12} />
          </button>}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={labelValue}
                data-copilot-anchor={`dataset-label-input-${dataset.id}`}
                data-tour="layout-rename"
                onFocus={() => beginRename(dataset)}
                onChange={event => setEditingLabel(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    cancelRename();
                    event.currentTarget.blur();
                  }
                }}
                onBlur={commitRename}
                className="min-w-[160px] max-w-full flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-gray-800 outline-none hover:border-gray-200 hover:bg-white focus:border-blue-300 focus:bg-white dark:text-gray-100 dark:hover:border-white/10 dark:hover:bg-black/20 dark:focus:border-blue-800 dark:focus:bg-gray-950"
                title={getDatasetHoverLabel(dataset)}
                aria-label="Dataset display label"
              />
              {merged && (
                <span
                  className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                  title="Several files pooled into this one panel"
                >
                  {paths.length} files merged
                </span>
              )}
              {panel.linkGroup && (
                <span
                  className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                  title="Shares clustering and analysis with the other panels in its link group"
                >
                  linked
                </span>
              )}
              {rowCount > 1 && (
                <span
                  className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-300"
                  title="Panels sit in rows, counted from the top of the view"
                >
                  row {datasetRows.indexOf(panel.layoutRow ?? 0) + 1} of {rowCount}
                </span>
              )}
              {panel.collapsed && (
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-300">
                  minimized
                </span>
              )}
            </div>
            {sourceSummary && (
              <div
                className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400"
                title={sourceNames.join('\n')}
              >
                Source: {sourceSummary}
              </div>
            )}
            <div className="mt-1 border-l border-gray-200 pl-2 dark:border-white/10">
              {paths.map(path => (
                <div
                  key={path}
                  className="truncate py-0.5 font-mono text-[11px] text-gray-500 dark:text-gray-400"
                  title={path}
                >
                  {filename(path)}
                </div>
              ))}
            </div>
          </div>
          <AnalysisButton
            onClick={() => setPanelCollapsed(panel.id, !panel.collapsed)}
            variant="neutral"
            size="xs"
            title={panel.collapsed ? 'Restore panel' : 'Minimize panel'}
          >
            {panel.collapsed ? 'Restore' : 'Minimize'}
          </AnalysisButton>
        </div>
      </div>
    );
  };

  const renderGroup = (group: LayoutTreeGroup) => {
    if (group.kind === 'unlinked') return renderBucket(group.buckets[0]);
    const panelIds = group.buckets.map(bucket => bucket.panel.id);
    const allSelected = panelIds.every(panelId => selectedPanelIds.has(panelId));
    const selectedCount = panelIds.filter(panelId => selectedPanelIds.has(panelId)).length;

    return (
      <div key={group.id} className="rounded border border-blue-100 bg-blue-50/40 p-2 dark:border-blue-900/40 dark:bg-blue-950/20">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => toggleGroupSelection(panelIds)}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
              allSelected
                ? 'border-blue-500 bg-blue-500 text-white'
                : selectedCount > 0
                  ? 'border-blue-500 bg-blue-100 text-blue-600 dark:bg-blue-900/40'
                  : 'border-blue-300 bg-white text-transparent hover:border-blue-500 dark:border-blue-800 dark:bg-black/20'
            }`}
            title={allSelected ? 'Untick these linked panels' : 'Tick these linked panels'}
          >
            <Check size={12} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-blue-700 dark:text-blue-300" title="These panels share clustering and analysis">
              Linked panels
            </div>
            <div className="text-[11px] text-blue-600/70 dark:text-blue-300/70">
              {group.buckets.length} panel{group.buckets.length === 1 ? '' : 's'} · {selectedCount} ticked
            </div>
          </div>
          <AnalysisButton
            onClick={() => {
              seedHistoryBaseline(useBrowserStore.getState(), 'Before unlink group', 'layout');
              group.buckets.forEach(bucket => unlinkPanel(bucket.panel.id));
              useBrowserStore.getState().pushSnapshot('Unlink dataset group', { kind: 'layout' });
              setStatus({ kind: 'info', message: `Unlinked ${group.buckets.length} panel${group.buckets.length === 1 ? '' : 's'}.` });
            }}
            variant="dangerOutline"
            size="xs"
            title="Unlink these panels from each other"
          >
            Unlink these
          </AnalysisButton>
        </div>
        <div className="space-y-1.5">
          {group.buckets.map(renderBucket)}
        </div>
      </div>
    );
  };

  const currentGroups = makePresetFromCurrent('Current layout', datasets, panels)?.groups ?? [];

  return (
    <AnalysisPanelShell
      tabs={[{ key: 'layout', label: 'Layout' }]}
      activeTab="layout"
      onTabChange={() => {}}
      theme="slate"
      showTabs={false}
      layout="standard"
      bodyMode="fill"
      isFullView={isFullView}
      header={
        <AnalysisPanelHeader
          detail="Arrange the dataset panels: link them so they share clustering, merge datasets into one panel, even out their widths, and save an arrangement to reuse."
          theme="slate"
        />
      }
      toolbar={
        <section className="fb-panel-card text-[12px]" data-testid="layout-arrange-card">
              <div className="flex items-center gap-2">
            <LayoutColumns size={16} className="flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-gray-900 dark:text-gray-100">Arrange panels</h3>
          </div>
              <div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
            {!multiplePanels && (
              <p className="col-span-2 text-[11px] text-ink-muted dark:text-gray-400" data-testid="layout-link-needs-two">
                Linking and merging need two or more dataset panels: open another file, or add a copy of this one (Add a copy, in the dataset panel's header menu).
              </p>
            )}
            {canTick && (
              <>
                <span className="pt-1 text-gray-700 dark:text-gray-300" title="Tick panels in the list below">
                  Ticked ({selectedPanels.length})
                </span>
                <div className="flex flex-wrap items-center gap-1 text-[11px]">
                  {multiplePanels && (
                    <>
                      <AnalysisButton
                        onClick={handleMerge}
                        disabled={!canMerge}
                        data-copilot-anchor="dataset-merge-button"
                        theme="emerald"
                        variant="primary"
                        size="sm"
                        className="inline-flex items-center gap-1"
                        title={canMerge ? 'Pool the ticked datasets into one panel' : tickHint}
                      >
                        <Merge size={12} /> Merge
                      </AnalysisButton>
                      <AnalysisButton
                        onClick={handleLinkSelected}
                        disabled={!canLink}
                        data-copilot-anchor="dataset-link-button"
                        theme="blue"
                        variant={canLink ? 'primary' : 'neutral'}
                        size="sm"
                        className="inline-flex items-center gap-1"
                        title={canLink ? 'Link the ticked panels so they share clustering and analysis' : tickHint}
                      >
                        <Link size={12} /> Link
                      </AnalysisButton>
                    </>
                  )}
                  {linkedPanelIds.size > 0 && (
                    <AnalysisButton
                      onClick={handleUnlinkSelected}
                      disabled={!anyLinked}
                      data-copilot-anchor="dataset-unlink-button"
                      variant="dangerOutline"
                      size="sm"
                      className="inline-flex items-center gap-1"
                      title={anyLinked ? 'Unlink the ticked panels' : 'Tick a linked panel below first'}
                    >
                      <Unlink size={12} /> Unlink
                    </AnalysisButton>
                  )}
                  {mergedBucketCount > 0 && (
                    <AnalysisButton
                      onClick={handleUnmerge}
                      disabled={!canUnmerge}
                      data-copilot-anchor="dataset-unmerge-button"
                      variant="warning"
                      size="sm"
                      className="inline-flex items-center gap-1"
                      title={canUnmerge ? 'Split the ticked merged panels back into one panel per file' : 'Tick a merged panel below first'}
                    >
                      <Split size={12} /> Unmerge
                    </AnalysisButton>
                  )}
                  {selectedPanelIds.size > 0 && (
                    <AnalysisButton onClick={clearLocalSelection} variant="neutral" size="sm">
                      Clear ticks
                    </AnalysisButton>
                  )}
                </div>
              </>
            )}
            <span className="pt-1 text-gray-700 dark:text-gray-300">All panels</span>
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              {panels.filter(p => !p.collapsed).length >= 2 && <AnalysisButton
                onClick={equalizePanelWidths}
                variant="neutral"
                size="sm"
                className="inline-flex items-center gap-1"
                title="Give every panel in a row the same width"
                data-testid="layout-equal-widths"
              >
                <GridIcon size={12} /> Equal widths
              </AnalysisButton>}
              <AnalysisButton
                onClick={resetPanelLayout}
                variant="neutral"
                size="sm"
                className="inline-flex items-center gap-1"
                title="Reset rows, sizes, and track layout"
                data-tour="layout-reset"
              >
                <Refresh size={12} /> Reset
              </AnalysisButton>
            </div>
          </div>
        </section>
      }
    >
      <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
        <div className="min-w-0 space-y-2">
          {status && <AnalysisStatus kind={status.kind}>{status.message}</AnalysisStatus>}
          {layoutBuckets.length > 0 && (
            <div className="fb-panel-card" data-tour="layout-tree">
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                <h3 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">Dataset panels</h3>
                {multiplePanels && (
                  <span>
                    {[
                      `${selectedPanelIds.size} ticked`,
                      linkedGroupCount > 0 ? `${linkedGroupCount} link group${linkedGroupCount === 1 ? '' : 's'}` : '',
                      mergedBucketCount > 0 ? `${mergedBucketCount} merged` : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                )}
                {multiplePanels && (
                  <div className="ml-auto flex flex-wrap gap-1">
                    <AnalysisButton onClick={selectAllPanels} variant="neutral" size="xs" title="Tick every dataset panel">
                      Tick all
                    </AnalysisButton>
                    {datasetPanels.length >= 3 && (
                      <AnalysisButton
                        onClick={handlePairLinkSelected}
                        disabled={selectedPanels.length < 2}
                        theme="blue"
                        variant="outline"
                        size="xs"
                        title={selectedPanels.length < 2 ? tickHint : 'Link the ticked panels two by two, in panel order'}
                      >
                        Pair link
                      </AnalysisButton>
                    )}
                    {!allInOneGroup && (
                      <AnalysisButton
                        onClick={handleLinkAll}
                        theme="blue"
                        variant="outline"
                        size="xs"
                        title="Link every dataset panel into one group"
                      >
                        Link all
                      </AnalysisButton>
                    )}
                    {linkedPanelIds.size > 0 && (
                      <AnalysisButton
                        onClick={handleUnlinkAll}
                        variant="dangerOutline"
                        size="xs"
                        title="Remove all dataset links"
                      >
                        Unlink all
                      </AnalysisButton>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {layoutGroups.map(renderGroup)}
              </div>
            </div>
          )}
          {layoutBuckets.length === 0 && (
            <div className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-white/15 dark:text-gray-400">
              No dataset panels are open.
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-2">
          <div className="fb-panel-card" data-tour="layout-save-arrangement">
            <h3 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">Save Arrangement</h3>
            <div className="flex gap-1">
              <input
                value={presetName}
                onChange={event => setPresetName(event.target.value)}
                className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-white/10 dark:bg-gray-900 dark:text-gray-200"
                placeholder="Preset name"
              />
              <AnalysisButton onClick={handleSavePreset} theme="emerald" variant="primary" size="sm">
                Save
              </AnalysisButton>
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              Current layout: {currentGroups.length} group{currentGroups.length === 1 ? '' : 's'}.
            </div>
          </div>

          <div className="fb-panel-card" data-tour="layout-saved-arrangements">
            <h3 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">Saved Arrangements</h3>
            {presets.length === 0 ? (
              <div className="text-xs text-gray-500 dark:text-gray-400">No saved arrangements.</div>
            ) : (
              <div className="space-y-2">
                {presets.map(preset => (
                  <div key={preset.name} className="rounded border border-gray-100 p-2 dark:border-white/10">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-gray-700 dark:text-gray-200" title={preset.name}>
                          {preset.name}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {preset.groups.length} group{preset.groups.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <AnalysisButton
                          onClick={() => handleApplyPreset(preset)}
                          disabled={busyPreset !== null}
                          theme="blue"
                          variant="primary"
                          size="xs"
                        >
                          {busyPreset === preset.name ? 'Loading' : 'Load'}
                        </AnalysisButton>
                        <AnalysisButton
                          onClick={() => handleDeletePreset(preset.name)}
                          disabled={busyPreset !== null}
                          variant="dangerOutline"
                          size="xs"
                          title="Delete preset"
                        >
                          <Trash size={11} />
                        </AnalysisButton>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {preset.groups.slice(0, 4).map(group => (
                        <span
                          key={`${preset.name}-${group.label}`}
                          className="max-w-[120px] truncate rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400"
                          title={group.paths.join('\n')}
                        >
                          {group.label}
                        </span>
                      ))}
                      {preset.groups.length > 4 && (
                        <span className="text-[11px] text-gray-400">+{preset.groups.length - 4}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AnalysisPanelShell>
  );
}
