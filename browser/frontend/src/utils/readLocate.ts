/**
 * Going to reads by name (fb-r4-clicks): find them in the open datasets
 * (POST /api/reads/locate, services/read_locate.py), show the read whole in
 * the panel that has it, and highlight it.
 *
 * The search widens one step at a time: the view, its chromosome, then every
 * other contig (most reads first). Each step says what it searches
 * (`onProgress`) and an AbortSignal cancels between and during steps (the
 * server stops when the request goes away).
 */
import { fetchJson } from '../api/sharedFetch';
import { useBrowserStore } from '../stores/browserStore';
import { useReadActionsStore } from '../stores/readActionsStore';
import { describeReadNames } from './readNames';
import { beginNavigationIntent, type NavigationIntent, type NavigationTarget } from './search/navigationIntent';
import { panelGenomeKey } from './regionNavigation';
import type { PanelConfig } from '../types';

export type LocateScope = 'region' | 'chrom' | 'genome';

export interface ReadHit {
  name: string;
  read_id: string;
  dataset_id: string;
  chrom: string;
  start: number;
  end: number;
  strand: '+' | '-' | null;
  supplementary?: boolean;
}

/** A file the server could not read (no index, gone, no access): its reads were not looked at. */
export interface LocateError {
  dataset_id: string | null;
  path: string;
  error: string;
}

interface LocateResponse {
  scope: LocateScope;
  found: ReadHit[];
  not_found: string[];
  /** Over the server's per-request limit: not looked for (sent again in the next chunk). */
  not_searched?: string[];
  complete: boolean;
  errors?: LocateError[];
}

/** Names per request (services/read_locate.py MAX_NAMES): longer lists go in chunks. */
export const LOCATE_MAX_NAMES = 2000;

export interface LocateResult {
  found: ReadHit[];
  notFound: string[];
  /** Every scope was searched to its end (no budget ran out, every file was read). */
  complete: boolean;
  cancelled: boolean;
  /** Files that could not be read (one per dataset and path). */
  errors: LocateError[];
}

export interface LocateOptions {
  /** Where the search starts (the view the box belongs to). */
  viewport?: { chrom: string; start: number; end: number } | null;
  datasetIds?: string[];
  signal?: AbortSignal;
  onProgress?: (scope: LocateScope, label: string) => void;
  /** Seconds per step on the server. */
  budgetS?: number;
}

const SCOPE_LABEL: Record<LocateScope, (chrom?: string) => string> = {
  region: () => 'Searching the view…',
  chrom: (chrom) => `Searching ${chrom ?? 'this chromosome'}…`,
  genome: () => 'Searching every chromosome…',
};

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

