/**
 * Quantify a window's state (a browser-store extension): the window (genomic bp, shared by every metaprofile in the
 * set: the main track and the cluster profiles), the spec, and whether the results card is open. Saved with the
 * session as `frontend.windowQuant = { version: 1, window, spec, openIn, axis }`; a session without it loads with no window
 * and the defaults. Never changes what the read lanes show (refreshFree); undo / redo leave it alone.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import type { BrowserState } from '../../stores/browserStore';
import { DEFAULT_AXIS_FRAME, normalizeAxisFrame, type AxisFrame } from './axisFrame';
import { DEFAULT_QUANT_SPEC, normalizeQuantSpec, normalizeQuantWindow, type QuantSpec, type QuantWindow } from './spec';

export const WINDOW_QUANT_VERSION = 1;

export interface WindowQuantState {
  version: number;
  window: QuantWindow | null;
  spec: QuantSpec;
  /** Where the results card is shown (Quantify window was pressed there): the cluster profiles, the metaprofile
   *  track's card, or nowhere. */
  openIn: 'cluster' | 'track' | null;
  /** The metaprofiles' x-axis: genome coordinates or relative to an anchor (the window is then stored relative too). */
  axis: AxisFrame;
}

export const emptyWindowQuant = (): WindowQuantState => ({ version: WINDOW_QUANT_VERSION, window: null, spec: { ...DEFAULT_QUANT_SPEC, measures: [] }, openIn: null, axis: { ...DEFAULT_AXIS_FRAME } });

export function normalizeWindowQuant(raw: unknown): WindowQuantState {
  if (!raw || typeof raw !== 'object') return emptyWindowQuant();
  const r = raw as Record<string, unknown>;
  return { version: WINDOW_QUANT_VERSION, window: normalizeQuantWindow(r.window), spec: normalizeQuantSpec(r.spec), openIn: r.openIn === 'cluster' || r.openIn === 'track' ? r.openIn : null, axis: normalizeAxisFrame(r.axis) };
}

declare module '../../stores/browserStore' {
  interface BrowserState {
    windowQuant: WindowQuantState;
    setQuantWindow: (w: QuantWindow | null) => void;
    updateQuantSpec: (patch: Partial<QuantSpec>) => void;
    setQuantOpen: (where: 'cluster' | 'track' | null) => void;
    setQuantAxis: (patch: Partial<AxisFrame>) => void;
    /** "Select window" armed: the next drag on a metaprofile (the main track too, without Shift) sets the window. */
    quantSelecting: boolean;
    setQuantSelecting: (on: boolean) => void;
  }
}

let registered = false;

export function registerWindowQuantState(): void {
  if (registered) return;
  registered = true;
  registerStoreExtension({
    id: 'windowQuant',
    keys: ['windowQuant'],
    refreshFree: true,
    create: set => ({
      windowQuant: emptyWindowQuant(),
      setQuantWindow: (w: QuantWindow | null) => set(s => ({ windowQuant: { ...s.windowQuant, window: normalizeQuantWindow(w) } })),
      updateQuantSpec: (patch: Partial<QuantSpec>) => set(s => ({ windowQuant: { ...s.windowQuant, spec: normalizeQuantSpec({ ...s.windowQuant.spec, ...patch }) } })),
      setQuantOpen: (where: 'cluster' | 'track' | null) => set(s => ({ windowQuant: { ...s.windowQuant, openIn: where } })),
      setQuantAxis: (patch: Partial<AxisFrame>) => set(s => ({ windowQuant: { ...s.windowQuant, axis: normalizeAxisFrame({ ...s.windowQuant.axis, ...patch }) } })),
      quantSelecting: false,
      setQuantSelecting: (on: boolean) => set({ quantSelecting: on }),
    }),
    serialize: (s: BrowserState) => ({ windowQuant: s.windowQuant }),
    restoreSnapshot: () => ({}),
    importSession: frontend => ({ windowQuant: normalizeWindowQuant(frontend?.windowQuant) }),
  });
}
