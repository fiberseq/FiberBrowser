import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** The function colour of a read operation (design tokens --fb-action-peaks / -cluster / -sort / -filter / -highlight). */
export type ActionTone = 'peaks' | 'cluster' | 'sort' | 'filter' | 'highlight';

/**
 * Each tone's class, spelled out: Tailwind keeps a component class only when it
 * finds its full name in the source, so a class built as `fb-action-${tone}`
 * was dropped from the build and Sort and Filter fell back to Scan's blue.
 */
export const ACTION_TONE_CLASS: Record<ActionTone, string> = {
  peaks: 'fb-action-peaks',
  cluster: 'fb-action-cluster',
  sort: 'fb-action-sort',
  filter: 'fb-action-filter',
  highlight: 'fb-action-highlight',
};

interface ActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  tone: ActionTone;
  icon?: ReactNode;
  /** Running or chosen: drawn solid in the tone. */
  active?: boolean;
  /** Busy (e.g. a scan is running): not clickable; keeps its at-rest colours (legible ink) with a spinner. */
  busy?: boolean;
  /** Why the action can't run. The button keeps its colour (faded), does nothing and says why on hover. */
  disabledReason?: string | null;
}

/**
 * Scan, Cluster, Sort and Filter: one family of buttons, each in the colour of
 * its function (Scan blue like Peak Detection, Cluster cyan like Clusters, Sort
 * amber, Filter purple like Rules, where filter rules live). Tinted at
 * rest, solid when active; blocked ones are aria-disabled (not `disabled`) so the
 * reason still shows on hover, and keep their colour, faded (never grey).
 */
export function ActionButton({ tone, icon, active, busy, disabledReason, title, className = '', onClick, children, ...rest }: ActionButtonProps) {
  const blocked = Boolean(disabledReason) && !busy;
  return (
    <button
      type="button"
      {...rest}
      className={`fb-action ${ACTION_TONE_CLASS[tone]}${active ? ' fb-action-active' : ''}${busy ? ' fb-action-busy' : ''} ${className}`}
      disabled={busy || undefined}
      aria-busy={busy || undefined}
      aria-disabled={blocked || undefined}
      title={blocked ? disabledReason ?? undefined : title}
      onClick={blocked || busy ? undefined : onClick}
    >
      {busy ? <span className="fb-action-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}
