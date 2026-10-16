import { useBrowserStore } from '../stores/browserStore';
import { panelGenomeLabel, usePanelGenomeStore } from '../stores/panelGenomeStore';
import { figureFooterText, figureRegions, figureTitleText, mainReferenceLabel } from './figureRegions';
import { CANVAS_SCALE, getCanvasRenderScale, normalizeCanvasRenderScale, requestCanvasRedraw, setCanvasRenderScale } from './canvasUtils';
import { beginVectorCapture, endVectorCapture, getCanvasRecording, isVectorUsable, replayRecording } from './vectorCapture';
import { PdfRenderer, SvgRenderer } from './vectorRenderers';
import { matchedReadCount, readExportTrackSnapshots, waitForReadTracks } from './readExport';
import { activePanelView, shownPanelViews, viewFileStem, visibleDatasetPanels, type PanelScopeState } from './panelScope';
import { safeFilenamePart } from './analysisExport';
import { panelGap } from '../theme/uiTheme';
import { figureCitationLine } from './citation';

/**
 * The track-figure export behind the Export button, shared with headless
 * rendering (/api/render/figure) so both produce the same image.
 */

export type FigureFormat = 'png' | 'svg' | 'pdf';

export interface FigureOptions {
  format?: FigureFormat;
  /** Output pixels per CSS pixel for PNG (the Export panel's 1x-4x). */
  scale?: number;
  includeTitle?: boolean;
  /** Title text; defaults to the coordinates. */
  title?: string;
  includeCoords?: boolean;
  /** Grow scrolling all-read tracks to show every row. */
  expandReadTracks?: boolean;
  /** Show the same number of reads in every visible sample. */
  matchReadCounts?: boolean;
  /**
   * Draw the figure at the UI size (default): a 150% UI gives 150% text,
   * labels, row heights and strokes, so a figure is as readable as the view.
   * False: at 100%, whatever the UI size.
   */
  matchUiSize?: boolean;
  /** A one-line citation at the foot ("Made with FiberBrowser <version> ..."; default on). */
  includeCitation?: boolean;
}

export interface FigureResult {
  blob: Blob;
  format: FigureFormat;
  width: number;
  height: number;
  /** SVG/PDF: tracks drawn as vectors vs. placed as images (reads, heatmaps). */
  vectorTracks?: number;
  rasterTracks?: number;
  /** The size the figure was drawn at (1 = 100%; the UI size when matched). */
  figureScale?: number;
}

const CONTAINER = '[data-export-container]';
/** PDF points per CSS pixel (96 px per inch, 72 pt per inch). */
const PX_TO_PT = 0.75;
/** Title band above the tracks (layout px; the figure's size scales it). */
const TITLE_HEIGHT = 40;
/** Footer band: the coordinates line, and the datasets line below it when there is one (audit M12). */
const FOOTER_HEIGHT = 30;
const FOOTER_DATASETS_LINE = 14;
/** The citation line: below the footer, or a band of its own without one. */
const FOOTER_CITATION_LINE = 14;
const CITATION_BAND = 20;

/** A reference's short name in a figure (`null`: the main genome). */
export function figureReferenceLabel(key: string | null): string | null {
  return key === null
    ? mainReferenceLabel(useBrowserStore.getState())
    : panelGenomeLabel(usePanelGenomeStore.getState().genomes[key], key);
}

/**
 * The default file name of a figure (after `fiberhmm_`): the regions its panels
 * show, not the main locus (stale in Per panel mode, audit M1). Up to three
 * regions are each named; more: the first and a count. With panels on two
 * references each region carries its reference (their contig names can be the same).
 */
export function figureFileStem(s: PanelScopeState, referenceLabel: (key: string | null) => string | null): string {
  const shown = shownPanelViews(s, { scope: 'all' });
  const views = shown.length ? shown : [activePanelView(s)];
  const references = new Set(views.map(v => v.genomeKey)).size > 1;
  const named = (view: typeof views[number], stem: string) => {
    const name = references ? referenceLabel(view.genome) : null;
    return name ? `${safeFilenamePart(name)}_${stem}` : stem;
  };
  if (views.length > 3) return named(views[0], viewFileStem(views));
  return views.map(v => named(v, viewFileStem(v))).join('_');
}

