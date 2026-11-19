/**
 * FiberHMM variant-allele and SV-event layers (bigBed datasets): their per-dataset settings in the browser store,
 * and Show / Hide items on a read panel's row menu. The Variants panel's SNP, combination and SV tabs read these
 * layers through their usual endpoints (the server answers from them for a bigBed dataset).
 */
import { extendTrackMenu } from '../../components/tracks/trackRegistry';
import { useBrowserStore } from '../../stores/browserStore';
import { datasetVariantLayers } from './model';
import { layerSettingsFor, registerFiberhmmLayerState, setLayerSettings } from './state';

let done = false;

export function registerFiberhmmLayers(): void {
  if (done) return;
  done = true;
  registerFiberhmmLayerState();
  extendTrackMenu('reads', ctx => {
    const id = ctx.datasetId;
    if (!id) return [];
    const state = useBrowserStore.getState();
    const has = datasetVariantLayers(state.datasets.find(d => d.id === id));
    const s = layerSettingsFor(state, id);
    const items = [];
    if (has.sv) {
      items.push({
        id: 'fiberhmm-sv', icon: 'eye' as const, label: s.sv ? 'Hide FiberHMM SV events' : 'Show FiberHMM SV events',
        title: 'Deletions, insertions and clips from the sample\'s fiberhmm_sv layer on the reads, and the SV band',
        run: () => setLayerSettings(id, { sv: !s.sv }),
      });
    }
    if (has.var) {
      items.push({
        id: 'fiberhmm-var', icon: 'eye' as const, label: s.var ? 'Hide FiberHMM allele marks' : 'Show FiberHMM allele marks',
        title: 'Each read\'s allele at the VCF sites of the sample\'s fiberhmm_var layer (REF, ALT, other, ambiguous after DAF conversion)',
        run: () => setLayerSettings(id, { var: !s.var }),
      });
    }
    return items;
  });
}
