/**
 * The feature hub (DESIGN §6): every feature set in one list — fiberhmm-scan modules (opened or run here), Find
 * classes, NFR runs, SVs, peaks, live-lift Differences — with a comparison column per dataset (and per haplotype),
 * hits in view with row expansion and navigation, and "Use as" anchors, cluster regions or a read filter.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { AnalysisPanelProps } from '../../plugins/types';
import { AnalysisButton, AnalysisPanelHeader } from '../../components/controls/shared/AnalysisControls';
import { AnalysisPanelShell } from '../../components/controls/shared/AnalysisPanelShell';
import { JobStatus } from '../../components/controls/shared/JobStatus';
import { pickFolder } from '../../api/files';
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { closeScanId, loadScanHits, openScanPath, refreshScans, restoreSessionScans, scanSets, useHubData, useProviderSets, withGraphGroups } from './hubData';
import { hitSelectionEntry, type HubSelected, type HubUi } from './hubState';
import { useHubJob } from './hubJob';
import { asAnchors, asClusterRegions, asFilter, goToHits } from './actions';
import { sendToNucleosomeWindow } from '../nucleosomes/handoff';
import { ScanDialog } from './ScanDialog';
import { columnPathStatus, displaySpan, graphText, liftChip, liftText } from './frames';
import { matchHits } from './matching';
import { useGraphStatusStore } from '../graphPanel/statusStore';
import type { FeatureHit, FeatureSet, HitValue } from './types';
import { AssocTab, type AssocSeed } from './AssocTab';
import { OverlayTab, type OverlaySeed } from './OverlayTab';

type HubTab = 'hits' | 'assoc' | 'overlay';
const HUB_TABS: Array<{ key: HubTab; label: string }> = [{ key: 'hits', label: 'Hits' }, { key: 'assoc', label: 'Associate' }, { key: 'overlay', label: 'Overlay' }];

interface Row { set: FeatureSet; hit: FeatureHit; role: 'prevalence' | 'strength' | null; key: string; matches: string[] }
interface Column { key: string; label: string; colour?: string; kind: string; datasetId?: string; hap?: string }

const fmt = (v: number | null | undefined, kind?: string) => {
  if (v == null || !Number.isFinite(v)) return '';
  if (kind === 'fraction') return v.toFixed(2);
  if (kind === 'nats') return v.toFixed(1);
  return Math.round(v).toLocaleString();
};

function roleOf(set: FeatureSet): Row['role'] {
  if (set.type.roles?.prevalence) return 'prevalence';
  if (set.type.roles?.strength) return 'strength';
  return null;
}

function roleKind(set: FeatureSet, role: Row['role']): string | undefined {
  const name = role ? set.type.roles?.[role] : undefined;
  return set.type.scores.find(s => s.name === name)?.kind ?? (role === 'prevalence' ? 'fraction' : undefined);
}

const valueOf = (row: Row, col: string): HitValue | undefined => (row.role ? row.hit.values?.[col]?.[row.role] : undefined);

function maxPrevalence(row: Row): number | null {
  if (row.role !== 'prevalence') return null;
  const vs = Object.values(row.hit.values ?? {}).map(v => v.prevalence?.v).filter((v): v is number => v != null && Number.isFinite(v));
  return vs.length ? Math.max(...vs) : null;
}

const locus = (h: { chrom: string; start: number; end: number; anchor: number }) => `${h.chrom}:${(h.anchor + 1).toLocaleString()}`;
const rowKey = (set: FeatureSet, hit: FeatureHit) => `${set.setId}|${hit.hitId}`;
/** Sort position: where the hit is on this genome (a hit that can't be placed here sorts last). */
const placeOf = (h: FeatureHit) => displaySpan(h)?.start ?? Number.MAX_SAFE_INTEGER;
const CHIP_TONE = {
  ok: 'bg-sky-50 text-sky-800 dark:bg-sky-900/30 dark:text-sky-200',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  muted: 'bg-violet-50 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200',
};
const sameSel = (a: HubSelected, set: FeatureSet, hit: FeatureHit) => a.setId === set.setId && a.hitId === hit.hitId;

