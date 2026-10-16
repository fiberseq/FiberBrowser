import { panelReversed } from '../../hooks/usePanelDisplayStore';
import { closeSplitOutcome } from './SplitGroupStrip';
import { useState, useRef, useCallback, useEffect, type ReactNode, type RefObject } from 'react';
import { useTrackMenuStore } from '../../stores/trackMenuStore';
import { useShallow } from 'zustand/react/shallow';
import { fitHeaderActions, useHeaderMeasure } from '../../hooks/useHeaderActionsFit';
import { closeSplitPanels } from '../../utils/splitPanels';
import { setSplitShowAll, splitLocusText, splitShowsAll } from '../../utils/splitLocus';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import { SubTrackMenu } from './SubTrackMenu';
import { useDatasetActions } from '../../hooks/useDatasetActions';
import { Check, Chromosome, Dna, Eye, EyeOff, GripVertical, Layers, LayoutColumns, Link, ListIcon, Maximize, Minimize, Minus, MoreHorizontal, Plus, Unlink, X } from '../ui/Icons';
import { usePanelHeaderAdditions } from './panelHeaderExtensions';
import { isStacked, stackTarget } from '../../stores/panelArrangement';
import { openHaplotypeCompare } from '../controls/haplotype/haplotypeCompareRequest';
import { UI_THEME, headerBarStyle } from '../../theme/uiTheme';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../utils/datasetLabels';
import { isStrandedDafDataset } from '../../utils/datasetChemistry';
import { StrandChip } from './StrandChip';
import { useReadStatusStore } from '../../stores/readStatusStore';
import { compactReadStatus } from './read-track/readCounts';
import { panelTitle } from '../../utils/panelTitle';

const HEADER_HEIGHT = 28;

/** The dataset name always keeps this much of the header (px; the rest of it is in its tooltip). */
export const HEADER_NAME_MIN = 56;
/** Room the name gets before the read count may show beside it (px, or the whole name if shorter). */
const HEADER_NAME_PRIORITY = 120;

export interface HeaderLayout {
  /** The read count: in full ("586/3,170 visible"), short ("586/3,170") or left out. */
  status: 'full' | 'short' | 'none';
  /** The strand chip says "Strand" instead of "Both strands". */
  strandNarrow: boolean;
  /** Px the header uses besides its action buttons (padding, grip, name, count, strand). */
  used: number;
}

/**
 * What fits beside the dataset name in a header `room` px wide (audit M14:
 * with four panels the name went first, leaving "312/3,173 visible" and no
 * name). The name has priority: the count shortens, then the strand chip,
 * then the count goes; the name keeps at least HEADER_NAME_MIN. `actionsWidth`:
 * the action buttons that must stay (measured; fb-n11-tracks).
 */
export function headerLayout(room: number | undefined, c: {
  label: string; status: string | null; stranded: boolean; strand: 'CT' | 'GA' | null; grip: boolean; actions: boolean;
  actionsWidth?: number;
  /** The title's part that is never cut (a split panel's group, measured px): the name keeps at least this. */
  nameMin?: number;
}): HeaderLayout {
  const GAP = 6;
  const fixed = 14 + (c.grip ? 13 + GAP : 0);
  const actionsW = c.actions ? (c.actionsWidth ?? 22 + GAP + 23) + GAP : 0;
  // The name span never gets narrower than HEADER_NAME_MIN (its CSS min-width), even for a short name.
  const name = Math.max(HEADER_NAME_MIN, c.nameMin ?? 0, Math.min(Math.ceil(c.label.length * 7.4), HEADER_NAME_PRIORITY));
  const text = (t: string) => Math.ceil(t.length * 6.2) + GAP;
  const strandW = (narrow: boolean) => (!c.stranded ? 0 : (c.strand ? 82 : narrow ? 64 : 92) + GAP);
  const statusW = (s: HeaderLayout['status']) => (!c.status || s === 'none' ? 0 : text(s === 'full' ? c.status : compactReadStatus(c.status)));
  const used = (o: Omit<HeaderLayout, 'used'>) => fixed + name + strandW(o.strandNarrow) + statusW(o.status);
  const full = { status: c.status ? 'full' as const : 'none' as const, strandNarrow: false };
  if (room === undefined || !(room > 0)) return { ...full, used: used(full) };
  const options: Omit<HeaderLayout, 'used'>[] = c.status
    ? [full, { status: 'short', strandNarrow: false }, { status: 'short', strandNarrow: true }, { status: 'none', strandNarrow: true }]
    : [full, { status: 'none', strandNarrow: true }];
  for (const o of options) {
    if (used(o) + actionsW <= room) return { ...o, used: used(o) };
  }
  const last = options[options.length - 1];
  return { ...last, used: used(last) };
}

