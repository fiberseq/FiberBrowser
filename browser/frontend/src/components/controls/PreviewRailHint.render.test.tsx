import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAnalysisPanel } from '../../plugins/registry';
import { registerPreviewFeature, resetPreviewsForTests, previewsEnabled } from '../../utils/previewFeatures';
import { PreviewFeaturesSettings } from './sidebar/view/PreviewFeaturesSettings';
import { PREVIEW_HINT_KEY, PreviewRailHint } from './PreviewRailHint';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

registerPreviewFeature({ id: 'demo-preview', label: 'Demo panel', summary: 'Shows a demo.', limitations: [], graduation: 'Never.' });
registerAnalysisPanel({ contentType: 'demo-preview-panel', label: 'Demo', component: () => null, preview: 'demo-preview' } as never);

// Usability round 2, N8: what "Show preview features" controls, said in both states; a hint in the rail.
describe('Preview vocabulary', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.removeItem(PREVIEW_HINT_KEY);
    resetPreviewsForTests(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelectorAll('[data-testid="preview-rail-hint-popover"]').forEach(el => el.remove());
    resetPreviewsForTests(false);
  });
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it('Settings lists the Preview features while the switch is off, and while it is on', async () => {
    await act(async () => root.render(<PreviewFeaturesSettings />));
    expect(q('preview-features-list')?.dataset.state).toBe('off');
    expect(q('preview-features-list-heading')?.textContent).toBe('Turning it on adds:');
    expect(q('preview-features-list')?.textContent).toContain('Demo panel');
    await act(async () => resetPreviewsForTests(true));
    expect(q('preview-features-list')?.dataset.state).toBe('on');
    expect(q('preview-features-list')?.textContent).toContain('Demo panel');
  });

  it('previews off: a rail tile says the panel is a Preview feature; Turn on turns them on, once', async () => {
    await act(async () => root.render(<PreviewRailHint />));
    const tile = q('preview-rail-hint')!;
    expect(tile.getAttribute('aria-label')).toBe('Demo is a Preview feature: turn on');
    await act(async () => tile.click());
    expect(q('preview-rail-hint-popover')?.textContent).toContain('Demo is a Preview feature');
    await act(async () => q('preview-rail-hint-turn-on')!.click());
    expect(previewsEnabled()).toBe(true);
    expect(localStorage.getItem(PREVIEW_HINT_KEY)).toBe('1');
    await act(async () => resetPreviewsForTests(false));
    expect(q('preview-rail-hint')).toBeNull();
  });

  it('Not now removes it for good on later mounts', async () => {
    await act(async () => root.render(<PreviewRailHint />));
    await act(async () => q('preview-rail-hint')!.click());
    await act(async () => q('preview-rail-hint-dismiss')!.click());
    expect(q('preview-rail-hint')).toBeNull();
    expect(previewsEnabled()).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<PreviewRailHint />));
    expect(q('preview-rail-hint')).toBeNull();
  });
});
