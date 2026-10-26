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
 * same pixels and every canvas that has marks on screen shows them in the image (its
 * marks stand out from its background there as on screen). A canvas still missing after
 * the last draw is copied in from the page.
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
 * The canvas's own picture, sampled on a `cols` x `rows` grid over its visible box:
 * which samples are marks (not the canvas's background colour), and the contrast
 * between marks and background (largest channel difference of their means).
 */
export interface ProbeMarks { cols: number; rows: number; mark: Uint8Array; contrast: number }

/**
 * A canvas on screen with marks on it. In the image, its marks must stand out from its
 * background as they do on screen (an HTML label or guide over a blank canvas does not
 * count); without `marks`, its box must just not be one flat colour. `source` and
 * `sourceBox` (backing-store px; `mirror`: drawn flipped, CSS scaleX(-1)) copy its
 * visible part in when it never draws.
 */
export interface UiCaptureProbe {
  box: UiBox;
  marks?: ProbeMarks;
  source?: CanvasImageSource;
  sourceBox?: UiBox;
  mirror?: boolean;
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
 * The mean colour of cell (col, row) of a probe's box on a cols x rows grid, from a
 * `width` px wide fingerprint: averaged like the canvas's own grid (a downscale).
 */
function cellMean(pixels: Uint32Array, width: number, height: number, box: UiBox, cols: number, rows: number, col: number, row: number): number {
  const x0 = Math.max(0, Math.floor(box.x + (col * box.w) / cols)), x1 = Math.min(width, Math.max(x0 + 1, Math.floor(box.x + ((col + 1) * box.w) / cols)));
  const y0 = Math.max(0, Math.floor(box.y + (row * box.h) / rows)), y1 = Math.min(height, Math.max(y0 + 1, Math.floor(box.y + ((row + 1) * box.h) / rows)));
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = pixels[y * width + x];
      r += p & 255; g += (p >>> 8) & 255; bl += (p >>> 16) & 255; n++;
    }
  }
  if (n === 0) return 0;
  return (Math.round(r / n)) | (Math.round(g / n) << 8) | (Math.round(bl / n) << 16);
}

/** Largest channel difference between the mean colours of the mark and background samples. */
function markContrast(colorAt: (i: number) => number, mark: Uint8Array): number {
  const sums = [[0, 0, 0], [0, 0, 0]];
  const counts = [0, 0];
  for (let i = 0; i < mark.length; i++) {
    const p = colorAt(i), m = mark[i];
    counts[m]++;
    for (let c = 0; c < 3; c++) sums[m][c] += (p >>> (8 * c)) & 255;
  }
  if (counts[0] === 0 || counts[1] === 0) return 0;
  let best = 0;
  for (let c = 0; c < 3; c++) best = Math.max(best, Math.abs(sums[1][c] / counts[1] - sums[0][c] / counts[0]));
  return best;
}