/**
 * How many of a header's action pills (measured widths, in order) show whole in `room` px (the room left for the
 * actions), leaving the essential actions `essentials` px; and the px they take. Undefined room (no layout): all.
 */
export function fitHeaderPills(room: number | undefined, widths: number[], essentials: number, gap = 6): { count: number; width: number } {
  let count = 0, width = 0;
  for (const w of widths) {
    if (room !== undefined && room - (width + w + gap) < essentials) break;
    count += 1;
    width += w + gap;
  }
  return { count, width };
}

/** The header's actions, most important first (fb-n11-tracks): what stays when the panel is narrow. */
export const HEADER_ACTION_ORDER = ['close', 'minimize', 'fullview', 'tracks', 'cleanview', 'reverse', 'copy', 'arrange', 'haplotypes'] as const;
export type HeaderActionKey = typeof HEADER_ACTION_ORDER[number];
/** Shown even in the narrowest panel (with the name); the rest give way to the read count first. */
const ESSENTIAL_ACTIONS = 4;

interface Props {
  panel: PanelConfig;
  panelIndex: number;
  isSelected?: boolean;
  narrow?: boolean;
  /** The panel's width in px. */
  width?: number;
  /** Px at the bar's right end covered by the side-panel drawer: the controls stay left of it. */
  insetRight?: number;
  /** No room left of the drawer: the bar is drawn over it instead. */
  overDrawer?: boolean;
  onDragStart?: (e: React.DragEvent, idx: number) => void;
  onDragEnd?: () => void;
}

interface HeaderAction {
  key: HeaderActionKey;
  icon: ReactNode;
  label: string;
  title: string;
  tour: string;
  onSelect: () => void;
  danger?: boolean;
  pressed?: boolean;
  testId?: string;
  /** Text beside the icon when there is room (the Tracks button). */
  text?: string;
  haspopup?: boolean;
}

