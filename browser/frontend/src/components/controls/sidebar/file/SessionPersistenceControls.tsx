import { isPublicMode } from '../../../../utils/publicMode';
import { useState } from 'react';
import { downloadSession } from '../../../../api/session';
import { fetchApiResponse } from '../../../../api/sharedFetch';
import { useBrowserStore } from '../../../../stores/browserStore';
import { buildSessionManifest, formatSessionManifest } from '../../../../utils/sessionManifest';
import { ExternalLink } from '../../../ui/Icons';
import { isLabServerPage, labMember } from '../../../../utils/labServer';
import { withRootPath } from '../../../../utils/rootPath';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';

export const SESSION_SETTINGS = defineSettings({
  sessionName: {
    id: 'file.session-name',
    label: 'Session name',
    keywords: ['name', 'title', 'save session', 'file name'],
    location: inSidebar('file.session'),
  },
  onLaunch: {
    id: 'file.session-on-launch',
    label: 'On launch: reopen the last session',
    keywords: ['reopen', 'restore', 'last session', 'startup', 'start fresh', 'launch'],
    location: inSidebar('file.session'),
  },
});
import { LabSessionShelf } from './LabSessionShelf';
import { getLastSessionPreference, setLastSessionPreference, type LastSessionPreference } from '../../../../utils/launchSession';

interface SessionPersistenceControlsProps {
  setError: (message: string) => void;
}

