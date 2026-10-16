/**
 * The coverage histogram of a panel's reads (its own row since fb-n11-tracks;
 * it was a fixed 30 px band inside the read canvas). Shown when "Coverage
 * histogram" is on; resized, deleted and restored like every other track.
 * The bars fill the row's height.
 */
import { useEffect, useRef } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { feedHasCoverage, useTrackFeedStore } from '../../stores/trackFeedStore';
import type { PanelConfig } from '../../types';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { drawCoverageHistogram } from './read-track/ReadTrackCanvas';
import { HoverLabel } from './TrackLabels';

export function CoverageTrack({ width, height, panel, sidebarWidth = 0 }: {
  width: number; height: number; panel: PanelConfig; sidebarWidth?: number;
}) {
  const stateKey = panel.stateKey ?? panel.datasetId ?? '';
  const feed = useTrackFeedStore(s => s.byStateKey[stateKey]);
  const background = useBrowserStore(s => s.activeColormap.noReadBackgroundColor ?? s.activeColormap.backgroundColor);
  const canvasRenderVersion = useCanvasRenderVersion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePanOffsetTransform(canvasRef, { scope: feed?.panScope ?? 'main' });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;
    ctx.fillStyle = typeof background === 'string' ? background : '#ffffff';
    ctx.fillRect(0, 0, width, height);
    if (!feedHasCoverage(feed)) return;
    // Drawn in the view the panel shows now: the reads' intervals are relative to the view they
    // were fetched for (a linked pair's: its bounds), so they move with a pan until the next reads come.
    const regionWidth = Math.max(1, feed!.end - feed!.start);
    const offset = feed!.linked ? feed!.linkedOffset : feed!.dataStart - feed!.start;
    drawCoverageHistogram(ctx, feed!.reads, {
      sidebarWidth, trackWidth: Math.max(1, width - sidebarWidth), regionWidth,
      histogramHeight: height, headerHeight: 0, linkedOffset: offset,
      isReversed: feed!.isReversed, width, backgroundColor: typeof background === 'string' ? background : undefined,
    });
  }, [feed, width, height, sidebarWidth, background, canvasRenderVersion]);

  return (
    <div className="relative" style={{ width, height }} data-copilot-track="coverage" data-testid={`coverage-track-${panel.datasetId ?? ''}`}
      data-figure-fill={typeof background === 'string' ? background : '#ffffff'}>
      <canvas ref={canvasRef} width={width} height={height} className="block" style={{ userSelect: 'none' }} />
      <HoverLabel style={{ top: 1, left: sidebarWidth + 4 }}>Coverage</HoverLabel>
    </div>
  );
}
