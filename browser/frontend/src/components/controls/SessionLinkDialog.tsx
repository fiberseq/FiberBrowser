import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  discardLink, openLink, previewLink, stageLink,
  type LinkPreview, type LinkTrack, type OpenedLink,
} from '../../api/sessionLinks';
import {
  STARTUP_LINK_REQUEST, applyOpenedLink, confirmQuestion, formatBytes, scrubLinkParams, settleStartupLink,
  type LinkRequest,
} from '../../utils/sessionLinks';
import { useConnectClusterStore } from '../../utils/connectCluster';
import { isLabServerPage } from '../../utils/labServer';

type Phase =
  | { name: 'loading' }
  | { name: 'fetch-question'; preview: LinkPreview }
  | { name: 'ready'; preview: LinkPreview }
  | { name: 'opening'; preview: LinkPreview }
  | { name: 'done'; result: OpenedLink }
  | { name: 'error'; message: string };

const TYPE_LABELS: Record<LinkTrack['type'], string> = {
  bam: 'BAM', bigbed: 'bigBed', bigwig: 'bigWig', bed: 'BED', plasmid: 'Plasmid map',
};

function describeTrack(track: LinkTrack): string {
  if (track.type === 'bigbed') return track.as === 'reads' ? 'bigBed reads' : 'bigBed';
  return TYPE_LABELS[track.type] ?? track.type;
}

function genomeText(preview: LinkPreview): string {
  const genome = preview.genome;
  if (!genome) return 'Keep the current genome';
  if (genome.kind === 'catalog') return genome.id ?? genome.label ?? '';
  return `${genome.label ?? 'FASTA'} (FASTA from ${hostOf(genome.url)})`;
}

function hostOf(url?: string | null): string {
  try { return url ? new URL(url).host : ''; } catch { return ''; }
}

function sourceText(preview: LinkPreview): string {
  const source = preview.source;
  if (source.kind === 'inline') return 'this link (the list is in the link itself)';
  const what = source.kind === 'hub' ? 'track hub' : 'session';
  return `${what} at ${source.host ?? 'an unknown host'}`;
}

/**
 * Opening a session link (?open_link=, ?session=, ?hub=): nothing loads until
 * the user has seen the source host, the genome and the tracks, and confirmed.
 * Mounted once (App); does nothing when the page was opened without a link.
 */