export function PanelHeader({ panel, panelIndex, isSelected, narrow, width, insetRight = 0, overDrawer = false, onDragStart, onDragEnd }: Props) {
  const openPanelAtSite = useBrowserStore(s => s.openPanelAtSite);
  const panels = useBrowserStore(s => s.panels);
  const datasets = useBrowserStore(s => s.datasets);
  const removePanel = useBrowserStore(s => s.removePanel);
  const reversed = useBrowserStore(s => panelReversed(s, panel.id));
  const perPanel = useBrowserStore(s => s.navigationMode === 'perPanel');
  const duplicatePanel = useBrowserStore(s => s.duplicatePanel);
  const setPanelCollapsed = useBrowserStore(s => s.setPanelCollapsed);
  const fullViewPanelId = useBrowserStore(s => s.fullViewPanelId);
  const setFullViewPanel = useBrowserStore(s => s.setFullViewPanel);
  const selectedDatasets = useBrowserStore(s => s.selectedDatasets);
  const toggleDatasetSelection = useBrowserStore(s => s.toggleDatasetSelection);
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const setPanelTrackLabels = useBrowserStore(s => s.setPanelTrackLabels);
  const { handleRemove } = useDatasetActions();
  const readStatusKey = panel.stateKey ?? panel.datasetId;
  const readStatus = useReadStatusStore(s => (readStatusKey ? s.byStateKey[readStatusKey] : undefined));

  const [showSubTrackMenu, setShowSubTrackMenu] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const tracksButtonRef = useRef<HTMLButtonElement>(null);

  // A track's right-click "Tracks in this panel…" opens this header's menu.
  const tracksMenuRequested = useTrackMenuStore(s => s.tracksMenuFor === panel.id);
  useEffect(() => {
    if (tracksMenuRequested && useTrackMenuStore.getState().takeTracksMenuRequest(panel.id)) {
      setShowOverflow(false);
      setShowSubTrackMenu(true);
    }
  }, [tracksMenuRequested, panel.id]);

  const dataset = panel.datasetId ? datasets.find(d => d.id === panel.datasetId) : undefined;
  const currentGenome = useBrowserStore(s => s.currentGenome);
  // A "Split into panels" panel: its group's colour and name ("ind · N5 · V2").
  const subset = panel.readSubset;
  const subsetReads = useSplitPanelStore(s => (subset ? s.reads[panel.stateKey ?? ''] : undefined));
  const color = subset?.colour || dataset?.color || '#4b5563';
  // What plugin packs add to this header (panelHeaderExtensions.ts): chips, "…" items, room for a longer name.
  const additions = usePanelHeaderAdditions({ panel, dataset, showLayoutChrome: !exportInProgress });
  const labelChars = additions.reduce<number | undefined>((n, a) => (a.labelChars ? Math.max(n ?? 0, a.labelChars) : n), undefined);
  const baseLabel = dataset ? getDatasetDisplayLabel(dataset, labelChars) : panel.datasetId || (currentGenome ? currentGenome.toUpperCase() : 'Genome');
  // Group first, dataset last (utils/panelTitle.ts): "Carriers · INS 9.2 kb @ chr2L:… · numb", "roo copy 2 (chr3L) · …".
  const sourceDataset = panel.altAllele ? datasets.find(d => d.id === panel.altAllele!.cluster.datasetId) : undefined;
  const rawTitle = panelTitle(panel, baseLabel, sourceDataset ? getDatasetDisplayLabel(sourceDataset) : undefined);
  const title = reversed ? { ...rawTitle, primary: `◀ ${rawTitle.primary}`, full: `◀ ${rawTitle.full}` } : rawTitle;
  const label = title.full;
  // Away from its split's locus, showing every read here (utils/splitLocus.ts): said in the header.
  const mainView = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end })));
  const splitAllHere = splitShowsAll(subset, panel.viewportOverride ?? mainView, panel);
  const labelTitle = dataset ? (title.secondary ? `${title.full}\n${getDatasetHoverLabel(dataset)}` : getDatasetHoverLabel(dataset)) : label;
  const isFullView = fullViewPanelId === panel.id;
  const showLayoutChrome = !exportInProgress;
  const isDatasetSelected = selectedDatasets.has(panel.id);
  // Another panel shows this dataset (a copy at another site, a duplicate):
  // closing this one only closes the panel, never the dataset.
  const hasSiblingPanel = Boolean(panel.datasetId) && panels.some(p => p.id !== panel.id && p.contentType === 'dataset' && p.datasetId === panel.datasetId);
  const closePanel = () => {
    // The last panel of a split closes the split: the panel it came from shows again (and an expanded
    // Carriers panel's alt dataset closes with it), never left folded away with the dataset still open.
    const groupId = panel.readSubset?.groupId;
    if (groupId && !panels.some(p => p.id !== panel.id && p.readSubset?.groupId === groupId)) { void closeSplitPanels(groupId); return; }
    if (panel.datasetId && !hasSiblingPanel) handleRemove(panel.datasetId); else removePanel(panel.id);
  };
  const stranded = isStrandedDafDataset(dataset);
  // A dataset panel's copy gets its own location box, linked to the main view
  // until unlinked (to show another chromosome, haplotype or strand).
  const addCopy = () => (panel.datasetId ? openPanelAtSite(panel.id, { linked: true }) : duplicatePanel(panel.id));
  const copyTitle = panel.datasetId
    ? 'Add a copy of this panel. It moves with the main view until you unlink it, then it has its own location (e.g. another chromosome or haplotype).'
    : 'Duplicate panel';
  // Stacked or side by side (M17): the other arrangement, when there is one.
  const arrangePanel = useBrowserStore(s => s.arrangePanel);
  const stacked = isStacked(panels, panel.id);
  const stackOnto = panel.contentType === 'dataset' && !stacked ? stackTarget(panels, panel.id) : null;
  const panelLabel = (p: PanelConfig | null) => {
    const d = p?.datasetId ? datasets.find(x => x.id === p.datasetId) : undefined;
    return d ? getDatasetDisplayLabel(d) : 'the panel beside it';
  };

  // The actions, most important first (HEADER_ACTION_ORDER).
  const actions: HeaderAction[] = [
    {
      key: 'close', icon: <X size={14} />, tour: 'panel-close', danger: true, testId: `panel-close-${panel.id}`,
      label: hasSiblingPanel || !panel.datasetId ? 'Close panel' : 'Close dataset',
      title: hasSiblingPanel || !panel.datasetId ? 'Close this panel' : 'Close dataset: remove it from the browser (the file stays on disk; Undo brings it back)',
      onSelect: closePanel,
    },
    {
      key: 'minimize', icon: <Minus size={14} />, tour: 'panel-minimize', label: 'Minimize', testId: `panel-minimize-${panel.id}`,
      title: 'Minimize panel (a tile at the bottom of the rail, or a button in the classic strip, brings it back)',
      onSelect: () => setPanelCollapsed(panel.id, true),
    },
    {
      key: 'fullview', icon: isFullView ? <Minimize size={13} /> : <Maximize size={13} />, tour: 'panel-full-view', testId: `panel-full-view-${panel.id}`,
      label: isFullView ? 'Restore all panels' : 'Expand to full view', title: isFullView ? 'Restore all panels' : 'Expand to full view',
      onSelect: () => setFullViewPanel(isFullView ? null : panel.id), pressed: isFullView,
    },
    {
      key: 'tracks', icon: <Layers size={14} />, tour: 'panel-subtracks', label: 'Tracks in this panel…', text: 'Tracks', haspopup: true,
      title: 'Tracks in this panel: show, remove, restore, reorder and add tracks', testId: `panel-tracks-${panel.id}`,
      onSelect: () => setShowSubTrackMenu(v => !v), pressed: showSubTrackMenu,
    },
    ...(panel.datasetId ? [{
      key: 'cleanview' as const, icon: panel.showTrackLabels ? <Eye size={14} /> : <EyeOff size={14} />, tour: 'panel-clean-view',
      label: 'Clean view', testId: `panel-clean-view-${panel.id}`, pressed: !panel.showTrackLabels,
      title: panel.showTrackLabels
        ? 'Clean view is off: track labels stay over the data, on screen and in exported figures. Click to show them only on hover.'
        : 'Clean view: track labels show only while you hover a track, and exported figures leave them out. Click to keep them shown.',
      onSelect: () => setPanelTrackLabels(panel.id, !panel.showTrackLabels),
    }] : []),
    ...(perPanel ? [{ key: 'reverse' as const, tour: 'panel-reverse', icon: <span>◀</span>, label: 'Reverse', testId: `panel-reverse-${panel.id}`, pressed: reversed, title: 'Reverse this panel', onSelect: () => useBrowserStore.getState().setPanelReversed(panel.id, !reversed) }] : []),
    { key: 'copy', icon: <Plus size={14} />, tour: 'panel-add-copy', label: panel.datasetId ? 'Add a copy' : 'Duplicate', title: copyTitle, onSelect: addCopy },
    ...(stacked ? [{
      key: 'arrange' as const, icon: <LayoutColumns size={14} />, tour: 'panel-side-by-side', label: 'Side by side',
      title: 'Give this panel a column of its own, beside the panels it is stacked with', onSelect: () => arrangePanel(panel.id, 'side'),
    }] : stackOnto ? [{
      key: 'arrange' as const, icon: <ListIcon size={14} />, tour: 'panel-stack', label: `Stack below ${panelLabel(stackOnto)}`,
      title: `Stack this panel below ${panelLabel(stackOnto)}, at full width`, onSelect: () => arrangePanel(panel.id, 'stack'),
    }] : []),
    ...(panel.datasetId ? [{
      key: 'haplotypes' as const, icon: <Chromosome size={14} />, tour: 'panel-compare-haplotypes', label: 'Compare haplotypes…',
      title: 'Show this locus on two chromosomes (e.g. two haplotypes) side by side', onSelect: () => openHaplotypeCompare(panel),
    }] : []),
  ];

  // The chips shown between the name and the actions (split, its reads note, plugin packs'): measured too, their room kept.
  const chipTexts = [
    isDatasetSelected && panel.datasetId && showLayoutChrome ? 'Target' : null,
    // The split pill reads "Split ×", and "Close split" on hover: measured at the wider text so nothing moves.
    subset && showLayoutChrome ? 'Close split' : null,
    subset && subsetReads?.message ? (subsetReads.state === 'frozen' ? 'saved reads' : 'no reads') : null,
    ...additions.flatMap(a => a.chipTexts ?? []),
  ].filter((t): t is string => Boolean(t));
  // Plugin packs' action pills (a split panel's "Expand INS 9.2k"): in the bar while they fit, else only in "…".
  const pills = showLayoutChrome ? additions.flatMap(a => a.headerPills ?? []) : [];
  // Measured: the header's width, each button's width, the "…" button, the Tracks label, the chips and the pills.
  const { headerRef, measureRef, width: measuredWidth, widths } = useHeaderMeasure([actions.map(a => a.key).join(','), showLayoutChrome, chipTexts.join('|'), title.secondary ? title.primary : '', pills.map(p => p.text).join('|')]);
  const headerWidth = measuredWidth ?? width;
  const GAP = 6;
  const measured = (key: string) => widths[key] ?? 0;
  const chipsWidth = chipTexts.length ? measured('chips') + GAP : 0;
  const room = headerWidth === undefined ? undefined : headerWidth - insetRight - chipsWidth;
  // A split panel's group (and a title of its own) is never cut: the name keeps its measured width.
  const titleMin = title.secondary ? Math.max(HEADER_NAME_MIN, Math.ceil(measured('title-primary'))) : HEADER_NAME_MIN;
  const essentialsWidth = actions.slice(0, ESSENTIAL_ACTIONS).reduce((sum, a) => sum + measured(a.key), 0) + GAP * (ESSENTIAL_ACTIONS - 1);
  const fit = headerLayout(room, {
    label, status: readStatus?.text ?? null, stranded: stranded && showLayoutChrome, strand: panel.strand ?? null,
    grip: Boolean(showLayoutChrome && onDragStart), actions: showLayoutChrome,
    nameMin: titleMin,
    // The essentials stay; the read count gives way before them (and "…" may be needed).
    actionsWidth: measuredWidth === undefined ? undefined : essentialsWidth + GAP + measured('more'),
  });
  // Plugin packs' items that live only in "…": keep room for it when they are offered. "…" is always there (it
  // always holds Close panel, at every width: usability audit bug 6), so its room is always kept.
  const altMenu = additions.some(a => a.wantsMenu);
  const menuAlways = showLayoutChrome;
  const actionsRoom = room === undefined || measuredWidth === undefined ? undefined : room - fit.used - GAP - (altMenu || menuAlways ? measured('more') + GAP : 0);
  // The pills, whole, as many (in order) as leave the essential actions their room (round 2, N3: they shrank to empty
  // circles in a two-SV split's 480-px headers); the rest only in "…" (their items are there). No layout (tests): all.
  const { count: pillsCount, width: pillsWidth } = fitHeaderPills(actionsRoom, pills.map(p => measured(`pill-${p.key}`)), essentialsWidth, GAP);
  const shownPills = pills.slice(0, pillsCount);
  const actionsFit = fitHeaderActions(
    actionsRoom === undefined ? undefined : actionsRoom - pillsWidth,
    actions.map(a => ({ key: a.key, width: measured(a.key) })),
    // "…" is always there and its room already kept (above): not counted twice.
    { gap: GAP, moreWidth: altMenu || menuAlways ? 0 : measured('more'), labelExtra: measured('tracks-label') - measured('tracks') },
  );
  const shown = new Set(actionsFit.shown);
  const overflowActions = actions.filter(a => !shown.has(a.key));
  // Left to right: Tracks, the panel tools, "…", then minimize, expand and close at the end.
  const VISUAL = ['tracks', 'cleanview', 'reverse', 'copy', 'arrange', 'haplotypes'] as HeaderActionKey[];
  const TRAILING = ['minimize', 'fullview', 'close'] as HeaderActionKey[];
  const byKey = (k: HeaderActionKey) => actions.find(a => a.key === k);
  const subTrackMenuAnchor = (shown.has('tracks') ? tracksButtonRef.current : overflowRef.current) ?? tracksButtonRef.current ?? overflowRef.current;

  const tint = UI_THEME.headerTone === 'tint';
  const bar = headerBarStyle(color);

  // Use onMouseDown for selection so it fires before child stopPropagation. A press on a control in the bar (a chip,
  // a pill, an action) is that control's, not a target toggle: targeting there showed the Target chip between
  // mousedown and mouseup, which moved the control away from the pointer and lost its click (integ/fb40: the NFR
  // groups chip needed two clicks). The name button targets on its own click.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest?.('button, a, input, select, textarea, [role="button"], [role="dialog"], [role="menu"]')) return;
    if (panel.datasetId) {
      toggleDatasetSelection(panel.id);
    }
  }, [panel.id, panel.datasetId, toggleDatasetSelection]);

  const actionClass = (a: HeaderAction) => `fb-header-act flex-shrink-0 gap-1 ${a.danger ? 'hover:!text-red-600 dark:hover:!text-red-300' : ''} ${a.key === 'cleanview' && a.pressed ? 'opacity-80' : ''}`;
  // The hidden measuring copies are spans (not buttons): nothing finds them as controls.
  const measureCopy = (a: HeaderAction, withText = false) => (
    <span key={`${a.key}${withText ? '-label' : ''}`} className={actionClass(a)} data-measure-key={withText ? 'tracks-label' : a.key}>
      {a.icon}
      {withText && a.text && <span className="text-[11.5px] font-medium">{a.text}</span>}
    </span>
  );
  const actionButton = (a: HeaderAction, measureOnly = false, withText = false) => measureOnly ? measureCopy(a, withText) : (
    <button
      key={a.key}
      ref={!measureOnly && a.key === 'tracks' ? tracksButtonRef : undefined}
      type="button"
      tabIndex={measureOnly ? -1 : undefined}
      data-measure-key={measureOnly ? (withText ? 'tracks-label' : a.key) : undefined}
      onMouseDown={measureOnly ? undefined : (e) => e.stopPropagation()}
      onClick={measureOnly ? undefined : (e) => { e.stopPropagation(); a.onSelect(); }}
      className={`fb-header-act flex-shrink-0 gap-1 ${a.danger ? 'hover:!text-red-600 dark:hover:!text-red-300' : ''} ${a.key === 'cleanview' && !a.pressed ? '' : a.key === 'cleanview' ? 'opacity-80' : ''}`}
      aria-label={measureOnly ? undefined : a.label}
      aria-pressed={!measureOnly && a.pressed !== undefined && a.key !== 'tracks' ? a.pressed : undefined}
      aria-haspopup={!measureOnly && a.haspopup ? 'dialog' : undefined}
      aria-expanded={!measureOnly && a.haspopup ? Boolean(a.pressed) : undefined}
      title={measureOnly ? undefined : a.title}
      data-tour={measureOnly ? undefined : a.tour}
      data-testid={measureOnly ? undefined : a.testId}
    >
      {a.icon}
      {withText && a.text && <span className="text-[11.5px] font-medium">{a.text}</span>}
    </button>
  );

  // Plugin packs' notices for the panel body (a job's status: the alt-allele build), under the bar.
  const bodies = additions.filter(a => a.body);
  const headerBar = (
    <div
      ref={headerRef}
      data-figure-label={label}
      data-figure-color={color}
      className="group/panel-header relative flex items-center pl-2 pr-1.5 select-none gap-1.5"
      data-testid={panel.datasetId ? `dataset-header-${panel.datasetId}` : undefined}
      data-header-inset={insetRight > 0 ? insetRight : undefined}
      data-header-over-drawer={overDrawer ? 'true' : undefined}
      data-header-overflow={actionsFit.overflow.length}
      data-header-pills={pills.length ? `${pillsCount}/${pills.length}` : undefined}
      style={{
        height: HEADER_HEIGHT,
        ...bar,
        // Beside the drawer: its controls move out from under it (and back as it slides away).
        ...(insetRight > 0 ? { paddingRight: 6 + insetRight } : {}),
        ...(overDrawer ? { zIndex: 31 } : {}),
        transition: 'padding-right 200ms ease-out',
        cursor: panel.datasetId ? 'pointer' : 'default',
        boxShadow: [
          tint ? bar.boxShadow : null,
          isSelected
            ? 'inset 0 0 0 3px rgba(0,0,0,0.7)'
            : isDatasetSelected
              ? `inset 0 0 0 3px ${tint ? color : 'rgba(255,255,255,0.6)'}`
              : null,
        ].filter(Boolean).join(', ') || 'none',
      }}
      onMouseDown={handleMouseDown}
    >
      {showLayoutChrome && onDragStart && (
        <span
          draggable
          className="cursor-grab leading-none opacity-0 transition-opacity hover:opacity-100 group-hover/panel-header:opacity-80 group-focus-within/panel-header:opacity-80 active:cursor-grabbing"
          title="Drag panel"
          data-tour="panel-drag-handle"
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => onDragStart(e, panelIndex)}
          onDragEnd={onDragEnd}
        >
          <GripVertical size={13} />
        </span>
      )}

      {/* Colour (the bar), name, read count, strand, then the actions that fit. The name comes first (M14). */}
      {(() => {
        // Group first, never cut (Top 1): the group's span keeps its width, the context after it is cut first.
        const nameBody = title.secondary ? (
          <>
            <span className="flex-shrink-0" data-testid="panel-header-title">{title.primary}</span>
            <span className="min-w-0 truncate font-normal opacity-80" data-testid="panel-header-context">{title.sep.replace(/ /g, '\u00a0')}{title.secondary}</span>
          </>
        ) : label;
        const layout = title.secondary ? 'flex min-w-0 items-baseline overflow-hidden whitespace-nowrap' : 'truncate';
        return panel.datasetId && showLayoutChrome ? (
          // The name targets the panel for Cluster, Sort and Filter (a button: reachable from the keyboard, its state
          // said): the same as a click anywhere on the bar, and as ticking it under Cluster's "Applies to".
          <button type="button" className={`fb-header-name flex-1 ${layout} text-left font-semibold text-[13px] tracking-[-0.005em] rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1`}
            style={{ minWidth: titleMin }}
            aria-pressed={isDatasetSelected}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggleDatasetSelection(panel.id); }}
            title={`${readStatus ? `${labelTitle} · ${readStatus.text}` : labelTitle}\n${isDatasetSelected
              ? 'Targeted: Cluster, Sort and Filter apply to the targeted panels. Click to untarget.'
              : 'Click to target this panel: Cluster, Sort and Filter then apply to the targeted panels only.'}`}
            data-testid="panel-header-name">
            {nameBody}
          </button>
        ) : (
          <span className={`flex-1 ${layout} font-semibold text-[13px] tracking-[-0.005em]`} style={{ minWidth: titleMin }}
            title={readStatus ? `${labelTitle} · ${readStatus.text}` : labelTitle} data-testid="panel-header-name">
            {nameBody}
          </span>
        );
      })()}
      {readStatus && fit.status !== 'none' && (
        <span className="flex-shrink-0 truncate text-[11px] tabular-nums opacity-80" title={`${readStatus.text}. ${readStatus.title}`} data-testid="panel-read-status"
          data-short={fit.status === 'short' ? 'true' : undefined}>
          {fit.status === 'short' ? compactReadStatus(readStatus.text) : readStatus.text}
        </span>
      )}
      {isDatasetSelected && panel.datasetId && showLayoutChrome && (
        <span className="fb-header-pill flex-shrink-0 font-semibold" data-testid="panel-target-chip"
          title="Targeted: Cluster, Sort and Filter apply to the targeted panels (see Cluster’s “Applies to”)">
          Target
        </span>
      )}
      {subset && showLayoutChrome && (
        <button type="button" className="fb-header-pill group/split flex-shrink-0" data-testid="split-panel-close-all" aria-label="Close split (all its panels)"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); void closeSplitPanels(subset.groupId); }}
          title={`A split panel: the reads of ${subset.label} (${subset.count.toLocaleString()} when split). Close split: closes all its panels; ${closeSplitOutcome(panels, subset.groupId)}.`}>
          {/* Both texts in one grid cell: the pill is as wide as the wider one, so hovering moves nothing. */}
          <span className="inline-grid">
            <span className="[grid-area:1/1] group-hover/split:invisible group-focus-visible/split:invisible">Split ×</span>
            <span className="invisible [grid-area:1/1] group-hover/split:visible group-focus-visible/split:visible" aria-hidden="true">Close split</span>
          </span>
        </button>
      )}
      {subset && splitAllHere && (
        <button type="button" className="fb-header-pill flex-shrink-0 truncate" data-testid="split-panel-all-reads"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); setSplitShowAll(subset.groupId, false); }}
          title={`Every read in this view, not split: this split is for ${splitLocusText(subset)}. Click to show the split's reads (back at its locus they show again by themselves).`}>
          All reads here · not split
        </button>
      )}
      {additions.map((a, i) => (a.splitChips ? <span key={`ext-split-chips-${i}`} className="contents">{a.splitChips}</span> : null))}
      {shownPills.map(p => (
        <button key={`pill-${p.key}`} type="button" className="fb-header-pill flex-shrink-0" data-testid={p.testId}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); p.onSelect(); }}
          title={p.title}>
          {p.icon}{p.text}
        </button>
      ))}
      {subset && subsetReads?.message && (
        <span className="fb-header-pill flex-shrink-0" data-testid="split-panel-note" title={subsetReads.message}>
          {subsetReads.state === 'frozen' ? 'saved reads' : 'no reads'}
        </span>
      )}
      {stranded && showLayoutChrome && <StrandChip panelId={panel.id} strand={panel.strand ?? null} narrow={narrow || fit.strandNarrow} />}
      {stranded && !showLayoutChrome && panel.strand && (
        <span className="fb-header-pill">{panel.strand} strand</span>
      )}
      {additions.map((a, i) => (a.chips ? <span key={`ext-chips-${i}`} className="contents">{a.chips}</span> : null))}

      {showLayoutChrome && VISUAL.filter(k => shown.has(k)).map(k => actionButton(byKey(k)!, false, k === 'tracks' && actionsFit.labelled))}

      {showLayoutChrome && (overflowActions.length > 0 || altMenu || menuAlways) && (
        <div className="relative flex-shrink-0">
          <button
            ref={overflowRef}
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setShowOverflow(v => !v); }}
            className="fb-header-act"
            title={`More: ${[...overflowActions.map(a => a.label), ...pills.slice(pillsCount).map(p => p.text), ...additions.flatMap(a => (a.menuTitle ? [a.menuTitle] : []))].join(', ')}`}
            aria-label="Panel actions"
            aria-haspopup="menu"
            aria-expanded={showOverflow}
            data-testid={`panel-actions-${panel.id}`}
            data-tour="panel-actions"
          >
            <MoreHorizontal size={15} />
          </button>
          {showOverflow && (
            <PanelMenu onClose={() => setShowOverflow(false)} anchor={overflowRef}>
              {[...VISUAL, ...TRAILING].filter(k => !shown.has(k)).map(k => byKey(k)).filter((a): a is HeaderAction => Boolean(a)).map(a => (
                <MenuItem key={a.key} tour={a.tour} icon={a.icon} title={a.title} danger={a.danger} onSelect={a.onSelect}>
                  {a.label}
                </MenuItem>
              ))}
              {/* Close panel stays in "…" at every width (also when its × fits in the bar). */}
              {shown.has('close') && (() => { const close = byKey('close')!; return (
                <>
                  {overflowActions.length > 0 && <div className="fb-menu-sep" />}
                  <MenuItem key="close-always" tour={close.tour} icon={close.icon} title={close.title} danger onSelect={close.onSelect}>{close.label}</MenuItem>
                </>
              ); })()}
              {altMenu && <div className="fb-menu-sep" />}
              {additions.map((a, i) => (a.menu ? <span key={`ext-menu-${i}`} className="contents">{a.menu}</span> : null))}
            </PanelMenu>
          )}
        </div>
      )}

      {showLayoutChrome && TRAILING.filter(k => shown.has(k)).map(k => actionButton(byKey(k)!))}

      {/* Every action, invisible, to measure what fits. */}
      {(showLayoutChrome || chipTexts.length > 0 || Boolean(title.secondary)) && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div ref={measureRef} className="invisible absolute left-0 top-0 flex w-max items-center gap-1.5">
            {showLayoutChrome && actions.map(a => measureCopy(a))}
            {showLayoutChrome && measureCopy(actions.find(a => a.key === 'tracks')!, true)}
            {showLayoutChrome && <span data-measure-key="more" className="fb-header-act"><MoreHorizontal size={15} /></span>}
            {title.secondary && <span data-measure-key="title-primary" className="whitespace-nowrap font-semibold text-[13px] tracking-[-0.005em]">{title.primary}</span>}
            {pills.map(p => <span key={`pill-${p.key}`} data-measure-key={`pill-${p.key}`} className="fb-header-pill flex-shrink-0">{p.icon}{p.text}</span>)}
            {chipTexts.length > 0 && (
              <span data-measure-key="chips" className="flex items-center gap-1.5">
                {chipTexts.map(t => <span key={t} className="fb-header-pill flex-shrink-0">{t}</span>)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tracks in this panel */}
      {showSubTrackMenu && subTrackMenuAnchor && (
        <SubTrackMenu
          panelId={panel.id}
          subTracks={panel.subTracks}
          anchorRect={subTrackMenuAnchor.getBoundingClientRect()}
          onClose={() => setShowSubTrackMenu(false)}
        />
      )}
    </div>
  );
  if (!bodies.length || !showLayoutChrome) return headerBar;
  return (
    <>
      {headerBar}
      <div className="shrink-0 space-y-1 bg-white px-2 py-1 dark:bg-dark-surface" data-testid="panel-header-body">
        {bodies.map((a, i) => <div key={`ext-body-${i}`}>{a.body}</div>)}
      </div>
    </>
  );
}

/** The header's ⋯ menu; closes on a click elsewhere or Escape. */
function PanelMenu({ children, onClose, anchor }: { children: ReactNode; onClose: () => void; anchor: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchor]);
  return (
    <div ref={ref} role="menu" className="fb-menu right-0 min-w-[13rem]" onMouseDown={(e) => e.stopPropagation()}
      onClickCapture={() => window.setTimeout(onClose, 0)}>
      {children}
    </div>
  );
}

export function MenuItem({ children, icon, onSelect, tour, title, danger, role = 'menuitem', checked }: {
  children: ReactNode; icon: ReactNode; onSelect: () => void; tour: string; title?: string; danger?: boolean;
  role?: 'menuitem' | 'menuitemcheckbox'; checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemcheckbox' ? Boolean(checked) : undefined}
      className={`fb-menu-item ${danger ? 'hover:!text-red-600 dark:hover:!text-red-400' : ''}`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      title={title}
      data-tour={tour}
    >
      <span className="flex w-4 justify-center text-ink-muted" aria-hidden="true">{icon}</span>
      {children}
    </button>
  );
}

export { HEADER_HEIGHT as PANEL_HEADER_HEIGHT };
