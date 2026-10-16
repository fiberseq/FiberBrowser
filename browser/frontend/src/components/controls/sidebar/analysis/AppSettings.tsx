import { useCallback, useEffect, useState } from 'react';
import {
  getAppInfo, removeGithubToken, saveGithubToken, setFiberhmmChoice, setUpdateSettings, type AppInfo,
} from '../../../../api/appUpdate';
import { openUpdateDialog, updatesAvailableHere } from '../../../appUpdate/appUpdateStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { SidebarSettingNote, SidebarSettingRow, SidebarSettingToggle } from '../shared/SidebarSetting';
import { defineSettings, inSidebar } from '../../../../utils/settingsCatalog';

const ownComputerOnly = () => (updatesAvailableHere() ? null : 'only in FiberBrowser on your own computer');

export const APP_SETTINGS = defineSettings({
  fiberhmm: {
    id: 'app.fiberhmm',
    label: 'FiberHMM',
    keywords: ['fiberhmm version', 'bundled', 'custom fiberhmm', 'source tree', 'engine', 'about'],
    location: inSidebar('analysis.app'),
    hiddenReason: ownComputerOnly,
  },
  fiberhmmPath: {
    id: 'app.fiberhmm-path',
    label: 'Custom path',
    keywords: ['fiberhmm source', 'fiberhmm folder', 'FIBERHMM_SOURCE_DIR'],
    location: inSidebar('analysis.app'),
    hiddenReason: ownComputerOnly,
  },
  updateAtStartup: {
    id: 'app.update-check-startup',
    label: 'Check for updates at startup',
    keywords: ['update', 'upgrade', 'new version', 'privacy', 'network'],
    location: inSidebar('analysis.app'),
    hiddenReason: ownComputerOnly,
  },
  updateManifest: {
    id: 'app.update-manifest',
    label: 'Update manifest',
    keywords: ['update url', 'update channel', 'lab builds', 'shared drive', 'dropbox', 'FIBERBROWSER_UPDATE_URL'],
    location: inSidebar('analysis.app'),
    hiddenReason: ownComputerOnly,
  },
  githubToken: {
    id: 'app.github-token',
    label: 'GitHub token',
    keywords: ['sign in', 'github', 'private releases', 'personal access token', 'gh auth login', 'keychain'],
    location: inSidebar('analysis.app'),
    hiddenReason: ownComputerOnly,
  },
});

const SOURCE_TEXT: Record<string, string> = {
  bundled: 'bundled with the app',
  installed: 'installed in FiberBrowser\'s Python',
  env: 'from FIBERHMM_SOURCE_DIR',
  app: 'custom (Settings)',
  settings: 'from browser_settings.json',
};

function authLine(info: AppInfo): { text: string; ok: boolean } {
  const auth = info.auth;
  if (!auth) return { text: '', ok: true };
  if (auth.gh.signed_in) return { text: 'Signed in to GitHub with the GitHub CLI (gh).', ok: true };
  if (auth.keychain.has_token) return { text: `A GitHub token is kept in the ${auth.keychain.name}.`, ok: true };
  return {
    text: `Sign in to check for ${info.updates.channel} updates: run gh auth login, or paste a read-only GitHub token below.`,
    ok: false,
  };
}

export function AppSettings() {
  if (!updatesAvailableHere()) return null;
  return (
    <SidebarSubSection
      id="analysis.app"
      label="FiberHMM & Updates"
      helpText="Which FiberHMM this FiberBrowser runs, and the update check"
      persist
    >
      <AppSettingsBody />
    </SidebarSubSection>
  );
}

