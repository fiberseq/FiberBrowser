import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore, panelGenomeLabel } from '../../stores/panelGenomeStore';
import { useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { pickFile } from '../../api/files';
import { loadGtf, setCircularChrom, getChromosomes } from '../../api/reference';
import { fetchJson } from '../../api/sharedFetch';
import type { AttachGenomeRequest, PanelGenomeInfo } from '../../api/panelGenomes';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { mainReferenceLabel } from '../../utils/figureRegions';
import { formatCoordinates } from '../../utils/coordinates';
import { AnalysisButton, CheckboxRow } from './shared';
import { openLibrary } from './library/libraryStore';
import { X } from '../ui/Icons';

function source(info: PanelGenomeInfo): Omit<AttachGenomeRequest, 'dataset_ids'> | null {
  if (info.kind === 'registry' && info.genome_id) return { genome_id: info.genome_id };
  if (info.fasta_path) return { fasta_path: info.fasta_path, ...(info.gtf_path ? { gtf_path: info.gtf_path } : {}) };
  return null;
}

/** Reference details and the existing dataset reference actions, close to the panel. */
export function ReferenceManager({ panelId, onClose }: { panelId: string; onClose: () => void }) {
  const { panel, datasets, mainChroms, mainLabel, fastaPath, publicMode, chrom, start, end } = useBrowserStore(useShallow(s => ({
    panel: s.panels.find(p => p.id === panelId), datasets: s.datasets, mainChroms: s.chroms,
    mainLabel: mainReferenceLabel(s), fastaPath: s.fastaPath, publicMode: s.publicMode,
    chrom: s.chrom, start: s.start, end: s.end,
  })));
  const { genomes, assignments } = usePanelGenomeStore(useShallow(s => ({ genomes: s.genomes, assignments: s.assignments })));
  const check = useGenomeCheckStore(s => s.check);
  const ref = useRef<HTMLDivElement>(null);
  const barSelector = `[data-reference-panel=${JSON.stringify(panelId)}]`;
  const dismiss = useDismissableDialog(ref, true, onClose, undefined, [
    `${barSelector} [data-testid="panel-site-more"]`, `${barSelector} [data-testid="panel-genome-chip"]`,
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mainAnnotation, setMainAnnotation] = useState<string | null>(null);
  const [selectedChrom, setSelectedChrom] = useState('');
  const key = panel?.genome;
  const info = key ? genomes[key] : undefined;
  const chroms = key ? info?.chroms ?? [] : mainChroms;
  const view = panel?.viewportOverride ?? { chrom, start, end };
  const contig = chroms.find(c => c.name === (selectedChrom || view.chrom));
  const dataset = datasets.find(d => d.id === panel?.datasetId);
  const fit = check?.datasets.find(d => d.dataset_id === panel?.datasetId);
  const assigned = panel?.datasetId ? assignments[panel.datasetId] : undefined;
  const name = key ? panelGenomeLabel(info, key) : mainLabel ?? 'Main reference';
  useEffect(() => {
    void usePanelGenomeStore.getState().refresh();
    void useGenomeCheckStore.getState().refresh();
    void fetchJson<{ pairs: Array<{ annotation: string | null }> }>('/api/reference_pairs')
      .then(r => setMainAnnotation(r.pairs.map(p => p.annotation).filter(Boolean).join(', ') || null))
      .catch(() => setMainAnnotation('Unavailable'));
  }, []);
  useEffect(() => setSelectedChrom(''), [key]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const attach = async (request: Omit<AttachGenomeRequest, 'dataset_ids'>) => {
    if (!panel?.datasetId) return;
    const result = await usePanelGenomeStore.getState().attach({ dataset_ids: [panel.datasetId], ...request });
    if (!result.success) throw new Error(result.error || 'Could not load reference');
  };
  const chooseFasta = () => run(async () => {
    const picked = await pickFile('fasta');
    if (picked.success && picked.path) await attach({ fasta_path: picked.path });
  });
  const chooseGtf = () => run(async () => {
    const picked = await pickFile('gtf');
    if (!picked.success || !picked.path) return;
    const result = await loadGtf(picked.path, key);
    if (!result.success) throw new Error(result.message || 'Could not load annotation');
    if (!key) setMainAnnotation(picked.path);
    await usePanelGenomeStore.getState().refresh();
    useBrowserStore.getState().triggerRefresh();
  });
  const switchTo = (value: string) => run(async () => {
    if (!panel?.datasetId) return;
    if (!value) {
      await usePanelGenomeStore.getState().detach([panel.datasetId]);
    } else {
      const request = source(genomes[value]);
      if (request) await attach(request);
    }
  });
  if (!panel) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) dismiss(); }}>
      <div className="absolute inset-0 bg-black/40" onClick={dismiss} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Reference manager" tabIndex={-1} data-testid="reference-manager"
        className="relative mx-4 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Reference</h2>
          <button className="fb-icon-btn h-6 w-6" type="button" aria-label="Close reference manager" data-testid="reference-manager-close" onClick={dismiss}><X size={14} /></button>
        </div>
        <div className="space-y-3 px-4 py-3 text-[12px] text-ink">
          <div className="space-y-1 break-words" data-testid="reference-manager-details">
            <p className="font-semibold">{name}</p>
            <p>FASTA: {key ? info?.fasta_path ?? 'none' : fastaPath || 'none'}</p>
            <p>Annotation: {key ? info?.gtf_path ?? 'none' : mainAnnotation ?? 'none'}</p>
            <p>{info?.n_chroms ?? chroms.length} contigs</p>
            <p>Circular: {chroms.filter(c => c.circular).map(c => c.name).join(', ') || 'none'}</p>
            <p>Window: {formatCoordinates(view.chrom, view.start, view.end)}</p>
          </div>
          <div className="space-y-1 border-t border-line pt-2" data-testid="reference-manager-datasets">
            <p className="font-semibold">Datasets in this panel</p>
            {panel.datasetId ? <>
              <p>{dataset?.label ?? panel.datasetId}</p>
              <p>Aligned to: {fit?.assembly.short ?? fit?.assembly.name ?? fit?.assembly.declared ?? 'Unknown from BAM header'}</p>
              <p>Uses: {assigned ? panelGenomeLabel(genomes[assigned], assigned) : mainLabel ?? 'Main reference'}</p>
              {!fit && <p className="text-ink-muted">Reference check unavailable.</p>}
              {fit && <p role={fit.severity === 'warning' || fit.severity === 'error' ? 'alert' : undefined}
                className={fit.severity === 'warning' || fit.severity === 'error' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-muted'}>
                {fit.status === 'match' ? 'Contigs match this reference.' : fit.message ?? 'Could not confirm a match. Check the reference.'}
              </p>}
              {fit?.suggestion?.can_load && fit.status !== 'match' && <AnalysisButton disabled={busy || publicMode} data-testid="reference-manager-fix"
                onClick={() => void run(() => attach({ genome_id: fit.suggestion!.genome_id }))}>Use {fit.suggestion.genome_id}</AnalysisButton>}
            </> : <p>No datasets</p>}
          </div>
          <div className="space-y-2 border-t border-line pt-2">
            <label className="block">Switch reference
              <select className="input-tool mt-1 w-full min-w-0 rounded px-1.5 py-0.5 text-[11px]" aria-label="Switch reference" data-testid="reference-manager-switch" value={key ?? ''}
                disabled={busy || publicMode || !panel.datasetId} onChange={e => void switchTo(e.target.value)}>
                <option value="">{mainLabel ?? 'Main reference'}</option>
                {Object.values(genomes).map(g => <option key={g.key} value={g.key} disabled={!source(g)}>{g.label}{!source(g) ? ' (BAM contigs only)' : ''}</option>)}
              </select>
            </label>
            <p className="text-[11px] text-ink-muted">Reference changes apply to every panel showing this dataset. Annotations and circular contigs apply to every panel using this reference.</p>
            <div className="flex flex-wrap gap-2">
              <AnalysisButton disabled={busy || publicMode || !panel.datasetId} data-testid="reference-manager-fasta" onClick={() => void chooseFasta()}>Attach FASTA…</AnalysisButton>
              <AnalysisButton disabled={busy || publicMode} data-testid="reference-manager-gtf" onClick={() => void chooseGtf()}>Attach GTF…</AnalysisButton>
            </div>
            <label className="block">Contig
              <select className="input-tool mt-1 w-full min-w-0 rounded px-1.5 py-0.5 text-[11px]" aria-label="Contig to mark circular" data-testid="reference-manager-contig" value={contig?.name ?? ''}
                disabled={busy} onChange={e => setSelectedChrom(e.target.value)}>
                {!contig && <option value="">Choose a contig</option>}
                {chroms.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            <CheckboxRow label="Circular" checked={Boolean(contig?.circular)} testId="reference-manager-circular"
              disabled={busy || publicMode || !contig || (!contig.circular && contig.size > 10_000_000)}
              description={contig && !contig.circular && contig.size > 10_000_000 ? 'Circular mode is limited to contigs up to 10 million bases.' : undefined}
              onChange={circular => void run(async () => {
                if (!contig) return;
                const result = await setCircularChrom(contig.name, circular, key);
                if (!result.success) throw new Error(result.error || 'Could not update contig');
                if (!key) useBrowserStore.getState().setChroms((await getChromosomes()).chroms);
                await usePanelGenomeStore.getState().refresh();
                useBrowserStore.getState().triggerRefresh();
              })} />
          </div>
          {busy && <p role="status">Loading…</p>}
          {error && <p role="alert" className="text-red-600 dark:text-red-400" data-testid="reference-manager-error">{error}</p>}
          <div className="flex gap-2 border-t border-line pt-2">
            <AnalysisButton data-testid="reference-manager-settings" onClick={() => { dismiss(); useBrowserStore.getState().openSidebarSection('genome'); }}>Genome settings</AnalysisButton>
            <AnalysisButton data-testid="reference-manager-library" onClick={() => { onClose(); openLibrary(); }}>Library</AnalysisButton>
          </div>
        </div>
      </div>
    </div>, document.body,
  );
}
