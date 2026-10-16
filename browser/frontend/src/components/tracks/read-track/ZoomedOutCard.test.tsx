import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZOOMED_OUT_BANNER_HEIGHT, ZoomedOutCard, zoomedOutMessage } from './ZoomedOutCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ZoomedOutCard', () => {
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
  });
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  it('says the view is past the read limit, not that it has no reads, with the read count', () => {
    // The owner's numb locus: ~24k reads over 150 kb, over the default 100 kb limit.
    const text = zoomedOutMessage(150_000, 100_000, 24_113);
    expect(text).toBe('Zoomed out past the read limit (100 kb): this view is 150 kb. Zoom in, or load reads for this '
      + 'view (24,113 reads here: slow at this depth).');
    expect(text).not.toContain('No reads');
    expect(zoomedOutMessage(150_000, 100_000, 40)).toContain('(40 reads here)');
    expect(zoomedOutMessage(150_000, 100_000, null)).toContain('load reads for this view.');
  });

  it('zooms to the limit, raises the limit once to fit the view, and opens the setting', async () => {
    const onZoom = vi.fn(), onRaise = vi.fn(), onOpenSetting = vi.fn();
    await act(async () => root.render(
      <ZoomedOutCard datasetId="d" width={150_000} limit={100_000} reads={24_113}
        onZoom={onZoom} onRaise={onRaise} onOpenSetting={onOpenSetting} />));
    expect(q('read-track-zoomed-out-text-d')!.textContent).toContain('24,113 reads');
    expect(q('read-track-zoom-to-limit-d')!.textContent).toBe('Zoom to 100 kb here');
    expect(q('read-track-raise-limit-d')!.textContent).toBe('Load reads (limit 200 kb)');
    await act(async () => q('read-track-zoom-to-limit-d')!.click());
    await act(async () => q('read-track-raise-limit-d')!.click());
    await act(async () => q('read-track-limit-setting-d')!.click());
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onRaise).toHaveBeenCalledWith(200_000);
    expect(onOpenSetting).toHaveBeenCalledTimes(1);
  });

  it('is one slim line along the bottom (not over the plot), dismissible in its panel', async () => {
    const onDismiss = vi.fn();
    await act(async () => root.render(
      <ZoomedOutCard datasetId="d" width={150_000} limit={100_000} reads={24_113}
        onRaise={() => {}} onOpenSetting={() => {}} onDismiss={onDismiss} />));
    const wrap = q('read-track-zoomed-out-d')!.parentElement!;
    expect(wrap.className).toContain('bottom-0');
    expect(wrap.style.height).toBe(`${ZOOMED_OUT_BANNER_HEIGHT}px`);
    expect(q('read-track-zoomed-out-text-d')!.title).toContain('Zoomed out past the read limit');
    await act(async () => q('read-track-zoomed-out-dismiss-d')!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('offers no zoom where the panel cannot move the view, and no raise past the largest limit', async () => {
    await act(async () => root.render(
      <ZoomedOutCard datasetId="d" width={50_000_000} limit={10_000_000} reads={null}
        onRaise={() => {}} onOpenSetting={() => {}} />));
    expect(q('read-track-zoom-to-limit-d')).toBeNull();
    expect(q('read-track-raise-limit-d')).toBeNull();
    expect(q('read-track-limit-setting-d')).not.toBeNull();
  });
});
