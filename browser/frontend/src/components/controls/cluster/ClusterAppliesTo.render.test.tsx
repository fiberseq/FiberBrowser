import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { ClusterAppliesTo } from './ClusterAppliesTo';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const panel = (id: string, datasetId: string) => ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 });

describe('Cluster "Panels" (round 2: N2 keyboard, N7 chip, N15 wording; round 3: R8)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const key = (key: string, opts: KeyboardEventInit = {}) => act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  });
  const menu = () => document.querySelector<HTMLElement>('[data-testid="cluster-applies-to-menu"]');
  const button = () => container.querySelector<HTMLButtonElement>('[data-testid="cluster-applies-to"]')!;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 500, currentGenome: 'dm6',
      datasets: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
      panels: [panel('pa', 'a'), panel('pb', 'b')],
      selectedDatasets: new Set(), selectedPeaks: new Set(), peaksByRule: {}, peakRules: [], peakModes: {},
      clusterPeakMode: 'accessibility', clusterFeatureRules: [], selectedFeatures: [], filteredReadIds: {}, selectedGenes: new Set(),
    } as any);
    act(() => root.render(<ClusterAppliesTo />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows a short chip naming what it chooses, and no "Clustered" before a run', () => {
    expect(container.querySelector('[data-testid="cluster-applies-to-short"]')!.textContent).toBe('Panels: all');
    expect(button().getAttribute('aria-label')).toContain('Panels: all.');
    act(() => button().click());
    const m = menu()!;
    expect(m.textContent).toContain('Panels for Cluster, Sort and Filter');
    expect(m.textContent).not.toContain('Clustered');
    expect(Array.from(m.querySelectorAll('[data-testid="cluster-applies-status"]')).map(e => e.textContent)).toEqual(['Will cluster', 'Will cluster']);
    expect(m.querySelector('[data-testid="cluster-applies-to-scope"]')!.textContent).toContain('Sort and Filter act on the same panels');
    expect(m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-all-input"]')!.checked).toBe(true);
    // All compatible panels: the rows are status only (nothing to tick that the mode ignores).
    expect(m.querySelectorAll('li[data-testid="cluster-applies-row"] input')).toHaveLength(0);
    expect(Array.from(m.querySelectorAll('[data-testid="cluster-applies-name"]')).map(e => e.textContent)).toEqual(['Alpha', 'Beta']);
  });

  it('focus opens on the checked radio; ↑/↓ move between rows, Space ticks, Tab stays inside, Escape returns to the chip', () => {
    button().focus();
    act(() => button().click());
    let m = menu()!;
    const allRadio = m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-all-input"]')!;
    const selRadio = m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-selected-input"]')!;
    expect(document.activeElement).toBe(allRadio);
    // All mode: ↑/↓ go between the radios only (the rows are status).
    key('ArrowDown');
    expect(document.activeElement).toBe(selRadio);
    key('ArrowDown');
    expect(document.activeElement).toBe(allRadio);
    // Picking "Selected panels" shows the boxes.
    key('ArrowDown');
    act(() => selRadio.click());
    m = menu()!;
    const rows = Array.from(m.querySelectorAll<HTMLInputElement>('li[data-testid="cluster-applies-row"] input'));
    expect(rows).toHaveLength(2);
    key('ArrowDown');
    expect(document.activeElement).toBe(rows[0]);
    key('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    key('ArrowDown');
    // Wraps to the first row (the mode radios come first).
    expect(document.activeElement).toBe(allRadio);
    key('ArrowUp');
    expect(document.activeElement).toBe(rows[1]);
    // Space on a checkbox ticks it (the browser's own default; jsdom: a click).
    act(() => rows[1].click());
    expect(useBrowserStore.getState().selectedDatasets.has('pb')).toBe(true);
    expect(selRadio.checked).toBe(true);
    // Tab from the last control wraps to the first; Shift+Tab from the first to the last.
    const focusables = Array.from(m.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])'))
      .filter(el => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked));
    focusables[focusables.length - 1].focus();
    key('Tab');
    expect(document.activeElement).toBe(focusables[0]);
    // (The radio group is one Tab stop, its checked radio: "Selected panels" now.)
    expect(document.activeElement).toBe(selRadio);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    key('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('with a target, focus opens on "Selected panels" and the chip names the panel', () => {
    act(() => useBrowserStore.setState({ selectedDatasets: new Set(['pa']) } as any));
    expect(container.querySelector('[data-testid="cluster-applies-to-short"]')!.textContent).toBe('Panels: Alpha');
    act(() => button().click());
    expect(document.activeElement).toBe(menu()!.querySelector('[data-testid="cluster-applies-selected-input"]'));
  });

  it('"All compatible panels" clears the targets; "Selected panels" waits for a tick', () => {
    act(() => useBrowserStore.setState({ selectedDatasets: new Set(['pa']) } as any));
    act(() => button().click());
    let m = menu()!;
    expect(m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-selected-input"]')!.checked).toBe(true);
    const status = () => Array.from(menu()!.querySelectorAll('li [data-testid="cluster-applies-status"]')).map(e => e.textContent);
    expect(status()).toEqual(['Will cluster', 'Not selected']);
    act(() => m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-all-input"]')!.click());
    expect(useBrowserStore.getState().selectedDatasets.size).toBe(0);
    m = menu()!;
    act(() => m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-selected-input"]')!.click());
    expect(m.querySelector<HTMLInputElement>('[data-testid="cluster-applies-selected-input"]')!.checked).toBe(true);
    expect(useBrowserStore.getState().selectedDatasets.size).toBe(0);
    // Said: with none ticked the run still takes every compatible panel (and the rows say so).
    expect(m.querySelector('[data-testid="cluster-applies-selected"]')!.textContent).toContain('until you tick one, Cluster takes all compatible panels');
    expect(status()).toEqual(['Will cluster', 'Will cluster']);
    // Tick one, then untick it: back to "All compatible panels" (what the run then does).
    const boxes = () => Array.from(menu()!.querySelectorAll<HTMLInputElement>('li[data-testid="cluster-applies-row"] input'));
    act(() => boxes()[0].click());
    expect(useBrowserStore.getState().selectedDatasets.has('pa')).toBe(true);
    boxes()[0].focus();
    act(() => boxes()[0].click());
    expect(useBrowserStore.getState().selectedDatasets.size).toBe(0);
    expect(menu()!.querySelector<HTMLInputElement>('[data-testid="cluster-applies-all-input"]')!.checked).toBe(true);
    // The box it was on is gone (All mode rows are status only): focus is on the checked radio, still in the picker.
    expect(document.activeElement).toBe(menu()!.querySelector('[data-testid="cluster-applies-all-input"]'));
  });

  it('unticking linked panels (they toggle together) goes back to "All compatible panels"', () => {
    act(() => useBrowserStore.setState(s => ({ panels: s.panels.map((p: any) => ({ ...p, linkGroup: 'g' })), selectedDatasets: new Set(['pa', 'pb']) }) as any));
    act(() => button().click());
    const boxes = Array.from(menu()!.querySelectorAll<HTMLInputElement>('li[data-testid="cluster-applies-row"] input'));
    act(() => boxes[0].click());
    expect(useBrowserStore.getState().selectedDatasets.size).toBe(0);
    expect(menu()!.querySelector<HTMLInputElement>('[data-testid="cluster-applies-all-input"]')!.checked).toBe(true);
  });

  it('Tab from a radio that ↑/↓ reached (not the checked one) stays in the picker', () => {
    act(() => useBrowserStore.setState({ selectedDatasets: new Set(['pa']) } as any));
    act(() => button().click());
    const m = menu()!;
    key('Home');
    expect(document.activeElement).toBe(m.querySelector('[data-testid="cluster-applies-all-input"]'));
    key('Tab', { shiftKey: true });
    expect(m.contains(document.activeElement)).toBe(true);
    const rows = Array.from(m.querySelectorAll<HTMLInputElement>('li[data-testid="cluster-applies-row"] input'));
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    key('Home');
    key('Tab');
    expect(document.activeElement).toBe(rows[0]);
  });
});
