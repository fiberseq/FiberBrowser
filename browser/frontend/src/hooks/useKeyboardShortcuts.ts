import { useEffect, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { findChromInfo } from '../utils/chromAliases';
import { useEphemeralStore } from '../stores/ephemeralStore';
import { resetViewUndoably } from '../utils/resetView';

interface KeyboardShortcutsOptions {
  onScanPeaks?: () => void;
  onToggleShortcutsModal?: () => void;
  /** A dialog the caller knows is open (Export, Keyboard shortcuts): no shortcut acts behind it. */
  modalOpen?: boolean;
}

/** Full-window dialogs: while one is open, no key reaches the browser behind it. */
const MODAL_SELECTOR = '[aria-modal="true"], [data-export-modal]';
/** Menus, popovers and dialogs that close on Escape themselves. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]';

/**
 * Whether a menu or dialog is really on show. Content kept mounted but hidden
 * (an inactive side-panel drawer tab, a panel too narrow to use) must not count,
 * or Escape stops working behind it: hidden by attribute, inert, or by CSS
 * (display: none on it or an ancestor, which checkVisibility sees).
 */
function isShown(el: Element): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check !== 'function') return true;  // no layout to ask (e.g. jsdom): the attributes decide
  if (check.call(el)) return true;
  // display: contents has no box of its own, so checkVisibility says no: ask its parent.
  const parent = el.parentElement;
  return Boolean(parent) && getComputedStyle(el).display === 'contents' && isShown(parent!);
}

/** What is open in the page: a modal dialog (blocks every shortcut) or any menu/popover/dialog (Escape is its own). */
export function openOverlayState(root: ParentNode = document): { modal: boolean; overlay: boolean } {
  let modal = false;
  for (const el of root.querySelectorAll(MODAL_SELECTOR)) {
    if (isShown(el)) { modal = true; break; }
  }
  let overlay = modal;
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (!isShown(el)) continue;
    overlay = true;
    // A dialog over the whole window is modal even without aria-modal.
    if (el.getAttribute('role') !== 'menu' && el.getAttribute('role') !== 'listbox' && el.closest('.fixed.inset-0')) {
      modal = true;
      break;
    }
  }
  return { modal, overlay };
}

const hasEntries = (record: Record<string, unknown> | undefined) =>
  Object.values(record ?? {}).some(value => value != null);

/**
 * Escape with nothing open: clear the cluster focus, or, when nothing is
 * focused, the peak selection — but never a clustering or read filter built on
 * the selection (Reset view does that). One undo step when something changed,
 * none when nothing did. Returns what was cleared.
 */
export function clearFocusOrSelection(): 'focus' | 'peaks' | null {
  const s = useBrowserStore.getState();
  const activeNode = s.activeClusterTreeNodeId ? s.clusterTreeNodes?.[s.activeClusterTreeNodeId] : undefined;
  if (hasEntries(s.clusterFocus) || hasEntries(activeNode?.focus as Record<string, unknown> | undefined)) {
    s.clearClusterFocus();
    return 'focus';
  }
  const builtOnSelection = Object.values(s.clusterAssignments ?? {}).some(a => a && Object.keys(a).length > 0)
    || hasEntries(s.filteredReadIds)
    || (s.clusterTreeRootIds?.length ?? 0) > 0;
  if (s.selectedPeaks.size === 0 || builtOnSelection) return null;
  seedHistoryBaseline(s, 'Before clearing the peak selection', 'analysis');
  s.clearPeakSelection();
  useBrowserStore.getState().pushSnapshot('Clear peak selection', { kind: 'analysis' });
  return 'peaks';
}

const KEYBOARD_PAN_FALLBACK_RESET_MS = 15_000;

let keyboardPanFallbackTimer: ReturnType<typeof setTimeout> | null = null;
/** The view the last keyboard pan moved to: its pan offset belongs to that view only. */
let keyboardPanView: { chrom: string; start: number; end: number } | null = null;

function visibleGenomeWidthPx(): number {
  const container = document.querySelector('[data-export-container]') as HTMLElement | null;
  const width = container?.clientWidth ?? window.innerWidth;
  return Math.max(200, width || 800);
}

function hasVisibleReadTrack(): boolean {
  const panels = useBrowserStore.getState().panels;
  return panels.some(panel => (
    !panel.collapsed &&
    panel.contentType === 'dataset' &&
    panel.subTracks.some(track => track.type === 'reads' && track.visible)
  ));
}

