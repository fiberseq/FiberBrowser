import type { LiftAxis } from './axis';
import { useBrowserStore } from '../../stores/browserStore';
import { useDifferenceSelection } from './inspectionStore';
import { liveLiftHaplotypeColor } from './palette';
import type { Difference } from './differenceTypes';
import { openSourceView } from './sourceView';
import { useLiveLiftStore } from './store';
import type { PanelConfig } from '../../types';

export function ExpansionOverlay({ axis, viewKey, sidebar = 0, panel: enclosing }: { axis: LiftAxis; viewKey: string; sidebar?: number; panel?: PanelConfig | null }) {
  const dark = useBrowserStore(s => s.darkMode);
  const panels = useBrowserStore(s => s.panels);
  return <>{axis.blocks.map(({ x0, x1, ins }) => <div key={ins.ins_id} data-testid="live-lift-expanded-block" data-ins-id={ins.ins_id}
    className="absolute top-0 z-20 text-[10px] h-6 border-x border-slate-300 bg-slate-100/95 dark:bg-slate-800/95"
    style={{ left: sidebar + x0, width: Math.max(1, x1 - x0), color: liveLiftHaplotypeColor(ins.hap_label, dark) }}>
    <div className="absolute top-0 flex items-center gap-2 px-1 h-6 bg-slate-100 dark:bg-slate-800 rounded shadow-sm"
      style={{ left: x0 > 250 ? undefined : 0, right: x0 > 250 ? 0 : undefined }}>
    <button data-testid="live-lift-expanded-collapse" aria-label={`Collapse ${ins.label}`} className="font-bold" onClick={() => useBrowserStore.getState().collapseLiveLift(viewKey, ins.ins_id)}>×</button>
    <strong className="whitespace-nowrap" title={ins.label}>{ins.label}</strong>
    {['Identify', 'Open in HG002 view'].map(action => <button key={action} className="underline whitespace-nowrap" title={action} onClick={() => {
      const panel = (enclosing?.datasetId === ins.datasetId ? enclosing : undefined)
        ?? panels.find(p => p.datasetId === ins.datasetId && p.liftHap === ins.hap_label)
        ?? panels.find(p => p.datasetId === ins.datasetId);
      if (!panel || !ins.datasetId) return;
      const allele = ins.alleles?.find(a => a.hap_label === panel.liftHap);
      const difference: Difference = { id: allele?.ins_id ?? ins.ins_id, hap: allele?.hap_label ?? ins.hap_label, hap_label: allele?.hap_label ?? ins.hap_label, kind: allele?.kind ?? ins.kind ?? 'insertion', reason: 'alternate_block', source: 'assembly',
        t_start: ins.pos, t_end: allele?.t_end ?? ins.t_end ?? ins.pos, ref_bp: allele?.ref_bp ?? ins.ref_bp ?? 0, alt_bp: allele?.length ?? ins.selected_length ?? ins.length, chain: null, strand: allele ? allele.strand ?? null : ins.strand ?? null,
        src: (allele ? allele.src : ins.src) ?? { contig: null, start: null, end: null }, grch38: null, alt: null };
      const selection = { panelId: panel.id, datasetId: ins.datasetId, viewKey, chrom: ins.chrom, difference };
      if (action === 'Identify') useDifferenceSelection.getState().select({ ...selection, action: 'identify' });
      else void openSourceView(selection);
    }}>{action}</button>)}
    </div>
  </div>)}</>;
}

/** A selected site is visible in native siblings too, without creating a
 * genomic highlight region or altering the user's existing region selection. */
export function DifferenceGuide({ axis, viewKey, chrom, sidebar = 0 }: { axis: LiftAxis; viewKey: string; chrom: string; sidebar?: number }) {
  const selection = useDifferenceSelection(s => s.selection);
  const enabled = useLiveLiftStore(s => s.enabled);
  const present = useBrowserStore(s => s.panels.some(p => p.id === selection?.panelId));
  if (!enabled || !present || !selection || selection.viewKey !== viewKey || selection.chrom !== chrom) return null;
  return <div data-testid="live-lift-difference-guide" className="absolute inset-y-0 border-l border-dashed border-amber-500 pointer-events-none z-10"
    style={{ left: sidebar + axis.toX(selection.difference.t_start) }} />;
}
