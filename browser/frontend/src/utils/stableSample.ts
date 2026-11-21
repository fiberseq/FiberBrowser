/**
 * Seeded, stable sampling (the browser's side of browser/services/stable_sample.py): an item's key is blake2b-64 of
 * (seed, identity parts), a sample of k is the k smallest keys (ties by identity). Never Math.random, never Set or
 * object order: the same seed gives the same items everywhere. Golden values pin this to the server's keys.
 */

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean) {
  const m: bigint[] = new Array(16);
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(block[i * 8 + b]);
    m[i] = w;
  }
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= (t >> 64n) & MASK;
  if (last) v[14] ^= MASK;
  const G = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b (unkeyed) with an `outLen`-byte digest. */
export function blake2b(data: Uint8Array, outLen = 8): Uint8Array {
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  let t = 0n;
  let off = 0;
  while (data.length - off > 128) {
    t += 128n;
    compress(h, data.subarray(off, off + 128), t, false);
    off += 128;
  }
  const last = new Uint8Array(128);
  last.set(data.subarray(off));
  t += BigInt(data.length - off);
  compress(h, last, t, true);
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

const enc = new TextEncoder();
const PREFIX = enc.encode('fiberbrowser.sample.v1');

/** An item's sampling key: blake2b-64 of the seed and its identity parts (as services/stable_sample.stable_key). */
export function stableKey(seed: number, ...parts: string[]): bigint {
  const chunks = [PREFIX, enc.encode(`\x1f${Math.trunc(seed)}`), ...parts.map(p => enc.encode(`\x1f${p}`))];
  const buf = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  const d = blake2b(buf, 8);
  let k = 0n;
  for (const b of d) k = (k << 8n) | BigInt(b);
  return k;
}

/** The k items with the smallest keys (ties by identity), in key order. */
export function lowestK<T>(items: readonly T[], k: number, key: (t: T) => bigint, ident: (t: T) => string): T[] {
  const ranked = items.map(t => ({ t, k: key(t), id: ident(t) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return (k < 0 ? ranked : ranked.slice(0, Math.max(0, k))).map(x => x.t);
}

// Poisson(1) cumulative probabilities (k = 0..17), the same literals as services/stable_sample.py.
const POISSON1_CDF = [0.36787944117144233, 0.7357588823428847, 0.9196986029286058, 0.9810118431238463, 0.9963401531726563,
  0.9994058151824183, 0.999916758850712, 0.9999897508033253, 0.999998874797402, 0.9999998885745216, 0.9999999899522336,
  0.9999999991683892, 0.9999999999364022, 0.9999999999954802, 0.9999999999997, 0.9999999999999813, 0.9999999999999989, 0.9999999999999999];

/** A bootstrap unit's 32-bit stream seed: the low 32 bits of its stable key. */
export function unitSeed(seed: number, unit: string): number {
  return Number(stableKey(seed, 'bootstrap', unit) & 0xffffffffn);
}

function mulberry32(state: number): number {
  let t = state >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A unit's multiplicity in each bootstrap resample: Poisson(1) draws from its own stream (as the server's). */
export function poissonWeights(seed: number, unit: string, resamples: number): Uint8Array {
  const s0 = unitSeed(seed, unit);
  const out = new Uint8Array(resamples);
  for (let b = 0; b < resamples; b++) {
    const u = mulberry32((s0 + Math.imul(b + 1, 0x6d2b79f5)) >>> 0);
    let k = 0;
    while (k < POISSON1_CDF.length && u >= POISSON1_CDF[k]) k++;
    out[b] = k;
  }
  return out;
}

/** The percentile interval of bootstrap values (linear interpolation, numpy's default). */
export function percentileInterval(values: number[], level = 0.95): [number, number] | null {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p: number) => { const h = (v.length - 1) * p, lo = Math.floor(h); return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (h - lo); };
  const a = (1 - level) / 2;
  return [q(a), q(1 - a)];
}
