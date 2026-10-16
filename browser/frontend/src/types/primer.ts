// Primer design types

export interface PrimerPair {
  fwd_seq: string;
  fwd_start: number;
  fwd_end: number;
  fwd_tm: number;
  fwd_len: number;
  rev_seq: string;
  rev_start: number;
  rev_end: number;
  rev_tm: number;
  rev_len: number;
  product_size: number;
  tm_diff: number;
  g_count: number;
  fwd_distance?: number;  // Distance from fwd primer end to target start
  rev_distance?: number;  // Distance from target end to rev primer start
  fwd_blast_hits?: number;  // Significant BLAST hits for fwd primer (1 = unique)
  rev_blast_hits?: number;  // Significant BLAST hits for rev primer (1 = unique)
  /** Where the Primers panel designed it (results outlive navigation). */
  designChrom?: string;
  designTargetStart?: number;
  designTargetEnd?: number;
}

export interface SavedPrimer {
  name: string;
  pair: PrimerPair;
  chrom: string;
  targetStart: number;
  targetEnd: number;
  addedAt: number; // timestamp
  /** Where this entry came from. 'design' = produced by the current
   *  session's Design flow. 'bed'/'tsv' = imported from a file the user
   *  already ordered/ran; excluded from export by default so re-opening
   *  doesn't re-queue them on IDT. Undefined = legacy ('design'). */
  source?: 'design' | 'bed' | 'tsv';
  /** Original filename for imported primers (just for display). */
  loadedFromFile?: string;
}

export interface DafcPrimerQuad {
  x_pair: PrimerPair;
  y_pair: PrimerPair;
  max_tm_range: number;
}

export interface PrimerState {
  targetStart: number | null;
  targetEnd: number | null;
  /** The target's chromosome (a peak picked in a panel at another locus); absent = the main view's. */
  targetChrom?: string | null;
  pair: PrimerPair | null;
  configFasta: string | null;
  configBlastDb: string | null;
  designing: boolean;
  error: string | null;
  designResults: PrimerPair[];
  savedPrimers: SavedPrimer[];
  mode: 'standard' | 'dafc' | '4c';
  dafcQuads: DafcPrimerQuad[];
  /** Which cart sources to overlay on the PrimerTrack.
   *  'off' = don't draw cart primers at all (default).
   *  'all' | 'imported' | 'design' = show matching source(s). */
  cartTrackDisplay: 'off' | 'all' | 'imported' | 'design';
}
