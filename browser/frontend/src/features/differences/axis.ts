/** One molecular bp has the same scale as one target bp. Insertions consume
 * axis length, never target coordinates; identical positions therefore line
 * up at the same fraction in differently sized sibling panels. */
export interface DifferenceExpansion {
  chrom: string; pos: number; ins_id: string; length: number; label: string; hap_label: string;
  /** The full description for the tooltip and inspector ("Assembly MAT · ref 0 → alt 2,353 bp"); `label` stays short ("MAT +2.4 kb"). */
  detail?: string;
  src?: { contig: string | null; start: number | null; end: number | null };
  datasetId?: string;
  source?: 'assembly' | 'reads';
  associate_native?: boolean;
  referenceScope?: string;
  targetRevision?: number;
  ref_start?: number;
  anchor_convention?: 'ref_end';
  estimated?: boolean;
  kind?: 'insertion' | 'replacement'; t_end?: number; ref_bp?: number;
  selected_length?: number;
  alleles?: Array<{ ins_id: string; hap_label: string; length: number; src?: DifferenceExpansion['src']; strand?: '+' | '-' | null;
    kind?: 'insertion' | 'replacement'; t_end?: number; ref_bp?: number }>;
  strand?: '+' | '-' | null;
}
export interface AxisPosition { pos: number; ins_id?: string; within?: number }
export interface DifferenceAxis {
  toX: (pos: number, within?: { ins_id: string; offset: number }) => number;
  fromX: (x: number) => AxisPosition;
  blocks: Array<{ x0: number; x1: number; ins: DifferenceExpansion }>;
  pxPerBp: number;
  /** Split a target span, excluding the inserted columns at its boundaries. */
  spans: (a: number, b: number) => Array<{ x: number; w: number }>;
}
export type LiveLiftExpansion = DifferenceExpansion;
export type LiftAxis = DifferenceAxis;

export function makeAxis(start: number, end: number, width: number, reversed = false,
  expansions: readonly DifferenceExpansion[] = []): DifferenceAxis {
  const inserts = expansions.filter(e => e.pos >= start && e.pos < end && e.length > 0)
    .slice().sort((a, b) => a.pos - b.pos || a.ins_id.localeCompare(b.ins_id));
  const pxPerBp = width / Math.max(1, end - start + inserts.reduce((n, e) => n + e.length, 0));
  const pixel = (p: number) => reversed ? width - p * pxPerBp : p * pxPerBp;
  let added = 0;
  const runs = inserts.map(ins => {
    const a = ins.pos - start + added;
    added += ins.length;
    return { a, b: a + ins.length, ins };
  });
  const toX: DifferenceAxis['toX'] = (pos, within) => {
    if (within) {
      const block = runs.find(b => b.ins.ins_id === within.ins_id);
      if (block) return pixel(block.a + Math.max(0, Math.min(block.ins.length, within.offset)));
    }
    return pixel(pos - start + inserts.reduce((n, e) => n + (e.pos <= pos ? e.length : 0), 0));
  };
  const fromX = (x: number): AxisPosition => {
    const p = (reversed ? width - x : x) / pxPerBp;
    let extra = 0;
    for (const r of runs) {
      if (p >= r.a && p < r.b) return { pos: r.ins.pos, ins_id: r.ins.ins_id, within: p - r.a };
      if (p >= r.b) extra += r.ins.length;
    }
    return { pos: start + p - extra };
  };
  const spans: DifferenceAxis['spans'] = (a, b) => {
    const cuts = [a, ...new Set(inserts.filter(i => i.pos > a && i.pos < b).map(i => i.pos)), b];
    return cuts.slice(1).flatMap((z, i) => {
      const lo = cuts[i];
      if (z <= lo) return [];
      // At the right edge use the *near* side of any block at that position.
      const left = toX(lo);
      const right = pixel(z - start + inserts.reduce((n, e) => n + (e.pos < z ? e.length : 0), 0));
      return [{ x: Math.min(left, right), w: Math.abs(right - left) }];
    });
  };
  return { toX, fromX, pxPerBp, spans,
    blocks: runs.map(r => ({ x0: Math.min(pixel(r.a), pixel(r.b)), x1: Math.max(pixel(r.a), pixel(r.b)), ins: r.ins })) };
}
