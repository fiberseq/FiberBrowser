import { useEffect, type KeyboardEvent, type RefObject } from 'react';

/**
 * Keyboard use of a dropdown menu (as the genome-mismatch banner's): ArrowDown
 * on its button opens it; it opens with focus on its first item; arrow keys
 * (Home/End) move between items, Escape and Tab close it (focus back on its
 * button). Every key pressed in the open menu stays in it, so the browser's
 * own shortcuts (arrows pan, +/- zoom, Cmd+Z undo...) don't act on the view
 * behind it; Enter and Space still choose.
 *
 * `rootRef` holds the button (`aria-haspopup="menu"`) and the `role="menu"`;
 * items are `role="menuitem"` (grayed ones with aria-disabled stay reachable,
 * so their reason is read out).
 */
export function useMenuKeys(open: boolean, close: () => void, rootRef: RefObject<HTMLElement>) {
  const itemSelector = '[role="menu"] [role="menuitem"]:not([disabled])';
  useEffect(() => {
    if (!open) return;
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])];
    (items.find(item => item.getAttribute('aria-disabled') !== 'true') ?? items[0])?.focus();
  }, [open, rootRef]);
  return (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' && (e.target as HTMLElement).getAttribute('aria-haspopup') === 'menu') {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).click();
      }
      return;
    }
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus();
    const trigger = () => rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    if (e.key === 'ArrowDown') focus(at + 1);
    else if (e.key === 'ArrowUp') focus(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(items.length - 1);
    // Tab too: the focused item is about to unmount, so the focus goes back to the button on purpose.
    else if (e.key === 'Escape' || e.key === 'Tab') { close(); trigger()?.focus(); }
    else { e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
  };
}
