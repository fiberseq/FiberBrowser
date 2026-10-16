/**
 * A to-scale cartoon of what an insertion appears to be, drawn only from the
 * identification's hits: the flanking reference with the breakpoints, the
 * target-site duplication, the insert as segments (TEs coloured by class with
 * orientation chevrons, LTRs boxed, ORFs from the library's annotation, gene
 * fragments, poly(A), unmatched stretches greyed), truncated element ends
 * jagged, and the carriers' nucleosome occupancy and MSPs along the insert.
 * Every part has a tooltip; uncertain parts are greyed and say why.
 *
 * The SVG carries explicit colours (light or dark) so "Save SVG / PNG" export
 * exactly what is on screen.
 */
import { forwardRef, useMemo } from 'react';
import {
  CLASS_COLORS, CLASS_LEGEND, KIND_COLORS, type CartoonModel, type CartoonShape,
} from './identifyModel';

export interface CartoonChromatin { nuc: (number | null)[]; msp: (number | null)[]; nucColor: string; mspColor: string; label: string }

interface Props {
  model: CartoonModel;
  width: number;
  dark: boolean;
  chrom?: string | null;
  chromatin?: CartoonChromatin | null;
}

const FLANK = 54;
const BODY_Y = 26;
const BODY_H = 20;
const ORF_Y = BODY_Y + BODY_H + 5;
const ORF_H = 7;
const SCALE_Y = ORF_Y + ORF_H + 16;
const CHROM_Y = SCALE_Y + 12;
const CHROM_H = 24;
const FONT = 'ui-sans-serif, system-ui, -apple-system, sans-serif';

function palette(dark: boolean) {
  return dark
    ? { bg: '#0f172a', ink: '#e2e8f0', muted: '#94a3b8', flank: '#64748b', unknownFill: '#334155', unknownEdge: '#64748b', white: '#0f172a' }
    : { bg: '#ffffff', ink: '#1e293b', muted: '#64748b', flank: '#94a3b8', unknownFill: '#e2e8f0', unknownEdge: '#94a3b8', white: '#ffffff' };
}

/** A box with zigzag sides where the element is truncated. */
function bodyPath(x0: number, x1: number, y: number, h: number, jagged: CartoonShape['jagged']): string {
  const zig = (x: number, dir: 1 | -1) => {
    const n = 4;
    const pts: string[] = [];
    for (let i = 1; i <= n; i++) {
      const yy = y + (i * h) / n;
      const xx = x + (i % 2 === 1 ? dir * 3 : 0);
      pts.push(`L${xx.toFixed(1)},${yy.toFixed(1)}`);
    }
    return pts;
  };
  const left = jagged === 'left' || jagged === 'both';
  const right = jagged === 'right' || jagged === 'both';
  const d = [`M${x0.toFixed(1)},${y}`, `L${x1.toFixed(1)},${y}`];
  if (right) d.push(...zig(x1, -1)); else d.push(`L${x1.toFixed(1)},${y + h}`);
  d.push(`L${x0.toFixed(1)},${y + h}`);
  if (left) {
    const up: string[] = [];
    const n = 4;
    for (let i = n - 1; i >= 0; i--) up.push(`L${(x0 + (i % 2 === 1 ? 3 : 0)).toFixed(1)},${(y + (i * h) / n).toFixed(1)}`);
    d.push(...up);
  }
  d.push('Z');
  return d.join(' ');
}

function chevrons(x0: number, x1: number, y: number, h: number, dir: 'right' | 'left', color: string) {
  const out = [];
  const step = 26;
  const w = x1 - x0;
  if (w < 18) return null;
  const n = Math.max(1, Math.floor(w / step));
  for (let i = 0; i < n; i++) {
    const cx = x0 + ((i + 0.5) * w) / n;
    const s = 3.5;
    const pts = dir === 'right'
      ? `${cx - s},${y + h / 2 - s} ${cx + s - 1},${y + h / 2} ${cx - s},${y + h / 2 + s}`
      : `${cx + s},${y + h / 2 - s} ${cx - s + 1},${y + h / 2} ${cx + s},${y + h / 2 + s}`;
    out.push(<polyline key={i} points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />);
  }
  return out;
}

