import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { flushRegionCatalogSavesOnUnload, setRegionCatalogPersistence, useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { detectRegions } from '../../../api/regions';
import { beginRegionScan, fileRegionScan, scanFromResponse } from '../../../utils/regionScan';
import { mainGenomeKey, shownGenomes, stepRegion } from '../../../utils/regionNavigation';
import { migrateLegacyRegions } from '../../../utils/regionMigration';
import { isSandboxPage } from '../../../utils/sandbox';
import { waitForViewIdle } from '../../../utils/viewIdle';

/**
 * Keeps the region catalog in step with the workspace (mounted once, renders nothing):
 * - reads the user's saved regions for every reference shown;
 * - turns old bookmarks and "Add View" regions into catalog regions (utils/regionMigration.ts);
 * - finds each open BAM dataset's regions once (a bounded server scan: amplicons,
 *   read clusters, a targeted run's loci from its index; a whole-genome dataset is
 *   skipped at once, said in its status line) and lists them as the dataset's own
 *   category; a dataset given its own reference later is
 *   looked at again there, and its amplicons leave the reference it was on
 *   (a dataset that doesn't fit a reference, a dm6 BAM under hg38, is refused
 *   there, and amplicons an earlier version filed there are removed);
 * - a reference key that names another reference now (a FASTA of the same
 *   file name from another folder) has its catalog read again;
 * - N / P step to the next / previous region of the catalog the Regions panel
 *   shows (utils/regionNavigation.stepGenome), as its ‹ › buttons do.
 */
export function RegionsHost() {
  const { datasets, chroms, currentGenome, fastaPath, bookmarks, navigatorRegions, panels, publicMode } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets, chroms: s.chroms, currentGenome: s.currentGenome, fastaPath: s.fastaPath,
    bookmarks: s.bookmarks, navigatorRegions: s.navigatorRegions, panels: s.panels, publicMode: s.publicMode,
  })));
  const assignments = usePanelGenomeStore(s => s.assignments);
  const panelGenomes = usePanelGenomeStore(s => s.genomes);
  // What each reference key stands for (a FASTA's path): a key reused for another file is read again.
  const sources = useRef(new Map<string, string>());
  // A pass ends with a scans update: the effect below runs again for datasets opened meanwhile.
  const scans = useRegionCatalogStore(s => s.scans);
  const scanned = useRef(new Map<string, string>());
  const running = useRef(false);
  const scanController = useRef<AbortController | null>(null);
  useEffect(() => () => scanController.current?.abort(), []);

  useEffect(() => {
    // A public server and a tour tab keep regions in their session only.
    setRegionCatalogPersistence(() => !useBrowserStore.getState().publicMode && !isSandboxPage());
    // A rename just before a reload or close is still saved.
    window.addEventListener('pagehide', flushRegionCatalogSavesOnUnload);
    return () => window.removeEventListener('pagehide', flushRegionCatalogSavesOnUnload);
  }, []);

  const main = mainGenomeKey({ currentGenome, fastaPath });
  useEffect(() => {
    if (!chroms.length) return;
    const regions = useRegionCatalogStore.getState();
    for (const genome of shownGenomes(useBrowserStore.getState())) {
      // Only a FASTA's file name can name two references (a registry id can't).
      const source = genome === main ? (!currentGenome ? fastaPath : null) : panelGenomes[genome]?.fasta_path;
      if (source) {
        const before = sources.current.get(genome);
        sources.current.set(genome, source);
        if (before !== undefined && before !== source) regions.forget(genome);
      }
      void useRegionCatalogStore.getState().ensureLoaded(genome);
    }
  }, [chroms.length, main, panels, publicMode, currentGenome, fastaPath, panelGenomes]);

  useEffect(() => {
    if (!chroms.length || !(currentGenome || fastaPath)) return;
    const hasLegacy = bookmarks.length > 0 || navigatorRegions.some(r => r.source === 'navigator' || r.source === 'manual');
    if (hasLegacy) void migrateLegacyRegions();
  }, [bookmarks, navigatorRegions, chroms.length, currentGenome, fastaPath]);

  // Each BAM dataset's amplicons, once per dataset and reference.
  useEffect(() => {
    const regions = useRegionCatalogStore.getState();
    const open = new Set(datasets.map(d => d.id));
    for (const id of Object.keys(regions.fingerprints)) if (!open.has(id)) regions.setFingerprint(id, null);
    for (const id of Object.keys(regions.scans)) if (!open.has(id)) regions.setScan(id, null);
    for (const id of [...scanned.current.keys()]) if (!open.has(id)) scanned.current.delete(id);
    // A public server refuses the scan (it reads a whole dataset): its visitors save regions by hand.
    if (!chroms.length || running.current || publicMode) return;
    const todo = datasets.filter(d => (d.data_type ?? 'bam') === 'bam' && scanned.current.get(d.id) !== `${assignments[d.id] ?? main}`);
    if (!todo.length) return;
    running.current = true;
    const controller = new AbortController();
    scanController.current = controller;
    void (async () => {
      try {
        for (const dataset of todo) {
          await waitForViewIdle(controller.signal);
          if (controller.signal.aborted) break;
          if (!useBrowserStore.getState().datasets.some(d => d.id === dataset.id)) continue;
          const key = `${usePanelGenomeStore.getState().assignments[dataset.id] ?? mainGenomeKey(useBrowserStore.getState())}`;
          const previous = scanned.current.get(dataset.id);
          scanned.current.set(dataset.id, key);
          const store = useRegionCatalogStore.getState();
          store.setScan(dataset.id, { state: 'running' });
          const current = beginRegionScan(dataset.id);
          try {
            const res = await detectRegions(dataset.id);
            // A scan asked for meanwhile (Regions › Scan regions, a row's buttons) is newer: it decides.
            if (!current()) continue;
            store.setFingerprint(dataset.id, res.fingerprint);
            if (res.fingerprint) {
              // Moved to its own reference: its amplicons on the one it was on go (found again here).
              if (previous && previous !== key) await store.dropDetected(previous, res.fingerprint);
              // Not on this reference at all (another assembly): amplicons filed here before go.
              if (res.refused && res.mismatch && res.genome) await store.dropDetected(res.genome, res.fingerprint);
            }
            // Amplicons, read clusters and a targeted run's regions (found from its index) are the
            // dataset's own category; a skip says why (the Regions panel's status line per dataset).
            await fileRegionScan(res, dataset, { scope: 'dataset' });
            store.setScan(dataset.id, scanFromResponse(res, { scope: 'dataset' }));
          } catch (err) {
            store.setScan(dataset.id, { state: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        }
      } finally {
        running.current = false;
        // Datasets opened meanwhile: once more (the effect depends on scans).
        useRegionCatalogStore.setState(s => ({ scans: { ...s.scans } }));
      }
    })();
  }, [datasets, chroms.length, assignments, main, scans, publicMode]);

  // N / P: next / previous region of the current category (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'n' && e.key !== 'p' && e.key !== 'N' && e.key !== 'P') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      // Nothing to step through: the key does nothing (the Regions panel says why).
      stepRegion(e.key.toLowerCase() === 'n' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return null;
}
