import { useState, useEffect, useCallback, useRef } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchApiResponse } from '../../api/sharedFetch';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { HistogramChart } from '../charts/HistogramChart';
import { DonutChart } from '../charts/DonutChart';
import { HeatmapChart } from '../charts/HeatmapChart';
import { OverlayProfileChart } from '../charts/OverlayProfileChart';
import { VPlotChart } from '../charts/VPlotChart';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisStatus } from './shared';
import { ChartSaveButton } from '../charts/ChartSaveButton';
import { downloadTextFile, exportTimestamp, formatTsv } from '../../utils/analysisExport';

interface PluginChartResponse {
  chart_type: string;
  title?: string;
  error?: string;
  // histogram
  groups?: { label: string; bars: { label: string; value: number; color: string }[] }[];
  y_label?: string;
  // donut
  segments?: { label: string; value: number; color: string }[];
  // heatmap
  matrix?: number[][];
  row_labels?: string[];
  col_labels?: string[];
  // profile
  series?: { data: number[]; color: string; label: string }[];
  // scatter
  x_label?: string;
  points?: { x: number; y: number; label?: string; color?: string }[];
  // vplot
  size_min?: number;
  size_max?: number;
  size_bin?: number;
  pos_bin?: number;
  // table
  columns?: string[];
  rows?: Record<string, unknown>[];
  // image
  src?: string;
  // multi
  charts?: PluginChartResponse[];
}

interface Props {
  isFullView?: boolean;
  apiPrefix?: string;
}

type PluginTab = 'visualization';

const PLUGIN_TABS: { key: PluginTab; label: string }[] = [
  { key: 'visualization', label: 'Visualization' },
];

export function PythonPluginPanel({ isFullView, apiPrefix }: Props) {
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);

  const [containerWidth, containerRef] = useContainerWidth(280);
  const [data, setData] = useState<PluginChartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const chartWidth = Math.max(200, containerWidth - 16);
  const regionLabel = `${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`;

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestSeqRef.current;
    if (!apiPrefix) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApiResponse(
        `${apiPrefix}/data?chrom=${encodeURIComponent(chrom)}&start=${start}&end=${end}`,
        { signal },
      );
      if (signal?.aborted || requestId !== requestSeqRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (signal?.aborted || requestId !== requestSeqRef.current) return;
      if (json.error) {
        setError(json.error);
        setData(null);
      } else {
        setData(json);
      }
    } catch (err) {
      if (signal?.aborted || requestId !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Plugin fetch failed');
      setData(null);
    } finally {
      if (!signal?.aborted && requestId === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [apiPrefix, chrom, start, end]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchData(controller.signal);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchData]);

  return (
    <div ref={containerRef} className="p-3 text-sm">
      <AnalysisPanelShell
        tabs={PLUGIN_TABS}
        activeTab="visualization"
        onTabChange={() => undefined}
        theme="indigo"
        showTabs={false}
        isFullView={isFullView}
        header={(
          <AnalysisPanelHeader
            title="Python Plugin"
            detail="Viewport-scoped plugin output from the local Python bridge."
            meta={apiPrefix ? regionLabel : undefined}
            theme="indigo"
            actions={apiPrefix && (
              <AnalysisButton
                type="button"
                onClick={() => void fetchData()}
                theme="indigo"
                variant="outline"
              >
                Refresh
              </AnalysisButton>
            )}
          />
        )}
        summary={(
          <AnalysisRunSummary
            inputs={apiPrefix ? [regionLabel] : []}
            outputs={data?.chart_type ? [data.chart_type] : []}
          />
        )}
      >
        {loading && <AnalysisStatus kind="loading" compact>Loading plugin output...</AnalysisStatus>}
        {error && <AnalysisStatus kind="error" compact>{error}</AnalysisStatus>}
        {!apiPrefix && (
          <AnalysisStatus kind="empty" compact>
            No plugin route is attached to this panel.
          </AnalysisStatus>
        )}
        {apiPrefix && !loading && !error && !data && (
          <AnalysisStatus kind="empty" compact>
            No plugin data returned for this viewport.
          </AnalysisStatus>
        )}
        {data && <ChartRenderer data={data} width={chartWidth} height={isFullView ? 300 : 180} />}
      </AnalysisPanelShell>
    </div>
  );
}

