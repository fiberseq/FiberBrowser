import { beforeEach, expect, it, vi } from 'vitest';
import type { SerializedState } from '../stores/historySlice';

vi.mock('../stores/historyStorage', () => ({ loadAutoSave: vi.fn() }));
import { loadAutoSave } from '../stores/historyStorage';
import { decideLaunchOffer, getLastSessionPreference, markUpdateRestart, setLastSessionPreference } from './launchSession';

const entry = { bootId: 'before-update', state: { datasets: [{ id: 'one' }] } as SerializedState, timestamp: 1 };
const launch = { boot_id: 'after-update', previous_boot_id: 'before-update', previous_exit: 'clean' as const };
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

it('reopens an update session once while preserving the ordinary Fresh preference', async () => {
  setLastSessionPreference('fresh');
  vi.mocked(loadAutoSave).mockResolvedValue(entry);
  await markUpdateRestart(true);
  expect(decideLaunchOffer(entry, launch, { hasWork: () => true, preference: 'fresh' })).toBe('auto-reopen');
  expect(getLastSessionPreference()).toBe('fresh');
  expect(decideLaunchOffer(entry, launch, { hasWork: () => true, preference: 'fresh' })).toBe('discard');
});

it('cancelled/failed handoff clears the one-time reopen request', async () => {
  vi.mocked(loadAutoSave).mockResolvedValue(entry);
  await markUpdateRestart(true);
  await markUpdateRestart(false);
  expect(decideLaunchOffer(entry, launch, { hasWork: () => true })).toBe('reopen');
});

it('does not mark a restart without a durable session', async () => {
  vi.mocked(loadAutoSave).mockResolvedValue(null);
  await expect(markUpdateRestart(true)).rejects.toThrow('saved session');
});

it('does not turn a crash or another session into an automatic update restore', async () => {
  vi.mocked(loadAutoSave).mockResolvedValue(entry);
  await markUpdateRestart(true);
  expect(decideLaunchOffer({ ...entry, bootId: 'unrelated' }, launch, { hasWork: () => true })).toBe('reopen');
  expect(decideLaunchOffer(entry, { ...launch, previous_exit: 'crash' }, { hasWork: () => true })).toBe('recover');
});
