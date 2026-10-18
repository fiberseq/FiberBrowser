import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SvSplitDef } from '../../stores/svSlice';
import { SvSplitCounts } from './SplitPanelsDialog';

const def: SvSplitDef = { datasetId: 'synthetic', chrom: 'chrT', t: 'I', ref: 1000, len: 100,
  end: 1000, margin: 100, label: 'Synthetic insertion', counts: [10, 8, 7], viewStart: 0, viewEnd: 2000 };
const text = (value: SvSplitDef) => {
  const element = document.createElement('div');
  element.innerHTML = renderToStaticMarkup(<SvSplitCounts def={value} />);
  return element.textContent;
};

describe('split dialog evidence counts', () => {
  it.each([false, true])('keeps confirmed counts separate when include-putative is %s', includePutative => {
    const value = { ...def, includePutative, counts: (includePutative ? [15, 8, 2] : [10, 8, 7]) as [number, number, number],
      evidenceCounts: { confirmed: 10, putative: 5, ambiguous: 2 } };
    expect(text(value)).toContain('Confirmed: 10 of 18 informative');
    expect(text(value)).toContain('5 putative · 2 ambiguous');
    expect(text(value)).toContain('all 25 reads in view');
  });
  it('preserves legacy session counts when evidence levels are unavailable', () => {
    expect(text(def)).toContain('Carriers: 10 of 18 informative');
    expect(text(def)).not.toContain('Confirmed:');
  });
});
