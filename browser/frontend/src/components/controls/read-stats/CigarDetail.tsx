import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CigarOp } from '../../../api/readStats';
import { AnalysisButton } from '../shared';

// Colors matching IGV conventions.
const CIGAR_OP_COLORS: Record<string, string> = {
  'M': '#c0c0c0',
  '=': '#c0c0c0',
  'X': '#ef4444',
  'I': '#a855f7',
  'D': '#374151',
  'N': '#fbbf24',
  'S': '#f97316',
  'H': '#78716c',
};

const CIGAR_OP_LABELS: Record<string, string> = {
  'M': 'Match/Mismatch',
  '=': 'Sequence Match',
  'X': 'Mismatch',
  'I': 'Insertion',
  'D': 'Deletion',
  'N': 'Skipped (intron)',
  'S': 'Soft Clip',
  'H': 'Hard Clip',
};

export function CigarDetail({ cigarString, cigarOps, fpIntervals, methylPositions, width }: {
  cigarString: string | null;
  cigarOps: CigarOp[];
  fpIntervals?: [number, number, number][] | null;
  methylPositions?: number[] | null;
  width: number;
}) {
  const cigarCanvasRef = useRef<HTMLCanvasElement>(null);
  const fpCanvasRef = useRef<HTMLCanvasElement>(null);
  const [copiedCigar, setCopiedCigar] = useState(false);

  const { totalLen, refToX } = useMemo(() => {
    let total = 0;
    for (const op of cigarOps) {
      if ('MDN=X'.includes(op.op)) total += op.len;
      else if (op.op === 'I' || op.op === 'S') total += Math.max(1, Math.min(op.len, 3));
    }
    const drawW = Math.max(100, width);
    const sc = total > 0 ? drawW / total : 1;

    const mapper = (refOffset: number): number => {
      let cx = 0;
      let rp = 0;
      for (const op of cigarOps) {
        if ('MDN=X'.includes(op.op)) {
          if (refOffset >= rp && refOffset < rp + op.len) {
            return cx + (refOffset - rp) * sc;
          }
          cx += op.len * sc;
          rp += op.len;
        } else if (op.op === 'I' || op.op === 'S') {
          cx += Math.max(1, Math.min(op.len, 3)) * sc;
        }
      }
      return cx;
    };

    return { totalLen: total, refToX: mapper };
  }, [cigarOps, width]);

  const opSummary = useMemo(() => {
    const counts: Record<string, { count: number; totalBp: number }> = {};
    for (const op of cigarOps) {
      if (!counts[op.op]) counts[op.op] = { count: 0, totalBp: 0 };
      counts[op.op].count++;
      counts[op.op].totalBp += op.len;
    }
    return counts;
  }, [cigarOps]);

  useEffect(() => {
    const canvas = cigarCanvasRef.current;
    if (!canvas || totalLen === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const drawW = Math.max(100, width);
    const drawH = 20;
    canvas.width = drawW * dpr;
    canvas.height = drawH * dpr;
    canvas.style.width = `${drawW}px`;
    canvas.style.height = `${drawH}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, drawW, drawH);

    const barY = 2;
    const barH = 16;
    const scale = drawW / totalLen;
    let x = 0;

    for (const op of cigarOps) {
      const color = CIGAR_OP_COLORS[op.op] || '#999';

      if ('MDN=X'.includes(op.op)) {
        const w = Math.max(1, op.len * scale);
        ctx.fillStyle = color;
        ctx.fillRect(x, barY, w, barH);
        if (w > 20) {
          ctx.fillStyle = op.op === 'D' || op.op === 'N' ? '#fff' : '#333';
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const label = op.len >= 1000 ? `${(op.len / 1000).toFixed(1)}k` : `${op.len}`;
          ctx.fillText(`${op.op}:${label}`, x + w / 2, barY + barH / 2);
        }
        x += w;
      } else if (op.op === 'I') {
        const markerW = Math.max(2, Math.min(4, 3 * scale));
        ctx.fillStyle = color;
        ctx.fillRect(x, barY - 2, markerW, barH + 4);
        ctx.beginPath();
        ctx.moveTo(x, barY - 2);
        ctx.lineTo(x + markerW, barY - 2);
        ctx.lineTo(x + markerW / 2, barY + 2);
        ctx.closePath();
        ctx.fill();
        x += markerW;
      } else if (op.op === 'S') {
        const w = Math.max(2, Math.min(op.len * scale, 20));
        ctx.fillStyle = color;
        ctx.fillRect(x, barY + 2, w, barH - 4);
        if (w > 14) {
          ctx.fillStyle = '#fff';
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('S', x + w / 2, barY + barH / 2);
        }
        x += w;
      }
    }
  }, [cigarOps, width, totalLen]);

  const hasFpData = fpIntervals && fpIntervals.length > 0;
  const hasMethy = methylPositions && methylPositions.length > 0;

  useEffect(() => {
    const canvas = fpCanvasRef.current;
    if (!canvas || totalLen === 0) return;
    if (!hasFpData && !hasMethy) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const drawW = Math.max(100, width);
    const drawH = 20;
    canvas.width = drawW * dpr;
    canvas.height = drawH * dpr;
    canvas.style.width = `${drawW}px`;
    canvas.style.height = `${drawH}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, drawW, drawH);

    const barY = 2;
    const barH = 16;

    ctx.fillStyle = '#e5e5e5';
    ctx.fillRect(0, barY + barH / 2 - 1, drawW, 2);

    if (fpIntervals) {
      for (const [ivStart, ivEnd, size] of fpIntervals) {
        const x1 = refToX(ivStart);
        const x2 = refToX(ivEnd);
        const w = Math.max(1, x2 - x1);

        if (size > 0) {
          ctx.fillStyle = size >= 90 ? '#33a040' : '#8c8c8c';
          ctx.fillRect(x1, barY, w, barH);
          if (w > 18) {
            ctx.fillStyle = '#fff';
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${size}`, x1 + w / 2, barY + barH / 2);
          }
        } else if (size < 0) {
          ctx.fillStyle = '#f5f5f5';
          ctx.fillRect(x1, barY + 2, w, barH - 4);
        } else {
          ctx.fillStyle = '#fafafa';
          ctx.fillRect(x1, barY + 3, w, barH - 6);
        }
      }
    }

    if (methylPositions) {
      ctx.fillStyle = '#6b21a8';
      for (const pos of methylPositions) {
        const x = refToX(pos);
        if (x < 0 || x > drawW) continue;
        const tickW = Math.max(2, 3);
        ctx.beginPath();
        ctx.moveTo(x, barY - 1);
        ctx.lineTo(x - tickW / 2, barY - 4);
        ctx.lineTo(x + tickW / 2, barY - 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(x - 0.5, barY, 1, barH);
      }
    }
  }, [fpIntervals, methylPositions, width, totalLen, refToX, hasFpData, hasMethy]);

  const handleCopyCigar = useCallback(() => {
    if (cigarString) {
      navigator.clipboard.writeText(cigarString);
      setCopiedCigar(true);
      setTimeout(() => setCopiedCigar(false), 1500);
    }
  }, [cigarString]);

  return (
    <div className="border-t border-gray-100 dark:border-white/10 pt-2 space-y-1">
      <div className="text-[11px] text-gray-400 font-medium">Read Alignment</div>

      <div>
        <div className="text-[11px] text-gray-400 mb-0.5">CIGAR</div>
        <canvas ref={cigarCanvasRef} className="w-full rounded" />
      </div>

      {(hasFpData || hasMethy) && (
        <div>
          <div className="text-[11px] text-gray-400 mb-0.5">
            Footprints{hasMethy ? ' + modifications' : ''}
          </div>
          <canvas ref={fpCanvasRef} className="w-full rounded" />
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {Object.entries(opSummary).map(([op, { count, totalBp }]) => (
          <div key={op} className="flex items-center gap-1 text-[11px]">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: CIGAR_OP_COLORS[op] || '#999' }}
            />
            <span className="text-gray-500" title={CIGAR_OP_LABELS[op]}>
              {op}: {totalBp.toLocaleString()}bp
              {count > 1 && <span className="text-gray-400"> ({count}x)</span>}
            </span>
          </div>
        ))}
        {hasFpData && (
          <>
            <div className="flex items-center gap-1 text-[11px]">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#33a040' }} />
              <span className="text-gray-500">Nuc</span>
            </div>
            <div className="flex items-center gap-1 text-[11px]">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#8c8c8c' }} />
              <span className="text-gray-500" title="Small footprints below the size threshold">Small FP</span>
            </div>
          </>
        )}
        {hasMethy && (
          <div className="flex items-center gap-1 text-[11px]">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#6b21a8' }} />
            <span className="text-gray-500">Modified bases</span>
          </div>
        )}
      </div>

      {cigarString && (
        <div>
          <div className="flex items-center gap-1 mb-0.5">
            <span className="text-[11px] text-gray-400">CIGAR String</span>
            <AnalysisButton
              onClick={handleCopyCigar}
              theme="violet"
              variant="outline"
              className="px-1 py-0 text-[11px]"
            >
              {copiedCigar ? 'Copied!' : 'Copy'}
            </AnalysisButton>
          </div>
          <div className="font-mono text-[11px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded p-1.5 max-h-16 overflow-auto break-all select-all leading-relaxed">
            {cigarString}
          </div>
        </div>
      )}
    </div>
  );
}
