import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { panelGenomeLabel, usePanelGenomeStore } from '../../stores/panelGenomeStore';
import type { ChromInfo, PanelConfig } from '../../types';
import { ReferenceManager } from '../controls/ReferenceManager';
import { SmartSearchInput } from '../controls/SmartSearchInput';
import { isSecondaryContig } from '../controls/ChromSelector';
import { formatCoordinates } from '../../utils/coordinates';
import { mainReferenceLabel, panelFigureLocus } from '../../utils/figureRegions';
import { ArrowLeft, ArrowRight, Crosshair, Link, MatchLocus, Minus, MoreHorizontal, Plus, Unlink, X } from '../ui/Icons';
import { getTopCoveredWindows } from '../../api/coverage';
import { inGenomeLinkGroup, linkGroupPeers, matchablePanels } from '../../utils/panelNavigation';
import type { BrowserState } from '../../stores/browserStore';

export const PANEL_SITE_BAR_HEIGHT = 26;

const BTN = 'rounded px-1 py-0 text-[11px] leading-tight text-gray-600 hover:bg-white disabled:opacity-40 disabled:hover:bg-transparent dark:text-gray-300 dark:hover:bg-gray-700';

/**
 * The location box never gets narrower than this (px, with its Go button): its
 * input keeps about 140 px, enough to read a locus (audit M14: four panels left
 * it 0-60 px, "chr3R:6", "c").
 */
export const LOCUS_BOX_MIN = 176;

/** What the bar holds, for its compact layout (siteBarLevel). */
export interface SiteBarContent {
  genomeLabel: string | null;
  linkedIcon: boolean;
  name: string | null;
  showChroms: boolean;
  findReads: boolean;
  match: boolean;
  canLink: boolean;
  grouped: boolean;
}

/**
 * How compact the bar must be to keep the location box at LOCUS_BOX_MIN in
 * `width` px: 0, everything in the bar; 1, pan, zoom, Go to reads and Match go
 * to a ⋯ menu and Link shows its icon only; 2, the chromosome list goes there
 * too; 3, the reference chip and region name as well. `width` 0 (no layout yet): 0.
 */
export function siteBarLevel(width: number, c: SiteBarContent): 0 | 1 | 2 | 3 {
  if (!(width > 0)) return 0;
  const PAD = 12, GAP = 4, BUTTON = 19, MORE = 20;
  const ident = (c.genomeLabel ? 8 + 6.5 * c.genomeLabel.length : 0) + (c.linkedIcon ? 11 + GAP : 0)
    + (c.name ? 6.6 * c.name.length + GAP : 0);
  const chroms = c.showChroms ? 72 + GAP : 0;
  const close = c.grouped ? BUTTON + GAP : 0;
  const tools = (c.findReads ? BUTTON + GAP : 0) + (c.match ? BUTTON + GAP : 0) + 4 * (17 + GAP);
  const need = [
    PAD + ident + chroms + LOCUS_BOX_MIN + GAP + tools + (c.canLink ? 54 + GAP : 0) + close,
    PAD + ident + chroms + LOCUS_BOX_MIN + GAP + MORE + (c.canLink ? 20 + GAP : 0) + close,
    PAD + ident + LOCUS_BOX_MIN + GAP + MORE + (c.canLink ? 20 + GAP : 0) + close,
  ];
  const level = need.findIndex(n => n <= width);
  return (level === -1 ? 3 : level) as 0 | 1 | 2 | 3;
}

/**
 * The location box's minimum width at `level`: LOCUS_BOX_MIN, or, in a bar too narrow
 * even for that (level 3), what the ⋯, Link and Close buttons leave (never under 64 px).
 */
export function locusBoxMinWidth(width: number, c: Pick<SiteBarContent, 'canLink' | 'grouped'>, level: number): number {
  if (level < 3 || !(width > 0)) return LOCUS_BOX_MIN;
  const rest = 12 + 4 + 20 + (c.canLink ? 20 + 4 : 0) + (c.grouped ? 19 + 4 : 0);
  return Math.max(64, Math.min(LOCUS_BOX_MIN, Math.floor(width - rest)));
}

/** The bar's width in its own (unzoomed) px, kept up to date (`mountKey`: re-attach when the bar is drawn anew). */
function useBarWidth(mountKey: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.offsetWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mountKey]);
  return [ref, width] as const;
}

