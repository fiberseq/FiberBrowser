import { datasetPanelView } from '../../utils/panelScope';
import { variantScanTarget, variantScanIdentity } from './scanTarget';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
/**
 * The SNP scan of the view: run when the view (or the dataset, or the thresholds) changes while the SNPs or
 * Combinations tab is shown and Auto is on, debounced, the previous request cancelled (the server stops reading the
 * BAM when its client goes away). A view scanned before with the same settings is not asked for again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { scanSnps, type ScanTarget, type SnpParams, type SnpScan } from './api';
import type { PanelConfig } from '../../types';
import type { Dataset } from '../../types/dataset';
import { trimScan, updateVariantsState, useVariantsStore } from './variantsState';

export const MAX_SCAN_SPAN = 300_000;
export const SCAN_DEBOUNCE_MS = 500;

export type ScanStatus =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'done'; scan: SnpScan }
  | { kind: 'too-wide'; message: string }
  | { kind: 'error'; message: string };

/** The BAM datasets shown in read panels (the main view's first), and the one the panel scans. */
export function variantDatasets(panels: PanelConfig[], datasets: Dataset[]): Dataset[] {
  const shown = panels.filter(p => p.contentType === 'dataset' && p.datasetId ).map(p => p.datasetId!);
  const bam = datasets.filter(d => d.data_type === 'bam');
  const ordered = [...new Set(shown)].map(id => bam.find(d => d.id === id)).filter((d): d is Dataset => Boolean(d));
  return ordered.length ? ordered : bam;
}

export function chooseDataset(wanted: string | undefined, choices: Dataset[]): string {
  if (wanted && choices.some(d => d.id === wanted)) return wanted;
  return choices[0]?.id ?? '';
}

/** The read panel a dataset's grouping goes to (its main-view panel). */
export function panelForDataset(panels: PanelConfig[], datasetId: string): PanelConfig | undefined {
  const view = datasetPanelView({ ...useBrowserStore.getState(), panels }, datasetId);
  return panels.find(p => p.id === view.panelId);
}

/** A scan's identity on this page: the dataset (and its files: a reused id with other files is another scan), the
 * reference, the view and the settings. */
export function clientScanKey(target: ScanTarget, params: SnpParams, duplicates: boolean, identity = ''): string {
  return JSON.stringify([target.datasetId, identity, target.genome ?? null, target.readIds ?? null, target.chrom, Math.floor(target.start), Math.ceil(target.end), params, duplicates,
    // (A subset scan is its panel's: another panel's same reads are scanned for it.)
    ...(target.readIds && target.panelKey ? [target.panelKey] : [])]);
}

const scanned = new Map<string, string>();   // client key -> server scan key

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

export function useSnpScan({ datasetId, params, autoScan, active }: {
  datasetId: string; params: SnpParams; autoScan: boolean; active: boolean;
}) {
  useSplitPanelStore(s => s.reads);
  const { chrom, start, end, genome, readScope, panelKey, duplicates, identity } = useBrowserStore(useShallow(s => {
    const view = variantScanTarget(s, datasetId);
    return {
      chrom: view.chrom, start: view.start, end: view.end, genome: view.genome, readScope: JSON.stringify(view.readIds ?? null),
      panelKey: view.panelKey, duplicates: Boolean(s.showDuplicateReads),
      identity: variantScanIdentity(s, datasetId),
    };
  }));
  const target = useMemo<ScanTarget | null>(() => (datasetId && chrom ? { datasetId, chrom, ...(genome ? { genome } : {}), ...(readScope !== "null" ? { readIds: JSON.parse(readScope), ...(panelKey ? { panelKey } : {}) } : {}), start: Math.floor(start), end: Math.ceil(end) } : null),
    [datasetId, chrom, start, end, genome, readScope, panelKey]);
  const key = target ? clientScanKey(target, params, duplicates, identity) : '';
  const [status, setStatus] = useState<ScanStatus>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;

  const run = useCallback(async (signalFrom?: AbortController) => {
    if (!target) return;
    if (target.end - target.start > MAX_SCAN_SPAN) {
      setStatus({ kind: 'too-wide', message: `Zoom in to ${MAX_SCAN_SPAN / 1000} kb or less to find SNPs (the view is ${Math.round((target.end - target.start) / 1000).toLocaleString()} kb).` });
      return;
    }
    controller.current?.abort();
    const ctrl = signalFrom ?? new AbortController();
    controller.current = ctrl;
    const runKey = key;
    const store = useVariantsStore.getState();
    store.setScanning(target.datasetId, true);
    setStatus({ kind: 'scanning' });
    try {
      const response = await scanSnps(target, params, duplicates, ctrl.signal);
      const scan = { ...response, target, clientKey: runKey };
      // Another view, dataset or setting since: this result is not the panel's any more.
      if (ctrl.signal.aborted || currentKey.current !== runKey) return;
      scanned.set(key, scan.scan_key);
      useVariantsStore.getState().putScan(scan);
      updateVariantsState({ scan: trimScan(scan) });
      setStatus({ kind: 'done', scan });
    } catch (err) {
      if (isAbort(err) || ctrl.signal.aborted) return;
      setStatus({ kind: 'error', message: String((err as Error)?.message ?? err).replace(/^API error \d+: /, '') });
    } finally {
      if (controller.current === ctrl) {
        controller.current = null;
        useVariantsStore.getState().setScanning(target.datasetId, false);
      }
    }
  }, [target, params, duplicates, key]);

  // A view scanned before: its result at once.
  useEffect(() => {
    const done = scanned.get(key);
    const scan = done ? useVariantsStore.getState().scans[done] : undefined;
    if (scan) {
      useVariantsStore.getState().putScan(scan);
      setStatus({ kind: 'done', scan });
    }
  }, [key]);

  useEffect(() => {
    if (!active || !autoScan || !target) return;
    const done = scanned.get(key);
    if (done && useVariantsStore.getState().scans[done]) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => { void run(ctrl); }, SCAN_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [active, autoScan, key, run, target]);

  // A new view, dataset or setting cancels the scan running (a manual one too, with Auto off).
  useEffect(() => () => controller.current?.abort(), [key]);

  const scanNow = useCallback(() => { void run(); }, [run]);
  const cancel = useCallback(() => {
    controller.current?.abort();
    setStatus({ kind: 'idle' });
  }, []);
  /** "Clear": no result shown, nothing of this dataset's scans reused (Auto scans the view afresh). */
  const reset = useCallback(() => {
    controller.current?.abort();
    for (const k of [...scanned.keys()]) if ((JSON.parse(k) as unknown[])[0] === datasetId) scanned.delete(k);
    useVariantsStore.setState(s => ({
      latest: Object.fromEntries(Object.entries(s.latest).filter(([ds]) => ds !== datasetId && !ds.startsWith(`${datasetId}|`))),
      scans: Object.fromEntries(Object.entries(s.scans).filter(([, scan]) => scan.dataset_id !== datasetId)),
    }));
    setStatus({ kind: 'idle' });
  }, [datasetId]);
  return { target, status, scanNow, cancel, reset, duplicates, scanKey: key };
}
