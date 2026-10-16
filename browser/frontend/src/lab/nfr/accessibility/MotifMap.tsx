/**
 * Accessibility (preview): the motif map of a saved NFR, one figure. Top: each variant's open span as a bar over the
 * NFR's window, and one row per shown motif family with its sites as ticks (the family's colour). Below: the sites x
 * variants grid, one metric per cell: coverage, the share of the variant's member reads whose own opening covers the
 * site (cell shading in the variant's colour). When footprint classes exist, a small dot in a cell is the share
 * footprinted when open at a site under a class (a second, lighter layer). One canvas, so Save exports all of it.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { MotifFamily, MotifSite } from '../api';
import { useBrowserStore } from '../../../stores/browserStore';
import { bp, formatQ, variantColor } from '../accessibilityView';
import { motifLabel, NfrCanvasExport } from './NfrCharts';

/** Family colours, in fixed order (validated categorical palette, light and dark steps); families past the eighth are
 * drawn in the neutral ink (still labelled). */
export const FAMILY_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const INK = '#8b93a1';
/** A footprint marker is drawn where the variant's opening covers the site in at least this share of its reads. */
export const MARKER_MIN_COVERAGE = 0.1;
const GRID = 'rgba(139,147,161,0.25)';

/** The one test shown for a site, named the same everywhere. */
export const COVER_TEST_LABEL = 'Coverage differs (q)';
export const COVER_TEST_HELP = 'How likely a coverage difference this large between the variants is by chance, adjusted across all sites '
  + 'tested in this NFR (Benjamini–Hochberg q). A small q is stronger evidence that the variants differ at this site; it is evidence, not proof.';
export const COVERAGE_HELP = 'Coverage: the share of the variant\'s reads whose own opening covers the site.';

export interface MapFamily { family: MotifFamily; color: string }
export interface MapSite { family: MotifFamily; site: MotifSite; color: string }

/** Coverage of a site by one variant (null: no member reads). */
export function coverageOf(site: MotifSite, name: string): number | null {
  const c = site.coverage?.[name];
  if (c) return c.n ? c.p : null;
  return site.open?.[name] ?? null;
}

/** P(footprinted | open) of a variant at a site under a footprint class (null: no class there, or no labelled reads). */
export function footprintOf(site: MotifSite, name: string): number | null {
  if (!site.classes?.length) return null;
  return site.layers?.[name]?.p_fp_given_open ?? null;
}

export interface MapLayout {
  L: number; R: number; laneTop: number; lane: number; famTop: number; famH: number; axisY: number;
  gridHead: number; gridTop: number; rowH: number; cellW: number; legendY: number; height: number;
}

/** Narrowest grid column; a map narrower than its labels and columns is drawn at the width it needs (scrolled). */
export const MIN_CELL_W = 28;

/** The width the map needs: its label column and every variant's column at the narrowest. */
export function motifMapWidth(width: number, variants: number): number {
  let w = width;
  for (let i = 0; i < 8; i++) w = Math.max(width, labelWidth(w) + 12 + variants * MIN_CELL_W);   // the label column grows with w
  return Math.ceil(w);
}
const labelWidth = (width: number) => Math.round(Math.max(96, Math.min(150, width * 0.3)));

export function motifMapLayout(width: number, variants: number, families: number, sites: number): MapLayout {
  const L = labelWidth(width), R = 12, lane = 9, laneTop = 6;
  const famTop = laneTop + variants * (lane + 3) + 4;
  const famH = 14;
  const axisY = famTop + families * famH + 2;
  const gridHead = axisY + 30;
  const gridTop = gridHead + 14;
  const rowH = 16;
  const cellW = Math.max(MIN_CELL_W, Math.min(90, Math.floor((width - L - R) / Math.max(1, variants))));
  const legendY = gridTop + sites * rowH + 14;
  return { L, R, laneTop, lane, famTop, famH, axisY, gridHead, gridTop, rowH, cellW, legendY, height: legendY + 6 };
}

