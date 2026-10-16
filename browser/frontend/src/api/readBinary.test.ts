import { describe, expect, it } from 'vitest';
import { clearReadBinaryExpansions, decodeReadBinary, readAlignmentBounds, readRegionProjectionSafe } from './readBinary';

function payload(header: unknown, data: number[] = []) {
  const text = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(8 + Math.ceil(text.length / 8) * 8 + data.length);
  new Uint8Array(buffer).set([70, 66, 82, 49]);
  new DataView(buffer).setUint32(4, text.length, true);
  new Uint8Array(buffer).set(text, 8);
  new Uint8Array(buffer).set(data, 8 + Math.ceil(text.length / 8) * 8);
  return buffer;
}

describe('compact binary reads', () => {
  it('preserves optional fields and ordinary array consumers without expanding unused marks', () => {
    const data = decodeReadBinary(payload({ count: 2, reads: { n: 2, kind: 'object', fields: {
      id: { n: 2, kind: 'dictionary', dictionary: ['a', 'b'], values: [0, 2, '|u1'] },
      methyl: { n: 2, kind: 'list', stride: 2, items: { n: 4, kind: 'number', values: [8, 4, '|u1'] } },
      duplicate: { n: 2, kind: 'dictionary', valid: [16, 2, '|u1'], dictionary: [true], values: [24, 2, '|u1'] },
    } } }, [0, 1, 0, 0, 0, 0, 0, 0, 4, 8, 12, 16, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(Object.getOwnPropertyDescriptor(data.reads[0], 'methyl')?.get).toBeTypeOf('function');
    expect(data.reads).toEqual([{ id: 'a', methyl: [4, 8], duplicate: true }, { id: 'b', methyl: [12, 16] }]);
    expect(Array.isArray(data.reads[0].methyl)).toBe(true);
    expect(JSON.parse(JSON.stringify(data)).reads).toEqual(data.reads);
  });
  it('rejects truncated or unknown versions', () => {
    expect(() => decodeReadBinary(new ArrayBuffer(4))).toThrow('Invalid read payload');
    const buffer = payload({ reads: { n: 1, kind: 'number', values: [0, 20, '<f8'] } });
    expect(() => decodeReadBinary(buffer)).toThrow('Invalid read column');
  });
  it('shares expanded columns with derived read copies across redraws', () => {
    const data = decodeReadBinary(payload({ reads: { n: 1, kind: 'object', fields: {
      methyl: { n: 1, kind: 'list', stride: 2, items: { n: 2, kind: 'number', values: [0, 2, '|u1'] } },
    } } }, [4, 8]));
    const original = data.reads[0];
    const derived = Object.defineProperties({}, Object.getOwnPropertyDescriptors(original)) as typeof original;
    const marks = derived.methyl;
    expect(derived.methyl).toBe(marks);
    expect(original.methyl).toBe(marks);
    clearReadBinaryExpansions();
    expect(derived.methyl).toEqual(marks);
    expect(derived.methyl).not.toBe(marks);
  });
});

it('keeps alignment extents and projection eligibility out of the read schema', () => {
  const decoded = decodeReadBinary(payload({
    _region_reuse_safe: true,
    geometry: { n: 1, kind: 'list', stride: 2, items: { n: 2, kind: 'number', values: [0, 2, '|u1'] } },
    reads: { n: 1, kind: 'object', fields: { id: { n: 1, kind: 'dictionary', dictionary: ['one'], values: [8, 1, '|u1'] } } },
  }, [10, 90, 0, 0, 0, 0, 0, 0, 0]));
  expect(decoded).toEqual({ reads: [{ id: 'one' }] });
  expect(readAlignmentBounds.get(decoded.reads[0])).toEqual([10, 90]);
  expect(readRegionProjectionSafe.has(decoded)).toBe(true);
});