/** Where the ⋯ menu goes: right-aligned under its button, in the tracks area (outside the panel, which clips). */
function menuPlace(trigger: HTMLElement): { host: HTMLElement; style: CSSProperties } {
  const host = (trigger.closest('[data-export-container]') as HTMLElement | null) ?? document.body;
  const t = trigger.getBoundingClientRect();
  if (host === document.body) {
    return { host, style: { position: 'fixed', top: t.bottom + 2, right: Math.max(4, window.innerWidth - t.right) } };
  }
  // The tracks area is zoomed by the UI size: screen px -> its own px.
  const h = host.getBoundingClientRect();
  const zoom = host.offsetWidth > 0 ? h.width / host.offsetWidth : 1;
  return { host, style: { position: 'absolute', top: (t.bottom - h.top) / zoom + 2, right: Math.max(4, (h.right - t.right) / zoom) } };
}

/**
 * The compact bar's ⋯ menu: the controls that didn't fit. Opens with the first item
 * focused (arrow keys move); a pick, Escape or a click elsewhere closes it and gives
 * the focus back to ⋯. Drawn over the tracks area, so a narrow panel can't clip it.
 */
function SiteBarMenu({ children }: { children: ReactNode }) {
  const [place, setPlace] = useState<{ host: HTMLElement; style: CSSProperties } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = place !== null;
  const close = (refocus: boolean) => {
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  };
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [data-testid="panel-genome-chip"], select') ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const inside = (target: EventTarget | null) => Boolean(target instanceof Node
      && (menuRef.current?.contains(target) || triggerRef.current?.contains(target)));
    const onPointer = (event: PointerEvent) => { if (!inside(event.target)) close(false); };
    const onScroll = (event: Event) => { if (!inside(event.target)) close(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (!menuRef.current?.contains(document.activeElement) || document.activeElement instanceof HTMLSelectElement) return;
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative ml-auto shrink-0">
      <button ref={triggerRef} type="button" className={BTN}
        onClick={() => (open ? close(false) : triggerRef.current && setPlace(menuPlace(triggerRef.current)))}
        aria-label="More location controls" aria-haspopup="menu" aria-expanded={open}
        title="More: pan, zoom and the rest of this panel's location controls" data-testid="panel-site-more">
        <MoreHorizontal size={13} aria-hidden="true" />
      </button>
      {place && createPortal(
        <div ref={menuRef} role="menu" aria-label="Location controls" className="fb-menu !right-auto !top-auto !mt-0 !min-w-[12rem]"
          style={place.style} data-testid="panel-site-menu"
          onMouseDown={event => event.stopPropagation()}
          onClickCapture={event => {
            const target = event.target as HTMLElement;
            // The reference dialog takes focus after this menu has closed.
            if (target.closest('[data-testid="panel-genome-chip"]')) { close(false); return; }
            if (target.closest('button[role="menuitem"]')) window.setTimeout(() => close(true), 0);
          }}>
          {children}
        </div>,
        place.host,
      )}
    </div>
  );
}

function SiteMenuItem({ icon, children, onSelect, disabled, title, testId }: {
  icon: ReactNode; children: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; testId?: string;
}) {
  return (
    <button type="button" role="menuitem" className="fb-menu-item disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={onSelect} disabled={disabled} title={title} data-testid={testId}>
      <span className="flex w-4 justify-center text-ink-muted" aria-hidden="true">{icon}</span>
      {children}
    </button>
  );
}

/** Name worth showing next to the location (contact loci, named regions). */
function siteName(panel: PanelConfig): string | null {
  if (panel.contactRegionRole) return panel.regionLabel ?? (panel.contactRegionRole === 'x' ? 'Locus X' : 'Locus Y');
  const label = panel.regionLabel;
  if (!label || label === 'Independent' || label.includes(':')) return null;
  return label;
}

/**
 * What "Match other panels to this location" would do for a panel: 'none' (no
 * other dataset panel on its reference), 'same' (they are all there already),
 * 'move'.
 */
