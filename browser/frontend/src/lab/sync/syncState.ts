import { removeMatchedGroups } from '../../utils/matchedGroupActions';
import { useBrowserStore } from '../../stores/browserStore';
import { registerStoreExtension } from '../../stores/storeExtensions';
import { useAnchorPick } from './anchors';
import { splitAtOrigin, windowKey, type ComparisonFrame } from './model';
export interface SyncState {
  comparisonFrames: ComparisonFrame[];
  activeComparisonFrameId: string | null;
  saveComparisonFrame: (frame: ComparisonFrame) => void;
  removeComparisonFrame: (id: string) => void;
  activateComparisonFrame: (id: string | null) => void;
}
declare module '../../stores/browserStore' {
  interface BrowserState extends SyncState {
  }
}
type SavedWindow = ComparisonFrame['windows'][number];
const isInterval = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] < v[1];
/** Frames saved before block maps were one rigid block per window. */
function withBlocks(w: SavedWindow, length: number): SavedWindow {
  if (!w || typeof w !== 'object')
    return w;
  return Array.isArray(w.blocks) ? w : { ...w, blocks: [{ frame: [0, length], genomic: [w.start, w.end] }] };
}
/** Blocks may not overlap in the frame or in the genome, run in the window's strand order, and
 * (on a circular contig) never straddle its origin. */