interface Box { left: number; top: number; right: number; bottom: number }

/**
 * The part of the figure area a figure shows (layout px): the dataset panels and
 * the gap around them. The analysis strip above them and side panels beside them
 * (a drawer, docked) are HTML the figure doesn't draw: they left a blank strip
 * (audit M11). No dataset panel (another layout): the whole area.
 */
export function figureCropBox(panels: Box[], area: { width: number; height: number }, pad: number): Box {
  const boxes = panels.filter(b => b.right > b.left && b.bottom > b.top);
  if (boxes.length === 0) return { left: 0, top: 0, right: area.width, bottom: area.height };
  return {
    left: Math.max(0, Math.min(...boxes.map(b => b.left)) - pad),
    top: Math.max(0, Math.min(...boxes.map(b => b.top)) - pad),
    right: Math.min(area.width, Math.max(...boxes.map(b => b.right)) + pad),
    bottom: Math.min(area.height, Math.max(...boxes.map(b => b.bottom)) + pad),
  };
}

/**
 * What the figure draws of `selector`: what is in a dataset panel. Side panels
 * (charts), stacked above or docked beside them, are not in the figure: their
 * canvases fell over the title or outside the crop. No dataset panel (another
 * layout): everything.
 */
export function figureDrawables<T extends Element>(container: ParentNode, selector: string): T[] {
  const all = Array.from(container.querySelectorAll<T>(selector));
  if (!container.querySelector('[data-panel-id]')) return all;
  return all.filter(el => !!el.closest('[data-panel-id]'));
}

/** The figure's footer height: one line, or two with the datasets line (it was cut off, audit M12); the citation
 * line below them (or a band of its own). */
export function figureFooterHeight(includeCoords: boolean, datasetsLine: boolean, citationLine = false): number {
  const footer = includeCoords ? FOOTER_HEIGHT + (datasetsLine ? FOOTER_DATASETS_LINE : 0) : 0;
  return footer + (citationLine ? (includeCoords ? FOOTER_CITATION_LINE : CITATION_BAND) : 0);
}

/** Where the citation line's baseline is, below the tracks (and the title band). */
export function figureCitationOffset(includeCoords: boolean, datasetsLine: boolean): number {
  return includeCoords ? 20 + (datasetsLine ? FOOTER_DATASETS_LINE : 0) + FOOTER_CITATION_LINE : 14;
}

/** Wait for reads at the export layout and for every canvas at the requested resolution. */
export async function waitForExportRender(targetScale: number): Promise<void> {
  await waitForReadTracks(() => {
    const container = document.querySelector(CONTAINER);
    return !!container && figureDrawables<HTMLCanvasElement>(container, 'canvas').every(canvas => {
      // CSS layout size, before UI zoom: the backing store uses this size too.
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return true;
      return canvas.width >= Math.floor(width * targetScale) - 1
        && canvas.height >= Math.floor(height * targetScale) - 1;
    });
  }, 'The tracks did not finish drawing. Wait for reads to load, or use a smaller view or lower resolution, then export again.');
  const container = document.querySelector(CONTAINER)!;
  for (const canvas of figureDrawables<HTMLCanvasElement>(container, 'canvas')) {
    assertExportSize(canvas.width, canvas.height);
  }
}

/** Refuse oversized backing stores before they can become blank images. */
export function assertExportSize(width: number, height: number): void {
  if (width > 32_767 || height > 32_767 || width * height > 268_435_456) {
    throw new Error('This image is too large to export. Use a lower resolution, fewer reads, or turn off Expand all-read tracks.');
  }
}

