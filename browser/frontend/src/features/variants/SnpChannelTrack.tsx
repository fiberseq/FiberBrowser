// SnpChannelTrack - the SNP channel above a dataset panel's reads: the SNPs the Variants panel found in this dataset's
// view, one tick each (its height the minor-allele fraction; amber: a DAF call that looks like deamination). Hover
// highlights the SNP's row in the Variants panel and back; a click selects it (shift-click: several), for "Split into
// panels" and the Combinations tab. A standard sub-track ('snps'), registered like the other channels; collapsible.
// A panel split by SNP allele always draws the SNP(s) it was split by, its allele as a coloured letter (its own reads'
// scan has no SNP there: they all carry that allele).
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Snp, SnpScan } from './api';
import type { PanelConfig } from '../../types';
import type { SplitSnp } from '../types';
import { CIGAR_COLORS } from '../../components/tracks/read-track/constants';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { sameChrom } from '../../utils/chromAliases';
import { trackX } from '../../utils/consensusTrack';
import {
  VARIANTS_PANEL, normalizeVariantsState, scanFor, selectSnp, shownSnps, snpLabel, updateVariantsState,
  useVariantsPanelState, useVariantsStore, type VariantsPanelState,
} from './variantsState';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { HoverLabel, useTrackLabels } from '../../components/tracks/TrackLabels';
import { TRACK_BACKGROUND } from '../../components/tracks/TrackContainerConstants';

export const SNP_CHANNEL_HEADER = 18;
export const SNP_CHANNEL_HEIGHT = SNP_CHANNEL_HEADER + 26;
/** A split panel's channel with no scan ticks: just its allele pill, just above the reads. */
export const SNP_CHANNEL_SPLIT_HEIGHT = 30;

const PILL_W = 17, PILL_H = 17;

const PASS = '#db2777';
const DEAMINATION = '#d97706';
const FAILING = '#94a3b8';

/** The scan a panel draws: its dataset's, on its chromosome and overlapping its view. */
export function snpScanForView(scan: SnpScan | null, chrom: string, start: number, end: number): SnpScan | null {
  if (!scan) return null;
  const r = scan.region;
  return sameChrom(r.chrom, chrom) && r.start < end && r.end > start ? scan : null;
}

/** A split allele's pill colour (white letter on it). */
export const ALLELE_COLOURS: Record<string, string> = { A: '#2e9e44', C: '#1f5fbf', G: '#f2a900', T: '#d62728' };

export function baseColour(base: string | null | undefined): string {
  return ALLELE_COLOURS[(base ?? '').toUpperCase()] ?? CIGAR_COLORS.N;
}

export interface PanelSplitSnp { snp: SplitSnp; allele: string | null }

/** The SNPs a split panel was made by (its rule), with its allele at each, in a view. */
export function splitSnpsInView(panel: Pick<PanelConfig, 'readSubset'> | undefined, chrom: string, start: number, end: number): PanelSplitSnp[] {
  const rule = panel?.readSubset?.rule;
  if (!rule?.splitSnps?.length) return [];
  return rule.splitSnps.map((snp, i) => ({ snp, allele: rule.splitAlleles?.[i] ?? null }))
    .filter(({ snp }) => sameChrom(snp.chrom, chrom) && snp.pos >= Math.floor(start) && snp.pos < Math.ceil(end));
}

/** The panel key a channel's own scan is under (variantsState.latestKey). */
const panelKeyOf = (panel: Pick<PanelConfig, 'stateKey' | 'datasetId' | 'id'> | undefined) => (panel ? panel.stateKey ?? panel.datasetId ?? panel.id : undefined);

/**
 * What a panel's channel draws (render and layout alike): the scan's SNPs in view while the Variants panel is open,
 * and the SNPs it was split by always (a figure of the split, the Variants panel closed).
 */
export function snpChannelContent(datasetId: string | null | undefined, chrom: string, start: number, end: number,
  panel: PanelConfig | undefined, store: Parameters<typeof scanFor>[1], panelState: VariantsPanelState | undefined, open: boolean,
): { scan: SnpScan | null; snps: Snp[]; splitSnps: PanelSplitSnp[] } {
  const splitSnps = splitSnpsInView(panel, chrom, start, end);
  const found = snpScanForView(scanFor(datasetId, store, panelState, panelKeyOf(panel)), chrom, start, end);
  const scan = open || !splitSnps.length ? found : null;
  const snps = shownSnps(scan, normalizeVariantsState(panelState).passingOnly).filter(s => s.pos >= start && s.pos < end);
  return { scan, snps, splitSnps };
}