export function FeatureHubPanel({ isFullView }: AnalysisPanelProps) {
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const dark = useBrowserStore(s => s.darkMode);
  const datasets = useBrowserStore(s => s.datasets);
  const hub = useBrowserStore(s => s.featureHub);
  const setHub = useBrowserStore(s => s.setFeatureHub);
  const scans = useHubData(s => s.scans);
  const scanHitsBySet = useHubData(s => s.hits);
  const missing = useHubData(s => s.missing);
  const dataError = useHubData(s => s.error);
  const providerErrors = useHubData(s => s.providerErrors);
  const job = useHubJob(s => s.job);
  const [dialog, setDialog] = useState(false);
  const [pathText, setPathText] = useState('');
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assocSeed, setAssocSeed] = useState<AssocSeed | null>(null);
  const [overlaySeed, setOverlaySeed] = useState<OverlaySeed | null>(null);
  const view = useMemo(() => ({ chrom, start, end }), [chrom, start, end]);
  const providerSets = useProviderSets(view);
  const sessionScans = useMemo(() => hub.scans.map(s => s.path).join('\n'), [hub.scans]);

  // Reopen the session's scans (a restored session, a restarted server).
  useEffect(() => { void restoreSessionScans(); }, [sessionScans]);
  // Hits in view of the visible scan sets (debounced while browsing).
  const hidden = hub.ui.hiddenSets.join('\n');
  // A scan's columns follow its bindings: they change when datasets open or close.
  const scanKey = scans.map(s => `${s.scanId}:${s.manifestDigest}:${s.datasets.map(d => `${d.scanDataset}=${d.status}:${d.dataset ?? ''}`).join(',')}`).join('|');
  const datasetKey = datasets.map(d => `${d.id}:${(d.paths ?? [d.path]).join(',')}`).join('|');
  // Graph columns come with the hits: registering or removing a package reads them again.
  const graphKey = useGraphStatusStore(s => (s.status?.registrations ?? []).map(r => `${r.id}@${r.revisions.package}`).join(','));
  useEffect(() => { if (hub.scans.length) void refreshScans(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [datasetKey]);
  useEffect(() => {
    const t = setTimeout(() => { void loadScanHits(view, hub.ui.hiddenSets); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hidden, scanKey, graphKey]);
  // A finished live scan: its hits.
  const jobDone = job && !['queued', 'running', 'cancelling'].includes(job.status) ? job.job_id + job.status : '';
  useEffect(() => { if (jobDone) void loadScanHits(view, hub.ui.hiddenSets); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jobDone]);

  const sets: FeatureSet[] = useMemo(() => {
    const fromScans = scanSets(scans).map(s => ({ ...s, groups: [...s.groups, ...(scanHitsBySet[s.setId]?.groups ?? [])],
      source: { kind: 'inline' as const, hits: scanHitsBySet[s.setId]?.hits ?? [] } }));
    return [...fromScans, ...providerSets].map(set => withGraphGroups(set, datasets));
  }, [scans, scanHitsBySet, providerSets, datasets]);
  const visible = sets.filter(s => !hub.ui.hiddenSets.includes(s.setId));
  const typeIds = [...new Set(sets.map(s => s.typeId))];
  const ui = hub.ui;
  const setUi = (patch: Partial<HubUi>) => setHub(h => ({ ui: { ...h.ui, ...patch } }));

  const columns: Column[] = useMemo(() => {
    const out: Column[] = [{ key: 'all', label: 'All', kind: 'all' }];
    const seen = new Set(['all']);
    const order = new Map(datasets.map((d, i) => [d.id, i]));
    const extra: Column[] = [];
    for (const set of visible) {
      for (const g of set.groups) {
        if (seen.has(g.id) || g.id === 'all') continue;
        const hits = set.source.kind === 'inline' ? set.source.hits : [];
        if (!hits.some(h => h.values?.[g.id] || columnPathStatus(h.graph, { datasetId: g.datasetId, hap: g.hap }) !== undefined)) continue;
        seen.add(g.id);
        const colour = g.kind === 'haplotype' ? liveLiftHaplotypeColor(g.hap ?? g.label, dark) : undefined;
        extra.push({ key: g.id, label: g.label, kind: g.kind, colour, ...(g.datasetId ? { datasetId: g.datasetId } : {}), ...(g.hap ? { hap: g.hap } : {}) });
      }
    }
    extra.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dataset' ? -1 : 1)
      || (order.get(a.key.slice(3)) ?? 99) - (order.get(b.key.slice(3)) ?? 99) || a.label.localeCompare(b.label));
    return [...out, ...extra];
  }, [visible, datasets, dark]);

  // Hits of one feature in several frames (a scan here and a lifted scan of an assembly; MAT and PAT): DESIGN §5.4.
  const matches = useMemo(() => matchHits(visible.flatMap(set => (set.source.kind === 'inline' ? set.source.hits : [])
    .map(hit => ({ ...hit, key: rowKey(set, hit), setId: set.setId })))), [visible]);
  const byKey = useMemo(() => new Map(visible.flatMap(set => (set.source.kind === 'inline' ? set.source.hits : []).map(hit => [rowKey(set, hit), { set, hit }] as const))), [visible]);
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const set of visible) {
      if (ui.typeFilter && set.typeId !== ui.typeFilter) continue;
      const role = roleOf(set);
      for (const hit of set.source.kind === 'inline' ? set.source.hits : []) {
        const key = rowKey(set, hit);
        out.push({ set, hit, role, key, matches: matches.get(key) ?? [] });
      }
    }
    const shared = ui.sharedOnly ? out.filter(r => r.matches.length > 0) : out;
    const filtered = ui.minPrevalence == null ? shared : shared.filter(r => (maxPrevalence(r) ?? -1) >= ui.minPrevalence!);
    const delta = (r: Row) => {
      if (!ui.compare) return null;
      const a = valueOf(r, ui.compare[0])?.v, b = valueOf(r, ui.compare[1])?.v;
      return a != null && b != null ? a - b : null;
    };
    const key = (r: Row): number | string => {
      switch (ui.sort.key) {
        case 'prevalence': return maxPrevalence(r) ?? -Infinity;
        case 'strength': return r.hit.values?.all?.strength?.v ?? r.hit.scores.strength ?? -Infinity;
        case 'delta': return delta(r) ?? -Infinity;
        case 'label': return r.hit.label ?? '';
        default: return placeOf(r.hit);
      }
    };
    const dir = ui.sort.dir === 'desc' ? -1 : 1;
    return filtered.sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir || placeOf(a.hit) - placeOf(b.hit) || a.hit.hitId.localeCompare(b.hit.hitId);
    });
  }, [visible, ui, matches]);

  const selected = hub.selected;
  const isSelected = (r: Row) => selected.some(x => sameSel(x, r.set, r.hit));
  const click = (r: Row, additive: boolean) => {
    const entry = hitSelectionEntry(r.set, r.hit);
    setHub(h => {
      const has = h.selected.some(x => sameSel(x, r.set, r.hit));
      if (!additive) return { selected: has && h.selected.length === 1 ? [] : [entry] };
      return { selected: has ? h.selected.filter(x => !sameSel(x, r.set, r.hit)) : [...h.selected, entry] };
    });
  };
  const selectAllShown = () => setHub({ selected: rows.map(r => hitSelectionEntry(r.set, r.hit)) });

  const openPath = async (path: string) => {
    if (!path.trim()) return;
    setBusy(true); setNotice('');
    try {
      const info = await openScanPath(path.trim());
      setNotice(`Opened ${info.label}: ${info.sets.length} feature set${info.sets.length === 1 ? '' : 's'}.`);
      setPathText('');
    } catch (e) {
      setNotice(String((e as Error).message ?? e).replace(/^API error \d+: /, ''));
    } finally { setBusy(false); }
  };
  const browse = async () => {
    try {
      const r = await pickFolder('Choose a fiberhmm-scan output directory');
      if (r.path) await openPath(r.path);
    } catch (e) { setNotice(String((e as Error).message ?? e)); }
  };
  const act = async (fn: () => Promise<string | null> | string | null, done: string) => {
    setBusy(true); setNotice('');
    try { const err = await fn(); setNotice(err ?? done); }
    catch (e) { setNotice(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  const groupsForCompare = columns.filter(c => c.kind !== 'all');
  const liveJob = job && ['queued', 'running', 'cancelling'].includes(job.status);

  const tab: HubTab = ui.tab ?? 'hits';
  const setTab = (t: HubTab) => setUi({ tab: t === 'hits' ? undefined : t });

  return <AnalysisPanelShell tabs={HUB_TABS} activeTab={tab} onTabChange={setTab} theme="indigo" layout="standard" bodyMode="none"
    isFullView={isFullView} bodyClassName="min-w-0 break-words">
    <div data-testid="hub-panel" className="space-y-2">
      <AnalysisPanelHeader theme="indigo"
        detail="Every feature set in one list, with a column per dataset: scans (opened or run here), Find classes, NFRs, SVs, peaks and Differences. Pick hits and use them as anchors, cluster regions or a read filter."
        actions={<>
          <AnalysisButton theme="indigo" variant="soft" data-testid="hub-open-scan" disabled={busy} onClick={() => { void browse(); }}>Open scan…</AnalysisButton>
          <AnalysisButton theme="indigo" variant="primary" data-testid="hub-scan" disabled={Boolean(liveJob)} onClick={() => setDialog(true)}>Scan…</AnalysisButton>
        </>} />
      <div className="flex gap-1">
        <input className="input-tool min-w-0 flex-1 text-[11px]" placeholder="…or type a scan directory and press Enter" value={pathText}
          onChange={e => setPathText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void openPath(pathText); }} data-testid="hub-scan-path" />
        <AnalysisButton disabled={busy || !pathText.trim()} onClick={() => { void openPath(pathText); }} data-testid="hub-scan-path-open">Open</AnalysisButton>
      </div>
      {job && <JobStatus testId="hub-job" title="Scan" state={job.status === 'complete' ? 'complete' : job.status === 'error' ? 'error' : job.status === 'cancelled' ? 'cancelled' : job.status === 'cancelling' ? 'cancelling' : job.status === 'queued' ? 'queued' : 'running'}
        stage={job.stage ?? null} message={liveJob ? job.message : undefined} runKey={job.job_id} startedAt={job.created_at} finishedAt={job.finished_at ?? null}
        stageProgress={job.progress?.total ? { completed: job.progress.completed ?? 0, total: job.progress.total, noun: 'units' } : null}
        onCancel={liveJob ? () => { void useHubJob.getState().cancel(); } : undefined}
        result={job.status === 'complete' ? `${job.where}: ${job.computed_units} unit-module${job.computed_units === 1 ? '' : 's'} computed, the rest reused` : job.error ?? undefined} />}
      {(notice || dataError) && <p role="status" className="text-ink-secondary" data-testid="hub-notice">{notice || dataError}</p>}
      {providerErrors.map(e => <p key={e} role="status" className="text-ink-secondary">{e}</p>)}

      <section data-testid="hub-scans" className="space-y-1">
        {scans.map(s => {
          const bound = s.datasets.filter(d => d.status === 'bound').length;
          const status = s.datasets.some(d => d.status === 'stale') ? 'stale' : bound === s.datasets.length ? 'bound' : bound ? 'partly bound' : 'scan of other files';
          return <div key={s.scanId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-fb border border-line px-2 py-1 dark:border-white/10" data-testid="hub-scan-row">
            <strong className="min-w-0 truncate" title={s.path}>{s.label}</strong>
            <span className="text-ink-muted">{s.source === 'cache' ? 'browser scan' : `fiberhmm-scan ${s.fiberhmm ?? ''}`} · {Object.keys(s.modules).join(' ')} · {s.units.mode === 'grid' ? `${(s.units.unit_bp ?? 0) / 1000}/${(s.units.stride_bp ?? 0) / 1000} kb grid` : 'BED units'}</span>
            <span className={`rounded-full px-1.5 text-[10px] ${status === 'bound' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200' : status === 'stale' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300'}`}
              title={s.datasets.map(d => `${d.scanDataset}: ${d.status}${d.dataset ? ` → ${datasets.find(x => x.id === d.dataset)?.label ?? d.dataset}` : ''}${d.note ? ` (${d.note})` : ''}`).join('\n') + (s.referenceNote ? `\n${s.referenceNote}` : '')}
              data-testid="hub-scan-binding">● {status}</span>
            {s.annotated.length > 0 && <span className="text-[11px] text-ink-muted" title={s.annotated.map(a => a.path).join('\n')}>annotated BAMs: {s.annotated.length}</span>}
            {status === 'stale' && <button type="button" className="text-[11px] text-amber-700 underline dark:text-amber-300" data-testid="hub-scan-rescan"
              title="The loaded BAM changed since this scan: scan the view's units again" onClick={() => setDialog(true)}>Re-scan…</button>}
            <button type="button" className="ml-auto text-[11px] text-ink-muted hover:underline" onClick={() => { void closeScanId(s.scanId); }}>Close</button>
          </div>;
        })}
        {Object.entries(missing).map(([path, why]) => (
          <div key={path} className="rounded-fb border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="hub-scan-missing">
            Scan not found: {path.split(/[\\/]/).pop()} — {why}. Locate it (Open scan…) or re-scan.
            <button type="button" className="ml-2 underline" onClick={() => {
              setHub(h => ({ scans: h.scans.filter(x => x.path !== path) }));
              useHubData.setState(st => { const m = { ...st.missing }; delete m[path]; return { missing: m }; });
            }}>Forget</button>
          </div>
        ))}
      </section>

      {tab === 'assoc' && <AssocTab sets={sets} scans={scans} seed={assocSeed} />}
      {tab === 'overlay' && <OverlayTab sets={sets} seed={overlaySeed} />}
      {tab === 'hits' && <>
      <section data-testid="hub-sets" className="space-y-0.5">
        {!sets.length && <p className="text-ink-secondary">No feature sets yet: open a scan or run one, or run Find classes, NFRs or a peak scan.</p>}
        {sets.map(set => {
          const on = !ui.hiddenSets.includes(set.setId);
          const n = set.source.kind === 'inline' ? set.source.hits.length : 0;
          const experimental = (set.provenance as { experimental?: boolean }).experimental || set.provenance.summary?.includes('experimental');
          return <label key={set.setId} className="flex min-h-[22px] items-center gap-2 rounded-fb px-1 hover:bg-gray-50 dark:hover:bg-white/5" data-testid="hub-set-row" data-type={set.typeId}>
            <input type="checkbox" checked={on} onChange={e => setUi({ hiddenSets: e.target.checked ? ui.hiddenSets.filter(x => x !== set.setId) : [...ui.hiddenSets, set.setId] })} />
            <span className="font-medium">{set.type.plural}</span>
            <span className="text-[11px] text-ink-muted">{set.typeId}</span>
            <span className="tabular-nums" data-testid="hub-set-count">{n} in view</span>
            {experimental && <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">experimental</span>}
            {set.status !== 'complete' && <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300">{set.status}</span>}
            {set.note && <span className="truncate text-[11px] text-amber-700 dark:text-amber-300" title={set.note}>{set.note}</span>}
            {scanHitsBySet[set.setId]?.note && <span className="truncate text-[11px] text-amber-700 dark:text-amber-300" title={scanHitsBySet[set.setId]!.note} data-testid="hub-set-note">{scanHitsBySet[set.setId]!.note}</span>}
            <span className="ml-auto truncate text-[11px] text-ink-muted" title={set.provenance.summary}>{set.provenance.producer === 'browser' ? set.provenance.module : (set as { scan?: { label: string } }).scan?.label ?? set.provenance.module}</span>
          </label>;
        })}
      </section>

      <section data-testid="hub-hits" className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={ui.typeFilter} onChange={e => setUi({ typeFilter: e.target.value })} data-testid="hub-type-filter" aria-label="Type">
            <option value="">All types</option>
            {typeIds.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <label className="inline-flex items-center gap-1 text-[11px]">Prevalence ≥
            <input type="number" min={0} max={1} step={0.05} className="input-tool w-16 min-h-0 rounded px-1 py-0.5 text-[11px]" value={ui.minPrevalence ?? ''}
              onChange={e => setUi({ minPrevalence: e.target.value === '' ? null : Math.max(0, Math.min(1, Number(e.target.value))) })} data-testid="hub-min-prevalence" />
          </label>
          <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" value={`${ui.sort.key}:${ui.sort.dir}`} aria-label="Sort" data-testid="hub-sort"
            onChange={e => { const [key, dir] = e.target.value.split(':'); setUi({ sort: { key: key as HubUi['sort']['key'], dir: dir as 'asc' | 'desc' } }); }}>
            <option value="locus:asc">Sort: position</option>
            <option value="prevalence:desc">Sort: prevalence</option>
            <option value="strength:desc">Sort: strength</option>
            <option value="label:asc">Sort: label</option>
            {ui.compare && <option value="delta:desc">Sort: Δ</option>}
          </select>
          <label className="inline-flex items-center gap-1 text-[11px]" title="Only hits found again in another frame or set: the same feature in this genome's scan and a lifted scan of an assembly, or on both haplotypes">
            <input type="checkbox" checked={Boolean(ui.sharedOnly)} onChange={e => setUi({ sharedOnly: e.target.checked })} data-testid="hub-shared-only" />Matched only
          </label>
          <select className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]" aria-label="Compare" data-testid="hub-compare" value={ui.compare ? ui.compare.join('|') : ''}
            onChange={e => setUi({ compare: e.target.value ? e.target.value.split('|') as [string, string] : null })}>
            <option value="">Compare: off</option>
            {groupsForCompare.flatMap((a, i) => groupsForCompare.slice(i + 1).map(b => <option key={`${a.key}|${b.key}`} value={`${a.key}|${b.key}`}>Δ {a.label} − {b.label}</option>))}
          </select>
          <span className="ml-auto text-[11px] text-ink-muted" data-testid="hub-hit-count">{rows.length} hit{rows.length === 1 ? '' : 's'} in view</span>
          <button type="button" className="text-[11px] text-indigo-700 hover:underline dark:text-indigo-300" onClick={selectAllShown} data-testid="hub-select-shown">Select shown</button>
        </div>
        <div className="max-h-[360px] overflow-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-[11px] tabular-nums" data-testid="hub-table">
            <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-gray-900">
              <tr>
                <th className="px-1 text-left font-medium">Type</th><th className="px-1 text-left font-medium">Locus</th><th className="px-1 text-left font-medium">Label</th>
                {columns.map(c => <th key={c.key} className="px-1 text-right font-medium" style={c.colour ? { color: c.colour } : undefined} data-testid="hub-col">{c.label}</th>)}
                {ui.compare && <th className="px-1 text-right font-medium">Δ</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const id = `${r.set.setId}|${r.hit.hitId}`;
                const sel = isSelected(r);
                const kind = roleKind(r.set, r.role);
                const d = ui.compare ? (() => { const a = valueOf(r, ui.compare![0])?.v, b = valueOf(r, ui.compare![1])?.v; return a != null && b != null ? a - b : null; })() : null;
                return <HitRows key={id} row={r} selected={sel} expanded={expanded === id} columns={columns} kind={kind} delta={ui.compare ? d : undefined} byKey={byKey}
                  onClick={e => click(r, e.shiftKey || e.metaKey || e.ctrlKey)} onToggle={() => setExpanded(expanded === id ? null : id)} />;
              })}
              {!rows.length && <tr><td colSpan={columns.length + 5} className="px-2 py-2 text-ink-secondary">No hits in view{ui.minPrevalence != null || ui.typeFilter ? ' with these filters' : ''}.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {selected.length > 0 && <section className="flex flex-wrap items-center gap-1 rounded-fb border border-indigo-200 bg-indigo-50/60 px-2 py-1 dark:border-indigo-800 dark:bg-indigo-950/30" data-testid="hub-selection">
        <span className="font-medium" data-testid="hub-selected-count">{selected.length} selected</span>
        <AnalysisButton onClick={() => setNotice(goToHits(selected) ?? '')} data-testid="hub-goto">Go to</AnalysisButton>
        <span className="text-[11px] text-ink-muted">Use as</span>
        <AnalysisButton theme="indigo" variant="soft" disabled={busy} data-testid="hub-use-anchors"
          onClick={() => { void act(() => asAnchors(selected), `Saved ${selected.length} anchor${selected.length === 1 ? '' : 's'} (kept with the session).`); }}>Anchors</AnalysisButton>
        <AnalysisButton theme="indigo" variant="soft" disabled={busy} data-testid="hub-use-cluster"
          onClick={() => { void act(() => asClusterRegions(selected), 'Clustered on the selected hits.'); }}>Cluster regions</AnalysisButton>
        <AnalysisButton theme="indigo" variant="soft" disabled={busy || !selected.some(h => h.hasStates)} data-testid="hub-use-filter"
          title="Keep the reads in state 1 (a class member, open in the NFR) at any of the selected hits that have per-read states"
          onClick={() => { void act(() => asFilter(selected, 'any'), 'Filtered the reads to members of the selected hits.'); }}>Filter</AnalysisButton>
        <AnalysisButton theme="indigo" variant="soft" data-testid="hub-use-nuc-window"
          disabled={!selected.some(h => !h.frame || h.frame.kind === 'linear' || h.frame.kind === 'lifted')}
          title="Measure nucleosomes around the first selected hit in the Nucleosomes panel's window mode (its anchor phases; the other selected hits can be its background)"
          onClick={() => {
            const h = selected.find(x => !x.frame || x.frame.kind === 'linear' || x.frame.kind === 'lifted');
            if (h) sendToNucleosomeWindow({ chrom: h.chrom, start: h.start, end: Math.max(h.end, h.start + 1), anchor: h.anchor,
              ...(h.strand ? { strand: h.strand } : {}), label: `${h.label || h.typeId} ${h.chrom}:${(h.start + 1).toLocaleString()}` });
          }}>Nucleosome window</AnalysisButton>
        <AnalysisButton theme="indigo" variant="soft" data-testid="hub-associate"
          title="Open the association builder with the selected hits' set as A"
          onClick={() => { setAssocSeed({ aKey: selected[0].setId }); setTab('assoc'); }}>Associate…</AnalysisButton>
        <AnalysisButton theme="indigo" variant="soft" data-testid="hub-overlay"
          title="Overlay the selected hits' patches: aligned density with denominators, facets and a pile"
          onClick={() => { setOverlaySeed({ loci: 'selection', at: Date.now() }); setTab('overlay'); }}>Overlay patches</AnalysisButton>
        <button type="button" className="ml-auto text-[11px] text-ink-muted hover:underline" onClick={() => setHub({ selected: [] })}>Clear</button>
      </section>}

      {hub.anchors.length > 0 && <section data-testid="hub-anchors" className="space-y-0.5">
        <div className="text-[11px] font-medium text-ink-secondary">Anchor sets</div>
        {hub.anchors.map(a => <div key={a.id} className="flex items-center gap-2 text-[11px]" data-testid="hub-anchor-set">
          <span>{a.label}</span><span className="text-ink-muted">{a.anchors.length} anchor{a.anchors.length === 1 ? '' : 's'}</span>
          <button type="button" className="text-indigo-700 hover:underline dark:text-indigo-300" onClick={() => setNotice(goToHits(a.anchors.map(p => ({ chrom: p.chrom, start: p.start ?? p.pos, end: p.end ?? p.pos + 1, frame: p.source ? undefined : p.frame }))) ?? '')}>Go to</button>
          <button type="button" className="ml-auto text-ink-muted hover:underline" onClick={() => setHub(h => ({ anchors: h.anchors.filter(x => x.id !== a.id) }))}>Remove</button>
        </div>)}
      </section>}
      </>}
    </div>
    {dialog && <ScanDialog onClose={() => setDialog(false)} />}
  </AnalysisPanelShell>;
}

function HitRows({ row, selected, expanded, columns, kind, delta, onClick, onToggle, byKey }: {
  row: Row; selected: boolean; expanded: boolean; columns: Column[]; kind?: string; delta?: number | null;
  onClick: (e: React.MouseEvent) => void; onToggle: () => void; byKey: Map<string, { set: FeatureSet; hit: FeatureHit }>;
}) {
  const { set, hit } = row;
  const ref = useRef<HTMLTableRowElement>(null);
  const dark = useBrowserStore(s => s.darkMode);
  const here = displaySpan(hit);
  const chip = liftChip(hit);
  const hap = hit.frame?.kind === 'source' ? (hit.frame.hapLabel ?? hit.frame.hap) : undefined;
  const hover = [liftText(hit), graphText(hit.graph)].filter(Boolean).join('\n');
  const matched = row.matches.map(k => byKey.get(k)).filter((m): m is { set: FeatureSet; hit: FeatureHit } => Boolean(m));
  const matchText = matched.map(m => `${m.set.type.label} · ${m.hit.frame?.kind === 'source' ? (m.hit.frame.hapLabel ?? m.hit.frame.contig) : 'this genome'}`
    + ` · ${(m.set as { scan?: { label: string } }).scan?.label ?? m.set.provenance.module} · ${(() => { const t = displaySpan(m.hit); return t ? locus(t) : locus(m.hit); })()}`).join('\n');
  return <>
    <tr ref={ref} className={`cursor-pointer border-t border-gray-100 dark:border-gray-800 ${selected ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-gray-50 dark:hover:bg-white/5'}`}
      onClick={onClick} data-testid="hub-row" data-selected={selected ? 'true' : 'false'} data-type={hit.typeId}
      data-lift={hit.lift?.status ?? ''} data-hap={hap ?? ''} title={hover || undefined}>
      <td className="px-1 text-left"><span className="rounded bg-gray-100 px-1 text-[10px] text-gray-700 dark:bg-white/10 dark:text-gray-200">{hit.typeId}</span></td>
      <td className="whitespace-nowrap px-1 text-left" data-testid="hub-row-locus">
        {here ? locus(here) : locus(hit)}{here ? (here.end <= here.start ? ' ⋮' : '') : ''}
        {hap && <span className="ml-1 text-[10px] font-semibold" style={{ color: liveLiftHaplotypeColor(hap, dark) }}>{hap}</span>}
        {chip && <span className={`ml-1 rounded px-1 text-[10px] ${CHIP_TONE[chip.tone]}`} data-testid="hub-lift-chip" title={hover}>{chip.text}</span>}
        {matched.length > 0 && <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
          data-testid="hub-match-chip" title={`The same feature in another frame or set:\n${matchText}`}>≡ {matched.length}</span>}
        {hit.flags?.includes('pinned') && <span className="ml-1 rounded bg-indigo-100 px-1 text-[10px] text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200"
          title="Kept in the legacy class or NFR cart">Pinned</span>}
        {hit.flags?.includes('open_end') && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
          title="At the edge of the scanned units: a scan reaching further may change this hit (fiberhmm-scan open_end)"
          data-testid="hub-row-open-end">open end</span>}
      </td>
      <td className="max-w-[10rem] truncate px-1 text-left" title={hit.label}>{hit.label}</td>
      {columns.map(c => {
        const v = row.role ? hit.values?.[c.key]?.[row.role] : undefined;
        const inGroups = c.key === 'all' || set.groups.some(g => g.id === c.key);
        // A value; empty: a column of the set without a value here (not measured, or no value of this kind);
        // 'absent': the column's path lacks the hit's sequence (graph columns: an insertion only some haplotypes
        // carry); '—': a column the set doesn't have (not scanned there). Never a made-up 0.
        const path = v?.v == null && c.key !== 'all' ? columnPathStatus(hit.graph, c) : undefined;
        if (path === 'absent') {
          return <td key={c.key} className="px-1 text-right text-[10px] italic text-ink-muted" data-testid="hub-cell-absent"
            title={`${c.label} lacks this sequence (graph columns): absent, not "not scanned"`}>absent</td>;
        }
        return <td key={c.key} className="px-1 text-right" title={v?.n != null ? `n = ${v.n}${v.lo != null ? ` · lower bound ${fmt(v.lo, kind)}` : ''}` : undefined}>
          {v?.v != null ? fmt(v.v, kind) : inGroups ? '' : '—'}
        </td>;
      })}
      {delta !== undefined && <td className="px-1 text-right">{delta != null ? `${delta > 0 ? '+' : ''}${fmt(delta, kind)}` : ''}</td>}
      <td className="px-1 text-right"><button type="button" aria-label={expanded ? 'Collapse' : 'Expand'} data-testid="hub-row-expand"
        onClick={e => { e.stopPropagation(); onToggle(); }} className="text-ink-muted hover:text-ink">{expanded ? '▾' : '▸'}</button></td>
    </tr>
    {expanded && <tr className="bg-gray-50/60 dark:bg-white/5" data-testid="hub-row-detail">
      <td colSpan={columns.length + 5} className="px-2 py-1">
        <div className="space-y-1">
          <div><strong>{set.type.label}</strong> {hit.label} · {hit.chrom}:{(hit.start + 1).toLocaleString()}{hit.end > hit.start ? `-${hit.end.toLocaleString()}` : ' (insertion boundary)'}{hap ? ` (${hap})` : ''}</div>
          {hit.lift && <div data-testid="hub-row-lift">{liftText(hit)}</div>}
          {hit.graph && <div className="text-ink-muted" data-testid="hub-row-graph">{graphText(hit.graph)}</div>}
          {matched.length > 0 && <div data-testid="hub-row-matches">Same feature: {matched.map(m => {
            const t = displaySpan(m.hit);
            return `${(m.set as { scan?: { label: string } }).scan?.label ?? m.set.provenance.module}${m.hit.frame?.kind === 'source' ? ` ${m.hit.frame.hapLabel ?? ''}` : ''} ${m.hit.label ?? ''} at ${t ? locus(t) : locus(m.hit)}`;
          }).join('; ')}</div>}
          <div className="text-ink-muted">{set.provenance.summary}</div>
          {set.type.stateRule && <div className="text-ink-muted">States: {set.type.stateRule}</div>}
          <div className="flex flex-wrap gap-x-3">
            {Object.entries(hit.values ?? {}).map(([col, roles]) => <span key={col}>
              {columns.find(c => c.key === col)?.label ?? col}: {Object.entries(roles).map(([r, v]) => `${r} ${fmt(v.v, r === 'prevalence' ? 'fraction' : kind)}${v.lo != null && v.hi != null ? ` [${fmt(v.lo, 'fraction')}–${fmt(v.hi, 'fraction')}]` : ''}${v.n != null ? ` (n ${v.n})` : ''}`).join(', ')}
            </span>)}
          </div>
          <div className="flex gap-1">
            <AnalysisButton onClick={() => { goToHits([hit]); }} disabled={!here} title={!here ? 'In another assembly, and it doesn\'t lift onto this genome' : undefined} data-testid="hub-row-goto">Go to</AnalysisButton>
            {hit.link && <AnalysisButton onClick={() => useBrowserStore.getState().openAnalysisPanel(hit.link!.panel)}>Open in its panel</AnalysisButton>}
            {(!hit.frame || hit.frame.kind === 'linear' || hit.frame.kind === 'lifted') && <AnalysisButton data-testid="hub-row-nuc-window"
              title="Measure nucleosomes around this hit in the Nucleosomes panel's window mode"
              onClick={() => { sendToNucleosomeWindow({ chrom: hit.chrom, start: hit.start, end: Math.max(hit.end, hit.start + 1), anchor: hit.anchor,
                ...(hit.strand ? { strand: hit.strand } : {}), label: `${hit.label || set.type.label} ${hit.chrom}:${(hit.start + 1).toLocaleString()}` }); }}>Nucleosome window</AnalysisButton>}
          </div>
        </div>
      </td>
    </tr>}
  </>;
}
