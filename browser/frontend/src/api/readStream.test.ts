import { describe, expect, it, vi } from 'vitest';
import { decodeReadStream } from './readStream';
import { readBinaryBytes, readRegionProjectionSafe } from './readBinary';

function frame(extra: object, names: string[] = []) {
  const header = new TextEncoder().encode(JSON.stringify({ ...extra,
    reads: { n: names.length, kind: 'object', fields: {
      id: { n: names.length, kind: 'dictionary', dictionary: names, values: [0, names.length, '|u1'] },
    } },
  }));
  const base = 8 + Math.ceil(header.length / 8) * 8;
  const bytes = new Uint8Array(4 + base + names.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length - 4, true);
  bytes.set([70, 66, 82, 49], 4);
  new DataView(bytes.buffer).setUint32(8, header.length, true);
  bytes.set(header, 12);
  bytes.set(names.map((_, i) => i), 4 + base);
  return bytes;
}

describe('progressive read frames', () => {
  it('paints before completion, tolerates split frame boundaries, and returns final row order', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const progress = vi.fn();
    const pending = decodeReadStream(new Response(new ReadableStream({ start(c) { stream = c; } })), progress);
    const first = frame({ width: 100 }, ['b', 'a']);
    for (let i = 0; i < first.length; i += 3) stream.enqueue(first.slice(i, i + 3));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    expect(progress.mock.calls[0][0].reads.map((r: any) => r.id)).toEqual(['b', 'a']);
    let complete = false;
    void pending.then(() => { complete = true; });
    expect(complete).toBe(false);
    stream.enqueue(frame({ width: 100, _stream_complete: true, _stream_order: [1, 0], _region_reuse_safe: true }));
    stream.close();
    const result = await pending;
    expect(result.reads.map(r => r.id)).toEqual(['a', 'b']);
    expect(readRegionProjectionSafe.has(result)).toBe(true);
    expect(readBinaryBytes.get(result)).toBeGreaterThan(first.length);
    expect(result).not.toHaveProperty('_stream_complete');
  });

  it('rejects truncated, failed, or invalidly ordered cohorts', async () => {
    for (const bytes of [frame({}, ['a']), frame({ _stream_error: 'failed' }), frame({ _stream_complete: true, _stream_order: [2] }), frame({ _stream_complete: true, count: 4 }, ['a'])]) {
      await expect(decodeReadStream(new Response(bytes))).rejects.toThrow();
    }
  });
});
