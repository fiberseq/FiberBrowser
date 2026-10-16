import { useState } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { addAnnotationFile, getAnnotationFiles, browseAnnotationFiles, pickAnnotationFile, type BrowseAnnotationEntry } from '../../../api/annotations';
import { pickFolder } from '../../../api/files';
import { AnalysisButton, AnalysisStatus } from '../shared';

export function FilesTab() {
  const {
    annotationFiles,
    setAnnotationFiles,
    activateAnnotationFile,
    deactivateAnnotationFile,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    setAnnotationFiles: s.setAnnotationFiles,
    activateAnnotationFile: s.activateAnnotationFile,
    deactivateAnnotationFile: s.deactivateAnnotationFile,
  })));

  const [loadPath, setLoadPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [browseResults, setBrowseResults] = useState<BrowseAnnotationEntry[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState('');

  const handleLoad = async (path?: string) => {
    const target = (path || loadPath).trim();
    if (!target) return;
    setLoading(true);
    setLoadError('');
    try {
      const addResult = await addAnnotationFile(target);
      // Auto-activate the newly added file
      if (addResult.file?.id) {
        await activateAnnotationFile(addResult.file.id);
      }
      const result = await getAnnotationFiles();
      setAnnotationFiles(result.files);
      setLoadPath('');
      setBrowseResults(null);
    } catch (err: any) {
      const msg = err?.message || String(err);
      setLoadError(msg.includes('400') ? 'File not found or not a .bb/.bigBed file' :
                   msg.includes('404') ? 'Endpoint not available — restart the server' : `Error: ${msg}`);
      console.error('Failed to add annotation file:', err);
    }
    setLoading(false);
  };

  const [toggleError, setToggleError] = useState('');

  const handleToggle = async (fileId: string, active: boolean) => {
    setToggleError('');
    try {
      if (active) {
        await deactivateAnnotationFile(fileId);
      } else {
        await activateAnnotationFile(fileId);
      }
      // Refresh file list to get updated state
      const result = await getAnnotationFiles();
      setAnnotationFiles(result.files);
    } catch (err: any) {
      setToggleError(`Toggle failed: ${err?.message || err}`);
    }
  };

  const alreadyLoadedPaths = new Set(annotationFiles.map(f => f.path));

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        Annotation BigBed files (BED6+2 format) discovered alongside your datasets.
      </div>

      {toggleError && (
        <AnalysisStatus kind="error" compact>
          {toggleError}
        </AnalysisStatus>
      )}

      {annotationFiles.length === 0 ? (
        <AnalysisStatus kind="empty" compact title="No annotation files discovered">
          Load an annotation BigBed or browse a folder.
        </AnalysisStatus>
      ) : (
        <div className="space-y-1">
          {annotationFiles.map(f => (
            <div key={f.id} className="flex items-center gap-2 p-1.5 rounded border border-gray-200 dark:border-white/10">
              <button
                onClick={() => handleToggle(f.id, f.active)}
                className={`w-8 h-4 rounded-full relative transition-colors flex-shrink-0 ${
                  f.active ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                  f.active ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate" title={f.path}>{f.label}</div>
                <div className="text-[11px] text-gray-400">
                  {(f.annotationTypes ?? []).length} types
                  {(f.datasetIds ?? []).length > 0 && ` · ${f.datasetIds.length} datasets`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Native file/folder picker buttons */}
      <div className="border-t border-gray-200 dark:border-white/10 pt-2">
        <div className="flex gap-1.5">
          <AnalysisButton
            onClick={async () => {
              setLoading(true);
              setLoadError('');
              setBrowseResults(null);
              try {
                const result = await pickAnnotationFile();
                if (result.success && result.path) {
                  await handleLoad(result.path);
                }
              } catch (err: any) {
                setLoadError(err?.message || String(err));
              }
              setLoading(false);
            }}
            disabled={loading}
            theme="violet"
            variant="primary"
            size="sm"
            className="flex-1"
            data-tour="annotations-load-file"
          >
            {loading ? 'Loading...' : 'Load File...'}
          </AnalysisButton>
          <AnalysisButton
            onClick={async () => {
              setBrowsing(true);
              setBrowseError('');
              setLoadError('');
              try {
                const result = await pickFolder();
                if (result.success && result.path) {
                  const browse = await browseAnnotationFiles(result.path);
                  setBrowseResults(browse.files);
                  if (browse.files.length === 0) setBrowseError('No .bb/.bigBed files found in this folder');
                }
              } catch (err: any) {
                setBrowseError(err?.message || String(err));
              }
              setBrowsing(false);
            }}
            disabled={browsing}
            theme="violet"
            variant="soft"
            size="sm"
            className="flex-1"
          >
            {browsing ? 'Browsing...' : 'Browse Folder...'}
          </AnalysisButton>
        </div>
        {loadError && (
          <AnalysisStatus kind="error" compact className="mt-1">
            {loadError}
          </AnalysisStatus>
        )}
        {browseError && (
          <AnalysisStatus kind="error" compact className="mt-1">
            {browseError}
          </AnalysisStatus>
        )}
        {browseResults && browseResults.length > 0 && (
          <div className="mt-1.5 max-h-40 overflow-y-auto space-y-0.5">
            {browseResults.map(entry => {
              const already = alreadyLoadedPaths.has(entry.path);
              return (
                <div key={entry.path} className="flex items-center gap-1.5 p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" title={entry.path}>{entry.name}</div>
                    <div className="text-[11px] text-gray-400">{(entry.size / 1024 / 1024).toFixed(1)} MB</div>
                  </div>
                  {already ? (
                    <span className="text-[11px] text-gray-400 flex-shrink-0">loaded</span>
                  ) : (
                    <AnalysisButton
                      onClick={() => handleLoad(entry.path)}
                      disabled={loading}
                      theme="violet"
                      variant="primary"
                      className="flex-shrink-0"
                    >
                      Add
                    </AnalysisButton>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Direct path input (fallback) */}
      <div className="border-t border-gray-200 dark:border-white/10 pt-2">
        <div className="text-[11px] text-gray-500 mb-1">Or load by path:</div>
        <div className="flex gap-1">
          <input
            type="text"
            value={loadPath}
            onChange={e => { setLoadPath(e.target.value); setLoadError(''); }}
            placeholder="/path/to/annotations.bb"
            className="flex-1 text-xs px-2 py-1 rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-gray-800"
            onKeyDown={e => e.key === 'Enter' && handleLoad()}
          />
          <AnalysisButton
            onClick={() => handleLoad()}
            disabled={loading || !loadPath.trim()}
            theme="violet"
            variant="primary"
            size="sm"
          >
            {loading ? '...' : 'Load'}
          </AnalysisButton>
        </div>
      </div>
    </div>
  );
}
