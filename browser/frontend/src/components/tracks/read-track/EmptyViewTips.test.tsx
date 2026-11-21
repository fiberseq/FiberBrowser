import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { EmptyViewTips } from './EmptyViewTips';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The tips said "Cmd+click always selects footprints" and "Shift+click always selects
// reads", from the click-mode era; there are no click modes, and right-click opens the read menu.
describe('EmptyViewTips', () => {
  it('names right-click, Shift+click and Cmd/Ctrl+click without click-mode wording', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<EmptyViewTips />));
    const text = container.textContent ?? '';
    expect(text).toMatch(/Right-click a read for its actions/);
    expect(text).toMatch(/Shift\+click selects a read, (Cmd|Ctrl)\+click a footprint/);
    expect(text).not.toMatch(/always|mode/i);
    // Plain scroll moves through rows; modified scroll has the same meaning in every panel.
    expect(text).toMatch(/(Cmd|Ctrl)\+scroll zooms the genomic region around the pointer/);
    expect(text).toContain('Shift+scroll sizes read rows in all panels together');
    expect(text).toContain('plain scroll moves through rows');
    expect(text).toMatch(/Drag to pan; \+ \/ − \(or ↑ \/ ↓\) to zoom/);
    act(() => root.unmount());
  });
});