function clearKeyboardPanFallback() {
  if (!keyboardPanFallbackTimer) return;
  clearTimeout(keyboardPanFallbackTimer);
  keyboardPanFallbackTimer = null;
}

function queueKeyboardPan(direction: -1 | 1): void {
  const state = useBrowserStore.getState();
  const regionWidth = Math.max(3, state.end - state.start);
  const step = Math.max(1, Math.round(regionWidth * 0.25)) * direction;
  const chromInfo = findChromInfo(state.chroms, state.chrom);
  const maxEnd = chromInfo?.size ?? Number.POSITIVE_INFINITY;
  let nextStart = state.start + step;
  let nextEnd = state.end + step;
  if (nextStart < 0) {
    nextStart = 0;
    nextEnd = regionWidth;
  }
  if (Number.isFinite(maxEnd) && nextEnd > maxEnd) {
    nextEnd = maxEnd;
    nextStart = Math.max(0, nextEnd - regionWidth);
  }

  const appliedShift = nextStart - state.start;
  if (appliedShift === 0) return;

  clearKeyboardPanFallback();
  // The view was moved some other way since the last keyboard pan (a typed locus, Go, a gene): that pan's
  // offset is stale (a view with no reads to draw never consumes it) and must not hold back this pan.
  const stale = keyboardPanView && (keyboardPanView.chrom !== state.chrom
    || keyboardPanView.start !== state.start || keyboardPanView.end !== state.end);
  if (stale && !useEphemeralStore.getState().isPanning) {
    useEphemeralStore.getState().setPanOffset(0);
    keyboardPanView = null;
  }
  const pixelDelta = Math.round(-(appliedShift / regionWidth) * visibleGenomeWidthPx());
  const ephemeral = useEphemeralStore.getState();
  const nextPanOffset = ephemeral.panOffset + pixelDelta;
  if (
    hasVisibleReadTrack() &&
    ephemeral.panOffset !== 0 &&
    Math.abs(nextPanOffset) > Math.abs(ephemeral.panOffset)
  ) {
    return;
  }
  ephemeral.setIsPanning(true);
  ephemeral.setPanOffset(nextPanOffset);
  state.setViewport(state.chrom, nextStart, nextEnd);
  useEphemeralStore.getState().setIsPanning(false);
  const moved = useBrowserStore.getState();
  keyboardPanView = { chrom: moved.chrom, start: moved.start, end: moved.end };

  if (!hasVisibleReadTrack()) {
    requestAnimationFrame(() => useEphemeralStore.getState().setPanOffset(0));
    return;
  }
  keyboardPanFallbackTimer = setTimeout(() => {
    keyboardPanFallbackTimer = null;
    const { isPanning, setPanOffset } = useEphemeralStore.getState();
    if (!isPanning) setPanOffset(0);
  }, KEYBOARD_PAN_FALLBACK_RESET_MS);
}

function adjustReadRowHeight(direction: -1 | 1): void {
  const state = useBrowserStore.getState();
  const current = state.readRowHeight === 'auto' ? 1 : state.readRowHeight;
  const step = current >= 12 ? 2 : 1;
  const next = Math.max(1, Math.min(99, Math.round(current + direction * step)));
  state.setReadRowHeight(next);
}

