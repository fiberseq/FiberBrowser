/**
 * Session links in the page: read the link from the address bar, then apply
 * what the server opened (genome, datasets, tracks, locus).
 *
 *   /?open_link=<id>             a link the server already holds (from /open,
 *                                the app's fiberbrowser:// handler or a script)
 *   /?session=<URL | data:...>   a session document (also ?sessionURL=)
 *   /?hub=<hub.txt URL>          a UCSC-style track hub (&genome= picks one)
 *
 * Nothing is loaded until the user confirms in SessionLinkDialog.
 */
import type { OpenedLink, OpenedLinkTrack } from '../api/sessionLinks';
import { searchGene } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { ensureCompositeFor } from './trackLoader';
import { genomeLoadHasFasta } from './genomeAutoload';
import { showLoadedReference } from './referenceNavigation';

export type LinkRequest =
  | { kind: 'pending'; id: string }
  | { kind: 'session' | 'hub'; value: string; genome: string | null };

const LINK_PARAMS = ['open_link', 'session', 'sessionURL', 'hub', 'genome'];

/** A ?session= value that is a session link (not a linked-window session id). */
export function isSessionLinkValue(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  if (!v) return false;
  return /^(https?:|s3:|data:)/i.test(v) || v.startsWith('{') || (v.length > 40 && /^[A-Za-z0-9_\-+/=]+$/.test(v));
}

export function linkRequestFromSearch(search: string): LinkRequest | null {
  const params = new URLSearchParams(search);
  const id = params.get('open_link');
  if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return { kind: 'pending', id };
  const genome = params.get('genome');
  const hub = params.get('hub');
  if (hub) return { kind: 'hub', value: hub, genome };
  const session = params.get('sessionURL') || params.get('session');
  if (session && isSessionLinkValue(session)) return { kind: 'session', value: session, genome };
  return null;
}

/** The link this page was opened with (read before the dialog scrubs the address bar). */
export const STARTUP_LINK_REQUEST: LinkRequest | null =
  typeof window === 'undefined' ? null : linkRequestFromSearch(window.location.search);

export interface LinkOutcome {
  /** A reference was loaded (the genome auto-load must not replace it). */
  genomeLoaded: boolean;
}

let resolveOutcome: (outcome: LinkOutcome) => void = () => {};
/** Settles when the startup link is opened, cancelled or fails. */
export const startupLinkOutcome: Promise<LinkOutcome> = new Promise(resolve => { resolveOutcome = resolve; });

export function settleStartupLink(outcome: LinkOutcome): void {
  resolveOutcome(outcome);
}

export function hasLinkRequest(search: string = typeof window === 'undefined' ? '' : window.location.search): boolean {
  return linkRequestFromSearch(search) !== null;
}

/** Take the link out of the address bar (and history): it may carry a pre-signed URL. */
export function scrubLinkParams(): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of LINK_PARAMS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch { /* keep the address as it is */ }
}

// Opened links whose files may expire: the status banner polls only then.
let openedLinks = 0;
const openedListeners = new Set<() => void>();

export function linksOpenedCount(): number {
  return openedLinks;
}

export function onLinkOpened(listener: () => void): () => void {
  openedListeners.add(listener);
  return () => openedListeners.delete(listener);
}

function registerOpenedTrack(track: OpenedLinkTrack): void {
  const store = useBrowserStore.getState();
  const kind = track.kind === 'bigbed' ? 'bigbed' : 'bigwig';
  const catalogEntryId = store.addCatalogEntry({
    source: 'online',
    kind,
    label: track.label,
    url: track.url,
    loaded: true,
    trackIndex: track.track_index,
  });
  const compositeId = ensureCompositeFor(catalogEntryId, { label: track.label, source: 'online', kind });
  if (track.color) {
    const composite = useBrowserStore.getState().compositeTracks.find(c => c.id === compositeId);
    const source = composite?.sources[0];
    if (composite && source) useBrowserStore.getState().updateSource(composite.id, source.id, { color: track.color });
  }
}

// A link chose where to look: the server's default start position (Browser.tsx,
// applied on the first refresh after datasets load) must not replace it.
let linkViewportChosen = false;

export function linkChoseViewport(): boolean {
  return linkViewportChosen;
}

async function goToLocus(locus: OpenedLink['locus']): Promise<boolean> {
  if (!locus) return false;
  const store = useBrowserStore.getState();
  if (locus.chrom && typeof locus.start === 'number' && typeof locus.end === 'number') {
    linkViewportChosen = true;
    store.setViewport(locus.chrom, locus.start, locus.end);
    return true;
  }
  try {
    const found = await searchGene(locus.text);
    if (found.found && found.chrom && typeof found.start === 'number' && typeof found.end === 'number') {
      linkViewportChosen = true;
      const pad = Math.max(500, Math.round((found.end - found.start) * 0.1));
      store.setViewport(found.chrom, Math.max(0, found.start - pad), found.end + pad);
      return true;
    }
  } catch { /* no genes loaded */ }
  return false;
}

/** Show what the server opened: reference, datasets, tracks and the locus. */
export async function applyOpenedLink(result: OpenedLink): Promise<{ locusFound: boolean }> {
  const store = useBrowserStore.getState();
  const genome = result.genome;
  if (genome?.loaded) {
    if (genome.kind === 'catalog' && genome.id) {
      store.setHasFasta(genome.has_fasta ?? genomeLoadHasFasta(genome as any));
      store.setFastaPath(null);
      store.setCurrentGenome(genome.id);
    } else {
      store.setHasFasta(true);
      store.setFastaPath(genome.url ?? null);
      store.setCurrentGenome(genome.inferred_genome ?? null);
    }
    await showLoadedReference();
  } else if (result.plasmids?.length) {
    await showLoadedReference();
  }
  for (const dataset of result.datasets ?? []) useBrowserStore.getState().addDataset(dataset);
  for (const track of result.tracks ?? []) registerOpenedTrack(track);
  const locusFound = await goToLocus(result.locus);
  useBrowserStore.getState().triggerRefresh();
  if ((result.opened ?? 0) > 0) {
    openedLinks += 1;
    openedListeners.forEach(listener => listener());
  }
  return { locusFound };
}

export function formatBytes(size: number | null | undefined): string | null {
  if (size == null || !Number.isFinite(size)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "Open 12 tracks from data.example.org?" */
export function confirmQuestion(count: number, hosts: string[]): string {
  const what = `${count} ${count === 1 ? 'track' : 'tracks'}`;
  if (hosts.length === 0) return `Open ${what}?`;
  if (hosts.length === 1) return `Open ${what} from ${hosts[0]}?`;
  return `Open ${what} from ${hosts[0]} and ${hosts.length - 1} other ${hosts.length === 2 ? 'host' : 'hosts'}?`;
}
