import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AltAlleleProvenancePill } from './AltAlleleProvenance';
import { registerAltAllelePreview } from './preview';
import type { AltAlleleLayout } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const layout: AltAlleleLayout = {
  chrom: 'chr2L', ref: 9_467_038, insert_len: 9_184, flank_left: 20_000, flank_right: 20_000,
  name: 'chr2L_9467038_INS9184', length: 49_184, insert_start: 20_000, insert_end: 29_184,
};

// Round 3, R14a: one pill ("Pinned to insertion ⓘ") where "PREVIEW ⓘ" and "Pinned to insertion · Show on reference"
// took the room of the panel's title at 480 px; the Preview mark and the way back are in its ⓘ.
describe('the insert-expanded header pill', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    registerAltAllelePreview();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('is one pill naming the coordinate mode; its ⓘ holds the Preview mark and Show on reference', () => {
    const back = vi.fn();
    act(() => root.render(<AltAlleleProvenancePill layout={layout} onShowReference={back} placed="118 of 120 carriers at the site (all reads) placed here" />));
    const pill = container.querySelector<HTMLButtonElement>('[data-testid="alt-allele-chip"]')!;
    expect(pill.textContent).toBe('Pinned to insertionⓘ');
    expect(container.querySelector('[data-testid="preview-badge"]')).toBeNull();
    act(() => pill.click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="alt-allele-provenance"]')!;
    expect(dialog.querySelector('[data-testid="preview-badge"]')).not.toBeNull();
    expect(dialog.textContent).toContain('118 of 120 carriers at the site');
    act(() => dialog.querySelector<HTMLButtonElement>('[data-testid="alt-allele-show-reference"]')!.click());
    expect(back).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="alt-allele-provenance"]')).toBeNull();
  });
});
