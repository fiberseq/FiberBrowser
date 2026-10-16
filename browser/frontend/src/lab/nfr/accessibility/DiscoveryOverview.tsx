/** Accessibility (preview): the pieces of an NFR card: variant lanes, a variant's row and mini profile, the statistics. */
import { useRef } from 'react';
import { type AccessibilityResult, type NfrProfiles, type NfrRegionResult, type NfrVariant } from '../api';
import { bp, pct, prevalenceRange, prevalenceTitle, strandSplit, variantColor } from '../accessibilityView';
import { useBrowserStore } from '../../../stores/browserStore';
import { useFeatureStore, type FeatureRef } from '../../../stores/featureStore';
import { variantTypeHelp } from './nfrHelp';
import { CheckboxRow } from '../../../components/controls/shared/CheckboxRow';
/** Stacked bars of an NFR's variants over its region (one lane per variant, edge SD as faint whiskers). */
export function VariantLanes({ nfr, width, highlight }: { nfr: NfrRegionResult; width: number; highlight?: string | null }) {
  const vs = nfr.variants;
  const lo = Math.min(nfr.start, ...vs.map(v => v.L - v.Lsd)) - 40;
  const hi = Math.max(nfr.end, ...vs.map(v => v.R + v.Rsd)) + 40;
  const lane = 13, top = 4, h = top + Math.max(1, vs.length) * lane + 14;
  const x = (p: number) => ((p - lo) / Math.max(1, hi - lo)) * width;
  return (
    <svg width={width} height={h} role="img" aria-label={`${nfr.id}: ${vs.length} variants over ${bp(nfr.start)}–${bp(nfr.end)}`} data-testid="nfr-lanes">
      <rect x={x(nfr.start)} y={0} width={Math.max(1, x(nfr.end) - x(nfr.start))} height={h - 12} rx={3}
        className="fill-fuchsia-50 dark:fill-fuchsia-900/20" />
      {vs.map((v, i) => {
        const y = top + i * lane;
        const c = variantColor(v.name);
        const dim = highlight && highlight !== v.name;
        return (
          <g key={v.id} opacity={dim ? 0.35 : 1}>
            <line x1={x(v.L - v.Lsd)} x2={x(v.L + v.Lsd)} y1={y + 4.5} y2={y + 4.5} stroke={c} strokeOpacity={0.45} strokeWidth={1} />
            <line x1={x(v.R - v.Rsd)} x2={x(v.R + v.Rsd)} y1={y + 4.5} y2={y + 4.5} stroke={c} strokeOpacity={0.45} strokeWidth={1} />
            <rect x={x(v.L)} y={y} width={Math.max(2, x(v.R) - x(v.L))} height={9} rx={2} fill={c} fillOpacity={0.35 + 0.55 * Math.min(1, v.prevalence * 1.4)}>
              <title>{`${nfr.id} ${v.name} ${v.relation}: ${bp(v.L)}–${bp(v.R)} (${bp(v.width)} bp), ${pct(v.prevalence)} of callable reads`}</title>
            </rect>
            <text x={Math.min(width - 2, x(v.R) + 3)} y={y + 8} fontSize={9} className="fill-gray-500 dark:fill-gray-400"
              textAnchor={x(v.R) + 24 > width ? 'end' : 'start'}>{v.name}</text>
          </g>
        );
      })}
      <text x={0} y={h - 2} fontSize={9} className="fill-gray-400">{bp(lo)}</text>
      <text x={width} y={h - 2} fontSize={9} textAnchor="end" className="fill-gray-400">{bp(hi)}</text>
    </svg>
  );
}

