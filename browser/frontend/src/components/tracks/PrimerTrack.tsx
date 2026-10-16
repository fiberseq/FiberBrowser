import { logicalOffset } from '../../utils/scaledCoordinates';
import { sameChrom } from '../../utils/chromAliases';
import { useRef, useEffect, useCallback, useMemo } from 'react';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import type { SavedPrimer } from '../../types';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverLabel, useTrackLabels } from './TrackLabels';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

interface Props {
  width: number;
  height: number;
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
}

export function PrimerTrack({ width, height, overrideChrom, overrideStart, overrideEnd }: Props) {
  const trackLabels = useTrackLabels();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRenderVersion = useCanvasRenderVersion();
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const storeChrom = useBrowserStore(s => s.chrom);
  const start = overrideStart ?? storeStart;
  const end = overrideEnd ?? storeEnd;
  const chrom = overrideChrom ?? storeChrom;
  const primer = useBrowserStore(s => s.primer);
  const setPrimerPair = useBrowserStore(s => s.setPrimerPair);
  const isReversed = useBrowserStore(s => s.isReversed);

  // In 3C mode, derive display pairs from dafcQuads filtered to this viewport.
  // Every pair shows only on the chromosome it was designed on (untagged
  // pairs, e.g. from older sessions, show anywhere).
  const onThisChrom = (pairChrom: string | undefined) => !pairChrom || sameChrom(pairChrom, chrom);
  const dafcQuads = primer.dafcQuads ?? [];
  const designResults = primer.mode === 'dafc' && dafcQuads.length > 0
    ? dafcQuads.flatMap(q => {
        const pairs: typeof primer.designResults = [];
        const xInView = q.x_pair.fwd_start < end && q.x_pair.rev_end > start;
        const yInView = q.y_pair.fwd_start < end && q.y_pair.rev_end > start;
        const legacy = q as { x_chrom?: string; y_chrom?: string; chrom?: string };
        if (xInView && onThisChrom(q.x_pair.designChrom ?? legacy.x_chrom ?? legacy.chrom)) pairs.push(q.x_pair);
        if (yInView && onThisChrom(q.y_pair.designChrom ?? legacy.y_chrom ?? legacy.chrom)) pairs.push(q.y_pair);
        return pairs;
      })
    : (primer.designResults ?? []).filter(pair => onThisChrom(pair.designChrom));
  const activePair = primer.pair && onThisChrom(primer.pair.designChrom) ? primer.pair : null;

  const regionWidth = end - start;
  // When the viewport is reversed, mirror the mapping so primer arrows
  // point the right way and the fwd/rev arrows don't cross the dashed
  // target. Matches the convention used by every other track (FireTrack,
  // MetaTrack, ReadTrackCanvas): flip the fractional position across
  // the midpoint.
  const posToPixel = useCallback(
    (pos: number) => {
      const frac = (pos - start) / regionWidth;
      return (isReversed ? 1 - frac : frac) * width;
    },
    [start, regionWidth, width, isReversed],
  );

  // Cart primers filtered to viewport + chrom, honoring cartTrackDisplay mode.
  // We show these in a distinct top band so they don't mix with fresh design
  // results (which stay in their existing band below).
  const cartDisplay = primer.cartTrackDisplay ?? 'off';
  const cartPrimers: SavedPrimer[] = useMemo(() => {
    if (cartDisplay === 'off') return [];
    return primer.savedPrimers.filter(sp => {
      if (!sameChrom(sp.chrom, chrom)) return false;
      const src = sp.source ?? 'design';
      if (cartDisplay === 'imported' && src === 'design') return false;
      if (cartDisplay === 'design' && src !== 'design') return false;
      // Viewport overlap
      const lo = Math.min(sp.pair.fwd_start, sp.pair.rev_start);
      const hi = Math.max(sp.pair.fwd_end, sp.pair.rev_end);
      return hi > start && lo < end;
    });
  }, [primer.savedPrimers, cartDisplay, chrom, start, end]);

  // Layout: cart band on top (if any), then design-results band below.
  const pairCount = designResults.length;
  const HEADER_H = 12;
  const cartCount = cartPrimers.length;
  const CART_GAP = cartCount > 0 ? 3 : 0;
  const availForRows = Math.max(0, height - HEADER_H - 2 - CART_GAP);
  // Give cart and design-results proportional share; rows grow with the track up to 28 px
  // (fb-n11-tracks: a 16 px cap left a resized track empty) and never below what fits.
  const totalRows = cartCount + pairCount;
  const rowH = totalRows > 0
    ? Math.min(28, availForRows / totalRows)
    : 0;
  const cartBandH = cartCount * rowH;
  const designBandY = HEADER_H + cartBandH + CART_GAP;

  // ── Canvas draw ────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    // Background
    ctx.fillStyle = TRACK_BACKGROUND.primer;
    ctx.fillRect(0, 0, width, height);

    // Track label
    ctx.fillStyle = '#92400e';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    drawTrackLabel(ctx, 'Primers', 4, 10, { ...trackLabels, pill: false });

    if (pairCount > 0 || cartCount > 0) {
      ctx.fillStyle = '#a16207';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      const parts: string[] = [];
      if (cartCount > 0) parts.push(`${cartCount} cart`);
      if (pairCount > 0) parts.push(`${pairCount} design`);
      drawTrackLabel(ctx, parts.join(' / '), width - 4, 10, { ...trackLabels, pill: false });
    }

    // Target region highlight
    if (primer.targetStart !== null && primer.targetEnd !== null && sameChrom(primer.targetChrom ?? storeChrom, chrom)) {
      // Screen left/right, like the cart and pair boxes below (reversed view flips them).
      const [tx1, tx2] = [posToPixel(primer.targetStart), posToPixel(primer.targetEnd)].sort((a, b) => a - b);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
      ctx.fillRect(tx1, 0, tx2 - tx1, height);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(tx1, 0, tx2 - tx1, height);
      ctx.setLineDash([]);
    }

    // ── Cart band (imported / design-saved primers) ──
    // Colors intentionally different from design-results: sky-blue/indigo
    // for BED imports, amber for design-saved. No arrows — just thin bars
    // with name labels so they read as "reference", not as a selectable pair.
    if (cartCount > 0) {
      // Band background
      ctx.fillStyle = 'rgba(99, 102, 241, 0.04)';
      ctx.fillRect(0, HEADER_H, width, cartBandH);

      cartPrimers.forEach((sp, i) => {
        const y = HEADER_H + i * rowH;
        const barH = Math.max(3, rowH - 2);
        const midY = y + barH / 2;
        const isBed = (sp.source ?? 'design') !== 'design';
        // BED/TSV imports: steel blue (fwd) / indigo (rev)
        // Design-saved: amber / orange
        const fwdColor = isBed ? '#0284c7' : '#d97706';
        const revColor = isBed ? '#4f46e5' : '#ea580c';

        // Same min/max normalization as the active-pair path so a reversed
        // viewport doesn't flip fwdX1/fwdX2 into a negative-width fillRect.
        const fwdPxA = posToPixel(sp.pair.fwd_start);
        const fwdPxB = posToPixel(sp.pair.fwd_end);
        const revPxA = posToPixel(sp.pair.rev_start);
        const revPxB = posToPixel(sp.pair.rev_end);
        const fwdX1 = Math.min(fwdPxA, fwdPxB);
        const fwdX2 = Math.max(fwdPxA, fwdPxB);
        const revX1 = Math.min(revPxA, revPxB);
        const revX2 = Math.max(revPxA, revPxB);

        ctx.fillStyle = fwdColor;
        ctx.fillRect(fwdX1, midY - 1.5, Math.max(fwdX2 - fwdX1, 3), 3);
        ctx.fillStyle = revColor;
        ctx.fillRect(revX1, midY - 1.5, Math.max(revX2 - revX1, 3), 3);

        // Connecting line between the two bars — pick the inner edges.
        const lineL = Math.min(fwdX2, revX2);
        const lineR = Math.max(fwdX1, revX1);
        ctx.strokeStyle = isBed ? 'rgba(79,70,229,0.5)' : 'rgba(234,88,12,0.5)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(lineL, midY);
        ctx.lineTo(lineR, midY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Name label at the LEFT edge of the pair (clamped to canvas). Under
        // reverse, the left edge is still the visually-leftmost X.
        if (rowH >= 9) {
          ctx.fillStyle = fwdColor;
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'left';
          const label = `${sp.name}${isBed ? '' : ' *'}`;
          const pairLeft = Math.min(fwdX1, revX1);
          const tx = Math.max(14, Math.min(width - 60, pairLeft));
          ctx.fillText(label, tx, y + barH / 2 + 3);
        }
      });
    }

    // Draw each primer pair (design results — below the cart band)
    designResults.forEach((pair, i) => {
      const isActive =
        activePair != null &&
        activePair.fwd_seq === pair.fwd_seq &&
        activePair.rev_seq === pair.rev_seq;
      const y = designBandY + i * rowH;
      const barH = Math.max(3, rowH - 2);

      // Order the pixel pairs so "X1" is always visually LEFT of "X2" —
      // decoupled from which genomic end is start vs end. Under reverse,
      // posToPixel flips, so the raw fwd_start maps to a larger pixel than
      // fwd_end. The arrow-drawing code below assumes X1 < X2, so we
      // normalize here. Direction semantics (fwd arrow points towards
      // product, rev arrow points back) are preserved by separately
      // tracking which physical end is the primer's 3' direction.
      const fwdPxA = posToPixel(pair.fwd_start);
      const fwdPxB = posToPixel(pair.fwd_end);
      const revPxA = posToPixel(pair.rev_start);
      const revPxB = posToPixel(pair.rev_end);
      const fwdX1 = Math.min(fwdPxA, fwdPxB);
      const fwdX2 = Math.max(fwdPxA, fwdPxB);
      const revX1 = Math.min(revPxA, revPxB);
      const revX2 = Math.max(revPxA, revPxB);
      // Under reverse, visual arrow direction swaps: fwd points LEFT (tip
      // at X1), rev points RIGHT (tip at X2).
      const fwdTipRight = !isReversed;

      if (isActive) {
        // ── Active pair: full arrows ──
        const arrowH = Math.min(14, barH);
        const ay = y + (barH - arrowH) / 2;
        const tip = 5;

        // Highlight background behind active pair
        ctx.fillStyle = 'rgba(225, 29, 72, 0.06)';
        ctx.fillRect(0, y - 1, width, barH + 2);

        // Fwd arrow (green) — points right by default, left under reverse.
        ctx.fillStyle = '#16a34a';
        const fwdW = fwdX2 - fwdX1;
        if (fwdW > 8) {
          ctx.beginPath();
          if (fwdTipRight) {
            ctx.moveTo(fwdX1, ay);
            ctx.lineTo(fwdX2 - tip, ay);
            ctx.lineTo(fwdX2 - tip, ay - 3);
            ctx.lineTo(fwdX2, ay + arrowH / 2);
            ctx.lineTo(fwdX2 - tip, ay + arrowH + 3);
            ctx.lineTo(fwdX2 - tip, ay + arrowH);
            ctx.lineTo(fwdX1, ay + arrowH);
          } else {
            ctx.moveTo(fwdX2, ay);
            ctx.lineTo(fwdX1 + tip, ay);
            ctx.lineTo(fwdX1 + tip, ay - 3);
            ctx.lineTo(fwdX1, ay + arrowH / 2);
            ctx.lineTo(fwdX1 + tip, ay + arrowH + 3);
            ctx.lineTo(fwdX1 + tip, ay + arrowH);
            ctx.lineTo(fwdX2, ay + arrowH);
          }
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(fwdX1, ay, Math.max(fwdW, 3), arrowH);
        }

        // Rev arrow (red) — opposite of fwd: points left by default, right under reverse.
        ctx.fillStyle = '#dc2626';
        const revW = revX2 - revX1;
        if (revW > 8) {
          ctx.beginPath();
          if (!fwdTipRight) {
            // reversed view → rev visually points right
            ctx.moveTo(revX1, ay);
            ctx.lineTo(revX2 - tip, ay);
            ctx.lineTo(revX2 - tip, ay - 3);
            ctx.lineTo(revX2, ay + arrowH / 2);
            ctx.lineTo(revX2 - tip, ay + arrowH + 3);
            ctx.lineTo(revX2 - tip, ay + arrowH);
            ctx.lineTo(revX1, ay + arrowH);
          } else {
            ctx.moveTo(revX2, ay);
            ctx.lineTo(revX1 + tip, ay);
            ctx.lineTo(revX1 + tip, ay - 3);
            ctx.lineTo(revX1, ay + arrowH / 2);
            ctx.lineTo(revX1 + tip, ay + arrowH + 3);
            ctx.lineTo(revX1 + tip, ay + arrowH);
            ctx.lineTo(revX2, ay + arrowH);
          }
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(revX1, ay, Math.max(revW, 3), arrowH);
        }

        // Product connecting line — between fwd's tip side and rev's tip side.
        // Under forward view, that's fwdX2 → revX1; under reverse, fwdX1 → revX2.
        const prodLeft  = fwdTipRight ? fwdX2 : revX2;
        const prodRight = fwdTipRight ? revX1 : fwdX1;
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(prodLeft, ay + arrowH / 2);
        ctx.lineTo(prodRight, ay + arrowH / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrow labels
        if (arrowH >= 8) {
          ctx.fillStyle = 'white';
          ctx.font = 'bold 7px sans-serif';
          ctx.textAlign = 'center';
          if (fwdW > 25) ctx.fillText('F', (fwdX1 + fwdX2) / 2, ay + arrowH / 2 + 2);
          if (revW > 25) ctx.fillText('R', (revX1 + revX2) / 2, ay + arrowH / 2 + 2);
        }

        // Product size label — drawn on the connecting-line span regardless
        // of reverse. prodLeft/prodRight already reflect the inner edges.
        const prodLabelX = (prodLeft + prodRight) / 2;
        const prodSpan = Math.abs(prodRight - prodLeft);
        if (prodLabelX > 40 && prodLabelX < width - 40 && prodSpan > 60) {
          ctx.fillStyle = '#374151';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${pair.product_size.toLocaleString()}bp`, prodLabelX, ay - 2);
        }
      } else {
        // ── Inactive pair: thin compact bars ──
        ctx.globalAlpha = 0.45;
        const midY = y + barH / 2;

        // Fwd bar (green)
        ctx.fillStyle = '#22c55e';
        ctx.fillRect(fwdX1, midY - 1.5, Math.max(fwdX2 - fwdX1, 3), 3);

        // Rev bar (red)
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(revX1, midY - 1.5, Math.max(revX2 - revX1, 3), 3);

        // Connecting line across the inner edges (reverse-safe).
        const innerL = Math.min(fwdX2, revX2);
        const innerR = Math.max(fwdX1, revX1);
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(innerL, midY);
        ctx.lineTo(innerR, midY);
        ctx.stroke();

        ctx.globalAlpha = 1;
      }

      // Row number
      ctx.fillStyle = isActive ? '#92400e' : 'rgba(146,64,14,0.35)';
      ctx.font = isActive ? 'bold 8px sans-serif' : '8px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}`, 4, y + barH / 2 + 3);
    });

    // If no results but we have a single active pair (e.g. from session
    // restore), draw it old-style. Reverse-safe: normalize pixel pairs.
    if (pairCount === 0 && activePair) {
      const primerY = height / 2 - 8;
      const primerH = 16;
      const fwdPxA = posToPixel(activePair.fwd_start);
      const fwdPxB = posToPixel(activePair.fwd_end);
      const revPxA = posToPixel(activePair.rev_start);
      const revPxB = posToPixel(activePair.rev_end);
      const fwdX1 = Math.min(fwdPxA, fwdPxB);
      const fwdX2 = Math.max(fwdPxA, fwdPxB);
      const revX1 = Math.min(revPxA, revPxB);
      const revX2 = Math.max(revPxA, revPxB);

      ctx.fillStyle = '#22c55e';
      ctx.fillRect(fwdX1, primerY, Math.max(fwdX2 - fwdX1, 3), primerH);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(revX1, primerY, Math.max(revX2 - revX1, 3), primerH);

      const innerL = Math.min(fwdX2, revX2);
      const innerR = Math.max(fwdX1, revX1);
      ctx.strokeStyle = '#6b7280';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(innerL, primerY + primerH / 2);
      ctx.lineTo(innerR, primerY + primerH / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [width, height, start, end, primer, designResults, activePair, posToPixel, pairCount, rowH, cartPrimers, cartCount, cartBandH, designBandY, canvasRenderVersion, trackLabels]);

  // ── Click handler: select a design-results pair ──
  // Cart primers are reference-only and not clickable.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (pairCount === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const clickY = logicalOffset(e.clientY - rect.top, e.currentTarget.clientHeight, rect.height);

      const rowIdx = Math.floor((clickY - designBandY) / rowH);
      if (rowIdx < 0 || rowIdx >= pairCount) return;

      setPrimerPair(designResults[rowIdx]);
    },
    [pairCount, designResults, setPrimerPair, rowH, designBandY],
  );

  // Guide line pixel positions for the active pair
  const guideLineXs = activePair
    ? [posToPixel(activePair.fwd_end), posToPixel(activePair.rev_start)]
    : [];

  return (
    <div style={{ position: 'relative', width, height }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block cursor-pointer"
        onClick={handleClick}
      />
      <HoverLabel style={{ top: 0, color: '#92400e' }}>
        Primers{cartCount > 0 || pairCount > 0 ? ` · ${[cartCount > 0 ? `${cartCount} cart` : '', pairCount > 0 ? `${pairCount} design` : ''].filter(Boolean).join(' / ')}` : ''}
      </HoverLabel>
      {/* Guide lines — extend beyond this track into subsequent tracks */}
      {guideLineXs.map((x, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: x,
            top: 0,
            width: 0,
            height: 3000,
            borderLeft: '1px dashed rgba(225, 29, 72, 0.35)',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        />
      ))}
    </div>
  );
}
