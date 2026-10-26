/**
 * Settings › Reads & Display › Graph mode (DESIGN_GRAPH_PRIMARY §5.1): how new datasets open, the zoom-out hand-off
 * thresholds and the complexity hand-off (features/graphPanel/handoff: kept on this computer, not in sessions), and
 * the registered graph packages (register a prepared package folder, or forget one). Not gated on preview features;
 * hidden on a public server (the graph routes are host-only).
 */
import { useEffect, useState } from 'react';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';
import { SidebarSettingNote, SidebarSettingRow, SidebarSettingToggle } from '../shared/SidebarSetting';
import { pickFolder } from '../../../../api/files';
import {
  HANDOFF_MAX_BP, HANDOFF_MIN_BP, useGraphSettings, validHandoffPair, type LiftedOpenView,
} from '../../../../features/graphPanel/handoff';
import { useGraphStatusStore } from '../../../../features/graphPanel/statusStore';
import { unregisterGraphPackage, GraphRequestError } from '../../../../features/graphPanel/api';
import { watchGraphBindings } from '../../../../features/graphPanel/bindingsStore';
import { isLabServerPage, labInfo } from '../../../../utils/labServer';

const notPublic = () => (useBrowserStore.getState().publicMode ? 'not on a public server' : null);

/** Who may register or remove graph packages: anyone locally; on a shared lab server only its admins (the table is
 * one per server; services/lab/auth.py LAB_ADMIN_ONLY). */
export function canManageGraphPackages(): boolean {
  const lab = labInfo();
  return lab === null || lab.role === 'admin';
}

export const GRAPH_MODE_SETTINGS = defineSettings({
  liftedView: {
    id: 'view.graph-lifted-view',
    label: 'Open lifted datasets as',
    keywords: ['graph mode', 'live lift', 'split', 'pooled', 'haplotype panels', 'default view'],
    location: inSidebar('view.graph'),
    hiddenReason: notPublic,
  },
  nativeGraph: {
    id: 'view.graph-native-open',
    label: 'Open native BAMs in graph mode',
    keywords: ['graph mode', 'open in graph mode', 'native dataset', 'view as graph'],
    location: inSidebar('view.graph'),
    hiddenReason: notPublic,
    toggle: {
      get: () => useGraphSettings.getState().nativeOpenView === 'graph',
      set: on => useGraphSettings.getState().set({ nativeOpenView: on ? 'graph' : 'linear' }),
    },
  },
  handoff: {
    id: 'view.graph-handoff',
    label: 'Zoom-out hand-off',
    keywords: ['graph mode', 'hand-off', 'handoff', 'linear', 'zoom out', 'threshold', 'kb'],
    location: inSidebar('view.graph'),
    hiddenReason: notPublic,
  },
  complexity: {
    id: 'view.graph-complexity-handoff',
    label: 'Complexity hand-off',
    keywords: ['graph mode', 'complexity', 'unresolved', 'tangled', 'linear'],
    location: inSidebar('view.graph'),
    hiddenReason: notPublic,
    toggle: {
      get: () => useGraphSettings.getState().complexity,
      set: on => useGraphSettings.getState().set({ complexity: on }),
    },
  },
  packages: {
    id: 'view.graph-packages',
    label: 'Graph packages',
    keywords: ['graph package', 'register graph package', 'pangenome', 'gbz', 'fiberbrowser-graph', 'remove package'],
    location: inSidebar('view.graph'),
    hiddenReason: notPublic,
  },
});

const kb = (bp: number) => String(Math.round(bp / 1000));
const LIFTED_LABELS: Record<LiftedOpenView, string> = { graph: 'Graph', split: 'Split panels', pooled: 'Pooled panel' };

