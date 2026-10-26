/**
 * Full UI capture (Export → Image → Capture full UI): the browser window as an image.
 *
 * html-to-image clones the page into an SVG <foreignObject>; each canvas (the read
 * tracks, axes, signal tracks) becomes a nested <img> with a PNG data URL. WebKit
 * (Safari and the desktop app's window) fires the SVG image's load before those nested
 * images are decoded, so the first draw of it paints every canvas blank; drawing the
 * same SVG again paints them. Chromium decodes them first, so one draw is complete.
 *
 * So this draws the SVG again until the image is complete: two draws in a row give the
 * same pixels and every canvas that has marks on screen has marks in the image. A canvas
 * still blank after the last draw is copied in from the page.
 */

export interface UiCaptureOptions {
  /** Output pixels per CSS pixel. */
  pixelRatio: number;
  backgroundColor?: string;
  /** Leave out nodes (the export dialog). */
  filter?: (node: HTMLElement) => boolean;
}

/** A box in CSS px from the captured node's top-left corner. */
export interface UiBox { x: number; y: number; w: number; h: number }

/**
 * A canvas on screen with marks on it: its box must not come out blank. `source` and
 * `sourceBox` (backing-store px) copy its visible part in when it does.
 */
export interface UiCaptureProbe {
  box: UiBox;
  source?: CanvasImageSource;
  sourceBox?: UiBox;
}

export interface UiCaptureDeps {
  /** Paint one fresh decode of the SVG `url` over `canvas` (already sized and cleared). */
  draw: (url: string, canvas: HTMLCanvasElement) => Promise<void>;
  /** The canvas's pixels at `width` x `height` (CSS px): compared between draws. */
  fingerprint: (canvas: HTMLCanvasElement, width: number, height: number) => Uint32Array | null;
  /** Pause before draw number `n` (1-based, from the second draw). */
  wait: (n: number) => Promise<void>;
  createCanvas: () => HTMLCanvasElement;
}

/** Draws at most this many times before falling back to copying blank canvases in. */
export const UI_CAPTURE_MAX_DRAWS = 8;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      img.decode().catch(() => undefined).then(() => requestAnimationFrame(() => resolve(img)));
    };
    img.onerror = () => reject(new Error('Could not draw the window. Use a lower resolution, then export again.'));
    img.decoding = 'sync';
    img.src = url;
  });
}

let scratch: HTMLCanvasElement | null = null;

const browserDeps: UiCaptureDeps = {
  draw: async (url, canvas) => {
    const img = await loadImage(url);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  },
  fingerprint: (canvas, width, height) => {
    // At CSS size: a small, fixed cost whatever the export resolution.
    scratch ??= document.createElement('canvas');
    scratch.width = Math.max(1, Math.round(width));
    scratch.height = Math.max(1, Math.round(height));
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
    return new Uint32Array(ctx.getImageData(0, 0, scratch.width, scratch.height).data.buffer.slice(0));
  },
  wait: n => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve()), Math.min(400, 40 * n))),
  createCanvas: () => document.createElement('canvas'),
};

function samePixels(a: Uint32Array | null, b: Uint32Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when the box in the fingerprint (width px wide) is one flat colour. */
export function boxIsBlank(pixels: Uint32Array, width: number, box: UiBox): boolean {
  const height = Math.floor(pixels.length / width);
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w)), y1 = Math.min(height, Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return false;
  const first = pixels[y0 * width + x0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = pixels[y * width + x];
      if (p === first) continue;
      // Ignore one-step differences (dithering, rounding in the downscale).
      for (let shift = 0; shift < 32; shift += 8) {
        if (Math.abs(((p >>> shift) & 255) - ((first >>> shift) & 255)) > 8) return false;
      }
    }
  }
  return true;
}

/**
 * Draw `svgUrl` (an html-to-image SVG of a `width` x `height` CSS px node) on one canvas
 * until it is complete (see the file comment), and return that canvas.
 */
