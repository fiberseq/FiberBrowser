import { describe, expect, it } from 'vitest';
import { formatFileLoadError } from './fileLoadErrors';

describe('file load error formatting', () => {
  it('adds a mapped-drive hint for WSL mount paths', () => {
    const message = formatFileLoadError('File not found: /mnt/z/lab/sample.bam');

    expect(message).toContain('/mnt/z/lab/sample.bam');
    expect(message).toContain('Windows mapped lab drive');
  });

  it('preserves backend mount-share guidance without duplicating it', () => {
    const message = formatFileLoadError('Mount the share inside WSL and load /mnt/lab/sample.bam');

    expect(message.match(/mount the share/gi)).toHaveLength(1);
  });
});
