import { useRef, type HTMLAttributes } from 'react';
import { useNativeWheel } from '../../hooks/useNativeWheel';
import { useLinearWheelZoom } from '../../hooks/useLinearWheelZoom';
import { useReadRowWheel } from '../../hooks/useReadRowWheel';

/** Give every linear subtrack the same gestures; the read canvas handles its more precise axis first. */
export function LinearWheelSurface({ view, width, gutter = 0, panelId, genome, onViewportChange, ...props }:
  HTMLAttributes<HTMLDivElement> & { view: { chrom: string; start: number; end: number }; width: number;
    gutter?: number; panelId?: string; genome?: string; onViewportChange?: (start: number, end: number) => void }) {
  const zoom = useLinearWheelZoom({ ...view, width, sidebarWidth: gutter, panelId, genome, onViewportChange });
  const row = useReadRowWheel(5);
  const ref = useRef<HTMLDivElement>(null);
  useNativeWheel(ref, e => {
    if (e.defaultPrevented || (e.target as HTMLElement).closest('input, select, textarea, button, [role="menu"]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width ? (e.clientX - rect.left) * width / rect.width : 0;
    if (x < gutter) return;
    if (!zoom(e, x)) row(e);
  });
  return <div {...props} ref={ref} />;
}