export function SessionPersistenceControls({ setError }: SessionPersistenceControlsProps) {
  const [launching, setLaunching] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [onLaunch, setOnLaunch] = useState<LastSessionPreference>(getLastSessionPreference);
  const sessionName = useBrowserStore(s => s.sessionName);
  const setSessionName = useBrowserStore(s => s.setSessionName);
  const publicMode = useBrowserStore(s => s.publicMode);
  const showDetails = useBrowserStore(s => s.showAnalysisDetails);
  const manifestCard = useBrowserStore(s => {
    const manifest = buildSessionManifest(s);
    const datasetLabel = `${manifest.datasets.length} dataset${manifest.datasets.length === 1 ? '' : 's'}`;
    const warningLabel = manifest.warnings.length === 0
      ? 'checks passed'
      : `${manifest.warnings.length} warning${manifest.warnings.length === 1 ? '' : 's'}`;
    const footprintRules = manifest.reproducibility.footprintRules;
    return {
      summary: `${datasetLabel} · ${warningLabel}`,
      warnings: manifest.warnings,
      footprintRules,
      footprintRuleNames: footprintRules.rules
        .filter(rule => rule.enabled)
        .slice(0, 3)
        .map(rule => `${rule.name} (${rule.layerLabel})`),
    };
  });
  const manifestWarnings = manifestCard.warnings;
  const footprintRuleLabel = manifestCard.footprintRules.total > 0
    ? `${manifestCard.footprintRules.enabled}/${manifestCard.footprintRules.total} footprint rules enabled · ${manifestCard.footprintRules.pinned} pinned`
    : null;
  const footprintLayerLabel = manifestCard.footprintRules.layers.length > 0
    ? manifestCard.footprintRules.layers.join(', ')
    : null;

  if (publicMode) return null;

  const writeClipboardText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  };

  const handleCopyManifest = async () => {
    const manifest = buildSessionManifest(useBrowserStore.getState());
    try {
      await writeClipboardText(formatSessionManifest(manifest));
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('failed');
      window.setTimeout(() => setCopyStatus('idle'), 2500);
    }
  };

  const handleSaveSession = async () => {
    try {
      await downloadSession(sessionName);
    } catch (error: any) {
      setError(error.message || 'Failed to save session');
    }
  };

  const handleNewWorkspace = async () => {
    if (!isLabServerPage()) {
      window.open('/?workspace=new', '_blank');
      return;
    }
    // A lab server starts a workspace only by POST (it then belongs to this member);
    // the tab is opened now so the browser doesn't treat it as an unrequested popup.
    const tab = window.open('', '_blank');
    try {
      const response = await fetchApiResponse('/api/workspaces', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) {
        throw new Error(data.detail || data.message || 'Could not start a workspace');
      }
      if (tab) tab.location.href = withRootPath(data.url);
      else window.open(data.url, '_blank');
    } catch (error: any) {
      tab?.close();
      setError(error.message || 'Could not start a workspace');
    }
  };

  const handleNewWindow = async () => {
    setLaunching(true);
    try {
      const response = await fetchApiResponse('/api/new-window', { method: 'POST' });
      const data = await response.json();
      if (data.url) {
        setTimeout(() => window.open(data.url, '_blank'), 1500);
      } else {
        setError(data.error || 'Failed to launch new window');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to launch new window');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-0.5" {...settingAnchor(SESSION_SETTINGS.sessionName)}>
        <input
          type="text"
          value={sessionName}
          onChange={e => setSessionName(e.target.value)}
          placeholder="Session name"
          className="text-[12px] px-1.5 py-0.5 border rounded flex-1 dark:bg-dark-bg dark:border-gray-600 dark:text-gray-300"
        />
      </div>
      <button
        onClick={handleSaveSession}
        className="w-full text-left px-2 py-1 text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded"
        title="Download a reloadable JSON containing the exact browser and analysis state"
      >
        Save session
      </button>
      {showDetails && (
      <button
          onClick={handleCopyManifest}
          className="w-full text-left px-2 py-1 text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded"
          title="Copy datasets, reference, seed, analysis cap, peak, cluster, filter, and restore-warning summary"
        >
          {copyStatus === 'copied'
            ? 'Manifest Copied'
            : copyStatus === 'failed'
              ? 'Copy Failed'
              : 'Copy Reproducibility Summary'}
        </button>
      )}
      {(showDetails || manifestWarnings.length > 0) && (
      <div className="mx-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
        <div className="font-medium">Manifest: {manifestCard.summary}</div>
        {footprintRuleLabel && (
          <div className="mt-0.5 text-slate-700 dark:text-slate-200">
            {footprintRuleLabel}{footprintLayerLabel ? ` · ${footprintLayerLabel}` : ''}
          </div>
        )}
        {manifestCard.footprintRuleNames.length > 0 && (
          <div className="mt-0.5 truncate text-slate-500 dark:text-slate-400" title={`Rules: ${manifestCard.footprintRuleNames.join(', ')}`}>
            Rules: {manifestCard.footprintRuleNames.join(', ')}
            {manifestCard.footprintRules.enabled > manifestCard.footprintRuleNames.length
              ? ` +${manifestCard.footprintRules.enabled - manifestCard.footprintRuleNames.length} more`
              : ''}
          </div>
        )}
        {manifestWarnings.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {manifestWarnings.slice(0, 3).map(warning => (
              <li key={warning} className="text-amber-700 dark:text-amber-300">
                {warning}
              </li>
            ))}
            {manifestWarnings.length > 3 && (
              <li className="text-amber-700 dark:text-amber-300">
                +{manifestWarnings.length - 3} more warning{manifestWarnings.length - 3 === 1 ? '' : 's'}
              </li>
            )}
          </ul>
        )}
      </div>
      )}
      {isLabServerPage() && labMember() && <LabSessionShelf setError={setError} />}
      {!isLabServerPage() && (
      <button
        onClick={handleNewWindow}
        disabled={launching}
        className="w-full text-left px-2 py-1 text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded flex items-center gap-1.5 disabled:opacity-50"
        title="Open a new independent browser instance"
      >
        <ExternalLink size={13} />
        {launching ? 'Launching...' : 'New Window'}
      </button>
      )}
      {!isPublicMode() && (
        <button
          onClick={handleNewWorkspace}
          className="w-full text-left px-2 py-1 text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded flex items-center gap-1.5"
          title="Open a new tab with its own datasets and analyses on this same server (shares the loaded reference genome)"
          data-testid="new-workspace"
        >
          <ExternalLink size={13} />
          New Independent Workspace
        </button>
      )}
      {!isLabServerPage() && (
        <label
          {...settingAnchor(SESSION_SETTINGS.onLaunch)}
          className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-gray-600 dark:text-gray-400"
          title="What FiberBrowser does with the last session when it starts again after a normal quit (after a crash it always offers to restore)"
        >
          <span className="shrink-0">On launch</span>
          <select
            value={onLaunch}
            onChange={e => {
              const value = e.target.value as LastSessionPreference;
              setLastSessionPreference(value);
              setOnLaunch(value);
            }}
            className="min-w-0 flex-1 rounded border px-1 py-0.5 text-[12px] dark:border-gray-600 dark:bg-dark-bg dark:text-gray-300"
            data-testid="on-launch-preference"
          >
            <option value="ask">Offer it on the welcome card</option>
            <option value="reopen">Reopen the last session</option>
            <option value="fresh">Start fresh</option>
          </select>
        </label>
      )}
    </>
  );
}