/** What the pointer is over: a grid cell (site, variant) or a tick (site). */
export function motifMapHit(lay: MapLayout, width: number, win: [number, number], sites: MapSite[], families: MapFamily[], names: string[],
  x: number, y: number): { site: number; variant: string | null } | null {
  if (y >= lay.gridTop && y < lay.gridTop + sites.length * lay.rowH) {
    const row = Math.floor((y - lay.gridTop) / lay.rowH);
    const col = x >= lay.L ? Math.floor((x - lay.L) / lay.cellW) : -1;
    return { site: row, variant: col >= 0 && col < names.length ? names[col] : null };
  }
  if (y >= lay.famTop && y < lay.axisY - 2 && x >= lay.L) {
    const f = Math.floor((y - lay.famTop) / lay.famH);
    const px = (v: number) => lay.L + ((v - win[0]) / Math.max(1, win[1] - win[0])) * (width - lay.L - lay.R);
    let best = -1, dist = 6;
    sites.forEach((s, i) => {
      if (s.family.id !== families[f]?.family.id) return;
      const d = Math.abs(px((s.site.start + s.site.end) / 2) - x);
      if (d <= dist) { dist = d; best = i; }
    });
    return best >= 0 ? { site: best, variant: null } : null;
  }
  return null;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = Math.max(1, hi - lo);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

export function siteText(s: MapSite): string {
  return `${motifLabel(s.family)} ${bp(s.site.start)} (${s.site.strand})`;
}

export function MotifMap({ families, sites, spans, names, window: win, width, hasClasses, fileStem }: {
  families: MapFamily[]; sites: MapSite[]; spans: Record<string, [number, number]>; names: string[]; window: [number, number];
  width: number; hasClasses: boolean; fileStem: string;
}) {
  const [hover, setHover] = useState<{ site: number; variant: string | null; x: number; y: number } | null>(null);
  const dark = useBrowserStore(st => !!st.darkMode);
  const hovered = hover?.site ?? -1;
  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h);
    const lay = motifMapLayout(w, names.length, families.length, sites.length);
    const { L, R } = lay;
    const px = (v: number) => L + ((v - win[0]) / Math.max(1, win[1] - win[0])) * (w - L - R);
    ctx.font = '10px sans-serif';
    // variant spans
    names.forEach((n, i) => {
      const span = spans[n];
      const y = lay.laneTop + i * (lay.lane + 3);
      ctx.fillStyle = variantColor(n); ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(n, L - 6, y + lay.lane - 1);
      if (!span) return;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px(span[0]), y, Math.max(2, px(span[1]) - px(span[0])), lay.lane);
      ctx.globalAlpha = 1;
    });
    // family rows: the sites as ticks, with a faint guide up through the spans
    families.forEach((f, i) => {
      const cy = lay.famTop + i * lay.famH + lay.famH / 2;
      const label = motifLabel(f.family);
      ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = INK;
      const fit = Math.max(8, Math.floor((L - 20) / 5.6));
      ctx.fillText(label.length > fit ? `${label.slice(0, fit - 1)}…` : label, L - 16, cy + 3);
      ctx.fillStyle = f.color; ctx.fillRect(L - 12, cy - 3, 6, 6);
      ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, cy); ctx.lineTo(w - R, cy); ctx.stroke();
      sites.forEach((s, k) => {
        if (s.family.id !== f.family.id) return;
        const x = px((s.site.start + s.site.end) / 2);
        const on = k === hovered;
        ctx.strokeStyle = f.color; ctx.globalAlpha = on ? 0.6 : 0.22; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, lay.laneTop); ctx.lineTo(x, cy - 5); ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = on ? 3 : 2;
        ctx.beginPath(); ctx.moveTo(x, cy - 5); ctx.lineTo(x, cy + 5); ctx.stroke();
      });
    });
    // position axis
    ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, lay.axisY); ctx.lineTo(w - R, lay.axisY); ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
    for (const v of niceTicks(win[0], win[1])) {
      const x = px(v);
      ctx.beginPath(); ctx.moveTo(x, lay.axisY); ctx.lineTo(x, lay.axisY + 3); ctx.stroke();
      ctx.fillText(fmt(v), x, lay.axisY + 13);
    }
    // the grid: one row per site, one column per variant, shaded by coverage
    ctx.font = 'bold 10px sans-serif';
    names.forEach((n, j) => { ctx.fillStyle = variantColor(n); ctx.textAlign = 'center'; ctx.fillText(n, L + j * lay.cellW + lay.cellW / 2, lay.gridHead + 9); });
    sites.forEach((s, i) => {
      const y = lay.gridTop + i * lay.rowH;
      if (i === hovered) { ctx.fillStyle = GRID; ctx.fillRect(0, y, L + names.length * lay.cellW, lay.rowH); }
      ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = INK;
      const label = `${s.family.name} ${fmt(s.site.start)}`;
      const fit = Math.max(8, Math.floor((L - 20) / 5.6));
      ctx.fillText(label.length > fit ? `${label.slice(0, fit - 1)}…` : label, L - 16, y + 11);
      ctx.fillStyle = s.color; ctx.fillRect(L - 12, y + 5, 6, 6);
      names.forEach((n, j) => {
        const x = L + j * lay.cellW;
        const v = coverageOf(s.site, n);
        ctx.fillStyle = variantColor(n); ctx.globalAlpha = v == null ? 0.04 : 0.06 + 0.94 * v;
        ctx.fillRect(x + 1, y + 1, lay.cellW - 2, lay.rowH - 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = v != null && v > 0.45 ? '#ffffff' : INK; ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
        ctx.fillText(v == null ? '–' : pct(v), x + (hasClasses ? lay.cellW / 2 - 4 : lay.cellW / 2), y + 11.5);
        // the footprint layer: only where the variant opens over the site (a marker on a closed cell says nothing)
        const fp = hasClasses && v != null && v >= MARKER_MIN_COVERAGE ? footprintOf(s.site, n) : null;
        if (fp != null) {
          ctx.fillStyle = (v ?? 0) > 0.45 ? '#ffffff' : dark ? '#e5e7eb' : '#111827';
          ctx.beginPath(); ctx.arc(x + lay.cellW - 7, y + lay.rowH / 2, 1.5 + 3 * Math.min(1, fp), 0, Math.PI * 2); ctx.fill();
        }
      });
    });
    ctx.fillStyle = INK; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`cell: share of the variant's reads whose opening covers the site${hasClasses ? ' · ●: footprinted when open (Find classes)' : ''}`, L, lay.legendY);
  }, [families, sites, spans, names.join('|'), win, hasClasses, hovered, dark]);
  const w = motifMapWidth(width, names.length);
  const lay = motifMapLayout(w, names.length, families.length, sites.length);
  const wrap = useRef<HTMLDivElement>(null);
  const onMove = (e: React.MouseEvent) => {
    const canvas = wrap.current?.querySelector('canvas');
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = motifMapHit(lay, w, win, sites, families, names, x, y);
    setHover(hit ? { ...hit, x, y } : null);
  };
  const tsv = useCallback(() => ['motif\tmatrices\tstart\tend\tstrand\tp\tin_spans\tcoverage_differs_q\t'
    + names.flatMap(n => [`coverage_${n}`, `reads_${n}`, `covered_${n}`, ...(hasClasses ? [`footprinted_when_open_${n}`] : [])]).join('\t'),
  ...sites.map(s => [motifLabel(s.family), s.family.members.map(m => m.id).join(','), s.site.start, s.site.end, s.site.strand, s.site.p, s.site.in.join(','),
    s.site.q_cover_diff ?? '', ...names.flatMap(n => [coverageOf(s.site, n) ?? '', s.site.coverage?.[n]?.n ?? '', s.site.coverage?.[n]?.covered ?? '',
      ...(hasClasses ? [footprintOf(s.site, n) ?? ''] : [])])].join('\t'))].join('\n'), [sites, names.join('|'), hasClasses]);
  const tip = useMemo(() => {
    if (!hover) return null;
    const s = sites[hover.site];
    if (!s) return null;
    const lines = [siteText(s)];
    const one = (n: string) => {
      const c = s.site.coverage?.[n];
      const fp = hasClasses ? footprintOf(s.site, n) : null;
      return `${n}: ${c && c.n ? `${pct(c.p)} (${c.covered} of ${c.n} reads)` : 'no reads'}${fp != null ? ` · footprinted when open ${pct(fp)}` : ''}`;
    };
    if (hover.variant) lines.push(one(hover.variant)); else names.forEach(n => lines.push(one(n)));
    if (s.site.q_cover_diff != null) lines.push(`${COVER_TEST_LABEL.replace(' (q)', '')}: q ${formatQ(s.site.q_cover_diff)}`);
    if (s.site.classes?.length) lines.push(`under ${s.site.classes.map(c => c.label).join(', ')}`);
    return lines;
  }, [hover, sites, names.join('|'), hasClasses]);
  return (
    <div ref={wrap} className={`relative ${w > width ? 'overflow-x-auto' : ''}`} style={{ maxWidth: width }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} data-testid="nfr-motif-map-wrap"
      data-sites={sites.length} data-families={families.map(f => f.family.name).join(',')}>
      <NfrCanvasExport draw={draw} width={w} height={lay.height} filename={`nfr-motif-map-${fileStem}`} title="Motif map" dataTsv={tsv} testId="nfr-motif-map" />
      {tip && hover && (
        <div className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ left: Math.min(hover.x + 12, Math.max(0, w - 260)), top: hover.y + 14 }} data-testid="nfr-motif-map-tip">
          {tip.map((t, i) => <div key={i} className={i === 0 ? 'font-semibold text-gray-900 dark:text-gray-100' : 'tabular-nums text-gray-600 dark:text-gray-300'}>{t}</div>)}
        </div>
      )}
    </div>
  );
}

/** The family colour slots for the shown families (in their order), the light or the dark steps. */
export function useFamilyColors(): string[] {
  const dark = useBrowserStore(s => !!s.darkMode);
  return dark ? FAMILY_COLORS.dark : FAMILY_COLORS.light;
}
