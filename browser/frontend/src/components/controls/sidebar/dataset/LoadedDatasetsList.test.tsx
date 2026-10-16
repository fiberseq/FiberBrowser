import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { LoadedDatasetsList } from './LoadedDatasetsList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The empty list pointed at a "File section" the sidebar no longer has.
describe('LoadedDatasetsList', () => {
  it('names no control the app does not have (Load File is not offered on a public server)', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<LoadedDatasetsList datasets={[]} />));
    expect(container.textContent).toBe('No datasets loaded.');
    act(() => root.unmount());
  });
});
