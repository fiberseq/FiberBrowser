import { describe, expect, it } from 'vitest';
import { chooseServerPaths, setServerFileBrowserListener, type ServerFileRequest } from '../serverFileBrowser';

describe('server file browser bridge', () => {
  it('a stale request resolving late does not close the newer dialog', async () => {
    const shown: Array<ServerFileRequest | null> = [];
    setServerFileBrowserListener(request => shown.push(request));
    const first = chooseServerPaths({ title: 'A' });
    const firstRequest = shown[shown.length - 1]!;
    const second = chooseServerPaths({ title: 'A' });
    const secondRequest = shown[shown.length - 1]!;
    expect(secondRequest.id).not.toBe(firstRequest.id);
    await expect(first).resolves.toBeNull();

    const before = shown.length;
    firstRequest.resolve(['/late']); // already settled: ignored
    expect(shown.length).toBe(before);

    secondRequest.resolve(['/b']);
    await expect(second).resolves.toEqual(['/b']);
    expect(shown[shown.length - 1]).toBeNull();
    setServerFileBrowserListener(null);
  });
});
