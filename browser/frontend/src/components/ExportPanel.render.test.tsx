import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useReadStatusStore } from '../stores/readStatusStore';
import { ExportPanel, readsInViewFromStatus } from './ExportPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Export dialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ chrom: 'chr1', start: 100, end: 10_100, datasets: [], bookmarks: [] } as never);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useReadStatusStore.setState({ byStateKey: {} });
  });
  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith(name))!;

  // Audit H2: the dialog was 923 px tall with no max height; Cancel/Export fell off a
  // 700-800 px window. It is now capped to the window, its body scrolls, and the actions
  // sit in a footer outside the scrolling body.
  it('fits the window: capped height, scrolling body, actions in a footer outside it', () => {
    act(() => root.render(<ExportPanel onClose={vi.fn()} />));
    const dialog = q('[role="dialog"]')!;
    expect(dialog.className).toContain('max-h-[calc(100vh-2rem)]');
    const body = q('[data-testid="export-dialog-body"]')!;
    expect(body.className).toContain('overflow-y-auto');
    const footer = q('[data-testid="export-dialog-footer"]')!;
    expect(body.contains(footer)).toBe(false);
    expect([...footer.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Cancel', 'Export PNG']);
  });

  // Audit M28: Escape didn't close it.
  it('closes on Escape, without the global Escape running too; an input handling Escape keeps it open', () => {
    const onClose = vi.fn();
    act(() => root.render(<ExportPanel onClose={onClose} />));
    // Typing a filename: Escape belongs to the field, the dialog stays open.
    const input = q<HTMLInputElement>('#export-filename')!;
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onClose).not.toHaveBeenCalled();

    const globalEscape = vi.fn();
    window.addEventListener('keydown', globalEscape);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    window.removeEventListener('keydown', globalEscape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(globalEscape).not.toHaveBeenCalled();
  });

  // Audit M28: the Data tab had three filled primary buttons.
  it('has one primary action per tab', () => {
    act(() => root.render(<ExportPanel onClose={vi.fn()} />));
    expect(container.querySelectorAll('.fb-btn-primary, .btn-tool-primary, .btn-tool-active')).toHaveLength(1);
    act(() => tab('Data').click());
    const primaries = container.querySelectorAll('.fb-btn-primary, .btn-tool-primary, .btn-tool-active');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe('Download .json');
  });

  it('warns before a large working-set TSV, from the reads in view', () => {
    expect(readsInViewFromStatus([{ text: '586/3,170 visible', title: '' }, { text: '0 reads', title: '' }, { text: '1,703 reads', title: '' }])).toBe(4873);
    expect(readsInViewFromStatus([{ text: '586 of 3,170 rows drawn', title: '' }, { text: '1 of 1,703 rows drawn', title: '' }])).toBe(4873);
    // The reads of the panels on screen (fb-n3-export: a hidden panel's reads are not exported).
    useBrowserStore.setState({ panels: [{ id: 'ds1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', layoutRow: 0 }] } as never);
    useReadStatusStore.setState({ byStateKey: { ds1: { text: '312/4,873 visible', title: '' } } });
    act(() => root.render(<ExportPanel onClose={vi.fn()} />));
    act(() => tab('Data').click());
    expect(q('[data-testid="export-working-set-size-warning"]')!.textContent).toContain('4,873 reads');
  });

  // The figure dialog is about the figure: no Bookmarks tab (bookmarks are saved regions in
  // the Regions panel since fb-r4-regions; the tab only pointed there).
  it('is titled Export figure and has Image and Data tabs only', () => {
    act(() => root.render(<ExportPanel onClose={vi.fn()} />));
    expect(q('#export-dialog-title')!.textContent).toBe('Export figure');
    expect([...container.querySelectorAll('[role="tab"]')].map(b => b.textContent)).toEqual(['Image', 'Data']);
    expect(container.textContent).not.toMatch(/Bookmark/);
  });

  // Audit M1 (figure part): in Per panel mode the default file name used the stale main locus.
  it('names the default file after the regions the panels show (Per panel mode)', () => {
    useBrowserStore.setState({
      panels: [{ id: 'a', contentType: 'dataset', datasetId: 'ds', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
        viewportOverride: { chrom: 'chr2', start: 5_000, end: 6_000 } }],
      navigationMode: 'perPanel', selectedDatasets: new Set(), collapsedRows: new Set(), fullViewPanelId: null,
    } as never);
    act(() => root.render(<ExportPanel onClose={vi.fn()} />));
    expect(q<HTMLInputElement>('[data-testid="export-filename"]')!.placeholder).toBe('fiberhmm_chr2_5000-6000_2x.png');
  });

  // Audit L10: Reads: Fit exports the rows on screen; the dialog says so and how to get every read.
  it('says when Reads: Fit leaves reads out of the figure', () => {
    const area = document.createElement('div');
    area.setAttribute('data-export-container', '');
    // Still loading when the dialog opens: no reads yet.
    area.innerHTML = '<div data-read-track-dataset-id="ds" data-read-track-working-count="0" data-read-track-render-count="0"></div>';
    document.body.appendChild(area);
    try {
      useBrowserStore.setState({ readDisplayMode: 'sample' } as never);
      act(() => root.render(<ExportPanel onClose={vi.fn()} />));
      expect(q('[data-testid="export-fit-reads-note"]')).toBeNull();
      // The reads arrive (Codex review: the note stayed absent).
      const track = area.firstElementChild!;
      track.setAttribute('data-read-track-working-count', '3202');
      track.setAttribute('data-read-track-render-count', '120');
      act(() => useReadStatusStore.setState({ byStateKey: { ds: { text: '120/3,202 visible', title: '' } } }));
      expect(q('[data-testid="export-fit-reads-note"]')!.textContent).toMatch(/120 of 3,202 reads.*Reads to All/s);
      // Match read counts draws the matched sample in full, Fit or not: no note.
      act(() => q<HTMLButtonElement>('[data-testid="export-more-options"]')!.click());
      const match = [...container.querySelectorAll<HTMLLabelElement>('label')].find(l => l.textContent?.includes('Match read counts'))!.querySelector('input')!;
      act(() => match.click());
      expect(q('[data-testid="export-fit-reads-note"]')).toBeNull();
      act(() => match.click());
      expect(q('[data-testid="export-fit-reads-note"]')).not.toBeNull();
      act(() => useBrowserStore.setState({ readDisplayMode: 'all' } as never));
      expect(q('[data-testid="export-fit-reads-note"]')).toBeNull();
    } finally {
      area.remove();
    }
  });

  // Audit L18: the export added labels the view doesn't show; the dialog says what the figure shows.
  it('says the figure matches the view and how to include labels', () => {
    act(() => root.render(<ExportPanel onClose={vi.fn()} />));
    expect(q('[data-testid="export-labels-rule"]')!.textContent).toMatch(/as they are on screen.*Clean view/s);
  });
});
