import type { SerializedState } from './historySlice';

const DB_NAME = 'fiberhmm_history';
const DB_VERSION = 1;
const STORE_NAME = 'autosave';
const KEY = 'latest';

interface AutoSaveEntry {
  state: SerializedState;
  timestamp: number;
  /** The page had undoable actions (the user did something) when saved. */
  acted?: boolean;
  /** The server run it was saved under (GET /api/session/launch): an earlier
   * run's save is offered as "Reopen last session" (on the welcome card) after a normal quit. */
  bootId?: string | null;
}

export type { AutoSaveEntry };

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAutoSave(state: SerializedState, acted = false, bootId: string | null = null): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: AutoSaveEntry = { state, timestamp: Date.now(), acted, ...(bootId ? { bootId } : {}) };
    store.put(entry, KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Silently fail — IndexedDB may be unavailable
  }
}

export async function loadAutoSave(): Promise<AutoSaveEntry | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY);
    const result = await new Promise<AutoSaveEntry | null>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function clearAutoSave(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Silently fail
  }
}

// A session restored from a save that had work keeps counting as work, so a
// later reload still offers it (the restore doesn't bring back undo history).
let restoredWork = false;
export function markRestoredWork(): void { restoredWork = true; }
export function hasRestoredWork(): boolean { return restoredWork; }
