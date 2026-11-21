// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../../stores/browserStore';
import { DEFAULT_SIGNAL_FILTERS, effectiveSignalFilters, signalFilterUrl } from '../../../../utils/signalFilters';
import { SIGNAL_FILTER_SETTINGS, SignalReadFilters } from './SignalReadFilters';
import { SignalDetails } from '../../read-stats/SignalDetails';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const counts = { total: 10, kept: 10, hidden: 0, background: 2, detectable: 4,
  unclassified: 1, unscored: 2, unknown: 1, structure_scored: 0 };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useBrowserStore.setState({ signalFilters: { ...DEFAULT_SIGNAL_FILTERS },
    datasets: [{ id: 'one', label: 'One', path: '/tmp/one.bam', color: '#000', signal_tags: true }],
    signalCounts: { one: { datasetId: 'one', locus: 'chr1:0-100', counts } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('starts off, reports all count categories and disables unscored structure', () => {
  act(() => root.render(<SignalReadFilters />));
  const inputs = Array.from(host.querySelectorAll('input'));
  expect(inputs).toHaveLength(4);
  expect(inputs.every(input => !input.checked)).toBe(true);
  expect(inputs[3].disabled).toBe(true);
  expect(host.textContent).toContain('Unavailable: structure is unscored');
  expect(host.textContent).toContain('10 of 10 kept · 0 hidden · 1 unclassified · 2 unscored · 1 unavailable');
  act(() => inputs[0].click());
  expect(useBrowserStore.getState().signalFilters).toEqual({ ...DEFAULT_SIGNAL_FILTERS, hideBackground: true });
  act(() => inputs[1].click());
  expect(useBrowserStore.getState().signalFilters.excludeUnscored).toBe(true);
});
it('allows independent strict options when structure evidence is available', () => {
  useBrowserStore.setState({ signalCounts: { one: { datasetId: 'one', locus: 'chr1:0-100', counts: { ...counts, structure_scored: 1 } } } });
  act(() => root.render(<SignalReadFilters />));
  const inputs = host.querySelectorAll('input');
  act(() => { inputs[2].click(); inputs[3].click(); });
  expect(useBrowserStore.getState().signalFilters).toEqual({ ...DEFAULT_SIGNAL_FILTERS, requireDetectable: true, requireStructure: true });
});
it('keeps missing model evidence distinct from zero in read details', () => {
  act(() => root.render(<SignalDetails signal={{ status: 'unscored', opportunities: null, p_signal: null,
    background_p: 0, structure: { status: 'unscored', score: null, p_value: null } }} />));
  expect(host.textContent).toContain('Model evidence (p_signal): Not assessed');
  expect(host.textContent).toContain('Background tail (p): 0');
});

describe('without bg/me signal tags in the loaded datasets', () => {
  const untagged = [{ id: 'one', label: 'One', path: '/tmp/one.bam', color: '#000' },
    { id: 'two', label: 'Two', path: '/tmp/two.bam', color: '#111', signal_tags: false }];
  it('offers no signal filters, no counts and no settings-search entries', () => {
    useBrowserStore.setState({ datasets: untagged });
    act(() => root.render(<SignalReadFilters />));
    expect(host.querySelector('[data-testid="signal-filters"]')).toBeNull();
    expect(host.querySelectorAll('input')).toHaveLength(0);
    for (const setting of Object.values(SIGNAL_FILTER_SETTINGS)) expect(setting.hiddenReason?.()).toMatch(/signal tags/);
  });
  it('keeps a saved filter inert: requests and the read track apply none until a tagged dataset loads', () => {
    useBrowserStore.setState({ datasets: untagged, signalFilters: { ...DEFAULT_SIGNAL_FILTERS, requireDetectable: true } });
    expect(effectiveSignalFilters(useBrowserStore.getState())).toEqual(DEFAULT_SIGNAL_FILTERS);
    expect(signalFilterUrl('/api/reads/compact?chrom=chr1')).not.toContain('signal_filters');
    useBrowserStore.setState({ datasets: [...untagged, { id: 'three', label: 'Three', path: '/tmp/3.bam', color: '#222', signal_tags: true }] });
    expect(effectiveSignalFilters(useBrowserStore.getState()).requireDetectable).toBe(true);
    expect(signalFilterUrl('/api/reads/compact?chrom=chr1')).toContain('signal_filters');
  });
  it('shows the filters as soon as one loaded dataset carries the tags', () => {
    useBrowserStore.setState({ datasets: [...untagged, { id: 'three', label: 'Three', path: '/tmp/3.bam', color: '#222', signal_tags: true }] });
    act(() => root.render(<SignalReadFilters />));
    expect(host.querySelectorAll('input')).toHaveLength(4);
    for (const setting of Object.values(SIGNAL_FILTER_SETTINGS)) expect(setting.hiddenReason?.()).toBeNull();
  });
});
