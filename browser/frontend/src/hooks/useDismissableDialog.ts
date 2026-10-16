/**
 * A modal card the user can dismiss (the Welcome card, usability audit round 2 N12): Escape closes it when nothing
 * else is open over it (a dialog or menu it opened, such as the Library, takes its own Escape first); focus moves into
 * it when it opens (not from a dialog over it), Tab stays inside it while it is topmost, and focus goes back to where
 * it was when the user dismisses it. With nowhere to go back to (it opened with the page: focus was on <body>), focus
 * goes to `fallback` (the Welcome card: the toolbar's Open; usability round 3, B4), never to <body>.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

function shown(el: Element): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el) : true;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab reaches inside `root`, in order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => shown(el));
}

/** A dialog or menu open in the page other than `own` (or inside it). */
export function otherOverlayOpen(own: Element | null, root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (own && (own === el || own.contains(el))) continue;
    if (shown(el)) return true;
  }
  return false;
}

/** The first shown, enabled control matching one of `selectors` (in order of preference). */
export function firstFocusable(selectors: string[], root: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      if (el.matches(FOCUSABLE) && shown(el)) return el;
      const inner = focusables(el)[0];
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * `ref`: the dialog element (it takes focus on open; give it tabIndex={-1}). `onDismiss`: closes it. `onKey`: other
 * keys while it is open and topmost (return true when handled). `fallback`: where focus goes on dismissal when there is
 * no opener to go back to (selectors, the first match wins). Returns `dismiss`, which closes it and gives focus back.
 */
export function useDismissableDialog(ref: RefObject<HTMLElement>, open: boolean, onDismiss: () => void,
  onKey?: (e: KeyboardEvent) => boolean, fallback?: string[]): () => void {
  const opener = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const dismiss = useCallback(() => {
    const back = opener.current;
    opener.current = null;
    onDismiss();
    requestAnimationFrame(() => {
      const target = back && back.isConnected && back !== document.body ? back : firstFocusable(fallbackRef.current ?? []);
      target?.focus({ preventScroll: true });
    });
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && !ref.current?.contains(active) ? active : null;
    // Focus inside it, unless focus is in it already or a dialog over it (the Library) holds it.
    if (ref.current && !ref.current.contains(document.activeElement) && !otherOverlayOpen(ref.current)) {
      ref.current.focus({ preventScroll: true });
    }
  }, [open, ref]);

  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || otherOverlayOpen(ref.current)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey && ref.current) {
        // Modal: Tab and Shift+Tab go round its own controls.
        const items = focusables(ref.current);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        const inside = ref.current.contains(document.activeElement);
        let next: HTMLElement | null = null;
        if (!inside) next = e.shiftKey ? items[items.length - 1] : items[0];
        else if (e.shiftKey && (at <= 0)) next = items[items.length - 1];
        else if (!e.shiftKey && at === items.length - 1) next = items[0];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      } else if (onKeyRef.current?.(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, ref, dismiss]);

  return dismiss;
}
