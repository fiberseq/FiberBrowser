// Navigation and bookmark types

export interface Bookmark {
  id: string;
  name: string;
  chrom: string;
  start: number;
  end: number;
  created: string;
}

/**
 * One jump in navigation history (Back / Forward, Alt+← / Alt+→): where its view was before the jump (chrom, start,
 * end), and once Back has undone it, where the jump went (`to`, for Forward). `panelId`: the jump moved that panel's
 * own view ("Each panel navigates", or a panel on another reference), not the main view.
 */
export interface ViewportHistoryEntry {
  chrom: string;
  start: number;
  end: number;
  panelId?: string;
  /** The jump moved its panel the way a pan does (setPanelViewport: locked panels and the main view moved likewise),
   *  so Back / Forward move it the same way and those come back too. */
  likePan?: boolean;
  to?: { chrom: string; start: number; end: number };
}
