import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_TONE_CLASS, ActionButton } from './ActionButton';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ActionButton (function-coloured Scan / Cluster / Sort / Filter)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const button = () => container.querySelector('button')!;

  it('is tinted in its tone at rest and runs on click', () => {
    const onClick = vi.fn();
    act(() => root.render(<ActionButton tone="cluster" title="Cluster reads" onClick={onClick}>Cluster</ActionButton>));
    expect(button().className).toContain('fb-action fb-action-cluster');
    expect(button().className).not.toContain('fb-action-active');
    expect(button().getAttribute('aria-disabled')).toBeNull();
    expect(button().title).toBe('Cluster reads');
    act(() => button().click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('blocked: aria-disabled, says why on hover, does nothing', () => {
    const onClick = vi.fn();
    act(() => root.render(<ActionButton tone="filter" disabledReason="Choose a filter rule first" title="Filter" onClick={onClick}>Filter</ActionButton>));
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(button().disabled).toBe(false); // so the reason tooltip still shows
    expect(button().title).toBe('Choose a filter rule first');
    act(() => button().click());
    expect(onClick).not.toHaveBeenCalled();
  });

  // Audit L19: the busy state was white text on a pale fill (the solid fill fades in, the
  // white text doesn't). Busy now keeps the at-rest tone ink, with a spinner for the icon.
  it('busy: keeps its tone ink with a spinner (not the solid/white active look), not clickable', () => {
    const onClick = vi.fn();
    act(() => root.render(<ActionButton tone="peaks" busy icon={<svg data-testid="icon" />} disabledReason="ignored while busy" onClick={onClick}>Scanning…</ActionButton>));
    expect(button().className).toContain('fb-action-busy');
    expect(button().className).not.toContain('fb-action-active');
    expect(button().querySelector('.fb-action-spinner')).not.toBeNull();
    expect(button().querySelector('[data-testid="icon"]')).toBeNull();
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-disabled')).toBeNull();
    act(() => button().click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

// Owner (1 Oct): Scan and Sort were the same colour. The tone class was built as
// `fb-action-${tone}`, which Tailwind never saw, so the build dropped .fb-action-order and
// Sort and Filter took Scan's blue. Each action has its own token and a class spelled out.
describe('each read operation has its own colour', () => {
  const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
  const source = readFileSync(resolve(__dirname, 'ActionButton.tsx'), 'utf8');
  const tones = Object.keys(ACTION_TONE_CLASS) as Array<keyof typeof ACTION_TONE_CLASS>;

  it('Scan, Cluster, Sort, Filter and Highlight: five tones, five different colours', () => {
    expect(tones.sort()).toEqual(['cluster', 'filter', 'highlight', 'peaks', 'sort']);
    const colours = tones.map(tone => css.match(new RegExp(`--fb-action-${tone}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase());
    expect(colours.every(Boolean)).toBe(true);
    expect(new Set(colours).size).toBe(tones.length);
  });

  it('each tone class is defined and spelled out in full in the source (so the build keeps it)', () => {
    for (const tone of tones) {
      const cls = ACTION_TONE_CLASS[tone];
      expect(css).toContain(`.${cls} { --tone: var(--fb-action-${tone});`);
      expect(source).toContain(`'${cls}'`);
    }
  });

  it('Sort is drawn in the sort tone', () => {
    const host = document.createElement('div');
    const r = createRoot(host);
    act(() => r.render(<ActionButton tone="sort" onClick={() => {}}>Sort</ActionButton>));
    expect(host.querySelector('button')!.className).toContain('fb-action-sort');
    act(() => r.unmount());
  });
});