/** True when the probe's canvas shows in the fingerprint (`width` px wide). */
export function probeDrawn(pixels: Uint32Array, width: number, probe: UiCaptureProbe): boolean {
  const m = probe.marks;
  if (!m) return !boxIsBlank(pixels, width, probe.box);
  const height = Math.floor(pixels.length / width);
  const out = markContrast(i => cellMean(pixels, width, height, probe.box, m.cols, m.rows, i % m.cols, Math.floor(i / m.cols)), m.mark);
  // A wash over the track (a highlight) keeps most of the contrast; a blank canvas has none.
  return out >= 0.3 * m.contrast;
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
  const blankProbes = (fp: Uint32Array | null) => (fp ? probes.filter(p => !probeDrawn(fp, fpWidth, p)) : probes);

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
    ctx.save();
    if (probe.mirror) {
      // Drawn flipped on screen: flip about the box's vertical centre line.
      ctx.translate((2 * b.x + b.w) * k, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(probe.source, s.x, s.y, s.w, s.h, probe.mirror ? 0 : b.x * k, b.y * k, b.w * k, b.h * k);
    ctx.restore();
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

/** A canvas's CSS transform: identity, a horizontal flip (reversed views), or something else. */
function canvasTransform(canvas: HTMLCanvasElement): 'none' | 'mirror' | 'other' {
  const t = getComputedStyle(canvas).transform;
  if (!t || t === 'none') return 'none';
  const m = t.match(/^matrix\(([^)]+)\)$/);
  if (!m) return 'other';
  const [a, b, c, d] = m[1].split(',').map(Number);
  if (b === 0 && c === 0 && d === 1 && (a === 1 || a === -1)) return a === 1 ? 'none' : 'mirror';
  return 'other';
}

/**
 * Sample the canvas's visible part (backing-store box `src`) on a grid, as it shows on
 * screen (over white; flipped when mirrored). Null when it has no marks.
 */
function sampleMarks(canvas: HTMLCanvasElement, src: UiBox, cssW: number, cssH: number, mirror: boolean): ProbeMarks | null {
  const cols = Math.max(1, Math.min(64, Math.round(cssW)));
  const rows = Math.max(1, Math.min(64, Math.round(cssH)));
  // At CSS size, then averaged per cell: the same way the image's fingerprint is gridded.
  const w = Math.max(1, Math.round(cssW)), h = Math.max(1, Math.round(cssH));
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  const ctx = full.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const px = new Uint32Array(cols * rows);
  try {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(canvas, src.x, src.y, src.w, src.h, 0, 0, w, h);
    const all = new Uint32Array(ctx.getImageData(0, 0, w, h).data.buffer);
    const box = { x: 0, y: 0, w, h };
    for (let i = 0; i < px.length; i++) px[i] = cellMean(all, w, h, box, cols, rows, i % cols, Math.floor(i / cols));
  } catch {
    return null;
  }
  // The background: the commonest colour; marks: samples well away from it.
  const counts = new Map<number, number>();
  for (const p of px) counts.set(p, (counts.get(p) ?? 0) + 1);
  let bg = px[0], most = 0;
  for (const [p, n] of counts) if (n > most) { bg = p; most = n; }
  const mark = new Uint8Array(px.length);
  let marks = 0;
  for (let i = 0; i < px.length; i++) {
    let far = false;
    for (let c = 0; c < 3; c++) if (Math.abs(((px[i] >>> (8 * c)) & 255) - ((bg >>> (8 * c)) & 255)) > 24) far = true;
    if (far) { mark[i] = 1; marks++; }
  }
  if (marks < 3 || px.length - marks < 3) return null;
  const contrast = markContrast(i => px[i], mark);
  return contrast > 24 ? { cols, rows, mark, contrast } : null;
}

/** The canvases in `root` that show marks, as probes in `root`'s CSS px. */
function canvasProbes(root: HTMLElement, width: number, filter?: (node: HTMLElement) => boolean): UiCaptureProbe[] {
  const rootRect = root.getBoundingClientRect();
  // Screen px per CSS px of the node (the UI size, where the engine reports zoomed boxes).
  const zoom = rootRect.width > 0 && width > 0 ? rootRect.width / width : 1;
  const probes: UiCaptureProbe[] = [];
  for (const canvas of Array.from(root.querySelectorAll('canvas'))) {
    if (filter && !filter(canvas as unknown as HTMLElement)) continue;
    if (canvas.width === 0 || canvas.height === 0 || getComputedStyle(canvas).visibility === 'hidden') continue;
    const rect = canvas.getBoundingClientRect();
    const visible = visibleBox(canvas, root);
    if (rect.width < 1 || rect.height < 1 || visible.width < 1 || visible.height < 1) continue;
    const transform = canvasTransform(canvas);
    if (transform === 'other') continue;
    const mirror = transform === 'mirror';
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    // The visible part in backing-store px; flipped on screen, its left edge is the canvas's right.
    const left = mirror ? rect.right - visible.right : visible.left - rect.left;
    const sourceBox = { x: left * sx, y: (visible.top - rect.top) * sy, w: visible.width * sx, h: visible.height * sy };
    const box = { x: (visible.left - rootRect.left) / zoom, y: (visible.top - rootRect.top) / zoom, w: visible.width / zoom, h: visible.height / zoom };
    const marks = sampleMarks(canvas, sourceBox, box.w, box.h, mirror);
    if (!marks) continue;
    probes.push({ box, marks, source: canvas, sourceBox, mirror });
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
