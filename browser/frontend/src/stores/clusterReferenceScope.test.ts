import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../types';
import { clusterReferenceScope, clusterRunLabel, peakReference } from './clusterSlice';
import { useBrowserStore } from './browserStore';
import { clusterChartRunPeaks } from '../components/controls/cluster-detail/clusterChartScope';

const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

// The audit's layout (H1): the hg38 demo at its own locus (Per panel mode) and a dm6 amplicon panel.
const st = {
  chrom: 'chr19', start: 47_514_037, end: 47_518_985,
  panels: [
    panel('ph', 'napa', { viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 } }),
    panel('pf', 'flyamp', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
  ],
};
const win = (key: string, chrom: string, start: number, end: number) => ({ dataset_id: key, result_key: key, chrom, start, end });
const windows = [win('napa', 'chr19', 47_514_262, 47_519_210), win('flyamp', 'chr2L', 6_356_793, 6_357_648)];
const human = [
  { start: 47_515_000, end: 47_515_200, mode: 'accessibility', chrom: 'chr19' },
  { start: 47_516_000, end: 47_516_200, mode: 'accessibility' },
];
const fly = [
  // Scanned in the dm6 panel (its reference recorded) and drawn there (its chromosome only).
  { start: 6_356_930, end: 6_357_166, mode: 'accessibility', chrom: 'chr2L', genome: 'dm6' },
  { start: 6_357_191, end: 6_357_572, mode: 'accessibility', chrom: 'chr2L' },
];
const name = (genome: string | null) => genome ?? 'hg38';

describe('clustering one reference at a time (audit H1)', () => {
  it('two builds of one insertion share a name: the refusal says the peaks are on another build (round 3 integration)', () => {
    const alt = {
      chrom: 'chr2L', start: 9_455_000, end: 9_495_000,
      panels: [panel('carriers', 'numb_alt', { genome: 'fasta:alt_b', viewportOverride: { chrom: 'chr2L_9467038_INS9185', start: 0, end: 20_000 } })],
    };
    const altName = (g: string | null) => (g?.startsWith('fasta:alt_') ? 'Alt allele chr2L:9,467,038 +9,185 bp' : 'dm6');
    const scope = clusterReferenceScope(alt, [win('numb_alt', 'chr2L_9467038_INS9185', 0, 20_000)],
      [{ start: 9_100, end: 9_400, mode: 'accessibility', chrom: 'chr2L_9467038_INS9185', genome: 'fasta:alt_a' }], altName);
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.message).toContain('another build of Alt allele chr2L:9,467,038 +9,185 bp');
    expect(scope.message).not.toContain('but the panels to cluster are on');
  });

  it('a peak is on its own reference, else on the reference of the panels showing it', () => {
    expect(fly.map(p => peakReference(st, p))).toEqual(['dm6', 'dm6']);
    expect(human.map(p => peakReference(st, p))).toEqual([null, null]);
  });

  it('peaks selected on hg38 and dm6 are refused, with the way out', () => {
    const scope = clusterReferenceScope(st, windows, [...human, ...fly], name);
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.message).toContain('Peaks are selected on hg38 and dm6');
    expect(scope.message).toContain('cluster one reference at a time');
  });

  it('peaks on one reference: only its panels are clustered, the others are named', () => {
    const scope = clusterReferenceScope(st, windows, human, name);
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.genome).toBeNull();
    expect(scope.windows.map(w => w.result_key)).toEqual(['napa']);
    expect(scope.leftOut.map(w => w.result_key)).toEqual(['flyamp']);
    expect(scope.note).toBe('1 panel on dm6 was not clustered: the selected peaks are on hg38, and reads of two assemblies can\'t share clusters.');

    const flyOnly = clusterReferenceScope(st, windows, fly, name);
    expect(flyOnly.ok && flyOnly.windows.map(w => w.result_key)).toEqual(['flyamp']);
    expect(flyOnly.ok && flyOnly.genome).toBe('dm6');
  });

  it('a selected panel scopes the run: the other reference\'s peaks are not used', () => {
    const scope = clusterReferenceScope(st, [windows[1]], [...human, ...fly], name);
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.peaks).toEqual(fly);
    expect(scope.leftOut).toEqual([]);
    expect(scope.note).toBeUndefined();
  });

  it('peaks only on a reference no clustered panel is on are refused', () => {
    const scope = clusterReferenceScope(st, [windows[0]], fly, name);
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.message).toContain('The selected peaks are on dm6, but the panels to cluster are on hg38');
  });

  it('a peak drawn in a panel on another assembly records it (Codex review: same chromosome names)', () => {
    useBrowserStore.getState().addCustomPeak(1_100, 1_200, 'chr1', 'mm10');
    const drawn = useBrowserStore.getState().getAllPeaks().find(p => p.isCustom && p.start === 1_100);
    expect(drawn?.genome).toBe('mm10');
    // An hg38 panel showing the same coordinates doesn't claim it.
    const overlapping = { chrom: 'chr1', start: 1_000, end: 2_000, panels: [panel('ph', 'h'), panel('pm', 'm', { genome: 'mm10', viewportOverride: { chrom: 'chr1', start: 1_000, end: 2_000 } })] };
    expect(peakReference(overlapping, drawn!)).toBe('mm10');
  });

  it('copies of a locus on one reference still cluster together', () => {
    const copies = { ...st, panels: [panel('pa', 'a'), panel('pb', 'b', { viewportOverride: { chrom: 'chr7', start: 1_000, end: 5_000 } })] };
    const scope = clusterReferenceScope(copies, [win('a', 'chr19', 47_514_037, 47_518_985), win('b', 'chr7', 1_000, 5_000)], human, name);
    expect(scope.ok && scope.windows.length).toBe(2);
  });
});

