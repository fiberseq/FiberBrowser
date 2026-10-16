/**
 * Fetch each capture region's sequence. A region whose sequence can't be
 * fetched (contig missing from the FASTA) or comes back short (past the contig
 * end) is reported, never filled in.
 */
export async function fetchCaptureSequences(
  regions: Array<{ name: string; chrom: string; start: number; end: number }>,
  fetchSequence: (chrom: string, start: number, end: number) => Promise<string>,
  onProgress?: (index: number, total: number) => void,
): Promise<{ entries: Array<{ name: string; seq: string }>; failures: string[] }> {
  const entries: Array<{ name: string; seq: string }> = [];
  const failures: string[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    onProgress?.(i, regions.length);
    const want = r.end - r.start;
    try {
      const seq = await fetchSequence(r.chrom, r.start, r.end);
      if (seq.length < want) failures.push(`${r.name} (${r.chrom}:${r.start}-${r.end}) has ${seq.length} of ${want} bases`);
      else entries.push({ name: r.name, seq });
    } catch {
      failures.push(`${r.name} (${r.chrom}:${r.start}-${r.end}) is not in the reference`);
    }
  }
  return { entries, failures };
}