export const InsertionCartoon = forwardRef<SVGSVGElement, Props>(function InsertionCartoon({ model, width, dark, chrom, chromatin }, ref) {
  const pal = palette(dark);
  const W = Math.max(320, width);
  const x0 = FLANK;
  const x1 = W - FLANK;
  const sx = (x: number) => x0 + (x / Math.max(1, model.length)) * (x1 - x0);
  const hasOrfs = model.features.some(f => f.kind === 'orf');
  const hasChromatin = Boolean(chromatin && chromatin.nuc.some(v => v !== null));
  const scaleY = hasOrfs ? SCALE_Y : SCALE_Y - ORF_H - 4;
  const chromY = scaleY + 12;
  const captionY = (hasChromatin ? chromY + CHROM_H + 18 : scaleY + 22);
  const legendClasses = useMemo(() => {
    const keys = new Set(model.body.map(s => s.cls).filter(Boolean));
    return CLASS_LEGEND.filter(l => keys.has(l.key));
  }, [model]);
  const H = captionY + 8 + (legendClasses.length ? 14 : 0);

  // The TSD: one copy is in the consensus (at one edge), the other is the reference
  // just past the other breakpoint (both flank the element in the carrier genome).
  const tsdShape = model.body.find(s => s.kind === 'tsd');
  let flankTsd: { x: number; w: number } | null = null;
  if (tsdShape) {
    const w = Math.max(6, sx(tsdShape.x1) - sx(tsdShape.x0));
    flankTsd = tsdShape.x0 <= 0.5 ? { x: x1, w } : { x: x0 - w, w };
  }

  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`}
      role="img" aria-label={`Insertion cartoon: ${model.caption}`} data-testid="insertion-cartoon"
      style={{ fontFamily: FONT, display: 'block' }}>
      {/* Transparent on screen (the panel shows through); exports fill it (cartoonSvgText). */}
      <rect x={0} y={0} width={W} height={H} fill="transparent" data-export-bg={pal.bg} />
      {/* Flanking reference and breakpoints */}
      <g>
        <title>Flanking reference{chrom ? ` (${chrom})` : ''}: the insert sits between the breakpoints</title>
        <line x1={4} x2={x0} y1={BODY_Y + BODY_H / 2} y2={BODY_Y + BODY_H / 2} stroke={pal.flank} strokeWidth={4} strokeLinecap="round" />
        <line x1={x1} x2={W - 4} y1={BODY_Y + BODY_H / 2} y2={BODY_Y + BODY_H / 2} stroke={pal.flank} strokeWidth={4} strokeLinecap="round" />
        <text x={4} y={BODY_Y + BODY_H + 12} fontSize={9} fill={pal.muted}>{model.reversed ? 'right flank' : 'left flank'}</text>
        <text x={W - 4} y={BODY_Y + BODY_H + 12} fontSize={9} fill={pal.muted} textAnchor="end">{model.reversed ? 'left flank' : 'right flank'}</text>
      </g>
      {[x0, x1].map(x => (
        <line key={x} x1={x} x2={x} y1={BODY_Y - 8} y2={BODY_Y + BODY_H + 8} stroke={pal.ink} strokeWidth={1} strokeDasharray="2 2" opacity={0.6} />
      ))}
      {flankTsd && model.tsd && (
        <g data-testid="cartoon-flank-tsd">
          <title>Target-site duplication {model.tsd.seq} ({model.tsd.length} bp): this copy is the reference at the site; the other is at the insert's edge</title>
          <rect x={flankTsd.x} y={BODY_Y + 3} width={flankTsd.w} height={BODY_H - 6} fill={KIND_COLORS.tsd} rx={1} />
        </g>
      )}
      {/* Insert body */}
      {model.body.map((s, i) => {
        const a = sx(s.x0);
        const b = Math.max(a + 1, sx(s.x1));
        const unknown = s.kind === 'unknown';
        const fill = unknown ? pal.unknownFill : s.color;
        const tsd = s.kind === 'tsd';
        const y = tsd ? BODY_Y + 3 : BODY_Y;
        const h = tsd ? BODY_H - 6 : BODY_H;
        const label = s.kind === 'tsd' ? 'TSD' : s.kind === 'polyA' ? 'A(n)' : s.label;
        const labelFits = label.length * 5.6 + 6 < b - a;
        return (
          <g key={`b${i}`} data-testid={`cartoon-seg-${s.kind}`} opacity={s.uncertain && !unknown ? 0.45 : 1}>
            <title>{s.title}</title>
            <path d={bodyPath(a, b, y, h, s.jagged)} fill={fill}
              stroke={unknown || s.uncertain ? pal.unknownEdge : 'none'} strokeDasharray={unknown || s.uncertain ? '3 2' : undefined} />
            {s.arrow && chevrons(a, b, y, h, s.arrow, pal.white)}
            {labelFits && !tsd && s.kind !== 'polyA' && (
              <text x={(a + b) / 2} y={BODY_Y - 5} fontSize={10} fontWeight={600} textAnchor="middle"
                fill={unknown ? pal.muted : pal.ink}>{unknown ? 'no match' : label}</text>
            )}
            {(tsd || s.kind === 'polyA') && (
              <text x={(a + b) / 2} y={BODY_Y - 5} fontSize={9} textAnchor="middle" fill={pal.muted}>{label}</text>
            )}
          </g>
        );
      })}
      {/* LTRs (boxed, with their orientation) and ORFs */}
      {model.features.map((f, i) => {
        const a = sx(f.x0);
        const b = Math.max(a + 2, sx(f.x1));
        if (f.kind === 'ltr') {
          const mid = (a + b) / 2;
          const s = Math.min(5, (b - a) / 2 - 1);
          const pts = f.arrow === 'right'
            ? `${mid - s},${BODY_Y + 4} ${mid + s},${BODY_Y + BODY_H / 2} ${mid - s},${BODY_Y + BODY_H - 4}`
            : `${mid + s},${BODY_Y + 4} ${mid - s},${BODY_Y + BODY_H / 2} ${mid + s},${BODY_Y + BODY_H - 4}`;
          return (
            <g key={`f${i}`} data-testid="cartoon-ltr" opacity={f.uncertain ? 0.55 : 1}>
              <title>{f.title}</title>
              <rect x={a} y={BODY_Y - 2} width={b - a} height={BODY_H + 4} fill={f.color} stroke={pal.ink} strokeWidth={1.2} rx={1.5} />
              {s > 1.5 && <polygon points={pts} fill={pal.white} />}
            </g>
          );
        }
        const fits = f.label.length * 5.2 + 4 < b - a;
        return (
          <g key={`f${i}`} data-testid="cartoon-orf" opacity={f.uncertain ? 0.55 : 1}>
            <title>{f.title}</title>
            <rect x={a} y={ORF_Y} width={b - a} height={ORF_H} fill="none" stroke={f.color} strokeWidth={1.3} rx={2} />
            {fits && <text x={(a + b) / 2} y={ORF_Y + ORF_H + 9} fontSize={9} textAnchor="middle" fill={pal.muted}>{f.label}</text>}
          </g>
        );
      })}
      {/* Scale */}
      <g>
        <line x1={x0} x2={x1} y1={scaleY} y2={scaleY} stroke={pal.muted} strokeWidth={1} />
        <text x={x0} y={scaleY + 10} fontSize={9} fill={pal.muted}>0</text>
        <text x={x1} y={scaleY + 10} fontSize={9} fill={pal.muted} textAnchor="end">{model.length.toLocaleString()} bp</text>
      </g>
      {/* The carriers' chromatin along the insert */}
      {hasChromatin && chromatin && (() => {
        const n = chromatin.nuc.length;
        const bw = (x1 - x0) / Math.max(1, n);
        const base = chromY + CHROM_H;
        let path = '';
        let pen = false;
        chromatin.msp.forEach((v, k) => {
          if (v === null) { pen = false; return; }
          const x = x0 + (k + 0.5) * bw;
          const y = base - Math.min(1, v) * CHROM_H;
          path += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
          pen = true;
        });
        return (
          <g data-testid="cartoon-chromatin">
            <title>{chromatin.label}: nucleosome occupancy (bars) and MSP fraction (line) along the insert, from the lens</title>
            <rect x={x0} y={chromY} width={x1 - x0} height={CHROM_H} fill={pal.ink} opacity={0.04} />
            {chromatin.nuc.map((v, k) => (v === null ? null : (
              <rect key={k} x={x0 + k * bw} y={base - v * CHROM_H} width={Math.max(0.8, bw)} height={v * CHROM_H}
                fill={chromatin.nucColor} opacity={0.6} />
            )))}
            <path d={path} fill="none" stroke={chromatin.mspColor} strokeWidth={1.2} />
            <text x={x0 - 4} y={chromY + 9} fontSize={9} fill={chromatin.nucColor} textAnchor="end">nuc</text>
            <text x={x0 - 4} y={chromY + 20} fontSize={9} fill={chromatin.mspColor} textAnchor="end">MSP</text>
          </g>
        );
      })()}
      <text x={W / 2} y={captionY} fontSize={11} fontWeight={600} fill={pal.ink} textAnchor="middle" data-testid="cartoon-caption">
        {model.caption}
      </text>
      {legendClasses.length > 0 && (
        <g>
          {legendClasses.map((l, i) => {
            const lx = W / 2 - (legendClasses.length * 70) / 2 + i * 70;
            return (
              <g key={l.key}>
                <rect x={lx} y={captionY + 7} width={9} height={9} fill={CLASS_COLORS[l.key]} rx={1.5} />
                <text x={lx + 12} y={captionY + 15} fontSize={9} fill={pal.muted}>{l.label}</text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
});

/** The cartoon as an SVG file. */
export function cartoonSvgText(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.querySelectorAll('[data-export-bg]').forEach(el => el.setAttribute('fill', el.getAttribute('data-export-bg') || '#ffffff'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** The cartoon as a PNG (2x), through an image of its SVG. */
export function cartoonPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob | null> {
  const text = cartoonSvgText(svg);
  const w = Number(svg.getAttribute('width')) || svg.clientWidth;
  const h = Number(svg.getAttribute('height')) || svg.clientHeight;
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export default InsertionCartoon;
