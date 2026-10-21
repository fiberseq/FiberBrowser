import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { onScreenStateKeys } from '../../utils/exportReadScopes';
import { foldedInShownGraph } from '../../stores/graphMembership';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchReadStats, type ReadStatsRegion, type ReadStatsResponse } from '../../api/readStats';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisStatus } from './shared';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useFocusedReadIds } from '../../hooks/useFocusedReadIds';
import { orderAssignmentReadIds } from '../../utils/clusterExport';
import { downloadTextFile, exportTimestamp, formatTsv } from '../../utils/analysisExport';
import { buildReadStatsRequestKey, resultForRequest } from '../../utils/readStatsRequestKey';
import { DistributionsTab } from './read-stats/DistributionsTab';
import { SummaryTab } from './read-stats/SummaryTab';
import { TableTab } from './read-stats/TableTab';
import type { ReadStatsDisplayRow } from './read-stats/types';
import { useAnalysisSettingsKey } from '../../hooks/useAnalysisSettingsKey';
import {
  capRequest, clusterOfScope, idsForScope, MAX_READ_STATS_READS, scopeOptions, summarizeByCluster,
  type ReadStatsScope,
} from '../../utils/readStatsScope';
import { ReadStatsScopePicker } from './read-stats/ReadStatsScopePicker';
import { describeReadSource } from './read-stats/readSource';
import { readStatsChromOf, readStatsRequestLoci } from './read-stats/readLocus';
import { viewFileStem } from '../../utils/panelScope';

type TabKey = 'summary' | 'table' | 'distributions';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'table', label: 'Table' },
  { key: 'distributions', label: 'Distributions' },
];

function appendUniqueReadIds(target: string[], readIds: string[]) {
  const seen = new Set(target);
  for (const readId of readIds) {
    if (seen.has(readId)) continue;
    seen.add(readId);
    target.push(readId);
  }
}

interface Props {
  isFullView?: boolean;
}