function consistentBlocks(w: SavedWindow) {
  const byFrame = [...w.blocks].sort((a, b) => a.frame[0] - b.frame[0]);
  for (let i = 1; i < byFrame.length; i++) {
    const a = byFrame[i - 1], b = byFrame[i];
    if (a.frame[1] > b.frame[0])
      return false;
    if (w.strand === '+' ? a.genomic[1] > b.genomic[0] : b.genomic[1] > a.genomic[0])
      return false;
  }
  return !w.contigLength || w.blocks.every(b => Math.floor(b.genomic[0] / w.contigLength!) === Math.floor((b.genomic[1] - 1) / w.contigLength!));
}
function validWindow(w: SavedWindow, length: number) {
  return w && typeof w.panelId === 'string' && typeof w.datasetId === 'string' && typeof w.chrom === 'string' && (w.genome === null || typeof w.genome === 'string') &&
    Number.isInteger(w.start) && w.start >= 0 && Number.isInteger(w.end) && ['+', '-'].includes(w.strand) && w.provenance && Number.isFinite(w.provenance.score) &&
    (w.copy === undefined || /^[a-z]$/.test(w.copy)) && (w.contigLength === undefined || (Number.isInteger(w.contigLength) && w.contigLength > 0)) &&
    w.blocks.length > 0 && w.blocks.every(b => isInterval(b?.frame) && isInterval(b?.genomic) && b.frame[0] >= 0 && b.frame[1] <= length &&
      b.frame[1] - b.frame[0] === b.genomic[1] - b.genomic[0] && b.genomic[0] >= w.start && b.genomic[1] <= w.end) && consistentBlocks(w);
}
/** Reject malformed frames on restore rather than turning them into a different comparison. */
export function restoreSync(saved?: Record<string, unknown>) {
  const frames = (Array.isArray(saved?.comparisonFrames) ? saved.comparisonFrames : [])
    .filter((f): f is ComparisonFrame => !!f && Array.isArray(f.windows) && Number.isInteger(f.length) && f.length > 0 && f.windows.every((w: unknown) => !!w && typeof w === 'object'))
    .map(f => ({ ...f, windows: f.windows.map((w: SavedWindow) => withBlocks(w, f.length)) }))
    .filter(f => typeof f.id === 'string' && typeof f.name === 'string' && Number.isInteger(f.version) && f.version > 0 &&
      ['draft', 'accepted'].includes(f.status) && Array.isArray(f.alignedOn) && f.windows.length >= 2 &&
      f.windows.some(w => w?.panelId === f.templatePanelId && (!w.copy || w.provenance?.metric?.split(' + ')[0] === 'template')) && f.windows.every(w => validWindow(w, f.length)) &&
      new Set(f.windows.map(windowKey)).size === f.windows.length);
  return { comparisonFrames: frames, activeComparisonFrameId: frames.some(f => f.id === saved?.activeComparisonFrameId && f.status === 'accepted') ? saved!.activeComparisonFrameId as string : null };
}
/** Lab session state uses the browser's zustand extension, including autosave and undo. */
export function registerSyncState() {
  registerStoreExtension({
    id: 'lab.sync', keys: ['comparisonFrames', 'activeComparisonFrameId'],
    create: (set, get) => ({
      comparisonFrames: [], activeComparisonFrameId: null,
      saveComparisonFrame: (frame: ComparisonFrame) => set(s => {
        const old = s.comparisonFrames.find(f => f.id === frame.id);
        const next = { ...frame, version: old ? old.version + 1 : 1 };
        if (!restoreSync({ comparisonFrames: [next] }).comparisonFrames.length)
          throw new Error('Invalid comparison frame');
        if (next.status === 'accepted') {
          s.upsertMatchedGroup({ id: `matched-${next.id}`, name: next.name,
            matchGroup: { origin: 'sync', frameId: next.id, frameVersion: next.version },
            regions: next.windows.map((w, i) => {
              const blocks = splitAtOrigin(w.blocks, w.strand, w.contigLength).map(b => ({ ...b,
                genomic: (w.contigLength ? [b.genomic[0] % w.contigLength, (b.genomic[0] % w.contigLength) + b.genomic[1] - b.genomic[0]] : b.genomic) as [number, number] }));
              return { start: Math.min(...blocks.map(b => b.genomic[0])), end: Math.max(...blocks.map(b => b.genomic[1])),
                index: i, chrom: w.chrom, genome: w.genome ?? undefined, isCustom: false,
                match: { template: w.panelId === next.templatePanelId && (!w.copy || w.provenance?.metric?.split(' + ')[0] === 'template'), groupId: `matched-${next.id}`, label: w.tag || `W${[...new Set(next.windows.map(w => w.panelId))].indexOf(w.panelId) + 1}${w.copy ?? ''}`, reversed: w.strand === '-',
                  length: next.length, blocks, wrapsOrigin: !!w.contigLength && new Set(w.blocks.map(b => Math.floor(b.genomic[0] / w.contigLength!))).size > 1, panelId: w.panelId, datasetId: w.datasetId, copy: w.copy } };
            }) });
        }
        return {
          comparisonFrames: [...s.comparisonFrames.filter(f => f.id !== next.id), next],
          activeComparisonFrameId: next.status === 'accepted' ? next.id : s.activeComparisonFrameId === next.id ? null : s.activeComparisonFrameId
        };
      }),
      removeComparisonFrame: (id: string) => {
        const s = get();
        const rule = s.peakRules.find(r => r.matchGroup?.frameId === id);
        if (rule) { removeMatchedGroups(rule.id); return; }
        set(s => ({ comparisonFrames: s.comparisonFrames.filter(f => f.id !== id),
          activeComparisonFrameId: s.activeComparisonFrameId === id ? null : s.activeComparisonFrameId }));
      },
      activateComparisonFrame: (id: string | null) => set(s => ({ activeComparisonFrameId: s.comparisonFrames.some(f => f.id === id && f.status === 'accepted') ? id : null })),
    }),
    onPeakRuleChange: (s, id, updates) => {
      const frameId = s.peakRules.find(r => r.id === id)?.matchGroup?.frameId;
      if (!frameId) return {};
      return updates === null
        ? { comparisonFrames: s.comparisonFrames.filter(f => f.id !== frameId), activeComparisonFrameId: s.activeComparisonFrameId === frameId ? null : s.activeComparisonFrameId }
        : updates.name === undefined ? {} : { comparisonFrames: s.comparisonFrames.map(f => f.id === frameId ? { ...f, name: updates.name! } : f) };
    },
    serialize: s => ({ comparisonFrames: s.comparisonFrames, activeComparisonFrameId: s.activeComparisonFrameId }),
    restoreSnapshot: restoreSync, importSession: restoreSync,
    onSessionImport: () => useAnchorPick.setState(s => ({ panelId: null, anchors: {}, epoch: s.epoch + 1 })),
  });
}
/** The active accepted frame; consumers must preserve its version with their results. */
export function getActiveFrame(): Readonly<ComparisonFrame> | null { const s = useBrowserStore.getState(); return s.comparisonFrames?.find(f => f.id === s.activeComparisonFrameId) ?? null; }
/** Reactive, read-only access to the accepted comparison frame. */
export function useActiveFrame(): Readonly<ComparisonFrame> | null { return useBrowserStore(s => s.comparisonFrames?.find(f => f.id === s.activeComparisonFrameId) ?? null); }
