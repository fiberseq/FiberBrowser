import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisTabBar } from './AnalysisTabBar';
import { AnalysisSubTabBar, HiddenTabTargets } from './AnalysisSubTabBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TABS = ['alpha', 'beta', 'gamma', 'delta'].map(key => ({ key, label: key }));

describe('tab bars never clip', () => {
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
    vi.restoreAllMocks();
  });

  it('tabs that do not fit go to a More menu; the active one stays in the bar', async () => {
    // A 200 px bar and 80 px tabs: one tab and More fit.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 80 } as DOMRect);
    const onTabChange = vi.fn();
    await act(async () => {
      root.render(<AnalysisTabBar tabs={TABS} activeTab="gamma" onTabChange={onTabChange} theme="cyan" />);
    });
    const shown = Array.from(container.querySelectorAll('button[data-analysis-tab]:not([tabindex="-1"])')).map(el => el.getAttribute('data-analysis-tab'));
    expect(shown).toEqual(['gamma']);
    const more = container.querySelector('[data-testid="analysis-tab-more"]') as HTMLButtonElement;
    expect(more.title).toBe('More tabs: alpha, beta, delta');
    // The others can still be switched to by their selector (tours, deep links)…
    (container.querySelector('[data-analysis-tab="delta"]') as HTMLButtonElement).click();
    expect(onTabChange).toHaveBeenLastCalledWith('delta');
    // …and from the menu.
    await act(async () => { more.click(); });
    const items = Array.from(container.querySelectorAll('[data-testid="analysis-tab-more-menu"] [role="menuitem"]'));
    expect(items.map(el => el.textContent)).toEqual(['alpha', 'beta', 'delta']);
    await act(async () => { (items[1] as HTMLButtonElement).click(); });
    expect(onTabChange).toHaveBeenLastCalledWith('beta');
    expect(container.querySelector('[data-testid="analysis-tab-more-menu"]')).toBeNull();
  });

  it('with room for every tab there is no More button', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 80 } as DOMRect);
    await act(async () => {
      root.render(<AnalysisTabBar tabs={TABS} activeTab="alpha" onTabChange={() => {}} theme="cyan" />);
    });
    expect(container.querySelectorAll('button[data-analysis-tab]:not([tabindex="-1"])')).toHaveLength(4);
    expect(container.querySelector('[data-testid="analysis-tab-more"]')).toBeNull();
  });

  it('sub-tabs are underlined tabs (like the bar above) that wrap, selectable by data-analysis-tab, also while hidden', async () => {
    const onTabChange = vi.fn();
    await act(async () => {
      root.render(<>
        <AnalysisSubTabBar tabs={TABS.slice(0, 2)} activeTab="alpha" onTabChange={onTabChange} label="Chart" />
        <HiddenTabTargets tabs={TABS.slice(2)} onTabChange={onTabChange} />
      </>);
    });
    const bar = container.querySelector('[data-testid="analysis-subtabs"]')!;
    expect(bar.className).toContain('flex-wrap');
    const active = bar.querySelector('[aria-pressed="true"]')!;
    expect(active.getAttribute('data-analysis-tab')).toBe('alpha');
    // One tab style per panel (M5): an underline in the panel colour, no filled pill.
    expect(active.className).toContain('border-b-2');
    expect(active.className).not.toMatch(/rounded-full|bg-gray-900/);
    (container.querySelector('[data-analysis-tab="delta"]') as HTMLButtonElement).click();
    expect(onTabChange).toHaveBeenCalledWith('delta');
  });
});
