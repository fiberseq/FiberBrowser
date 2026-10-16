import { looksLikeSession, requestSessionRestore } from '../utils/sessionRestore';
import { useCallback, useState, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { uploadFile } from '../api/files';
import { isPublicHostPage } from '../utils/publicServerFlag';
import { formatOpenErrors, openLocalPaths } from '../utils/openFiles';
import { planSelection } from '../utils/supportedFiles';
import { awaitNativeDropPaths, nativeDropAvailable } from '../utils/nativeDrop';
import { formatFileLoadError, messageFromError } from '../utils/fileLoadErrors';

/**
 * Handles file drag-and-drop onto the browser: every type Load File opens
 * (utils/openFiles), through the same route, with the same messages.
 */
export function useDragAndDrop() {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    // No stopPropagation: the desktop app listens on the document for the
    // dropped files' real paths (utils/nativeDrop).
    setDragOver(false);
    dragCounterRef.current = 0;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (isPublicHostPage()) {
      // A public server takes no files from its visitors.
      useBrowserStore.getState().setError('This public server shows its own datasets; files can\'t be added here.');
      return;
    }

    const store = useBrowserStore.getState();
    store.setLoading(true);
    store.setError(null);
    const errors: string[] = [];
    try {
      // The desktop app sends the dropped files' real paths: open those where
      // they are. In a web browser (or for a file without a path) the file is
      // uploaded and its server copy opened.
      const nativePaths = nativeDropAvailable()
        ? await awaitNativeDropPaths(files.map(f => f.name))
        : new Map<number, string>();

      // Indexes dropped with their BAM are used as they are (an upload keeps
      // none: each stored BAM is indexed from its own bytes); an index alone,
      // or a format FiberBrowser can't open, is reported and not uploaded.
      const plan = planSelection(files.map(f => f.name), { byName: true });
      errors.push(...plan.errors);
      const wanted = new Set(plan.open);

      const paths: string[] = [];
      for (const [position, file] of files.entries()) {
        if (!wanted.has(file.name)) continue;
        const native = nativePaths.get(position);
        if (native) { paths.push(native); continue; }
        const lowerName = file.name.toLowerCase();
        if (lowerName.endsWith('.json') && !lowerName.includes('.fiberlayer')) {
          // A saved session: restore it (relinking files if needed).
          let parsed: unknown = null;
          try { parsed = JSON.parse(await file.text()); } catch { /* reported below */ }
          if (looksLikeSession(parsed)) await requestSessionRestore(parsed);
          else errors.push(`${file.name}: not a FiberBrowser session file`);
          continue;
        }
        try {
          const result = await uploadFile(file);
          if (result.success && result.path) paths.push(result.path);
          else if (!(result as { is_index?: boolean }).is_index) {
            errors.push(`${file.name}: the upload failed${(result as { error?: string }).error ? ` (${(result as { error?: string }).error})` : ''}`);
          }
        } catch (err) {
          errors.push(`${file.name}: the upload failed (${messageFromError(err, 'request failed')})`);
        }
      }

      if (paths.length > 0) {
        // A plasmid dropped with its reads opens in the main view; on its own it
        // opens beside the current view (see showContig).
        const withReads = files.some(f => /\.(bam|bb|bigbed)$/i.test(f.name));
        const report = await openLocalPaths(paths, { plasmidPlacement: withReads ? 'main' : 'auto' });
        errors.push(...report.errors);
        if (report.opened.length > 0) useBrowserStore.getState().triggerRefresh();
      }
    } catch (err) {
      errors.push(messageFromError(err, 'Failed to load dropped file(s)'));
    } finally {
      const message = formatOpenErrors(errors, files.length);
      if (message) useBrowserStore.getState().setError(formatFileLoadError(message));
      useBrowserStore.getState().setLoading(false);
    }
  }, []);

  return { dragOver, handleDragEnter, handleDragLeave, handleDragOver, handleDrop };
}
