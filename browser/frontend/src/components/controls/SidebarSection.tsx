import { type ReactNode } from 'react';

interface Props {
  id: string;
  label: string;
  icon: ReactNode;
  description?: string;
  /**
   * The settings search lists every matching section, each under a small
   * heading of its own. As a page (no search), the sidebar's header names it.
   */
  heading?: boolean;
  children: React.ReactNode;
}

/** One settings page (a section of the settings sidebar), or one block of search results. */
export function SidebarSection({ id, label, icon, description, heading = false, children }: Props) {
  const headerId = `sidebar-section-${id}-header`;
  return (
    <div
      className={heading ? 'border-b border-gray-200/50 pb-3 last:border-b-0 dark:border-white/10' : 'pb-3'}
      role="region"
      aria-labelledby={headerId}
      data-sidebar-section={id}
    >
      {heading ? (
        <h3
          id={headerId}
          data-tour={`sidebar-${id}`}
          className="flex flex-nowrap items-center gap-2 px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-brand-700 dark:text-brand-300" aria-hidden="true">{icon}</span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </h3>
      ) : (
        description && (
          <p className="px-3 pb-2 pt-2.5 text-[12px] leading-[17px] text-ink-muted">
            {description}
          </p>
        )
      )}
      <div className="fb-sidebar-subsections">{children}</div>
    </div>
  );
}
