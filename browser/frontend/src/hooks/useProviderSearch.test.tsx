/**
 * fb-n4-tour: the render right after the text changes (before that text's
 * search has started) reported the previous text's answers as complete
 * (pending false), so a key handled in it (Enter in the command palette, as
 * Playwright's fill + Enter does) ran a row without waiting for the genes.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { searchGene } = vi.hoisted(() => ({ searchGene: vi.fn() }));
vi.mock('../api/reference', () => ({ searchGene }));

import '../utils/search/builtinProviders';
import { useBrowserStore } from '../stores/browserStore';
import type { SearchContext } from '../utils/search/providers';
import { useProviderSearch } from './useProviderSearch';

type Seen = { query: string; pending: boolean; groups: number };
const seen: Seen[] = [];
const context = (signal: AbortSignal): SearchContext => ({ source: 'palette', signal });

function Probe({ query }: { query: string }) {
  const { pending, groups } = useProviderSearch(query, context, 'k');
  seen.push({ query, pending, groups: groups.length });
  return null;
}

describe('useProviderSearch and a new text', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    seen.length = 0;
    searchGene.mockReset().mockReturnValue(new Promise(() => {}));
    useBrowserStore.setState({ chroms: [{ name: 'chr19', size: 58_000_000 }] } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('is pending, with no answers, from the first render of a gene-like text', () => {
    act(() => root.render(<Probe query="" />));
    act(() => root.render(<Probe query="NAPA" />));
    const first = seen.find(s => s.query === 'NAPA')!;
    expect(first).toEqual({ query: 'NAPA', pending: true, groups: 0 });
  });

  it('a text no server provider could answer is not pending once searched', () => {
    act(() => root.render(<Probe query="read-end footprints" />));
    expect(seen[seen.length - 1].pending).toBe(false);
    expect(searchGene).not.toHaveBeenCalled();
  });
});