export function SessionLinkHost({ request = STARTUP_LINK_REQUEST }: { request?: LinkRequest | null }) {
  const [phase, setPhase] = useState<Phase | null>(request ? { name: 'loading' } : null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const settled = useRef(false);

  const finish = useCallback((genomeLoaded: boolean) => {
    if (!settled.current) {
      settled.current = true;
      settleStartupLink({ genomeLoaded });
    }
  }, []);

  const showPreview = useCallback((preview: LinkPreview) => {
    if (!preview.success) {
      setPhase({ name: 'error', message: preview.error || 'This link could not be read.' });
      return;
    }
    if (preview.needs_fetch_confirmation) {
      setPhase({ name: 'fetch-question', preview });
      return;
    }
    setSelected(new Set((preview.tracks ?? []).filter(t => t.visible && !t.problem).map(t => t.index)));
    setPhase({ name: 'ready', preview });
  }, []);

  useEffect(() => {
    if (!request) return;
    // The address may carry a pre-signed URL: out of the address bar and history now.
    scrubLinkParams();
    let cancelled = false;
    (async () => {
      let id: string | null = null;
      if (request.kind === 'pending') {
        id = request.id;
      } else {
        const staged = await stageLink(request.kind === 'hub'
          ? { hub: request.value, genome: request.genome }
          : { session: request.value, genome: request.genome });
        if (!staged.success || !staged.id) {
          if (!cancelled) setPhase({ name: 'error', message: staged.error || 'This link could not be opened.' });
          return;
        }
        id = staged.id;
      }
      if (cancelled) return;
      setLinkId(id);
      const preview = await previewLink(id);
      if (!cancelled) showPreview(preview);
    })().catch(err => {
      if (!cancelled) setPhase({ name: 'error', message: err?.message || 'This link could not be opened.' });
    });
    return () => { cancelled = true; };
  }, [request, showPreview]);

  useEffect(() => {
    if (phase?.name === 'error') finish(false);
  }, [phase, finish]);

  const close = useCallback(() => {
    setPhase(null);
    finish(false);
  }, [finish]);

  const cancel = useCallback(() => {
    if (linkId) void discardLink(linkId).catch(() => {});
    close();
  }, [linkId, close]);

  const fetchDocument = useCallback(async () => {
    if (!linkId) return;
    setPhase({ name: 'loading' });
    showPreview(await previewLink(linkId, true));
  }, [linkId, showPreview]);

  /** Files on a cluster: the user connects (never automatic), then the link is reviewed again. */
  const connectCluster = useCallback((target: string) => {
    if (!linkId) return;
    const [user, host] = target.includes('@') ? target.split('@', 2) : [null, target];
    useConnectClusterStore.getState().show(
      { host, user, reason: `The link lists files on ${target}. Connect to open them.` },
      connected => {
        if (connected) void previewLink(linkId).then(showPreview);
      },
    );
  }, [linkId, showPreview]);

  const confirm = useCallback(async () => {
    if (!linkId || phase?.name !== 'ready') return;
    const preview = phase.preview;
    setPhase({ name: 'opening', preview });
    const result = await openLink(linkId, [...selected].sort((a, b) => a - b));
    if (result.success || (result.opened ?? 0) > 0) {
      await applyOpenedLink(result);
    }
    finish(Boolean(result.genome?.loaded) || Boolean(result.genome?.has_fasta));
    if (result.success && !(result.errors?.length) && !(result.warnings?.length)) {
      setPhase(null);
      return;
    }
    setPhase({ name: 'done', result });
  }, [linkId, phase, selected, finish]);

  useEffect(() => {
    if (!phase) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase.name !== 'opening') {
        event.stopPropagation();
        if (phase.name === 'done' || phase.name === 'error') close();
        else cancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [phase, cancel, close]);

  const tracks = useMemo(
    () => (phase && 'preview' in phase ? phase.preview.tracks ?? [] : []),
    [phase],
  );

  if (!phase) return null;

  const toggle = (index: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  let body: JSX.Element;
  if (phase.name === 'loading') {
    body = <p className="px-4 py-6 text-[13px] text-gray-600 dark:text-gray-300" data-testid="session-link-loading">Reading the link…</p>;
  } else if (phase.name === 'error') {
    body = (
      <>
        <Header title="This link can't be opened" />
        <p className="px-4 py-3 text-[13px] text-red-700 dark:text-red-300" data-testid="session-link-error">{phase.message}</p>
        <Footer><Button onClick={close} testId="session-link-close">Close</Button></Footer>
      </>
    );
  } else if (phase.name === 'fetch-question') {
    body = (
      <>
        <Header title={`Review a link from ${phase.preview.source.host ?? 'another page'}?`} />
        <div className="space-y-2 px-4 py-3 text-[13px] text-gray-700 dark:text-gray-200">
          <p>A page asks FiberBrowser to open a {phase.preview.source.kind === 'hub' ? 'track hub' : 'session'} at <b>{phase.preview.source.url}</b>.</p>
          <p className="text-gray-500 dark:text-gray-400">{phase.preview.reason} FiberBrowser has not contacted it yet.
            Only continue if you expected this link.</p>
        </div>
        <Footer>
          <Button onClick={cancel} testId="session-link-cancel">Cancel</Button>
          <Button onClick={fetchDocument} primary testId="session-link-fetch">Review the link</Button>
        </Footer>
      </>
    );
  } else if (phase.name === 'done') {
    const result = phase.result;
    body = (
      <>
        <Header title={result.success ? 'Link opened' : 'The link could not be opened'} />
        <div className="space-y-2 px-4 py-3 text-[13px] text-gray-700 dark:text-gray-200" data-testid="session-link-result">
          {result.message && <p>{result.message}</p>}
          {!result.success && result.error && <p className="text-red-700 dark:text-red-300">{result.error}</p>}
          {(result.errors ?? []).map((line, i) => <p key={`e${i}`} className="text-red-700 dark:text-red-300">{line}</p>)}
          {(result.warnings ?? []).map((line, i) => <p key={`w${i}`} className="text-amber-700 dark:text-amber-300">{line}</p>)}
        </div>
        <Footer><Button onClick={close} primary testId="session-link-close">Close</Button></Footer>
      </>
    );
  } else {
    const preview = phase.preview;
    const opening = phase.name === 'opening';
    const chosen = tracks.filter(t => selected.has(t.index));
    const hosts = [...new Set(chosen.map(t => t.host).filter(Boolean))];
    const tooMany = preview.max_tracks != null && chosen.length > preview.max_tracks;
    const genomeOnly = tracks.length === 0;
    body = (
      <>
        <Header
          title={genomeOnly ? `Open ${genomeText(preview)}?` : confirmQuestion(chosen.length, hosts)}
          subtitle={preview.title ?? undefined}
        />
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 border-b border-gray-100 px-4 py-2 text-[12px] dark:border-white/10">
          <dt className="text-gray-500 dark:text-gray-400">From</dt>
          <dd className="text-gray-800 dark:text-gray-100" data-testid="session-link-source">{sourceText(preview)}</dd>
          <dt className="text-gray-500 dark:text-gray-400">Genome</dt>
          <dd className="text-gray-800 dark:text-gray-100" data-testid="session-link-genome">{genomeText(preview)}</dd>
          {preview.locus && (<>
            <dt className="text-gray-500 dark:text-gray-400">Go to</dt>
            <dd className="text-gray-800 dark:text-gray-100">{preview.locus.text}</dd>
          </>)}
        </dl>
        {tracks.length > 0 && (
          <div className="flex-1 divide-y divide-gray-100 overflow-y-auto dark:divide-white/5" data-testid="session-link-tracks">
            {tracks.map(track => {
              const size = formatBytes(track.size);
              return (
                <label key={track.index} className={`flex items-start gap-2 px-4 py-1.5 ${track.problem ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5'}`} data-testid="session-link-track">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(track.index)}
                    disabled={Boolean(track.problem) || opening}
                    onChange={() => toggle(track.index)}
                  />
                  {track.color && <span className="mt-1 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: track.color }} />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-medium text-gray-800 dark:text-gray-100">{track.name}</span>
                      <span className="flex-shrink-0 text-[11px] text-gray-400">{describeTrack(track)}</span>
                      {size && <span className="flex-shrink-0 text-[11px] text-gray-400">{size}</span>}
                      {track.signed && <span className="flex-shrink-0 text-[11px] text-amber-600 dark:text-amber-400" title="A pre-signed link: it works until it expires and is never saved">signed link</span>}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-gray-400" title={track.url}>
                      {[track.group, track.sample].filter(Boolean).join(' · ')}{(track.group || track.sample) ? ' · ' : ''}{track.url}
                    </span>
                    {track.problem && <span className="block text-[11px] text-red-600 dark:text-red-400">{track.problem}</span>}
                    {track.problem && track.cluster && !isLabServerPage() && (
                      <button
                        type="button"
                        onClick={event => { event.preventDefault(); connectCluster(track.cluster!); }}
                        className="mt-0.5 rounded border border-blue-200 px-1.5 py-0.5 text-[11px] text-blue-700 hover:bg-blue-50 dark:border-blue-500/30 dark:text-blue-300"
                        data-testid="session-link-connect"
                      >
                        Connect to {track.cluster}…
                      </button>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {((preview.warnings?.length ?? 0) > 0 || tooMany) && (
          <div className="space-y-1 border-t border-gray-100 px-4 py-2 text-[12px] text-amber-700 dark:border-white/10 dark:text-amber-300" data-testid="session-link-warnings">
            {tooMany && <p>This server opens at most {preview.max_tracks} tracks from a link; untick some.</p>}
            {(preview.warnings ?? []).map((w, i) => <p key={i}>{w}</p>)}
          </div>
        )}
        <Footer>
          <span className="mr-auto text-[11px] text-gray-400">Only open links you trust. Nothing is loaded until you press Open.</span>
          <Button onClick={cancel} disabled={opening} testId="session-link-cancel">Cancel</Button>
          <Button
            onClick={confirm}
            primary
            disabled={opening || tooMany || (!genomeOnly && chosen.length === 0)}
            testId="session-link-open"
          >
            {opening ? 'Opening…' : 'Open'}
          </Button>
        </Footer>
      </>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open a link"
        data-testid="session-link-dialog"
        className="relative mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b border-gray-200 px-4 py-3 dark:border-white/10">
      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100" data-testid="session-link-question">{title}</h2>
      {subtitle && <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">{subtitle}</p>}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-2 dark:border-white/10">{children}</div>;
}

function Button({ onClick, children, primary, disabled, testId }: {
  onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean; testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={primary
        ? 'rounded bg-blue-600 px-3 py-1 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50'
        : 'rounded border border-gray-200 px-3 py-1 text-[13px] text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/15 dark:text-gray-200 dark:hover:bg-white/5'}
    >
      {children}
    </button>
  );
}
