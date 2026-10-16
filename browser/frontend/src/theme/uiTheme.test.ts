import { afterEach, describe, expect, it } from 'vitest';
import { UI_THEME, headerBarStyle, panelFrameStyle, panelGap, roundedPanels, withAlpha } from './uiTheme';

describe('uiTheme', () => {
  const saved = { ...UI_THEME };
  afterEach(() => {
    Object.assign(UI_THEME, saved);
    delete (window as any).__FIBERBROWSER_RENDER_MODE;
  });

  it('defaults to the design direction: solid headers, rounded panels (canvas row C)', () => {
    expect(UI_THEME).toEqual({ headerTone: 'solid', panelShape: 'rounded' });
    expect(roundedPanels()).toBe(true);
    expect(panelGap()).toBe(8);
  });

  it('adds alpha to hex colours only', () => {
    expect(withAlpha('#3b82f6', 0.35)).toBe('#3b82f659');
    expect(withAlpha('#3B82F6', 1)).toBe('#3B82F6ff');
    expect(withAlpha('rgb(1,2,3)', 0.5)).toBe('rgb(1,2,3)');
  });

  it('draws solid and tinted header bars', () => {
    expect(headerBarStyle('#10b981', 'solid')).toEqual({ backgroundColor: '#10b981', color: '#ffffff' });
    const tint = headerBarStyle('#10b981', 'tint');
    expect(tint.backgroundColor).toBe('#10b9811f');
    expect(tint.boxShadow).toBe('inset 0 3px 0 #10b981');
  });

  it('switching the shape to square removes the gaps and the frame', () => {
    UI_THEME.panelShape = 'square';
    expect(panelGap()).toBe(0);
    expect(panelFrameStyle('#3b82f6')).toEqual({});
  });

  it('figure renders stay edge to edge', () => {
    (window as any).__FIBERBROWSER_RENDER_MODE = true;
    expect(roundedPanels()).toBe(false);
    expect(panelGap()).toBe(0);
  });
});