/** A variant's mini profile: the share of its member reads open at each position (the NFR's callable reads, grey). */
export function MiniProfile({ profiles, name, color, width = 96, height = 20 }: {
  profiles: NfrProfiles | null; name: string; color: string; width?: number; height?: number;
}) {
  if (!profiles) return <span className="inline-block animate-pulse rounded bg-gray-100 dark:bg-white/5" style={{ width, height }} />;
  const mine = profiles.variants[name]?.profile ?? [];
  const n = profiles.x.length;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, n - 1)) * width).toFixed(1)},${(height - 1 - v * (height - 2)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label={`${name}: share of member reads open across the NFR`} data-testid="nfr-mini-profile">
      <path d={`${path(profiles.all.profile)} L${width},${height} L0,${height} Z`} className="fill-gray-200 dark:fill-white/10" />
      <path d={path(mine)} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

export function VariantRow({ v, nfr, profiles, checked, focused, onToggle, onHover, feature, featureSelected, featureHovered }: {
  v: NfrVariant; nfr: NfrRegionResult; profiles: NfrProfiles | null; checked: boolean;
  /** Clicked in the NFR channel or on the arcs (ringed until another is). */
  focused?: boolean;
  onToggle: (on: boolean) => void; onHover: (on: boolean) => void;
  feature?: FeatureRef | null; featureSelected?: boolean; featureHovered?: boolean;
}) {
  const color = variantColor(v.name);
  const members = profiles?.variants[v.name]?.n;
  // A modifier click selects the variant as a feature and must not tick or untick it, also when it lands on the box
  // itself (the label's activation is cancelled below; a click on the input fires its change first).
  const modifier = useRef(false);
  // The row is the shared CheckboxRow (a 16-px box, the whole row toggles it); the wrapper keeps the row's hover,
  // shift-click (select as a feature: it cancels the toggle) and rings.
  return (
    <div data-testid="nfr-variant-row" data-variant={v.id} data-feature-selected={featureSelected || undefined} data-feature-hovered={featureHovered || undefined}
      data-focused={focused || undefined}
      onMouseEnter={() => { onHover(true); if (feature) useFeatureStore.getState().setHover(feature); }}
      onMouseLeave={() => { onHover(false); useFeatureStore.getState().setHover(null); }}
      onClickCapture={e => { modifier.current = !!feature && (e.shiftKey || e.metaKey || e.ctrlKey); }}
      onClick={e => {
        // Shift / ctrl / cmd-click: select the variant as a feature (the checkbox ticks it for the card's views).
        if (!feature || !(e.shiftKey || e.metaKey || e.ctrlKey)) return;
        // On the words: cancel the label's click on the box. On the box itself its change is ignored (the controlled
        // box keeps its state); cancelling there too would flip it back twice in some engines.
        if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
        useBrowserStore.getState().selectFeature(feature, true);
      }}
      className={`rounded hover:bg-fuchsia-50/50 dark:hover:bg-white/[0.03] ${featureSelected ? 'ring-2 ring-inset ring-gray-900 dark:ring-gray-100' : ''} ${featureHovered ? 'bg-fuchsia-50 dark:bg-white/[0.05]' : ''} ${focused && !featureSelected ? 'ring-2 ring-inset ring-fuchsia-400' : ''}`}>
      <CheckboxRow checked={checked} onChange={on => { if (!modifier.current) onToggle(on); }} testId="nfr-variant-check" className="py-1 text-[12px] hover:!bg-transparent [&_input]:accent-fuchsia-600"
        title={`Ticked: ${nfr.id} ${v.name} is in this card's views (motif map, V-plots, ...) and its split by combination pattern. Shift-click: select it for Cluster, Sort and Filter in the main toolbar`}
        label={
          <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <span className="min-w-0">
              <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ background: color }} />
              <span className="font-semibold">{v.name}</span>{' '}
              <span className="text-gray-600 dark:text-gray-300" title={variantTypeHelp(v.relation)} data-testid="nfr-variant-type">{v.relation}</span>
              <span className="block truncate text-[11px] tabular-nums text-ink-muted">{bp(v.L)}–{bp(v.R)} · {bp(v.width)} bp</span>
            </span>
            <span className="text-right tabular-nums" title={`${prevalenceTitle(v)}; interval: read bootstrap, holding the variant set fixed`}>
              <span className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">{pct(v.prevalence)}</span>
              {v.ci && <span className="ml-1 text-[10px] text-ink-muted" title="95% interval (read bootstrap, the variant set held fixed)">[{Math.round(v.ci[0] * 100)}–{Math.round(v.ci[1] * 100)}]</span>}
              <span className="block text-[10px] text-ink-muted" title="Member reads (P >= 0.5) of the reads callable at this NFR">
                {members != null ? `${members.toLocaleString()} of ${nfr.callable.toLocaleString()}` : `of ${nfr.callable.toLocaleString()}`} reads
              </span>
            </span>
            <span className="hidden sm:block"><MiniProfile profiles={profiles} name={v.name} color={color} /></span>
          </span>
        } />
    </div>
  );
}

