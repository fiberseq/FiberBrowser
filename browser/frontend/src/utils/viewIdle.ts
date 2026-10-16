import { apiIdleToken, readIdleToken } from '../api/sharedFetch';

let painted = false;
let scheduled = false;

/** Release background work after a completed read canvas reaches the screen. */
export function markReadViewDrawn(): void {
  if (painted || scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    painted = true;
    performance.mark?.('read-view-painted');
  }));
}

/** Wait for the first view and a quiet API interval; cancellation always wakes it. */
export function waitForViewIdle(signal: AbortSignal, readsOnly = false): Promise<void> {
  return new Promise(resolve => {
    const idleToken = readsOnly ? readIdleToken : apiIdleToken;
    let token = idleToken();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const check = () => {
      const current = idleToken();
      if (signal.aborted || (painted && current !== undefined && current === token)) return finish();
      token = current;
      timer = setTimeout(check, 750);
    };
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
    else timer = setTimeout(check, 750);
  });
}
