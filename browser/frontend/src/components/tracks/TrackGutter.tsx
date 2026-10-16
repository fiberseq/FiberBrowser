import type { ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { trackBackground, type TrackBackgroundKind } from './TrackContainerConstants';

/**
 * A fixed track drawn to the right of the cluster sidebar's column. The column
 * (`gutter` px, 0 without clusters) is filled with the track's own ground, so
 * nothing of the panel behind shows through beside the track in either theme.
 */
export function TrackGutter({ gutter, kind, height, children }: {
  gutter: number;
  kind: TrackBackgroundKind;
  /** Fixed height: the track is then also the positioning box of its overlays (annotation filter box). */
  height?: number;
  children: ReactNode;
}) {
  const darkMode = useBrowserStore(s => s.darkMode);
  return (
    <div
      data-track-gutter={gutter > 0 ? kind : undefined}
      style={{ paddingLeft: gutter, background: gutter > 0 ? trackBackground(kind, darkMode) : undefined, ...(height != null ? { height } : {}) }}
    >
      {height != null
        ? <div style={{ position: 'relative', height }}>{children}</div>
        : children}
    </div>
  );
}
