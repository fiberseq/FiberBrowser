import { describe, expect, it } from 'vitest';
import { getDatasetDisplayLabel, getDatasetHoverLabel, withSample } from './datasetLabels';

describe('datasetLabels', () => {
  it('compacts plus-joined merged labels while preserving the first label', () => {
    expect(getDatasetDisplayLabel({
      id: 'merged',
      label: 'stage_a_recalled + stage_b_recalled + stage_c_recalled + stage_d_recalled',
      path: '/tmp/stage_a_recalled.bam',
      paths: ['/tmp/stage_a_recalled.bam', '/tmp/stage_b_recalled.bam', '/tmp/stage_c_recalled.bam', '/tmp/stage_d_recalled.bam'],
    })).toBe('stage_a_recalled + 3 more');
  });

  it('compacts long multi-path labels from path basenames when the label was not plus-joined', () => {
    expect(getDatasetDisplayLabel({
      id: 'merged',
      label: 'A very long manually generated merged dataset label that will not fit',
      path: '/data/2-4/a.recalled.bam',
      paths: ['/data/2-4/a.recalled.bam', '/data/2-4/b.recalled.bam', '/data/2-4/c.recalled.bam'],
    })).toBe('a + 2 more');
  });

  it('keeps full merged detail available for hover', () => {
    const hover = getDatasetHoverLabel({
      id: 'merged',
      label: 'A + B + C',
      path: '/tmp/A.bam',
      paths: ['/tmp/A.bam', '/tmp/B.bam', '/tmp/C.bam'],
    });

    expect(hover).toContain('A + B + C');
    expect(hover).toContain('3 sources:');
    expect(hover).toContain('B');
  });

  it('keeps the source visible after a single dataset is renamed', () => {
    const hover = getDatasetHoverLabel({
      id: 'dataset-a',
      label: 'Favorite DAF replicate',
      path: '/data/timecourse/stage_d_recalled.bam',
    });

    expect(hover).toContain('Favorite DAF replicate');
    expect(hover).toContain('Source:');
    expect(hover).toContain('stage_d_recalled');
  });

  // Usability round 2, N9: the file stem is the name however the BAM was opened; the sample name goes second.
  it('names a BAM by its file stem, with its sample name second and no repeated source line', () => {
    const ds = withSample({ id: 'pooled_rep_R1R2R3', label: 'pooled_rep.R1R2R3', path: '/d/pooled_rep.R1R2R3.bam' }, 'sample_1_rep');
    expect(getDatasetDisplayLabel(ds)).toBe('pooled_rep.R1R2R3');
    expect(getDatasetHoverLabel(ds)).toBe('pooled_rep.R1R2R3\nSample: sample_1_rep');
    // A sample name that is the name says nothing more: not kept.
    expect(withSample({ id: 'a', label: 'numb' }, 'numb')).not.toHaveProperty('sample');
    expect(getDatasetHoverLabel({ id: 'a', label: 'numb', path: '/d/numb.bam' })).toBe('numb');
  });
});
