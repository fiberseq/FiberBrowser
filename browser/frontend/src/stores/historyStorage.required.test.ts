import { afterEach, expect, it, vi } from 'vitest';
import type { SerializedState } from './historySlice';
import { saveAutoSave } from './historyStorage';

afterEach(() => vi.unstubAllGlobals());

it('a failed durable save blocks an update while background autosave stays best effort', async () => {
  vi.stubGlobal('indexedDB', { open: () => {
    const req: { onerror?: () => void; error: Error } = { error: new Error('Storage full') };
    queueMicrotask(() => req.onerror?.());
    return req;
  } });
  await expect(saveAutoSave({} as SerializedState, false, 'run', true)).rejects.toThrow('Storage full');
  await expect(saveAutoSave({} as SerializedState)).resolves.toBeUndefined();
});

it('transaction aborts reject the required save', async () => {
  const tx: { onabort?: () => void; error: Error; objectStore: () => { put: () => void } } = {
    error: new Error('Transaction aborted'), objectStore: () => ({ put: () => queueMicrotask(() => tx.onabort?.()) }),
  };
  vi.stubGlobal('indexedDB', { open: () => {
    const req: { onsuccess?: () => void; result: unknown } = {
      result: { transaction: () => tx, close: vi.fn() },
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  } });
  await expect(saveAutoSave({} as SerializedState, false, 'run', true)).rejects.toThrow('Transaction aborted');
});
