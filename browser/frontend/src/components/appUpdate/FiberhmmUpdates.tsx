import { useEffect, useState } from 'react';
import { getAppInfo, type FiberhmmSelection } from '../../api/appUpdate';
import { useAppUpdateStore } from './appUpdateStore';
import { useFiberhmmUpdateStore } from './fiberhmmUpdateStore';

/** Shared by Settings and the software update dialog. Quiet check failures stay silent. */
export function FiberhmmUpdates({ selection }: { selection?: FiberhmmSelection }) {
  const check = useAppUpdateStore(s => s.check?.fiberhmm);
  const { job, error, restartBusy, load, install, revert, restart } = useFiberhmmUpdateStore();
  const [latestSelection, setLatestSelection] = useState<FiberhmmSelection>();
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let alive = true;
    if (!selection || job.state === 'ready') {
      void getAppInfo().then(info => { if (alive) setLatestSelection(info.fiberhmm); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [selection, job.state, job.version, job.message]);
  const fh = latestSelection ?? selection;
  const overridden = check?.blocked || fh?.requested.source === 'env' || fh?.app_choice?.source === 'custom';
  const active = fh?.source === 'updated';
  const pending = fh?.app_choice?.source === 'updated';
  const pipCommand = check?.pip_command ?? fh?.pip_command;
  const busy = job.state === 'installing' || restartBusy || job.state === 'restarting';
  return (
    <div className="space-y-1 rounded border border-gray-200 px-2 py-2 text-[12px] dark:border-white/10" data-testid="fiberhmm-updates">
      {fh && <p>FiberHMM in use: {active ? `updated ${fh.version}` : `${fh.bundled.kind === 'bundled' && fh.source === 'bundled' ? 'bundled ' : ''}${fh.running?.version ?? fh.version ?? '?'}`}</p>}
      {!selection && fh?.notices.map(notice => <p key={notice} role="status">{notice}</p>)}
      {check?.status === 'update_available' && <>
        <p>FiberHMM {check.latest} is available (in use: {check.current ?? '?'}).</p>
        {check.packaged ? (
          overridden ? <p>FIBERHMM_SOURCE_DIR or Custom path takes precedence. Select bundled FiberHMM to use updates.</p> :
          <button type="button" className="fb-btn-primary px-2 py-1" disabled={busy || job.state === 'ready'} onClick={() => void install()}>Update FiberHMM to {check.latest}</button>
        ) : <code className="block select-all">{check.pip_command}</code>}
      </>}
      {!fh?.packaged && pipCommand && check?.status !== 'update_available' && <code className="block select-all">{pipCommand}</code>}
      {(active || pending) && !overridden && <button type="button" className="fb-btn-secondary px-2 py-1" disabled={busy} onClick={() => void revert()}>Use bundled FiberHMM</button>}
      {job.state === 'installing' && <p role="status">Installing FiberHMM… Downloading and checking compatibility.</p>}
      {job.message && <p role={job.state === 'needs_app_update' || job.state === 'error' ? 'alert' : 'status'}>{job.message}</p>}
      {(job.state === 'ready' || job.state === 'restarting' || fh?.app_choice?.restart_needed) && !overridden &&
        <button type="button" className="fb-btn-primary px-2 py-1" disabled={restartBusy} onClick={() => void restart()}>{restartBusy ? 'Saving session and restarting…' : 'Restart FiberBrowser'}</button>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
