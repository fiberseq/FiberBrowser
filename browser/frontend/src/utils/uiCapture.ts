/**
 * Full UI capture (Export → Image → Capture full UI): the browser window as an image.
 *
 * html-to-image clones the page into an SVG <foreignObject>; each canvas (the read
 * tracks, axes, signal tracks) becomes a nested <img> with a PNG data URL. WebKit
 * (Safari and the desktop app's window) fires the SVG image's load before those nested
 * images are decoded, so the first draw of it paints every canvas blank; drawing the
 * same SVG again paints them. Chromium decodes them first, so one draw is complete.
 *
 * So this draws the SVG until two draws in a row give the same pixels (one extra draw
 * in Chromium, two in WebKit), instead of html-to-image's single-draw toCanvas.
 */

export interface UiCaptureOptions {
  /** Output pixels per CSS pixel. */
  pixelRatio: number;
  backgroundColor?: string;
  /** Leave out nodes (the export dialog). */
  filter?: (node: HTMLElement) => boolean;
}

/** One rasterization of the SVG: a fresh image of `url` drawn on a fresh canvas. */
export type UiCaptureDraw = (url: string, width: number, height: number, options: UiCaptureOptions) => Promise<HTMLCanvasElement>;

/** Draws until the image stops changing; at most this many draws. */
export const UI_CAPTURE_MAX_DRAWS = 5;

function borderBoxSize(node: HTMLElement): { width: number; height: number } {
  // html-to-image's own size of a node: the client box plus borders.
  const style = getComputedStyle(node);
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  return {
    width: node.clientWidth + px('border-left-width') + px('border-right-width'),
    height: node.clientHeight + px('border-top-width') + px('border-bottom-width'),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      img.decode().catch(() => undefined).then(() => requestAnimationFrame(() => resolve(img)));
    };
    img.onerror = () => reject(new Error('Could not draw the window. Use a lower resolution, then export again.'));
    img.decoding = 'async';
    img.src = url;
  });
}

const drawOnce: UiCaptureDraw = async (url, width, height, options) => {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * options.pixelRatio);
  canvas.height = Math.round(height * options.pixelRatio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the image. Use a lower resolution, then export again.');
  if (options.backgroundColor) {
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
};

function pixels(canvas: HTMLCanvasElement): Uint32Array | null {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  return new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
}

function samePixels(a: Uint32Array | null, b: Uint32Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Draw `svgUrl` (an html-to-image SVG of a `width` x `height` CSS px node) until two
 * draws in a row match, and return the last. Exported for tests (`draw` stands in for
 * the browser's rasterizer).
 */
export async function drawUntilStable(
  svgUrl: string,
  width: number,
  height: number,
  options: UiCaptureOptions,
  draw: UiCaptureDraw = drawOnce,
): Promise<HTMLCanvasElement> {
  let canvas = await draw(svgUrl, width, height, options);
  let previous = pixels(canvas);
  for (let n = 1; n < UI_CAPTURE_MAX_DRAWS; n++) {
    const next = await draw(svgUrl, width, height, options);
    const current = pixels(next);
    canvas = next;
    if (samePixels(previous, current)) break;
    previous = current;
  }
  return canvas;
}

/** The node (the browser window) as a canvas at `pixelRatio`, with every canvas in it drawn. */
export async function captureUiCanvas(root: HTMLElement, options: UiCaptureOptions, draw: UiCaptureDraw = drawOnce): Promise<HTMLCanvasElement> {
  const { toSvg } = await import('html-to-image');
  const { width, height } = borderBoxSize(root);
  const url = await toSvg(root, { width, height, backgroundColor: options.backgroundColor, filter: options.filter });
  return drawUntilStable(url, width, height, options, draw);
}
