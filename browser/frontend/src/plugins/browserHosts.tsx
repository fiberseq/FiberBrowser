/**
 * Components a plugin pack (or core: the update check, main.tsx) mounts once in the browser window (Browser.tsx renders them all): hosts of its background
 * hooks (runs it follows, panels it keeps in step) and of its dialogs opened from anywhere. Each renders null or a
 * portal of its own. Registered before the app renders (plugins/packs.ts), so the list is fixed while it runs.
 */
import type { ComponentType } from 'react';

interface BrowserHost {
  id: string;
  component: ComponentType;
  /** Not in a headless figure render (`?render=1`): a dialog host, say. */
  interactiveOnly?: boolean;
}

const hosts: BrowserHost[] = [];

export function registerBrowserHost(id: string, component: ComponentType, options: { interactiveOnly?: boolean } = {}): void {
  const host = { id, component, ...options };
  const at = hosts.findIndex(h => h.id === id);
  if (at >= 0) hosts[at] = host;
  else hosts.push(host);
}

/** Every registered host (Browser.tsx). */
export function BrowserHosts({ renderMode }: { renderMode: boolean }) {
  return (
    <>
      {hosts.filter(h => !(renderMode && h.interactiveOnly)).map(({ id, component: Host }) => <Host key={id} />)}
    </>
  );
}