export function GraphModeSettings() {
  const publicMode = useBrowserStore(s => s.publicMode);
  const settings = useGraphSettings();
  const [outDraft, setOutDraft] = useState(kb(settings.outBp));
  const [inDraft, setInDraft] = useState(kb(settings.inBp));
  useEffect(() => { setOutDraft(kb(settings.outBp)); setInDraft(kb(settings.inBp)); }, [settings.outBp, settings.inBp]);
  useEffect(() => { if (!publicMode) void useGraphStatusStore.getState().load(); }, [publicMode]);
  if (publicMode) return null;

  const outKb = Number(outDraft), inKb = Number(inDraft);
  const min = HANDOFF_MIN_BP / 1000, max = HANDOFF_MAX_BP / 1000;
  // Judged on the whole-bp pair that would be saved (40.0004 / 40.0003 kb are both 40,000 bp).
  const outBp = Math.round(outKb * 1000), inBp = Math.round(inKb * 1000);
  const handoffError = !Number.isFinite(outKb) || !Number.isFinite(inKb) || outDraft.trim() === '' || inDraft.trim() === ''
    ? 'Enter both thresholds in kb.'
    : outBp < HANDOFF_MIN_BP || outBp > HANDOFF_MAX_BP || inBp < HANDOFF_MIN_BP || inBp > HANDOFF_MAX_BP ? `Both thresholds are ${min}–${max} kb.`
      : !validHandoffPair(outBp, inBp) ? 'Back to the graph must be below the zoom-out threshold.' : null;
  const commitHandoff = () => {
    if (handoffError) return;
    settings.set({ outBp, inBp });
  };

  return (
    <SidebarSubSection
      id="view.graph"
      label="Graph mode"
      helpText="Graph mode draws a dataset panel's reads on a registered pangenome graph package. These choices are kept on this computer, not in sessions."
      persist
    >
      <div className="space-y-2" data-testid="graph-mode-settings">
        <SidebarSettingRow setting={GRAPH_MODE_SETTINGS.liftedView}
          helpText="How a new live-lift dataset opens when a registered graph package binds it. The Add live lift dialog can choose otherwise for one dataset.">
          <select aria-label="Open lifted datasets as" data-testid="graph-settings-lifted-view" className="input-tool flex-1 text-xs"
            value={settings.defaultLiftedView} onChange={e => settings.set({ defaultLiftedView: e.target.value as LiftedOpenView })}>
            {(Object.keys(LIFTED_LABELS) as LiftedOpenView[]).map(v => <option key={v} value={v}>{LIFTED_LABELS[v]}{v === 'graph' ? ' (default)' : ''}</option>)}
          </select>
        </SidebarSettingRow>
        <div data-testid="graph-settings-native-open">
          <SidebarSettingToggle setting={GRAPH_MODE_SETTINGS.nativeGraph} checked={settings.nativeOpenView === 'graph'}
            onChange={on => settings.set({ nativeOpenView: on ? 'graph' : 'linear' })}
            helpText="Off by default: a BAM on this genome opens linear and the panel's Linear / Graph toggle switches it. On: BAMs you open (Open file, drag and drop, Load by path) open as a graph when a registered package binds their contig." />
        </div>

        <div className="space-y-1" {...settingAnchor(GRAPH_MODE_SETTINGS.handoff)} data-testid="graph-settings-handoff">
          <div className="text-[12px] text-gray-700 dark:text-gray-300">{GRAPH_MODE_SETTINGS.handoff.label}</div>
          <label className="flex items-center gap-1.5 text-[12px] text-gray-700 dark:text-gray-300">
            <span className="min-w-[8.5rem]">Linear when wider than</span>
            <input type="number" min={min} max={max} step={1} aria-label="Zoom-out threshold (kb)" data-testid="graph-settings-out-kb"
              className="input-tool w-16 text-xs" value={outDraft} onChange={e => setOutDraft(e.target.value)}
              onBlur={commitHandoff} onKeyDown={e => { if (e.key === 'Enter') commitHandoff(); }} />
            <span>kb</span>
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-gray-700 dark:text-gray-300">
            <span className="min-w-[8.5rem]">Graph again at or below</span>
            <input type="number" min={min} max={max} step={1} aria-label="Back-to-graph threshold (kb)" data-testid="graph-settings-in-kb"
              className="input-tool w-16 text-xs" value={inDraft} onChange={e => setInDraft(e.target.value)}
              onBlur={commitHandoff} onKeyDown={e => { if (e.key === 'Enter') commitHandoff(); }} />
            <span>kb</span>
          </label>
          {handoffError
            ? <div className="text-[11px] text-rose-700 dark:text-rose-300" role="alert" data-testid="graph-settings-handoff-error">{handoffError}</div>
            : <div className="text-[11px] text-ink-secondary">{min}–{max} kb (the graph helper draws at most {max} kb). Default 50 / 40 kb.</div>}
        </div>
        <div data-testid="graph-settings-complexity">
          <SidebarSettingToggle setting={GRAPH_MODE_SETTINGS.complexity} checked={settings.complexity}
            onChange={on => settings.set({ complexity: on })}
            helpText="On (default): a host draws linear where most of its window is unresolved in the graph's topology, and returns when you move on." />
        </div>

        <GraphPackages />
      </div>
    </SidebarSubSection>
  );
}

