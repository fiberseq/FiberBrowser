import { describe, expect, it } from 'vitest';
import { confirmQuestion, formatBytes, isSessionLinkValue, linkRequestFromSearch } from './sessionLinks';

describe('session link requests', () => {
  it('reads pending ids, sessions and hubs from the address', () => {
    expect(linkRequestFromSearch('?open_link=abcdefgh1234')).toEqual({ kind: 'pending', id: 'abcdefgh1234' });
    expect(linkRequestFromSearch('?session=https%3A%2F%2Fh.example.org%2Fs.json')).toEqual(
      { kind: 'session', value: 'https://h.example.org/s.json', genome: null });
    expect(linkRequestFromSearch('?sessionURL=https://h.example.org/s.json')?.kind).toBe('session');
    expect(linkRequestFromSearch('?hub=https://h.example.org/hub.txt&genome=hg38')).toEqual(
      { kind: 'hub', value: 'https://h.example.org/hub.txt', genome: 'hg38' });
    expect(linkRequestFromSearch('?session=data:application/json,%7B%7D')?.kind).toBe('session');
  });

  it('ignores a linked window id and malformed pending ids', () => {
    expect(linkRequestFromSearch('?session=abc123')).toBeNull();
    expect(isSessionLinkValue('abc123')).toBe(false);
    expect(linkRequestFromSearch('?open_link=<script>')).toBeNull();
    expect(linkRequestFromSearch('?chrom=chr1')).toBeNull();
  });

  it('phrases the question and sizes', () => {
    expect(confirmQuestion(12, ['data.example.org'])).toBe('Open 12 tracks from data.example.org?');
    expect(confirmQuestion(1, ['a.org', 'b.org'])).toBe('Open 1 track from a.org and 1 other host?');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(null)).toBeNull();
  });
});
