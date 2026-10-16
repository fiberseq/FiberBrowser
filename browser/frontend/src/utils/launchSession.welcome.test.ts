/**
 * fb-n4-tour: the Welcome card flashed for one frame (~20 ms) at launch. The
 * launch decision (CrashRecoveryBanner) started in an effect, after the first
 * render had drawn the empty browser with its Welcome card, so the card showed
 * over a dataset opened on the command line (and under the "Reopen your last
 * session" offer) until the decision held it back. A page that will decide now
 * starts out deciding; one that won't (a tour tab, a public server, a render)
 * shows the card at once, and nothing holds it back past the cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LaunchModule = typeof import('./launchSession');

async function freshModule(): Promise<LaunchModule> {
  vi.resetModules();
  return import('./launchSession');
}

describe('the Welcome card at launch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__;
    delete (window as unknown as { __FIBERBROWSER_RENDER_MODE?: boolean }).__FIBERBROWSER_RENDER_MODE;
  });

  it('a local page holds the card back from its first render', async () => {
    const m = await freshModule();
    expect(m.launchOfferHidesWelcome(m.useLaunchUiStore.getState())).toBe(true);
  });

  it('the decision, once started, owns the card (the cap does not cut it short)', async () => {
    const m = await freshModule();
    m.setLaunchUi({ deciding: true });
    m.setLaunchUi({ deciding: false, offerShown: true });
    vi.advanceTimersByTime(m.LAUNCH_DECIDING_MAX_MS + 100);
    expect(m.useLaunchUiStore.getState()).toMatchObject({ deciding: false, offerShown: true });
    m.setLaunchUi({ deciding: true });
    vi.advanceTimersByTime(m.LAUNCH_DECIDING_MAX_MS + 100);
    expect(m.useLaunchUiStore.getState().deciding).toBe(true);
  });

  it('nothing starts deciding: the card comes back after the cap', async () => {
    const m = await freshModule();
    vi.advanceTimersByTime(m.LAUNCH_DECIDING_MAX_MS - 100);
    expect(m.useLaunchUiStore.getState().deciding).toBe(true);
    vi.advanceTimersByTime(200);
    expect(m.launchOfferHidesWelcome(m.useLaunchUiStore.getState())).toBe(false);
  });

  it('a public server page and a render never hold it back', async () => {
    (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__ = true;
    expect((await freshModule()).useLaunchUiStore.getState().deciding).toBe(false);
    delete (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__;
    (window as unknown as { __FIBERBROWSER_RENDER_MODE?: boolean }).__FIBERBROWSER_RENDER_MODE = true;
    expect((await freshModule()).useLaunchUiStore.getState().deciding).toBe(false);
  });
});