/** The registered graph packages: Remove each; register a prepared package folder by path (or Browse…). */
function GraphPackages() {
  const status = useGraphStatusStore(s => s.status);
  const loadError = useGraphStatusStore(s => s.error);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const helperMissing = status && !status.helper.available;
  const manage = canManageGraphPackages();

  const register = async (dir = path) => {
    const value = dir.trim();
    if (!value || busy) return;
    setBusy(true); setError(null); setNote(null);
    const before = new Set(useGraphStatusStore.getState().status?.registrations.map(r => r.id) ?? []);
    const why = await useGraphStatusStore.getState().register(value);
    setBusy(false);
    if (why) { setError(why); return; }
    setPath('');
    const reg = useGraphStatusStore.getState().status?.registrations.find(r => !before.has(r.id)) ?? null;
    setNote(reg ? `Registered ${reg.label}. Datasets it binds now offer graph mode.` : 'This package was already registered.');
    // The header's Linear / Graph toggle appears once the bindings are read again (status changed → bindings).
    watchGraphBindings();
  };
  const browse = async () => {
    const picked = await pickFolder('Graph package folder (fiberbrowser-graph prepare)').catch(() => null);
    if (picked?.success && picked.path) { setPath(picked.path); void register(picked.path); }
  };
  const remove = async (id: string, label: string) => {
    setBusy(true); setError(null); setNote(null);
    try {
      await unregisterGraphPackage(id);
      setNote(`Removed ${label}.`);
    } catch (err) {
      setError(err instanceof GraphRequestError ? err.error.message : String(err));
    } finally {
      setBusy(false);
      await useGraphStatusStore.getState().load(true);
    }
  };

  return (
    <div className="space-y-1" {...settingAnchor(GRAPH_MODE_SETTINGS.packages)} data-testid="graph-packages">
      <div className="text-[12px] text-gray-700 dark:text-gray-300">{GRAPH_MODE_SETTINGS.packages.label}</div>
      {helperMissing && (
        <SidebarSettingNote tone="amber">
          The graph helper is not available{status?.helper.hint ? `: ${status.helper.hint}` : '.'}
        </SidebarSettingNote>
      )}
      {loadError && !status && <SidebarSettingNote tone="rose">{loadError}</SidebarSettingNote>}
      {status && (status.registrations.length ? (
        <ul className="space-y-0.5" data-testid="graph-packages-list">
          {status.registrations.map(r => (
            <li key={r.id} className="flex items-center gap-1.5 text-[11.5px]" data-testid="graph-package-row" data-registration-id={r.id}>
              <span className="min-w-0 flex-1 truncate" title={`${r.label} · ${r.bindings.length} paths`}>{r.label}</span>
              {manage && <button type="button" className="text-[11px] underline disabled:opacity-40" disabled={busy}
                data-testid={`graph-package-remove-${r.id}`} onClick={() => void remove(r.id, r.label)}>Remove</button>}
            </li>
          ))}
        </ul>
      ) : <div className="text-[11px] text-ink-secondary" data-testid="graph-packages-empty">No graph package is registered.</div>)}
      {status?.registration_errors?.map(e => (
        <div key={e.package} className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="graph-package-error">{e.package}: {e.error}</div>
      ))}
      {!manage && <div className="text-[11px] text-ink-secondary" data-testid="graph-packages-admin-only">Lab admins register and remove graph packages on this server.</div>}
      {manage && <div className="flex gap-1">
        <input type="text" value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void register(); }}
          aria-label="Graph package folder" placeholder="/path/to/graph-package" data-testid="graph-package-path"
          className="text-[12px] px-1.5 py-1 border rounded flex-1 dark:bg-dark-bg dark:border-gray-600 dark:text-gray-300 min-w-0" />
        {/* No folder dialog on a lab server (it would open on the server's screen). */}
        {!isLabServerPage() && <button type="button" className="btn-tool text-xs" disabled={busy} onClick={() => void browse()} data-testid="graph-package-browse">Browse…</button>}
        <button type="button" className="px-2 py-1 bg-blue-500 text-white rounded text-[11px] hover:bg-blue-600 disabled:opacity-40"
          disabled={busy || !path.trim() || Boolean(helperMissing)} onClick={() => void register()} data-testid="graph-package-register">
          {busy ? '…' : 'Register'}
        </button>
      </div>}
      {error && <div className="text-[11px] text-rose-700 dark:text-rose-300" role="alert" data-testid="graph-package-message-error">{error}</div>}
      {note && <div className="text-[11px] text-emerald-700 dark:text-emerald-300" data-testid="graph-package-message">{note}</div>}
    </div>
  );
}
