/**
 * What plugin packs add to a dataset panel's header (PanelHeader.tsx): chips between its name and its actions, items
 * in its "…" menu, and a wider name. Each extension is a hook, called in registration order on every render of a
 * header (packs register before the app renders, so the list is fixed).
 */
import type { ReactNode } from 'react';
import type { Dataset, PanelConfig } from '../../types';

export interface PanelHeaderContext {
  panel: PanelConfig;
  dataset: Dataset | undefined;
  /** The header shows its layout controls (not a figure export, not too narrow). */
  showLayoutChrome: boolean;
}

export interface PanelHeaderAddition {
  /** The chips' texts (the header measures them to keep their room). */
  chipTexts?: string[];
  /** The chips themselves (after the strand chip). */
  chips?: ReactNode;
  /** Chips of a split panel (right after its "Split ×" and "All reads here" pills). */
  splitChips?: ReactNode;
  /**
   * Action pills of a split panel (after its split chips), shown in the bar only while they fit beside the name and
   * the essential actions, at full width (never shrunk to an empty pill: round 2, N3). The extension also offers each
   * one in its `menu`, so a pill that doesn't fit is still in "…".
   */
  headerPills?: HeaderPill[];
  /** Items for the "…" menu (after a separator), when it is offered. */
  menu?: ReactNode;
  /** Keep room for "…" for them (the menu exists only to offer them). */
  wantsMenu?: boolean;
  /** Said in the "…" button's title ("the insert expanded"). */
  menuTitle?: string;
  /** The name may use this many characters. */
  labelChars?: number;
  /** Shown under the header bar, at the top of the panel body (a job's status while the panel's data is built). */
  body?: ReactNode;
}

export interface HeaderPill {
  key: string;
  text: string;
  title: string;
  icon?: ReactNode;
  testId?: string;
  onSelect: () => void;
}

export type PanelHeaderExtension = (ctx: PanelHeaderContext) => PanelHeaderAddition | null;

const extensions: PanelHeaderExtension[] = [];

export function registerPanelHeaderExtension(useExtension: PanelHeaderExtension): void {
  extensions.push(useExtension);
}

/** Every registered extension's addition for this header (a hook: same calls in the same order each render). */
export function usePanelHeaderAdditions(ctx: PanelHeaderContext): PanelHeaderAddition[] {
  return extensions.map(useExtension => useExtension(ctx)).filter((a): a is PanelHeaderAddition => Boolean(a));
}
