import { useEffect, useState } from 'react';
import { linkStatus, type HeldLink } from '../../api/sessionLinks';
import { linksOpenedCount, onLinkOpened } from '../../utils/sessionLinks';

const POLL_MS = 2 * 60 * 1000;

function names(links: HeldLink[]): string {
  const labels = links.flatMap(l => (l.labels.length ? l.labels : [l.url.split('/').pop() || l.url]));
  const shown = labels.slice(0, 3).join(', ');
  return labels.length > 3 ? `${shown} and ${labels.length - 3} more` : shown;
}

/**
 * Files opened from pre-signed links stop working when the link expires. The
 * server knows (the link's own expiry time, or a 403 on a one-byte read):
 * say which files and that the link must be reopened from its source.
 */
export function LinkExpiryBanner() {
  const [expired, setExpired] = useState<HeldLink[]>([]);
  const [soon, setSoon] = useState<HeldLink[]>([]);
  const [dismissed, setDismissed] = useState<string>('');
  const [active, setActive] = useState(linksOpenedCount() > 0);

  useEffect(() => onLinkOpened(() => setActive(true)), []);
  // After a reload the server may still hold links this page opened before.
  useEffect(() => {
    linkStatus().then(status => { if (status.links.length > 0) setActive(true); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = () => {
      linkStatus().then(status => {
        if (stopped) return;
        setExpired(status.expired);
        setSoon(status.expiring_soon);
      }).catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active]);

  const key = `${expired.map(l => l.url).join('|')}#${soon.map(l => l.url).join('|')}`;
  if ((!expired.length && !soon.length) || dismissed === key) return null;
  const hosts = [...new Set([...expired, ...soon].map(l => l.host).filter(Boolean))];
  return (
    <div
      role="status"
      data-testid="link-expiry-banner"
      className="fixed bottom-3 left-1/2 z-[120] flex max-w-2xl -translate-x-1/2 items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 shadow-lg dark:border-amber-500/40 dark:bg-amber-950/80 dark:text-amber-100"
    >
      <div>
        {expired.length > 0 ? (
          <p><b>Link expired</b> for {names(expired)}{hosts.length ? ` (${hosts.join(', ')})` : ''}: these files can't be read any more.
            Reopen the link from the source (the page that gave it to you).</p>
        ) : (
          <p><b>Links expire soon</b> for {names(soon)}. Reopen the link from the source to keep reading these files.</p>
        )}
      </div>
      <button type="button" onClick={() => setDismissed(key)} className="ml-auto text-amber-700 hover:text-amber-900 dark:text-amber-300" aria-label="Dismiss">×</button>
    </div>
  );
}
