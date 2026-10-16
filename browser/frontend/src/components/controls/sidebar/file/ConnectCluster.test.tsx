import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
  getRemoteSources: vi.fn(),
  connectRemote: vi.fn(),
  disconnectRemote: vi.fn(),
  listRemote: vi.fn(),
  remoteRefsStatus: vi.fn(),
  isClusterRef: (p: unknown) => typeof p === 'string' && p.startsWith('ssh://'),
}));
vi.mock('../../../../api/remote', () => remote);

const opener = vi.hoisted(() => ({ openClusterFiles: vi.fn() }));
vi.mock('../../../../utils/clusterOpen', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../utils/clusterOpen')>()),
  openClusterFiles: opener.openClusterFiles,
}));

const sessionApi = vi.hoisted(() => ({ checkSessionFiles: vi.fn(), importSession: vi.fn() }));
vi.mock('../../../../api/session', () => sessionApi);

import { ConnectClusterHost, truncationNote } from './ConnectClusterDialog';
import { CLUSTER_NOT_CONNECTED, SessionRestoreHost } from './SessionRestoreHost';
import { requestSessionRestore } from '../../../../utils/sessionRestore';
import { connectionServes, ensureClusterRefsConnected, openConnectCluster, useConnectClusterStore } from '../../../../utils/connectCluster';
import { planClusterOpen } from '../../../../utils/clusterOpen';
import type { RemoteConnection, RemoteEntry } from '../../../../api/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connected: RemoteConnection = {
  source: 'ssh', target: 'hpc', host: 'hpc', user: null, state: 'connected', message: 'Connected to hpc.',
  error: null, auth_command: null, terminal_opened: false, roots: ['/projects/lab'], missing_roots: [],
  home: '/home/me', remote_hostname: 'hpc8', python: '3.9.18', shared_master: false, own_master: true,
  latency_ms: 42.5, rate_bps: 2_500_000, bytes_served: 10_000_000, ref_prefix: 'ssh://hpc',
};

