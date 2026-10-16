/**
 * Which pages of this server run are open now (3.0.0 audit LOW-3).
 *
 * Every page autosaves its session under the server run's boot id. A second tab opened while the first one is
 * still working found that autosave from "this run" and offered "Unsaved session found… Restore" as if the
 * first tab had crashed; restoring it there reloaded the genome over the first tab's (HIGH-1). Each page of a
 * run now beats in localStorage (shared by the tabs of one origin) while it is open and clears its beat when it
 * goes (pagehide). A save from this run with another page still beating belongs to that page: nothing is
 * offered. A page that crashed stops beating: after STALE_MS its save is offered again, also to a page
 * opened while that beat was still fresh (watchOtherTabs). A page that goes normally marks its beat closed
 * (pagehide): it is no longer live, and its going is not a crash.
 */
const PREFIX = 'fiberbrowser.liveTab.';
export const BEAT_MS = 3_000;
export const STALE_MS = 10_000;
/** Beats older than this are cleared (later than STALE_MS, so a watcher can still see a crashed page's). */
const FORGET_MS = 10 * 60_000;

const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let beating: { bootId: string; timer: number; stop: () => void } | null = null;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function beat(bootId: string) {
  try { storage()?.setItem(PREFIX + tabId, JSON.stringify({ bootId, at: Date.now() })); } catch { /* storage full or blocked */ }
}

/** This page is open under this server run, until it goes (or stopTabHeartbeat). */
export function startTabHeartbeat(bootId: string): void {
  if (beating?.bootId === bootId) return;
  stopTabHeartbeat();
  beat(bootId);
  const timer = window.setInterval(() => beat(bootId), BEAT_MS);
  const onHide = () => {
    try { storage()?.setItem(PREFIX + tabId, JSON.stringify({ bootId, at: Date.now(), closed: true })); } catch { /* blocked */ }
  };
  // Back from the back/forward cache: open again.
  const onShow = (e: PageTransitionEvent) => { if (e.persisted) beat(bootId); };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  beating = {
    bootId, timer,
    stop: () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      onHide();
    },
  };
}

export function stopTabHeartbeat(): void {
  beating?.stop();
  beating = null;
}

type Beat = { bootId?: string; at?: number; closed?: boolean };
type TabState = 'live' | 'closed' | 'crashed';

/** The other pages' beats of this server run: live, closed (went normally) or crashed (stopped beating). */
function otherTabs(bootId: string, now: number): Map<string, TabState> {
  const tabs = new Map<string, TabState>();
  const store = storage();
  if (!store) return tabs;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(PREFIX) && key !== PREFIX + tabId) keys.push(key);
    }
    for (const key of keys) {
      let entry: Beat | null = null;
      try { entry = JSON.parse(store.getItem(key) ?? 'null'); } catch { entry = null; }
      if (!entry || typeof entry.at !== 'number' || now - entry.at > FORGET_MS) {
        store.removeItem(key);
        continue;
      }
      if (entry.bootId !== bootId) continue;
      tabs.set(key, entry.closed ? 'closed' : now - entry.at > STALE_MS ? 'crashed' : 'live');
    }
  } catch { /* storage blocked: what was read so far */ }
  return tabs;
}

/** Whether another page of this server run is open now (its beat is fresh and not closed). */
export function otherTabLive(bootId: string, now = Date.now()): boolean {
  return [...otherTabs(bootId, now).values()].includes('live');
}

/**
 * Wait for the pages of this run that are live now to end, then say how: ``crashed`` when any stopped beating
 * (a renderer crash, a killed browser), ``closed`` when all went normally. A page opened within seconds of
 * another page's crash saw that page's last beat as live; its save is offered once the beat expires.
 */
export function watchOtherTabs(bootId: string, onEnded: (how: 'crashed' | 'closed') => void): () => void {
  const watched = new Set([...otherTabs(bootId, Date.now())].filter(([, state]) => state === 'live').map(([key]) => key));
  let crashed = false;
  const timer = window.setInterval(() => {
    const tabs = otherTabs(bootId, Date.now());
    for (const key of [...watched]) {
      const state = tabs.get(key);
      if (state === 'live') continue;
      if (state === 'crashed') crashed = true;
      watched.delete(key);
    }
    if (watched.size === 0) {
      window.clearInterval(timer);
      onEnded(crashed ? 'crashed' : 'closed');
    }
  }, BEAT_MS);
  return () => window.clearInterval(timer);
}
