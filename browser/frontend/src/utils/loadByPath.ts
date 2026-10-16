/**
 * Open ▾ → Load by path / URL… (and the command `load-by-path`): the settings
 * sidebar opened at Data & Sessions with Load by path (its field focused) and,
 * just below it, Load Remote URL with its form open (URL, S3 endpoint and
 * profile). The same controls as in the sidebar; nothing new to learn.
 *
 * No static imports: the command bus (utils/appCommands) imports this, and the
 * settings modules it reveals import, through the file loaders, the bus again
 * (a cycle would leave a settings group undefined in utils/settingsRegistry).
 */

/** Fired on window: the Load Remote URL form should open (components/controls/sidebar/DataSection). */
export const SHOW_REMOTE_URL_EVENT = 'fiberbrowser:show-remote-url';

// The sidebar may not be mounted yet when asked (it opens on the same click):
// the form opens when it mounts.
let remoteFormRequested = false;

/** Whether the Load Remote URL form was asked to open (and forget the request). */
export function takeRemoteUrlRequest(): boolean {
  const requested = remoteFormRequested;
  remoteFormRequested = false;
  return requested;
}

/** Show Load by path and Load Remote URL in the sidebar. Resolves true when the path field was found. */
export async function showLoadByPath(): Promise<boolean> {
  remoteFormRequested = true;
  window.dispatchEvent(new CustomEvent(SHOW_REMOTE_URL_EVENT));
  window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.remote' },
  }));
  const [{ revealSetting }, { LOAD_PATH_SETTINGS }] = await Promise.all([
    import('./revealSetting'),
    import('../components/controls/sidebar/file/LoadLocalFileSettings'),
  ]);
  const found = await revealSetting(LOAD_PATH_SETTINGS.path);
  // The Remote URL form can mount after the path field took the focus (its subsection opens on a
  // timer) and its URL field autofocuses: give the focus back to the path field once it is there.
  const started = Date.now();
  while (typeof document !== 'undefined' && !document.querySelector('[data-testid="remote-url-input"]') && Date.now() - started < 1000) {
    await new Promise(resolve => window.setTimeout(resolve, 40));
  }
  if (typeof document === 'undefined') return found;   // the page went meanwhile
  const path = document.querySelector<HTMLElement>('[data-testid="load-by-path-input"]');
  const active = document.activeElement as HTMLElement | null;
  if (path && (!active || active === document.body || active.matches('[data-testid="remote-url-input"]'))) {
    path.focus({ preventScroll: true });
  }
  return found;
}