export function ReadStatsPanel({ isFullView }: Props) {
  const {
    chrom, start, end, spanningOnly,
    datasets,
    selectedReadIds,
    clearReadSelection,
    setReadSelection,
    clusterAssignments,
    clusterFocus,
    readSortOrder,
    clusterOrder,
    activeReadIds,
    jupyterReadOrder,
    analysisSampleSeed,
    activeColormap,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, spanningOnly: s.spanningOnly,
    datasets: s.datasets,
    selectedReadIds: s.selectedReadIds,
    clearReadSelection: s.clearReadSelection,
    setReadSelection: s.setReadSelection,
    clusterAssignments: s.clusterAssignments,
    clusterFocus: s.clusterFocus,
    readSortOrder: s.readSortOrder,
    clusterOrder: s.clusterOrder,
    activeReadIds: s.activeReadIds,
    jupyterReadOrder: s.jupyterReadOrder,
    analysisSampleSeed: s.analysisSampleSeed,
    activeColormap: s.activeColormap,
  })));

  const [activeTab, setActiveTab] = useState<TabKey>('summary');
  const [loading, setLoading] = useState(false);
  // The stats together with the request key they were fetched for.
  const [fetched, setFetched] = useState<{ key: string; data: ReadStatsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string>('viewer_order');
  const [sortAsc, setSortAsc] = useState(true);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const [containerWidth, containerRef] = useContainerWidth(280);
  const { hasClusterFocus, targetStateKeys } = useFocusedReadIds();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);
  const enabledQualityFilterCount = activeColormap.qualityFilters.filter(filter => filter.enabled).length;

  // Count total selected reads across all datasets
  const totalSelected = useMemo(() => {
    let n = 0;
    for (const ids of Object.values(selectedReadIds)) {
      n += ids.size;
    }
    return n;
  }, [selectedReadIds]);

  // Build request payload: remap stateKey-based selectedReadIds to datasetId for backend API
  const panels = useBrowserStore(s => s.panels);
  // Quality filters and legacy layer inference change the server's reads: stats
  // from before are hidden at once, and fetched again once the server has the
  // new settings (the quality sync bumps refreshGeneration when it lands).
  const analysisSettingsKey = useAnalysisSettingsKey();
  const stateKeyToDatasetId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of panels) {
      if (p.contentType === 'dataset' && p.datasetId) {
        const sk = p.stateKey ?? p.datasetId;
        map[sk] = p.datasetId;
      }
    }
    return map;
  }, [panels]);

  const orderOptions = useMemo(() => ({
    datasets, panels, readSortOrder, clusterOrder, activeReadIds, jupyterReadOrder,
  }), [datasets, panels, readSortOrder, clusterOrder, activeReadIds, jupyterReadOrder]);

  // Dataset panels on screen, by state key (a panel copy has its own): not
  // minimized, not in a collapsed row, not behind a maximized dataset panel.
  const collapsedRows = useBrowserStore(s => s.collapsedRows);
  const fullViewPanelId = useBrowserStore(s => s.fullViewPanelId);
  // (A member folded into a shown graph is on screen: its reads are in the host's band, at the host's locus.)
  const panelStateKeys = useMemo(() => onScreenStateKeys({ panels, collapsedRows, fullViewPanelId } as never),
    [panels, collapsedRows, fullViewPanelId]);
  const locusPanel = useCallback((sk: string) => {
    const own = panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === sk);
    return own?.collapsed ? foldedInShownGraph(own, panels) ?? own : own;
  }, [panels]);
  // Panels of one dataset at one locus show the same reads.
  const identityOf = useCallback((sk: string) => {
    const panel = locusPanel(sk);
    const v = panel?.viewportOverride;
    const at = v && (v.chrom !== chrom || v.start !== start || v.end !== end) ? `${v.chrom}:${v.start}-${v.end}` : 'main';
    return `${stateKeyToDatasetId[sk] || sk}@${at}`;
  }, [locusPanel, stateKeyToDatasetId, chrom, start, end]);

  // The selection per panel, in the panel's read order.
  const selectedByKey = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [sk, ids] of Object.entries(selectedReadIds)) {
      if (ids.size === 0) continue;
      const selectionAssignments: Record<string, number> = {};
      for (const readId of ids) selectionAssignments[readId] = clusterAssignments[sk]?.[readId] ?? 0;
      out[sk] = orderAssignmentReadIds(sk, selectionAssignments, orderOptions);
    }
    return out;
  }, [selectedReadIds, clusterAssignments, orderOptions]);

  // Which reads to describe: the selection, every read shown, or a cluster.
  // A new selection shows the selection; otherwise the group the user picked.
  const [scopePick, setScopePick] = useState<ReadStatsScope | null>(null);
  useEffect(() => { if (totalSelected > 0) setScopePick(null); }, [selectedReadIds, totalSelected]);
  const options = useMemo(() => scopeOptions({
    selectionCount: totalSelected,
    shownByKey: activeReadIds,
    assignments: clusterAssignments,
    stateKeys: panelStateKeys,
    clusterOrder: clusterOrder[panelStateKeys[0] ?? ''],
    identityOf,
  }), [totalSelected, activeReadIds, clusterAssignments, panelStateKeys, clusterOrder, identityOf]);
  const scope: ReadStatsScope = scopePick && options.some(o => o.key === scopePick)
    ? scopePick
    : totalSelected > 0 ? 'selection' : 'shown';
  const scopeOption = options.find(o => o.key === scope)!;
  const scopeCluster = clusterOfScope(scope);

  const scopeIds = useMemo(() => idsForScope(scope, {
    selectedByKey,
    shownByKey: activeReadIds,
    assignments: clusterAssignments,
    stateKeys: panelStateKeys,
    orderAssigned: (sk, members) => orderAssignmentReadIds(sk, members, orderOptions),
  }), [scope, selectedByKey, activeReadIds, clusterAssignments, panelStateKeys, orderOptions]);

  // Reads are looked up where they are shown: the main view's go in the
  // request, each panel at another locus adds its own region. Panels showing
  // the same reads are merged first, then the request is capped.
  // Lifted datasets (linear or graph rows) are described too (graph features): footprints and marks from their lifted
  // rows, alignment fields from each record's own source record (its bounds on the sample's assembly).
  const scoped = useMemo(() => {
    const result: Record<string, string[]> = {};
    const regions = new Map<string, ReadStatsRegion>();
    for (const [sk, orderedIds] of Object.entries(scopeIds)) {
      if (orderedIds.length === 0) continue;
      const dsId = stateKeyToDatasetId[sk] || sk;
      const panel = locusPanel(sk);
      const v = panel?.viewportOverride;
      const elsewhere = v && (v.chrom !== chrom || v.start !== start || v.end !== end) ? v : null;
      let target = result;
      if (elsewhere) {
        const key = `${elsewhere.chrom}:${elsewhere.start}-${elsewhere.end}`;
        let region = regions.get(key);
        if (!region) {
          region = { chrom: elsewhere.chrom, start: elsewhere.start, end: elsewhere.end, read_ids_by_dataset: {} };
          regions.set(key, region);
        }
        target = region.read_ids_by_dataset;
      }
      // Merge read IDs if multiple stateKeys map to the same dataset, but
      // keep each read once so requested/found counts match backend stats.
      if (!target[dsId]) target[dsId] = [];
      appendUniqueReadIds(target[dsId], orderedIds);
    }
    return capRequest(result, [...regions.values()]);
  }, [scopeIds, stateKeyToDatasetId, locusPanel, chrom, start, end]);
  const readIdsByDataset = scoped.main;
  const extraRegions = scoped.regions;
  const scopeTotal = scoped.total;

  // Which cluster each read of the result is in (for the By cluster table):
  // only when each dataset has one clustered panel on screen, so a read's
  // cluster is not ambiguous between panel copies clustered on their own.
  const clusteredKeyByDataset = useMemo(() => {
    const out = new Map<string, string>();
    for (const sk of panelStateKeys) {
      if (!Object.keys(clusterAssignments[sk] ?? {}).length) continue;
      const ds = stateKeyToDatasetId[sk] || sk;
      if (out.has(ds)) return null;
      out.set(ds, sk);
    }
    return out;
  }, [panelStateKeys, clusterAssignments, stateKeyToDatasetId]);
  const clusterOf = useCallback((datasetId: string, readId: string) => {
    const sk = clusteredKeyByDataset?.get(datasetId);
    return sk ? clusterAssignments[sk]?.[readId] : undefined;
  }, [clusteredKeyByDataset, clusterAssignments]);

  const requestedReadOrder = useMemo(() => {
    const order = new Map<string, number>();
    let i = 1;
    for (const byDataset of [readIdsByDataset, ...extraRegions.map(r => r.read_ids_by_dataset)]) {
      for (const [dsId, readIds] of Object.entries(byDataset)) {
        for (const readId of readIds) {
          const key = `${dsId}\t${readId}`;
          if (!order.has(key)) order.set(key, i++);
        }
      }
    }
    return order;
  }, [readIdsByDataset, extraRegions]);

  const readStatsRequestKey = useMemo(() => buildReadStatsRequestKey({
    chrom,
    start,
    end,
    spanning: spanningOnly,
    readIdsByDataset,
    sampleSeed: analysisSampleSeed,
    extraRegions,
    analysisSettingsKey,
  }), [analysisSampleSeed, chrom, end, extraRegions, readIdsByDataset, spanningOnly, start, analysisSettingsKey]);
  // Only stats for the current request are shown or exported: after the
  // selection changes (or its refresh fails) the older stats are dropped.
  const result = resultForRequest(fetched, readStatsRequestKey);

  // Debounced fetch
  useEffect(() => {
    if (scopeTotal === 0) {
      requestSeqRef.current += 1;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setLoading(false);
      setFetched(null);
      setError(null);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    const requestKey = readStatsRequestKey;
    const controller = new AbortController();
    const requestSeq = ++requestSeqRef.current;
    timerRef.current = setTimeout(async () => {
      if (requestSeqRef.current !== requestSeq) return;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchReadStats(chrom, start, end, spanningOnly, readIdsByDataset, analysisSampleSeed, {
          signal: controller.signal,
          extraRegions,
        });
        if (requestSeqRef.current === requestSeq && !controller.signal.aborted) {
          setFetched({ key: requestKey, data });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (requestSeqRef.current === requestSeq) {
          setError(e instanceof Error ? e.message : 'Failed to fetch read stats');
        }
      } finally {
        if (requestSeqRef.current === requestSeq && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      controller.abort();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (requestSeqRef.current === requestSeq) requestSeqRef.current += 1;
    };
  }, [readStatsRequestKey, scopeTotal]);

  // "Select cluster reads" handler
  const handleSelectClusterReads = useCallback(() => {
    for (const dsId of targetStateKeys) {
      const focus = clusterFocus[dsId];
      if (!focus) continue;
      const assignments = clusterAssignments[dsId] || {};
      const orderedIds = orderAssignmentReadIds(dsId, assignments, {
        datasets,
        panels,
        readSortOrder,
        clusterOrder,
        activeReadIds,
        jupyterReadOrder,
      }).filter(readId => focus.has(assignments[readId]));
      if (orderedIds.length > 0) setReadSelection(dsId, new Set(orderedIds));
    }
  }, [clusterAssignments, clusterFocus, datasets, panels, readSortOrder, clusterOrder, activeReadIds, jupyterReadOrder, setReadSelection, targetStateKeys]);

  // Sorted rows for table
  const sortedRows = useMemo<ReadStatsDisplayRow[]>(() => {
    if (!result) return [];
    const rows: ReadStatsDisplayRow[] = result.per_read.map(row => {
      const requestedOrder = requestedReadOrder.get(`${row.dataset_id}\t${row.read_id}`);
      return requestedOrder ? { ...row, viewer_order: requestedOrder } : row;
    });
    rows.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortCol];
      const bv = (b as unknown as Record<string, unknown>)[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortAsc ? av - bv : bv - av;
      }
      const sa = String(av), sb = String(bv);
      return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return rows;
  }, [result, requestedReadOrder, sortCol, sortAsc]);

  const handleSort = useCallback((col: string) => {
    if (col === sortCol) {
      setSortAsc(prev => !prev);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  }, [sortCol]);

  const readStatsTsvRows = useCallback(() => {
    if (!result) return;
    const cols = ['read_id', 'dataset_id', 'aligned_span', 'footprint_count', 'avg_footprint_size', 'accessibility_pct', 'methyl_count', 'methyl_pct', 'mapq', 'strand', 'viewer_order'];
    return [
      cols,
      ...sortedRows.map(r =>
        cols.map(c => {
          const v = (r as unknown as Record<string, unknown>)[c];
          return v == null ? '' : v;
        })
      ),
    ];
  }, [result, sortedRows]);

  // The loci the request covers: file names and the one read's chromosome come
  // from them, not the main locus (stale in Per panel mode, audit M2).
  const requestLoci = useMemo(() => ({ main: { chrom, start, end }, readIdsByDataset, extraRegions }), [chrom, start, end, readIdsByDataset, extraRegions]);
  const fileStem = useMemo(() => viewFileStem(readStatsRequestLoci(requestLoci)), [requestLoci]);

  const handleCopyTSV = useCallback(() => {
    const rows = readStatsTsvRows();
    if (!rows) return;
    navigator.clipboard.writeText(formatTsv(rows));
    setExportStatus(`Copied ${Math.max(0, rows.length - 1).toLocaleString()} TSV rows`);
  }, [readStatsTsvRows]);

  const handleDownloadTSV = useCallback(() => {
    const rows = readStatsTsvRows();
    if (!rows) return;
    downloadTextFile(
      formatTsv(rows),
      `read_stats_${fileStem}_${exportTimestamp()}.tsv`,
      'text/tab-separated-values',
    );
    setExportStatus(`Exported ${Math.max(0, rows.length - 1).toLocaleString()} TSV rows`);
  }, [fileStem, readStatsTsvRows]);

  const handleDownloadJSON = useCallback(() => {
    if (!result) return;
    downloadTextFile(
      JSON.stringify({
        kind: 'fiberbrowser.read_stats.v1',
        exported_at: new Date().toISOString(),
        settings: {
          chrom,
          start,
          end,
          spanning: spanningOnly,
          sample_seed: analysisSampleSeed,
          scope: { key: scope, label: scopeOption.label, reads: scopeTotal, truncated: scoped.truncated },
          requested_read_ids: readIdsByDataset,
          // Panels at other loci (their own view, another assembly): their reads were looked up there.
          other_regions: extraRegions,
          sort: { column: sortCol, ascending: sortAsc },
        },
        result,
        sorted_rows: sortedRows,
      }, null, 2),
      `read_stats_${fileStem}_${exportTimestamp()}.json`,
      'application/json',
    );
    setExportStatus(`Exported ${result.per_read.length.toLocaleString()} read stats`);
  }, [analysisSampleSeed, chrom, end, extraRegions, fileStem, readIdsByDataset, result, scope, scopeOption, scopeTotal, scoped.truncated, sortAsc, sortCol, sortedRows, spanningOnly, start]);

  const picker = (
    <ReadStatsScopePicker
      options={options}
      scope={scope}
      onChange={setScopePick}
      truncated={scoped.truncated ? { shown: MAX_READ_STATS_READS, total: scopeTotal } : null}
    />
  );
  const selectClusterButton = hasClusterFocus ? (
    <AnalysisButton
      theme="violet"
      variant="outline"
      size="sm"
      onClick={handleSelectClusterReads}
      data-tour="read-stats-select-cluster"
    >
      Select cluster reads
    </AnalysisButton>
  ) : null;

  // Empty state: nothing in this group.
  if (scopeTotal === 0 && !loading) {
    return (
      <div ref={containerRef} className="flex flex-col h-full overflow-hidden text-xs">
        <AnalysisPanelShell
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          theme="violet"
          showTabs={false}
          layout="standard"
          className="flex flex-col min-h-0 flex-1"
          bodyMode="panel"
          header={
            <AnalysisPanelHeader
              theme="violet"
              detail="Statistics for the selected reads, every read shown, or one cluster: a summary, distributions and a table you can export as TSV."
              meta={hasClusterFocus ? 'Cluster focus available' : undefined}
              actions={selectClusterButton ?? undefined}
            />
          }
          toolbar={picker}
        >
          <AnalysisStatus kind="empty" center title={scope === 'selection' ? 'Select reads' : 'No reads here'}>
            <div>
              {scope === 'selection'
                ? 'Shift+click reads to see statistics, or choose Reads shown or a cluster above.'
                : 'No reads are shown in this view yet.'}
            </div>
          </AnalysisStatus>
        </AnalysisPanelShell>
      </div>
    );
  }

  const narrow = containerWidth < 400;
  const agg = result?.aggregate;
  const requestedCount = result?.requested_count ?? Math.min(scopeTotal, MAX_READ_STATS_READS);
  const datasetCount = Object.keys(readIdsByDataset).length
    + extraRegions.reduce((n, r) => n + Object.keys(r.read_ids_by_dataset).filter(d => !(d in readIdsByDataset)).length, 0);
  const groupNoun = scope === 'selection' ? 'selected reads' : scope === 'shown' ? 'reads shown' : `reads in ${scopeOption.label}`;
  const foundCount = result?.found_count ?? result?.per_read.length ?? 0;
  const missingCount = result ? Math.max(0, requestedCount - foundCount) : 0;
  // One line under the title: which dataset (and panels) the reads are
  // from, plus how many were not found, only when some were not.
  const sourceKeys = Object.keys(scopeIds).filter(sk => scopeIds[sk]?.length);
  const source = describeReadSource(
    sourceKeys,
    sk => stateKeyToDatasetId[sk] || sk,
    id => datasets.find(d => d.id === id)?.label ?? id,
  );
  const headerDetail = [
    source ? `from ${source}` : '',
    result && missingCount > 0 ? `${missingCount.toLocaleString()} of ${requestedCount.toLocaleString()} not found in this view` : '',
    !result && error ? 'Read stats unavailable for this group' : '',
  ].filter(Boolean).join(' · ');
  const title = scope === 'selection'
    ? `${totalSelected} read${totalSelected !== 1 ? 's' : ''} selected`
    : scope === 'shown'
      ? `${scopeTotal.toLocaleString()} read${scopeTotal !== 1 ? 's' : ''} shown`
      : `${scopeOption.label} · ${scopeTotal.toLocaleString()} read${scopeTotal !== 1 ? 's' : ''}`;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden text-xs">
      <AnalysisPanelShell
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        theme="violet"
        layout="standard"
        className="flex flex-col min-h-0 flex-1"
        bodyMode="fill"
        header={
          <AnalysisPanelHeader
            theme="violet"
            title={title}
            detail={headerDetail}
            actions={
              <>
                {result && (
                  <>
                    <AnalysisButton
                      theme="violet"
                      variant="soft"
                      size="sm"
                      onClick={handleCopyTSV}
                    >
                      Copy TSV
                    </AnalysisButton>
                    <AnalysisButton
                      variant="neutral"
                      size="sm"
                      onClick={handleDownloadTSV}
                      data-tour="read-stats-export"
                    >
                      TSV
                    </AnalysisButton>
                    <AnalysisButton
                      variant="neutral"
                      size="sm"
                      onClick={handleDownloadJSON}
                    >
                      JSON
                    </AnalysisButton>
                  </>
                )}
                {selectClusterButton}
                {scope === 'selection' && (
                  <AnalysisButton
                    variant="dangerOutline"
                    size="sm"
                    onClick={() => clearReadSelection()}
                    data-tour="read-stats-deselect"
                  >
                    Deselect
                  </AnalysisButton>
                )}
              </>
            }
          />
        }
        toolbar={picker}
        summary={
          <AnalysisRunSummary
            seed={analysisSampleSeed}
            filterActive={hasClusterFocus}
            filterLabel="Cluster focus"
            filterSource={hasClusterFocus ? 'cluster-detail' : null}
            filterSourceLabel="Clusters"
            qualityFilterCount={enabledQualityFilterCount}
            inputs={[
              `${Math.min(scopeTotal, MAX_READ_STATS_READS).toLocaleString()} ${groupNoun}${scoped.truncated ? ` (first of ${scopeTotal.toLocaleString()})` : ''}`,
              datasetCount > 0 ? `${datasetCount} dataset${datasetCount !== 1 ? 's' : ''}` : 'no dataset selection',
              spanningOnly ? 'spanning reads' : 'overlapping reads',
            ]}
            outputs={result ? [
              `${foundCount.toLocaleString()} found`,
              `${missingCount.toLocaleString()} missing`,
            ] : []}
            extra={exportStatus ? (
              <span className="text-[11px] text-violet-700 dark:text-violet-300 px-1">
                {exportStatus}
              </span>
            ) : undefined}
          />
        }
      >
        {loading && (
          <AnalysisStatus kind="loading" center>
            Loading read statistics...
          </AnalysisStatus>
        )}

        {error && (
          <AnalysisStatus kind="error" center>
            {error}
          </AnalysisStatus>
        )}

        {!loading && result && missingCount > 0 && (
          <AnalysisStatus kind="warning" compact className="mb-2" title={`${missingCount} selected read${missingCount !== 1 ? 's' : ''} not found`}>
            Stats are scoped to selected read IDs in the current region; missing IDs may be outside this viewport or filtered by spanning mode.
          </AnalysisStatus>
        )}

        {!loading && result && activeTab === 'summary' && (
          <SummaryTab
            aggregate={agg!}
            isBam={result.is_bam}
            perRead={result.per_read}
            chrom={result.per_read.length === 1 ? readStatsChromOf(result.per_read[0], requestLoci) : chrom}
            containerWidth={containerWidth}
            byCluster={scopeCluster == null && clusteredKeyByDataset && clusteredKeyByDataset.size > 0
              ? summarizeByCluster(result.per_read, clusterOf, clusterOrder[panelStateKeys[0] ?? ''])
              : undefined}
            onPickCluster={cluster => setScopePick(`cluster:${cluster}`)}
          />
        )}

        {!loading && result && activeTab === 'table' && (
          <TableTab
            rows={sortedRows}
            total={result.per_read.length}
            sortCol={sortCol}
            sortAsc={sortAsc}
            onSort={handleSort}
            isBam={result.is_bam}
          />
        )}

        {!loading && result && activeTab === 'distributions' && (
          <DistributionsTab
            aggregate={agg!}
            isBam={result.is_bam}
            width={containerWidth}
            narrow={narrow}
          />
        )}
      </AnalysisPanelShell>
    </div>
  );
}
