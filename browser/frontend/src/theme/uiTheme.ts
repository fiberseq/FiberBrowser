import type { CSSProperties } from 'react';

/**
 * FiberBrowser's look, from the design system (FiberBrowser Design System,
 * "Direction (Sep 30)"): coloured panel and dataset headers, and panels as
 * separate blocks.
 *
 * THE SWITCH: change `headerTone` and/or `panelShape` below. That one line is
 * all it takes; headers, dataset blocks, analysis panels, the clean-view pill
 * and the gaps between panels all read these values.
 *   headerTone: 'solid' -> a bar in the panel/dataset colour with white text (canvas rows A and C)
 *               'tint'  -> a light tint of the colour, a 3 px colour rule and dark text (rows B and D)
 *   panelShape: 'rounded' -> 12 px corners, 8 px gaps, faint shadow (rows C and D)
 *               'square'  -> the original edge-to-edge panels (rows A and B)
 * The default is row C: solid headers, rounded panels.
 */
export type HeaderTone = 'solid' | 'tint';
export type PanelShape = 'rounded' | 'square';

export const UI_THEME: { headerTone: HeaderTone; panelShape: PanelShape } = {
  headerTone: 'solid',
  panelShape: 'rounded',
};

/** radius-panel and space-panel-gap in the design tokens. */
export const PANEL_RADIUS = 12;
export const PANEL_GAP = 8;

function renderMode(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__FIBERBROWSER_RENDER_MODE);
}

/** Rounded panels with gaps; figure renders (render mode) stay edge to edge. */
export function roundedPanels(): boolean {
  return UI_THEME.panelShape === 'rounded' && !renderMode();
}

/** The gap between (and around) panels in px: 0 for square panels and figure renders. */
export function panelGap(): number {
  return roundedPanels() ? PANEL_GAP : 0;
}

/** `#rrggbb` + alpha (0-1) as `#rrggbbaa`; other colour strings pass through. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `#${hex[1]}${a}`;
}

/**
 * The header bar of a panel or dataset in `color` (the panel's or dataset's
 * own colour). Solid: the colour with white text. Tint: a 12% tint, a 3 px
 * colour rule on top and the page's ink.
 */
export function headerBarStyle(color: string, tone: HeaderTone = UI_THEME.headerTone): CSSProperties {
  if (tone === 'tint') {
    return {
      backgroundColor: withAlpha(color, 0.12),
      boxShadow: `inset 0 3px 0 ${color}`,
      color: 'rgb(var(--fb-ink))',
    };
  }
  return { backgroundColor: color, color: '#ffffff' };
}

/** The frame around a panel block: a hairline in its colour, rounded when the theme says so. */
export function panelFrameStyle(color: string): CSSProperties {
  if (!roundedPanels()) return {};
  return {
    borderRadius: PANEL_RADIUS,
    overflow: 'hidden',
    // A ring, not a border: it takes no layout space, so the tracks keep their widths.
    boxShadow: `0 0 0 1px ${withAlpha(color, 0.35)}, var(--fb-shadow-panel-card)`,
  };
}