/** The channel's layout for a panel: 'full' (scan ticks), 'split' (only its split SNPs: a short row), or false (none). */
export function useSnpChannelShown(): (datasetId: string | null | undefined, chrom: string, start: number, end: number, panel?: PanelConfig) => false | 'full' | 'split' {
  const store = useVariantsStore(useShallow(s => ({ scans: s.scans, latest: s.latest })));
  const panelState = useVariantsPanelState();
  const open = useBrowserStore(s => s.panels.some(p => p.contentType === VARIANTS_PANEL));
  return useMemo(() => (datasetId, chrom, start, end, panel) => {
    if (!datasetId) return false;
    const c = snpChannelContent(datasetId, chrom, start, end, panel, store, panelState, open);
    if (c.splitSnps.length) return c.snps.length ? 'full' : 'split';
    return open && c.scan ? 'full' : false;
  }, [store, panelState, open]);
}

/** A split panel's guide through the reads at its SNPs: on unless turned off (one undo-free toggle). */
export function setSplitSnpGuide(panelId: string, on: boolean): void {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.id === panelId && p.readSubset
      ? { ...p, readSubset: { ...p.readSubset, rule: { ...p.readSubset.rule, splitSnpGuide: on } } } : p)),
  }));
}

function setCollapsed(panelId: string, collapsed: boolean) {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.id === panelId ? { ...p, subTracks: p.subTracks.map(t => (t.type === 'snps' ? { ...t, collapsed } : t)) } : p)),
  }));
}

function colour(snp: Snp): string {
  if (snp.daf_safe === false) return DEAMINATION;
  return snp.passes ? PASS : FAILING;
}

