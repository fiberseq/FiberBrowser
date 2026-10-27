/**
 * Segments mode (DESIGN §6.1): per observation, molecule-wide outputs in view, side by side. Sizes as the coarse
 * calls (short / mono / long / multi / can't tell, hatched, never dropped) and the density-matched z distribution;
 * spacing as the per-molecule repeat length distribution, regularity S and the too-short share; array segments as
 * regular / disordered / undetermined / low-information shares with the disruption events. Every bar part and NRL bin
 * highlights its molecules in every read track.
 */
import { MiniHistogram, StackedShares, type SharePart } from './charts';
import type { NucCategory } from './api';
import type { NucObservation, NucObservationSummary } from './types';

const pct = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(digits));

export const COARSE_PARTS: Array<{ key: string; label: string; color: string; hatched?: boolean }> = [
  { key: 'short', label: 'short (z < −2)', color: '#f59e0b' },
  { key: 'mono', label: 'mono', color: '#16a34a' },
  { key: 'long', label: 'long (z > 2)', color: '#0d9488' },
  { key: 'multi2', label: 'multi (2)', color: '#2563eb' },
  { key: 'multi3', label: 'multi (3+)', color: '#7c3aed' },
  { key: 'cant_tell', label: "can't tell", color: '#9ca3af', hatched: true },
  { key: 'edge_truncated', label: 'edge-truncated', color: '#d1d5db', hatched: true },
];
export const SEGMENT_PARTS: Array<{ key: 'regular' | 'disordered' | 'undetermined' | 'low_information'; label: string; color: string; hatched?: boolean }> = [
  { key: 'regular', label: 'regular', color: '#15803d' },
  { key: 'disordered', label: 'disordered', color: '#ea580c' },
  { key: 'undetermined', label: 'undetermined', color: '#cbd5e1' },
  { key: 'low_information', label: 'low information', color: '#94a3b8', hatched: true },
];

export function SegmentsView({ observations, summaries, loading, onHide, onSelect }: {
  observations: NucObservation[];
  summaries: Record<string, NucObservationSummary>;
  loading: boolean;
  onHide: (obsId: string) => void;
  onSelect: (obs: NucObservation, category: NucCategory) => void;
}) {
  return <div className="overflow-x-auto">
    <table className="w-full text-[11px]" data-testid="nuc-table">
      <thead className="text-ink-muted">
        <tr>
          <th className="px-1 text-left">Observation</th>
          <th className="px-1 text-right" title="Molecules with outputs / records in view">Molecules</th>
          <th className="px-1 text-left" title="Coarse size calls of footprints centred in view (nucleosome and TF calls); click a part to highlight its molecules">Size classes</th>
          <th className="px-1 text-left" title="Density-matched z of short, mono and long calls (dashed: ±2)">z</th>
          <th className="px-1 text-left" title="Per-molecule repeat length (median of dyad gaps): distribution, median [IQR]; click a bar to highlight its molecules">NRL</th>
          <th className="px-1 text-right" title="Per-molecule regularity S, median; too short for a repeat length">S · short</th>
          <th className="whitespace-nowrap px-1 text-left" title="Share of segmented bases in view: regular / disordered / undetermined / low information; click a part to highlight">Segments</th>
          <th className="px-1 text-right" title="Undersized footprint runs · missing nucleosomes in view; click to highlight">Events</th>
        </tr>
      </thead>
      <tbody>
        {observations.map(o => <Row key={o.obsId} obs={o} summary={summaries[o.obsId]} loading={loading} onHide={() => onHide(o.obsId)}
          onSelect={category => onSelect(o, category)} />)}
      </tbody>
    </table>
  </div>;
}

