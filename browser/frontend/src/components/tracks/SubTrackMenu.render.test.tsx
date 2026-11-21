import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { registerInsertionFeatures } from '../../features/register';
import { loadPacks } from '../../plugins/packs';
import { useBrowserStore } from '../../stores/browserStore';
import { usePreviewStore } from '../../utils/previewFeatures';
import type { SubTrackConfig } from '../../types';
import { registeredTrackKinds, registerTrackKind } from './trackRegistry';
import { SubTrackMenu } from './SubTrackMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Tracks menu titles', () => {
  it('renders a non-empty name for every registered row, separately from its description, on a colored header', () => {
    registerInsertionFeatures(); // Includes the hub, graph, nucleosome and lifted-track extensions.
    loadPacks();
    const kinds = registeredTrackKinds();
    const tracks = kinds.map(k => ({ type: k.type === 'composite-' ? 'composite-test' : k.type === 'ortho-' ? 'ortho-1' : k.type,
      visible: true, removed: false })) as SubTrackConfig[];
    useBrowserStore.setState({ panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd', subTracks: tracks }],
      compositeTracks: [{ id: 'test', label: 'Signal track', visible: true, sources: [] }],
      orthogonalTracks: [{ index: 1, label: 'Annotation track' }] } as never);
    usePreviewStore.setState({ enabled: true });
    const host = document.createElement('div');
    host.style.color = 'white'; // Solid PanelHeader foreground, inherited by the old menu.
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<SubTrackMenu panelId="p" subTracks={tracks} anchorRect={new DOMRect()} onClose={() => {}} />));
      const menu = host.querySelector('[role="dialog"]')!;
      expect(menu.classList.contains('text-ink')).toBe(true);
      expect(menu.classList.contains('dark:text-gray-100')).toBe(true);
      const rows = [...menu.querySelectorAll('[data-track-row]')];
      expect(rows).toHaveLength(kinds.length);
      for (const row of rows) {
        const title = row.querySelector('[data-track-title]')!;
        expect(title.textContent?.trim(), row.getAttribute('data-track-row')!).toBeTruthy();
        expect(row.querySelector('input')?.getAttribute('aria-label')).toBe(`Show ${title.textContent}`);
      }
      const microc = menu.querySelector('[data-track-row="microc"]')!;
      expect(microc.querySelector('[data-track-title]')!.textContent).toBe('Micro-C');
      expect(microc.textContent).toContain('with Micro-C loaded');
    } finally {
      act(() => root.unmount()); host.remove();
    }
  });

  it('rejects missing or whitespace-only registration labels at their source', () => {
    expect(() => registerTrackKind({ type: 'unnamed', label: ' ' } as never)).toThrow('non-empty label');
    expect(() => registerTrackKind({ type: 'unnamed' } as never)).toThrow('non-empty label');
  });
});