export async function drawUntilComplete(
  svgUrl: string,
  width: number,
  height: number,
  options: UiCaptureOptions,
  probes: UiCaptureProbe[] = [],
  deps: UiCaptureDeps = browserDeps,
): Promise<HTMLCanvasElement> {
  const canvas = deps.createCanvas();
  canvas.width = Math.round(width * options.pixelRatio);
  canvas.height = Math.round(height * options.pixelRatio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the image. Use a lower resolution, then export again.');
  const paint = async () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (options.backgroundColor) {
      ctx.fillStyle = options.backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await deps.draw(svgUrl, canvas);
    return deps.fingerprint(canvas, width, height);
  };
  const fpWidth = Math.max(1, Math.round(width));
  const blankProbes = (fp: Uint32Array | null) => (fp ? probes.filter(p => boxIsBlank(fp, fpWidth, p.box)) : probes);

  let previous = await paint();
  let blank = blankProbes(previous);
  for (let n = 2; n <= UI_CAPTURE_MAX_DRAWS; n++) {
    await deps.wait(n);
    const current = await paint();
    blank = blankProbes(current);
    if (blank.length === 0 && samePixels(previous, current)) return canvas;
    previous = current;
  }
  // Still blank: copy those canvases in from the page (over anything drawn on top of them there).
  const k = canvas.width / width;
  for (const probe of blank) {
    if (!probe.source || !probe.sourceBox) continue;
    const s = probe.sourceBox, b = probe.box;
    if (s.w <= 0 || s.h <= 0) continue;
    ctx.drawImage(probe.source, s.x, s.y, s.w, s.h, b.x * k, b.y * k, b.w * k, b.h * k);
  }
  return canvas;
}

/** A canvas's visible part: clipped by the scrolling or clipping boxes it sits in, up to `root`. */
function visibleBox(el: Element, root: Element): DOMRect {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  for (let node = el.parentElement; node && node !== root.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node !== root && style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const r = node.getBoundingClientRect();
    left = Math.max(left, r.left); top = Math.max(top, r.top);
    right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

/** True when the canvas shows more than one colour (sampled small). */
function canvasHasMarks(canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const probe = document.createElement('canvas');
  probe.width = 32; probe.height = 32;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  try {
    ctx.drawImage(canvas, 0, 0, 32, 32);
    const px = new Uint32Array(ctx.getImageData(0, 0, 32, 32).data.buffer);
    return px.some(p => p !== px[0]);
  } catch {
    return false;
  }
}

/** The canvases in `root` that show marks, as probes in `root`'s CSS px. */
function canvasProbes(root: HTMLElement, width: number, filter?: (node: HTMLElement) => boolean): UiCaptureProbe[] {
  const rootRect = root.getBoundingClientRect();
  // Screen px per CSS px of the node (the UI size, where the engine reports zoomed boxes).
  const zoom = rootRect.width > 0 && width > 0 ? rootRect.width / width : 1;
  const probes: UiCaptureProbe[] = [];
  for (const canvas of Array.from(root.querySelectorAll('canvas'))) {
    if (filter && !filter(canvas as unknown as HTMLElement)) continue;
    const rect = canvas.getBoundingClientRect();
    const visible = visibleBox(canvas, root);
    if (rect.width < 1 || rect.height < 1 || visible.width < 1 || visible.height < 1) continue;
    if (getComputedStyle(canvas).visibility === 'hidden' || !canvasHasMarks(canvas)) continue;
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    probes.push({
      box: { x: (visible.left - rootRect.left) / zoom, y: (visible.top - rootRect.top) / zoom, w: visible.width / zoom, h: visible.height / zoom },
      source: canvas,
      sourceBox: { x: (visible.left - rect.left) * sx, y: (visible.top - rect.top) * sy, w: visible.width * sx, h: visible.height * sy },
    });
  }
  return probes;
}

/** The node (the browser window) as a canvas at `pixelRatio`, with every canvas in it drawn. */
export async function captureUiCanvas(root: HTMLElement, options: UiCaptureOptions): Promise<HTMLCanvasElement> {
  const { toSvg } = await import('html-to-image');
  // html-to-image's own size of a node: the client box plus borders.
  const style = getComputedStyle(root);
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const width = root.clientWidth + px('border-left-width') + px('border-right-width');
  const height = root.clientHeight + px('border-top-width') + px('border-bottom-width');
  const probes = canvasProbes(root, width, options.filter);
  const svg = await toSvg(root, { width, height, backgroundColor: options.backgroundColor, filter: options.filter });
  // The canvases' images ask for async decoding (html-to-image); ask for sync, which WebKit may honour.
  const url = svg.split('decoding%3D%22async%22').join('decoding%3D%22sync%22');
  return drawUntilComplete(url, width, height, options, probes);
}
