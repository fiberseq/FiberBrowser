import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { ReadSampleNotice, sampleNoticeText } from './ReadSampleNotice';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLED = { level: 2, fraction: 0.25, kept: 3_412, total: 13_650, kept_spanning: 10, total_spanning: 41 };

describe('the read sample notice', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ loadAllReads: {}, exportInProgress: false } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says "N of M reads loaded (sampled)" and why', () => {
    const { text, title } = sampleNoticeText(SAMPLED);
    expect(text).toBe(`${(3412).toLocaleString()} of ${(13650).toLocaleString()} reads loaded (sampled)`);
    expect(title).toContain('1 in 4');
    expect(title).toContain('read every alignment');
  });

  it('nothing when the view was not sampled', async () => {
    await act(async () => { root.render(<ReadSampleNotice datasetId="ds" sampling={null} />); });
    expect(container.innerHTML).toBe('');
  });

  it('"Load all" asks for every read of that dataset (with a time warning), and "Sample" goes back', async () => {
    await act(async () => { root.render(<ReadSampleNotice datasetId="ds" sampling={SAMPLED} />); });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="read-sample-load-all"]')!;
    expect(button.title).toContain('about 4x the time');
    await act(async () => { button.click(); });
    expect(useBrowserStore.getState().loadAllReads).toEqual({ ds: true });
    await act(async () => { root.render(<ReadSampleNotice datasetId="ds" sampling={null} />); });
    expect(container.textContent).toContain('All reads loaded');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="read-sample-resample"]')!.click(); });
    expect(useBrowserStore.getState().loadAllReads).toEqual({});
  });

  it('hidden from figure exports', async () => {
    useBrowserStore.setState({ exportInProgress: true } as any);
    await act(async () => { root.render(<ReadSampleNotice datasetId="ds" sampling={SAMPLED} />); });
    expect(container.innerHTML).toBe('');
  });
});
