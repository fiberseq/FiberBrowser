/**
 * Window mode (DESIGN §6.2, NUC §3.7): FiberHMM's window metrics per observation inside one window (the view, a
 * selected peak, a hub hit, typed coordinates or a hand-off), with an optional anchor: the nucleosome state at the
 * anchor, the phasing in the anchor and molecule frames (whole-period bins against the molecule-level phase null,
 * the best period, positional dispersion), and with background anchors (the other selected hub hits) the dephasing
 * readout: the anchor's coherence and excess among matched backgrounds (fuzzy / dephased, NUC §13.1 kind 4).
 */
import { useState } from 'react';
import { fmt, PhasingBars, StackedShares, type SharePart } from './charts';
import { COARSE_PARTS, SEGMENT_PARTS } from './SegmentsView';
import { DEFAULT_FLANK, parseCoordinates, type WindowResolution } from './windowSource';
import type { NucObservation, NucPanelState, NucPhasing, NucWindowObservation, NucWindowSource } from './types';

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const SOURCES: Array<{ key: NucWindowSource; label: string; title: string }> = [
  { key: 'view', label: 'View', title: 'The view' },
  { key: 'peak', label: 'Selected peak', title: 'The first selected peak, ± the flank around its centre' },
  { key: 'hub', label: 'Hub hit', title: 'The first selected Feature hub hit, ± the flank around its anchor' },
  { key: 'coordinates', label: 'Coordinates', title: 'Typed coordinates' },
  { key: 'handoff', label: 'From a panel', title: 'The last window sent here from another panel (an NFR, a footprint, a hit)' },
];

export function WindowControls({ settings, setSettings, resolution, hubCount }: {
  settings: NucPanelState; setSettings: (patch: Partial<NucPanelState>) => void; resolution: WindowResolution; hubCount: number;
}) {
  const source = settings.windowSource ?? 'view';
  const anchor = settings.anchor ?? { kind: source === 'view' || source === 'coordinates' ? 'none' : 'feature', orientation: 'feature' };
  const [typed, setTyped] = useState(settings.window && source === 'coordinates' ? `${settings.window.chrom}:${settings.window.start + 1}-${settings.window.end}` : '');
  const typedOk = parseCoordinates(typed);
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid="nuc-window-controls">
    <label className="flex items-center gap-1">Window
      <select className="rounded border border-line bg-transparent px-1 dark:border-white/10" value={source} data-testid="nuc-window-source"
        onChange={e => setSettings({ windowSource: e.target.value as NucWindowSource, anchor: undefined })}>
        {SOURCES.map(s => <option key={s.key} value={s.key} title={s.title}>{s.label}</option>)}
      </select></label>
    {source === 'coordinates' && <form className="flex items-center gap-1" onSubmit={e => {
      e.preventDefault();
      if (typedOk) setSettings({ window: { ...typedOk, label: typed.trim() } });
    }}>
      <input className="w-44 rounded border border-line bg-transparent px-1 dark:border-white/10" placeholder="chr1:1,000-3,000" value={typed}
        aria-label="Window coordinates" data-testid="nuc-window-coords" onChange={e => setTyped(e.target.value)} />
      <button type="submit" className="rounded border border-line px-1 disabled:opacity-50 dark:border-white/10" disabled={!typedOk}>Set</button>
    </form>}
    {source !== 'view' && source !== 'coordinates' && <label className="flex items-center gap-1" title="Added on each side of the anchor: window metrics and phasing need the nucleosomes around it">± flank
      <input type="number" min={0} step={100} className="w-16 rounded border border-line bg-transparent px-1 dark:border-white/10"
        value={settings.flank ?? DEFAULT_FLANK} data-testid="nuc-window-flank"
        onChange={e => setSettings({ flank: Math.max(0, Number(e.target.value) || 0) })} /> bp</label>}
    <label className="flex items-center gap-1">Anchor
      <select className="rounded border border-line bg-transparent px-1 dark:border-white/10" value={anchor.kind} data-testid="nuc-anchor"
        onChange={e => setSettings({ anchor: { ...anchor, kind: e.target.value as typeof anchor.kind } })}>
        <option value="none">none</option>
        {source !== 'view' && source !== 'coordinates' && <option value="feature">{source === 'peak' ? "the peak's centre" : source === 'hub' ? "the hit's anchor" : "the panel's anchor"}</option>}
        <option value="centre">window centre</option>
        <option value="position">position…</option>
      </select></label>
    {anchor.kind === 'position' && <input type="number" className="w-28 rounded border border-line bg-transparent px-1 dark:border-white/10" aria-label="Anchor position"
      value={anchor.pos ?? ''} data-testid="nuc-anchor-pos" placeholder="position (bp)"
      onChange={e => setSettings({ anchor: { ...anchor, pos: e.target.value === '' ? undefined : Number(e.target.value) - 1 } })} />}
    {anchor.kind !== 'none' && <label className="flex items-center gap-1" title="Unoriented pools both flanks by distance; + or − keeps the downstream flank of a stranded anchor">Orientation
      <select className="rounded border border-line bg-transparent px-1 dark:border-white/10" value={String(anchor.orientation)} data-testid="nuc-orientation"
        onChange={e => setSettings({ anchor: { ...anchor, orientation: e.target.value === 'feature' ? 'feature' : Number(e.target.value) as 0 | 1 | -1 } })}>
        <option value="feature">from the feature's strand</option>
        <option value="0">unoriented</option>
        <option value="1">+ (downstream)</option>
        <option value="-1">− (downstream)</option>
      </select></label>}
    {anchor.kind !== 'none' && <label className="flex items-center gap-1" title="Background anchors for the dephasing readout: comparable loci without the property under test">Background
      <select className="rounded border border-line bg-transparent px-1 dark:border-white/10" value={settings.background ?? 'none'} data-testid="nuc-background"
        onChange={e => setSettings({ background: e.target.value as 'none' | 'hub' })}>
        <option value="none">none</option>
        <option value="hub" disabled={hubCount < 2}>other selected hub hits ({Math.max(0, hubCount - (source === 'hub' ? 1 : 0))})</option>
      </select></label>}
    <span className="text-ink-muted" data-testid="nuc-window-label">{'error' in resolution ? resolution.error : resolution.label}
      {'error' in resolution ? '' : resolution.anchor ? ` · anchor ${(resolution.anchor.pos + 1).toLocaleString()}${resolution.anchor.orientation ? (resolution.anchor.orientation > 0 ? ' (+)' : ' (−)') : ''}` : ''}
      {'error' in resolution || !resolution.background.length ? '' : ` · ${resolution.background.length} background anchors`}</span>
  </div>;
}

