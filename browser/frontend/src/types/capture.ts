export interface CaptureRegion {
  id: string;
  name: string;
  chrom: string;
  start: number;   // 0-based genomic (without padding)
  end: number;
  padding: number;  // Per-region padding in bp (stamped at add-time)
  addedAt: number;
  source: 'bounding' | 'viewport' | 'custom';
}
