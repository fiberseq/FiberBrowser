import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/tracks', async (orig) => ({ ...(await orig() as object), updateTrackFilter: vi.fn(async () => ({ success: true })) }));

import { useBrowserStore } from '../../stores/browserStore';
import { updateTrackFilter } from '../../api/tracks';
import { AnnotationFilterInput } from './TrackContainerAnalysis';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('AnnotationFilterInput', () => {
  it('follows the shared filter and never clears it when left untouched', async () => {
    useBrowserStore.setState({ trackFilters: {} } as any);
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    act(() => root.render(<AnnotationFilterInput trackIndex={0} />));
    const input = host.querySelector('input')!;
    // Another panel applies CTCF: this input shows it.
    act(() => { useBrowserStore.getState().setTrackFilter(0, ['CTCF']); });
    expect(input.value).toBe('CTCF');
    // Focusing and leaving without typing changes nothing.
    await act(async () => { input.focus(); input.blur(); });
    expect(useBrowserStore.getState().trackFilters[0]).toEqual(['CTCF']);
    expect(vi.mocked(updateTrackFilter)).not.toHaveBeenCalled();
    // Typing here and leaving applies it.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      input.focus();
      setValue.call(input, 'REST');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.blur(); });
    expect(useBrowserStore.getState().trackFilters[0]).toEqual(['REST']);
    expect(vi.mocked(updateTrackFilter)).toHaveBeenCalledWith(0, ['REST']);
    act(() => root.unmount());
  });
});