/** The summary bin of a phasing result (all flank bins pooled: the last bin), as R − null with its p. */
function phasingSummary(ph?: NucPhasing): string {
  const b = ph?.bins?.[ph.bins.length - 1];
  if (!b || b.R_minus_null == null) return '—';
  return `${fmt(b.R_minus_null, 2)}${b.null_p != null && b.null_p < 0.05 ? '*' : ''}`;
}

export function WindowView({ observations, results, loading }: {
  observations: NucObservation[]; results: Record<string, NucWindowObservation>; loading: boolean;
}) {
  const anyAnchor = Object.values(results).some(r => r.metrics?.phasing);
  const anyDephasing = Object.values(results).some(r => r.metrics?.dephasing);
  return <div className="overflow-x-auto">
    <table className="w-full text-[11px]" data-testid="nuc-window-table">
      <thead className="text-ink-muted">
        <tr>
          <th className="px-1 text-left">Observation</th>
          <th className="px-1 text-right" title="Molecules measured over at least 80% of the window · below the low-information floor (left out)">Molecules</th>
          <th className="px-1 text-left" title="Coarse calls of footprints centred in the window">Class mix</th>
          <th className="px-1 text-right" title="Per-molecule repeat length in the window: median [IQR] · too short">NRL</th>
          <th className="px-1 text-left" title="Mean share of each molecule's window in regular / disordered / undetermined / low-information segments">Segments</th>
          <th className="px-1 text-right" title="Missing nucleosomes per molecule · mean undersized share">Missing · undersized</th>
          {anyAnchor && <>
            <th className="px-1 text-right" title="Molecules with a nucleosome over the anchor / open there / not measured">At anchor</th>
            <th className="px-1 text-left" title="Anchor frame: R − null per whole-period bin (solid: p < 0.05; tick: best period); summary over all bins (* p < 0.05)">Phasing (anchor)</th>
            <th className="px-1 text-left" title="Molecule frame: dyad phase relative to each molecule's own grid">Phasing (molecule)</th>
            <th className="px-1 text-right" title="Positional dispersion of the nearest dyads across molecules (bp)">σ</th>
          </>}
          {anyDephasing && <th className="px-1 text-right" title="Coherence at the anchor among matched background anchors: p(dephased) = share of backgrounds at or below it; excess the same">Dephasing</th>}
        </tr>
      </thead>
      <tbody>
        {observations.map(o => <WindowRow key={o.obsId} obs={o} result={results[o.obsId]} loading={loading} anchorCols={anyAnchor} dephasingCol={anyDephasing} />)}
      </tbody>
    </table>
  </div>;
}

