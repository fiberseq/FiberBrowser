import { ChevronRight } from './Icons';

/**
 * The disclosure chevron for expandable rows and sections (replaces the ▸/▾ text
 * glyphs): points right when closed and down when open. Decorative; the control
 * that owns it carries aria-expanded. `data-disclosure` exposes the state to tests.
 */
export function DisclosureChevron({ open, size = 10, className = '' }: { open: boolean; size?: number; className?: string }) {
  return (
    <ChevronRight
      size={size}
      strokeWidth={2.5}
      aria-hidden="true"
      data-disclosure={open ? 'open' : 'closed'}
      className={`inline-block flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''} ${className}`}
    />
  );
}
