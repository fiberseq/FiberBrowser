import { SIGNAL_LABELS } from '../../../utils/signalFilters';
import type { CompactRead } from './types';
import type { ReadStateInfo } from '../../../types/clustering';
import { getClusterColor, getClusterLabel } from './constants';
import { clusterAssignmentForRead } from './readFilter';
import { tfFamilyMetadata } from '../../../utils/tfFamilies';
import { consensusRecordSummary } from '../../../utils/consensusVisual';

interface ReadTooltipProps {
  hoveredRead: { read: CompactRead; x: number; y: number };
  width: number;
  height: number;
  chrom: string;
  start: number;
  myClusterAssignments: Record<string, number>;
  myReadStateDetails: Record<string, ReadStateInfo> | null;
  annotationOverlays?: Record<string, Array<{ start: number; end: number; type: string; confidence: number }>> | null;
  annotationColors?: Record<string, string>;
}

export function ReadTooltip({
  hoveredRead, width, height, chrom, start,
  myClusterAssignments, myReadStateDetails,
  annotationOverlays, annotationColors,
}: ReadTooltipProps) {
  const read = hoveredRead.read;
  const footprints = read.intervals.filter(iv => iv[2] > 0);
  const allPositions = read.intervals;
  const readStart = allPositions.length > 0 ? Math.min(...allPositions.map(iv => iv[0])) : 0;
  const readEnd = allPositions.length > 0 ? Math.max(...allPositions.map(iv => iv[1])) : 0;
  const readSize = readEnd - readStart;
  const cluster = clusterAssignmentForRead(myClusterAssignments, read.id);
  const state = myReadStateDetails?.[read.id];
  const familySummaries = ([
    ['XCR', read.layers?.tf_cross_consensus],
    ['CR', read.layers?.tf_consensus],
    ['SR family', read.layers?.tf_sr],
  ] as const).map(([label, familyLayer]) => {
    const calls = (familyLayer?.intervals ?? [])
      .map((_interval, index) => tfFamilyMetadata(familyLayer, index))
      .filter((value): value is NonNullable<typeof value> => value != null);
    const value = calls.slice(0, 4).map(family => (
      `F${String(family.familyId).padStart(3, '0')} ${family.confidenceKind === 'unavailable' ? 'confidence unavailable' : Math.round(100 * family.familyConfidence)+'%'}`
    )).join(', ');
    return { label, calls, value };
  }).filter(summary => summary.calls.length > 0);
  const propagatedConsensus = Object.values(read.layers ?? {}).some(layer => (
    (layer.annotation_names ?? []).some(name => /^fhlt_[0-9a-f]+_P_/i.test(name))
  ));

  return (
    <div
      data-fb-hover-tip=""
      className="absolute pointer-events-none bg-gray-900 text-white px-2.5 py-1.5 rounded text-xs shadow-lg z-30 whitespace-nowrap"
      style={{
        left: Math.min(hoveredRead.x + 12, width - 220),
        top: Math.max(4, Math.min(height - 80, hoveredRead.y - 10)),
      }}
    >
      <div className="font-mono text-[11px] mb-1 text-gray-200 truncate max-w-[200px]" title={read.id}>
        {read.id}
      </div>
      <div className="text-gray-300 text-[11px] space-y-0.5">
        {read.signal && <div data-testid="signal-read-status">{SIGNAL_LABELS[read.signal.status]}</div>}
        <div>Footprints: {footprints.length}{read.qualities ? ` (${footprints.length} scored)` : ''}</div>
        {familySummaries.map(summary => (
          <div key={summary.label}>
            {summary.label}: {summary.value}
            {summary.calls.length > 4 ? ` +${summary.calls.length - 4}` : ''}
          </div>
        ))}
        {Object.entries(read.layers??{}).filter(([,layer])=>layer.consensus_workflow).map(([name,layer])=><div key={name}>
          {name}: {(layer.consensus_records??[]).slice(0,3).map(consensusRecordSummary).join('; ')}{(layer.consensus_records?.length??0)>3?' …':''}
        </div>)}
        {propagatedConsensus && (
          <div className="text-amber-300">Consensus: PCR-propagated hypothesis</div>
        )}
        <div>Span: {readSize.toLocaleString()} bp ({chrom}:{(start + readStart).toLocaleString()}-{(start + readEnd).toLocaleString()})</div>
        {cluster !== undefined && (
          <div className="flex items-center gap-1">
            Cluster: <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: getClusterColor(cluster) }}
            /> {getClusterLabel(cluster)}
          </div>
        )}
        {state && (
          <div>
            State: {state.pause ? 'Pause' : state.pic ? 'PIC' : state.elongating_count ? `Elong (${state.elongating_count})` : '\u2014'}
          </div>
        )}
        {annotationOverlays && annotationOverlays[read.id] && (
          <div>
            Annotations: {annotationOverlays[read.id].map(a =>
              `${a.type} (${a.confidence.toFixed(2)})`
            ).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

interface ClusterTooltipProps {
  hoverCluster: number;
  hoverY: number;
  sidebarWidth: number;
  height: number;
  clusterCounts: Map<number, number>;
  visibleClusterCounts: Map<number, number>;
  clusterStateConsensus: Map<number, { pause: number; pic: number; elongating: number; total: number }>;
}

export function ClusterTooltip({
  hoverCluster, hoverY, sidebarWidth, height,
  clusterCounts, visibleClusterCounts, clusterStateConsensus,
}: ClusterTooltipProps) {
  const assignedCount = clusterCounts.get(hoverCluster) || 0;
  const visibleCount = visibleClusterCounts.get(hoverCluster) || 0;
  const countLabel = assignedCount > 0 && visibleCount !== assignedCount
    ? `${visibleCount}/${assignedCount} visible`
    : `${assignedCount} reads`;

  return (
    <div
      data-fb-hover-tip=""
      className="absolute pointer-events-none bg-gray-900 text-white px-2 py-1 rounded text-xs shadow-lg z-20 whitespace-nowrap"
      style={{
        left: sidebarWidth + 4,
        top: Math.max(4, Math.min(height - 50, hoverY - 12)),
      }}
    >
      <span
        className="inline-block w-3 h-3 rounded-sm mr-1.5 align-middle"
        style={{ backgroundColor: getClusterColor(hoverCluster) }}
      />
      {getClusterLabel(hoverCluster)}
      <span
        className="text-gray-400 ml-1"
        title="Visible rows / total assigned reads for this cluster"
      >
        ({countLabel})
      </span>
      {clusterStateConsensus.has(hoverCluster) && (
        <div className="mt-1 text-gray-300 text-[11px]">
          {(() => {
            const c = clusterStateConsensus.get(hoverCluster)!;
            const stateLabels: [string, number, string][] = [];
            if (c.pause > 0) stateLabels.push(['P', c.pause, 'Pause']);
            if (c.pic > 0) stateLabels.push(['I', c.pic, 'PIC']);
            if (c.elongating > 0) stateLabels.push(['E', c.elongating, 'Elong']);
            if (stateLabels.length === 0) return null;
            return stateLabels.map(([key, count, label]) => (
              <span key={key} className="mr-1.5">
                <span className={
                  key === 'P' ? 'text-pink-400' :
                  key === 'I' ? 'text-[#60a5fa]' :
                  key === 'E' ? 'text-green-400' : 'text-orange-400'
                }>{label}</span>:{count}
              </span>
            ));
          })()}
        </div>
      )}
    </div>
  );
}
