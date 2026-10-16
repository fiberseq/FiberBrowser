/** Accessibility (preview): a small notice when a slow request finishes while its view is closed (utils/nfrJobs). */
import { useEffect } from 'react';
import { dismissNotice, useJobNotices, type JobOwner } from '../nfrJobs';

export function NfrNotices({ onOpen }: { onOpen?: (owner: JobOwner) => void }) {
  const notices = useJobNotices();
  useEffect(() => {
    if (!notices.length) return;
    const timers = notices.map(n => window.setTimeout(() => dismissNotice(n.id), 6000));
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [notices]);
  if (!notices.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex flex-col items-end gap-1.5" data-testid="nfr-notices" aria-live="polite">
      {notices.map(n => (
        <div key={n.id} data-testid="nfr-notice" role="status"
          className="pointer-events-auto flex items-center gap-2 rounded-md border border-fuchsia-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-700 shadow-lg dark:border-fuchsia-900/60 dark:bg-gray-900 dark:text-gray-200">
          <span className={`h-2 w-2 rounded-full ${n.ok ? 'bg-fuchsia-500' : 'bg-red-500'}`} />
          <span>{n.ok ? 'Ready' : 'Failed'}: {n.label}</span>
          {onOpen && n.owner && (
            <button type="button" className="font-medium text-fuchsia-700 hover:underline dark:text-fuchsia-300" onClick={() => { onOpen(n.owner!); dismissNotice(n.id); }}>Show</button>
          )}
          <button type="button" aria-label="Dismiss" className="text-ink-secondary hover:text-gray-700 dark:hover:text-gray-200" onClick={() => dismissNotice(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

/** A small dot that marks a tab or an entry whose result arrived while it was closed. */
export function NewDot({ title = 'New result' }: { title?: string }) {
  return <span data-testid="nfr-new-dot" title={title} className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-fuchsia-500 align-middle" />;
}
