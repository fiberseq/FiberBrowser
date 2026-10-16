// Navigation and bookmark types

export interface Bookmark {
  id: string;
  name: string;
  chrom: string;
  start: number;
  end: number;
  created: string;
}

export interface ViewportHistoryEntry {
  chrom: string;
  start: number;
  end: number;
}
