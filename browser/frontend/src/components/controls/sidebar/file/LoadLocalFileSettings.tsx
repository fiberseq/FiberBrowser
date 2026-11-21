import { useEffect, useState } from 'react';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { formatOpenErrors, openLocalPaths } from '../../../../utils/openFiles';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';
import { SidebarSettingToggle } from '../shared/SidebarSetting';
import { useGraphStatusStore } from '../../../../features/graphPanel/statusStore';
import { useGraphSettings } from '../../../../features/graphPanel/handoff';
import { nativeGraphOffered } from '../../../../features/graphPanel/openAsGraph';

export const LOAD_PATH_SETTINGS = defineSettings({
  path: {
    id: 'file.load-by-path',
    label: 'Load by path',
    keywords: ['server path', 'open file', 'paste path', 'bam', 'bigbed', 'fasta'],
    location: inSidebar('file.loadpath'),
    hiddenReason: () => (useBrowserStore.getState().publicMode ? 'not on a public server' : null),
  },
  graph: {
    id: 'file.load-by-path-graph',
    label: 'Open in graph mode',
    keywords: ['graph mode', 'pangenome', 'graph package', 'view as graph', 'open as graph'],
    location: inSidebar('file.loadpath'),
    hiddenReason: () => (useBrowserStore.getState().publicMode ? 'not on a public server'
      : nativeGraphOffered() ? null : 'no registered graph package on this genome'),
  },
});

interface LoadLocalFileSettingsProps {
  setError: (message: string) => void;
}

export function LoadLocalFileSettings({ setError }: LoadLocalFileSettingsProps) {
  const [pathInput, setPathInput] = useState('');
  const [pathLoading, setPathLoading] = useState(false);
  const publicMode = useBrowserStore(s => s.publicMode);
  // "Open in graph mode" (D3: off unless the Graph mode setting says otherwise), offered while a registered graph
  // package's target is on this genome.
  const nativeDefault = useGraphSettings(s => s.nativeOpenView === 'graph');
  const [asGraph, setAsGraph] = useState<boolean | null>(null);
  useGraphStatusStore(s => s.status);
  useBrowserStore(s => s.currentGenome);
  useEffect(() => { if (!publicMode) void useGraphStatusStore.getState().load(); }, [publicMode]);
  const graphOffered = !publicMode && nativeGraphOffered();

  if (publicMode) {
    return null;
  }

  const handleLoadByPath = async (text: string = pathInput) => {
    // One path, or several pasted one per line (a BAM and its index, a sample's files...).
    const paths = text.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    if (paths.length === 0) return;
    setPathLoading(true);
    setError('');
    try {
      // The same route as Load File and drag-and-drop (utils/openFiles).
      const report = await openLocalPaths(paths, graphOffered ? { openAsGraph: asGraph ?? nativeDefault } : {});
      if (report.opened.length > 0) {
        useBrowserStore.getState().triggerRefresh();
        if (report.errors.length === 0) setPathInput('');
      }
      const message = formatOpenErrors(report.errors, paths.length - report.indexes.length);
      if (message) setError(message);
    } catch (error: any) {
      setError(error.message || 'Failed to load file');
    } finally {
      setPathLoading(false);
    }
  };

  return (
    <SidebarSubSection
      id="file.loadpath"
      label="Load by path"
      helpText="Paste a path on the server to load BAM, BigBed, GTF, FASTA, BigWig, BED, .cool data, or a plasmid map (.gb, .dna, .embl); paste several paths, one per line, to open them together. Open in the top bar opens a file browser; the arrow beside it brings you here too."
      persist
    >
      <div className="flex gap-1" {...settingAnchor(LOAD_PATH_SETTINGS.path)}>
        <input
          type="text"
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleLoadByPath(); }}
          onPaste={e => {
            // A text box keeps one line: several pasted paths open together.
            const text = e.clipboardData.getData('text');
            if (text.split(/\r?\n/).filter(line => line.trim()).length < 2) return;
            e.preventDefault();
            void handleLoadByPath(text);
          }}
          data-testid="load-by-path-input"
          placeholder="/path/to/file.bam or Z:\\path\\file.bam"
          className="text-[12px] px-1.5 py-1 border rounded flex-1 dark:bg-dark-bg dark:border-gray-600 dark:text-gray-300 min-w-0"
        />
        <button
          onClick={() => void handleLoadByPath()}
          disabled={pathLoading || !pathInput.trim()}
          className="px-2 py-1 bg-blue-500 text-white rounded text-[11px] hover:bg-blue-600 disabled:opacity-40 flex-shrink-0"
        >
          {pathLoading ? '...' : 'Load'}
        </button>
      </div>
      {graphOffered && (
        <div className="mt-1" data-testid="load-by-path-graph">
          <SidebarSettingToggle
            setting={LOAD_PATH_SETTINGS.graph}
            checked={asGraph ?? nativeDefault}
            onChange={setAsGraph}
            helpText="A BAM on this genome opens as a graph host when a registered graph package binds its contig (its reads on the reference path). Otherwise it opens linear. You can switch any time with the panel's Linear / Graph toggle."
          />
        </div>
      )}
    </SidebarSubSection>
  );
}
