export interface ReadExportTrackSnapshot {
  element: HTMLElement;
  datasetId: string;
  workingCount: number;
  derivedCount: number;
  renderCount: number;
  fetchCount: number;
  loading: boolean;
  ready: boolean;
  error: string | null;
}

function readCount(element: HTMLElement, attribute: string): number {
  const value = Number(element.getAttribute(attribute));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function readExportTrackSnapshots(root: ParentNode): ReadExportTrackSnapshot[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-read-track-dataset-id]')).map(element => ({
    element,
    datasetId: element.dataset.readTrackDatasetId ?? '',
    workingCount: readCount(element, 'data-read-track-working-count'),
    derivedCount: readCount(element, 'data-read-track-derived-count'),
    renderCount: readCount(element, 'data-read-track-render-count'),
    fetchCount: readCount(element, 'data-read-track-fetch-count'),
    loading: element.dataset.readTrackLoading === 'true',
    ready: element.querySelector<HTMLCanvasElement>('canvas[data-copilot-track="reads"]')?.dataset.readTrackReady === 'true',
    error: element.dataset.readTrackError || null,
  }));
}

/** Wait for the current tracks to finish fetching and drawing, including tracks remounted by export layout. */
export function waitForReadTracks(
  predicate: (tracks: ReadExportTrackSnapshot[]) => boolean = () => true,
  timeoutMessage = 'Reads are still loading. Wait for the complete read set, then export again.',
  { root, timeoutMs = 30_000 }: { root?: ParentNode; timeoutMs?: number } = {},
): Promise<ReadExportTrackSnapshot[]> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    let previous: ReadExportTrackSnapshot[] | null = null;
    const finish = (error?: Error, tracks: ReadExportTrackSnapshot[] = []) => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      if (error) reject(error); else resolve(tracks);
    };
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    const check = () => {
      const container = root ?? document.querySelector('[data-export-container]');
      if (!container) { finish(new Error('Export container not found')); return; }
      const tracks = readExportTrackSnapshots(container);
      const failed = tracks.find(track => track.error && !track.loading);
      if (failed) { finish(new Error(failed.error!)); return; }
      const ready = tracks.every(track => !track.loading && track.ready) && predicate(tracks);
      // A new layout can mount empty canvases before its fetch effects run. Require
      // the same settled tracks on consecutive frames, not just canvases of the right size.
      if (ready && previous?.length === tracks.length && tracks.every((track, i) =>
        track.element === previous![i].element && track.renderCount === previous![i].renderCount
        && track.fetchCount === previous![i].fetchCount)) {
        finish(undefined, tracks);
        return;
      }
      previous = ready ? tracks : null;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(check); });
  });
}

export function matchedReadCount(counts: number[], displayCap: number): number | null {
  const finiteCounts = counts.filter(count => Number.isFinite(count) && count >= 0);
  if (finiteCounts.length === 0) return null;
  const cap = Math.max(1, Math.min(50_000, Math.floor(Number(displayCap) || 1)));
  return Math.min(cap, ...finiteCounts.map(Math.floor));
}
