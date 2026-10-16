/** Analysis features shipped in every release. The legacy pack name preserves saved sessions. */
import type { FiberBrowserPack } from '../plugins/packRegistry';
import './types';
import { registerSync } from './sync/register';
import { registerNfr } from './nfr/register';
import { setPreviewDefault } from '../utils/previewFeatures';

export const pack: FiberBrowserPack = {
  name: 'lab',
  label: 'Analysis features',
  flavor: 'public',
  register() {
    // Keep the existing preview preference and default in the unified release.
    setPreviewDefault(true);
    registerNfr();
    registerSync();
  },
};
