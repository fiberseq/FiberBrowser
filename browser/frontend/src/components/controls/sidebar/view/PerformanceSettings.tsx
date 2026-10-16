import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePerformanceStore } from '../../../../stores/performanceStore';
import { PERFORMANCE_MODE_LABELS, type PerformanceMode } from '../../../../utils/performanceProfile';
import { defineSettings, inSidebar } from '../../../../utils/settingsCatalog';
import { SidebarSettingNote, SidebarSettingRow } from '../shared/SidebarSetting';
import { readRegionDiagnostics } from '../../../../api/loadedReadRegion';
import { readExpansionDiagnostics } from '../../../../api/readBinary';

export const PERFORMANCE_SETTINGS = defineSettings({
  mode: { id: 'view.performance-mode', label: 'Performance mode',
    keywords: ['memory', 'ram', 'cpu', 'speed', 'cache', 'workers', 'low memory', 'diagnostics'],
    location: inSidebar('view.display') },
});

const descriptions = {
  low: 'Smaller caches, sampled reads and analyses, 1× canvases, no background read loading.',
  standard: 'Regular caches, sampled display, full analysis working sets and background read loading.',
  high: 'Larger caches and background spans, more workers, full analysis working sets.',
};
const mib = (bytes: number) => `${Math.round(bytes / 1024 ** 2).toLocaleString()} MiB`;

export function PerformanceSettings() {
  const [expanded, setExpanded] = useState(false);
  const { info, busy, error, setMode, refresh } = usePerformanceStore(useShallow(s => ({
    info: s.info, busy: s.busy, error: s.error, setMode: s.setMode, refresh: s.refresh,
  })));
  if (!info) return null;
  return <>
    <SidebarSettingRow setting={PERFORMANCE_SETTINGS.mode} helpText="Saved for this computer; takes effect now. Auto uses browser capability, total server memory and CPU cores. Low memory uses at most 2,000 reads per analysis working set; choose Standard or High performance for complete sets.">
      <select aria-label="Performance mode" data-testid="performance-mode" className="input-tool flex-1 text-xs"
        value={info.mode} disabled={busy} onChange={e => void setMode(e.target.value as PerformanceMode)}>
        {Object.entries(PERFORMANCE_MODE_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}{mode === 'auto' ? ' (default)' : ''}</option>)}
      </select>
    </SidebarSettingRow>
    <div className="text-[11px] text-ink-secondary" data-testid="performance-mode-description">
      {info.mode === 'auto' ? `${PERFORMANCE_MODE_LABELS[info.effective]}: ` : ''}{descriptions[info.effective]}
    </div>
    {error && <SidebarSettingNote tone="rose">{error}</SidebarSettingNote>}
    <details className="text-[12px]" data-testid="performance-diagnostics" onToggle={e => { setExpanded(e.currentTarget.open); if (e.currentTarget.open) void refresh(); }}>
      <summary className="cursor-pointer text-gray-500">Advanced: memory and workers</summary>
      {expanded && <PerformanceDiagnostics />}
    </details>
  </>;
}

function PerformanceDiagnostics() {
  const info = usePerformanceStore(s => s.info);
  const refresh = usePerformanceStore(s => s.refresh);
  useEffect(() => { const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  if (!info) return null;
  const regions = readRegionDiagnostics(), expansions = readExpansionDiagnostics();
  return <div className="mt-1.5 space-y-1 text-[11px] text-ink-secondary" data-testid="performance-budget-readout">
    <div>{Math.round(info.hardware.total_memory_bytes / 1024 ** 3)} GiB memory · {info.hardware.cores} CPU cores</div>
    <div>{info.workers} analysis workers · {info.decode_workers} decode workers · up to {info.numeric_threads} numerical threads</div>
    <div>Analysis working set: {info.max_working_reads ? `up to ${info.max_working_reads.toLocaleString()} reads` : 'all reads'} · display target: {info.sample_target.toLocaleString()} reads</div>
    {Object.entries(info.caches).map(([name, cache]) => <div key={name}>{name}: {mib(cache.retained_bytes)} of {mib(cache.budget_bytes)}</div>)}
    {info.shared_caches?.map(cache => <div key={cache.group}>Shared {cache.group}: {mib(cache.retained_bytes)} of {mib(cache.budget_bytes)}</div>)}
    <div>Browser cohorts: {mib(regions.retained)} of {mib(regions.budget)}</div>
    <div>Expanded layers: {mib(expansions.retained)} of {mib(expansions.budget)}</div>
    <div>Retention estimates; active views and running jobs use additional memory.</div>
  </div>;
}
