import { useState, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../stores/browserStore';
import { CANVAS_SCALE, getCanvasRenderScale, setCanvasRenderScale } from '../utils/canvasUtils';
import { assertExportSize, canvasToBlob, downloadBlob, exportTrackFigure, figureFileStem, figureReferenceLabel, waitForExportRender } from '../utils/figureExport';
import { figureRegions, figureTitleText } from '../utils/figureRegions';
import { figureCitationLine, loadFigureCitation, saveFigureCitation } from '../utils/citation';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import { readExportTrackSnapshots } from '../utils/readExport';
import { useReadStatusStore } from '../stores/readStatusStore';
import { Camera, X } from './ui/Icons';
import { DisclosureChevron } from './ui/Disclosure';
import { readsInViewFromStatus } from '../utils/dataExportActions';
import { ExportDataList } from './ExportDataList';
import { EXPORT_DATA_SHORTCUT } from '../utils/shortcuts';

export { readsInViewFromStatus };

type ExportTab = 'image' | 'data';
type ExportFormat = 'png' | 'svg' | 'pdf';

interface Props {
  onClose: () => void;
}

export function ExportPanel({ onClose }: Props) {
  const {
    chrom, start, end,
    panels,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end,
    panels: s.panels,
  })));
  // References' names (panels on another assembly): the title and the file name use them.
  const panelGenomes = usePanelGenomeStore(s => s.genomes);
  // The default file name: the regions the panels show (in Per panel mode the main locus is stale).
  const fileStem = useBrowserStore(s => figureFileStem(s, figureReferenceLabel));
  const defaultFilename = `fiberhmm_${fileStem}`;
  // Reads: Fit shows the reads that fit the track on screen, and the figure shows the
  // same rows (audit L10: at a large UI size that can be a thin band of a few reads).
  const readDisplayMode = useBrowserStore(s => s.readDisplayMode);
  // Read tracks report their counts when they load (the dialog can open while they do).
  const readStatus = useReadStatusStore(s => s.byStateKey);
  const [fitReads, setFitReads] = useState<{ shown: number; total: number } | null>(null);
  useEffect(() => {
    const container = document.querySelector('[data-export-container]');
    const tracks = container ? readExportTrackSnapshots(container) : [];
    const shown = tracks.reduce((n, t) => n + t.renderCount, 0);
    const total = tracks.reduce((n, t) => n + t.workingCount, 0);
    setFitReads(readDisplayMode === 'sample' && total > shown ? { shown, total } : null);
  }, [readDisplayMode, panels, readStatus]);

  const [activeTab, setActiveTab] = useState<ExportTab>('image');
  const [scale, setScale] = useState(2);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [includeTitle, setIncludeTitle] = useState(true);
  const [title, setTitle] = useState('');
  const [includeCoords, setIncludeCoords] = useState(true);
  // The citation line (default on; remembered on this computer when turned off).
  const [includeCitation, setIncludeCitationState] = useState(loadFigureCitation);
  const setIncludeCitation = (on: boolean) => { setIncludeCitationState(on); saveFigureCitation(on); };
  const [captureFullUI, setCaptureFullUI] = useState(false);
  const [expandAllReadTracks, setExpandAllReadTracks] = useState(true);
  const [matchVisibleReadCounts, setMatchVisibleReadCounts] = useState(false);
  // Figures at the UI size by default (readable, as on screen); off: at 100%.
  const [matchUiSize, setMatchUiSize] = useState(true);
  const uiScale = useBrowserStore(s => s.uiScale);
  const [moreOptions, setMoreOptions] = useState(false);
  const datasetCount = useBrowserStore(s => s.datasets.length);

  // Escape closes the dialog. Not from a field (Escape there belongs to the field,
  // e.g. the filename being typed), not when a handler already took it, and not while a
  // menu or dialog opened on top of Export is showing (that one closes first).
  // The app's global Escape doesn't also run.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const overlays = document.querySelectorAll('[aria-modal="true"], .fixed.inset-0 [role="dialog"], [role="menu"], [role="listbox"]');
      if ([...overlays].some(el => !el.closest('[data-export-modal]'))) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [exporting, setExporting] = useState(false);
  const [imageExportError, setImageExportError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');

  const sourceRenderScale = Math.max(CANVAS_SCALE, scale);

  // The figure's default title: every region its panels show (another locus, another assembly).
  const formatCoords = useCallback(() => {
    const st = useBrowserStore.getState();
    return figureTitleText(figureRegions({ ...st, panels, chrom, start, end }, figureReferenceLabel));
    // panelGenomes: a reference's name arriving renames the regions.
  }, [chrom, start, end, panels, panelGenomes]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setImageExportError(null);
    const named = (ext: string, fallback = defaultFilename) => filename.trim() ? `${filename.trim()}.${ext}` : `${fallback}.${ext}`;
    try {
      if (!captureFullUI) {
        const figure = await exportTrackFigure({
          format, scale, includeTitle, title, includeCoords, includeCitation,
          expandReadTracks: expandAllReadTracks,
          matchReadCounts: matchVisibleReadCounts,
          matchUiSize,
        });
        downloadBlob(figure.blob, named(format, format === 'png' ? `${defaultFilename}_${scale}x` : defaultFilename));
        onClose();
        return;
      }
      const previousCanvasRenderScale = getCanvasRenderScale();
      const raiseScale = sourceRenderScale > previousCanvasRenderScale;
      useBrowserStore.getState().setExportInProgress(true);
      if (raiseScale) setCanvasRenderScale(sourceRenderScale);
      try {
        await waitForExportRender(sourceRenderScale);
        // Native SVG/HTML capture preserves CSS zoom, controls and text metrics.
        if (captureFullUI) {
          const root = document.querySelector('[data-browser-root]') as HTMLElement;
          if (!root) throw new Error('Browser root not found');

          const { toCanvas } = await import('html-to-image');
          const uiScale = scale * (window.devicePixelRatio || 1);
          assertExportSize(root.clientWidth * uiScale, root.clientHeight * uiScale);
          const canvas = await toCanvas(root, {
            pixelRatio: uiScale,
            backgroundColor: '#ffffff',
            filter: (el) => {
              // Hide the export panel modal itself from the capture
              return !(el instanceof Element && el.closest('[data-export-modal]'));
            },
          });

          const uiFilename = `fiberhmm_ui_${fileStem}`;

          if (format === 'pdf') {
            const { jsPDF } = await import('jspdf');
            const imgData = canvas.toDataURL('image/png');
            const pdfWidth = canvas.width / uiScale * 0.75;
            const pdfHeight = canvas.height / uiScale * 0.75;
            const orientation = pdfWidth > pdfHeight ? 'landscape' : 'portrait';
            const pdf = new jsPDF({ orientation, unit: 'pt', format: [pdfWidth, pdfHeight] });
            pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
            pdf.save(filename.trim() ? `${filename.trim()}.pdf` : `${uiFilename}.pdf`);
            onClose();
          } else if (format === 'svg') {
            // SVG: embed the full UI capture as a raster image
            const svgNS = 'http://www.w3.org/2000/svg';
            const w = canvas.width / uiScale;
            const h = canvas.height / uiScale;
            const svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('xmlns', svgNS);
            svg.setAttribute('width', w.toString());
            svg.setAttribute('height', h.toString());
            const img = document.createElementNS(svgNS, 'image');
            img.setAttribute('width', w.toString());
            img.setAttribute('height', h.toString());
            img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', canvas.toDataURL('image/png'));
            svg.appendChild(img);
            const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
            downloadBlob(blob, filename.trim() ? `${filename.trim()}.svg` : `${uiFilename}.svg`);
            onClose();
          } else {
            downloadBlob(await canvasToBlob(canvas), filename.trim() ? `${filename.trim()}.png` : `${uiFilename}_${scale}x.png`);
            onClose();
          }
          return;
        }
      } finally {
        if (raiseScale) setCanvasRenderScale(previousCanvasRenderScale);
        useBrowserStore.getState().setExportInProgress(false);
      }
    } catch (err) {
      console.error('Export failed:', err);
      setImageExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [scale, format, sourceRenderScale, includeTitle, title, includeCoords, captureFullUI, expandAllReadTracks, matchVisibleReadCounts, matchUiSize, includeCitation, defaultFilename, fileStem, onClose, filename, waitForExportRender]);

  return (
    <div data-export-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      {/* Never taller than the window: the body scrolls, the actions stay in reach at the bottom. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        data-testid="export-dialog"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-apple-lg border border-line/60 bg-white/95 shadow-modal backdrop-blur-xl dark:border-white/10 dark:bg-dark-surface/95 dark:shadow-modal-dark"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-3 dark:border-white/10">
          <h2 id="export-dialog-title" className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-100">
            <span className="flex h-7 w-7 items-center justify-center rounded-fb bg-brand-50 text-brand-700 ring-1 ring-brand-100 dark:bg-brand-400/15 dark:text-brand-300 dark:ring-brand-400/20" aria-hidden="true"><Camera size={15} /></span>
            Export figure
          </h2>
          <button
            onClick={onClose}
            className="fb-icon-btn"
            aria-label="Close export dialog"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b dark:border-white/10" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'image'}
            onClick={() => setActiveTab('image')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium ${
              activeTab === 'image'
                ? 'text-brand-700 border-b-2 border-brand-600 dark:text-brand-300 dark:border-brand-400'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            Image
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'data'}
            onClick={() => setActiveTab('data')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium ${
              activeTab === 'data'
                ? 'text-brand-700 border-b-2 border-brand-600 dark:text-brand-300 dark:border-brand-400'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            Data
          </button>
        </div>

        {/* Content: scrolls when the window is short */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="export-dialog-body">
          {activeTab === 'data' ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Every data export, by what it is about (also Export data in the top bar, {EXPORT_DATA_SHORTCUT}). Individual plots also offer Data TSV in their save menus.
              </p>
              <ExportDataList onOpenPanel={onClose} />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Format selector */}
              <div>
                <div className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Format</div>
                <div className="flex gap-2" role="group" aria-label="Format">
                  {(['png', 'svg', 'pdf'] as const).map(f => (
                    <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)}
                      className={`fb-btn px-3 py-1 border ${format === f ? 'border-brand-600 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-400/15 dark:text-brand-200' : 'border-line bg-white text-gray-700 hover:bg-surface-sunken dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-200'}`}>
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {format === 'svg'
                    ? 'SVG: tracks, labels and axes as editable vectors; reads and heatmaps as a high-resolution image'
                    : format === 'pdf'
                      ? 'PDF: tracks, labels and axes as editable vectors; reads and heatmaps as a high-resolution image'
                      : 'PNG: Raster format with crisp pixel rendering'}
                </p>
              </div>

              {/* Scale selector (PNG only, not PDF or SVG) */}
              {format === 'png' && (
                <div>
                  <div className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Resolution scale</div>
                  <div className="flex gap-2" role="group" aria-label="Resolution scale">
                    {[1, 2, 3, 4].map((s) => (
                      <button key={s} type="button" aria-pressed={scale === s} onClick={() => setScale(s)}
                        className={`fb-btn px-3 py-1 border ${scale === s ? 'border-brand-600 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-400/15 dark:text-brand-200' : 'border-line bg-white text-gray-700 hover:bg-surface-sunken dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-200'}`}>
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Title option */}
              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={includeTitle}
                    onChange={(e) => setIncludeTitle(e.target.checked)}
                    className="rounded"
                    disabled={captureFullUI}
                  />
                  <span className={`text-sm font-medium ${captureFullUI ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>Include title</span>
                </label>
                {includeTitle && !captureFullUI && (
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={formatCoords()}
                    className="input-tool mt-2 w-full"
                  />
                )}
              </div>

              {/* Coordinates footer option */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeCoords}
                  onChange={(e) => setIncludeCoords(e.target.checked)}
                  className="rounded"
                  disabled={captureFullUI}
                />
                <span className={`text-sm font-medium ${captureFullUI ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>Include coordinates footer</span>
              </label>

              {/* Citation line: "Made with FiberBrowser <version> ... please cite" (More menu: How to cite) */}
              <label className="flex items-center gap-2" title={figureCitationLine()}>
                <input
                  type="checkbox"
                  checked={includeCitation}
                  onChange={(e) => setIncludeCitation(e.target.checked)}
                  className="rounded"
                  disabled={captureFullUI}
                  data-testid="export-citation-line"
                />
                <span className={`text-sm font-medium ${captureFullUI ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>Citation line (FiberBrowser version)</span>
              </label>

              {/* UI size: the figure as large as the view (a 150% UI gives a 150% figure) */}
              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={matchUiSize || captureFullUI}
                    onChange={(e) => setMatchUiSize(e.target.checked)}
                    className="rounded"
                    disabled={captureFullUI}
                    data-testid="export-match-ui-size"
                  />
                  <span className={`text-sm font-medium ${captureFullUI ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>
                    Match UI size ({Math.round((uiScale || 1) * 100)}%)
                  </span>
                </label>
                <p className="ml-6 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Text, labels, row heights and lines as large as on screen (View settings, UI size); off: at 100%
                </p>
              </div>

              {/* Full UI capture option */}
              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={captureFullUI}
                    onChange={(e) => setCaptureFullUI(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Capture full UI</span>
                </label>
                <p className="ml-6 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Include sidebar, toolbar, and controls as they appear on screen
                </p>
              </div>

              {/* What goes in the figure: the view as it is on screen. */}
              {!captureFullUI && (
                <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="export-labels-rule">
                  The figure shows the tracks as they are on screen, row for row. Track labels that appear only on hover are left out;
                  turn off <span className="font-medium">Clean view</span> in a dataset&apos;s header to show its labels, on screen and in the figure.
                </p>
              )}
              {/* Match read counts expands Fit tracks to the matched sample: the note doesn't apply. */}
              {!captureFullUI && !matchVisibleReadCounts && fitReads && (
                <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="export-fit-reads-note">
                  Reads: Fit shows the {fitReads.shown.toLocaleString()} of {fitReads.total.toLocaleString()} reads that fit on screen, and so does the figure.
                  For every read, set Reads to All: Expand all-read tracks (Read track options) then draws every row.
                </p>
              )}

              {/* Less used read-track options */}
              <div className="rounded-lg border border-line/80 dark:border-white/10">
                <button
                  type="button"
                  onClick={() => setMoreOptions(v => !v)}
                  aria-expanded={moreOptions}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium text-gray-700 dark:text-gray-300"
                  data-testid="export-more-options"
                >
                  <DisclosureChevron open={moreOptions} />
                  Read track options
                  <span className="ml-auto text-xs font-normal text-gray-500 dark:text-gray-400">
                    {[expandAllReadTracks && !matchVisibleReadCounts ? 'all rows' : null, matchVisibleReadCounts ? 'counts matched' : null].filter(Boolean).join(' · ') || 'as shown'}
                  </span>
                </button>
                {moreOptions && (
                  <div className="space-y-3 border-t border-line/80 px-3 py-2.5 dark:border-white/10">
                    <div>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={expandAllReadTracks}
                          onChange={(e) => setExpandAllReadTracks(e.target.checked)}
                          disabled={captureFullUI || matchVisibleReadCounts}
                          className="rounded"
                        />
                        <span className={`text-sm font-medium ${captureFullUI || matchVisibleReadCounts ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>
                          Expand all-read tracks
                        </span>
                      </label>
                      <p className="ml-6 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        When Reads are in All mode, export the full row set instead of only the scroll viewport.
                      </p>
                    </div>
                    <div>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={matchVisibleReadCounts}
                          onChange={(e) => setMatchVisibleReadCounts(e.target.checked)}
                          disabled={captureFullUI}
                          className="rounded"
                        />
                        <span className={`text-sm font-medium ${captureFullUI ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>
                          Match read counts across visible samples
                        </span>
                      </label>
                      <p className="ml-6 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        Sample every visible, non-minimized read track to the lowest active read count (up to Display max), then expand it at the selected row height.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Filename */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="export-filename">
                  Filename
                </label>
                <input
                  id="export-filename"
                  type="text"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder={`${captureFullUI ? `fiberhmm_ui_${fileStem}` : defaultFilename}${format === 'png' ? `_${scale}x` : ''}.${format}`}
                  data-testid="export-filename"
                  className="input-tool w-full"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Leave blank for the default name; .{format} is added. {formatCoords()}{format === 'png' ? `, ${scale}x` : ''}{datasetCount > 1 ? `, ${datasetCount} datasets` : ''}.
                </p>
              </div>

              {imageExportError && (
                <div className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {imageExportError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions: always on screen */}
        <div className="flex shrink-0 justify-end gap-2 border-t px-5 py-3 dark:border-white/10" data-testid="export-dialog-footer">
          {activeTab === 'image' ? (
            <>
              <button type="button" onClick={onClose} className="fb-btn-secondary px-4 py-1.5 text-[13px]">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="fb-btn-primary px-4 py-1.5 text-[13px]"
              >
                {exporting && (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                )}
                Export {format.toUpperCase()}
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose} className="fb-btn-secondary px-4 py-1.5 text-[13px]">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