/** The statistics behind the overview (round 1's table): strict-to-EM range, interval, strands, support. */
export function NfrDetails({ nfr, multiChannel, classesJoined, datasetLabel, result }: {
  nfr: NfrRegionResult; multiChannel: boolean; classesJoined: boolean; datasetLabel: (id: string) => string; result: AccessibilityResult;
}) {
  void result;
  return (
    <div className="mt-1.5 space-y-1 rounded-md bg-gray-50 p-2 text-[11px] dark:bg-white/[0.03]" data-testid="nfr-details">
      {nfr.mode === 'variants' && nfr.k != null && (
        <p className="text-gray-500" title="k: the largest number of edge clusters that split-half prediction strength still supports at the chosen stringency. Merged: candidates the held-out test could not tell apart. Dropped: candidates without enough support, reads or stability.">
          k = {nfr.k} by prediction strength · {nfr.merges?.length ?? 0} merged · {nfr.dropped?.length ?? 0} dropped
          {nfr.dropped?.length ? ` (${nfr.dropped.map(d => `${bp(d.L)}–${bp(d.R)}: ${(d.reasons ?? []).join(', ') || 'support'}`).join('; ')})` : ''}
          {' · '}closed {pct(nfr.closed)} · other shapes {pct(nfr.other?.em)}
          {nfr.censored ? ` · ${nfr.censored.toLocaleString()} edge-censored` : ''}{nfr.source === 'detected' ? ' · region detected' : ''}
        </p>
      )}
      <table className="w-full tabular-nums">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="font-medium">Variant</th>
            <th className="font-medium" title="From strict (reads at least 90% sure) to the EM estimate, lower first; in brackets the read-bootstrap interval, which holds the variant set fixed.">Strict–EM</th>
            {multiChannel && <th className="font-medium" title="Prevalence on each DAF strand (CT, GA) separately (per dataset when there are several).">CT / GA</th>}
            <th className="font-medium" title="Held-out log-likelihood the variant adds (nats), its split-half stability, and the share of reordered reruns that find it.">Support</th>
            <th className="font-medium" title="Timer depth from the median width">Depth</th>
          </tr>
        </thead>
        <tbody>
          {nfr.variants.map(v => (
            <tr key={v.id} className="border-t border-gray-200/70 dark:border-white/5">
              <td className="py-0.5 pr-2"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: variantColor(v.name) }} />{v.name}
                <span className="ml-1 text-ink-secondary" title={`Left edge ${bp(v.L)} ± ${v.Lsd.toFixed(0)} bp, right edge ${bp(v.R)} ± ${v.Rsd.toFixed(0)} bp`}>±{v.Lsd.toFixed(0)}/{v.Rsd.toFixed(0)}</span></td>
              <td className="pr-2" title={prevalenceTitle(v)}>{prevalenceRange(v)} {v.ci && <span className="text-ink-secondary">[{pct(v.ci[0])}–{pct(v.ci[1])}]</span>}</td>
              {multiChannel && <td className="pr-2 text-gray-500">{strandSplit(v, datasetLabel)}</td>}
              <td className="pr-2 text-gray-500">{bp(v.gain_nats)} nats · {v.stability.toFixed(2)}{v.robust != null ? ` · ${pct(v.robust)} of orders` : ''}</td>
              <td className="text-gray-500">{v.depth}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nfr.configurations.length > 0 && (
        <div data-testid="nfr-configurations">
          <span className="text-gray-500" title="What each read carries in this region: one variant, two on the same read (a split or a satellite), 'other' (an opening that fits no variant) or closed.">Per read: </span>
          {nfr.configurations.slice(0, 8).map(c => (
            <span key={c.label} className="mr-2 whitespace-nowrap" title={c.internal_footprint && classesJoined ? 'The protected stretch between these two openings has the position and size of a supported footprint class (Find classes on these reads): it may be one NFR with a factor bound inside rather than two NFRs. This is a match of positions, not checked read by read.' : undefined}>
              {c.display_label !== c.label && classesJoined ? <span className="text-fuchsia-700 dark:text-fuchsia-300">{c.display_label}</span> : c.label} {pct(c.weight)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Variant ids of the run, in NFR order (for "Save all"). */
export function allVariantIds(result: AccessibilityResult | null): string[] {
  return (result?.nfrs ?? []).flatMap(n => n.variants.map(v => v.id));
}
