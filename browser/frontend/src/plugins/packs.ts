/**
 * Internal plugin packs: optional feature folders that ship with some builds (ARCHITECTURE.md).
 *
 * A pack is a folder directly under src/ with a `fiberbrowser-pack.ts` exporting `pack: FiberBrowserPack`. Core code
 * never imports a pack: this module finds them (a build-time glob, empty in a build without them) and registers each
 * once. main.tsx imports it right after the sandbox and render-mode bootstraps and calls `loadPacks()` once the
 * built-in panels are registered, before rendering; tests that need a pack call `loadPacks()` themselves.
 */
import { registerPack, type FiberBrowserPack } from './packRegistry';

export type { FiberBrowserPack } from './packRegistry';

type PackModule = { pack?: FiberBrowserPack };

// Every src/<folder>/fiberbrowser-pack.ts of this build.
const modules = import.meta.glob<PackModule>('../*/fiberbrowser-pack.ts', { eager: true });

let done = false;

/** Register every pack of this build, once. */
export function loadPacks(): void {
  if (done) return;
  done = true;
  for (const key of Object.keys(modules).sort()) {
    const pack = modules[key]?.pack;
    if (pack) registerPack(pack);
  }
}
