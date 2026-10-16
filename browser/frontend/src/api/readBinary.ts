/** Compact-read columns stay in typed buffers; existing consumers get lazy arrays. */
export const READ_BINARY_TYPE = 'application/vnd.fiberbrowser.reads.v1';
export const readRegionProjectionSafe = new WeakSet<object>();
export const readAlignmentBounds = new WeakMap<object, [number, number]>();
export const readTerminalGaps = new WeakMap<object, [number, number][]>();
export const readBinaryBytes = new WeakMap<object, number>();
const expandedColumns = new Map<object, { value: unknown; bytes: number }>();
let MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
let expandedBytes = 0;
const denseFields = new Set(['methyl', 'methyl_m6a', 'methyl_m5c', 'deam', 'possible_deam_ct', 'possible_deam_ga']);

export function setReadExpansionBudget(bytes: number): void {
  MAX_EXPANDED_BYTES = Math.max(0, bytes);
  clearReadBinaryExpansions();
}

export function readExpansionDiagnostics() { return { budget: MAX_EXPANDED_BYTES, retained: expandedBytes }; }

/** Drop expanded evidence arrays; the compact columns can reconstruct them. */
export function clearReadBinaryExpansions(): void {
  expandedColumns.clear();
  expandedBytes = 0;
}
/** Share a bounded numerical expansion between lazy read views. */
export function cachedReadExpansion(token: object, expand: () => any, bytesPerItem: number): any {
  const cached = expandedColumns.get(token);
  if (cached) {
    expandedColumns.delete(token);
    expandedColumns.set(token, cached);
    return cached.value;
  }
  const value = expand();
  const bytes = 32 + (value?.length || 0) * bytesPerItem;
  while (expandedColumns.size && expandedBytes + bytes > MAX_EXPANDED_BYTES) {
    const [old, entry] = expandedColumns.entries().next().value!;
    expandedColumns.delete(old);
    expandedBytes -= entry.bytes;
  }
  if (bytes <= MAX_EXPANDED_BYTES) {
    expandedColumns.set(token, { value, bytes });
    expandedBytes += bytes;
  }
  return value;
}

type Vector = [number, number, string];
interface Column {
  n: number;
  kind: 'null' | 'object' | 'list' | 'number' | 'dictionary';
  valid?: Vector;
  values?: Vector;
  offsets?: Vector;
  stride?: number;
  fields?: Record<string, Column>;
  items?: Column;
  dictionary?: unknown[];
}

export function decodeReadBinary(buffer: ArrayBuffer): any {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FBR1') throw new Error('Invalid read payload');
  const length = new DataView(buffer).getUint32(4, true);
  const base = 8 + Math.ceil(length / 8) * 8;
  if (base > bytes.length) throw new Error('Truncated read payload');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  const vector = ([offset, count, type]: Vector) => {
    const constructors = { '|u1': Uint8Array, '<i2': Int16Array, '<u2': Uint16Array, '<i4': Int32Array, '<u4': Uint32Array, '<f8': Float64Array };
    const ctor = constructors[type as keyof typeof constructors];
    if (!ctor || offset < 0 || count < 0 || base + offset + count * ctor.BYTES_PER_ELEMENT > bytes.length) throw new Error('Invalid read column');
    return new ctor(buffer, base + offset, count);
  };
  const compile = (node: Column): ((index: number) => any) => {
    const valid = node.valid && vector(node.valid);
    let get: (index: number) => any;
    if (node.kind === 'object') {
      const fields = Object.entries(node.fields!).map(([key, value]) => [key, compile(value), value.valid && vector(value.valid), value.kind === 'number' || value.kind === 'dictionary'] as const);
      get = index => {
        const record: Record<string, unknown> = {};
        for (const [key, read, presence, scalar] of fields) {
          if (presence && presence[index] === 0) continue;
          if (scalar) { record[key] = read(index); continue; }
          if (denseFields.has(key)) {
            const token = {};
            Object.defineProperty(record, key, { enumerable: true, configurable: true, get() {
              return cachedReadExpansion(token, () => read(index), key === 'deam' ? 80 : 8);
            } });
            continue;
          }
          let resolved = false;
          let value: unknown;
          Object.defineProperty(record, key, { enumerable: true, configurable: true, get() {
            // Derived layers copy these descriptors. Share the expansion with
            // those copies, and memoize on the object actually being read.
            if (!resolved) { value = read(index); resolved = true; }
            Object.defineProperty(this, key, { value, enumerable: true, configurable: true, writable: true });
            return value;
          } });
        }
        return record;
      };
    } else if (node.kind === 'list') {
      const offsets = node.offsets && vector(node.offsets);
      const read = compile(node.items!);
      get = index => {
        const start = offsets ? offsets[index] : index * node.stride!;
        const length = offsets ? offsets[index + 1] - start : node.stride!;
        const result = new Array(length);
        for (let j = 0; j < length; j++) result[j] = read(start + j);
        return result;
      };
    } else if (node.kind === 'number' || node.kind === 'dictionary') {
      const values = vector(node.values!);
      get = node.kind === 'number' ? index => values[index] : index => node.dictionary![values[index]];
    } else get = () => null;
    return valid ? index => valid[index] === 0 ? undefined : valid[index] === 1 ? null : get(index) : get;
  };
  const dataset = (data: any) => {
    const read = compile(data.reads);
    const result = { ...data, reads: Array.from({ length: data.reads.n }, (_, i) => read(i)) };
    const geometry = data.geometry && compile(data.geometry);
    const terminals = data.terminals && compile(data.terminals);
    result.reads.forEach((record: any, index: number) => {
      const bounds = geometry ? geometry(index) : [record.reference_start, record.reference_end];
      if (bounds?.every(Number.isSafeInteger)) readAlignmentBounds.set(record, bounds);
      const gaps = terminals?.(index);
      if (Array.isArray(gaps)) readTerminalGaps.set(record, gaps);
    });
    delete result.geometry;
    delete result.terminals;
    if (result._region_reuse_safe === true) readRegionProjectionSafe.add(result);
    delete result._region_reuse_safe;
    readBinaryBytes.set(result, buffer.byteLength);
    return result;
  };
  const result = header.reads ? dataset(header) : {
    ...header, datasets: Object.fromEntries(Object.entries(header.datasets).map(([key, value]) => [key, dataset(value)])),
  };
  readBinaryBytes.set(result, buffer.byteLength);
  return result;
}
