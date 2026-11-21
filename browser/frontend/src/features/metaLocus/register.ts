/**
 * The meta-locus's hooks into the normal browser (ARCHITECTURE.md extension points): two read-menu items on the meta
 * contig ("Open this site", "Find more like this"). Called once from features/register.ts.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { item, registerReadMenuContribution } from '../../components/tracks/read-track/readMenuModel';
import { isMetaChrom } from './metaChrom';
import { findMoreLikeThis, isMetaHistoryPayload, metaHistoryPayload, restoreMetaFromHistory, selectedReadsByDataset } from './metaLocusStore';
import { findMoreWords } from './MetaLocusBar';
import type { MetaReadProvenance } from './types';
import { registerMetaLocusPreview } from './preview';

/** Open a read's site at its real locus (the meta-locus stays for Back). */
export function openSite(meta: MetaReadProvenance | undefined | null): boolean {
  if (!meta?.chrom || !meta.window) return false;
  const s = useBrowserStore.getState();
  // A jump: navigation Back returns to the meta-locus view with its pool and working set (the history entry keeps
  // them); the "↩" control does too.
  const [start, end] = meta.window;
  const payload = metaHistoryPayload();
  s.pushViewportHistory({ chrom: s.chrom, start: s.start, end: s.end, pan: false, ...(payload ? { meta: payload } : {}) });
  s.setViewport(meta.chrom, start, end);
  return true;
}

/** Back onto a history entry that left a meta-locus: restore its working set (see restoreMetaFromHistory). */
function watchHistory(): void {
  useBrowserStore.subscribe((state, previous) => {
    if (state.historyIndex === previous.historyIndex && state.chrom === previous.chrom) return;
    if (state.historyIndex < 0) return;
    const entry = state.viewportHistory[state.historyIndex];
    if (!entry || !isMetaHistoryPayload(entry.meta) || !isMetaChrom(state.chrom) || entry.chrom !== state.chrom) return;
    void restoreMetaFromHistory(entry.meta);
  });
}

let done = false;

export function registerMetaLocus(): void {
  if (done) return;
  done = true;
  // A Preview feature (3.1.0): its way in (Open BED as meta-locus…) hides while previews are off; a meta-locus a
  // session brings keeps working.
  registerMetaLocusPreview();
  watchHistory();
  registerReadMenuContribution({
    id: 'meta-locus',
    readItems: ctx => {
      if (!isMetaChrom(useBrowserStore.getState().chrom)) return [];
      const entries = [];
      if (ctx.readId) entries.push(item('ext:meta-locus:open-site', 'Open this site', 'target', { title: "This read's site at its real locus (Back returns here)" }));
      const n = ctx.selectedCount || (ctx.readId ? 1 : 0);
      if (n > 0) {
        entries.push(item('ext:meta-locus:find-more', `Find more like this${ctx.selectedCount ? ` (${ctx.selectedCount.toLocaleString()} selected)` : ''}`, 'search', {
          title: 'Scan the pool for reads like these: matches / read-site observations scanned, with a Wilson 95% interval; the display becomes enriched',
        }));
      }
      return entries;
    },
    run: async (action, ctx) => {
      if (action === 'ext:meta-locus:open-site') {
        if (!openSite(ctx.read?.meta)) ctx.say('This read has no site');
        return;
      }
      if (action === 'ext:meta-locus:find-more') {
        let ids = selectedReadsByDataset();
        if (!Object.keys(ids).length && ctx.read) ids = { [ctx.datasetId]: [ctx.read.id] };
        ctx.say('Scanning the pool…');
        const result = await findMoreLikeThis(ids);
        if (result) ctx.say(findMoreWords(result));
      }
    },
  });
}
