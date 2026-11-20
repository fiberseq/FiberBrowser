import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import type { SubTrackConfig } from '../../types';
import { SubTrackMenu } from './SubTrackMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Tracks menu titles', () => {
  it('sets its own foreground, so titles do not inherit the solid header\'s white text', () => {
    const tracks = ['ruler', 'fire', 'meta', 'reads', 'genes', 'microc'].map(type => ({ type, visible: true, removed: false })) as SubTrackConfig[];
    useBrowserStore.setState({ panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd', subTracks: tracks }] } as never);
    const host = document.createElement('div');
    host.style.color = '#ffffff'; // The solid PanelHeader bar's foreground (theme/uiTheme.ts headerBarStyle).
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<SubTrackMenu panelId="p" subTracks={tracks} anchorRect={new DOMRect()} onClose={() => {}} />));
      const menu = host.querySelector('[role="dialog"]')!;
      expect(menu.classList.contains('text-ink')).toBe(true);
      expect(menu.classList.contains('dark:text-gray-100')).toBe(true);
      const titles = [...menu.querySelectorAll('[data-track-row] [data-track-title]')];
      expect(titles.length).toBeGreaterThan(0);
      for (const t of titles) expect(t.textContent?.trim()).toBeTruthy();
    } finally {
      act(() => root.unmount()); host.remove();
    }
  });
});