export function matchState(st: Pick<BrowserState, 'panels' | 'chrom' | 'start' | 'end' | 'navigationMode'>, panelId: string): 'none' | 'same' | 'move' {
  const panel = st.panels.find(p => p.id === panelId);
  if (!panel) return 'none';
  const others = matchablePanels(st.panels, panel);
  if (others.length === 0) return 'none';
  const main = { chrom: st.chrom, start: st.start, end: st.end };
  const at = panel.viewportOverride ?? main;
  const there = (v: { chrom: string; start: number; end: number }) => v.chrom === at.chrom && v.start === at.start && v.end === at.end;
  // A panel following the main view moves with it (only in Linked navigation; Per panel gives each its own locus).
  return others.every(p => there(p.viewportOverride ?? main)) ? 'same' : 'move';
}

/** The panel's chromosome: its reference's primary ones (and the one shown). */
function PanelChromSelect({ chroms, chrom, onPick, className = 'max-w-[92px] shrink-0' }: { chroms: ChromInfo[]; chrom: string; onPick: (info: ChromInfo) => void; className?: string }) {
  const listed = useMemo(() => {
    const primary = chroms.some(c => !isSecondaryContig(c.name)) ? chroms.filter(c => !isSecondaryContig(c.name)) : chroms;
    const shown = primary.slice(0, 300);
    const current = chroms.find(c => c.name === chrom);
    return current && !shown.includes(current) ? [current, ...shown] : shown;
  }, [chroms, chrom]);
  if (listed.length === 0) return null;
  return (
    <select
      value={listed.some(c => c.name === chrom) ? chrom : ''}
      onChange={e => {
        const info = chroms.find(c => c.name === e.target.value);
        if (info) onPick(info);
      }}
      onMouseDown={e => e.stopPropagation()}
      data-testid="panel-chrom-select"
      aria-label="Chromosome of this panel"
      title="Chromosome"
      className={`${className} truncate rounded border border-gray-300 bg-white px-0.5 py-0 text-[11px] text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100`}
    >
      {!listed.some(c => c.name === chrom) && <option value="" disabled>{chrom}</option>}
      {listed.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
    </select>
  );
}

/**
 * Navigation for a panel with its own locus: a location box (gene or
 * coordinates, like the main search) and pan/zoom, grayed out while the panel
 * is linked to the main view, and a Link/Unlink button. A panel on another
 * assembly (panel.genome) or one given its own locus by "Each panel
 * navigates" (panel.navOwn) also has a chromosome list; the former names its
 * reference and is never linked to the main view (another assembly).
 */
export function PanelSiteBar({ panel }: { panel: PanelConfig }) {
  const [referenceOpen, setReferenceOpen] = useState(false);
  const isReversed = useBrowserStore(s => s.isReversed);
  const exporting = useBrowserStore(s => s.exportInProgress);
  const [barRef, barWidth] = useBarWidth(exporting);
  const mainChroms = useBrowserStore(s => s.chroms);
  const genomeInfo = usePanelGenomeStore(s => (panel.genome ? s.genomes[panel.genome] : undefined));
  const vpo = panel.viewportOverride!;
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useBrowserStore(s => s.pendingPanelLocationFocus);
  const ownChroms = useMemo<ChromInfo[] | undefined>(
    () => (panel.genome ? (genomeInfo?.chroms ?? []).map(c => ({ name: c.name, size: c.size, circular: c.circular })) : undefined),
    [panel.genome, genomeInfo],
  );

  useEffect(() => {
    if (pendingFocus !== panel.id) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    useBrowserStore.getState().clearPendingPanelLocationFocus();
  }, [pendingFocus, panel.id]);

  const store = useBrowserStore.getState;
  const span = vpo.end - vpo.start;
  const panBy = Math.round(span * 0.3) * (isReversed ? -1 : 1);
  // Panning into position 0 stops there instead of shrinking the window.
  const setView = (start: number, end: number) => {
    const width = Math.max(3, Math.round(end - start));
    const s = Math.max(0, Math.round(start));
    store().setPanelViewport(panel.id, s, s + width);
  };
  const zoom = (factor: number) => {
    const centre = (vpo.start + vpo.end) / 2;
    const width = Math.max(3, span * factor);
    setView(centre - width / 2, centre + width / 2);
  };
  const role = panel.contactRegionRole ?? (panel.regionLabel === 'Locus X' ? 'x' : panel.regionLabel === 'Locus Y' ? 'y' : null);
  const colors = panel.genome
    ? 'bg-violet-50 border-violet-300 dark:bg-violet-950/40 dark:border-violet-800'
    : role === 'x'
    ? 'bg-blue-50 border-blue-300 dark:bg-blue-950/40 dark:border-blue-800'
    : role === 'y'
      ? 'bg-amber-50 border-amber-300 dark:bg-amber-950/40 dark:border-amber-800'
      : 'bg-slate-50 border-slate-300 dark:bg-gray-800 dark:border-gray-600';
  const name = siteName(panel);
  const grouped = Boolean(panel.contactRegionGroupId || panel.haplotypeGroup);
  // Another assembly (never linked to the main view), or its own locus in "Each panel navigates".
  const showChroms = Boolean(panel.genome || panel.navOwn);
  const canLink = !panel.genome && !panel.navOwn;
  const genomeLabel = panel.genome ? panelGenomeLabel(genomeInfo, panel.genome) : null;
  const mainLabel = useBrowserStore(s => mainReferenceLabel(s));
  const match = useBrowserStore(s => matchState(s, panel.id));
  // Linked navigation: the other panels on this panel's reference that move with it.
  const linkedWith = useBrowserStore(s => (inGenomeLinkGroup(panel) ? linkGroupPeers(s.panels, panel, s.navigationMode).length - 1 : 0));
  const referenceName = genomeLabel ?? mainLabel ?? 'the main genome';
  const matchTitle = match === 'same'
    ? `The other panels on ${referenceName} are at this location already`
    : `Match other panels on ${referenceName} to this location (moves them to ${formatCoordinates(vpo.chrom, vpo.start, vpo.end)}`
      + `${panel.genome ? '' : '; in Linked navigation the main view too'}, without linking them)`;
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  // Where this dataset's reads are on the panel's reference (no main-view prompt reaches it).
  const findReads = async () => {
    if (!panel.datasetId) return;
    setFinding(true);
    setFindError(null);
    try {
      const res = await getTopCoveredWindows(Math.max(1_000, vpo.end - vpo.start), panel.datasetId, 1, { fit: true, genome: panel.genome });
      const w = res.windows?.[0];
      if (w) { store().recordJump(panel.id); store().navigatePanel(panel.id, w.chrom, w.start, w.end); }
      else setFindError(res.error || 'No reads found on this reference');
    } catch (e) {
      setFindError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinding(false);
    }
  };
  const pickChrom = (info: ChromInfo) => {
    const width = Math.min(info.size, Math.max(1_000, vpo.end - vpo.start));
    store().recordJump(panel.id);
    store().navigatePanel(panel.id, info.name, 0, width);
  };

  // Linked: moves with the main view, so its own controls are grayed out.
  const linked = !!panel.siteLocked && canLink;
  // A linked view of a haplotype comparison only says where it is: its own
  // location box and pan/zoom come back once it is unlinked (M18).
  const readOnly = linked && !!panel.haplotypeGroup;
  const where = formatCoordinates(vpo.chrom, vpo.start, vpo.end);

  // A figure has no controls: the bar says which reference and locus the panel shows.
  if (exporting) {
    return (
      <div data-testid="panel-site-bar" className={`flex min-w-0 items-center border-b px-1.5 ${colors}`} style={{ height: PANEL_SITE_BAR_HEIGHT }}>
        <span className="truncate font-mono text-[11px] text-gray-700"
          data-figure-text={panelFigureLocus({ reference: genomeLabel, name, chrom: vpo.chrom, start: vpo.start, end: vpo.end })}>
          {panelFigureLocus({ reference: genomeLabel, name, chrom: vpo.chrom, start: vpo.start, end: vpo.end })}
        </span>
      </div>
    );
  }

  const chromSelect = (className?: string) => (
    <PanelChromSelect chroms={ownChroms ?? mainChroms} chrom={vpo.chrom} onPick={pickChrom} className={className} />
  );
  const genomeChip = genomeLabel && (
    <button type="button" aria-haspopup="dialog" aria-expanded={referenceOpen}
      onClick={() => setReferenceOpen(true)}
      // A long reference name (a contig's description) shrinks and is cut with "…" (the whole of it
      // in the tooltip) before it can push into the location box: it never overlaps the coordinates.
      className="min-w-[3rem] max-w-[45%] shrink truncate rounded bg-violet-600 px-1 text-[10px] font-semibold leading-[16px] text-white dark:bg-violet-500"
      data-testid="panel-genome-chip"
      title={`Reference: ${genomeLabel} — click to manage`}
    >
      {genomeLabel}
    </button>
  );
  const linkedIcon = genomeLabel && linkedWith > 0 && (
    <span className="shrink-0 text-violet-700 dark:text-violet-300" data-testid="panel-genome-linked" role="img"
      aria-label={`Linked with ${linkedWith} other ${genomeLabel} panel${linkedWith === 1 ? '' : 's'}`}
      title={`Linked with ${linkedWith} other ${genomeLabel} panel${linkedWith === 1 ? '' : 's'}: they move together (Linked navigation). Per panel lets each move on its own.`}>
      <Link size={11} aria-hidden="true" />
    </span>
  );
  const findTitle = findError ?? "Go to this dataset's reads (its best-covered window at this zoom)";
  const panLeft = () => setView(vpo.start - panBy, vpo.end - panBy);
  const panRight = () => setView(vpo.start + panBy, vpo.end + panBy);
  // Too narrow for everything (audit M14): the location box keeps its width, the rest goes to a ⋯ menu.
  const level = readOnly ? 0 : siteBarLevel(barWidth, {
    genomeLabel, linkedIcon: Boolean(linkedIcon), name, showChroms,
    findReads: showChroms && Boolean(panel.datasetId), match: match !== 'none', canLink, grouped,
  });
  const compact = level >= 1;

  return (
    <div
      ref={barRef}
      data-reference-panel={panel.id}
      data-testid="panel-site-bar"
      data-compact={level > 0 ? String(level) : undefined}
      className={`flex min-w-0 items-center gap-1 overflow-hidden border-b px-1.5 ${colors}`}
      style={{ height: PANEL_SITE_BAR_HEIGHT }}
      onMouseDown={e => e.stopPropagation()}
      title={level >= 3 ? [genomeLabel, name, where].filter(Boolean).join(' · ') : undefined}
    >
      {readOnly ? (
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-700 dark:text-gray-200"
          title={`${where}: moves with the main view. Unlink to move this view on its own.`}
          data-testid="panel-site-location"
        >
          {where}
        </span>
      ) : (
        <>
          {level < 3 && genomeChip}
          {level < 3 && linkedIcon}
          {level < 3 && name && <span className="shrink-0 text-[11px] font-semibold text-gray-700 dark:text-gray-200">{name}</span>}
          {showChroms && level < 2 && chromSelect()}
          <div className="flex min-w-0" style={{ flex: '1 1 auto', minWidth: locusBoxMinWidth(barWidth, { canLink, grouped }, level), maxWidth: '14rem' }}
            data-testid="panel-location-box">
            <SmartSearchInput
              compact
              viewport={vpo}
              onNavigate={(chrom, start, end) => store().navigatePanel(panel.id, chrom, start, end)}
              inputRef={inputRef}
              ariaLabel="Location of this panel"
              disabled={linked}
              genome={panel.genome}
              chroms={ownChroms}
              panelId={panel.id}
            />
          </div>
          {compact ? (
            <SiteBarMenu>
              {level >= 3 && (genomeLabel || name) && (
                <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] text-ink-muted">
                  {genomeChip}{linkedIcon}{name && <span className="font-semibold">{name}</span>}
                </div>
              )}
              {showChroms && level >= 2 && (
                <label className="flex items-center gap-2 px-3 py-1 text-[12px] text-gray-700 dark:text-gray-200">
                  <span>Chromosome</span>
                  {chromSelect('min-w-0 flex-1')}
                </label>
              )}
              <SiteMenuItem icon={<ArrowLeft size={13} />} onSelect={panLeft} disabled={linked}>Pan left</SiteMenuItem>
              <SiteMenuItem icon={<ArrowRight size={13} />} onSelect={panRight} disabled={linked}>Pan right</SiteMenuItem>
              <SiteMenuItem icon={<Minus size={13} />} onSelect={() => zoom(1.5)} disabled={linked}>Zoom out</SiteMenuItem>
              <SiteMenuItem icon={<Plus size={13} />} onSelect={() => zoom(1 / 1.5)} disabled={linked}>Zoom in</SiteMenuItem>
              {showChroms && panel.datasetId && (
                <SiteMenuItem icon={<Crosshair size={13} />} onSelect={() => { void findReads(); }} disabled={finding}
                  title={findTitle} testId="panel-find-reads">Go to this dataset&apos;s reads</SiteMenuItem>
              )}
              {match !== 'none' && (
                <SiteMenuItem icon={<MatchLocus size={13} />} onSelect={() => store().matchPanelsToPanel(panel.id)} disabled={match === 'same'}
                  title={matchTitle} testId="panel-match-others">Match other panels to this location</SiteMenuItem>
              )}
            </SiteBarMenu>
          ) : (
            // The location box takes the free width (up to 14rem); the tools sit at the right end.
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {showChroms && panel.datasetId && (
                <button type="button" className={BTN} onClick={() => { void findReads(); }} disabled={finding}
                  data-testid="panel-find-reads" aria-label="Go to this dataset's reads"
                  title={findTitle}>
                  <Crosshair size={11} aria-hidden="true" />
                </button>
              )}
              {match !== 'none' && (
                <button type="button" className={BTN} onClick={() => store().matchPanelsToPanel(panel.id)} disabled={match === 'same'}
                  data-testid="panel-match-others" aria-label={`Match other panels on ${referenceName} to this location`}
                  title={matchTitle}>
                  <MatchLocus size={11} aria-hidden="true" />
                </button>
              )}
              <button type="button" disabled={linked} className={BTN} title="Pan left" onClick={panLeft}>{'\u25C0'}</button>
              <button type="button" disabled={linked} className={BTN} title="Zoom out" onClick={() => zoom(1.5)}>{'\u2212'}</button>
              <button type="button" disabled={linked} className={BTN} title="Zoom in" onClick={() => zoom(1 / 1.5)}>+</button>
              <button type="button" disabled={linked} className={BTN} title="Pan right" onClick={panRight}>{'\u25B6'}</button>
            </div>
          )}
        </>
      )}
      {canLink && <button
        type="button"
        aria-pressed={linked}
        aria-label={compact ? (linked ? 'Unlink' : 'Link') : undefined}
        data-testid="panel-site-lock"
        className={`flex shrink-0 items-center gap-0.5 rounded border px-1 py-0 text-[11px] leading-tight ${linked
          ? 'border-cyan-600 bg-cyan-600 text-white hover:bg-cyan-700'
          : 'border-gray-300 text-gray-600 hover:bg-white dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'}`}
        title={linked
          ? 'Linked: moves with the main view and other linked panels. Click to unlink and navigate this panel on its own (e.g. another chromosome or haplotype).'
          : 'Link: move with the main view and other linked panels again, keeping this location'}
        onClick={() => store().setPanelSiteLocked(panel.id, !linked)}
      >
        {linked ? <Unlink size={11} /> : <Link size={11} />}
        {!compact && <span>{linked ? 'Unlink' : 'Link'}</span>}
      </button>}
      {referenceOpen && <ReferenceManager panelId={panel.id} onClose={() => setReferenceOpen(false)} />}
      {grouped && (
        <button
          type="button"
          className={BTN}
          title={panel.contactRegionGroupId ? 'Close region panels and restore originals' : 'Close haplotype comparison and restore source panels'}
          aria-label={panel.contactRegionGroupId ? 'Close region panels' : 'Close haplotype comparison'}
          onClick={() => (panel.contactRegionGroupId ? store().closeContactRegions() : store().closeHaplotypeComparison())}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * For a main-view panel beside panels with their own locus: the same height
 * as their bar, so read tracks line up, and says which region it shows.
 */
export function MainViewBar() {
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const exporting = useBrowserStore(s => s.exportInProgress);
  // Beside a panel on another assembly, a figure names the main genome too.
  const reference = useBrowserStore(s => (s.panels.some(p => p.genome) ? mainReferenceLabel(s) : null));
  if (exporting) {
    const text = panelFigureLocus({ reference, chrom, start, end });
    return (
      <div data-testid="panel-main-view-bar" className="flex min-w-0 items-center border-b border-gray-200 bg-gray-50 px-1.5" style={{ height: PANEL_SITE_BAR_HEIGHT }}>
        <span className="truncate font-mono text-[11px] text-gray-700" data-figure-text={text}>{text}</span>
      </div>
    );
  }
  return (
    <div
      data-testid="panel-main-view-bar"
      className="flex min-w-0 items-center gap-1 border-b border-gray-200 bg-gray-50 px-1.5 text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-400"
      style={{ height: PANEL_SITE_BAR_HEIGHT }}
      title="This panel follows the main view"
    >
      <span className="shrink-0 font-semibold">Main view</span>
      <span className="truncate font-mono">{formatCoordinates(chrom, start, end)}</span>
    </div>
  );
}
