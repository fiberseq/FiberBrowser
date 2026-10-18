import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fixture from '../../../../tests/data/sv_conflicts.json';
import { clipConflict, normalizeSvConflictOptions } from './svConflicts';
import { supportingReadIds, svEvidenceLevel } from '../components/tracks/read-track/svDrawing';
import type { CompactRead, SvCluster } from '../components/tracks/read-track/types';
import { describeCarrier, layoutLens, type LensResponse } from '../features/insertion/insertionLensModel';
import { ReadTooltip } from '../components/tracks/read-track/ReadTrackTooltip';

const target = { ...fixture.target, id: 'target', end: 1000, support: 0, informative: 0, sa_support: 0 } as SvCluster;

describe('shared backend/frontend clip conflicts', () => {
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