function ChartRenderer({ data, width, height }: { data: PluginChartResponse; width: number; height: number }) {
  switch (data.chart_type) {
    case 'histogram':
      return data.groups ? (
        <HistogramChart groups={data.groups} yLabel={data.y_label || ''} width={width} height={height} />
      ) : null;

    case 'donut':
      return data.segments ? (
        <DonutChart segments={data.segments} width={width} height={height} title={data.title} />
      ) : null;

    case 'heatmap':
      return data.matrix ? (
        <HeatmapChart
          matrix={data.matrix}
          colormap="viridis"
          rowLabels={data.row_labels}
          colLabels={data.col_labels}
          width={width}
          height={height}
        />
      ) : null;

    case 'profile':
      return data.series ? (
        <OverlayProfileChart series={data.series} width={width} height={height} showLegend />
      ) : null;

    case 'vplot':
      return data.matrix ? (
        <VPlotChart
          matrix={data.matrix}
          sizeMin={data.size_min || 10}
          sizeMax={data.size_max || 300}
          sizeBin={data.size_bin || 10}
          posBin={data.pos_bin || 10}
          windowBp={0}
          width={width}
          height={height}
          filename="plugin_vplot"
        />
      ) : null;

    case 'table':
      return data.columns && data.rows ? (
        <PluginTable columns={data.columns} rows={data.rows} />
      ) : null;

    case 'image':
      return data.src ? <img src={data.src} alt={data.title || 'Plugin chart'} style={{ maxWidth: width }} /> : null;

    case 'multi':
      return data.charts ? (
        <div className="space-y-3">
          {data.charts.map((chart, i) => (
            <div key={i}>
              {chart.title && <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-400 mb-1">{chart.title}</div>}
              <ChartRenderer data={chart} width={width} height={Math.round(height * 0.7)} />
            </div>
          ))}
        </div>
      ) : null;

    case 'scatter':
      return data.points ? <ScatterCanvas points={data.points} xLabel={data.x_label} yLabel={data.y_label} width={width} height={height} /> : null;

    default:
      return <div className="text-xs text-gray-400">Unknown chart type: {data.chart_type}</div>;
  }
}

function ScatterCanvas({ points, xLabel, yLabel, width, height }: {
  points: { x: number; y: number; label?: string; color?: string }[];
  xLabel?: string;
  yLabel?: string;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const pad = { top: 10, right: 10, bottom: 30, left: 40 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    // Points
    ctx.globalAlpha = 0.5;
    for (const p of points) {
      const px = pad.left + ((p.x - xMin) / xRange) * plotW;
      const py = pad.top + plotH - ((p.y - yMin) / yRange) * plotH;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = p.color || '#6366f1';
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Axes
    ctx.strokeStyle = '#ccc';
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    ctx.fillStyle = '#999';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    if (xLabel) ctx.fillText(xLabel, pad.left + plotW / 2, height - 4);
    ctx.save();
    ctx.translate(10, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    if (yLabel) ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }, [points, xLabel, yLabel, width, height]);

  return (
    <div className="relative group" style={{ width, height }}>
      <canvas ref={canvasRef} style={{ width, height }} className="block" />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename="plugin_scatter"
        width={width}
        height={height}
        dataTsv={() => formatTsv([
          ['point_index', 'label', 'x', 'y', 'color', 'x_axis', 'y_axis'],
          ...points.map((point, index) => [index, point.label, point.x, point.y, point.color, xLabel, yLabel]),
        ])}
      />
    </div>
  );
}

function PluginTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const exportTable = () => downloadTextFile(
    formatTsv([columns, ...rows.map(row => columns.map(column => row[column]))]),
    `plugin_table_${exportTimestamp()}.tsv`,
    'text/tab-separated-values',
  );
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <AnalysisButton onClick={exportTable} variant="neutral" size="xs">Export TSV</AnalysisButton>
      </div>
      <div className="overflow-auto max-h-60 text-[11px]">
        <table className="w-full border-collapse">
          <thead>
            <tr>{columns.map(column => <th key={column} className="text-left px-1 py-0.5 border-b border-gray-200 dark:border-gray-700 font-medium">{column}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                {columns.map(column => <td key={column} className="px-1 py-0.5 border-b border-gray-100 dark:border-gray-800">{String(row[column] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
