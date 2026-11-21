import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadTooltip } from './ReadTrackTooltip';
import type { CompactRead } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(read: CompactRead) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ReadTooltip hoveredRead={{ read, x: 10, y: 10 }} width={800} height={200} chrom="chr1" start={1000}
        myClusterAssignments={{}} myReadStateDetails={null} />,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('ReadTooltip graph-lift and strand lines', () => {
  it('shows where a lifted read came from and its source MAPQ', () => {
    const el = render({ id: 'r1', intervals: [[0, 500, -500]], lift: { from: 'chr1_A:1141849:-', mapq: 7 } });
    expect(el.querySelector('[data-testid="read-lift-provenance"]')?.textContent)
      .toBe('Lifted from chr1_A:1141849:- · source MAPQ 7');
    expect(el.querySelector('[data-testid="read-strand-conflict"]')).toBeNull();
  });

  it('flags a read whose st tag and SEQ marks disagree', () => {
    const el = render({ id: 'r2', intervals: [[0, 500, -500]], strand: 'CT', strand_conflict: true });
    expect(el.querySelector('[data-testid="read-strand-conflict"]')?.textContent)
      .toBe('Strand: CT (st tag); SEQ marks say GA');
    expect(el.querySelector('[data-testid="read-lift-provenance"]')).toBeNull();
  });

  it('adds nothing for an ordinary read', () => {
    const el = render({ id: 'r3', intervals: [[0, 500, -500]], strand: 'GA' });
    expect(el.querySelector('[data-testid="read-lift-provenance"]')).toBeNull();
    expect(el.querySelector('[data-testid="read-strand-conflict"]')).toBeNull();
  });
});
