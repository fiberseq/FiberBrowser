/** A live-lift source panel's link (features/liveLift/linking/liftLink.ts), saved with the panel in sessions. */
export interface LiftLinkConfig {
  /** The link's identity: a correction scheduled for another link is dropped. */
  id: string;
  /** The lifted dataset whose map links the views. */
  datasetId: string;
  /** The lifted panel it was opened from (the ribbon's other side, the hover scope). */
  liftPanelId: string;
  /** Haplotype key, and its label (MAT/PAT). */
  hap: string;
  hapLabel: string;
  /** The source contig it opened on (informational: the panel's own view says which contig it shows now). */
  contig: string;
  /** Drawn reversed relative to the main view (set on entry for a '-' correspondence; the user can change it). */
  flip: boolean;
  /** A correspondence the user picked among disjoint/mixed ones (summary chain index); null: the dominant one. */
  chain?: number | null;
}

declare module '../../../types' {
  interface PanelConfig {
    liftLink?: LiftLinkConfig;
  }
}
