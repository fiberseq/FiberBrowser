import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatasetPanelLayout } from './DatasetPanelLayout';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

describe('dataset panel height ownership', () => {
  it.each(['rail', 'split', 'graph host'])('%s keeps its header outside the bounded body and sizes canvases to the remaining space', kind => {
    let resize = () => {};
    let available = 272;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => available);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} disconnect() {}
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(<DatasetPanelLayout panelId={kind} style={{ height: 300, border: '1px solid' }}
        header={<div data-testid="header">Dataset header and extensions</div>} initialBodyHeight={272}>
        {height => <div data-testid="rows" style={{ height, minHeight: 0, overflow: 'hidden' }} />}
      </DatasetPanelLayout>));
      const panel = host.querySelector<HTMLElement>('[data-panel-id]')!;
      const body = host.querySelector<HTMLElement>('[data-panel-body]')!;
      const header = host.querySelector<HTMLElement>('[data-panel-header]')!;
      expect(body.contains(header)).toBe(false);
      expect(header.parentElement).toBe(panel);
      expect(header.style.flexShrink).toBe('0');
      expect(panel.style.boxSizing).toBe('border-box');
      expect(panel.style.overflow).toBe('hidden');
      expect(body.style.minHeight).toBe('0');
      expect(body.style.flex).toBe('1 1 0%');
      expect(body.style.overflow).toBe('hidden');
      expect(host.querySelector<HTMLElement>('[data-testid="rows"]')!.style.height).toBe('272px');
      available = 240; // Extra header controls or a resized/stacked panel.
      act(() => resize());
      expect(host.querySelector<HTMLElement>('[data-testid="rows"]')!.style.height).toBe('240px');
    } finally {
      act(() => root.unmount()); vi.unstubAllGlobals();
    }
  });
});
