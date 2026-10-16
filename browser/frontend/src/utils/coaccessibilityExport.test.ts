import { describe, expect, it } from 'vitest';
import { buildCoaccPythonCommand } from './coaccessibilityExport';

const baseOptions = {
  chrom: 'chr2R',
  start: 100,
  end: 500,
  datasetIds: ['stage_d_recalled', 'stage_e_recalled'],
  normalization: 'correlation',
  minCoverage: 20,
  binSize: 100,
  signalType: 'accessibility',
  layer: 'tf',
  sampleSeed: 'paper-seed',
};

describe('buildCoaccPythonCommand', () => {
  it('copies scoped read IDs by default for reproducibility', () => {
    const result = buildCoaccPythonCommand({
      ...baseOptions,
      readIds: ['read-b', 'read-a'],
    });

    expect(result.exact).toBe(true);
    expect(result.includedReadCount).toBe(2);
    expect(result.omittedReadCount).toBe(0);
    expect(result.command).toContain('client.get_coacc_matrix_data(');
    expect(result.command).toContain('dataset_ids=["stage_d_recalled", "stage_e_recalled"]');
    expect(result.command).toContain('read_ids=["read-b", "read-a"]');
    expect(result.command).toContain('read_ids_by_dataset=None');
    expect(result.command).toContain('sample_seed="paper-seed"');
  });

  it('copies dataset-scoped read IDs for exact multi-dataset scopes', () => {
    const result = buildCoaccPythonCommand({
      ...baseOptions,
      readIds: ['read-a', 'read-b'],
      readIdsByDataset: {
        'stage_d_recalled': ['read-a'],
        'stage_e_recalled': ['read-b'],
      },
    });

    expect(result.exact).toBe(true);
    expect(result.includedReadCount).toBe(2);
    expect(result.command).toContain('read_ids=None');
    expect(result.command).toContain('read_ids_by_dataset={"stage_d_recalled": ["read-a"], "stage_e_recalled": ["read-b"]}');
  });

  it('preserves explicit empty dataset scopes in reproducible commands', () => {
    const result = buildCoaccPythonCommand({
      ...baseOptions,
      readIdsByDataset: {
        ds1: [],
        ds2: ['read-b'],
      },
    });

    expect(result.exact).toBe(true);
    expect(result.includedReadCount).toBe(1);
    expect(result.command).toContain('read_ids=None');
    expect(result.command).toContain('read_ids_by_dataset={"ds1": [], "ds2": ["read-b"]}');
  });

  it('omits only scopes above the explicit inline safety cap', () => {
    const result = buildCoaccPythonCommand({
      ...baseOptions,
      readIdsByDataset: { ds1: ['r1', 'r2'], ds2: ['r3'] },
      inlineReadIdLimit: 2,
    });

    expect(result.exact).toBe(false);
    expect(result.includedReadCount).toBe(0);
    expect(result.omittedReadCount).toBe(3);
    expect(result.command).toContain('too large to inline');
    expect(result.command).toContain('read_ids=None');
    expect(result.command).toContain('read_ids_by_dataset=None');
  });

  it('uses None when there is no active read scope', () => {
    const result = buildCoaccPythonCommand(baseOptions);

    expect(result.exact).toBe(true);
    expect(result.includedReadCount).toBe(0);
    expect(result.command).toContain('read_ids=None');
  });
});