/** The subsection's content: asks the server only while it is open. */
function AppSettingsBody() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [mode, setMode] = useState<'bundled' | 'custom'>('bundled');
  const [manifest, setManifest] = useState('');
  const [token, setToken] = useState('');

  const apply = useCallback((next: AppInfo) => {
    setInfo(next);
    setMode(next.fiberhmm.app_choice?.source ?? 'bundled');
    setCustomPath(next.fiberhmm.app_choice?.custom_path ?? '');
    setManifest(next.updates.manifest_url ?? '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAppInfo().then(next => { if (!cancelled) apply(next); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [apply]);

  const run = useCallback(async (action: () => Promise<AppInfo | null>, done?: string) => {
    setError(null);
    setMessage(null);
    try {
      const next = await action();
      if (next) apply(next);
      if (done) setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apply]);

  const fh = info?.fiberhmm;
  const auth = info ? authLine(info) : null;

  return (
    <div className="space-y-1.5">
      {!info && !error && <SidebarSettingNote>Loading…</SidebarSettingNote>}
      {info && fh && (
        <>
          <SidebarSettingRow
            setting={APP_SETTINGS.fiberhmm}
            helpText={fh.packaged
              ? 'The app runs the FiberHMM bundled with it. FIBERHMM_SOURCE_DIR, then a custom source tree chosen here, override it; one lacking what this build needs is not used.'
              : 'A source or pip run: FIBERHMM_SOURCE_DIR, then fiberhmm_source_dir in ~/.fiberhmm/browser_settings.json, then the installed fiberhmm package.'}
          >
            {fh.packaged ? (
              <select
                value={mode}
                onChange={e => {
                  const next = e.target.value as 'bundled' | 'custom';
                  setMode(next);
                  if (next === 'bundled') void run(() => setFiberhmmChoice('bundled'), 'Saved: the bundled FiberHMM, from the next start.');
                }}
                className="input-tool flex-1 text-xs"
                data-testid="app-fiberhmm-choice"
              >
                <option value="bundled">Bundled (default)</option>
                <option value="custom">Custom path…</option>
              </select>
            ) : (
              <span className="text-[11px] text-gray-500 dark:text-gray-400">source run</span>
            )}
          </SidebarSettingRow>
          {fh.packaged && mode === 'custom' && (
            <SidebarSettingRow setting={APP_SETTINGS.fiberhmmPath} helpText="A FiberHMM source tree (the folder holding fiberhmm/). Checked before it is used.">
              <input
                type="text"
                value={customPath}
                onChange={e => setCustomPath(e.target.value)}
                placeholder="/path/to/FiberHMM"
                className="input-tool flex-1 text-xs font-mono"
                data-testid="app-fiberhmm-path"
              />
              <button
                type="button"
                className="fb-btn-secondary px-2 py-0.5 text-[11px]"
                onClick={() => void run(async () => {
                  const next = await setFiberhmmChoice('custom', customPath);
                  const missing = next.checked?.missing ?? [];
                  if (missing.length) {
                    setError(`That FiberHMM lacks ${missing.join(', ')}; the app will keep using its bundled FiberHMM.`);
                  }
                  return next;
                }, 'Saved: takes effect when FiberBrowser restarts.')}
              >
                Use
              </button>
            </SidebarSettingRow>
          )}
          <div className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 dark:border-white/10 dark:text-gray-300" data-testid="app-fiberhmm-in-use">
            In use: FiberHMM {fh.running?.version ?? fh.version ?? '?'} · {SOURCE_TEXT[fh.source] ?? fh.source}
            <div className="truncate font-mono text-[10px] text-ink-secondary" title={fh.running?.path ?? fh.package_dir ?? ''}>
              {fh.running?.path ?? fh.package_dir}
            </div>
          </div>
          {fh.notices.map(notice => (
            <SidebarSettingNote key={notice} tone="amber">{notice}</SidebarSettingNote>
          ))}
          {fh.app_choice?.restart_needed && (
            <SidebarSettingNote tone="blue">The FiberHMM choice takes effect when FiberBrowser restarts.</SidebarSettingNote>
          )}
          {fh.requested.source === 'env' && (
            <SidebarSettingNote>FIBERHMM_SOURCE_DIR is set for this run; it wins over the choice above.</SidebarSettingNote>
          )}
          {!fh.packaged && (
            <SidebarSettingNote>FiberHMM updates: pip install -U fiberhmm (in FiberBrowser's Python).</SidebarSettingNote>
          )}

          <div className="pt-1" />
          <SidebarSettingToggle
            setting={APP_SETTINGS.updateAtStartup}
            checked={info.updates.check_at_startup}
            onChange={on => void run(() => setUpdateSettings({ check_at_startup: on }))}
            helpText={'A quiet check when FiberBrowser starts; it shows a note only when there is something to say. '
              + (info.updates.check_at_startup_set
                ? 'Set here for every FiberBrowser on this computer.'
                : info.packaged
                  ? 'On by default in the app.'
                  : 'Off by default when FiberBrowser runs from source or pip.')
              + ' Check for updates… works either way.'}
          />
          <div className="flex items-center gap-2">
            <button type="button" className="fb-btn-secondary px-2 py-0.5 text-[11px]" onClick={() => openUpdateDialog()}
              data-testid="app-check-updates">
              Check for updates…
            </button>
            <span className="truncate text-[10px] text-ink-secondary" title={info.updates.where}>
              {info.updates.channel} channel · {info.updates.where}
            </span>
          </div>
          <SidebarSettingRow
            setting={APP_SETTINGS.updateManifest}
            helpText="Where this channel's update manifest is, instead of its GitHub releases: an https:// address, or a file (a shared drive, a Dropbox-synced folder). FIBERBROWSER_UPDATE_URL overrides it."
          >
            <input
              type="text"
              value={manifest}
              onChange={e => setManifest(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              onBlur={() => {
                if (manifest.trim() !== (info.updates.manifest_url ?? '')) void run(() => setUpdateSettings({ manifest_url: manifest.trim() }), 'Saved.');
              }}
              placeholder="(the channel's GitHub releases)"
              className="input-tool flex-1 text-xs font-mono"
            />
          </SidebarSettingRow>
          {info.updates.private && auth && (
            <>
              <SidebarSettingNote tone={auth.ok ? 'gray' : 'amber'}>{auth.text}</SidebarSettingNote>
              <SidebarSettingRow
                setting={APP_SETTINGS.githubToken}
                helpText="A fine-grained, read-only token for the channel's repository (Contents: read). Kept in your OS keychain, never in a settings file."
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder={info.auth?.keychain.has_token ? '(saved in the keychain)' : 'github_pat_…'}
                  className="input-tool flex-1 text-xs font-mono"
                  disabled={!info.auth?.keychain.available}
                />
                <button
                  type="button"
                  className="fb-btn-secondary px-2 py-0.5 text-[11px]"
                  disabled={!token.trim()}
                  onClick={() => void run(async () => {
                    await saveGithubToken(token.trim());
                    setToken('');
                    return getAppInfo();
                  }, 'Token saved in the keychain.')}
                >
                  Save
                </button>
                {info.auth?.keychain.has_token && (
                  <button
                    type="button"
                    className="fb-btn-ghost px-2 py-0.5 text-[11px]"
                    onClick={() => void run(async () => { await removeGithubToken(); return getAppInfo(); }, 'Token removed.')}
                  >
                    Remove
                  </button>
                )}
              </SidebarSettingRow>
              {info.auth && !info.auth.keychain.available && info.auth.keychain.reason && (
                <SidebarSettingNote>{info.auth.keychain.reason}</SidebarSettingNote>
              )}
            </>
          )}
          {info.updates.disabled && <SidebarSettingNote>{info.updates.disabled}</SidebarSettingNote>}
          <SidebarSettingNote tone="slate">
            Privacy: a check is a plain request for the update manifest{info.updates.source === 'github' ? ' (and GitHub\'s release list)' : ''}; nothing about this computer or your data is sent. Updates are never installed by themselves: you open the downloaded, checksum-verified installer.
          </SidebarSettingNote>
        </>
      )}
      {message && <SidebarSettingNote tone="emerald">{message}</SidebarSettingNote>}
      {error && <SidebarSettingNote tone="rose">{error}</SidebarSettingNote>}
    </div>
  );
}