export function SnpChannelTrack({ width, height, datasetId, panelId, collapsed = false, sidebarWidth = 0, overrideChrom, overrideStart, overrideEnd }: {
  width: number; height: number; datasetId: string; panelId: string; collapsed?: boolean; sidebarWidth?: number;
  overrideChrom?: string; overrideStart?: number; overrideEnd?: number;
}) {
  const overlayLabels = useTrackLabels();
  const view = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end, isReversed: s.isReversed })));
  const chrom = overrideChrom ?? view.chrom, start = overrideStart ?? view.start, end = overrideEnd ?? view.end;
  const store = useVariantsStore(useShallow(s => ({ scans: s.scans, latest: s.latest })));
  const hovered = useVariantsStore(s => s.hovered);
  const raw = useVariantsPanelState();
  const state = useMemo(() => normalizeVariantsState(raw), [raw]);
  const panel = useBrowserStore(s => s.panels.find(p => p.id === panelId));
  const open = useBrowserStore(s => s.panels.some(p => p.contentType === VARIANTS_PANEL));
  // The scan's SNPs show while the Variants panel is open (as before); a split's SNPs always.
  const { scan, snps, splitSnps } = useMemo(() => snpChannelContent(datasetId, chrom, start, end, panel, store, raw, open),
    [datasetId, chrom, start, end, panel, store, raw, open]);
  const exporting = useBrowserStore(s => s.exportInProgress);
  const selected = useMemo(() => new Set(state.selected), [state.selected]);
  if (!scan && !splitSnps.length) return null;
  const reads = panel?.readSubset?.count;
  const splitText = splitSnps.length ? `${splitSnps.length} split · ${splitSnps.map(s => s.allele ?? '?').join('/')}` : '';
  const label = splitSnps.length
    ? `SNPs (${snps.length ? `${snps.length.toLocaleString()} · ` : ''}${splitText}${selected.size ? `, ${selected.size} selected` : ''})`
    : `SNPs (${snps.length.toLocaleString()}${selected.size ? `, ${selected.size} selected` : ''})`;
  const splitTitle = (s: PanelSplitSnp) => `${s.snp.label} — this panel: ${s.allele ?? 'not called'}${reads != null ? ` (${reads.toLocaleString()} reads)` : ''}`;
  const title = [
    ...splitSnps.map(splitTitle),
    ...(scan ? [`SNPs the Variants panel found in ${scan.region.chrom}:${(scan.region.start + 1).toLocaleString()}–${scan.region.end.toLocaleString()} `
      + `(MAF ≥ ${scan.params.min_maf}, depth ≥ ${scan.params.min_depth}). Tick height: minor-allele fraction. Click to select, shift-click for several.`] : []),
  ].join('\n');
  const guideOn = panel?.readSubset?.rule.splitSnpGuide !== false;
  const lane = Math.max(8, height - SNP_CHANNEL_HEADER - 2);
  const x = (p: number) => trackX(p + 0.5, start, end, width, sidebarWidth, view.isReversed);
  const pick = (snp: Snp, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    selectSnp(snp.id, e.shiftKey || e.ctrlKey || e.metaKey);
    updateVariantsState({ tab: 'snps' });
  };
  return (
    <section data-testid={`snp-channel-${datasetId}`} data-figure-fill={TRACK_BACKGROUND.signal} data-scan={scan?.scan_key}
      data-split-snps={splitSnps.length || undefined}
      className="relative border-y border-slate-200 text-slate-600" style={{ height, width, background: TRACK_BACKGROUND.signal }}>
      <div className="flex items-center gap-1 px-1 text-[11px]" style={{ height: SNP_CHANNEL_HEADER }}>
        <button type="button" className="flex items-center gap-1 text-slate-600 hover:text-slate-900" data-testid="snp-channel-toggle"
          aria-expanded={!collapsed} title={collapsed ? 'Show the SNPs' : 'Collapse the SNP channel to its header'}
          onClick={() => setCollapsed(panelId, !collapsed)}>
          <DisclosureChevron open={!collapsed} />
          {overlayLabels.clean ? null : <span data-figure-text={label}>{label}</span>}
        </button>
        {overlayLabels.hover && <HoverLabel title={title}>{scan ? 'click to select · shift-click for several' : splitSnps.map(s => s.snp.label).join(', ')}</HoverLabel>}
        {splitSnps.length > 0 && !overlayLabels.clean && !exporting && (
          // (Not in figures: hidden in render mode, left out of exports.)
          <button type="button" data-render-hide="true" className="ml-auto rounded px-1 text-[10px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            data-testid="snp-channel-guide-toggle" aria-pressed={guideOn}
            title={guideOn ? 'Hide the dashed line through the reads at the split SNP' : 'Show a dashed line through the reads at the split SNP'}
            onClick={() => setSplitSnpGuide(panelId, !guideOn)}>
            {guideOn ? 'guide on' : 'guide off'}
          </button>
        )}
      </div>
      {!collapsed && (
        <svg width={width} height={lane + 2} aria-label={`SNPs ${datasetId}`} data-figure-svg="">
          <line x1={sidebarWidth} x2={width} y1={lane} y2={lane} stroke="#cbd5e1" strokeWidth={1} />
          {snps.map(snp => {
            const isSel = selected.has(snp.id), isHov = hovered === snp.id;
            const h = Math.max(4, Math.min(1, snp.maf / 0.5) * (lane - 3));
            const cx = x(snp.pos);
            const w = Math.max(2, Math.min(6, (width - sidebarWidth) / Math.max(1, end - start)));
            return (
              <g key={snp.id} role="button" tabIndex={0} aria-pressed={isSel} aria-label={`${snpLabel(snp, scan!.region.chrom)}, MAF ${(snp.maf * 100).toFixed(1)}%`}
                data-testid="snp-channel-snp" data-snp={snp.id} data-selected={isSel || undefined} data-hovered={isHov || undefined}
                className="cursor-pointer focus:outline-none"
                onMouseEnter={() => useVariantsStore.getState().setHovered(snp.id)}
                onMouseLeave={() => useVariantsStore.getState().setHovered(null)}
                onClick={e => { e.stopPropagation(); pick(snp, e); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(snp, e); } }}>
                <title>{`${snpLabel(snp, scan!.region.chrom)}: ${Object.entries(snp.counts).map(([a, n]) => `${a} ${n}`).join(', ')}; MAF ${(snp.maf * 100).toFixed(1)}%${snp.daf_safe === false ? ' (looks like deamination)' : ''}`}</title>
                <rect x={cx - 5} y={0} width={10} height={lane} fill="transparent" />
                {(isSel || isHov) && <rect x={cx - w / 2 - 2} y={lane - h - 2} width={w + 4} height={h + 2} rx={1.5} fill="none" stroke="#111827" strokeWidth={isSel ? 2 : 1} />}
                <rect x={cx - w / 2} y={lane - h} width={w} height={h} rx={1} fill={colour(snp)} fillOpacity={hovered && !isHov ? 0.55 : 0.95} />
              </g>
            );
          })}
          {splitSnps.map(s => (
            // The stem from the pill down to the reads.
            <line key={`stem-${s.snp.id}`} x1={x(s.snp.pos)} x2={x(s.snp.pos)} y1={0} y2={lane + 2} stroke={baseColour(s.allele)} strokeWidth={1.5} />
          ))}
        </svg>
      )}
      {!collapsed && splitSnps.map(s => {
        const colour = baseColour(s.allele);
        const tip = splitTitle(s);
        const letter = s.allele ?? '?';
        // A filled pill, white letter, over the highlight washes (z-index above HighlightBands' 5; in figures drawn
        // after them: data-figure-overlay-top), fully opaque. Just above the reads with no scan ticks; else at the
        // lane's top, clear of the ticks.
        return (
          <div key={`split-${s.snp.id}`} data-testid="snp-channel-split" data-snp={s.snp.id} data-allele={s.allele ?? ''}
            role="img" aria-label={tip} title={tip}
            className="pointer-events-auto absolute z-[6] flex items-center justify-center rounded-full font-bold leading-none text-white shadow-sm"
            style={{ left: x(s.snp.pos) - PILL_W / 2, width: PILL_W, height: PILL_H, background: colour, fontSize: 13,
              ...(snps.length ? { top: SNP_CHANNEL_HEADER } : { bottom: 1 }) }}
            data-figure-overlay={colour} data-figure-overlay-opacity={1} data-figure-overlay-top="">
            <span data-figure-text={letter} style={{ color: '#ffffff', fontWeight: 700, fontSize: 13 }}>{letter}</span>
          </div>
        );
      })}
    </section>
  );
}