/** Wait until every canvas in the figure has drawn again under capture. */
function waitForRecordings(): Promise<void> {
  return new Promise(resolve => {
    const startTime = performance.now();
    const check = () => {
      const container = document.querySelector(CONTAINER);
      // Only what the figure draws (a side panel's chart is never recorded).
      const canvases = container ? figureDrawables<HTMLCanvasElement>(container, 'canvas') : [];
      const done = canvases.every(canvas => {
        const rect = canvas.getBoundingClientRect();
        // Read tracks are placed as images and never recorded.
        return rect.width === 0 || rect.height === 0 || canvas.dataset.figureRaster === 'true' || !!getCanvasRecording(canvas);
      });
      if (done || performance.now() - startTime >= 3000) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(() => requestAnimationFrame(check));
  });
}

/**
 * An inline SVG track (the footprint-class row) as a canvas: only the part that
 * shows on screen (it may sit in a scrolling box), at `scale` px per CSS px.
 */
export async function rasterizeSvgTrack(svg: SVGSVGElement, visible: DOMRect, scale: number): Promise<HTMLCanvasElement | null> {
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0 || visible.width <= 0 || visible.height <= 0) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const logicalWidth = Number(svg.getAttribute('width')) || rect.width;
  const logicalHeight = Number(svg.getAttribute('height')) || rect.height;
  clone.setAttribute('width', String(logicalWidth));
  clone.setAttribute('height', String(logicalHeight));
  // Standalone, an SVG falls back to a serif face: give it the page's.
  clone.style.fontFamily = getComputedStyle(svg).fontFamily;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  const image = new Image();
  image.src = url;
  try { await image.decode(); } catch { return null; }
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(visible.width * scale));
  out.height = Math.max(1, Math.round(visible.height * scale));
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  // Screen px of the SVG box → output px; draw the whole SVG offset so the visible part lands at 0,0.
  const sx = out.width / visible.width;
  const sy = out.height / visible.height;
  ctx.drawImage(image, (rect.left - visible.left) * sx, (rect.top - visible.top) * sy, rect.width * sx, rect.height * sy);
  return out;
}

/** The part of `el` its scrolling ancestors (up to `root`) leave on screen. */
function visibleRect(el: Element, root: Element): DOMRect {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const r = node.getBoundingClientRect();
    left = Math.max(left, r.left); top = Math.max(top, r.top);
    right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

interface FigureText { rect: DOMRect; text: string; font: string; color: string }

/** Encode a PNG, reporting a canvas that the browser could not save. */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Could not create the image. Use a lower resolution or fewer reads, then export again.'))), 'image/png');
  });
}

/** Render the visible tracks to a figure. Temporarily raises canvas resolution
 * and expands read tracks as requested, and always restores them. */
