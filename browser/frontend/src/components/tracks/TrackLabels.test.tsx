import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { HoverHint, HoverLabel, TrackLabelsProvider, useTrackLabels } from './TrackLabels';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const o = useTrackLabels();
  return <i data-clean={String(o.clean)} data-hover={String(o.hover)} />;
}

describe('track labels: clean data on screen, labels on hover; figures match the view', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState({ exportInProgress: false } as never);
  });
  const tree = () => (
    <TrackLabelsProvider>
      <div className="fb-track-row"><Probe /><HoverLabel>Peaks</HoverLabel><HoverHint>No genes in region</HoverHint></div>
    </TrackLabelsProvider>
  );

  it('on screen: the canvas draws no labels and the hover labels are in the row', () => {
    act(() => root.render(tree()));
    expect(container.querySelector('i')!.dataset).toMatchObject({ clean: 'true', hover: 'true' });
    expect(container.querySelector('.fb-hover-label')?.textContent).toBe('Peaks');
    expect(container.querySelector('.fb-hover-hint')?.textContent).toBe('No genes in region');
  });

  // Audit L18: exports used to add labels the view never shows at rest (and so differed
  // from the screen). A figure now shows what the view shows: in Clean view, no labels.
  it('while exporting in Clean view: no labels on the canvas and the hover labels are left out', () => {
    useBrowserStore.setState({ exportInProgress: true } as never);
    act(() => root.render(tree()));
    expect(container.querySelector('i')!.dataset).toMatchObject({ clean: 'true', hover: 'false' });
    expect(container.querySelector('[data-hover-label]')).toBeNull();
  });

  it('Clean view off: labels stay on the canvas (on a pill), on screen and in exports', () => {
    for (const exporting of [false, true]) {
      useBrowserStore.setState({ exportInProgress: exporting } as never);
      act(() => root.render(<TrackLabelsProvider showLabels><Probe /><HoverLabel>Peaks</HoverLabel></TrackLabelsProvider>));
      expect(container.querySelector('i')!.dataset).toMatchObject({ clean: 'false', hover: 'false' });
      expect(container.querySelector('[data-hover-label]')).toBeNull();
    }
  });

  it('without a provider (split view) the canvas keeps its labels', () => {
    act(() => root.render(<Probe />));
    expect(container.querySelector('i')!.dataset).toMatchObject({ clean: 'false', hover: 'false' });
  });
});
