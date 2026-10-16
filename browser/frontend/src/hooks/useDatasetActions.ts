import { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline, serializeDataset } from '../stores/historySlice';
import { closedDatasetReference } from '../stores/panelGenomeStore';
import { addDataset, addDatasetsGrouped, removeDataset } from '../api/datasets';
import { pickFile, pickDataset, pickFilesToOpen } from '../api/files';
import { loadGtf, removeGtf } from '../api/reference';
import { getStatus } from '../api/status';
import { getTracks } from '../api/tracks';
import {
  getOverlays,
  addOverlay,
  removeOverlay,
  pickOverlayFile,
  type ModificationOverlay,
} from '../api/overlays';
import { getS3Status, configureS3, testS3Access, type S3Status } from '../api/s3';
import { fetchApiResponse } from '../api/sharedFetch';
import { registerTrack, removeBackendTrack } from '../utils/trackLoader';
import { isPublicMode } from '../utils/publicMode';
import { formatFileLoadError, messageFromError } from '../utils/fileLoadErrors';
import { formatOpenErrors, openLocalPaths } from '../utils/openFiles';

interface TrackInfo {
  index: number;
  label: string;
  path: string;
}

export function useDatasetActions() {
  const {
    datasets,
    addToStore,
    removeFromStore,
    setDatasets,
    footprintGroups,
    setFootprintGroups,
    modificationOverlays,
    addModificationOverlay,
    removeModificationOverlay,
    setHasFasta,
    setFastaPath,
    setCurrentGenome,
    setGlobalError,
    globalError,
  } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    addToStore: s.addDataset,
    removeFromStore: s.removeDataset,
    setDatasets: s.setDatasets,
    footprintGroups: s.footprintGroups,
    setFootprintGroups: s.setFootprintGroups,
    modificationOverlays: s.modificationOverlays,
    addModificationOverlay: s.addModificationOverlay,
    removeModificationOverlay: s.removeModificationOverlay,
    setHasFasta: s.setHasFasta,
    setFastaPath: s.setFastaPath,
    setCurrentGenome: s.setCurrentGenome,
    setGlobalError: s.setError,
    globalError: s.error,
  })));

  const [loading, setLoading] = useState(false);
  // File-action errors live in the single app-wide error channel so they show
  // once (the top-of-browser banner) instead of in two places that dismiss
  // independently. The sidebar reads the same value.
  const error = globalError ?? '';
  const [status, setStatus] = useState<{ has_gtf: boolean; gene_count: number; track_count: number; overlays?: number; fasta_error?: string | null } | null>(null);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  // S3 support
  const [showS3Input, setShowS3Input] = useState(false);
  const [s3Url, setS3Url] = useState('');
  const [s3Profile, setS3Profile] = useState('');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Status, setS3Status] = useState<S3Status | null>(null);
  const [s3Testing, setS3Testing] = useState(false);
  // The form opens on the current S3 settings (e.g. a catalog's endpoint), so a
  // blank field means "none" rather than "keep whatever is set".
  useEffect(() => {
    if (!showS3Input || !s3Status?.configured) return;
    setS3Profile(prev => prev || (s3Status.profile ?? ''));
    setS3Endpoint(prev => prev || (s3Status.endpoint_url ?? ''));
  }, [showS3Input, s3Status]);
  // Multi-file load mode: 'combined' = one dataset, 'separate' = each file as its own dataset
  const [loadMode, setLoadMode] = useState<'combined' | 'separate'>('separate');

  const setActionError = useCallback((message: string) => {
    setGlobalError(message ? formatFileLoadError(message) : null);
  }, [setGlobalError]);

  // Fetch status and tracks on mount / when datasets change
  useEffect(() => {
    getStatus(false).then(setStatus).catch(() => {});
    getTracks().then(res => setTracks(res.tracks)).catch(() => {});
    getOverlays().then(res => {
      res.overlays.forEach(o => {
        if (!modificationOverlays.find(m => m.id === o.id)) {
          addModificationOverlay(o);
        }
      });
    }).catch(() => {});
    if (!isPublicMode()) getS3Status().then(setS3Status).catch(() => {});
  }, [datasets.length]);

  // Re-fetch local tracks/status when refreshGeneration changes (e.g. after a genome loads)
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  useEffect(() => {
    if (refreshGeneration === 0) return; // skip initial mount
    getStatus(false).then(setStatus).catch(() => {});
    getTracks().then(res => setTracks(res.tracks)).catch(() => {});
  }, [refreshGeneration]);

  const refreshData = useCallback(() => {
    getStatus(false).then(setStatus).catch(() => {});
    getTracks().then(res => setTracks(res.tracks)).catch(() => {});
    // triggerRefresh bumps refreshGeneration, which triggers Browser.tsx's useEffect
    // to re-fetch chroms (with chrom-existence check) and status. No need to duplicate
    // the getChromosomes() call here — doing so creates a race condition that can
    // cause a spurious viewport reset when adding datasets.
    useBrowserStore.getState().triggerRefresh();
  }, []);

  const handleAddBam = useCallback(async () => {
    setActionError('');
    setLoading(true);
    try {
      const pickerResult = await pickDataset();
      if (pickerResult.success) {
        const paths = pickerResult.paths && pickerResult.paths.length > 0
          ? pickerResult.paths
          : (pickerResult.path ? [pickerResult.path] : []);
        if (paths.length === 0) return;

        if (loadMode === 'separate' && paths.length > 1) {
          // Load as separate datasets, but pair BigBed layer companions (same
          // sample, e.g. *_footprint.bb + *_tf.bb + *_msp.bb) into one layered
          // dataset rather than one dataset per file. Unrelated files / BAMs
          // each still load separately.
          const groupResult = await addDatasetsGrouped(paths);
          if (groupResult.success && groupResult.datasets) {
            for (const dataset of groupResult.datasets) addToStore(dataset);
            if (groupResult.errors && groupResult.errors.length > 0) {
              setActionError(`Failed to load: ${groupResult.errors.join(', ')}`);
            }
          } else {
            setActionError(groupResult.error || 'Failed to load dataset file(s)');
          }
          refreshData();
        } else {
          // Load all files as one combined dataset
          const loadResult = await addDataset(paths.length === 1 ? paths[0] : paths);
          if (loadResult.success && loadResult.dataset) {
            addToStore(loadResult.dataset);
            refreshData();
          } else {
            setActionError(loadResult.error || 'Failed to load dataset file(s)');
          }
        }
      } else if (pickerResult.message && !pickerResult.message.includes('No file selected')) {
        setActionError(pickerResult.message);
      }
    } catch (err) {
      console.error('Dataset load error:', err);
      setActionError(messageFromError(err, 'Failed to load dataset file'));
    } finally {
      setLoading(false);
    }
  }, [addToStore, refreshData, loadMode, setActionError]);

  const handleLoadGtf = useCallback(async () => {
    setActionError('');
    setLoading(true);
    try {
      const pickerResult = await pickFile('gtf');
      if (pickerResult.success && pickerResult.path) {
        const loadResult = await loadGtf(pickerResult.path);
        if (loadResult.success) {
          refreshData();
        } else {
          setActionError(loadResult.message || 'Failed to load GTF');
        }
      }
    } catch (err) {
      console.error('GTF error:', err);
      setActionError(messageFromError(err, 'Failed to load GTF file'));
    } finally {
      setLoading(false);
    }
  }, [refreshData, setActionError]);

  const handleAddTrack = useCallback(async () => {
    setActionError('');
    setLoading(true);
    try {
      const pickerResult = await pickFile('bigwig');
      if (pickerResult.success && pickerResult.path) {
        const loadResult = await registerTrack({ pathOrUrl: pickerResult.path, source: 'local' });
        if (loadResult.success) {
          refreshData();
        } else {
          setActionError(loadResult.message || 'Failed to add track');
        }
      }
    } catch (err) {
      console.error('Track error:', err);
      setActionError(messageFromError(err, 'Failed to add track'));
    } finally {
      setLoading(false);
    }
  }, [refreshData, setActionError]);

  const handleAddOverlay = useCallback(async () => {
    setActionError('');
    setLoading(true);
    try {
      const pickerResult = await pickOverlayFile();
      if (pickerResult.success && pickerResult.path) {
        const loadResult = await addOverlay(pickerResult.path);
        if (loadResult.success && loadResult.overlay) {
          addModificationOverlay(loadResult.overlay);
          refreshData();
        } else {
          setActionError(loadResult.error || 'Failed to load overlay');
        }
      }
    } catch (err) {
      console.error('Overlay error:', err);
      setActionError(messageFromError(err, 'Failed to load overlay'));
    } finally {
      setLoading(false);
    }
  }, [addModificationOverlay, refreshData, setActionError]);

  const handleRemoveOverlay = useCallback(async (overlayId: string) => {
    try {
      await removeOverlay(overlayId);
      removeModificationOverlay(overlayId);
      refreshData();
    } catch (err) {
      console.error('Remove overlay error:', err);
    }
  }, [removeModificationOverlay, refreshData]);

  const handleLoadS3 = useCallback(async () => {
    const url = s3Url.trim();
    if (!url) return;
    setActionError('');
    setLoading(true);
    setS3Testing(true);
    try {
      // Branch on URL scheme. HTTPS / HTTP remote BAMs (any web server or
      // object store's public/pre-signed URL) don't need boto3 or S3
      // credentials — htslib fetches them directly via byte-range requests,
      // and validate_remote_bam runs server-side as part of addDataset to
      // probe the .bai/.csi sidecar.
      const isHttps = /^https?:\/\//i.test(url);
      const isS3    = /^s3:\/\//i.test(url);
      if (!isHttps && !isS3) {
        setActionError('URL must start with s3://, http://, or https://');
        return;
      }

      if (isS3) {
        // S3 path keeps the existing configure + test flow so users with
        // narrow IAM profiles get an early, specific error.
        // A profile or an endpoint (Cloudflare R2, Backblaze B2, MinIO, an
        // institutional store) applies to every s3:// file from now on. The
        // fields start from the current settings, so changing them (clearing
        // both included: AWS with the default credentials) reconfigures.
        const wantProfile = s3Profile.trim();
        const wantEndpoint = s3Endpoint.trim();
        const changed = wantProfile !== (s3Status?.profile ?? '') || wantEndpoint !== (s3Status?.endpoint_url ?? '');
        if (changed && (wantProfile || wantEndpoint || s3Status?.configured)) {
          const configResult = await configureS3(wantProfile || undefined, undefined, wantEndpoint || undefined);
          if (!configResult.success) {
            setActionError(`S3 config failed: ${configResult.error || 'Unknown error'}`);
            return;
          }
          getS3Status().then(setS3Status).catch(() => {});
        }
        // <bam>##idx##<index>: the BAM is the object to test (the backend checks both).
        const testResult = await testS3Access(url.split('##idx##')[0]);
        if (!testResult.accessible) {
          setActionError(`Cannot access S3 URL: ${testResult.error || 'Unknown error'}`);
          return;
        }
      }

      // For both schemes: addDataset hits /api/datasets/add, which runs
      // validate_remote_bam on the backend (HEAD probe + Accept-Ranges
      // check + .bai sidecar probe).
      const loadResult = await addDataset(url);
      if (loadResult.success && loadResult.dataset) {
        addToStore(loadResult.dataset);
        setS3Url('');
        setShowS3Input(false);
        refreshData();
      } else {
        setActionError(loadResult.error || 'Failed to load remote dataset');
      }
    } catch (err) {
      console.error('Remote load error:', err);
      setActionError(messageFromError(err, 'Failed to load remote dataset'));
    } finally {
      setLoading(false);
      setS3Testing(false);
    }
  }, [s3Url, s3Profile, s3Endpoint, s3Status, addToStore, refreshData, setActionError]);

  const handleDropWindow = useCallback(async () => {
    try {
      await fetchApiResponse('/api/datasets/drop_window', { method: 'POST' });
    } catch (err) {
      console.error('Failed to open drop window:', err);
    }
  }, []);

  const handleRemoveTrack = useCallback(async (trackIdx: number) => {
    try {
      await removeBackendTrack(trackIdx);
      refreshData();
    } catch (err) {
      console.error('Remove track error:', err);
    }
  }, [refreshData]);

  const handleRemoveGtf = useCallback(async () => {
    try {
      await removeGtf();
      refreshData();
    } catch (err) {
      console.error('Remove GTF error:', err);
    }
  }, [refreshData]);

  // Closing a dataset is a history step: Undo opens it again from its files (see utils/datasetUndo).
  // A close that fails keeps the dataset open and says why (the red banner).
  const handleRemove = useCallback(async (datasetId: string) => {
    const before = useBrowserStore.getState();
    const dataset = before.datasets.find(d => d.id === datasetId);
    const label = dataset?.label ?? datasetId;
    try {
      if (dataset) seedHistoryBaseline(before, `Before closing ${label}`, 'layout');
      // Its own reference, if it has one: the server closes it with the dataset; Undo gives it back.
      const reference = closedDatasetReference(datasetId);
      const res = await removeDataset(datasetId);
      if (res.success) {
        removeFromStore(datasetId);
        if (dataset) {
          useBrowserStore.getState().pushSnapshot(`Close ${label}`, {
            kind: 'layout',
            coalesceKey: `close-dataset:${datasetId}:${Date.now()}`,
            closedDatasets: [{ ...serializeDataset(dataset), ...(reference ? { reference } : {}) }],
          });
        }
      } else {
        useBrowserStore.getState().setError(`Could not close ${label}: ${res.error || 'the server did not close it'}. It is still open; try again.`);
      }
    } catch (err) {
      console.error('Failed to remove dataset:', err);
      useBrowserStore.getState().setError(`Could not close ${label}: ${messageFromError(err, 'the request failed')}. It is still open; try again.`);
    }
  }, [removeFromStore]);

  const handleAdd = useCallback(async (newPath: string, newLabel?: string) => {
    if (!newPath.trim()) return;
    setActionError('');
    setLoading(true);
    try {
      const res = await addDataset(newPath.trim(), newLabel?.trim() || undefined);
      if (res.success && res.dataset) {
        addToStore(res.dataset);
      } else {
        setActionError(res.error || 'Failed to add dataset');
      }
    } catch (err) {
      setActionError(messageFromError(err, 'Failed to add dataset'));
    } finally {
      setLoading(false);
    }
  }, [addToStore, setActionError]);

  const handleLoadFile = useCallback(async () => {
    setActionError('');
    setLoading(true);
    try {
      const result = await pickFilesToOpen();
      if (!result.success) {
        // A real cancel is quiet; a dialog that could not open says so.
        if (!result.cancelled && result.message) setActionError(result.message);
        return;
      }
      const paths = result.paths?.length ? result.paths : (result.path ? [result.path] : []);
      // One route for every way of opening files (utils/openFiles): indexes
      // chosen with their BAM are used, each file opens on its own, and every
      // file that can't be opened is named in one message.
      const report = await openLocalPaths(paths);
      const message = formatOpenErrors(report.errors, paths.length - report.indexes.length);
      if (message) setActionError(message);
      refreshData();
    } catch (err) {
      setActionError(messageFromError(err, 'Failed to load file'));
    } finally {
      setLoading(false);
    }
  }, [refreshData, setActionError]);

  return {
    // State
    loading, error, setError: setActionError,
    status, tracks,
    // S3
    showS3Input, setShowS3Input,
    s3Url, setS3Url,
    s3Profile, setS3Profile,
    s3Endpoint, setS3Endpoint,
    s3Status, s3Testing,
    // Handlers
    handleAddBam, handleLoadGtf, handleAddTrack, handleAddOverlay,
    handleRemoveOverlay, handleLoadS3, handleDropWindow,
    handleRemoveTrack, handleRemoveGtf, handleRemove, handleAdd,
    handleLoadFile,
    // Multi-file load mode
    loadMode, setLoadMode,
    refreshData,
  };
}
