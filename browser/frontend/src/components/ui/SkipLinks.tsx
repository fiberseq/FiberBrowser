/**
 * Skip links at the start of the tab order (usability round 2, N13): the toolbar and every header button come before
 * the reads, so "Skip to reads" and "Skip to panels" jump there (with no side panel open, to the panel launchers).
 * Hidden until focused.
 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function shown(el: Element): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Focus `el`'s first control matching `preferred` (else its first focusable one, else it). False: nothing there. */
function focusInside(el: HTMLElement | undefined, preferred?: string): boolean {
  if (!el) return false;
  const pick = (selector: string) => [...el.querySelectorAll<HTMLElement>(selector)].find(shown);
  const target = (preferred ? pick(preferred) : undefined) ?? pick(FOCUSABLE);
  if (target) {
    target.focus();
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus();
  return true;
}

const firstShown = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(shown);

export function skipToReads(): boolean {
  return focusInside(firstShown('[data-panel-id]'), 'canvas[data-copilot-track="reads"]');
}

/**
 * The first side panel; with none open, the panel launchers (the rail's tiles, or the analysis strip in strip mode),
 * so the link always lands somewhere (usability round 3, B3).
 */
export function skipToPanels(): boolean {
  const panel = firstShown('[data-analysis-panel-id]');
  if (panel) return focusInside(panel);
  const launchers = firstShown('[data-testid="panel-rail-launchers"]') ?? firstShown('[data-testid="analysis-strip"]');
  return launchers ? focusInside(launchers) : false;
}

const LINK = 'sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:rounded-fb focus:border focus:border-blue-500 focus:bg-white focus:px-3 focus:py-1.5 focus:text-[13px] focus:font-medium focus:text-blue-700 focus:shadow-lg dark:focus:bg-dark-surface dark:focus:text-blue-200';

export function SkipLinks() {
  return (
    <nav aria-label="Skip links" data-testid="skip-links">
      <a href="#reads" className={LINK} data-testid="skip-to-reads"
        onClick={e => { e.preventDefault(); skipToReads(); }}>Skip to reads</a>
      <a href="#panels" className={LINK} data-testid="skip-to-panels"
        onClick={e => { e.preventDefault(); skipToPanels(); }}>Skip to panels</a>
    </nav>
  );
}
