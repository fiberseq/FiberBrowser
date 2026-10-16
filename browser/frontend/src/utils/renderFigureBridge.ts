import { applyImportedState } from '../api/session';
import { getDafcStatus } from '../api/dafc';
import { applyDafcStatusToStores } from '../hooks/useDafcStatusBootstrap';
import { exportTrackFigure, type FigureOptions } from './figureExport';

/**
 * Hooks the headless render worker (scripts/render-headless.mjs) calls in
 * render mode: restore a browser state the same way a session import does,
 * then export the figure exactly as the Export button would.
 */
declare global {
  interface Window {
    /** Set once a figure state is applied: the page then fetches like the live app. */
    __FIBERBROWSER_FIGURE_MODE?: boolean;
    __fiberbrowserApplyFigureState?: (result: Record<string, unknown>) => Promise<void>;
    __fiberbrowserExportFigure?: (options: FigureOptions) => Promise<{ b64: string; mime: string; width: number; height: number }>;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

export interface RenderFigureBridgeOptions {
  /** Load what the live page loads at startup but render mode skips (the backend track list). */
  loadStartupData: () => Promise<void>;
}

export function installRenderFigureBridge({ loadStartupData }: RenderFigureBridgeOptions): () => void {
  window.__fiberbrowserApplyFigureState = async result => {
    window.__FIBERBROWSER_RENDER_READY = false;
    window.__FIBERBROWSER_FIGURE_MODE = true;
    // Contact maps and track registrations first: the saved settings refer to them.
    await Promise.all([
      loadStartupData().catch(() => {}),
      getDafcStatus().then(applyDafcStatusToStores).catch(() => {}),
    ]);
    applyImportedState(result);
    // Re-arm readiness even when the restored view equals the initial one
    // (Browser's ready effect only re-fires when the viewport/panels change).
    await nextFrame();
    await nextFrame();
    window.setTimeout(() => window.__fiberbrowserMarkRenderReady?.({ figure: true }), 50);
  };
  window.__fiberbrowserExportFigure = async options => {
    const figure = await exportTrackFigure(options);
    return { b64: await blobToBase64(figure.blob), mime: figure.blob.type, width: figure.width, height: figure.height };
  };
  return () => {
    delete window.__fiberbrowserApplyFigureState;
    delete window.__fiberbrowserExportFigure;
  };
}
