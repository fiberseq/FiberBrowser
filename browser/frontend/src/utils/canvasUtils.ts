import { projectReferenceContext } from '../features/differences/referenceCanvas';
import { type DependencyList, useEffect, useSyncExternalStore } from 'react';
import { getBrowserPerformanceProfile } from './performanceProfile';
import { wrapForVectorCapture } from './vectorCapture';

/**
 * Canvas utility functions for high-DPI rendering.
 */

// Fixed render scale for high-quality output (2x like Retina displays)
export const CANVAS_SCALE = 2;

const MIN_CANVAS_SCALE = 1;
const MAX_CANVAS_SCALE = 6;

let activeCanvasRenderScale = CANVAS_SCALE;
if (typeof navigator !== 'undefined') {
  activeCanvasRenderScale = getBrowserPerformanceProfile().interactiveCanvasScale;
}
let canvasRenderVersion = 0;
const canvasRenderListeners = new Set<() => void>();

export function normalizeCanvasRenderScale(scale: number): number {
  if (!Number.isFinite(scale)) return CANVAS_SCALE;
  return Math.max(MIN_CANVAS_SCALE, Math.min(MAX_CANVAS_SCALE, Math.round(scale * 100) / 100));
}

export function getCanvasRenderScale(): number {
  return activeCanvasRenderScale;
}

export function setCanvasRenderScale(scale: number): void {
  const next = normalizeCanvasRenderScale(scale);
  if (next === activeCanvasRenderScale) return;
  activeCanvasRenderScale = next;
  canvasRenderVersion += 1;
  canvasRenderListeners.forEach(listener => listener());
}

/** Ask every canvas track to draw again (e.g. to record it for export). */
export function requestCanvasRedraw(): void {
  canvasRenderVersion += 1;
  canvasRenderListeners.forEach(listener => listener());
}

function subscribeCanvasRenderScale(listener: () => void): () => void {
  canvasRenderListeners.add(listener);
  return () => canvasRenderListeners.delete(listener);
}

export function useCanvasRenderVersion(): number {
  return useSyncExternalStore(
    subscribeCanvasRenderScale,
    () => canvasRenderVersion,
    () => 0,
  );
}

/**
 * Set up a canvas for high-DPI rendering.
 * The canvas renders at the active canvas scale. Normal interactive rendering
 * uses CANVAS_SCALE; export can temporarily raise the active scale so PNG
 * captures get real source pixels instead of upscaling a 2x screen buffer.
 *
 * @param canvas - The canvas element
 * @param width - CSS width in pixels
 * @param height - CSS height in pixels
 * @returns The 2D context, already scaled for logical coordinates
 */
export function setupHighDpiCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const renderScale = getCanvasRenderScale();

  // Set actual canvas size (higher resolution)
  canvas.width = Math.max(1, Math.round(width * renderScale));
  canvas.height = Math.max(1, Math.round(height * renderScale));

  // Set CSS size (display size)
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  // Scale context so drawing code uses logical coordinates
  ctx.scale(renderScale, renderScale);

  // During an SVG/PDF export, also record the drawing (after the scale, so
  // the record is in logical coordinates).
  return projectReferenceContext(canvas, wrapForVectorCapture(canvas, ctx), width, height);
}

/**
 * Get the actual pixel dimensions of a high-DPI canvas.
 * Useful for export when you need the raw canvas size.
 */
export function getCanvasPixelSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  return {
    width: canvas.width,
    height: canvas.height
  };
}

export function useScheduledCanvasEffect(
  render: () => void,
  deps: DependencyList,
  immediate = false,
): void {
  useEffect(() => {
    if (immediate || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      render();
      return;
    }
    const frame = window.requestAnimationFrame(() => render());
    return () => window.cancelAnimationFrame(frame);
  }, [...deps, immediate]);
}
