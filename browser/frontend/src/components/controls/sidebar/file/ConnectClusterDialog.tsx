import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  connectRemote,
  disconnectRemote,
  getRemoteSources,
  listRemote,
  type RemoteConnection,
  type RemoteEntry,
  type RemoteListing,
  type RemoteSourceInfo,
} from '../../../../api/remote';
import { connectionServes, useConnectClusterStore } from '../../../../utils/connectCluster';
import { openClusterFiles, planClusterOpen } from '../../../../utils/clusterOpen';
import { messageFromError } from '../../../../utils/fileLoadErrors';
import { Folder, Server } from '../../../ui/Icons';

type Filter = 'data' | 'reference' | 'all';

const FILTERS: { id: Filter; label: string; kinds: RemoteEntry['kind'][] | null }[] = [
  { id: 'data', label: 'BAM / BigBed', kinds: ['bam', 'bigbed'] },
  { id: 'reference', label: 'FASTA / maps', kinds: ['fasta', 'map'] },
  { id: 'all', label: 'All files', kinds: null },
];

const KIND_LABEL: Record<string, string> = {
  bam: 'BAM', bigbed: 'BigBed', bigwig: 'BigWig', fasta: 'FASTA', map: 'Map', index: 'Index',
  annotation: 'Annotation', session: 'JSON', other: '',
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Why a listing is partial (the helper bounds entries, entries read and time). */
export function truncationNote(listing: Pick<RemoteListing, 'entries' | 'truncated_reason' | 'scanned' | 'limit'>): string {
  const shown = (listing.entries?.length ?? 0).toLocaleString('en-US');
  if (listing.truncated_reason === 'scan') {
    return `This folder is very large: only the first ${(listing.scanned ?? 0).toLocaleString('en-US')} entries were read, `
      + `and ${shown} of them are shown. To reach a subfolder not shown, add its path to Folders to share and connect again.`;
  }
  if (listing.truncated_reason === 'time') {
    return `Listing this folder took too long: ${shown} entries are shown. To reach a subfolder not shown, add its path to Folders to share and connect again.`;
  }
  return `Only the first ${(listing.limit ?? listing.entries?.length ?? 0).toLocaleString('en-US')} entries are shown.`;
}

function refForFolder(connection: RemoteConnection, folder: string): string {
  return `${connection.ref_prefix}${folder.startsWith('/') ? '' : '/'}${folder}`;
}

function pathOfRef(ref: string): string {
  const rest = ref.replace(/^[a-z0-9]+:\/\//i, '');
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(slash) : '/';
}

// One filled (primary) action at a time: Connect/Browse until files are
// listed, then Open (UI audit L16).
const PRIMARY_BUTTON = 'rounded bg-blue-600 px-3 py-1 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const SECONDARY_BUTTON = 'rounded border border-gray-300 bg-white px-3 py-1 text-[13px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/15 dark:bg-transparent dark:text-gray-200 dark:hover:bg-white/10';

/** "Connect to cluster…": sign in over SSH, browse the shared folders, open files by reference. */
export function ConnectClusterDialog() {
  const { prefill, waiter, close } = useConnectClusterStore();
  const [sources, setSources] = useState<RemoteSourceInfo[]>([]);
  const [host, setHost] = useState(prefill?.host ?? '');
  const [user, setUser] = useState(prefill?.user ?? '');
  const [folders, setFolders] = useState((prefill?.folders?.length ? prefill.folders : ['~']).join('\n'));
  const [remotePython, setRemotePython] = useState('');
  const [openTerminal, setOpenTerminal] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseTarget, setBrowseTarget] = useState<string | null>(null);
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [filter, setFilter] = useState<Filter>('data');
  const [selected, setSelected] = useState<Record<string, RemoteEntry>>({});
  const [openStatus, setOpenStatus] = useState<string | null>(null);
  const [closeMaster, setCloseMaster] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'ssh' | 's3'>('ssh');
  const [s3Location, setS3Location] = useState('s3://');
  const [s3Profile, setS3Profile] = useState('');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const probeCount = useRef(0);

  const ssh = sources.find(s => s.scheme === 'ssh');
  const s3 = sources.find(s => s.scheme === 's3');
  const connections = ssh?.connections ?? [];
  const browsing = connections.find(c => c.target === browseTarget && c.state === 'connected') ?? null;
  // Files are listed: Open is the next step (and the one primary button).
  const filesShown = (mode === 'ssh' && browsing !== null) || (mode === 's3' && listing !== null);

  const refresh = useCallback(async () => {
    probeCount.current += 1;
    try {
      const result = await getRemoteSources(probeCount.current % 3 === 1);
      setSources(result.sources);
    } catch (err) {
      setError(messageFromError(err, 'Could not reach the server'));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [close]);

  // Pick up a new connection to browse; a restore waiting on this host and
  // account continues once a connection that serves them is up.
  useEffect(() => {
    const connected = connections.filter(c => c.state === 'connected');
    if (!browseTarget && connected.length > 0) {
      const wanted = connected.find(c => connectionServes(c, prefill?.host || host, prefill ? prefill.user : user))
        ?? connected.find(c => c.host === (prefill?.host || host)) ?? connected[0];
      setBrowseTarget(wanted.target);
    }
    if (waiter && prefill?.host && connected.some(c => connectionServes(c, prefill.host, prefill.user))) close(true);
  }, [connections, browseTarget, prefill, host, user, waiter, close]);

  const loadFolder = useCallback(async (ref: string) => {
    setListing(prev => ({ ...(prev ?? { success: true }), success: true, ref, entries: prev?.ref === ref ? prev.entries : [] }));
    try {
      const result = await listRemote(ref);
      setListing({ ...result, ref: result.ref ?? ref });
      setSelected({});
    } catch (err) {
      setListing({ success: false, ref, error: messageFromError(err, 'Could not list the folder') });
    }
  }, []);

  useEffect(() => {
    if (mode === 'ssh' && browsing && (!listing || !listing.ref?.startsWith(browsing.ref_prefix + '/'))) {
      const root = browsing.roots[0];
      if (root) void loadFolder(refForFolder(browsing, root));
    }
  }, [mode, browsing, listing, loadFolder]);

  const browseS3 = async () => {
    let location = s3Location.trim();
    if (!/^s3:\/\/[^/]+/i.test(location)) {
      setError('Type a bucket as s3://bucket/ or s3://bucket/folder/');
      return;
    }
    if (!location.endsWith('/')) location += '/';
    setBusy(true);
    setError(null);
    try {
      const result = await connectRemote({ source: 's3', profile: s3Profile.trim() || undefined,
        endpoint_url: s3Endpoint.trim() || undefined });
      if (!result.success) setError(result.error || 'S3 is not available');
      else await loadFolder(location);
    } catch (err) {
      setError(messageFromError(err, 'Could not reach S3'));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: 'ssh' | 's3') => {
    if (next === mode) return;
    setMode(next);
    setListing(null);
    setSelected({});
    setError(null);
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectRemote({
        host: host.trim(),
        user: user.trim() || undefined,
        roots: folders.split(/\n|,/).map(f => f.trim()).filter(Boolean),
        remote_python: remotePython.trim() || undefined,
        open_terminal: openTerminal,
      });
      if (!result.success) setError(result.error || 'Could not connect');
      else if (result.connection) setBrowseTarget(null);
      await refresh();
    } catch (err) {
      setError(messageFromError(err, 'Could not connect'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (connection: RemoteConnection) => {
    await disconnectRemote(connection.target, closeMaster).catch(() => null);
    if (browseTarget === connection.target) {
      setBrowseTarget(null);
      setListing(null);
    }
    await refresh();
  };

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard not available: the command is selectable */ }
  };

  const visibleEntries = useMemo(() => {
    const kinds = FILTERS.find(f => f.id === filter)?.kinds;
    return (listing?.entries ?? []).filter(e => e.type === 'dir' || !kinds || kinds.includes(e.kind));
  }, [listing, filter]);

  const selection = Object.values(selected);
  const plan = planClusterOpen(selection);
  const missingIndex = selection.filter(e => (e.kind === 'bam' || e.kind === 'fasta') && !e.has_index);

  const openSelected = async () => {
    setOpenStatus('Opening…');
    try {
      const result = await openClusterFiles(selection);
      setOpenStatus(result.errors.length ? result.errors.join('\n') : `Opened ${result.opened} item${result.opened === 1 ? '' : 's'}.`);
      if (!result.errors.length) setSelected({});
    } catch (err) {
      setOpenStatus(messageFromError(err, 'Could not open the files'));
    }
  };

  const toggle = (entry: RemoteEntry) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[entry.ref]) delete next[entry.ref];
      else next[entry.ref] = entry;
      return next;
    });
  };

  const hosts = ssh?.hosts ?? [];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => close(false)}>
      <div className="absolute inset-0 bg-brand-950/45 backdrop-blur-[2px]" />
      <div
        role="dialog"
        aria-label="Connect to cluster"
        data-testid="connect-cluster-dialog"
        className="relative mx-4 flex max-h-[90vh] w-full max-w-4xl flex-col rounded-apple-lg border border-line/70 bg-white shadow-modal dark:border-white/10 dark:bg-dark-surface dark:shadow-modal-dark"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-100">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-fb bg-brand-50 text-brand-700 ring-1 ring-brand-100 dark:bg-brand-400/15 dark:text-brand-300 dark:ring-brand-400/20" aria-hidden="true"><Server size={15} /></span>
            Connect to cluster
          </h2>
          <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
            {prefill?.reason ?? 'Open BAM, BigBed, FASTA and plasmid-map files that live on a cluster, without copying them. FiberBrowser signs in with your own ssh (keys, ~/.ssh/config, Duo) and reads only the byte ranges it needs.'}
          </p>
          <div className="mt-2 inline-flex rounded border border-gray-200 text-[12px] dark:border-white/15" role="tablist">
            {([['ssh', 'Cluster (SSH)'], ['s3', 'S3 bucket']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={mode === id}
                data-testid={`connect-source-${id}`}
                onClick={() => switchMode(id)}
                className={`px-2 py-0.5 ${mode === id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'}`}>
                {label}
              </button>
            ))}
          </div>
          {mode === 'ssh' && ssh && !ssh.available && (
            <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{ssh.problem}</p>
          )}
          {mode === 's3' && s3 && !s3.available && (
            <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{s3.problem}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {mode === 's3' && (
            <div className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[2fr_1fr_1fr]">
              <label className="text-[12px] text-gray-600 dark:text-gray-300">
                Bucket and folder
                <input value={s3Location} onChange={e => setS3Location(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void browseS3(); }}
                  placeholder="s3://bucket/folder/" data-testid="connect-s3-location"
                  className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200" />
              </label>
              <label className="text-[12px] text-gray-600 dark:text-gray-300">
                AWS profile <span className="text-gray-400">(optional)</span>
                <input value={s3Profile} onChange={e => setS3Profile(e.target.value)} placeholder="default"
                  className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200" />
              </label>
              <label className="text-[12px] text-gray-600 dark:text-gray-300">
                Endpoint <span className="text-gray-400">(S3-compatible)</span>
                <input value={s3Endpoint} onChange={e => setS3Endpoint(e.target.value)} placeholder="https://…"
                  className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200" />
              </label>
              <div className="flex items-center gap-2 sm:col-span-3">
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  Uses your AWS credentials (profile, environment or instance role); public buckets need none.
                </span>
                <button type="button" onClick={browseS3} disabled={busy || s3?.available === false}
                  data-testid="connect-s3-browse"
                  className={`ml-auto ${filesShown ? SECONDARY_BUTTON : PRIMARY_BUTTON}`}>
                  {busy ? 'Opening…' : 'Browse'}
                </button>
              </div>
              {error && <p className="text-[12px] text-red-600 dark:text-red-400 sm:col-span-3">{error}</p>}
            </div>
          )}

          {/* Sign in */}
          {mode === 'ssh' && (
          <div className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_1fr]">
            <label className="text-[12px] text-gray-600 dark:text-gray-300">
              Host
              <input
                list="fb-ssh-hosts"
                value={host}
                onChange={e => setHost(e.target.value)}
                placeholder="mycluster (a Host from ~/.ssh/config) or login.cluster.example.edu"
                data-testid="connect-cluster-host"
                className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200"
              />
              <datalist id="fb-ssh-hosts">
                {hosts.map(h => <option key={h.alias} value={h.alias}>{h.hostname ?? ''}</option>)}
              </datalist>
            </label>
            <label className="text-[12px] text-gray-600 dark:text-gray-300">
              User <span className="text-gray-400">(optional)</span>
              <input
                value={user}
                onChange={e => setUser(e.target.value)}
                placeholder="your cluster user name, if not in ~/.ssh/config"
                className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200"
              />
            </label>
            <label className="text-[12px] text-gray-600 dark:text-gray-300 sm:col-span-2">
              Folders to share (one per line; FiberBrowser can read nothing outside them)
              <textarea
                value={folders}
                onChange={e => setFolders(e.target.value)}
                rows={2}
                placeholder={'~\n/projects/MYLAB'}
                data-testid="connect-cluster-folders"
                className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <label className="flex items-center gap-1 text-[12px] text-gray-600 dark:text-gray-300">
                <input type="checkbox" checked={openTerminal} onChange={e => setOpenTerminal(e.target.checked)} />
                Open a terminal window if a password or Duo is needed
              </label>
              <button type="button" className="text-[12px] text-blue-600 hover:underline dark:text-blue-300"
                onClick={() => setShowAdvanced(v => !v)}>
                {showAdvanced ? 'Hide advanced' : 'Advanced…'}
              </button>
              <button
                type="button"
                onClick={connect}
                disabled={busy || !host.trim() || ssh?.available === false}
                data-testid="connect-cluster-connect"
                data-primary={filesShown ? 'false' : 'true'}
                className={`ml-auto ${filesShown ? SECONDARY_BUTTON : PRIMARY_BUTTON}`}
              >
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
            {showAdvanced && (
              <label className="text-[12px] text-gray-600 dark:text-gray-300 sm:col-span-2">
                Remote Python (only if python3 on the cluster is missing or older than 3.6)
                <input
                  value={remotePython}
                  onChange={e => setRemotePython(e.target.value)}
                  placeholder="/usr/bin/python3"
                  className="mt-0.5 w-full rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[12px] dark:border-white/15 dark:bg-gray-900 dark:text-gray-200"
                />
              </label>
            )}
            {error && <p className="text-[12px] text-red-600 dark:text-red-400 sm:col-span-2">{error}</p>}
          </div>
          )}

          {/* Connections */}
          {mode === 'ssh' && connections.length > 0 && (
            <div className="border-t border-gray-100 px-4 py-2 dark:border-white/5">
              {connections.map(connection => (
                <ConnectionRow
                  key={connection.target}
                  connection={connection}
                  active={connection.target === browseTarget}
                  onBrowse={() => { setBrowseTarget(connection.target); setListing(null); }}
                  onDisconnect={() => disconnect(connection)}
                  onCopy={copyCommand}
                  copied={copied}
                />
              ))}
              <label className="mt-1 flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                <input type="checkbox" checked={closeMaster} onChange={e => setCloseMaster(e.target.checked)} />
                Disconnect also closes the SSH sign-in (otherwise it stays open ~30 min, so reconnecting needs no Duo)
              </label>
            </div>
          )}

          {/* File browser */}
          {((mode === 'ssh' && browsing) || (mode === 's3' && listing)) && (
            <div className="border-t border-gray-200 px-4 py-2 dark:border-white/10" data-testid="connect-cluster-browser">
              <div className="flex flex-wrap items-center gap-1">
                {mode === 'ssh' && browsing && browsing.roots.map(root => (
                  <button key={root} type="button"
                    onClick={() => loadFolder(refForFolder(browsing, root))}
                    className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/5">
                    {root === browsing.home ? '~' : root}
                  </button>
                ))}
                <button type="button" disabled={!listing?.parent_ref}
                  onClick={() => listing?.parent_ref && loadFolder(listing.parent_ref)}
                  className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-white/15 dark:text-gray-300">
                  Up
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400" title={listing?.path}>
                  {mode === 's3' ? listing?.ref : `${browsing?.target}:${listing?.path ?? (listing?.ref ? pathOfRef(listing.ref) : '')}`}
                </span>
                {FILTERS.map(f => (
                  <button key={f.id} type="button" onClick={() => setFilter(f.id)}
                    className={`rounded px-1.5 py-0.5 text-[11px] ${filter === f.id ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              {listing && !listing.success && (
                <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{listing.error}</p>
              )}
              <div className="mt-1 max-h-[38vh] divide-y divide-gray-100 overflow-y-auto rounded border border-gray-100 dark:divide-white/5 dark:border-white/10">
                {visibleEntries.length === 0 && listing?.success && (
                  <div className="px-2 py-2 text-[12px] text-gray-400">No matching files here.</div>
                )}
                {visibleEntries.map(entry => (
                  <div key={entry.ref} className="flex items-center gap-2 px-2 py-1 text-[12px]" data-testid="connect-cluster-entry">
                    {entry.type === 'dir' ? (
                      <button type="button" onClick={() => loadFolder(entry.ref)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-gray-700 hover:text-blue-600 dark:text-gray-200">
                        <span className="flex w-4 justify-center text-brand-500/80 dark:text-brand-300/80" aria-hidden="true"><Folder size={13} /></span>
                        <span className="truncate font-medium" title={`${entry.name}/`}>{entry.name}/</span>
                      </button>
                    ) : (
                      <label className={`flex min-w-0 flex-1 items-center gap-2 ${entry.openable ? 'cursor-pointer' : 'opacity-60'}`}>
                        <input type="checkbox" disabled={!entry.openable} checked={Boolean(selected[entry.ref])} onChange={() => toggle(entry)} />
                        <span className="truncate text-gray-700 dark:text-gray-200" title={entry.name}>{entry.name}</span>
                        {KIND_LABEL[entry.kind] && (
                          <span className="flex-shrink-0 rounded bg-gray-100 px-1 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">{KIND_LABEL[entry.kind]}</span>
                        )}
                        {(entry.kind === 'bam' || entry.kind === 'fasta') && (
                          <span className={`flex-shrink-0 rounded px-1 text-[11px] ${entry.has_index ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'}`}>
                            {entry.has_index ? 'indexed' : 'no index'}
                          </span>
                        )}
                      </label>
                    )}
                    <span className="w-16 flex-shrink-0 text-right text-[11px] text-gray-400">{formatBytes(entry.size)}</span>
                  </div>
                ))}
              </div>
              {listing?.truncated && <p className="mt-1 text-[11px] text-amber-600" data-testid="connect-cluster-truncated">{truncationNote(listing)}</p>}
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                {mode === 's3' && 'FASTA files on S3 cannot be opened by range here; download them. '}
                Reads come over the network by range: loci and amplicons open quickly; chromosome-wide and genome-wide views
                (coverage of a whole chromosome, best-covered windows) transfer much more and are slower than local files.
                Footprint-class runs need local copies.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-gray-200 px-4 py-3 dark:border-white/10">
          <span className="min-w-0 flex-1 whitespace-pre-line text-[12px] text-gray-500 dark:text-gray-400">
            {openStatus ?? (missingIndex.length > 0
              ? `${missingIndex.map(e => e.name).join(', ')} ha${missingIndex.length === 1 ? 's' : 've'} no index: run samtools index / samtools faidx on the cluster first.`
              : selection.length > 0
                ? [plan.fasta.length ? 'FASTA as the reference' : '', plan.plasmidDataset ? 'a plasmid map with its BAM(s)' : '',
                   plan.maps.length ? `${plan.maps.length} map(s)` : '', plan.bams.length ? `${plan.bams.length} BAM dataset(s)` : '',
                   plan.bigbeds.length ? `${plan.bigbeds.length} BigBed file(s)` : ''].filter(Boolean).join(', ')
                : '')}
          </span>
          <button type="button" onClick={() => close(false)}
            className="rounded px-3 py-1 text-[13px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">
            Close
          </button>
          <button
            type="button"
            onClick={openSelected}
            disabled={selection.length === 0 || missingIndex.length > 0}
            data-testid="connect-cluster-open"
            data-primary={filesShown ? 'true' : 'false'}
            className={filesShown ? PRIMARY_BUTTON : SECONDARY_BUTTON}
          >
            Open {selection.length > 0 ? selection.length : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConnectionRow({ connection, active, onBrowse, onDisconnect, onCopy, copied }: {
  connection: RemoteConnection;
  active: boolean;
  onBrowse: () => void;
  onDisconnect: () => void;
  onCopy: (command: string) => void;
  copied: boolean;
}) {
  const badge = {
    connected: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
    starting: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    authenticating: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    error: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    disconnected: 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400',
  }[connection.state];
  return (
    <div className="py-1.5" data-testid="connect-cluster-connection">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${badge}`}>{connection.state}</span>
        <span className="text-[13px] font-medium text-gray-700 dark:text-gray-200">{connection.target}</span>
        {connection.state === 'connected' && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {connection.remote_hostname ? `${connection.remote_hostname} · ` : ''}
            {connection.latency_ms != null ? `${connection.latency_ms} ms round trip` : ''}
            {connection.rate_bps != null && connection.rate_bps > 0 ? ` · ${formatBytes(connection.rate_bps)}/s` : ''}
            {connection.bytes_served ? ` · ${formatBytes(connection.bytes_served)} read` : ''}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          {connection.state === 'connected' && !active && (
            <button type="button" onClick={onBrowse}
              className="rounded border border-gray-200 px-2 py-0.5 text-[12px] text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-gray-300">
              Browse
            </button>
          )}
          <button type="button" onClick={onDisconnect} data-testid="connect-cluster-disconnect"
            className="rounded border border-gray-200 px-2 py-0.5 text-[12px] text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-gray-300">
            {connection.state === 'connected' ? 'Disconnect' : 'Cancel'}
          </button>
        </span>
      </div>
      {connection.state !== 'connected' && (
        <div className="mt-0.5 text-[12px] text-gray-600 dark:text-gray-300">{connection.error ?? connection.message}</div>
      )}
      {connection.missing_roots?.length > 0 && connection.state === 'connected' && (
        <div className="mt-0.5 text-[11px] text-amber-600">Not found on the cluster: {connection.missing_roots.join(', ')}</div>
      )}
      {connection.auth_command && (
        <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-500/30 dark:bg-amber-950/20">
          <div className="text-[11px] text-amber-800 dark:text-amber-200">
            {connection.terminal_opened
              ? 'A terminal window is asking for your password / Duo. If it did not appear, run this in any terminal:'
              : 'Run this in a terminal and answer the password / Duo prompts; FiberBrowser continues by itself:'}
          </div>
          <div className="mt-1 flex items-start gap-1">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] text-gray-700 dark:text-gray-200">{connection.auth_command}</code>
            <button type="button" onClick={() => onCopy(connection.auth_command!)}
              className="flex-shrink-0 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-white dark:border-white/15 dark:text-gray-300">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Mounted once (local servers): shows the dialog whenever something asks for it. */
export function ConnectClusterHost() {
  const open = useConnectClusterStore(s => s.open);
  return open ? <ConnectClusterDialog /> : null;
}
