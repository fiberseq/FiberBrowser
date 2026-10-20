import { expect, it } from 'vitest';
import { mapSpan, prefetchView, resetNavigation, setNavigationFetcher } from './navigation';

// Two 1 Mb tiles of one chain: [990000, 999900) in tile 0, [1000500, 1005000) in tile 1 (a 600 bp target-only gap
// across the tile boundary). A view inside the gap maps by the nearer exact flank, which is in the next tile.
function tile(n: number) {
  const out = [0x47, 0x4c, 0x54, 0x31, 0];
  const uv = (v: number) => { while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
  const zz = (v: number) => v < 0 ? -v * 2 - 1 : v * 2;
  uv(n); uv(n < 2 ? 1 : 0);
  if (n < 2) {
    const a = n === 0 ? 990000 : 1000500, b = n === 0 ? 999900 : 1005000, q = n === 0 ? 0 : 9900;
    uv(zz(a - n * 1000000)); uv(b - a); uv(zz(q)); uv(0);
  }
  return new Uint8Array(out);
}

it('a gap across a tile boundary maps by the nearer exact flank in the neighbouring tile', async () => {
  resetNavigation();
  setNavigationFetcher({
    json: async u => u.includes('summary')
      ? { key: 'k', tile_bp: 1000000, outline_max_drift: 1000, haplotypes: ['H'], labels: { H: 'MAT' }, sources: { S: 'H' }, targets: { T: 3000000 },
        selected: [true], chains: [['T', 990000, 1005000, 'S', 0, 14400, '+', 'H', 15000, 14400]] }
      : { rows: [[990000, 1005000, 0, 14400, '+', 0, 600]] },
    bytes: async u => tile(Number(new URL(u, 'http://x').searchParams.get('tile'))),
  } as never);
  await prefetchView('d', 'k', 0, 'T', 1000000, 1000100);
  const view = { chrom: 'T', start: 1000000, end: 1000100 };
  // Only the view's tile is loaded: the nearer flank may be in the previous one, so the mapping is not yet exact
  // (and that tile is asked for).
  expect(mapSpan('d', 'k', 'toSource', view, { hap: 'H' })).toMatchObject({ status: 'mapped', mapping: { exact: false } });
  await prefetchView('d', 'k', 0, 'T', 999000, 999100);
  expect(mapSpan('d', 'k', 'toSource', view, { hap: 'H' })).toMatchObject({ status: 'mapped', mapping: { start: 10000, end: 10100, exact: true } });
});
