import { describe, expect, it } from 'vitest';
import { isSecondaryContig } from './ChromSelector';

describe('isSecondaryContig', () => {
  it('keeps primary chromosomes (any naming) in the main list', () => {
    for (const name of ['chr1', '19', 'chrX', 'chrM', '2L', 'chr2R', 'plasmid_pUC19', 'I']) {
      expect(isSecondaryContig(name)).toBe(false);
    }
  });

  it('moves unplaced, alt, random, patch and decoy contigs aside', () => {
    for (const name of ['chr1_KI270706v1_random', 'chrUn_GL000195v1', 'chr6_GL000250v2_alt', 'chr1_KN196472v1_fix', 'HLA-A*01:01:01:01', 'chrEBV', 'KI270728.1', 'GL000220.1']) {
      expect(isSecondaryContig(name)).toBe(true);
    }
  });
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useBrowserStore } from '../../stores/browserStore';
import { ChromSelector, OTHER_CONTIGS_VALUE } from './ChromSelector';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChromSelector', () => {
  it('lists every contig when none looks primary', () => {
    useBrowserStore.setState({ chroms: [{ name: 'chrEBV', size: 171823 }], chrom: 'chrEBV' } as any);
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(React.createElement(ChromSelector)));
    expect([...container.querySelectorAll('option')].map(o => o.value)).toEqual(['chrEBV']);
    act(() => root.unmount());
  });
});

describe('contig naming edge cases', () => {
  it('treats hg19 alternate haplotypes and upper-case suffixes as secondary, phased chromosomes as primary', () => {
    expect(isSecondaryContig('chr6_apd_hap1')).toBe(true);
    expect(isSecondaryContig('chr1_KI270706V1_RANDOM')).toBe(true);
    expect(isSecondaryContig('chr1_hap1')).toBe(false);
    expect(isSecondaryContig('KI270728.1')).toBe(true);
  });
});

describe('ChromSelector with many secondary contigs (UI audit M32)', () => {
  const dm6Like = () => [
    ...['chr2L', 'chr2R', 'chr3L', 'chr3R', 'chr4', 'chrM', 'chrX', 'chrY'].map(name => ({ name, size: 1_000_000 })),
    ...Array.from({ length: 1862 }, (_, i) => ({ name: `chrUn_DS${483000 + i}v1`, size: 1000 + i })),
    { name: 'chrX_DS483646v1_random', size: 5000 },
  ];
  const mount = () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(React.createElement(ChromSelector)));
    return { container, root, done: () => { act(() => root.unmount()); container.remove(); } };
  };
  const change = (select: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('lists the primary chromosomes and one Other contigs entry, not 1,871 options', () => {
    useBrowserStore.setState({ chroms: dm6Like(), chrom: 'chr2L', start: 0, end: 20000 } as any);
    const { container, done } = mount();
    const options = [...container.querySelectorAll('option')];
    expect(options.length).toBe(9);
    expect(options.slice(0, 8).map(o => o.value)).toEqual(['chr2L', 'chr2R', 'chr3L', 'chr3R', 'chr4', 'chrM', 'chrX', 'chrY']);
    expect(options[8].value).toBe(OTHER_CONTIGS_VALUE);
    expect(options[8].textContent).toContain('Other contigs (1,863)');
    done();
  });

  it('keeps a secondary current contig selectable in the list', () => {
    useBrowserStore.setState({ chroms: dm6Like(), chrom: 'chrX_DS483646v1_random', start: 0, end: 5000 } as any);
    const { container, done } = mount();
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('chrX_DS483646v1_random');
    expect(container.querySelectorAll('option').length).toBe(10);
    done();
  });

  it('Other contigs opens a searchable picker that jumps to the chosen contig; Escape closes it', () => {
    useBrowserStore.setState({ chroms: dm6Like(), chrom: 'chr2L', start: 100, end: 200 } as any);
    const { container, done } = mount();
    const select = container.querySelector('select') as HTMLSelectElement;
    act(() => change(select, OTHER_CONTIGS_VALUE));
    expect(useBrowserStore.getState().chrom).toBe('chr2L');  // opening the picker doesn't navigate
    const search = container.querySelector('[data-testid="chrom-other-search"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(search, '483646v1_rand'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    const opts = [...container.querySelectorAll('[role="option"]')];
    expect(opts.map(o => o.textContent)).toEqual([expect.stringContaining('chrX_DS483646v1_random')]);
    act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useBrowserStore.getState().chrom).toBe('chrX_DS483646v1_random');
    expect(container.querySelector('[data-testid="chrom-other-picker"]')).toBeNull();

    act(() => change(container.querySelector('select') as HTMLSelectElement, OTHER_CONTIGS_VALUE));
    const again = container.querySelector('[data-testid="chrom-other-search"]') as HTMLInputElement;
    act(() => { again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[data-testid="chrom-other-picker"]')).toBeNull();
    done();
  });
});