function WindowRow({ obs, result, loading, anchorCols, dephasingCol }: {
  obs: NucObservation; result?: NucWindowObservation; loading: boolean; anchorCols: boolean; dephasingCol: boolean;
}) {
  const m = result?.metrics;
  const cols = 5 + (anchorCols ? 4 : 0) + (dephasingCol ? 1 : 0);
  const mix = m?.class_mix ?? {};
  const coarse: SharePart[] = COARSE_PARTS.map(p => ({ ...p, value: mix[p.key] ?? 0 }));
  const segs: SharePart[] = SEGMENT_PARTS.map(p => ({ ...p, value: (m?.[`${p.key}_fraction` as 'regular_fraction'] ?? 0) as number }));
  const q = m?.nrl_quantiles;
  const st = m?.state_counts;
  const dep = m?.dephasing;
  return <tr className="border-t border-gray-100 align-middle dark:border-gray-800" data-testid="nuc-window-row" data-obs={obs.obsId}>
    <td className="px-1 text-left">
      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: obs.color }} />
      <span className="align-middle">{obs.label}</span>
      {result?.anchorNote && <span className="ml-1 text-amber-700 dark:text-amber-300" title={result.anchorNote}>⚠</span>}
    </td>
    {result?.error ? <td colSpan={cols} className="px-1 text-left text-amber-700 dark:text-amber-300" data-testid="nuc-window-error">{result.error}</td>
      : !result ? <td colSpan={cols} className="px-1 text-left text-ink-muted">{loading ? '…' : ''}</td>
      : !m ? <td colSpan={cols} className="px-1 text-left text-ink-muted">{result.notComputed ? `${result.notComputed} molecules not computed yet: Compute in view` : 'No molecule covers the window'}</td>
      : <>
        <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-window-molecules"
          title={`${m.n_molecules ?? 0} molecules measured${m.excluded_low_information ? `, ${m.excluded_low_information} low-information left out` : ''}${result.notComputed ? `, ${result.notComputed} not computed` : ''}`}>
          {m.n_molecules ?? 0}{m.excluded_low_information ? <span className="text-ink-muted"> · {m.excluded_low_information} low</span> : null}</td>
        <td className="px-1 text-left">
          <div className="flex items-center gap-1">
            <StackedShares parts={coarse} width={96} testId="nuc-window-mix" />
            {m.insufficient && <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" data-testid="nuc-insufficient"
              title="Can't-tell calls dominate this window: its size mix is not informative">insufficient</span>}
          </div>
        </td>
        <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-window-nrl">{q ? `${Math.round(q[2])} [${Math.round(q[1])}–${Math.round(q[3])}]` : '—'}
          <span className="text-ink-muted"> · {pct(m.too_short_fraction)}</span></td>
        <td className="px-1 text-left"><StackedShares parts={segs} width={96} testId="nuc-window-seg" /></td>
        <td className="whitespace-nowrap px-1 text-right">{fmt(m.missing_per_molecule, 2)} · {pct(m.undersized_fraction)}</td>
        {anchorCols && <>
          <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-window-state" title="nucleosome / open / not measured at the anchor">
            {st ? `${st['1'] ?? 0} / ${st['0'] ?? 0} / ${st['.'] ?? 0}` : '—'}</td>
          <td className="px-1 text-left"><div className="flex items-center gap-1">
            <PhasingBars bins={m.phasing?.anchor?.bins?.slice(0, -1) ?? []} color={obs.color} width={72} height={18} testId="nuc-phasing-anchor" />
            <span title={m.phasing?.anchor ? `period ${fmt(m.phasing.anchor.P, 0)} bp · ${m.phasing.anchor.n_molecules} molecules` : undefined}>{phasingSummary(m.phasing?.anchor)}</span></div></td>
          <td className="px-1 text-left"><div className="flex items-center gap-1">
            <PhasingBars bins={m.phasing?.molecule?.bins?.slice(0, -1) ?? []} color={obs.color} width={72} height={18} testId="nuc-phasing-molecule" />
            <span title={m.phasing?.molecule ? `period ${fmt(m.phasing.molecule.P, 0)} bp · ${m.phasing.molecule.n_molecules} molecules` : undefined}>{phasingSummary(m.phasing?.molecule)}</span></div></td>
          <td className="whitespace-nowrap px-1 text-right">{fmt(m.phasing?.anchor?.dispersion_bp, 0)}</td>
        </>}
        {dephasingCol && <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-dephasing"
          title={dep ? [`coherence ${fmt(dep.coherence.value, 3)} (matched background median ${fmt(dep.coherence.background_median, 3)}, ${dep.coherence.n_matched} matched)`,
            `excess ${fmt(dep.excess.value, 3)} (median ${fmt(dep.excess.background_median, 3)})`,
            `${dep.n_background} background anchors on this observation`].join('\n') : undefined}>
          {dep ? `p ${fmt(dep.coherence.p_dephased, 2)} · ${dep.coherence.n_matched}` : '—'}</td>}
      </>}
  </tr>;
}
