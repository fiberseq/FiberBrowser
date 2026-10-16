import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { TrackLabelOptions } from '../../utils/trackLabels';

interface TrackLabelContextValue extends TrackLabelOptions {
  /** Show the hover labels (DOM): on screen, not in exports or figure renders. */
  hover: boolean;
}

// Without a provider (e.g. the linked split view) tracks draw their labels on the canvas as before.
const TrackLabelContext = createContext<TrackLabelContextValue>({ clean: false, pill: false, hover: false });

function renderMode(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__FIBERBROWSER_RENDER_MODE);
}

/**
 * How the tracks of a dataset panel label their data.
 *
 * Clean view (the default, per dataset panel): the data stays clean; track labels
 * ("Peaks", "Accessibility", "Metaprofile", …) and empty-row hints appear only
 * while the pointer is over that track row (or it has keyboard focus).
 * Clean view off (`showLabels`): the labels stay drawn over the data, on a small
 * translucent pill.
 *
 * An exported figure shows what the view shows at rest: no labels in Clean view
 * (hover-only labels are left out), the same labels when Clean view is off, so
 * rows and labels match the screen. Headless figure renders (render mode), which
 * have no hover, draw the labels as plain text as before.
 */
export function TrackLabelsProvider({ children, showLabels = false }: { children: ReactNode; showLabels?: boolean }) {
  const exporting = useBrowserStore(s => s.exportInProgress);
  const value = renderMode()
    ? { clean: false, pill: false, hover: false }
    : showLabels
      ? { clean: false, pill: true, hover: false }
      : { clean: true, pill: false, hover: !exporting };
  return (
    <TrackLabelContext.Provider value={value}>
      {children}
    </TrackLabelContext.Provider>
  );
}

export function useTrackLabels(): TrackLabelContextValue {
  return useContext(TrackLabelContext);
}

/** A track label that fades in while its track row is hovered or focused. */
export function HoverLabel({ children, style, className = '', title }: { children: ReactNode; style?: CSSProperties; className?: string; title?: string }) {
  const { hover } = useTrackLabels();
  if (!hover) return null;
  return <span className={`fb-hover-label ${className}`} style={style} title={title} data-hover-label="">{children}</span>;
}

/** An empty-row hint ("No genes in region"), centred, shown the same way. */
export function HoverHint({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const { hover } = useTrackLabels();
  if (!hover) return null;
  return <span className="fb-hover-hint" style={style} data-hover-label="">{children}</span>;
}
