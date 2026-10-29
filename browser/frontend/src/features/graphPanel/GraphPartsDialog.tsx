import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ClusterMatchedRun } from '../../utils/clusterMatchedRun';

interface Part { kind: string; label: string; length: number; samples: number; carriers?: string[]; reason?: string; frame_span?: [number, number] }

/** The run's authoritative parts and carriers, including parts dropped by the chosen run options. */
export function graphParts(run: ClusterMatchedRun): { part: Part; carriers: string[]; status: string }[] {
  const columns = run.graph?.columns as { shared?: Part[]; carrier_sets?: { carriers: string[]; features: Part[] }[]; dropped?: Part[] } | undefined;
  if (!columns) return [];
  const labels = new Map(run.graph?.observations.map(o => [o.id, o.label]));
  const names = (ids: string[]) => ids.map(id => labels.get(id) ?? id);
  return [
    ...(columns.shared ?? []).map(part => ({ part, carriers: names(part.carriers ?? run.graph!.observations.map(o => o.id)), status: 'Shared fit' })),
    ...(columns.carrier_sets ?? []).flatMap(set => set.features.map(part => ({ part, carriers: names(set.carriers), status: 'Carrier refinement' }))),
    ...(columns.dropped ?? []).map(part => ({ part, carriers: names(part.carriers ?? []), status: part.reason ?? 'Dropped' })),
  ];
}

export function GraphPartsDialog({ run, onClose }: { run: ClusterMatchedRun; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const rows = graphParts(run);
  return createPortal(<div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/30" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label="Graph regions and carriers" data-testid="graph-parts-dialog"
      className="max-h-[80vh] max-w-3xl overflow-auto rounded bg-white p-4 shadow-xl dark:bg-stone-900" onClick={e => e.stopPropagation()}>
      <div className="mb-2 flex items-center justify-between gap-4"><strong>Graph regions and carriers</strong><button autoFocus type="button" onClick={onClose}>Close</button></div>
      <p className="mb-2 text-xs">Parts of the current run. Repeat columns: {String(run.graph?.options.repeat_columns ?? 'exclude')}; carrier features: {String(run.graph?.options.carrier_features ?? 'refine')}.</p>
      <table className="text-left text-xs"><thead><tr><th className="p-1">Part</th><th className="p-1">Bases / samples</th><th className="p-1">Carriers</th><th className="p-1">Use</th></tr></thead>
        <tbody>{rows.map(({ part, carriers, status }, i) => <tr key={i} className="border-t border-stone-200 dark:border-stone-700">
          <td className="p-1">{part.kind}: {part.label}</td><td className="p-1">{(part.frame_span ? part.frame_span[1] - part.frame_span[0] : part.length).toLocaleString()} / {part.samples}</td>
          <td className="p-1">{carriers.join(', ') || 'None'}</td><td className="p-1">{status}</td>
        </tr>)}</tbody></table>
      {!rows.length && <p className="text-xs">This run has no recorded parts.</p>}
    </div>
  </div>, document.body);
}