export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
  const modalOpenRef = useRef(Boolean(options.modalOpen));
  modalOpenRef.current = Boolean(options.modalOpen);
  useEffect(() => {
    // What was open when the key went down, read before any menu's own
    // listener closes it (window capture runs first): Escape that closes a
    // menu or dialog must not also clear the selection behind it.
    const openAtKeyDown = new WeakMap<KeyboardEvent, { modal: boolean; overlay: boolean }>();
    const captureOpenState = (e: KeyboardEvent) => { openAtKeyDown.set(e, openOverlayState()); };
    const handleKeyDown = (e: KeyboardEvent) => {
      // A menu, dialog or field already handled this key.
      if (e.defaultPrevented) return;
      const open = openAtKeyDown.get(e) ?? openOverlayState();
      // Nothing behind a dialog reacts to keys (arrows, Escape, undo, ...).
      if (modalOpenRef.current || open.modal) return;
      // Escape belongs to the open menu or popover, which closes on it.
      if (e.key === 'Escape' && open.overlay) return;
      // Skip if typing in input/textarea/contenteditable
      const target = e.target as HTMLElement;
      // (and dropdowns: their arrow keys pick an option)
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      const s = useBrowserStore.getState();

      // Undo/Redo — Cmd+Z / Cmd+Shift+Z (or Ctrl on non-Mac)
      // Shift makes e.key 'Z'.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          s.redo();
        } else {
          s.undo();
        }
        return;
      }

      // Each panel navigates: the main view's pan/zoom keys would move a view
      // no panel shows (each panel has its own locus box). Back / Forward
      // (Alt+← / Alt+→) still work: they undo the panels' own jumps too.
      if (s.navigationMode === 'perPanel' && !(e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(e.key)) {
        return;
      }

      switch (e.key) {
        // Navigation history - Alt+Arrow for back/forward
        case 'ArrowLeft':
          if (e.altKey) {
            e.preventDefault();
            s.goBack();
          } else {
            e.preventDefault();
            queueKeyboardPan(s.isReversed ? 1 : -1);
          }
          break;
        case 'ArrowRight':
          if (e.altKey) {
            e.preventDefault();
            s.goForward();
          } else {
            e.preventDefault();
            queueKeyboardPan(s.isReversed ? -1 : 1);
          }
          break;

        // Zoom - Arrow up/down and +/-
        case 'ArrowUp':
          e.preventDefault();
          s.zoomIn();
          break;
        case 'ArrowDown':
          e.preventDefault();
          s.zoomOut();
          break;
        case '+':
        case '=':
          e.preventDefault();
          s.zoomIn();
          break;
        case '-':
          e.preventDefault();
          s.zoomOut();
          break;

        // Read row height - bracket keys avoid conflicting with genome zoom.
        case '[':
        case '{':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            adjustReadRowHeight(-1);
          }
          break;
        case ']':
        case '}':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            adjustReadRowHeight(1);
          }
          break;

        // Cluster focus - Number keys 1-9
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9': {
          e.preventDefault();
          const clusterIndex = parseInt(e.key) - 1;
          for (const key of clusterFocusKeys(s)) {
            const assignments = s.clusterAssignments[key];
            if (!assignments) continue;
            const clusterIds = new Set(Object.values(assignments));
            if (clusterIds.has(clusterIndex)) {
              s.setClusterFocus(key, new Set([clusterIndex]));
            }
          }
          break;
        }

        // Clear cluster focus - 0 key
        case '0':
          e.preventDefault();
          s.clearClusterFocus();
          break;

        // Escape: clear the cluster focus, else the peak selection (nothing open).
        case 'Escape':
          if (clearFocusOrSelection()) e.preventDefault();
          break;

        // Reset view - R key (but not Cmd+R or Ctrl+R for refresh)
        case 'r':
        case 'R':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            resetViewUndoably();
          }
          break;

        // Scan peaks - S key
        case 's':
        case 'S':
          if (!e.ctrlKey && !e.metaKey && options.onScanPeaks) {
            e.preventDefault();
            options.onScanPeaks();
          }
          break;

        // Toggle genome overview - G key
        case 'g':
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            s.toggleGenomeOverview();
          }
          break;

        // Show keyboard shortcuts modal - ? key
        case '?':
          if (options.onToggleShortcutsModal) {
            e.preventDefault();
            options.onToggleShortcutsModal();
          }
          break;
      }
    };

    window.addEventListener('keydown', captureOpenState, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', captureOpenState, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [options.onScanPeaks, options.onToggleShortcutsModal]);
}

/**
 * The clustering states a number key focuses: each dataset panel's own
 * (a copy clustered on its own has its own), the selected panels when any are.
 */
export function clusterFocusKeys(s: Pick<ReturnType<typeof useBrowserStore.getState>, 'panels' | 'selectedDatasets' | 'datasets'>): string[] {
  const panels = s.panels.filter(p => p.contentType === 'dataset' && p.datasetId);
  const selected = panels.filter(p => s.selectedDatasets.has(p.id));
  const keys = (selected.length > 0 ? selected : panels).map(p => p.stateKey ?? p.datasetId!);
  if (keys.length === 0) keys.push(...s.datasets.map(d => d.id));
  return [...new Set(keys)];
}
