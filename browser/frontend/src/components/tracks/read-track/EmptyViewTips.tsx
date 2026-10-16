const KBD = 'px-1 py-0.5 bg-gray-100 dark:bg-white/10 rounded text-[11px] font-mono border border-gray-200 dark:border-white/15';

/**
 * The tips on an empty read track ("No reads in this view"): what drags,
 * scrolls and clicks on reads do. There are no click modes: a plain click or
 * drag pans, right-click opens the read menu, Shift+click selects a read and
 * Cmd/Ctrl+click a footprint (as in Keyboard shortcuts).
 */
export function EmptyViewTips() {
  const mod = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  return (
    <>
      <div>Drag to pan; + / − (or ↑ / ↓) to zoom</div>
      <div><kbd className={KBD}>Right-click</kbd> a read for its actions</div>
      <div><kbd className={KBD}>Shift+click</kbd> selects a read, <kbd className={KBD}>{mod}+click</kbd> a footprint</div>
      <div><kbd className={KBD}>{mod}+scroll</kbd> zooms read row height</div>
    </>
  );
}