function Row({ obs, summary, loading, onHide, onSelect }: {
  obs: NucObservation; summary?: NucObservationSummary; loading: boolean; onHide: () => void; onSelect: (c: NucCategory) => void;
}) {
  const s = summary;
  const nrl = s?.spacing?.nrl;
  const seg = s?.segments;
  const coarse: SharePart[] = COARSE_PARTS.map(p => ({ ...p, value: s?.sizes?.coarse[p.key as keyof NonNullable<NucObservationSummary['sizes']>['coarse']] ?? 0 }));
  const segments: SharePart[] = SEGMENT_PARTS.map(p => ({ ...p, value: (seg?.[p.key] ?? 0) as number }));
  return <tr className="border-t border-gray-100 align-middle dark:border-gray-800" data-testid="nuc-row" data-obs={obs.obsId} data-kind={obs.kind}>
    <td className="px-1 text-left">
      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: obs.color }} />
      <span className="align-middle" title={`${obs.label}${obs.kind === 'graph' ? ' (graph path: every molecule over the path, insertions included)' : ''}${obs.readIds ? ` · ${obs.readIds.length} reads in scope` : ''}`}>{obs.label}</span>
      <button type="button" aria-label={`Hide ${obs.label}`} className="ml-1 text-ink-muted hover:text-ink" onClick={onHide}>×</button>
      {s?.sources?.some(x => x !== 'live') && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300"
        data-testid="nuc-source" title={`Outputs read from ${s.sources.filter(x => x !== 'live').map(x => x === 'annotated' ? "the BAM's own nucleosome groups" : 'an opened scan').join(' and ')}${s.sources.includes('live') ? ', the rest computed here' : ''}`}>
        {s.sources.includes('annotated') ? 'BAM tags' : 'scan'}</span>}
    </td>
    {s?.error ? <td colSpan={7} className="px-1 text-left text-amber-700 dark:text-amber-300">{s.error}</td> : <>
      <td className="whitespace-nowrap px-1 text-right" data-testid="nuc-molecules"
        title={s ? [`${s.computed ?? 0} molecules with outputs of ${s.records ?? 0} records in view`,
          s.undecodable ? `${s.undecodable} records without calls FiberHMM can read` : '',
          s.notComputed ? `${s.notComputed} not computed yet` : '',
          s.lowInformation ? `${s.lowInformation} below the low-information floor (counted, left out of segments)` : ''].filter(Boolean).join('\n') : undefined}>
        {s ? `${(s.computed ?? 0).toLocaleString()} / ${(s.records ?? 0).toLocaleString()}` : loading ? '…' : ''}
        {s?.lowInformation ? <span className="text-ink-muted"> · {s.lowInformation} low</span> : null}</td>
      <td className="px-1 text-left">
        <StackedShares parts={coarse} testId="nuc-coarse-bar" onPart={key => onSelect({ kind: 'coarse', name: key })}
          title={`${COARSE_PARTS.map(p => `${p.label}: ${s?.sizes?.coarse[p.key as 'mono'] ?? 0}`).join('\n')}\nTF calls among them: ${s?.sizes?.tf ?? 0}\ncan't tell or truncated: ${pct(s?.sizes?.cantTellFraction)}`} />
      </td>
      <td className="px-1 text-left">{s?.sizes?.z ? <MiniHistogram edges={s.sizes.z.edges} counts={s.sizes.z.counts} color={obs.color} width={84} height={20} marks={[-2, 2]} testId="nuc-z" /> : null}</td>
      <td className="whitespace-nowrap px-1 text-left" data-testid="nuc-nrl">
        {nrl ? <div className="flex items-center gap-1">
          <MiniHistogram edges={nrl.edges} counts={nrl.counts} color={obs.color} width={96} height={20} unit=" bp" testId="nuc-nrl-hist"
            onBin={(lo, hi) => onSelect({ kind: 'nrl', lo, hi })} />
          <span>{nrl.quantiles ? `${num(nrl.quantiles[2])} [${num(nrl.quantiles[1])}–${num(nrl.quantiles[3])}]` : ''}</span>
        </div> : null}
      </td>
      <td className="whitespace-nowrap px-1 text-right">{num(s?.spacing?.regularity?.[2], 2)}{s?.spacing ? ` · ${pct(s.spacing.tooShortFraction)}` : ''}</td>
      <td className="px-1 text-left" data-testid="nuc-segments">
        {seg?.bp ? <StackedShares parts={segments} testId="nuc-seg-bar" onPart={key => onSelect({ kind: 'segment', state: key })}
          title={SEGMENT_PARTS.map(p => `${p.label}: ${pct(seg[p.key])}`).join('\n')} /> : null}
        {seg?.bp ? <span className="sr-only">{`${pct(seg.regular)} · ${pct(seg.disordered)} · ${pct(seg.undetermined)} · ${pct(seg.low_information)}`}</span> : null}
      </td>
      <td className="whitespace-nowrap px-1 text-right">{seg ? <>
        <button type="button" className="underline decoration-dotted" title="Undersized footprint runs: highlight their molecules" data-testid="nuc-undersized"
          onClick={() => onSelect({ kind: 'event', name: 'undersized' })}>{seg.undersizedRuns}</button>{' · '}
        <button type="button" className="underline decoration-dotted" title="Missing nucleosomes: highlight their molecules" data-testid="nuc-missing"
          onClick={() => onSelect({ kind: 'event', name: 'missing' })}>{seg.missingNucleosomes}</button>
      </> : ''}</td>
    </>}
  </tr>;
}
