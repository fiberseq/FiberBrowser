import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { linkedViewportFilter } from '../dafcStore';
import { QualityGateEditor } from '../../components/controls/labeling/QualityGateEditor';
import type { QualityGate } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('linked split view filter', () => {
  it('filters to nothing when the filtered window loaded no visible molecules', () => {
    expect(linkedViewportFilter(true, false, new Set(), new Set(['a']))).toEqual(new Set());
    expect(linkedViewportFilter(false, true, new Set(['a']), new Set())).toEqual(new Set());
  });

  it("doesn't filter while the window's reads haven't loaded", () => {
    expect(linkedViewportFilter(true, false, null, null)).toBeNull();
    expect(linkedViewportFilter(true, true, null, new Set(['a']))).toEqual(new Set(['a']));
  });

  it('intersects both windows, and is off without a filter', () => {
    expect(linkedViewportFilter(true, true, new Set(['a', 'b']), new Set(['b', 'c']))).toEqual(new Set(['b']));
    expect(linkedViewportFilter(false, false, new Set(['a']), new Set(['b']))).toBeNull();
  });
});

describe('QualityGateEditor', () => {
  it('opens the custom name box when custom… is chosen for a known gate', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let gate = { qualityName: 'aq', minValue: 230, maxValue: null } as unknown as QualityGate;
    const render = () => root.render(
      <QualityGateEditor gate={gate} onChange={g => { gate = g; render(); }} onRemove={() => {}} />,
    );
    act(() => render());
    expect(container.querySelector('input[type="text"]')).toBeNull();
    const select = container.querySelector('select')!;
    act(() => {
      select.value = '__custom__';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
    expect(select.value).toBe('__custom__');
    act(() => root.unmount());
  });
});
