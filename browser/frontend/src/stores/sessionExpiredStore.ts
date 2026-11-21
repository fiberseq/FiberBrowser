/**
 * "This tab's session expired": the server answered 401 (its access token changed, e.g. it restarted with a new
 * link). Every API call through api/sharedFetch reports it here; components/controls/SessionExpiredBanner shows
 * the banner. Never a silent failure.
 */
import { create } from 'zustand';

export const SESSION_EXPIRED_TEXT = "This tab's session expired (the server restarted). Reload with the new link.";

interface SessionExpiredState { expired: boolean; }
export const useSessionExpiredStore = create<SessionExpiredState>(() => ({ expired: false }));

export function reportAuthStatus(status: number): void {
  if (status === 401 && !useSessionExpiredStore.getState().expired) useSessionExpiredStore.setState({ expired: true });
}