export async function exportTrackFigure(options: FigureOptions = {}): Promise<FigureResult> {
  const format = options.format ?? 'png';
  const scale = options.scale ?? 2;
  const includeTitle = options.includeTitle ?? true;
  const includeCoords = options.includeCoords ?? true;
  const includeCitation = options.includeCitation ?? true;
  const citation = includeCitation ? figureCitationLine() : null;
  const expand = options.expandReadTracks ?? true;
  const matchCounts = options.matchReadCounts ?? false;

  const store = useBrowserStore.getState();
  const { datasets } = store;
  // Each region the panels show (another locus, another assembly), not just the main view's.
  const regions = figureRegions(store, figureReferenceLabel);
  const coords = figureFooterText(regions);
  const vector = format === 'svg' || format === 'pdf';
  // The figure is laid out in the view's own CSS pixels (as at 100%) and drawn
  // at figureScale: the UI size unless asked for 100%. Everything scales with
  // it: text, labels, row heights, strokes, the title and the footer.
  const uiScale = Number.isFinite(store.uiScale) && store.uiScale > 0 ? store.uiScale : 1;
  const figureScale = (options.matchUiSize ?? true) ? uiScale : 1;
  // SVG/PDF: tracks become vectors; what stays raster (reads, heatmaps) is
  // drawn at >= 3x the figure's size so it holds up in print.
  // Canvases render at most at the canvas limit (6x); wait for what they can reach.
  const sourceRenderScale = normalizeCanvasRenderScale(Math.max(CANVAS_SCALE, scale * figureScale, vector ? 3 * figureScale : 0));
  const previousCanvasRenderScale = getCanvasRenderScale();
  const raiseScale = sourceRenderScale > previousCanvasRenderScale;
  const expandTracks = expand || matchCounts;

  try {
    await waitForReadTracks(
      tracks => tracks.every(track => !track.loading),
      'Reads are still loading. Wait for the complete read set, then export again.',
    );
    let matchedTarget: number | null = null;
    if (matchCounts) {
      const container = document.querySelector(CONTAINER);
      if (!container || readExportTrackSnapshots(container).length === 0) {
        throw new Error('No visible read tracks are available to count-match.');
      }
      const settled = await waitForReadTracks(
        tracks => tracks.length > 0 && tracks.every(track => !track.loading),
        'Timed out waiting for visible read counts.',
      );
      matchedTarget = matchedReadCount(settled.map(track => track.workingCount), store.allReadsDisplayCap);
      if (matchedTarget == null || matchedTarget < 1) {
        throw new Error('At least one visible sample has no reads in the current view, so a matched export cannot be created.');
      }
    }

    store.setExportInProgress(true);
    if (matchedTarget != null) store.setExportMatchedReadCounts(matchedTarget, matchedTarget);
    if (expandTracks) store.setExportFullReadTracks(true);
    if (raiseScale) setCanvasRenderScale(sourceRenderScale);

    if (matchedTarget != null) {
      const fetched = await waitForReadTracks(
        tracks => tracks.length > 0 && tracks.every(track => !track.loading && track.fetchCount >= matchedTarget!),
        'Timed out while loading the matched read sample for export.',
      );
      const adjusted = matchedReadCount(fetched.map(track => track.derivedCount), matchedTarget);
      if (adjusted == null || adjusted < 1) {
        throw new Error('At least one visible sample has no reads after the active view filters were applied.');
      }
      if (adjusted !== matchedTarget) {
        store.setExportMatchedReadCounts(adjusted, matchedTarget);
        matchedTarget = adjusted;
      }
      await waitForReadTracks(
        tracks => tracks.length > 0 && tracks.every(track => !track.loading && track.renderCount === matchedTarget),
        'Timed out while rendering the count-matched read tracks.',
      );
    }
    if (vector) {
      // Record every track while it draws again.
      beginVectorCapture();
      requestCanvasRedraw();
      await waitForRecordings();
    }
    await waitForExportRender(sourceRenderScale);
    if (vector) endVectorCapture();

    const container = document.querySelector(CONTAINER) as HTMLElement | null;
    if (!container) throw new Error('Export container not found');
    const containerRect = container.getBoundingClientRect();
    // Screen px per layout px of the figure area: the UI size where the engine
    // reports zoomed boxes (Chromium), 1 where it reports layout ones (WebKit,
    // the desktop app). Everything below is measured in layout px.
    const screenZoom = container.offsetWidth > 0 && containerRect.width > 0 ? containerRect.width / container.offsetWidth : 1;
    const layoutRect = (rect: DOMRect) => new DOMRect(
      (rect.left - containerRect.left) / screenZoom,
      (rect.top - containerRect.top) / screenZoom,
      rect.width / screenZoom,
      rect.height / screenZoom,
    );
    const panelEls = Array.from(container.querySelectorAll<HTMLElement>('[data-panel-id]'));
    const drawn = <T extends Element>(selector: string): T[] => figureDrawables<T>(container, selector);
    const canvases = drawn<HTMLCanvasElement>('canvas');
    const images = drawn<HTMLImageElement>('img');
    // Inline SVG tracks (footprint classes): drawn from their visible part.
    const svgs: Array<{ rect: DOMRect; canvas: HTMLCanvasElement }> = [];
    for (const svg of drawn<SVGSVGElement>('svg[data-figure-svg]')) {
      const visible = visibleRect(svg, container);
      const canvas = await rasterizeSvgTrack(svg, visible, Math.max(scale, vector ? 3 : 1) * figureScale / screenZoom);
      if (canvas) svgs.push({ rect: layoutRect(visible), canvas });
    }
    // HTML rows' grounds and the labels the view shows over them (Clean view off).
    const fills = drawn<HTMLElement>('[data-figure-fill]')
      .map(el => ({ rect: layoutRect(el.getBoundingClientRect()), color: el.dataset.figureFill ?? '#ffffff' }))
      .filter(fill => fill.rect.width > 0 && fill.rect.height > 0);
    const texts: FigureText[] = drawn<HTMLElement>('[data-figure-text]')
      .map(el => {
        const style = getComputedStyle(el);
        // The computed font size is in layout px, like the box (figureScale applies to both).
        const size = parseFloat(style.fontSize) || 11;
        return { rect: layoutRect(el.getBoundingClientRect()), text: el.dataset.figureText ?? '', font: `${style.fontWeight} ${size}px sans-serif`, color: style.color };
      })
      .filter(t => t.text && t.rect.width > 0 && t.rect.height > 0);
    if (canvases.length === 0 && images.length === 0 && svgs.length === 0) throw new Error('Nothing to export: no tracks are drawn');
    // Highlighted regions (components/tracks/HighlightBands.tsx): a wash over the tracks, drawn after them.
    // (In page order; a mark drawn over the washes on screen, e.g. a split SNP's allele pill, says so: data-figure-overlay-top.)
    const overlayEls = drawn<HTMLElement>('[data-figure-overlay]');
    const overlays = [...overlayEls.filter(el => el.dataset.figureOverlayTop == null), ...overlayEls.filter(el => el.dataset.figureOverlayTop != null)]
      .map(el => ({ rect: layoutRect(el.getBoundingClientRect()), color: el.dataset.figureOverlay || '#fde047', opacity: Number(el.dataset.figureOverlayOpacity) || 0.35 }))
      .filter(o => o.rect.width > 0 && o.rect.height > 0);

    // Panel headers are HTML, not canvases; draw them as a colored bar + label.
    const headers = drawn<HTMLElement>('[data-figure-label]')
      .map(el => ({ rect: layoutRect(el.getBoundingClientRect()), label: el.dataset.figureLabel ?? '', color: el.dataset.figureColor ?? '#4b5563' }))
      .filter(header => header.rect.width > 0 && header.rect.height > 0);
    // Layout px from here on; the output is figureScale times this size.
    // The figure is the dataset panels: not the strip above them nor side panels beside them.
    const crop = figureCropBox(
      panelEls.map(el => layoutRect(el.getBoundingClientRect())),
      { width: container.offsetWidth || containerRect.width / screenZoom, height: container.offsetHeight || containerRect.height / screenZoom },
      panelGap(),
    );
    const baseWidth = crop.right - crop.left;
    // Expanded read tracks run below the panels' boxes.
    let contentBottom = crop.bottom;
    for (const el of [...canvases, ...images]) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) contentBottom = Math.max(contentBottom, layoutRect(rect).bottom);
    }
    const baseHeight = Math.ceil(contentBottom - crop.top);
    const titleHeight = includeTitle ? TITLE_HEIGHT : 0;
    // The datasets the figure shows (its panels'), when more than one.
    const shownIds = new Set(visibleDatasetPanels(store).map(p => p.datasetId));
    const shownDatasets = datasets.filter(d => shownIds.has(d.id));
    const datasetLine = shownDatasets.length > 1 ? `Datasets: ${shownDatasets.map(d => d.label).join(', ')}` : null;
    const footerHeight = figureFooterHeight(includeCoords, !!datasetLine, !!citation);
    const totalHeight = baseHeight + titleHeight + footerHeight;
    const outWidth = baseWidth * figureScale;
    const outHeight = totalHeight * figureScale;
    const titleText = options.title || figureTitleText(regions);
    const place = (rect: DOMRect) => ({ x: rect.left - crop.left, y: rect.top - crop.top + titleHeight });

    if (vector) {
      let pdf: import('jspdf').jsPDF | null = null;
      let renderer: SvgRenderer | PdfRenderer;
      if (format === 'pdf') {
        const { jsPDF } = await import('jspdf');
        // Same physical size as before: 1 CSS px = 0.75 pt.
        pdf = new jsPDF({
          orientation: outWidth > outHeight ? 'landscape' : 'portrait',
          unit: 'pt',
          format: [outWidth * PX_TO_PT, outHeight * PX_TO_PT],
          compress: true,
        });
        renderer = new PdfRenderer(pdf, outWidth * PX_TO_PT, outHeight * PX_TO_PT);
      } else {
        renderer = new SvgRenderer(outWidth, outHeight);
      }
      const r = renderer as unknown as CanvasRenderingContext2D & {
        image: (href: string, x: number, y: number, w: number, h: number) => void;
      };
      // Drawn in layout px; the figure's size (UI size or 100%) scales it all.
      const unit = (pdf ? PX_TO_PT : 1) * figureScale;
      r.scale(unit, unit);
      r.fillStyle = '#ffffff';
      r.fillRect(0, 0, baseWidth, totalHeight);
      if (includeTitle) {
        r.fillStyle = '#1f2937';
        r.font = 'bold 18px sans-serif';
        r.textAlign = 'center';
        r.textBaseline = 'alphabetic';
        r.fillText(titleText, baseWidth / 2, 26);
      }
      let vectorTracks = 0;
      let rasterTracks = 0;
      for (const fill of fills) {
        const { x, y } = place(fill.rect);
        r.fillStyle = fill.color;
        r.fillRect(x, y, fill.rect.width, fill.rect.height);
      }
      for (const canvas of canvases) {
        const screen = canvas.getBoundingClientRect();
        if (screen.width === 0 || screen.height === 0) continue;
        const rect = layoutRect(screen);
        const { x, y } = place(rect);
        const recording = getCanvasRecording(canvas);
        if (isVectorUsable(recording)) {
          vectorTracks += 1;
          // Recordings are in the track's own pixels; the page may be zoomed
          // (UI scale), so fit them to the box the canvas occupies.
          const logicalWidth = parseFloat(canvas.style.width) || rect.width;
          const logicalHeight = parseFloat(canvas.style.height) || rect.height;
          r.save();
          r.translate(x, y);
          r.scale(rect.width / logicalWidth, rect.height / logicalHeight);
          // Cut shapes where the canvas edge cut them on screen.
          replayRecording(recording, r as unknown as Parameters<typeof replayRecording>[1],
            { x: 0, y: 0, w: logicalWidth, h: logicalHeight });
          r.restore();
        } else {
          rasterTracks += 1;
          r.image(canvas.toDataURL('image/png'), x, y, rect.width, rect.height);
        }
      }
      for (const image of images) {
        const screen = image.getBoundingClientRect();
        if (screen.width === 0 || screen.height === 0 || !image.complete || image.naturalWidth === 0) continue;
        const rect = layoutRect(screen);
        const { x, y } = place(rect);
        let href: string;
        try {
          const raster = document.createElement('canvas');
          raster.width = image.naturalWidth;
          raster.height = image.naturalHeight;
          raster.getContext('2d')?.drawImage(image, 0, 0);
          href = raster.toDataURL('image/png');
        } catch {
          // Cross-origin image: an SVG can still link it; a PDF can't embed it.
          if (pdf) continue;
          href = image.src;
        }
        rasterTracks += 1;
        r.image(href, x, y, rect.width, rect.height);
      }
      for (const svg of svgs) {
        const { x, y } = place(svg.rect);
        rasterTracks += 1;
        r.image(svg.canvas.toDataURL('image/png'), x, y, svg.rect.width, svg.rect.height);
      }
      for (const o of overlays) {
        const { x, y } = place(o.rect);
        r.save();
        r.globalAlpha = o.opacity;
        r.fillStyle = o.color;
        r.fillRect(x, y, o.rect.width, o.rect.height);
        r.restore();
      }
      // Panel headers last so they sit above any track drawing.
      for (const header of headers) {
        const { x, y } = place(header.rect);
        r.fillStyle = header.color;
        r.fillRect(x, y, header.rect.width, header.rect.height);
        r.fillStyle = '#ffffff';
        r.font = 'bold 13px sans-serif';
        r.textAlign = 'left';
        r.textBaseline = 'middle';
        r.fillText(header.label, x + 8, y + header.rect.height / 2);
      }
      for (const t of texts) {
        const { x, y } = place(t.rect);
        r.fillStyle = t.color;
        r.font = t.font;
        r.textAlign = 'left';
        r.textBaseline = 'middle';
        r.fillText(t.text, x, y + t.rect.height / 2);
      }
      if (includeCoords) {
        const footerY = baseHeight + titleHeight + 20;
        r.fillStyle = '#6b7280';
        r.font = '12px monospace';
        r.textAlign = 'center';
        r.textBaseline = 'alphabetic';
        r.fillText(coords, baseWidth / 2, footerY);
        if (datasetLine) {
          r.font = '10px sans-serif';
          r.fillText(datasetLine, baseWidth / 2, footerY + FOOTER_DATASETS_LINE);
        }
      }
      if (citation) {
        r.fillStyle = '#9ca3af';
        r.font = '9px sans-serif';
        r.textAlign = 'center';
        r.textBaseline = 'alphabetic';
        r.fillText(citation, baseWidth / 2, baseHeight + titleHeight + figureCitationOffset(includeCoords, !!datasetLine));
      }
      const blob = pdf
        ? pdf.output('blob')
        : new Blob([(renderer as SvgRenderer).toSvg()], { type: 'image/svg+xml' });
      return { blob, format, width: outWidth, height: outHeight, vectorTracks, rasterTracks, figureScale };
    }

    // PNG: scale is the output pixel multiplier; source canvases were
    // re-rendered at that scale above, so 3x/4x are real resolution.
    const totalScale = scale * figureScale;
    const exportCanvas = document.createElement('canvas');
    assertExportSize(outWidth * scale, outHeight * scale);
    exportCanvas.width = Math.max(1, Math.round(baseWidth * totalScale));
    exportCanvas.height = Math.max(1, Math.round(totalHeight * totalScale));
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.imageSmoothingEnabled = false;
    ctx.scale(totalScale, totalScale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, baseWidth, totalHeight);
    if (includeTitle) {
      ctx.fillStyle = '#1f2937';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(titleText, baseWidth / 2, 26);
    }
    for (const header of headers) {
      const { x, y } = place(header.rect);
      ctx.fillStyle = header.color;
      ctx.fillRect(x, y, header.rect.width, header.rect.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(header.label, x + 8, y + header.rect.height / 2, Math.max(0, header.rect.width - 16));
      ctx.textBaseline = 'alphabetic';
    }
    fills.forEach(fill => {
      const { x, y } = place(fill.rect);
      ctx.fillStyle = fill.color;
      ctx.fillRect(x, y, fill.rect.width, fill.rect.height);
    });
    canvases.forEach(canvas => {
      const rect = layoutRect(canvas.getBoundingClientRect());
      const { x, y } = place(rect);
      ctx.drawImage(canvas, x, y, rect.width, rect.height);
    });
    images.forEach(image => {
      const screen = image.getBoundingClientRect();
      if (screen.width === 0 || screen.height === 0 || !image.complete || image.naturalWidth === 0) return;
      const rect = layoutRect(screen);
      const { x, y } = place(rect);
      ctx.drawImage(image, x, y, rect.width, rect.height);
    });
    svgs.forEach(svg => {
      const { x, y } = place(svg.rect);
      ctx.drawImage(svg.canvas, x, y, svg.rect.width, svg.rect.height);
    });
    overlays.forEach(o => {
      const { x, y } = place(o.rect);
      ctx.save();
      ctx.globalAlpha = o.opacity;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = o.color;
      ctx.fillRect(x, y, o.rect.width, o.rect.height);
      ctx.restore();
    });
    texts.forEach(t => {
      const { x, y } = place(t.rect);
      ctx.fillStyle = t.color;
      ctx.font = t.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.text, x, y + t.rect.height / 2);
      ctx.textBaseline = 'alphabetic';
    });
    if (includeCoords) {
      const footerY = baseHeight + titleHeight + 20;
      ctx.fillStyle = '#6b7280';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(coords, baseWidth / 2, footerY, Math.max(0, baseWidth - 16));
      if (datasetLine) {
        ctx.font = '10px sans-serif';
        ctx.fillText(datasetLine, baseWidth / 2, footerY + FOOTER_DATASETS_LINE, Math.max(0, baseWidth - 16));
      }
    }
    if (citation) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(citation, baseWidth / 2, baseHeight + titleHeight + figureCitationOffset(includeCoords, !!datasetLine),
        Math.max(0, baseWidth - 16));
    }

    return { blob: await canvasToBlob(exportCanvas), format, width: outWidth, height: outHeight, figureScale };
  } finally {
    endVectorCapture();
    const after = useBrowserStore.getState();
    if (raiseScale) setCanvasRenderScale(previousCanvasRenderScale);
    if (expandTracks) after.setExportFullReadTracks(false);
    if (matchCounts) after.setExportMatchedReadCounts(null);
    after.setExportInProgress(false);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
