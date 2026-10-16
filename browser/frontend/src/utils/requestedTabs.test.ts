import { describe, expect, it, vi } from 'vitest';
import { consumeRequestedTab, normalizeRequestedTab } from './requestedTabs';

describe('requested tab helpers', () => {
  const tabs = ['rules', 'quality', 'presets'] as const;

  it('normalizes allowed tabs and falls back for invalid values', () => {
    expect(normalizeRequestedTab('quality', tabs, 'rules')).toBe('quality');
    expect(normalizeRequestedTab('unknown', tabs, 'rules')).toBe('rules');
    expect(normalizeRequestedTab(null, tabs, 'rules')).toBe('rules');
  });

  it('supports aliases for legacy tabs', () => {
    expect(normalizeRequestedTab('filters', tabs, 'rules', { filters: 'quality' })).toBe('quality');
  });

  it('consumes valid and invalid session values exactly once', () => {
    const storage = {
      getItem: vi.fn(() => 'invalid'),
      removeItem: vi.fn(),
    };

    expect(consumeRequestedTab('fiberbrowser_colormap_tab', tabs, 'rules', { storage })).toBe('rules');
    expect(storage.getItem).toHaveBeenCalledWith('fiberbrowser_colormap_tab');
    expect(storage.removeItem).toHaveBeenCalledWith('fiberbrowser_colormap_tab');
  });
});
