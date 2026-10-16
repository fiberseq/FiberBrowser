import { useEffect, useRef } from 'react';
import { ChartMaximizeButton } from '../../charts/ChartMaximizeButton';
import { ChartSaveButton } from '../../charts/ChartSaveButton';
import { wilsonInterval } from '../../../utils/statistics';
import { formatTsv } from '../../../utils/analysisExport';

interface BarData {
  dsId: string;
  dsLabel: string;
  dsColor: string;
  count: number;
  total: number;
  pct: number;
  segments?: { label: string; count: number; pct: number; color: string }[];
}

export interface TranscriptionClassData {
  key: string;
  label: string;
  color: string;
  stacked?: boolean;
  bars: BarData[];
}

export function formatTranscriptionStateTsv(classes: TranscriptionClassData[]): string {
  const rows: unknown[][] = [[
    'record_type', 'class_key', 'class_label', 'class_color',
    'dataset_id', 'dataset_label', 'dataset_color',
    'count', 'total', 'rate', 'percent', 'ci_low', 'ci_high',
    'segment_label', 'segment_count', 'segment_percent', 'segment_color',
  ]];
  for (const cls of classes) {
    for (const bar of cls.bars) {
      const interval = bar.total > 0 ? wilsonInterval(bar.count, bar.total) : undefined;
      rows.push([
        'class', cls.key, cls.label, cls.color,
        bar.dsId, bar.dsLabel, bar.dsColor,
        bar.count, bar.total, bar.total > 0 ? bar.count / bar.total : 0,
        bar.pct, interval?.low, interval?.high,
        '', '', '', '',
      ]);
      for (const segment of bar.segments ?? []) {
        rows.push([
          'segment', cls.key, cls.label, cls.color,
          bar.dsId, bar.dsLabel, bar.dsColor,
          bar.count, bar.total, bar.total > 0 ? bar.count / bar.total : 0,
          bar.pct, interval?.low, interval?.high,
          segment.label, segment.count, segment.pct, segment.color,
        ]);
      }
    }
  }
  return formatTsv(rows);
}

export function TranscriptionStateChart({
  classes,
  width = 280,
}: {
  classes: TranscriptionClassData[];
  width?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rowHeight = 18;
  const classGap = 12;
  const labelWidth = 70;
  const barAreaWidth = width - labelWidth - 70;
  const height = classes.reduce((h, cls) => h + cls.bars.length * rowHeight + classGap + 14, 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    let y = 0;

    for (const cls of classes) {
      ctx.fillStyle = cls.color;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(cls.label, 0, y + 10);
      y += 14;

      for (const bar of cls.bars) {
        ctx.fillStyle = bar.dsColor;
        ctx.fillRect(0, y + 4, 8, 8);

        ctx.fillStyle = '#666';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        const labelText = bar.dsLabel.length > 8 ? bar.dsLabel.slice(0, 7) + '...' : bar.dsLabel;
        ctx.fillText(labelText, 12, y + 12);

        const barX = labelWidth;
        const barY = y + 3;
        const barH = 12;
        ctx.fillStyle = '#f3f4f6';
        ctx.fillRect(barX, barY, barAreaWidth, barH);

        if (bar.segments && bar.segments.length > 0) {
          const totalWidth = (bar.pct / 100) * barAreaWidth;
          let segX = barX;
          const totalCount = bar.segments.reduce((s, seg) => s + seg.count, 0);
          for (const seg of bar.segments) {
            if (seg.count === 0) continue;
            const segWidth = totalCount > 0 ? (seg.count / totalCount) * totalWidth : 0;
            ctx.fillStyle = seg.color;
            ctx.fillRect(segX, barY, Math.max(1, segWidth), barH);
            segX += segWidth;
          }
        } else {
          const barWidth = Math.max(bar.count > 0 ? 2 : 0, (bar.pct / 100) * barAreaWidth);
          ctx.fillStyle = cls.color;
          ctx.globalAlpha = 0.7;
          ctx.fillRect(barX, barY, barWidth, barH);
          ctx.globalAlpha = 1;
        }

        if (bar.total > 0) {
          const ci = wilsonInterval(bar.count, bar.total);
          const lowX = barX + ci.low * barAreaWidth;
          const highX = barX + ci.high * barAreaWidth;
          const centerY = barY + barH / 2;
          ctx.strokeStyle = '#374151';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(lowX, centerY);
          ctx.lineTo(highX, centerY);
          ctx.moveTo(lowX, centerY - 3);
          ctx.lineTo(lowX, centerY + 3);
          ctx.moveTo(highX, centerY - 3);
          ctx.lineTo(highX, centerY + 3);
          ctx.stroke();
        }

        ctx.fillStyle = '#666';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${bar.count}/${bar.total} (${bar.pct.toFixed(0)}%)`, width, y + 12);

        y += rowHeight;
      }

      y += classGap;
    }
  }, [classes, width, height, barAreaWidth]);

  return (
    <div className="relative group">
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block"
      />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename="transcription_states"
        dataTsv={() => formatTranscriptionStateTsv(classes)}
        width={width}
        height={height}
      />
      <ChartMaximizeButton
        title="Transcription States"
        filename="transcription_states"
        renderChart={(w, _h) => (
          <TranscriptionStateChart classes={classes} width={w} />
        )}
      />
    </div>
  );
}
