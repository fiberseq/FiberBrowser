import { decodeReadBinary, readBinaryBytes, readRegionProjectionSafe } from './readBinary';
import type { ReadsResponse } from '../components/tracks/read-track/types';

export const READ_STREAM_TYPE = 'application/vnd.fiberbrowser.reads.stream.v1';
export type ReadProgress = (data: ReadsResponse) => void;

/** Decode bounded frames as they arrive; only a completion frame returns a cohort. */
export async function decodeReadStream(response: Response, progress?: ReadProgress): Promise<ReadsResponse> {
  if (!response.body) throw new Error('Missing read stream');
  const reader = response.body.getReader();
  const reads: ReadsResponse['reads'] = [];
  let bytes = 0, lastProgress = -Infinity;
  let frame = new Uint8Array(4), filled = 0, header = true;
  let result: ReadsResponse | undefined;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let offset = 0;
      while (offset < chunk.value.length) {
        const count = Math.min(frame.length - filled, chunk.value.length - offset);
        frame.set(chunk.value.subarray(offset, offset + count), filled);
        offset += count; filled += count;
        if (filled !== frame.length) continue;
        if (header) {
          const size = new DataView(frame.buffer).getUint32(0, true);
          if (size < 8 || size > 1024 * 1024 * 1024) throw new Error('Invalid read frame size');
          frame = new Uint8Array(size); filled = 0; header = false;
          continue;
        }
        if (result) throw new Error('Read data after completion');
        const data = decodeReadBinary(frame.buffer);
        bytes += frame.length;
        if (data._stream_error) throw new Error(data._stream_error);
        for (const read of data.reads) reads.push(read);
        if (data._stream_complete) {
          const order: number[] | undefined = data._stream_order;
          if (order && (new Set(order).size !== order.length
            || order.some(i => !Number.isInteger(i) || i < 0 || i >= reads.length))) throw new Error('Invalid read order');
          result = { ...data, reads: order ? order.map(i => reads[i]) : reads };
          const expected = data.display_count ?? data.count;
          if (typeof expected === 'number' && result!.reads.length !== expected) throw new Error('Incomplete read cohort');
          delete (result as any)._stream_order;
          delete (result as any)._stream_complete;
          if (readRegionProjectionSafe.has(data)) readRegionProjectionSafe.add(result!);
          readBinaryBytes.set(result!, bytes);
        } else if (progress && performance.now() - lastProgress >= 500) {
          lastProgress = performance.now();
          progress({ ...data, reads: reads.slice() });
          // Let React commit the first rows before reading more queued frames.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        frame = new Uint8Array(4); filled = 0; header = true;
      }
    }
    if (!result || !header || filled) throw new Error('Incomplete read stream');
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
