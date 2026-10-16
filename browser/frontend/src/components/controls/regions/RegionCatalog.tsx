import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { categoryShown, useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import type { RegionCatalog, RegionCategory, RegionEntry } from '../../../types/regions';
import { regionLabel } from '../../../api/regions';
import { scanDatasetRegions, scanStatusText, type RegionScanRequest } from '../../../utils/regionScan';
import type { Dataset } from '../../../types';
import { BED_HELP, bedReferenceFit, parseRegionBed, regionsToBed, type ReferenceChroms } from '../../../utils/regionBed';
import { emptyCatalog, entriesOf, namesFromBed, orderedCategories } from '../../../utils/regionCatalog';
import { catalogReferenceLabel, goToRegion, mainGenomeKey, panelGenomeKey, regionGoNote, shownEntriesOf, shownGenomes, stepCategory, stepRegion, targetGenome, viewOnGenome } from '../../../utils/regionNavigation';
import { panelGenomeChroms } from '../../../stores/panelGenomeStore';
import { highlightRegionEntries } from '../../../utils/highlightActions';
import { formatCoordinates, parseCoordinates } from '../../../utils/coordinates';
import { Bookmark, ChevronDown, ChevronLeft, ChevronRight, Download, GripVertical, Highlighter, MoreHorizontal, Pencil, Search, Trash, Upload, X } from '../../ui/Icons';

/**
 * The Regions panel's catalog (fb-r4-regions): every saved region of one
 * reference in categories and subheadings, like the Library's groups.
 * Sources: a dataset's amplicons (found automatically), regions found on
 * request (a chromosome or the view), BED files, the view saved by hand,
 * and what used to be bookmarks. Filter by keyword; drag regions between
 * categories; rename in place; select several to highlight, export, move or
 * remove; step through a category with ‹ › (or N / P).
 */

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const BTN = 'fb-btn-ghost h-[24px] gap-1 px-1.5 text-[11.5px]';
const ICON_BTN = 'rounded p-0.5 text-ink-muted hover:bg-gray-100 hover:text-ink dark:hover:bg-white/10 disabled:opacity-40';

type Row =
  | { type: 'category'; category: RegionCategory; depth: 0 | 1; path: string; count: number; shown: number }
  | { type: 'entry'; entry: RegionEntry; depth: 0 | 1 | 2 };

/** A question asked in the panel (the app's own, not a browser dialog): a delete, an import into another reference. */
interface Prompt {
  text: string;
  actions: Array<{ label: string; run: () => void; kind?: 'primary' | 'danger'; testId?: string }>;
}

/** A reference's chromosomes as the browser knows them (the main genome's, or a panel reference's). */
function referenceChroms(genome: string): ReferenceChroms {
  const s = useBrowserStore.getState();
  const chroms = genome === mainGenomeKey(s) ? s.chroms : panelGenomeChroms(genome, s.chroms);
  return { key: genome, chroms: chroms.map(c => ({ name: c.name, size: c.size })) };
}

/**
 * Where a BED file's regions belong: `target` when they fit it (or nothing is
 * known to check against), else a question: another shown reference they fit
 * better, or none.
 */
export function bedImportCheck(regions: Array<{ chrom: string; end: number }>, target: string, references: ReferenceChroms[]):
  | { kind: 'ok' }
  | { kind: 'elsewhere'; genome: string; missing: string[] }
  | { kind: 'unknown'; missing: string[] } {
  const own = references.find(r => r.key === target);
  if (!regions.length || !own || !own.chroms.length) return { kind: 'ok' };
  const fit = bedReferenceFit(regions, references);
  const mine = fit.find(f => f.key === target)!;
  if (mine.fits === regions.length) return { kind: 'ok' };
  const best = fit.find(f => f.key !== target && references.find(r => r.key === f.key)?.chroms.length);
  if (best && best.fits > mine.fits) return { kind: 'elsewhere', genome: best.key, missing: mine.missing };
  if (mine.fits === 0) return { kind: 'unknown', missing: mine.missing };
  return { kind: 'ok' };
}

function sourceBadge(category: RegionCategory): string | null {
  switch (category.source) {
    case 'auto': return 'detected';
    case 'top': return 'found';
    case 'bed': return 'BED';
    case 'bookmarks': return 'bookmarks';
    default: return null;
  }
}

function matches(entry: RegionEntry, path: string, q: string): boolean {
  return entry.label.toLowerCase().includes(q)
    || (entry.autoLabel ?? '').toLowerCase().includes(q)
    || (entry.gene ?? '').toLowerCase().includes(q)
    || path.toLowerCase().includes(q)
    // Plain digits, not formatCoordinates: two toLocaleString calls per entry
    // made each keystroke take ~600 ms on a 50,000-region catalog.
    || `${entry.chrom}:${entry.start}-${entry.end}`.toLowerCase().includes(q.replace(/,/g, ''));
}

/** The visible rows: shown categories (their regions unless folded), filtered by keyword. */
export function catalogRows(catalog: RegionCatalog, fingerprints: Record<string, string>, filter: string): Row[] {
  const q = filter.trim().toLowerCase();
  const rows: Row[] = [];
  const ordered = orderedCategories(catalog);
  const hidden = new Set(ordered.filter(({ category }) => !categoryShown(category, fingerprints)).map(o => o.category.id));
  const byCategory = new Map<string, RegionEntry[]>();
  for (const e of catalog.entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  for (const { category, depth, path } of ordered) {
    if (hidden.has(category.id) || (category.parent && hidden.has(category.parent))) continue;
    const own = byCategory.get(category.id) ?? [];
    const children = depth === 0 ? ordered.filter(o => o.category.parent === category.id) : [];
    const total = own.length + children.reduce((n, c) => n + (byCategory.get(c.category.id)?.length ?? 0), 0);
    const shownOwn = q ? own.filter(e => matches(e, path, q)) : own;
    const childMatches = q ? children.some(c => (byCategory.get(c.category.id) ?? []).some(e => matches(e, c.path, q))) : true;
    if (q && !shownOwn.length && !childMatches && !path.toLowerCase().includes(q)) continue;
    const parentCollapsed = category.parent ? catalog.categories.find(c => c.id === category.parent)?.collapsed : false;
    if (parentCollapsed && !q) continue;
    rows.push({ type: 'category', category, depth, path, count: total, shown: shownOwn.length });
    if (category.collapsed && !q) continue;
    for (const entry of shownOwn) rows.push({ type: 'entry', entry, depth: (depth + 1) as 1 | 2 });
  }
  return rows;
}

function download(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(text: string): string {
  return text.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'regions';
}

/** A small menu under its button; closes on a click elsewhere or Escape. */
function Popover({ onClose, children, align = 'right', testId }: { onClose: () => void; children: ReactNode; align?: 'left' | 'right'; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" data-testid={testId}
      className={`absolute top-full z-[95] mt-1 min-w-[12rem] rounded-fb-lg border border-line bg-white p-1 text-[12px] shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark ${align === 'right' ? 'right-0' : 'left-0'}`}>
      {children}
    </div>
  );
}

function MenuItem({ onClick, children, danger, disabled, testId, title }: { onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean; testId?: string; title?: string }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} data-testid={testId} title={title}
      className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-white/10 ${danger ? 'text-red-600 dark:text-red-400' : 'text-ink'}`}>
      {children}
    </button>
  );
}

/** "Save this region": the view (or a panel's), named after its nearest gene unless renamed. */
/** The view to save or search on this reference, kept current as the view moves. */
function useViewOnGenome(genome: string, datasetId?: string) {
  // (Subscribed to what decides it, so a pan or zoom updates the form.)
  useBrowserStore(useShallow(s => [s.chrom, s.start, s.end, s.panels, s.selectedDatasets, s.navigationMode, s.currentGenome, s.fastaPath]));
  return viewOnGenome(genome, useBrowserStore.getState(), datasetId);
}

function SaveViewForm({ genome, catalog, onDone }: { genome: string; catalog: RegionCatalog; onDone: (message: string) => void }) {
  const shown = useViewOnGenome(genome);
  const view = shown ?? { chrom: '', start: 0, end: 0, panelGenome: null };
  const [label, setLabel] = useState('');
  const [suggested, setSuggested] = useState<string | null>(null);
  const cats = orderedCategories(catalog).filter(o => o.category.source !== 'auto');
  // Saved views go to their own category ("Saved regions", made on first use) unless another is chosen.
  const [category, setCategory] = useState(cats.find(o => o.category.source === 'saved')?.category.id ?? '__new');
  const [newName, setNewName] = useState('Saved regions');
  useEffect(() => {
    let live = true;
    // (A public server doesn't name regions: the locus is the default name there.)
    if (!view.chrom || useBrowserStore.getState().publicMode) return;
    regionLabel(view.chrom, view.start, view.end, view.panelGenome).then(r => { if (live) setSuggested(r.label); }).catch(() => undefined);
    return () => { live = false; };
  }, [view.chrom, view.start, view.end, view.panelGenome]);
  if (!shown) return <div className="rounded-fb border border-dashed border-line p-2 text-[11.5px] text-ink-muted" data-testid="region-save-form">No panel shows {genome}: open a dataset on it to save its view.</div>;
  const save = () => {
    const store = useRegionCatalogStore.getState();
    const categoryId = category === '__new'
      ? store.addCategory(genome, { name: newName.trim() || 'Saved regions', source: 'saved' })
      : category;
    store.addEntries(genome, categoryId, [{ chrom: view.chrom, start: view.start, end: view.end, label: label.trim() || suggested || formatCoordinates(view.chrom, view.start, view.end), source: 'saved' }]);
    onDone(`Saved ${label.trim() || suggested || 'the view'}.`);
  };
  return (
    <form className="space-y-1.5 rounded-fb border border-teal-200 bg-teal-50/60 p-2 dark:border-teal-800/50 dark:bg-teal-900/20"
      onSubmit={e => { e.preventDefault(); save(); }} data-testid="region-save-form">
      <div className="font-mono text-[11px] text-ink-muted">{formatCoordinates(view.chrom, view.start, view.end)}</div>
      <input autoFocus className="input-tool h-7 w-full text-[12px]" value={label} onChange={e => setLabel(e.target.value)}
        placeholder={suggested ?? 'Name'} aria-label="Region name" data-testid="region-save-label" />
      <div className="flex flex-wrap items-center gap-1">
        <select className="input-tool h-7 min-w-0 flex-1 text-[12px]" value={category} onChange={e => setCategory(e.target.value)} aria-label="Category">
          {cats.map(o => <option key={o.category.id} value={o.category.id}>{o.path}</option>)}
          <option value="__new">New category…</option>
        </select>
        {category === '__new' && (
          <input className="input-tool h-7 min-w-0 flex-1 text-[12px]" value={newName} onChange={e => setNewName(e.target.value)} aria-label="New category name" />
        )}
        <button type="submit" className="fb-btn-primary h-7 px-2.5 text-[12px]" data-testid="region-save-confirm">Save</button>
      </div>
    </form>
  );
}

/** The open BAM datasets on this reference (shown in a panel). */
function useScannableDatasets(genome: string) {
  const { datasets, panels } = useBrowserStore(useShallow(s => ({ datasets: s.datasets, panels: s.panels })));
  const s = useBrowserStore.getState();
  return datasets.filter(d => (d.data_type ?? 'bam') === 'bam'
    && panels.some(p => p.datasetId === d.id && panelGenomeKey(p, s) === genome));
}

/** One open dataset's scan: what it found or why it was skipped, and the narrower (or slow) scans it can have. */
type ScanNotice = { datasets: Pick<Dataset, 'id' | 'label'>[]; details?: boolean };

function RegionScanNotice({ datasets, details }: ScanNotice) {
  const scans = useRegionCatalogStore(st => st.scans);
  return <>{datasets.map(d => {
    const scan = scans[d.id];
    return `${d.label || d.id}: ${scanStatusText(scan)}${details && scan?.note ? `. ${scan.note}` : ''}`;
  }).join('; ')}</>;
}

function DatasetScanRow({ genome, dataset, onDone }: { genome: string; dataset: Dataset; onDone: (message: ScanNotice) => void }) {
  const scan = useRegionCatalogStore(st => st.scans[dataset.id]);
  const s = useBrowserStore.getState();
  const view = useViewOnGenome(genome, dataset.id) ?? { chrom: s.chrom, start: s.start, end: s.end };
  const busy = scan?.state === 'running';
  const label = dataset.label || dataset.id;
  const run = async (request: RegionScanRequest) => {
    await scanDatasetRegions(dataset, request);
    onDone({ datasets: [dataset], details: true });
  };
  const skipped = scan?.state === 'refused' && scan.status !== 'mismatch';
  const text = scanStatusText(scan);
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5" data-testid="region-scan-row" data-dataset={dataset.id}
      data-state={scan?.state ?? 'none'} data-status={scan?.status ?? ''}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dataset.color || '#64748b' }} aria-hidden="true" />
      <span className="min-w-0 max-w-[45%] truncate font-medium" title={label}>{label}</span>
      <span className={`min-w-0 flex-1 truncate ${scan?.state === 'refused' || scan?.state === 'error' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-muted'}`}
        title={[text, scan?.message, scan?.note].filter(Boolean).join('\n')} data-testid="region-scan-status">{text}</span>
      {scan?.state !== 'running' && scan?.status !== 'mismatch' && (
        <span className="flex shrink-0 gap-0.5">
          <button type="button" className={BTN} disabled={busy} onClick={() => void run({ scope: 'view', view })}
            title={`Best-covered regions in the view (${formatCoordinates(view.chrom, view.start, view.end)})`} data-testid="region-scan-view">This view</button>
          <button type="button" className={BTN} disabled={busy} onClick={() => void run({ scope: 'chrom', view })}
            title={`Best-covered regions on ${view.chrom}`} data-testid="region-scan-chrom">{view.chrom}</button>
          {skipped && (
            <button type="button" className={BTN} disabled={busy} onClick={() => void run({ scope: 'dataset', force: true })}
              title="Read every read of the dataset (can take minutes on a large one)" data-testid="region-scan-anyway">Scan anyway (slow)</button>
          )}
        </span>
      )}
    </li>
  );
}

/** Every open BAM dataset of this reference with its scan status (Regions › Scan regions scans them all again). */
function DatasetScanList({ genome, onDone }: { genome: string; onDone: (message: ScanNotice) => void }) {
  const onGenome = useScannableDatasets(genome);
  if (!onGenome.length) return null;
  return (
    <ul className="rounded-fb border border-line px-2 py-1 text-[11.5px] dark:border-white/10" data-testid="region-scan-list" aria-label="Region scans of the open datasets">
      {onGenome.map(d => <DatasetScanRow key={d.id} genome={genome} dataset={d} onDone={onDone} />)}
    </ul>
  );
}

export function RegionCatalog() {
  const browser = useBrowserStore(useShallow(s => ({
    panels: s.panels, selectedDatasets: s.selectedDatasets, navigationMode: s.navigationMode,
    currentGenome: s.currentGenome, fastaPath: s.fastaPath,
  })));
  const publicMode = useBrowserStore(s => s.publicMode);
  useBrowserStore(s => s.chrom); // re-render on navigation (the target's view)
  useBrowserStore(s => s.chroms); // and when a plasmid map is loaded
  const genomes = useMemo(() => shownGenomes(useBrowserStore.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [browser.panels, browser.currentGenome, browser.fastaPath]);
  // The chosen catalog outlives the panel (moved into the drawer, closed and opened again).
  const picked = useRegionCatalogStore(st => st.picked);
  const setPicked = useRegionCatalogStore.getState().setPicked;
  const target = targetGenome(useBrowserStore.getState());
  const genome = picked && genomes.includes(picked) ? picked : target;
  const main = mainGenomeKey(useBrowserStore.getState());
  const { catalog, fingerprints, active, sync, saveError, loadError, undo } = useRegionCatalogStore(useShallow(st => ({
    catalog: st.catalogs[genome], fingerprints: st.fingerprints, active: st.active, sync: st.sync[genome], saveError: st.saveError,
    loadError: st.loadErrors[genome], undo: st.undo,
  })));
  // N / P step the catalog shown here (utils/regionNavigation.stepGenome), as ‹ › do.
  useEffect(() => {
    useRegionCatalogStore.getState().setShown(genome);
    return () => useRegionCatalogStore.getState().setShown(null);
  }, [genome]);
  const cat = catalog ?? emptyCatalog(genome);
  // Named as the user sees it: on a plasmid, the plasmid (its regions are kept with the genome's).
  const reference = catalogReferenceLabel(genome, useBrowserStore.getState());
  // Reset forgets the whole catalog (every plasmid map's regions too): it names the catalog.
  const catalogName = genome === 'none' ? 'every plasmid map' : genome;
  useEffect(() => { void useRegionCatalogStore.getState().ensureLoaded(genome); }, [genome]);

  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ kind: 'entry' | 'coords' | 'category'; id: string } | null>(null);
  const [menu, setMenu] = useState<{ kind: 'category' | 'entry'; id: string } | null>(null);
  const [form, setForm] = useState<'save' | 'more' | null>(null);
  const [status, setStatus] = useState<string | ScanNotice | null>(null);
  // Scan regions: every open dataset of this reference again (each line says what it found or why not).
  const scannable = useScannableDatasets(genome);
  const [scanningAll, setScanningAll] = useState(false);
  const scanAll = async () => {
    setScanningAll(true);
    try {
      for (const d of scannable) {
        await scanDatasetRegions(d, { scope: 'dataset' });
      }
      // A newer automatic scan can supersede this request. Follow its status
      // instead of keeping a snapshot of "scanning…" after it has completed.
      setStatus({ datasets: scannable });
    } finally {
      setScanningAll(false);
    }
  };
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  // A message or question about one reference's catalog goes when another is shown.
  useEffect(() => { setStatus(null); setPrompt(null); }, [genome]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // "Name from a BED file": the category whose regions take the BED's names.
  const namesRef = useRef<HTMLInputElement>(null);
  const [namesFor, setNamesFor] = useState<string | null>(null);
  const store = useRegionCatalogStore.getState;

  const rows = useMemo(() => catalogRows(cat, fingerprints, filter), [cat, fingerprints, filter]);
  const entryRows = rows.filter((r): r is Extract<Row, { type: 'entry' }> => r.type === 'entry');
  const totalShown = useMemo(() => rows.reduce((n, r) => (r.type === 'category' && r.depth === 0 ? n + r.count : n), 0), [rows]);
  // Selections of regions no longer listed (removed, filtered out) are dropped.
  useEffect(() => {
    if (!checked.size) return;
    const ids = new Set(cat.entries.map(e => e.id));
    if ([...checked].some(id => !ids.has(id))) setChecked(new Set([...checked].filter(id => ids.has(id))));
  }, [cat.entries, checked]);

  // --- windowed list ------------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(400);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewHeight(el.clientHeight || 400);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  // --- next / previous ----------------------------------------------------
  const stepCat = stepCategory(genome);
  const stepEntries = stepCat ? shownEntriesOf(cat, stepCat, fingerprints) : [];
  const stepAt = active?.genome === genome && active.category === stepCat && active.entry ? stepEntries.findIndex(e => e.id === active.entry) : -1;
  const stepName = stepCat ? orderedCategories(cat).find(o => o.category.id === stepCat)?.path : null;

  const go = useCallback((entry: RegionEntry) => {
    const note = regionGoNote(genome);
    const problem = goToRegion(genome, entry);
    setStatus(problem ?? note);
  }, [genome]);

  const selectedEntries = cat.entries.filter(e => checked.has(e.id));
  const toggleChecked = (id: string) => setChecked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // --- drag and drop ----------------------------------------------------
  const onDragStart = (e: DragEvent, entry: RegionEntry) => {
    const ids = checked.has(entry.id) ? [...checked] : [entry.id];
    e.dataTransfer.setData('application/x-fiberbrowser-regions', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropOn = (e: DragEvent, categoryId: string, beforeId: string | null) => {
    const raw = e.dataTransfer.getData('application/x-fiberbrowser-regions');
    setDropTarget(null);
    if (!raw) return;
    e.preventDefault();
    try {
      const ids = JSON.parse(raw) as string[];
      store().moveEntries(genome, ids, categoryId, beforeId);
    } catch { /* not ours */ }
  };
  const allowDrop = (e: DragEvent, key: string) => {
    if (!e.dataTransfer.types.includes('application/x-fiberbrowser-regions')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== key) setDropTarget(key);
  };

  // --- import / export ----------------------------------------------------
  const importOne = (into: string, text: string, fileName: string): string => {
    const res = store().importBed(into, text, fileName);
    return `${fileName}${into !== genome ? ` (into ${into})` : ''}: ${res.imported.toLocaleString()} region${res.imported === 1 ? '' : 's'}${res.skipped ? `, ${res.skipped} line${res.skipped === 1 ? '' : 's'} skipped (${res.problems[0] ?? 'not BED'})` : ''}`;
  };
  /**
   * Import BED files into this reference's catalog, after checking their
   * chromosomes against it: regions that fit another shown reference better
   * (a dm6 BED with hg38 shown) or none at all are imported only when the
   * user says where.
   */
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = await Promise.all(Array.from(files).map(async file => ({ name: file.name, text: await file.text() })));
    if (fileRef.current) fileRef.current.value = '';
    const references = genomes.map(referenceChroms);
    const done: string[] = [];
    const ask = (queue: typeof list) => {
      for (let i = 0; i < queue.length; i++) {
        const { name, text } = queue[i];
        const check = bedImportCheck(parseRegionBed(text).regions, genome, references);
        if (check.kind === 'ok') { done.push(importOne(genome, text, name)); continue; }
        const rest = queue.slice(i + 1);
        const next = (line?: string) => { if (line) done.push(line); setPrompt(null); ask(rest); };
        const missing = check.missing.join(', ');
        setPrompt(check.kind === 'elsewhere' ? {
          text: `${name} looks like ${check.genome} regions: ${missing || 'its chromosomes'} ${check.missing.length === 1 ? 'is' : 'are'} not on ${genome}. Import into ${check.genome}?`,
          actions: [
            { label: `Import into ${check.genome}`, kind: 'primary', run: () => next(importOne(check.genome, text, name)), testId: 'region-import-elsewhere' },
            { label: `Import into ${genome} anyway`, run: () => next(importOne(genome, text, name)), testId: 'region-import-here' },
            { label: 'Skip', run: () => next(`${name}: skipped`) },
          ],
        } : {
          text: `None of ${name}'s chromosomes (${missing || 'its chromosomes'}) are on ${genome} or another reference shown now.`,
          actions: [
            { label: `Import into ${genome} anyway`, run: () => next(importOne(genome, text, name)), testId: 'region-import-here' },
            { label: 'Skip', kind: 'primary', run: () => next(`${name}: skipped`) },
          ],
        });
        return;
      }
      if (done.length) setStatus(`Imported ${done.join('; ')}.`);
    };
    ask(list);
  };
  const nameFromBed = async (files: FileList | null) => {
    const file = files?.[0];
    const categoryId = namesFor;
    setNamesFor(null);
    if (namesRef.current) namesRef.current.value = '';
    if (!file || !categoryId) return;
    const list = entriesOf(cat, categoryId, true);
    const names = namesFromBed(list, parseRegionBed(await file.text()).regions);
    for (const [id, name] of names) store().updateEntry(genome, id, { label: name });
    setStatus(`Named ${names.size} of ${list.length} region${list.length === 1 ? '' : 's'} from ${file.name} (the BED region overlapping each most, at least half of either).`);
  };
  const exportBed = (entries: RegionEntry[], name: string) => {
    if (!entries.length) { setStatus('Nothing to export.'); return; }
    download(`${safeName(name)}.bed`, regionsToBed(cat, entries));
    setStatus(`Exported ${entries.length.toLocaleString()} region${entries.length === 1 ? '' : 's'} as BED.`);
  };
  // Side-by-side views (panelSlice.openGenomeRegionViews) open on the main genome, with its datasets.
  const sideBySideBlocked = genome !== mainGenomeKey(useBrowserStore.getState())
    ? `Side-by-side views open on the main genome (${mainGenomeKey(useBrowserStore.getState())}); go to the region instead` : null;
  const openSideBySide = (entries: RegionEntry[]) => {
    if (sideBySideBlocked) { setStatus(sideBySideBlocked); return; }
    const s = useBrowserStore.getState();
    const datasetIds = [...new Set(s.panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.genome).map(p => p.datasetId as string))];
    s.openGenomeRegionViews(entries.slice(0, 8).map(e => ({ chrom: e.chrom, start: e.start, end: e.end, label: e.label, datasetIds })));
  };
  /** What "Export BED" writes without a selection: the rows a filter shows; unfiltered, every listed category (folded ones too). */
  const shownEntries = () => {
    if (filter.trim()) return entryRows.map(r => r.entry);
    // Every category the panel lists, folded or under a folded heading (not a closed dataset's amplicons).
    const byId = new Map(cat.categories.map(c => [c.id, c]));
    const shownCats = new Set(cat.categories.filter(c => categoryShown(c, fingerprints)
      && (!c.parent || !byId.has(c.parent) || categoryShown(byId.get(c.parent)!, fingerprints))).map(c => c.id));
    return cat.entries.filter(e => shownCats.has(e.category));
  };
  const others = genomes.filter(g => g !== genome);
  const moveTo = (to: string, what: { categoryIds?: string[]; entryIds?: string[] }) => {
    void store().moveToGenome(genome, to, what).then(res => setStatus(res.error ?? (res.moved ? null : 'Nothing was moved.')));
  };

  // --- rows ---------------------------------------------------------------
  const commitEdit = (value: string) => {
    if (!editing) return;
    if (editing.kind === 'entry') store().updateEntry(genome, editing.id, { label: value });
    else if (editing.kind === 'category') store().updateCategory(genome, editing.id, { name: value.trim() || 'Regions' });
    else {
      const parsed = parseCoordinates(value);
      if (!parsed || parsed.end <= parsed.start) { setStatus('Coordinates are chrom:start-end.'); return; }
      store().updateEntry(genome, editing.id, parsed);
    }
    setEditing(null);
  };
  const editKeys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit((e.target as HTMLInputElement).value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
  };
  const editor = (initial: string, label: string) => (
    <input autoFocus defaultValue={initial} aria-label={label} onKeyDown={editKeys} onBlur={e => commitEdit(e.target.value)}
      className="input-tool h-[22px] min-w-0 flex-1 text-[12px]" data-testid="region-edit-input" />
  );

  const categoryRow = (row: Extract<Row, { type: 'category' }>) => {
    const { category, depth, path, count } = row;
    const top = depth === 0;
    const children = cat.categories.filter(c => c.parent === category.id);
    const tops = cat.categories.filter(c => !c.parent && c.id !== category.id);
    const all = entriesOf(cat, category.id, true);
    const isStep = stepCat === category.id;
    return (
      <div
        className={`group flex h-full items-center gap-1 border-b border-line/60 pr-1 dark:border-white/5 ${top ? 'bg-gray-50/80 dark:bg-white/[0.03]' : ''} ${dropTarget === `c:${category.id}` ? 'ring-2 ring-inset ring-teal-500' : ''}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onDragOver={e => allowDrop(e, `c:${category.id}`)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={e => dropOn(e, category.id, null)}
        data-testid="region-category"
        data-category-id={category.id}
        data-category-name={category.name}
      >
        <button type="button" className={ICON_BTN} aria-expanded={!category.collapsed} aria-label={`${category.collapsed ? 'Show' : 'Fold'} ${path}`}
          onClick={() => store().updateCategory(genome, category.id, { collapsed: !category.collapsed })}>
          {category.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        {editing?.kind === 'category' && editing.id === category.id ? editor(category.name, 'Category name') : (
          <button type="button" className={`min-w-0 truncate text-left text-[12px] ${top ? 'font-semibold' : 'font-medium'} ${isStep ? 'text-teal-800 dark:text-teal-300' : 'text-ink'}`}
            title={`${path}${category.note ? `\n${category.note}` : ''}\nClick: step through this category (‹ › or N / P). Double-click: rename.`}
            onClick={() => { if (all.length) { store().setActive(genome, category.id, null); setStatus(null); } }}
            onDoubleClick={() => setEditing({ kind: 'category', id: category.id })}
            data-testid="region-category-name">
            {category.name}
          </button>
        )}
        <span className="shrink-0 tabular-nums text-[11px] text-ink-muted" data-testid="region-category-count">{count.toLocaleString()}</span>
        {sourceBadge(category) && <span className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300" title={category.note}>{sourceBadge(category)}</span>}
        <span className="flex-1" />
        <div className="relative flex shrink-0 items-center opacity-70 group-hover:opacity-100">
          <button type="button" className={ICON_BTN} title="Highlight every region here" aria-label={`Highlight the regions of ${path}`}
            disabled={!all.length} onClick={() => highlightRegionEntries(genome, all)}><Highlighter size={12} /></button>
          <button type="button" className={ICON_BTN} aria-label={`More for ${path}`} aria-haspopup="menu" onClick={() => setMenu({ kind: 'category', id: category.id })}
            data-testid="region-category-menu"><MoreHorizontal size={12} /></button>
          {menu?.kind === 'category' && menu.id === category.id && (
            <Popover onClose={() => setMenu(null)}>
              <MenuItem onClick={() => { setMenu(null); setEditing({ kind: 'category', id: category.id }); }}>Rename</MenuItem>
              {top && <MenuItem onClick={() => { setMenu(null); const id = store().addCategory(genome, { name: 'New subheading', parent: category.id, source: 'user' }); setEditing({ kind: 'category', id }); }}>Add subheading</MenuItem>}
              <MenuItem disabled={!all.length} onClick={() => { setMenu(null); exportBed(all, `${genome}_${path}`); }}>Export as BED</MenuItem>
              <MenuItem disabled={!all.length || !!sideBySideBlocked} onClick={() => { setMenu(null); openSideBySide(all); }}
                title={sideBySideBlocked ?? 'Open the first 8 side by side'}>Open side by side</MenuItem>
              <MenuItem disabled={!all.length} onClick={() => { setMenu(null); setNamesFor(category.id); namesRef.current?.click(); }}
                title="Each region takes the name of the BED region that overlaps it most" testId="region-category-names-from-bed">Name from a BED file…</MenuItem>
              {category.source === 'auto' && <MenuItem onClick={() => { setMenu(null); store().restoreAutoLabels(genome, category.id); }}>Restore detected names</MenuItem>}
              <MenuItem onClick={() => { setMenu(null); store().moveCategory(genome, category.id, prevSibling(cat, category)); }}>Move up</MenuItem>
              <MenuItem onClick={() => { setMenu(null); store().moveCategory(genome, category.id, nextAfter(cat, category)); }}>Move down</MenuItem>
              {!children.length && (top
                ? tops.map(t => <MenuItem key={t.id} onClick={() => { setMenu(null); store().moveCategory(genome, category.id, null, t.id); }}>Under {t.name}</MenuItem>)
                : <MenuItem onClick={() => { setMenu(null); store().moveCategory(genome, category.id, null, null); }}>Make a category</MenuItem>)}
              {others.map(g => (
                <MenuItem key={`to:${g}`} onClick={() => { setMenu(null); moveTo(g, { categoryIds: [category.id] }); }}
                  title={`Move ${path} and its regions to the ${g} catalog`} testId="region-category-move-genome">Move to {g}</MenuItem>
              ))}
              <div className="my-1 border-t border-line dark:border-white/10" />
              <MenuItem danger onClick={() => {
                setMenu(null);
                setPrompt({
                  text: `Delete ${path} and its ${count.toLocaleString()} region${count === 1 ? '' : 's'}?`,
                  actions: [
                    { label: 'Delete', kind: 'danger', run: () => { setPrompt(null); store().removeCategory(genome, category.id, { undoable: true }); }, testId: 'region-confirm-delete' },
                    { label: 'Cancel', run: () => setPrompt(null) },
                  ],
                });
              }} testId="region-category-delete">Delete…</MenuItem>
            </Popover>
          )}
        </div>
      </div>
    );
  };

  const entryRow = (row: Extract<Row, { type: 'entry' }>) => {
    const { entry, depth } = row;
    const isActive = active?.genome === genome && active.entry === entry.id;
    return (
      <div
        className={`group flex h-full items-center gap-1 border-b border-line/40 pr-1 dark:border-white/5 ${isActive ? 'bg-teal-50 dark:bg-teal-900/25' : 'hover:bg-gray-50 dark:hover:bg-white/[0.04]'} ${dropTarget === `e:${entry.id}` ? 'shadow-[inset_0_2px_0_0_rgb(20_184_166)]' : ''}`}
        style={{ paddingLeft: 2 + depth * 14 }}
        draggable={!editing}
        onDragStart={e => onDragStart(e, entry)}
        onDragOver={e => allowDrop(e, `e:${entry.id}`)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={e => dropOn(e, entry.category, entry.id)}
        data-testid="region-entry"
        data-entry-id={entry.id}
        data-active={isActive ? 'true' : undefined}
      >
        <GripVertical size={11} className="shrink-0 cursor-grab text-gray-300 group-hover:text-gray-500 dark:text-white/20" aria-hidden="true" />
        <input type="checkbox" className="shrink-0" checked={checked.has(entry.id)} onChange={() => toggleChecked(entry.id)} aria-label={`Select ${entry.label}`} />
        {editing?.id === entry.id && editing.kind !== 'category' ? editor(editing.kind === 'entry' ? entry.label : formatCoordinates(entry.chrom, entry.start, entry.end), editing.kind === 'entry' ? 'Region name' : 'Region coordinates') : (
          <button type="button" className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden text-left"
            title={`${entry.label}\n${formatCoordinates(entry.chrom, entry.start, entry.end)}${entry.detail ? `\n${entry.detail}` : ''}${entry.autoLabel && entry.autoLabel !== entry.label ? `\nDetected as ${entry.autoLabel}` : ''}\nClick: go there. Double-click or F2: rename.`}
            onClick={() => go(entry)}
            onDoubleClick={() => setEditing({ kind: 'entry', id: entry.id })}
            onKeyDown={e => {
              if (e.key === 'F2') { e.preventDefault(); setEditing({ kind: 'entry', id: entry.id }); }
              else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); store().removeEntries(genome, [entry.id], { undoable: true }); }
            }}
            data-testid="region-entry-go">
            {/* The name keeps room first; the coordinates shrink (and end in …) in a narrow panel. */}
            <span className="min-w-[4.5rem] shrink truncate text-[12px] text-ink" data-testid="region-entry-label">{entry.label}</span>
            <span className="min-w-0 shrink-[4] truncate font-mono text-[10.5px] text-ink-muted" data-testid="region-entry-coords">{formatCoordinates(entry.chrom, entry.start, entry.end)}</span>
          </button>
        )}
        {entry.reads != null && <span className="shrink-0 tabular-nums text-[10.5px] text-ink-muted" title="Reads">{entry.reads.toLocaleString()}</span>}
        {entry.reads == null && entry.score != null && entry.score !== 0 && <span className="shrink-0 tabular-nums text-[10.5px] text-ink-muted" title="Score">{entry.score}</span>}
        <div className="relative flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <button type="button" className={ICON_BTN} title="Highlight" aria-label={`Highlight ${entry.label}`} onClick={() => highlightRegionEntries(genome, [entry])}
            data-testid="region-entry-highlight"><Highlighter size={12} /></button>
          <button type="button" className={ICON_BTN} title="Rename" aria-label={`Rename ${entry.label}`} onClick={() => setEditing({ kind: 'entry', id: entry.id })}
            data-testid="region-entry-rename"><Pencil size={12} /></button>
          <button type="button" className={ICON_BTN} aria-label={`More for ${entry.label}`} onClick={() => setMenu({ kind: 'entry', id: entry.id })}><MoreHorizontal size={12} /></button>
          {menu?.kind === 'entry' && menu.id === entry.id && (
            <Popover onClose={() => setMenu(null)}>
              <MenuItem onClick={() => { setMenu(null); setEditing({ kind: 'coords', id: entry.id }); }}>Edit coordinates</MenuItem>
              {entry.autoLabel && entry.autoLabel !== entry.label && <MenuItem onClick={() => { setMenu(null); store().updateEntry(genome, entry.id, { label: entry.autoLabel }); }}>Restore name ({entry.autoLabel})</MenuItem>}
              <MenuItem disabled={!!sideBySideBlocked} title={sideBySideBlocked ?? undefined} onClick={() => { setMenu(null); openSideBySide([entry]); }}>Open beside</MenuItem>
              <MenuItem danger onClick={() => { setMenu(null); store().removeEntries(genome, [entry.id], { undoable: true }); }}>Delete</MenuItem>
            </Popover>
          )}
        </div>
      </div>
    );
  };

  const savedNote = sync === 'local' ? 'Kept in this session only (not saved for next time).' : saveError;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="region-catalog" data-genome={genome}>
      <div className="flex flex-wrap items-center gap-1.5">
        {genomes.length > 1 && (
          <select className="input-tool h-7 text-[12px]" value={genome} onChange={e => setPicked(e.target.value === target ? null : e.target.value)} aria-label="Reference" data-testid="region-genome-select">
            {genomes.map(g => <option key={g} value={g}>{g}{g === main ? ' (main genome)' : ''}</option>)}
          </select>
        )}
        <div className="relative min-w-[10rem] flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
          <input type="search" className="input-tool h-7 w-full pl-6 text-[12px]" placeholder={`Filter ${totalShown.toLocaleString()} regions on ${reference}`}
            value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter regions" data-testid="region-filter" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={`${BTN} ${form === 'save' ? 'bg-gray-900/[0.06] dark:bg-white/10' : ''}`} onClick={() => setForm(form === 'save' ? null : 'save')}
          title="Save the view as a region (named after its nearest gene)" data-tour="region-add-view" data-testid="region-save-view"><Bookmark size={12} aria-hidden="true" /> Save view</button>
        <button type="button" className={BTN} onClick={() => fileRef.current?.click()} title={`Import BED files. ${BED_HELP}`} data-testid="region-import-bed"><Upload size={12} aria-hidden="true" /> Import BED</button>
        <input ref={fileRef} type="file" multiple accept=".bed,.txt,.tsv,text/plain" className="hidden" data-testid="region-import-input"
          onChange={e => void importFiles(e.target.files)} />
        <input ref={namesRef} type="file" accept=".bed,.txt,.tsv,text/plain" className="hidden" data-testid="region-names-input"
          onChange={e => void nameFromBed(e.target.files)} />
        {!publicMode && (
          <button type="button" className={BTN} disabled={scanningAll || !scannable.length} onClick={() => void scanAll()}
            title={scannable.length ? `Scan the ${scannable.length === 1 ? 'open dataset' : `${scannable.length} open datasets`} on ${reference} for their regions (each says what it found or why not)` : `No BAM dataset on ${reference} is open`}
            data-testid="region-find"><Search size={12} aria-hidden="true" /> {scanningAll ? 'Scanning…' : 'Scan regions'}</button>
        )}
        <button type="button" className={BTN} onClick={() => exportBed(checked.size ? selectedEntries : shownEntries(), `${genome}_regions`)}
          title={`Export ${checked.size ? 'the selected regions' : filter.trim() ? 'the regions the filter shows' : 'every listed category\u2019s regions (folded ones too)'} as BED (categories as track lines)`} data-testid="region-export-bed"><Download size={12} aria-hidden="true" /> Export BED</button>
        <div className="relative">
          <button type="button" className={BTN} aria-label="More region actions" aria-haspopup="menu" onClick={() => setForm(form === 'more' ? null : 'more')}><MoreHorizontal size={12} /></button>
          {form === 'more' && (
            <Popover onClose={() => setForm(null)}>
              <MenuItem onClick={() => { setForm(null); const id = store().addCategory(genome, { name: 'New category', source: 'user' }); setEditing({ kind: 'category', id }); }}
                testId="region-new-category">New category</MenuItem>
              <MenuItem danger onClick={() => {
                setForm(null);
                setPrompt({
                  text: `Forget every saved region on ${catalogName}? This can't be undone. (A dataset's amplicons are found again when it is opened.)`,
                  actions: [
                    { label: 'Forget them', kind: 'danger', run: () => { setPrompt(null); void store().resetGenome(genome); }, testId: 'region-confirm-reset' },
                    { label: 'Cancel', run: () => setPrompt(null) },
                  ],
                });
              }} testId="region-reset">
                Reset saved regions on {catalogName}…</MenuItem>
            </Popover>
          )}
        </div>
      </div>

      {/* Keyed by reference: a form opened for one never files into another's categories. */}
      {form === 'save' && <SaveViewForm key={genome} genome={genome} catalog={cat} onDone={m => { setForm(null); setStatus(m); }} />}
      {!publicMode && <DatasetScanList key={`scan-${genome}`} genome={genome} onDone={m => setStatus(m)} />}

      <div className="flex items-center gap-1 text-[11.5px]" data-testid="region-stepper">
        <button type="button" className={ICON_BTN} disabled={!stepEntries.length} onClick={() => setStatus(stepRegion(-1, genome))}
          title="Previous region (P)" aria-label="Previous region" data-testid="region-prev"><ChevronLeft size={14} /></button>
        <button type="button" className={ICON_BTN} disabled={!stepEntries.length} onClick={() => setStatus(stepRegion(1, genome))}
          title="Next region (N)" aria-label="Next region" data-testid="region-next"><ChevronRight size={14} /></button>
        <span className="min-w-0 truncate text-ink-muted" data-testid="region-step-label">
          {stepCat ? `${stepAt >= 0 ? `${stepAt + 1} / ` : ''}${stepEntries.length} in ${stepName}` : 'No regions to step through'}
        </span>
      </div>

      {prompt && (
        <div className="space-y-1.5 rounded-fb border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11.5px] text-ink dark:border-amber-700/60 dark:bg-amber-900/20"
          role="alertdialog" aria-label="Regions" data-testid="region-prompt">
          <div>{prompt.text}</div>
          <div className="flex flex-wrap gap-1">
            {prompt.actions.map((a, i) => (
              <button key={a.label} type="button" autoFocus={i === 0} onClick={a.run} data-testid={a.testId}
                className={`h-[24px] px-2 text-[11.5px] ${a.kind === 'primary' ? 'fb-btn-primary' : a.kind === 'danger' ? 'fb-btn-secondary text-red-600 dark:text-red-400' : 'fb-btn-secondary'}`}>{a.label}</button>
            ))}
          </div>
        </div>
      )}
      {status && (
        <div className="flex items-start gap-1 rounded-fb bg-gray-50 px-2 py-1 text-[11.5px] text-ink dark:bg-white/[0.05]" role="status" data-testid="region-status">
          <span className="min-w-0 flex-1">{typeof status === 'string' ? status : <RegionScanNotice {...status} />}</span>
          <button type="button" className={ICON_BTN} onClick={() => setStatus(null)} aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
      {undo && undo.changes.some(c => c.genome === genome) && (
        <div className="flex items-center gap-1 rounded-fb bg-gray-50 px-2 py-1 text-[11.5px] text-ink dark:bg-white/[0.05]" role="status" data-testid="region-undo-bar">
          <span className="min-w-0 flex-1 truncate">{undo.label}.</span>
          <button type="button" className={BTN} onClick={() => { const done = store().undoLast(); if (done) setStatus(`Undone: ${done}.`); }} data-testid="region-undo">Undo</button>
          <button type="button" className={ICON_BTN} onClick={() => store().clearUndo()} aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
      {sync === 'error' ? (
        <div className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="region-load-error">
          <span className="min-w-0 flex-1">Your saved regions on {catalogName} could not be read{loadError ? ` (${loadError})` : ''}; changes are kept in this window until they can be saved.</span>
          <button type="button" className={BTN} onClick={() => void store().ensureLoaded(genome)} data-testid="region-load-retry">Retry</button>
        </div>
      ) : savedNote && <div className="text-[11px] text-amber-700 dark:text-amber-300">{savedNote}</div>}

      {checked.size > 0 && (
        <div className="flex flex-wrap items-center gap-1 rounded-fb border border-teal-200 bg-teal-50/70 px-1.5 py-1 text-[11.5px] dark:border-teal-800/50 dark:bg-teal-900/20" data-testid="region-selection-bar">
          <span className="font-medium">{checked.size} selected</span>
          <button type="button" className={BTN} onClick={() => highlightRegionEntries(genome, selectedEntries)} data-testid="region-selection-highlight"><Highlighter size={12} aria-hidden="true" /> Highlight</button>
          <button type="button" className={BTN} disabled={!!sideBySideBlocked} onClick={() => openSideBySide(selectedEntries)}
            title={sideBySideBlocked ?? 'Open up to 8 side by side'} data-tour="regions-open-all">Open side by side</button>
          <select className="input-tool h-[24px] text-[11.5px]" value="" aria-label="Move the selected regions to" data-testid="region-selection-move"
            onChange={e => {
              const value = e.target.value;
              if (!value) return;
              if (value.startsWith('genome:')) moveTo(value.slice(7), { entryIds: [...checked] });
              else store().moveEntries(genome, [...checked], value);
              setChecked(new Set());
            }}>
            <option value="">Move to…</option>
            {orderedCategories(cat).map(o => <option key={o.category.id} value={o.category.id}>{o.path}</option>)}
            {others.length > 0 && (
              <optgroup label="Another reference">
                {others.map(g => <option key={g} value={`genome:${g}`}>The {g} catalog</option>)}
              </optgroup>
            )}
          </select>
          <button type="button" className={BTN} onClick={() => exportBed(selectedEntries, `${genome}_selected_regions`)}><Download size={12} aria-hidden="true" /> BED</button>
          <button type="button" className={`${BTN} text-red-600`} onClick={() => { store().removeEntries(genome, [...checked], { undoable: true }); setChecked(new Set()); }} data-testid="region-selection-remove"><Trash size={12} aria-hidden="true" /> Remove</button>
          <button type="button" className={ICON_BTN} onClick={() => setChecked(new Set())} aria-label="Clear the selection"><X size={12} /></button>
          {entryRows.length > 0 && (
            <button type="button" className={`${BTN} ml-auto`} onClick={() => setChecked(new Set(entryRows.map(r => r.entry.id)))}>Select all {entryRows.length.toLocaleString()}</button>
          )}
        </div>
      )}

      <div
        ref={listRef}
        className="relative min-h-[8rem] flex-1 overflow-y-auto rounded-fb border border-line bg-surface dark:border-white/10"
        onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        data-tour="regions-saved"
        data-testid="region-list"
      >
        {rows.length === 0 ? (
          <div className="p-3 text-[12px] text-ink-muted" data-testid="region-empty">
            {filter
              ? `No region on ${reference} matches “${filter}”.`
              : sync === 'loading'
                ? 'Reading your saved regions…'
                : 'No saved regions on this reference yet. Save the view, import a BED file, or find a dataset’s regions. An amplicon dataset’s amplicons are listed here when it opens.'}
          </div>
        ) : (
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {visible.map((row, i) => (
              <div key={row.type === 'category' ? `c:${row.category.id}` : `e:${row.entry.id}`}
                style={{ position: 'absolute', top: (first + i) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}>
                {row.type === 'category' ? categoryRow(row) : entryRow(row)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function prevSibling(catalog: RegionCatalog, category: RegionCategory): string | null {
  const siblings = catalog.categories.filter(c => (c.parent ?? null) === (category.parent ?? null));
  const at = siblings.findIndex(c => c.id === category.id);
  return at > 0 ? siblings[at - 1].id : category.id;
}

function nextAfter(catalog: RegionCatalog, category: RegionCategory): string | null {
  const siblings = catalog.categories.filter(c => (c.parent ?? null) === (category.parent ?? null));
  const at = siblings.findIndex(c => c.id === category.id);
  if (at < 0 || at >= siblings.length - 1) return category.id;
  const after = siblings[at + 2];
  return after ? after.id : null;
}
