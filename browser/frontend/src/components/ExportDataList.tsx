import { useMemo, useState, type ComponentType } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { useConsensusViewStore } from '../stores/consensusViewStore';
import { useDafcStore } from '../stores/dafcStore';
import { useReadStatusStore } from '../stores/readStatusStore';
import { registerBuiltinDataExports } from '../utils/builtinDataExports';
import {
  DATA_EXPORT_GROUPS, entryAvailability, entryButtonLabel, listDataExports, useDataExports,
  type DataExportContext, type DataExportEntry, type DataExportGroup,
} from '../utils/dataExportRegistry';
import { defaultReadScope, readScopeOptions, type ReadScopeKey } from '../utils/exportReadScopes';
import { BarChart, Download, FootprintClasses, Peaks, ReadClusters, Reads } from './ui/Icons';

registerBuiltinDataExports();

const GROUP_ICONS: Record<DataExportGroup, ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>> = {
  reads: Reads,
  peaks: Peaks,
  classes: FootprintClasses,
  clusters: ReadClusters,
  analysis: BarChart,
  session: Download,
};

type EntryStatus = { busy?: boolean; message?: string; error?: string };

/**
 * Every data export, grouped by what it is about (utils/dataExportRegistry.ts):
 * each says what is in it and its format, and is disabled with the reason
 * when it doesn't apply. Shown by Export data… and the Export dialog's Data tab.
 */
export function ExportDataList({ onOpenPanel }: { onOpenPanel?: () => void }) {
  useDataExports();  // re-render when an export is registered
  // Availability follows the store (and the class run, contact data, reads in view).
  const state = useBrowserStore(s => s);
  useConsensusViewStore(s => `${s.jobId ?? ''}:${s.catalog ? 1 : 0}`);
  useDafcStore(s => s.dafcLoaded);
  useReadStatusStore(s => s.byStateKey);

  const scopeOptions = useMemo(() => readScopeOptions(state), [state]);
  const [scopePick, setScopePick] = useState<ReadScopeKey | null>(null);
  const readScope: ReadScopeKey = scopePick && scopeOptions.some(o => o.key === scopePick)
    ? scopePick : defaultReadScope(scopeOptions);
  const ctx: DataExportContext = { state, readScope };
  const [status, setStatus] = useState<Record<string, EntryStatus>>({});

  const run = async (entry: DataExportEntry) => {
    setStatus(s => ({ ...s, [entry.id]: { busy: true } }));
    try {
      const message = await entry.run({ state: useBrowserStore.getState(), readScope });
      setStatus(s => ({ ...s, [entry.id]: { message: typeof message === 'string' ? message : undefined } }));
      if (entry.action === 'open') onOpenPanel?.();
    } catch (error) {
      setStatus(s => ({ ...s, [entry.id]: { error: error instanceof Error ? error.message : String(error) } }));
    }
  };

  return (
    <div className="space-y-4" data-testid="export-data-list">
      {DATA_EXPORT_GROUPS.map(group => {
        const entries = listDataExports(group.id);
        if (entries.length === 0) return null;
        const Icon = GROUP_ICONS[group.id];
        return (
          <section key={group.id} aria-labelledby={`export-group-${group.id}-title`} data-testid={`export-group-${group.id}`}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <Icon size={14} aria-hidden={true} className="text-brand-700 dark:text-brand-300" />
              <h3 id={`export-group-${group.id}-title`} className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">{group.title}</h3>
            </div>
            <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">{group.description}</p>
            {group.id === 'reads' && (
              <label className="mb-2 flex items-center gap-2 text-[12px] text-gray-700 dark:text-gray-300">
                <span className="shrink-0">Reads</span>
                <select
                  value={readScope}
                  onChange={e => setScopePick(e.target.value as ReadScopeKey)}
                  className="min-w-0 flex-1 rounded-md border border-line bg-white px-1.5 py-1 text-[12px] dark:border-white/15 dark:bg-dark-bg dark:text-gray-200"
                  data-testid="export-read-scope"
                  aria-label="Which reads"
                >
                  {scopeOptions.map(o => (
                    <option key={o.key} value={o.key}>{o.label} ({o.count.toLocaleString()})</option>
                  ))}
                </select>
              </label>
            )}
            <div className="divide-y divide-line/60 rounded-lg border border-line/70 dark:divide-white/10 dark:border-white/10">
              {entries.map(entry => (
                <ExportEntryRow key={entry.id} entry={entry} ctx={ctx} status={status[entry.id]} onRun={() => void run(entry)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ExportEntryRow({ entry, ctx, status, onRun }: {
  entry: DataExportEntry;
  ctx: DataExportContext;
  status?: EntryStatus;
  onRun: () => void;
}) {
  const availability = entryAvailability(entry, ctx);
  let warning: string | null = null;
  try { warning = entry.sizeWarning?.(ctx) ?? null; } catch { warning = null; }
  const label = entryButtonLabel(entry);
  return (
    <div
      className={`flex items-start justify-between gap-3 px-3 py-2 ${availability.ok ? '' : 'bg-gray-50/70 dark:bg-white/[0.02]'}`}
      data-testid={`export-entry-${entry.id}`}
      data-available={availability.ok ? 'true' : 'false'}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`text-[12px] font-medium ${availability.ok ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>{entry.title}</span>
          <span className="rounded bg-gray-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-gray-600 dark:bg-white/10 dark:text-gray-300">{entry.format}</span>
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">{entry.description}</div>
        {availability.ok && availability.detail && (
          <div className="text-[11px] text-gray-600 dark:text-gray-300" data-testid={`export-entry-${entry.id}-detail`}>{availability.detail}</div>
        )}
        {!availability.ok && (
          <div className="text-[11px] text-gray-600 dark:text-gray-300" data-testid={`export-entry-${entry.id}-reason`}>{availability.reason}</div>
        )}
        {warning && (
          <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300" data-testid={`export-${entry.id}-size-warning`}>{warning}</div>
        )}
        {status?.message && <div className="mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-300" role="status">{status.message}</div>}
        {status?.error && <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400" role="alert">{status.error}</div>}
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={!availability.ok || status?.busy}
        className={`${entry.primary ? 'fb-btn-primary' : 'fb-btn-secondary'} shrink-0`}
        title={availability.ok ? `${entry.title} (${entry.format})` : availability.reason}
        data-testid={`export-entry-${entry.id}-button`}
      >
        {status?.busy ? (entry.action === 'open' ? 'Opening…' : 'Preparing…') : label}
      </button>
    </div>
  );
}
