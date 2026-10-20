/**
 * One molecule hovered across a live-lift panel and its linked source panel (DESIGN_LIVE_LIFT.md §5.3): the shared
 * `liftHover` store drives the outline of that molecule's rows in both panels and its line in the ribbon.
 *
 * Identity is the molecule, not the QNAME: the lifted dataset, the source BAM (library index in the dataset's paths)
 * and the QNAME. A lifted row says its library (`live_lift.library`); a native row of the linked source panel is
 * from the same files, so its library is its `library_id` among them (a single-file dataset: the only one).
 */
import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { readBodyExtent } from '../../../components/tracks/read-track/readExtent';
import type { CompactRead } from '../../../components/tracks/read-track/types';
import type { Dataset, PanelConfig } from '../../../types';

export interface LiftHover {
  key: string;
  /** The lifted dataset whose panels and links share it. */
  datasetId: string;
  /** The panel the pointer is in. */
  panelId: string;
  /** Where the molecule is in each frame, when known (the ribbon's line). */
  target?: { chrom: string; start: number; end: number };
  source?: { chrom: string; start: number; end: number };
}

export const useLiftHover = create<{ hover: LiftHover | null; set: (h: LiftHover | null) => void; clear: (panelId: string) => void }>(set => ({
  hover: null,
  set: hover => set(s => (sameHover(s.hover, hover) ? s : { hover })),
  clear: panelId => set(s => (s.hover?.panelId === panelId ? { hover: null } : s)),
}));

function sameHover(a: LiftHover | null, b: LiftHover | null): boolean {
  if (!a || !b) return a === b;
  return a.key === b.key && a.panelId === b.panelId;
}

export const moleculeKey = (datasetId: string, library: number, qname: string) => `${datasetId}\u0000${library}\u0000${qname}`;

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The library index of a native row among the lifted dataset's files (0 for a single file; -1: not one of them). */
export function nativeLibrary(read: CompactRead, lifted: Dataset): number {
  const paths = lifted.paths?.length ? lifted.paths : [lifted.path];
  const lib = (read as { library_id?: string }).library_id;
  if (paths.length === 1 || !lib) return paths.length === 1 ? 0 : -1;
  const exact = paths.indexOf(lib);
  if (exact >= 0) return exact;
  // library_id is the resolved path; the dataset may list the path as given.
  const byName = paths.map((p, i) => [basename(p), i] as const).filter(([b]) => b === basename(lib));
  return byName.length === 1 ? byName[0][1] : -1;
}

/**
 * Which lifted dataset a panel shares hovers with: its own (a lifted panel with a linked source panel open), or its
 * link's (a linked source panel). Null: the panel takes no part.
 */
export function hoverScope(panel: PanelConfig | undefined, panels: PanelConfig[], datasets: Dataset[]): { lifted: Dataset; role: 'lift' | 'source' } | null {
  if (!panel) return null;
  if (panel.liftLink) {
    const lifted = datasets.find(d => d.id === panel.liftLink!.datasetId);
    return lifted ? { lifted, role: 'source' } : null;
  }
  const own = datasets.find(d => d.id === panel.datasetId);
  if (own?.data_type !== 'bam_livelift') return null;
  return panels.some(p => p.liftLink?.datasetId === own.id) ? { lifted: own, role: 'lift' } : null;
}

/** A row's molecule key in its panel's role (null: it can't be matched). */
export function rowMoleculeKey(read: CompactRead, scope: { lifted: Dataset; role: 'lift' | 'source' }): string | null {
  if (scope.role === 'lift') {
    const ll = read.live_lift as { library?: number } | undefined;
    if (!ll) return null;
    return moleculeKey(scope.lifted.id, ll.library ?? 0, read.id);
  }
  const lib = nativeLibrary(read, scope.lifted);
  return lib < 0 ? null : moleculeKey(scope.lifted.id, lib, read.id);
}

/** The rows of a panel that are the hovered molecule (object identity: two libraries may share a QNAME). */
export function hoveredRows(reads: readonly CompactRead[], scope: { lifted: Dataset; role: 'lift' | 'source' } | null,
  hover: LiftHover | null): Set<CompactRead> | undefined {
  if (!scope || !hover || hover.datasetId !== scope.lifted.id) return undefined;
  const out = new Set<CompactRead>();
  for (const r of reads) if (r.id === hover.key.slice(hover.key.lastIndexOf('\u0000') + 1) && rowMoleculeKey(r, scope) === hover.key) out.add(r);
  return out.size ? out : undefined;
}

// ── The read track's side ───────────────────────────────────────────────────


/**
 * A read track's part in the shared hover: publishes the molecule under the pointer (when the panel is a lifted panel
 * with a linked source panel, or a linked source panel) and returns the rows of this panel that are the hovered
 * molecule. `origin`: the absolute position of the rows' coordinate 0.
 */
export function useLiftHoverRows(panelId: string | null, reads: readonly CompactRead[], hovered: CompactRead | null,
  chrom: string, origin: number): Set<CompactRead> | undefined {
  const scope = useBrowserStore(useShallow(s => {
    const sc = hoverScope(s.panels.find(p => p.id === panelId), s.panels, s.datasets);
    return { lifted: sc?.lifted, role: sc?.role };
  }));
  const active = scope.lifted && scope.role ? { lifted: scope.lifted, role: scope.role } : null;
  const hover = useLiftHover(s => (active && s.hover?.datasetId === active.lifted.id ? s.hover : null));
  useEffect(() => {
    if (!panelId) return;
    const store = useLiftHover.getState();
    if (!active || !hovered) { store.clear(panelId); return; }
    const key = rowMoleculeKey(hovered, active);
    if (!key) { store.clear(panelId); return; }
    const body = readBodyExtent(hovered);
    const here = body ? { chrom, start: origin + body.lo, end: origin + body.hi } : undefined;
    const src = (hovered.live_lift as { source?: { contig: string; start: number; end: number } } | undefined)?.source;
    store.set({ key, datasetId: active.lifted.id, panelId,
      target: active.role === 'lift' ? here : undefined,
      source: active.role === 'lift' ? (src ? { chrom: src.contig, start: src.start, end: src.end } : undefined) : here });
  }, [panelId, hovered, active?.lifted.id, active?.role, chrom, origin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (panelId) useLiftHover.getState().clear(panelId); }, [panelId]);
  return useMemo(() => hoveredRows(reads, active, hover), [reads, active?.lifted.id, active?.role, hover]); // eslint-disable-line react-hooks/exhaustive-deps
}
