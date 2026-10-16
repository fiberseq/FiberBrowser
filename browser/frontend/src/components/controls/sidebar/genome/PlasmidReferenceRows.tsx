import { useState } from 'react';
import { pickAnyFile } from '../../../../api/files';
import { useBrowserStore } from '../../../../stores/browserStore';
import { formatBp } from '../../../../utils/coordinates';
import { isPlasmidChrom, isPlasmidMapPath, loadPlasmidFiles, pickAndOpenPlasmidDataset, showContig, PLASMID_MAP_EXTS } from '../../../../utils/plasmidLoader';
import { X } from '../../../ui/Icons';

const LINK = 'px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10 rounded';

/** Plasmid maps next to the FASTA/GTF rows: add one, and open any loaded one here or beside the current view. */
export function PlasmidReferenceRows() {
  const chroms = useBrowserStore(s => s.chroms);
  const plasmids = chroms.filter(isPlasmidChrom);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const openWithReads = async () => {
    setMessage(null);
    setBusy(true);
    try {
      await pickAndOpenPlasmidDataset(setStatus);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setMessage(null);
    const picked = await pickAnyFile();
    if (!picked.success) return;
    const paths = picked.paths?.length ? picked.paths : (picked.path ? [picked.path] : []);
    const maps = paths.filter(isPlasmidMapPath);
    if (maps.length === 0) {
      if (paths.length > 0) setMessage(`Choose a plasmid map (${PLASMID_MAP_EXTS.map(e => `.${e}`).slice(0, 5).join(', ')}, …)`);
      return;
    }
    setBusy(true);
    try {
      const result = await loadPlasmidFiles(maps);
      if (!result.success) setMessage(result.error || 'Failed to load plasmid map');
      else if (result.failed > 0) setMessage(`${result.failed} could not be loaded: ${result.error}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-0.5" data-testid="plasmid-reference-rows">
      <div className="flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${plasmids.length > 0 ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
        <button
          onClick={add}
          disabled={busy}
          className="flex-1 text-left text-[12px] text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-50"
          title="Load a plasmid map (GenBank, SnapGene .dna, EMBL, SBOL) as its own contig. Its reads come from a BAM aligned to it."
        >
          {busy ? 'Loading plasmid map...' : plasmids.length > 0 ? `Plasmid maps (${plasmids.length})` : 'Load Plasmid Map...'}
        </button>
        {plasmids.length > 0 && (
          <button onClick={add} disabled={busy} className={LINK} title="Load another plasmid map">Add</button>
        )}
        <button
          onClick={() => { void openWithReads(); }}
          disabled={busy}
          className={LINK}
          title="Open a plasmid map with the BAM file(s) aligned to it: the BAM's contig is matched to the map by sequence, whatever its name or origin"
          data-testid="plasmid-open-dataset"
        >
          With reads…
        </button>
      </div>
      {status && <div className="pl-2.5 text-[11px] text-gray-500 dark:text-gray-400">{status}</div>}
      {plasmids.map(p => (
        <div key={p.name} className="flex items-center gap-1 pl-2.5">
          <span className="flex-1 truncate font-mono text-[11px] text-gray-700 dark:text-gray-300" title={p.name}>
            {p.name} <span className="font-sans text-gray-400">{formatBp(p.size)}</span>
          </span>
          <button onClick={() => { void showContig(p.name, p.size, 'main'); }} className={LINK} title="Show this plasmid in the main view">View</button>
          <button onClick={() => { void showContig(p.name, p.size, 'beside'); }} className={LINK} title="Open it beside the current view: copies of the dataset panels with reads on it (else of the selected or first panel)">Beside</button>
        </div>
      ))}
      {message && (
        <div className="text-[11px] text-red-600 dark:text-red-400">
          {message}
          <button onClick={() => setMessage(null)} className="ml-1 inline-flex align-[-2px] text-gray-500 hover:text-gray-700" aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
    </div>
  );
}
