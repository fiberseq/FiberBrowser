import { describe, expect, it } from 'vitest';
import { assertReadTracksIntact } from './readExport';

// A full-UI export's read refetch can start a few frames after the pre-capture wait settled on the tracks already
// drawn; when it fails or is still loading once the capture is done, the image must not be saved.
function container(tracks: Array<{ loading?: boolean; error?: string }>): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-export-container', '');
  for (const [i, t] of tracks.entries()) {
    const el = document.createElement('div');
    el.setAttribute('data-read-track-dataset-id', `ds${i}`);
    el.setAttribute('data-read-track-loading', t.loading ? 'true' : 'false');
    if (t.error) el.setAttribute('data-read-track-error', t.error);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-copilot-track', 'reads');
    canvas.dataset.readTrackReady = 'true';
    el.appendChild(canvas);
    root.appendChild(el);
  }
  return root;
}

describe('assertReadTracksIntact', () => {
  it('passes drawn tracks', () => {
    expect(() => assertReadTracksIntact(container([{}, {}]))).not.toThrow();
  });
  it('reports a track whose load failed during the capture', () => {
    expect(() => assertReadTracksIntact(container([{}, { error: 'Could not load reads for napa_ddda. Reload the region, then export again.' }])))
      .toThrow('Could not load reads for napa_ddda');
  });
  it('refuses a track still loading', () => {
    expect(() => assertReadTracksIntact(container([{ loading: true }]))).toThrow('did not finish drawing');
  });
  it('does nothing without an export container', () => {
    expect(() => assertReadTracksIntact(null)).not.toThrow();
  });
});
