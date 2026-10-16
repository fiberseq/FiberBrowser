import { describe, expect, it, vi } from 'vitest';

const WARNING = 'fly.bed: its chromosomes (chr2L) are not on hg38, the main genome; they match dm6. '
  + 'Tracks are drawn in the main view, so it shows nothing until dm6 is the main genome.';
vi.mock('../api/tracks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/tracks')>()),
  addTrack: vi.fn(async () => ({ success: true, track_index: 0, label: 'fly', render_mode: 'annotation', warning: WARNING })),
}));

import { registerTrack } from './trackLoader';
import { useBrowserStore } from '../stores/browserStore';

describe('a track for another assembly, added from any track control (L11)', () => {
  it('shows the server\'s warning in the message banner', async () => {
    useBrowserStore.getState().setError(null);
    const r = await registerTrack({ pathOrUrl: '/beds/fly.bed', source: 'local' });
    expect(r.success).toBe(true);
    expect(r.warning).toBe(WARNING);
    expect(useBrowserStore.getState().error).toBe(WARNING);
  });

  it('leaves it to the caller that reports it with its other messages (openLocalPaths)', async () => {
    useBrowserStore.getState().setError(null);
    const r = await registerTrack({ pathOrUrl: '/beds/fly2.bed', source: 'local', showWarning: false });
    expect(r.warning).toBe(WARNING);
    expect(useBrowserStore.getState().error).toBeNull();
  });
});
