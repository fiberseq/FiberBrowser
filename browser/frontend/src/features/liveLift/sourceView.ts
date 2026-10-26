import { addDataset } from '../../api/datasets';
import { attachPanelGenome } from '../../api/panelGenomes';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { useBrowserStore } from '../../stores/browserStore';
import { createDefaultSubTracks, generatePanelId } from '../../stores/utils';
import { registerViewLink } from '../../utils/panelExtensions';
import { openAltAllelePanel } from '../altAllele/altAllelePanel';
import type { DifferenceSelection } from './inspectionStore';
import { useLiveLiftStore } from './store';
import { sourceHapLabel, sourceSampleLabel, sourceSampleName } from './sampleLabel';

interface SourceLink { chrom: string; pos: number; targetEnd?: number; contig: string; start: number; end: number; reversed: boolean }
declare module '../../types' { interface PanelConfig { liveLiftSource?: SourceLink } }

/** Only the difference and its flanks are anchored by this local link. The
 * source panel names its own contig/reference; it never pretends to be hg38. */
registerViewLink({
  toPanel: (panel, main) => {
    if (!useLiveLiftStore.getState().enabled) return undefined;
    const l = panel.liveLiftSource;
    if (!l) return undefined;
    const targetEnd = l.targetEnd ?? l.pos;
    if (main.chrom !== l.chrom || main.end < l.pos || main.start > targetEnd) return null;
    const source = (p: number, right: boolean) => p < l.pos ? l.start + p - l.pos
      : p > targetEnd ? l.end + p - targetEnd : right ? l.end : l.start;
    const a = source(main.start, false), b = source(main.end, true);
    const lo = l.reversed ? l.start + l.end - b : a;
    const hi = l.reversed ? l.start + l.end - a : b;
    const size = usePanelGenomeStore.getState().genomes[panel.genome ?? '']?.chroms.find(c => c.name === l.contig)?.size;
    // The allele remains a boundary; its panel needs a nonempty neighborhood
    // for fetching reads when the target view lies entirely in a deletion.
    return { chrom: l.contig, start: Math.max(0, lo === hi ? lo - 1000 : lo),
      end: Math.min(size ?? Infinity, lo === hi ? hi + 1000 : hi) };
  },
  toMain: (panel, next) => {
    if (!useLiveLiftStore.getState().enabled) return undefined;
    const l = panel.liveLiftSource;
    if (!l) return undefined;
    if (next.chrom !== l.contig) return null;
    const targetEnd = l.targetEnd ?? l.pos;
    const target = (p: number, right: boolean) => p < l.start ? l.pos + p - l.start
      : p > l.end ? targetEnd + p - l.end : right ? targetEnd : l.pos;
    const a = target(l.reversed ? l.start + l.end - next.end : next.start, false);
    const b = target(l.reversed ? l.start + l.end - next.start : next.end, true);
    // A source view wholly inside the insertion leaves the main view centred
    // at its boundary, retaining enough context to keep the strip usable.
    return { chrom: l.chrom, start: Math.max(0, a === b ? a - 1000 : a), end: a === b ? b + 1000 : b };
  },
});

export async function openSourceView(s: DifferenceSelection): Promise<void> {
  const st = useBrowserStore.getState();
  const dataset = st.datasets.find(d => d.id === s.datasetId);
  const d = s.difference;
  if (!dataset || !d.src.contig || d.src.start === null || d.src.end === null) return;
  try {
    // Reuse an ordinary source BAM if already open; the header-contig reference
    // path works without a source-assembly FASTA and is persisted like alt-allele panels.
    let native = st.datasets.find(n => n.data_type === 'bam' && n.path === dataset.path);
    if (!native) {
      const result = await addDataset(dataset.paths?.length ? dataset.paths : dataset.path, `${dataset.label} · ${sourceSampleName(dataset) ? `${sourceSampleName(dataset)} source` : 'source assembly'}`);
      if (!result.success || !result.dataset || result.dataset.data_type !== 'bam') throw new Error(result.error ?? 'Cannot open the source BAM as a native dataset');
      native = result.dataset;
    }
    const references = usePanelGenomeStore.getState();
    const existing = references.genomes[references.assignments[native.id]];
    const attached = existing?.chroms.some(c => c.name === d.src.contig) ? { success: true, genome: existing }
      : await attachPanelGenome({ dataset_ids: [native.id], contigs: true, span: 0 });
    if (!attached.success || !attached.genome) throw new Error(attached.error ?? 'Cannot attach the BAM-header reference');
    await usePanelGenomeStore.getState().refresh();
    const id = generatePanelId(), source = native;
    useBrowserStore.setState(state => ({
      datasets: state.datasets.some(n => n.id === source.id) ? state.datasets : [...state.datasets, source],
      slotOrder: state.slotOrder.includes(source.id) ? state.slotOrder : [...state.slotOrder, source.id],
      panels: [...state.panels, { id, contentType: 'dataset', datasetId: source.id, stateKey: `${id}~hg002`,
        subTracks: createDefaultSubTracks(state.orthogonalTracks, state.compositeTracks), collapsed: false, linkGroup: null,
        layoutRow: 0, genome: attached.genome!.key, ownLocus: true, siteLocked: false,
        title: `${sourceHapLabel(dataset, d.hap_label)} ${d.kind}`, titleDetail: `Local link anchored at the ${d.kind}`,
        viewportOverride: { chrom: d.src.contig!, start: Math.max(0, d.src.start! - 1000), end: d.src.end! + 1000 },
        ...(s.viewKey === 'main' ? { liveLiftSource: { chrom: s.chrom, pos: d.t_start, targetEnd: d.t_end, contig: d.src.contig!, start: d.src.start!, end: d.src.end!, reversed: d.strand === '-' } } : {}),
      }],
    }));
    useBrowserStore.getState().pushSnapshot(`Open ${d.kind} in ${sourceSampleLabel(dataset)} source view`, { kind: 'layout' });
  } catch (e) {
    // The native match is the existing alt-allele path's accepted input.
    const native = st.datasets.find(n => n.data_type === 'bam' && n.path !== dataset.path);
    if (native && d.read_support && d.kind === 'insertion') {
      await openAltAllelePanel({ datasetId: native.id, chrom: s.chrom, ref: d.t_start, len: d.alt_bp }, { afterPanelId: s.panelId });
    } else useBrowserStore.getState().setError(`${sourceSampleName(dataset) ? `${sourceSampleName(dataset)} source` : 'Source assembly'} view: ${(e as Error).message}. An alt-allele fallback requires matching native insertion evidence.`);
  }
}
