import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fixture from '../../../../tests/data/sv_conflicts.json';
import regressions from '../../../../tests/data/sv_conflict_regressions.json';
import visibility from '../../../../tests/data/sv_visibility.json';
import { clipConflict, normalizeSvConflictOptions } from './svConflicts';
import { supportingReadIds, svEvidenceLevel, visibleSvSummary } from '../components/tracks/read-track/svDrawing';
import type { CompactRead, SvCluster } from '../components/tracks/read-track/types';
import { describeCarrier, layoutLens, type LensResponse } from '../features/insertion/insertionLensModel';
import { ReadTooltip } from '../components/tracks/read-track/ReadTrackTooltip';

const target = { ...fixture.target, id: 'target', end: 1000, support: 0, informative: 0, sa_support: 0 } as SvCluster;

describe('shared backend/frontend clip conflicts', () => {
  it.each(visibility.cases)('matches figure visibility at $min_len bp / $min_support carriers', c => {
    const summary = { clusters: visibility.clusters, clips: [] } as unknown as Parameters<typeof visibleSvSummary>[0];
    expect(visibleSvSummary(summary, c.min_len, c.min_support)?.clusters.map(c => c.id) ?? []).toEqual(c.ids);
  });
  it.each(regressions)('$name (CIGAR regression)', c => {
    const reads = c.reads.map(r => ({ ...r, intervals: [] })) as CompactRead[];
    const cluster = { id: 'target', support: 0, informative: 0, ...c.target } as SvCluster;
    for (const rows of [reads, [...reads].reverse()]) {
      expect(supportingReadIds(rows, cluster, 'chrT', c.expected as 'putative' | 'conflicting')).toEqual(['synthetic']);
      expect(supportingReadIds(rows, cluster, 'chrT')).toEqual(c.expected === 'putative' ? ['synthetic'] : []);
      const consolidated = { ...rows[0], sv_alignments: rows, sv_segments: rows.flatMap(r => r.sv_segments ?? []) };
      expect(svEvidenceLevel(consolidated, cluster, 'chrT')).toBe(c.expected);
      expect(rows.map(r => svEvidenceLevel({ ...r, sv_segments: consolidated.sv_segments }, cluster, 'chrT')).sort())
        .toEqual([...c.levels].sort());
      if ('overlap' in c) {
        const clip = rows[0].sv!.find(e => e.t === 'S')! as Extract<NonNullable<CompactRead['sv']>[number], { t: 'S' }>;
        expect(clipConflict(consolidated, clip, cluster.ref, cluster.end, 'chrT')?.overlap).toBe(c.overlap);
      }
    }
  });
  it.each(fixture.cases)('$name', c => {
    const read = { ...c.read, intervals: [] } as CompactRead;
    const policy = normalizeSvConflictOptions('options' in c ? c.options : undefined);
    expect(svEvidenceLevel(read, target, fixture.chrom, [], policy)).toBe(c.expected);
    expect(supportingReadIds([read, read], target, fixture.chrom, 'carriers', [], policy))
      .toEqual(c.expected === 'conflicting' ? [] : [read.id]);
    if (c.expected === 'conflicting') {
      const clip = read.sv!.find(e => e.t === 'S')!;
      if (clip.t !== 'S') throw new Error('missing clip');
      const reason = clipConflict(read, clip, 1000, 1000, fixture.chrom, policy)!;
      expect(reason.code).toBe('clip_elsewhere');
      expect(reason.message).toContain('Supporting clip aligns elsewhere');
      expect(supportingReadIds([read], target, fixture.chrom, 'conflicting', [], policy)).toEqual([read.id]);
    }
  });

  it('retains conflict reasons in lens layout and tooltips', () => {
    const read = { ...fixture.cases[0].read, intervals: [] } as CompactRead;
    const reason = clipConflict(read, read.sv![0] as never, 1000, 1000)!;
    const response = { flank: 100, cluster: { len: 100 }, carriers: [
      { id: 'synthetic', len: 100, strand: '+', read, evidence_level: 'conflicting', evidence_reason: reason },
    ], reference: [] } as unknown as LensResponse;
    const layout = layoutLens(response, 'start', false);
    expect(layout.carrierRows[0].evidenceLevel).toBe('conflicting');
    expect(describeCarrier(layout.carrierRows[0])).toContain(reason.message);
    const tooltip = renderToStaticMarkup(createElement(ReadTooltip, {
      hoveredRead: { read, x: 0, y: 0 }, width: 800, height: 400, chrom: fixture.chrom, start: 0,
      myClusterAssignments: {}, myReadStateDetails: null,
      svSummary: { clusters: [target], clips: [], min_len: 50, n_reads: 1, scope: 'all', margin: 100 },
    }));
    expect(tooltip).toContain('sv-read-conflict');
    expect(tooltip).toContain('Supporting clip aligns elsewhere');
  });
});
