/**
 * A quantification in the Plots workspace: drawn from its card's stored result with the same component as the card
 * under the metaprofiles (QuantResultView). Display choices (bars / lines / table, sort) are local; the numbers are
 * re-computed only by the panel that made them (its Quantify card).
 */
import { useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { SuppliedData } from '../plots/gallery';
import { formatLocus, plotDisplayName, type PlotSpec } from '../plots/plotModel';
import { QuantResultView } from './QuantResultView';
import type { QuantSpec } from './spec';

export function QuantPlot({ plot, data, width }: { plot: PlotSpec; data: SuppliedData | null; width: number }) {
  const dark = useBrowserStore(s => s.darkMode);
  const rec = plot.supplied!.quant!;
  const [display, setDisplay] = useState<Partial<Pick<QuantSpec, 'chart' | 'view' | 'sort'>>>({});
  const spec = { ...rec.spec, ...display };
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-quant-plot" data-state={data?.quant ? 'current' : 'missing'}>
      <span className="text-[11px] text-ink-secondary" data-testid="plots-quant-origin">From <b className="font-semibold">{plot.supplied!.origin}</b> · {formatLocus(plot.pinned)} · {rec.bounds.kind === 'window' ? 'window' : rec.bounds.kind === 'sites' ? 'meta-locus sites' : 'whole region'} · sampling {plot.sampling.n.toLocaleString('en-US')} reads per dataset, seed {plot.sampling.seed} · re-run in that panel to recompute</span>
      {data?.quant ? (
        <QuantResultView result={data.quant} spec={spec} width={width} dark={dark} measuresText={plot.supplied!.measures ?? ''}
          filename={plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)} onDisplay={p => setDisplay(d => ({ ...d, ...p }))} />
      ) : <div className="text-[11px] text-ink-secondary" role="status">The values of this card are not stored here: re-run Quantify in its panel.</div>}
    </div>
  );
}
