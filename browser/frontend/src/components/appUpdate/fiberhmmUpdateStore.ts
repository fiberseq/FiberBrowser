import { create } from 'zustand';
import {
  getFiberhmmUpdate, installFiberhmmUpdate, revertFiberhmmUpdate, restartFiberhmmUpdate, quitForUpdate,
  type FiberhmmUpdateJob,
} from '../../api/appUpdate';
import { autoSaveNow } from '../../hooks/useAutoSave';
import { markUpdateRestart } from '../../utils/launchSession';

interface State {
  job: FiberhmmUpdateJob;
  error: string | null;
  restartBusy: boolean;
  load: () => Promise<void>;
  install: () => Promise<void>;
  revert: () => Promise<void>;
  restart: () => Promise<void>;
}
let poll: ReturnType<typeof setTimeout> | null = null;
function follow(job: FiberhmmUpdateJob) {
  useFiberhmmUpdateStore.setState({ job });
  if (poll) clearTimeout(poll);
  poll = job.state === 'installing' ? setTimeout(() => void useFiberhmmUpdateStore.getState().load(), 500) : null;
}
export const useFiberhmmUpdateStore = create<State>((set, get) => ({
  job: { state: 'idle' }, error: null, restartBusy: false,
  load: async () => {
    try { follow(await getFiberhmmUpdate()); }
    catch (e) { set({ error: String(e) }); }
  },
  install: async () => {
    set({ error: null, job: { state: 'installing' } });
    try { follow(await installFiberhmmUpdate()); }
    catch (e) { set({ error: String(e), job: { state: 'error' } }); }
  },
  revert: async () => {
    set({ error: null });
    try { follow(await revertFiberhmmUpdate()); }
    catch (e) { set({ error: String(e) }); }
  },
  restart: async () => {
    if (get().restartBusy) return;
    set({ restartBusy: true, error: null });
    let handedOff = get().job.state === 'restarting';
    try {
      if (!handedOff) {
        // Same required durable save and reopen marker as the app updater.
        await autoSaveNow({ required: true });
        await markUpdateRestart(true);
        const job = await restartFiberhmmUpdate();
        set({ job });
        handedOff = true;
      }
      const result = await quitForUpdate();
      if (!result.success) throw new Error('The app refused to quit. Quit FiberBrowser to finish the update.');
    } catch (e) {
      if (!handedOff) await markUpdateRestart(false).catch(() => {});
      set({ error: `Could not restart: ${String(e)}` });
    } finally { set({ restartBusy: false }); }
  },
}));
