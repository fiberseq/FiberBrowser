/**
 * "Open BED as meta-locus…" (File / Open menu and ⌘K): a BED, its anchor and flank, the datasets, the working-set
 * size and seed. Opening starts the pool in the background; the build strip shows its progress.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { pickWithFallback, type PickPathResponse } from '../../api/files';
import { fetchJson } from '../../api/sharedFetch';
import { getBrowserPerformanceProfile } from '../../utils/performanceProfile';
import { isLocalPage } from '../../utils/serverFileBrowser';
import { DEFAULT_COUNT, DEFAULT_FLANK, MAX_FLANK, closeMetaLocusDialog, lastSettings, openMetaLocus, rememberSettings, useMetaLocusStore } from './metaLocusStore';
import { maxFlankFor } from './metaChrom';
import { probeMetaLocusPool, type MetaLocusSpec } from './api';
import { META_LOCUS_PREVIEW } from './preview';
import { PreviewBadge, PreviewLimitations } from '../../components/ui/PreviewBadge';

export function MetaLocusDialog() {
  const open = useMetaLocusStore(s => s.dialogOpen);
  if (!open) return null;
  return <MetaLocusDialogBody />;
}

function MetaLocusDialogBody() {
  const datasets = useBrowserStore(s => s.datasets);
  const maxRegionForReads = useBrowserStore(s => s.maxRegionForReads);
  const previous = useMetaLocusStore(s => s.spec);
  const previousCount = useMetaLocusStore(s => s.count);
  const previousSeed = useMetaLocusStore(s => s.seed);
  const lowPower = getBrowserPerformanceProfile().tier === 'low';
  const flankCap = maxFlankFor(lowPower, maxRegionForReads, MAX_FLANK);
  const bams = useMemo(() => datasets.filter(d => (d.data_type ?? 'bam') === 'bam'), [datasets]);
  // The last-used settings (this session's meta-locus, else this browser's last Open); anchor defaults to Start
  // (TSS, strand-aware), as the plan says.
  const last = useMemo(() => lastSettings(), []);
  const [bedPath, setBedPath] = useState(previous?.bed_path ?? last.bed_path ?? '');
  const [anchor, setAnchor] = useState<MetaLocusSpec['anchor']>(previous?.anchor ?? last.anchor ?? 'start');
  const [flank, setFlank] = useState(Math.min(previous?.flank_bp ?? last.flank_bp ?? DEFAULT_FLANK, flankCap));
  const [chosen, setChosen] = useState<string[]>(() => {
    const saved = previous?.dataset_ids?.length ? previous.dataset_ids : last.dataset_ids?.filter(id => bams.some(d => d.id === id));
    return saved?.length ? saved : bams.map(d => d.id);
  });
  const [count, setCount] = useState((previous ? previousCount : last.count) || DEFAULT_COUNT);
  const [seed, setSeed] = useState((previous ? previousSeed : last.seed) || 1);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState('');
  const storeError = useMetaLocusStore(s => s.error);
  const busy = useMetaLocusStore(s => s.busy);
  const [upload, setUpload] = useState<{ name: string; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMetaLocusDialog(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const browse = async () => {
    const picked = await pickWithFallback(() => fetchJson<PickPathResponse>('/api/pick_file?file_type=bed'), { title: 'Choose a BED file' });
    if (picked?.path) { setBedPath(picked.path); setUpload(null); }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    useMetaLocusStore.setState({ error: null });
    try {
      setUpload({ name: file.name, text: await readBedFile(file) });
      setBedPath('');
    } catch (err) {
      setUpload(null);
      setError(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    useMetaLocusStore.setState({ error: null });
    const path = bedPath.trim();
    if (!path && !upload) { setError('Choose a BED file, or type its path on the server'); return; }
    if (!bams.length) { setError('Load a BAM dataset first: a meta-locus pools the reads of BAM datasets'); return; }
    if (!chosen.length) { setError('Choose at least one dataset'); return; }
    const f = Math.max(100, Math.min(flankCap, Math.round(flank)));
    const fileName = upload ? upload.name : path;
    const name = fileName.split(/[\\/]/).pop()?.replace(/\.gz$/, '').replace(/\.bed$/, '') || 'regions';
    const where = upload ? { bed_path: '', bed_text: upload.text, bed_name: upload.name } : { bed_path: path };
    rememberSettings({ bed_path: upload ? last.bed_path : path, anchor, flank_bp: f, count: Math.max(1, Math.round(count)),
      seed: Math.round(seed), dataset_ids: chosen });
    void openMetaLocus(
      { ...where, name, anchor, flank_bp: f, dataset_ids: chosen.length === bams.length ? undefined : chosen },
      { count: Math.max(1, Math.round(count)), seed: Math.round(seed) },
    );
  };
  const shownError = error || storeError;

  // "cached: opens instantly" when the server already has this pool (a typed path; checked as the spec changes).
  useEffect(() => {
    const path = bedPath.trim();
    setCached(false);
    if (upload || !path || !chosen.length) return;
    let live = true;
    const timer = setTimeout(() => {
      void probeMetaLocusPool({ bed_path: path, anchor, flank_bp: Math.max(100, Math.min(flankCap, Math.round(flank))),
        dataset_ids: chosen.length === bams.length ? undefined : chosen })
        .then(r => { if (live) setCached(Boolean(r?.cached)); }).catch(() => { if (live) setCached(false); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [bedPath, upload, anchor, flank, chosen, bams, flankCap]);

  const toggle = (id: string) => setChosen(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={closeMetaLocusDialog}>
      <div className="absolute inset-0 bg-black/40" />
      <form role="dialog" aria-modal="true" aria-labelledby="meta-locus-title" data-testid="meta-locus-dialog" onSubmit={submit}
        className="relative mx-4 w-full max-w-md rounded-lg bg-white text-xs shadow-xl dark:bg-gray-800" onClick={e => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 id="meta-locus-title" className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200">
            Open BED as meta-locus <PreviewBadge feature={META_LOCUS_PREVIEW} />
          </h2>
          <PreviewLimitations feature={META_LOCUS_PREVIEW} className="mt-1 text-[11px] text-gray-500 dark:text-gray-400" />
        </div>
        <div className="space-y-2 px-4 py-3 text-gray-700 dark:text-gray-200">
          <label className="block">
            <span className="mb-0.5 block text-gray-500 dark:text-gray-400">BED file</span>
            <span className="flex gap-1">
              <input data-testid="meta-locus-bed" className="input-tool min-w-0 flex-1 text-xs" value={upload ? '' : bedPath} autoFocus
                onChange={e => { setBedPath(e.target.value); setUpload(null); }}
                placeholder={upload ? `${upload.name} (chosen)` : 'Path on the server, e.g. /data/sites.bed'} />
              <button type="button" className="btn-tool-default text-xs" data-testid="meta-locus-choose"
                onClick={() => fileInput.current?.click()}>Choose file…</button>
              <input ref={fileInput} type="file" accept=".bed,.gz,.txt,.tsv" className="hidden" data-testid="meta-locus-file"
                onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
            </span>
            {cached && !upload && <span className="mt-0.5 block text-emerald-700 dark:text-emerald-400" data-testid="meta-locus-cached">cached: opens instantly</span>}
            {upload && <span className="mt-0.5 block text-gray-500 dark:text-gray-400" data-testid="meta-locus-upload">
              {upload.name}: {upload.text.split('\n').filter(l => l.trim() && !/^(#|track|browser)/.test(l)).length.toLocaleString()} regions, sent with Open
            </span>}
            {isLocalPage() && <button type="button" className="mt-0.5 text-[11px] text-gray-500 underline dark:text-gray-400" onClick={() => void browse()}>
              Pick a path on this computer…</button>}
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-0.5 block text-gray-500 dark:text-gray-400">Anchor</span>
              <select data-testid="meta-locus-anchor" className="input-tool w-full text-xs" value={anchor} onChange={e => setAnchor(e.target.value as MetaLocusSpec['anchor'])}>
                <option value="centre">Centre</option>
                <option value="start">Start (TSS, strand-aware)</option>
                <option value="end">End (strand-aware)</option>
              </select>
            </label>
            <label className="flex-1">
              <span className="mb-0.5 block text-gray-500 dark:text-gray-400">Flank ± bp</span>
              <input data-testid="meta-locus-flank" type="number" min={100} max={flankCap} step={100} className="input-tool w-full text-xs"
                value={flank} onChange={e => setFlank(Number(e.target.value))} title={lowPower ? `Up to ±${flankCap.toLocaleString()} bp on this computer (its read-view limit)` : undefined} />
            </label>
          </div>
          <div>
            <span className="mb-0.5 block text-gray-500 dark:text-gray-400">Datasets</span>
            <div className="max-h-28 space-y-0.5 overflow-y-auto" data-testid="meta-locus-datasets">
              {bams.length === 0 && <div className="text-gray-400">No BAM dataset is loaded</div>}
              {bams.map(d => (
                <label key={d.id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => toggle(d.id)} />
                  <span className="truncate">{d.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-0.5 block text-gray-500 dark:text-gray-400">Working set (reads)</span>
              <input data-testid="meta-locus-count" type="number" min={1} max={10000} className="input-tool w-full text-xs" value={count} onChange={e => setCount(Number(e.target.value))} />
            </label>
            <label className="flex-1">
              <span className="mb-0.5 block text-gray-500 dark:text-gray-400">Seed</span>
              <input data-testid="meta-locus-seed" type="number" className="input-tool w-full text-xs" value={seed} onChange={e => setSeed(Number(e.target.value))} />
            </label>
          </div>
          {shownError && <div role="alert" className="text-red-600 dark:text-red-400" data-testid="meta-locus-dialog-error">{shownError}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-2 dark:border-white/10">
          <button type="button" className="btn-tool-default text-xs" onClick={closeMetaLocusDialog}>Cancel</button>
          <button type="submit" className="btn-tool-primary text-xs" data-testid="meta-locus-open" disabled={busy}>{busy ? 'Opening…' : 'Open'}</button>
        </div>
      </form>
    </div>
  );
}


/** A BED file's text (gzip read with the browser's DecompressionStream). */
export async function readBedFile(file: File): Promise<string> {
  const gz = file.name.endsWith('.gz');
  if (!gz) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
      reader.readAsText(file);
    });
  }
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot read .gz files; give the path instead');
  const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