function entry(name: string, kind: RemoteEntry['kind'], extra: Partial<RemoteEntry> = {}): RemoteEntry {
  return { name, type: 'file', size: 1000, mtime: 0, ref: `ssh://hpc/projects/lab/${name}`, kind,
    openable: ['bam', 'bigbed', 'fasta', 'map'].includes(kind), ...extra };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

describe('planClusterOpen', () => {
  it('opens one map with its BAMs as a plasmid dataset, the FASTA first', () => {
    const plan = planClusterOpen([entry('p.gb', 'map'), entry('a.bam', 'bam'), entry('b.bam', 'bam'),
      entry('ref.fa', 'fasta'), entry('fp.bb', 'bigbed'), entry('x.bai', 'index')]);
    expect(plan.fasta).toEqual(['ssh://hpc/projects/lab/ref.fa']);
    expect(plan.plasmidDataset).toEqual({ map: 'ssh://hpc/projects/lab/p.gb',
      bams: ['ssh://hpc/projects/lab/a.bam', 'ssh://hpc/projects/lab/b.bam'] });
    expect(plan.bams).toEqual([]);
    expect(plan.bigbeds).toEqual(['ssh://hpc/projects/lab/fp.bb']);
  });

  it('loads several maps and the BAMs separately', () => {
    const plan = planClusterOpen([entry('p.gb', 'map'), entry('q.gb', 'map'), entry('a.bam', 'bam')]);
    expect(plan.plasmidDataset).toBeNull();
    expect(plan.maps).toHaveLength(2);
    expect(plan.bams).toHaveLength(1);
  });
});

describe('Connect to cluster dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(remote).forEach(fn => (fn as any).mockReset?.());
    opener.openClusterFiles.mockReset().mockResolvedValue({ opened: 2, errors: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useConnectClusterStore.setState({ open: false, prefill: null, waiter: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('connects with the typed host and folders', async () => {
    remote.getRemoteSources.mockResolvedValue({ sources: [{ scheme: 'ssh', label: 'Cluster (SSH)', available: true,
      problem: null, hosts: [{ alias: 'hpc', hostname: 'login.hpc.example.edu' }], connections: [] }] });
    remote.connectRemote.mockResolvedValue({ success: true, connection: { ...connected, state: 'starting' } });
    act(() => root.render(<ConnectClusterHost />));
    act(() => openConnectCluster());
    await flush();
    const dialog = document.querySelector('[data-testid="connect-cluster-dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('datalist option')?.getAttribute('value')).toBe('hpc');

    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setValue(dialog.querySelector('[data-testid="connect-cluster-host"]') as HTMLInputElement, 'hpc');
      setValue(dialog.querySelector('[data-testid="connect-cluster-folders"]') as HTMLTextAreaElement, '~\n/projects/lab');
    });
    await act(async () => { (dialog.querySelector('[data-testid="connect-cluster-connect"]') as HTMLButtonElement).click(); });
    expect(remote.connectRemote).toHaveBeenCalledWith(expect.objectContaining({
      host: 'hpc', roots: ['~', '/projects/lab'], open_terminal: true }));
  });

  it('has one primary button at a time: Connect until files are listed, then Open (L16)', async () => {
    const isFilled = (el: Element | null) => (el?.getAttribute('class') ?? '').includes('bg-blue-600');
    remote.getRemoteSources.mockResolvedValue({ sources: [{ scheme: 'ssh', label: '', available: true, problem: null,
      hosts: [], connections: [] }] });
    act(() => root.render(<ConnectClusterHost />));
    act(() => openConnectCluster());
    await flush();
    const connect = () => document.querySelector('[data-testid="connect-cluster-connect"]');
    const open = () => document.querySelector('[data-testid="connect-cluster-open"]');
    expect(isFilled(connect())).toBe(true);
    expect(isFilled(open())).toBe(false);

    // Connected and browsing: Open is the next step, Connect steps back.
    remote.getRemoteSources.mockResolvedValue({ sources: [{ scheme: 'ssh', label: '', available: true, problem: null,
      hosts: [], connections: [connected] }] });
    remote.listRemote.mockResolvedValue({ success: true, path: '/projects/lab', ref: 'ssh://hpc/projects/lab',
      parent_ref: null, truncated: false, entries: [entry('a.bam', 'bam', { has_index: true })] });
    act(() => root.unmount());
    root = createRoot(container);
    useConnectClusterStore.setState({ open: false, prefill: null, waiter: null });
    act(() => root.render(<ConnectClusterHost />));
    act(() => openConnectCluster());
    await flush(10);
    expect(document.querySelector('[data-testid="connect-cluster-browser"]')).not.toBeNull();
    expect(isFilled(open())).toBe(true);
    expect(isFilled(connect())).toBe(false);
  });

  it('shows the sign-in command while waiting for Duo', async () => {
    remote.getRemoteSources.mockResolvedValue({ sources: [{ scheme: 'ssh', label: '', available: true, problem: null,
      hosts: [], connections: [{ ...connected, state: 'authenticating', message: 'Finish signing in',
        auth_command: 'ssh -M -S /x/cm -o ControlPersist=30m -N -f -- hpc', terminal_opened: true }] }] });
    act(() => root.render(<ConnectClusterHost />));
    act(() => openConnectCluster());
    await flush();
    const text = document.querySelector('[data-testid="connect-cluster-connection"]')!.textContent!;
    expect(text).toContain('authenticating');
    expect(text).toContain('ssh -M -S /x/cm');
    expect(text).toContain('password / Duo');
  });

  it('browses a connected host, shows index presence and opens the selection', async () => {
    remote.getRemoteSources.mockResolvedValue({ sources: [{ scheme: 'ssh', label: '', available: true, problem: null,
      hosts: [], connections: [connected] }] });
    remote.listRemote.mockResolvedValue({ success: true, path: '/projects/lab', ref: 'ssh://hpc/projects/lab',
      parent_ref: null, truncated: false, entries: [
        { name: 'runs', type: 'dir', size: null, mtime: 0, ref: 'ssh://hpc/projects/lab/runs', kind: 'dir' },
        entry('a.bam', 'bam', { has_index: true }), entry('b.bam', 'bam', { has_index: false }),
        entry('a.bam.bai', 'index'), entry('p.gb', 'map')] });
    act(() => root.render(<ConnectClusterHost />));
    act(() => openConnectCluster());
    await flush(10);
    expect(remote.listRemote).toHaveBeenCalledWith('ssh://hpc/projects/lab');
    const connection = document.querySelector('[data-testid="connect-cluster-connection"]')!.textContent!;
    expect(connection).toContain('42.5 ms');
    const rows = Array.from(document.querySelectorAll('[data-testid="connect-cluster-entry"]'));
    // BAM / BigBed filter: folders and BAMs (not the map or the index).
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('runs/'), expect.stringContaining('indexed'), expect.stringContaining('no index')]);
    const openButton = document.querySelector('[data-testid="connect-cluster-open"]') as HTMLButtonElement;
    expect(openButton.disabled).toBe(true);
    await act(async () => { (rows[1].querySelector('input') as HTMLInputElement).click(); });
    expect(openButton.disabled).toBe(false);
    await act(async () => { (rows[2].querySelector('input') as HTMLInputElement).click(); });
    expect(openButton.disabled).toBe(true);  // b.bam has no index
    expect(document.body.textContent).toContain('samtools index');
    await act(async () => { (rows[2].querySelector('input') as HTMLInputElement).click(); });
    await act(async () => { openButton.click(); });
    await flush();
    expect(opener.openClusterFiles).toHaveBeenCalledWith([expect.objectContaining({ ref: 'ssh://hpc/projects/lab/a.bam' })]);
    expect(document.body.textContent).toContain('Opened 2 items');
  });

  it('a session restore waits for the host and continues once it is connected', async () => {
    remote.remoteRefsStatus.mockResolvedValue({ refs: [], disconnected: 1, targets: [{ source: 'ssh', target: 'hpc',
      host: 'hpc', user: null, connected: false, folders: ['/projects/lab'], refs: 2 }] });
    let state: RemoteConnection[] = [];
    remote.getRemoteSources.mockImplementation(async () => ({ sources: [{ scheme: 'ssh', label: '', available: true,
      problem: null, hosts: [], connections: state }] }));
    remote.listRemote.mockResolvedValue({ success: true, ref: 'ssh://hpc/projects/lab', entries: [] });
    act(() => root.render(<ConnectClusterHost />));
    let resolved: boolean | null = null;
    const pending = ensureClusterRefsConnected(['ssh://hpc/projects/lab/a.bam', '/local/b.bam'], 'This session')
      .then(value => { resolved = value; });
    await flush();
    const dialog = document.querySelector('[data-testid="connect-cluster-dialog"]')!;
    expect(dialog.textContent).toContain('This session: 2 files on hpc. Connect to open them.');
    expect((dialog.querySelector('[data-testid="connect-cluster-host"]') as HTMLInputElement).value).toBe('hpc');
    expect((dialog.querySelector('[data-testid="connect-cluster-folders"]') as HTMLTextAreaElement).value).toBe('/projects/lab');
    expect(resolved).toBeNull();
    state = [connected];
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    await flush();
    await pending;
    expect(resolved).toBe(true);
    expect(document.querySelector('[data-testid="connect-cluster-dialog"]')).toBeNull();
  });

  it('a restore for alice@hpc waits for a connection that signs in as alice', async () => {
    remote.remoteRefsStatus.mockResolvedValue({ refs: [], disconnected: 1, targets: [{ source: 'ssh', target: 'alice@hpc',
      host: 'hpc', user: 'alice', connected: false, folders: ['/projects/lab'], refs: 1 }] });
    // A user-less connection whose account is unknown is not alice's.
    let state: RemoteConnection[] = [{ ...connected, default_user: null }];
    remote.getRemoteSources.mockImplementation(async () => ({ sources: [{ scheme: 'ssh', label: '', available: true,
      problem: null, hosts: [], connections: state }] }));
    remote.listRemote.mockResolvedValue({ success: true, ref: 'ssh://hpc/projects/lab', entries: [] });
    act(() => root.render(<ConnectClusterHost />));
    let resolved: boolean | null = null;
    const pending = ensureClusterRefsConnected(['ssh://alice@hpc/projects/lab/a.bam'], 'This session')
      .then(value => { resolved = value; });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    await flush();
    expect(resolved).toBeNull();
    expect(document.querySelector('[data-testid="connect-cluster-dialog"]')).not.toBeNull();
    state = [{ ...connected, target: 'alice@hpc', user: 'alice', ref_prefix: 'ssh://alice@hpc' }];
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    await flush();
    await pending;
    expect(resolved).toBe(true);
  });

  it('closing the connect dialog cancels a session restore and keeps the current state', async () => {
    sessionApi.checkSessionFiles.mockResolvedValue({ missing: 0, changed: 0, files: [],
      remote: { refs: [{ ref: 'ssh://hpc/projects/lab/a.bam', source: 'ssh', target: 'hpc', connected: false }],
        targets: [], disconnected: 1 } });
    sessionApi.importSession.mockResolvedValue({ success: true, results: {} });
    remote.remoteRefsStatus.mockResolvedValue({ refs: [], disconnected: 1, targets: [{ source: 'ssh', target: 'hpc',
      host: 'hpc', user: null, connected: false, folders: ['/projects/lab'], refs: 1 }] });
    remote.getRemoteSources.mockResolvedValue({ sources: [{ scheme: 'ssh', label: '', available: true,
      problem: null, hosts: [], connections: [] }] });
    act(() => root.render(<><SessionRestoreHost /><ConnectClusterHost /></>));
    await flush();
    const outcome = requestSessionRestore({ viewport: {}, datasets: [{ paths: ['ssh://hpc/projects/lab/a.bam'] }] });
    await flush();
    expect(document.querySelector('[data-testid="connect-cluster-dialog"]')).not.toBeNull();
    await act(async () => { useConnectClusterStore.getState().close(false); });
    await expect(outcome).resolves.toEqual({ restored: false, message: CLUSTER_NOT_CONNECTED });
    expect(sessionApi.importSession).not.toHaveBeenCalled();
  });

  it('browses an S3 bucket with the same file list', async () => {
    remote.getRemoteSources.mockResolvedValue({ sources: [
      { scheme: 'ssh', label: '', available: true, problem: null, hosts: [], connections: [] },
      { scheme: 's3', label: 'S3 bucket', available: true, problem: null, connections: [] }] });
    remote.connectRemote.mockResolvedValue({ success: true, connection: { source: 's3', state: 'connected' } });
    remote.listRemote.mockResolvedValue({ success: true, path: '/runs/', ref: 's3://lab-data/runs/', parent_ref: 's3://lab-data/',
      entries: [{ ...entry('a.bam', 'bam', { has_index: true }), ref: 's3://lab-data/runs/a.bam' }] });
    act(() => root.render(<ConnectClusterHost />));
    act(() => openConnectCluster());
    await flush();
    await act(async () => { (document.querySelector('[data-testid="connect-source-s3"]') as HTMLButtonElement).click(); });
    const input = document.querySelector('[data-testid="connect-s3-location"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 's3://lab-data/runs');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('[data-testid="connect-s3-browse"]') as HTMLButtonElement).click(); });
    await flush();
    expect(remote.connectRemote).toHaveBeenCalledWith(expect.objectContaining({ source: 's3' }));
    expect(remote.listRemote).toHaveBeenCalledWith('s3://lab-data/runs/');
    const rows = document.querySelectorAll('[data-testid="connect-cluster-entry"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('a.bam');
  });

  it('a lab server page offers no Connect to cluster', async () => {
    (window as any).__FIBERBROWSER_LAB__ = { user: 'ann', role: 'member', auth: 'accounts', anonymous: false, jobs: false };
    try {
      const { ConnectClusterSettings } = await import('./ConnectClusterSettings');
      act(() => root.render(<><ConnectClusterSettings publicMode={false} /><ConnectClusterHost /></>));
      act(() => openConnectCluster());
      await flush();
      expect(document.querySelector('[data-testid="connect-cluster-button"]')).toBeNull();
      await expect(ensureClusterRefsConnected(['ssh://hpc/x.bam'])).resolves.toBe(true);
      expect(remote.remoteRefsStatus).not.toHaveBeenCalled();
    } finally {
      delete (window as any).__FIBERBROWSER_LAB__;
    }
  });

  it('nothing to connect for local-only sessions', async () => {
    await expect(ensureClusterRefsConnected(['/local/a.bam'])).resolves.toBe(true);
    expect(remote.remoteRefsStatus).not.toHaveBeenCalled();
  });
});

describe('connectionServes', () => {
  const hpc = { host: 'hpc', target: 'hpc', user: null as string | null };
  it('matches the exact target', () => {
    expect(connectionServes(hpc, 'hpc', null)).toBe(true);
    expect(connectionServes({ ...hpc, target: 'alice@hpc', user: 'alice' }, 'hpc', 'alice')).toBe(true);
  });
  it('another spelling only when ssh -G says it is the same account', () => {
    expect(connectionServes(hpc, 'hpc', 'alice')).toBe(false);
    expect(connectionServes({ ...hpc, default_user: 'bob' }, 'hpc', 'alice')).toBe(false);
    expect(connectionServes({ ...hpc, default_user: 'alice' }, 'hpc', 'alice')).toBe(true);
    expect(connectionServes({ ...hpc, target: 'bob@hpc', user: 'bob' }, 'hpc', null)).toBe(false);
    expect(connectionServes({ ...hpc, target: 'bob@hpc', user: 'bob', default_user: 'bob' }, 'hpc', null)).toBe(true);
    expect(connectionServes(hpc, 'other', null)).toBe(false);
  });
});

describe('truncationNote', () => {
  it('says why a listing is partial', () => {
    expect(truncationNote({ entries: new Array(5000), truncated_reason: 'limit', limit: 5000 }))
      .toBe('Only the first 5,000 entries are shown.');
    expect(truncationNote({ entries: new Array(12), truncated_reason: 'scan', scanned: 50000 }))
      .toContain('only the first 50,000 entries were read, and 12 of them are shown');
    expect(truncationNote({ entries: new Array(3), truncated_reason: 'time' })).toContain('took too long');
  });
});