/** Find reads by name, widening the search until all are found. */
export async function locateReads(names: string[], options: LocateOptions = {}): Promise<LocateResult> {
  const { viewport, datasetIds, signal, onProgress, budgetS } = options;
  const remaining = new Set(names);
  const found: ReadHit[] = [];
  const fallback = new Map<string, ReadHit>();
  const errors = new Map<string, LocateError>();
  let complete = true;
  const scopes: LocateScope[] = viewport ? ['region', 'chrom', 'genome'] : ['genome'];
  const stopped = () => ({ found, notFound: [...remaining].filter(n => !fallback.has(n)), complete: false, cancelled: true, errors: [...errors.values()] });
  for (const scope of scopes) {
    if (remaining.size === 0) break;
    if (signal?.aborted) return stopped();
    onProgress?.(scope, SCOPE_LABEL[scope](viewport?.chrom));
    // The server looks at LOCATE_MAX_NAMES names per request: a longer list goes in chunks (none left unsearched).
    const asked = [...remaining];
    for (let at = 0; at < asked.length; at += LOCATE_MAX_NAMES) {
      if (signal?.aborted) return stopped();
      const chunk = asked.slice(at, at + LOCATE_MAX_NAMES).filter(n => remaining.has(n));
      if (chunk.length === 0) continue;
      let res: LocateResponse;
      try {
        res = await fetchJson<LocateResponse>('/api/reads/locate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            names: chunk,
            scope,
            ...(viewport ? { chrom: viewport.chrom, start: viewport.start, end: viewport.end } : {}),
            ...(datasetIds?.length ? { dataset_ids: datasetIds } : {}),
            ...(budgetS ? { budget_s: budgetS } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (isAbort(err) || signal?.aborted) return stopped();
        throw err;
      }
      for (const hit of res.found ?? []) {
        if (!remaining.has(hit.name)) continue;
        if (hit.supplementary) {
          // Only a supplementary alignment here: the read's primary one may be
          // further out (the browser draws primary alignments).
          if (!fallback.has(hit.name)) fallback.set(hit.name, hit);
          continue;
        }
        remaining.delete(hit.name);
        fallback.delete(hit.name);
        found.push(hit);
      }
      for (const e of res.errors ?? []) errors.set(`${e.dataset_id}\u0000${e.path}`, e);
      // Names the server did not look at (over its limit): the search is not complete.
      if (!res.complete || (res.not_searched?.length ?? 0) > 0) complete = false;
    }
  }
  // No primary alignment anywhere: the supplementary one is all there is.
  for (const [name, hit] of fallback) {
    if (!remaining.has(name)) continue;
    remaining.delete(name);
    found.push(hit);
  }
  // In the order asked.
  const order = new Map(names.map((n, i) => [n, i]));
  found.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return { found, notFound: names.filter(n => remaining.has(n)), complete, cancelled: false, errors: [...errors.values()] };
}

/** A read's whole span with a margin (none when the view keeps only full-length reads: it must span the view). */
export function readWindow(hit: { start: number; end: number }, spanningOnly: boolean): { start: number; end: number } {
  if (spanningOnly) return { start: hit.start, end: Math.max(hit.end, hit.start + 1) };
  const length = Math.max(1, hit.end - hit.start);
  const margin = Math.max(100, Math.round(length * 0.1));
  return { start: Math.max(0, hit.start - margin), end: hit.end + margin };
}

/**
 * The window showing every hit on the first hit's chromosome (a list of reads
 * on one locus). The hits must be on one reference (goToReads groups them:
 * two assemblies can both call a contig chr1).
 */
export function windowForHits(hits: ReadHit[], spanningOnly: boolean, maxSpan = 2_000_000): { chrom: string; start: number; end: number } | null {
  if (hits.length === 0) return null;
  const chrom = hits[0].chrom;
  const same = hits.filter(h => h.chrom === chrom);
  const start = Math.min(...same.map(h => h.start));
  const end = Math.max(...same.map(h => h.end));
  if (end - start > maxSpan || spanningOnly) return { chrom, ...readWindow(hits[0], spanningOnly) };
  return { chrom, ...readWindow({ start, end }, false) };
}

const keyOf = (p: PanelConfig) => p.stateKey ?? p.datasetId ?? p.id;

/** Dataset panels showing a dataset (shown ones first). */
export function panelsForDataset(panels: PanelConfig[], datasetId: string): PanelConfig[] {
  return panels
    .filter(p => p.contentType === 'dataset' && p.datasetId === datasetId)
    .sort((a, b) => Number(Boolean(a.collapsed)) - Number(Boolean(b.collapsed)));
}

/**
 * The navigation intent of an action on a read panel (Zoom to read): the view
 * that panel shows (its own locus, else the main view). Take it before the
 * lookup; its answer moves nothing once that view moved, another Go to was
 * asked, or another session was opened (navigationIntent).
 */
export function beginReadPanelIntent(stateKey: string): NavigationIntent {
  const panel = useBrowserStore.getState().panels.find(p => p.contentType === 'dataset' && keyOf(p) === stateKey);
  return beginNavigationIntent(panel?.viewportOverride ? { panelId: panel.id } : 'main');
}

/** Move a panel to a locus: its own view when it navigates on its own, else the main view. */
export function navigatePanelTo(panel: PanelConfig | null | undefined, chrom: string, start: number, end: number): void {
  const store = useBrowserStore.getState();
  // A jump (Zoom to read, a read found by name): Back (Alt+←) returns to where the view was.
  store.recordJump(panel?.viewportOverride ? panel.id : null);
  if (panel?.viewportOverride) {
    store.navigatePanel(panel.id, chrom, start, end);
  } else {
    store.setViewport(chrom, start, end);
  }
}

export interface GoToReadsContext {
  /** The view of the box the names were typed in. */
  viewport?: { chrom: string; start: number; end: number } | null;
  /** The box's own navigation (a panel's box); default: the panel that has the read. */
  navigate?: (chrom: string, start: number, end: number) => void;
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
  /** Select the reads too (a list of names, or importReadNames). Default: when several names. */
  select?: boolean;
  /** Move the view to the reads. Default true. */
  navigateTo?: boolean;
  /** Look only in these datasets (a panel's box: the datasets on its reference). Default: every open dataset. */
  datasetIds?: string[];
  /** The view the answer moves (a panel's box: its panel); default the main view and the panels with their own locus. */
  target?: NavigationTarget;
}

export interface GoToReadsResult {
  ok: boolean;
  found: ReadHit[];
  notFound: string[];
  cancelled: boolean;
  message: string;
}

/** Select these read ids in every dataset panel of their datasets. */
function selectHits(hits: ReadHit[]): void {
  const store = useBrowserStore.getState();
  const byKey = new Map<string, Set<string>>();
  for (const hit of hits) {
    for (const panel of panelsForDataset(store.panels, hit.dataset_id)) {
      const key = keyOf(panel);
      if (!byKey.has(key)) byKey.set(key, new Set(store.selectedReadIds[key] ?? []));
      byKey.get(key)!.add(hit.read_id);
    }
  }
  for (const [key, ids] of byKey) store.setReadSelection(key, ids);
}

const STALE_MESSAGE = 'Not moved to the reads: the view changed while they were looked up.';

/**
 * Find the named reads, show them and highlight them. One read: its whole
 * span with a margin in the panel that has it. Several: their common window
 * when they are close together (else the first one's), all selected.
 */
export async function goToReads(names: string[], ctx: GoToReadsContext = {}): Promise<GoToReadsResult> {
  const store = useBrowserStore.getState();
  const epoch = useReadActionsStore.getState().epoch;
  const navigateTo = ctx.navigateTo !== false;
  // Taken now: a pan, a zoom, another Go to or another assembly while the reads
  // are looked up makes the answer stale (it must not jump back to them).
  const intent = navigateTo ? beginNavigationIntent(ctx.target ?? 'main') : null;
  const open0 = store.datasets.map(d => d.id).filter(Boolean);
  const datasetIds = ctx.datasetIds ? open0.filter(id => ctx.datasetIds!.includes(id)) : open0;
  if (datasetIds.length === 0) {
    return {
      ok: false, found: [], notFound: names, cancelled: false,
      message: ctx.datasetIds && open0.length
        ? 'No open dataset on this panel\'s reference: read names are looked up in its datasets.'
        : 'Open a dataset first: read names are looked up in the open datasets.',
    };
  }
  let result: LocateResult;
  try {
    result = await locateReads(names, {
      viewport: ctx.viewport ?? { chrom: store.chrom, start: store.start, end: store.end },
      datasetIds,
      signal: ctx.signal,
      onProgress: (_scope, label) => ctx.onProgress?.(label),
    });
  } catch (err) {
    return { ok: false, found: [], notFound: names, cancelled: false, message: `Read search failed: ${(err as Error)?.message ?? err}` };
  }
  // Cancelled (Cancel, the text changed), or another session or snapshot was opened meanwhile: its view is not ours to move.
  if (result.cancelled || ctx.signal?.aborted || useReadActionsStore.getState().epoch !== epoch) {
    return { ok: false, found: result.found, notFound: result.notFound, cancelled: true, message: 'Read search cancelled.' };
  }
  // The view moved (or another Go to was asked) meanwhile: neither moved back nor selected.
  if (intent && !intent.isCurrent()) {
    return { ok: false, found: result.found, notFound: result.notFound, cancelled: true, message: STALE_MESSAGE };
  }
  const open = new Set(useBrowserStore.getState().datasets.map(d => d.id).filter(id => datasetIds.includes(id)));
  const found = result.found.filter(h => open.has(h.dataset_id));
  const notFound = [...result.notFound, ...result.found.filter(h => !open.has(h.dataset_id)).map(h => h.name)];
  // Files the server could not read: their reads were not looked at (not "not found").
  const unreadable = unreadableText(result.errors ?? []);
  if (found.length === 0) {
    const partial = unreadable
      ? `; ${unreadable}, so the search is incomplete`
      : result.complete ? '' : ' (the search stopped before the end of the files: try again, or narrow it with the locus first)';
    return {
      ok: false, found, notFound, cancelled: false,
      message: names.length === 1
        ? `Read not found in the open datasets: ${names[0]}${partial}`
        : `None of the ${names.length} reads was found in the open datasets${partial}.`,
    };
  }

  const ids = found.map(h => h.read_id);
  const select = ctx.select ?? names.length > 1;

  if (navigateTo) {
    const latest = useBrowserStore.getState();
    const spanningOnly = latest.spanningOnly;
    // Reads on another assembly than the first one's (same contig name or not) never share its window:
    // the hits are grouped by reference, each group shown in its own panel.
    const panelOf = (hit: ReadHit) => panelsForDataset(latest.panels, hit.dataset_id)[0];
    const referenceOf = (hit: ReadHit) => panelGenomeKey(panelOf(hit), latest);
    const groups = new Map<string, ReadHit[]>();
    for (const hit of found) {
      const key = referenceOf(hit);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(hit);
    }
    const moves: Array<{ panel: PanelConfig | undefined; chrom: string; start: number; end: number }> = [];
    // One move per view (the main view, or a panel's own locus), in the order the names were given.
    const viewOf = (panel: PanelConfig | undefined) => (panel?.viewportOverride ? `panel:${panel.id}` : 'main');
    const taken = new Set<string>();
    for (const [i, group] of [...groups.values()].entries()) {
      const target = windowForHits(group, spanningOnly);
      if (!target) continue;
      if (ctx.navigate) {
        // A panel's box: its own reference only (its datasets were searched).
        if (i === 0) ctx.navigate(target.chrom, target.start, target.end);
        continue;
      }
      const panel = panelOf(group[0]);
      if (taken.has(viewOf(panel))) continue;
      taken.add(viewOf(panel));
      moves.push({ panel, ...target });
    }
    // The panels that have the reads, on a locus of their own: not if the user moved one meanwhile.
    const own = moves.filter(m => m.panel?.viewportOverride).map(m => ({ panelId: m.panel!.id }));
    if (own.length && intent && !intent.isCurrent(own)) {
      return { ok: false, found, notFound, cancelled: true, message: STALE_MESSAGE };
    }
    for (const m of moves) navigatePanelTo(m.panel, m.chrom, m.start, m.end);
  }
  // After moving: a jump clears the reads selected at the old locus.
  if (select) selectHits(found);
  useReadActionsStore.getState().pulseReads(ids, { scrollTo: ids[0] });

  const where = `${found[0].chrom}:${found[0].start.toLocaleString()}-${found[0].end.toLocaleString()}`;
  const supplementaryOnly = found.length === 1 && found[0].supplementary
    ? ' (only a supplementary alignment: the browser draws primary alignments)' : '';
  let message = names.length === 1
    ? `${names[0]} at ${where}${supplementaryOnly}`
    : `Found ${found.length} of ${names.length} reads${select ? ' (selected)' : ''}`;
  if (notFound.length) message += `; not found: ${describeReadNames(notFound)}`;
  if (unreadable) message += `; ${unreadable}`;
  return { ok: true, found, notFound, cancelled: false, message };
}

/** "could not read napa_ddda (no index)" for the files the server could not read; '' when none. */
function unreadableText(errors: LocateError[]): string {
  if (errors.length === 0) return '';
  const datasets = useBrowserStore.getState().datasets;
  const label = (e: LocateError) => {
    const ds = datasets.find(d => d.id === e.dataset_id) as { label?: string } | undefined;
    return ds?.label || e.dataset_id || e.path.split(/[\\/]/).pop() || e.path;
  };
  const names = [...new Set(errors.map(label))];
  const why = errors[0].error ? ` (${errors[0].error})` : '';
  return `could not read ${names.length === 1 ? names[0] : `${names[0]} and ${names.length - 1} more`}${why}`;
}
