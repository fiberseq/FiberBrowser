import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitNativeDropPaths, receiveNativeDrop, resetNativeDrop } from './nativeDrop';

describe('dropped files in the desktop app', () => {
  beforeEach(() => { window.__fiberbrowserNativeDrop = true; resetNativeDrop(); vi.useFakeTimers(); });
  afterEach(() => { delete window.__fiberbrowserNativeDrop; resetNativeDrop(); vi.useRealTimers(); });

  it('two files with the same name from different folders keep their own paths', async () => {
    const waiting = awaitNativeDropPaths(['sample.bam', 'sample.bam']);
    receiveNativeDrop({ files: [{ name: 'sample.bam', path: '/run1/sample.bam' }, { name: 'sample.bam', path: '/run2/sample.bam' }] });
    expect([...(await waiting).entries()]).toEqual([[0, '/run1/sample.bam'], [1, '/run2/sample.bam']]);
  });

  it('a report that comes after its drop gave up is not used for the next drop', async () => {
    const first = awaitNativeDropPaths(['sample.bam'], 2000);
    vi.advanceTimersByTime(2001);
    expect((await first).size).toBe(0);  // the first drop uploaded instead
    receiveNativeDrop({ files: [{ name: 'sample.bam', path: '/run1/sample.bam' }] });  // late
    const second = awaitNativeDropPaths(['sample.bam'], 2000);
    receiveNativeDrop({ files: [{ name: 'sample.bam', path: '/run2/sample.bam' }] });
    expect((await second).get(0)).toBe('/run2/sample.bam');
  });

  it('files without a path (dragged from a web page) are left to upload', async () => {
    const waiting = awaitNativeDropPaths(['a.bam', 'b.bed']);
    receiveNativeDrop({ files: [{ name: 'a.bam', path: '/d/a.bam' }, { name: 'b.bed', path: null }] });
    expect([...(await waiting).entries()]).toEqual([[0, '/d/a.bam']]);
  });
});
