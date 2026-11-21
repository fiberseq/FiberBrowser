import { describe, expect, it } from 'vitest';
import { buildNucRegRows, describeNucRegTile, nucRegRefDeltaFromByte, nucRegScoreAt } from './nucLayers';

// score byte for a log2 score: 1 + round((s + 2) / 10 * 254)
const byte = (s: number) => 1 + Math.round(((s + 2) / 10) * 254);

describe('nucreg ref_delta (cut windows read against their own width)', () => {
  const scale = { zero: 3, top: 6, reference: true };
  it('reads each tile against its own width when the layer carries ref_delta', () => {
    const layer = {
      intervals: [[0, 250, 250], [250, 500, 250]] as [number, number, number][],
      qualities: [[byte(2.5), byte(3.5)], [0, 0], [128 - 20, 128]],   // first tile: a cut window, delta -0.5
      quality_names: ['score', 'period', 'ref_delta'], scale,
    };
    const rows = buildNucRegRows(layer)!;
    expect(rows.tiles[0].refDelta).toBeCloseTo(-0.5, 6);
    expect(rows.tiles[1].refDelta).toBe(0);
    // the lane's level: score less its width's shift; the plain score is unchanged
    expect(nucRegScoreAt(rows, 10, true)).toBeCloseTo(rows.tiles[0].score + 0.5, 6);
    expect(nucRegScoreAt(rows, 10)).toBeCloseTo(rows.tiles[0].score, 6);
    expect(describeNucRegTile(rows.tiles[0], scale)).toMatch(/[−+]0\.0\d vs random packing/);   // not −0.51
  });
  it('leaves layers without ref_delta (full windows, scans, annotated BAMs) as they were', () => {
    const rows = buildNucRegRows({ intervals: [[0, 250, 250]], qualities: [[byte(2.5)], [0]], scale })!;
    expect(rows.tiles[0].refDelta).toBeUndefined();
    expect(nucRegScoreAt(rows, 10, true)).toBeCloseTo(rows.tiles[0].score, 6);
    expect(nucRegRefDeltaFromByte(0)).toBe(0);
  });
});
