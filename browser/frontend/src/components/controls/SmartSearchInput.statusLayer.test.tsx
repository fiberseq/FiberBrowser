import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { runFromPalette, type SearchSuggestion } from '../../utils/search/providers';
import { SmartSearchInput } from './SmartSearchInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Audit L6 (fb-n3-search): with "Each panel navigates" the main locus box sits
 * in a faded, disabled group of the toolbar. A palette pick run there (a read
 * found: "4741_FP64DJ_3 at chr3L:…") showed its outcome inside that group: a
 * faded line with no visible background over the toolbar below. It is drawn
 * outside the faded group now.
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(disabled: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(
    // As Browser.tsx wraps the main navigation controls in Per panel mode.
    <fieldset disabled={disabled} className={disabled ? 'contents [&>*]:opacity-40' : 'contents'} data-testid="main-navigation-controls">
      <SmartSearchInput disabled={disabled} disabledReason="Each panel navigates" />
    </fieldset>,
  ));
}

const found: SearchSuggestion = {
  id: 'r', kind: 'read', label: '4741_FP64DJ_3', score: 950,
  run: () => ({ ok: true, message: '4741_FP64DJ_3 at chr3L:5,064,641-5,065,114' }),
};

beforeEach(() => {
  useBrowserStore.setState({ chrom: 'chr19', start: 1_000, end: 2_000, chroms: [{ name: 'chr19', size: 58_617_616 }] as never } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

describe('the main locus box status line (L6)', () => {
  it('grayed out (Per panel): a palette pick\'s outcome is drawn outside the faded group', async () => {
    render(true);
    await act(async () => { await runFromPalette(found); });
    const status = document.querySelector('[data-testid="location-search-info"]');
    expect(status?.textContent).toContain('4741_FP64DJ_3 at chr3L');
    expect(status?.closest('fieldset')).toBeNull();
    expect(status?.className).toContain('bg-white');
  });

  it('active: it stays under the box, as before', async () => {
    render(false);
    await act(async () => { await runFromPalette(found); });
    const status = document.querySelector('[data-testid="location-search-info"]');
    expect(status?.textContent).toContain('4741_FP64DJ_3 at chr3L');
    expect(status?.closest('fieldset')).not.toBeNull();
  });
});
