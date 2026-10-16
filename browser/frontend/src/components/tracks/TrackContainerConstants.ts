// Shared constants for TrackContainer and its extracted sub-modules

export const AXIS_HEIGHT = 30;
export const META_HEIGHT = 50;
export const FIRE_HEIGHT = 50;
export const MICROC_HEIGHT = 150;
export const COACC_HEIGHT = 120;
export const GENE_HEIGHT = 80;
export const ORTHO_HEIGHT = 40;
export const ANNOTATION_HEIGHT = 60;
export const CAPTURE_HEIGHT = 30;
export const PRIMER_HEIGHT = 40;
export const SEQUENCE_HEIGHT = 24;
export const SLOT_HEADER_HEIGHT = 20;

export const TRACK_COLORS = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#d63384', '#0891b2'];

/**
 * The ground each fixed track paints behind its data. The cluster sidebar's
 * column beside these tracks (TrackGutter) takes the same colour, so the page
 * background never shows through beside them (it did in dark mode once reads
 * were clustered). The tracks stay light in dark mode like the reads, the
 * sequence strip too: one canvas ground per theme, never a dark band between
 * light rows (audit M29).
 */
export const TRACK_BACKGROUND = {
  axis: '#fafafa',
  gene: '#ffffff',
  annotation: '#fafafa',
  signal: '#fafafa',
  capture: '#eef2ff',
  primer: '#fef3c7',
  sequence: '#fafafa',
} as const;

export type TrackBackgroundKind = keyof typeof TRACK_BACKGROUND;

/** The same in both themes (the read canvas stays light in dark mode). */
export function trackBackground(kind: TrackBackgroundKind, _darkMode = false): string {
  return TRACK_BACKGROUND[kind];
}