describe('per-panel matched peaks survive the cluster tree', () => {
  it('a branch applied again restores a copy of the peaks; the copies still get their own', () => {
    const st = useBrowserStore.getState();
    st.setClusterAssignments('a', { r1: 0 });
    st.setClusterAssignments('b', { r2: 0 });
    const regions = [{ start: 1_100, end: 1_200, mode: 'accessibility', chrom: 'chr1' }];
    st.setClusterPeakRegions(regions);
    st.setClusterWindowPeaks({ regions, byKey: { a: [{ start: 1_100, end: 1_200 }], b: [{ start: 5_100, end: 5_200 }] } });
    const id = useBrowserStore.getState().captureActiveClusterTreeNode({ name: 'All reads' })!;
    useBrowserStore.getState().applyClusterTreeNode(id);
    const now = useBrowserStore.getState();
    expect(clusterChartRunPeaks(now.clusterPeakRegions, now.clusterWindowPeaks, ['b'], { chrom: 'chr1', genome: null, start: 5_000, end: 6_000 }, 'chr1'))
      .toEqual([{ start: 5_100, end: 5_200 }]);
  });
});

describe('cluster undo label (audit L7)', () => {
  it('names the parameter the method takes', () => {
    expect(clusterRunLabel('graph', 10, 1)).toBe('Cluster Neighbourhoods resolution 1');
    expect(clusterRunLabel('graph', 10, 0.75)).toBe('Cluster Neighbourhoods resolution 0.75');
    expect(clusterRunLabel('graph', 10)).toBe('Cluster Neighbourhoods');
    expect(clusterRunLabel('kmeans', 6)).toBe('Cluster K-means (exact) k=6');
    expect(clusterRunLabel('minibatch', 4)).toBe('Cluster K-means (fast) k=4');
    expect(clusterRunLabel('hdbscan', 10)).toBe('Cluster HDBSCAN');
    expect(clusterRunLabel('combinatorial', 10)).toBe('Cluster Combinatorial');
  });
});
