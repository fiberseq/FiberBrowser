/** Whether the server marked this page as public (--public). It injects the
 * flag into index.html before any script runs, so it is safe to read from
 * modules that can't import the store. */
export function isPublicServerPage(): boolean {
  return typeof window !== 'undefined'
    && (window as unknown as { __FIBERHMM_PUBLIC__?: boolean }).__FIBERHMM_PUBLIC__ === true;
}

/** A page of a real `--public` server, as opposed to a local server's tour tab
 * (which also runs with public-mode rules). A public server shows its curated
 * catalog only: no files, uploads or track URLs, and no external track search. */
export function isPublicHostPage(): boolean {
  return isPublicServerPage()
    && !(window as unknown as { __FIBERBROWSER_SANDBOX__?: string }).__FIBERBROWSER_SANDBOX__;
}
