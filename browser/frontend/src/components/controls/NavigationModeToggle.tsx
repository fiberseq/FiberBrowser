import { useEffect, type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { LayoutColumns, Link, X } from '../ui/Icons';

/** Why the main locus controls are off in "Each panel navigates". */
export const PER_PANEL_NAV_REASON = 'Each panel navigates: use the locus box in each panel. Switch to Linked to move them together from here.';

/** The Linked segment's tooltip: what linking does, and where each reference's panels go (fb-r3-nav). */
export const LINKED_NAV_TITLE = 'Linked navigation: the panels on the same genome share one locus (this locus box moves the main genome\'s; '
  + 'panels on another genome move together from any of their locus boxes). Switching from Per panel, each genome\'s panels go to '
  + 'where you last moved one of them (else its first panel).';

/** How long the note beside the toggle stays. */
const NOTICE_MS = 8_000;

const SEGMENT = 'inline-flex items-center gap-1 px-1.5 py-[3px] text-[11px] leading-none transition-colors';

/**
 * Next to the main locus box: "Linked" (one locus per genome: this nav bar
 * moves the main genome's panels, the panels on another assembly move
 * together from their own locus boxes) or "Per panel" (every dataset panel
 * gets its own chromosome and locus box, so you needn't copy a view to look
 * somewhere else; this nav bar is off). A short note under it says when the
 * mode was switched for you (a dataset opened in its own panel).
 */
export function NavigationModeToggle() {
  const mode = useBrowserStore(s => s.navigationMode);
  const setMode = useBrowserStore(s => s.setNavigationMode);
  const notice = useBrowserStore(s => s.navigationNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => useBrowserStore.getState().setNavigationNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const segment = (value: 'linked' | 'perPanel', icon: ReactNode, label: string, title: string) => {
    const on = mode === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        data-testid={`nav-mode-${value}`}
        onClick={() => setMode(value)}
        title={title}
        className={`${SEGMENT} ${on
          ? 'bg-brand-600 text-white dark:bg-brand-500'
          : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-dark-surface dark:text-gray-300 dark:hover:bg-white/10'}`}
      >
        {icon}
        <span className="hidden min-[1400px]:inline">{label}</span>
      </button>
    );
  };
  return (
    <div className="relative inline-flex shrink-0">
      <div
        role="radiogroup"
        aria-label="Navigation"
        data-testid="navigation-mode-toggle"
        className="inline-flex shrink-0 overflow-hidden rounded-fb border border-line shadow-chip dark:border-white/10"
      >
        {segment('linked', <Link size={12} aria-hidden="true" />, 'Linked', LINKED_NAV_TITLE)}
        {segment('perPanel', <LayoutColumns size={12} aria-hidden="true" />, 'Per panel',
          'Each panel navigates: every dataset panel gets its own chromosome and locus box (no need to copy a view)')}
      </div>
      {notice && (
        <div
          role="status"
          data-testid="navigation-mode-notice"
          className="absolute left-0 top-full z-40 mt-1 flex w-[280px] items-start gap-1.5 rounded-fb border border-brand-200 bg-white px-2 py-1.5 text-[11px] leading-snug text-gray-700 shadow-lg dark:border-brand-700 dark:bg-dark-surface dark:text-gray-200"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label="Close" data-testid="navigation-mode-notice-close"
            className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
            onClick={() => useBrowserStore.getState().setNavigationNotice(null)}>
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
