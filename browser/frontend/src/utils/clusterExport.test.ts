import { describe, expect, it } from 'vitest';
import {
  buildClusterAssignmentRows,
  formatClusterAssignmentsTsv,
  orderAssignmentReadIds,
} from './clusterExport';

describe('cluster assignment export', () => {
  it('orders reads by viewer cluster order and read sort order', () => {
    const rows = buildClusterAssignmentRows({
      clusterAssignments: {
        panel_a: {
          alpha: 2,
          top: 1,
          second: 1,
          tail: 2,
        },
      },
      datasets: [{ id: 'ds_a', label: 'Sample A' }],
      panels: [{ id: 'panel-a', contentType: 'dataset', datasetId: 'ds_a', stateKey: 'panel_a' }],
      clusterOrder: { panel_a: [1, 2] },
      readSortOrder: { panel_a: ['second', 'top', 'tail', 'alpha'] },
      clusterPatterns: { 1: [1, 0], 2: [0, 1] },
    });

    expect(rows.map(r => r.read_id)).toEqual(['second', 'top', 'tail', 'alpha']);
    expect(rows.map(r => r.viewer_order)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ dataset: 'Sample A', cluster: 1, pattern: '10' });
  });

  it('lets notebook order override cluster/read sorting when present', () => {
    const ordered = orderAssignmentReadIds(
      'ds_a',
      { a: 1, b: 1, c: 2 },
      {
        jupyterReadOrder: { ds_a: ['c', 'a'] },
        readSortOrder: { ds_a: ['b', 'a', 'c'] },
        clusterOrder: { ds_a: [1, 2] },
      },
    );

    expect(ordered).toEqual(['c', 'a', 'b']);
  });

  it('formats TSV with viewer_order appended for reproducible reloads', () => {
    const tsv = formatClusterAssignmentsTsv({
      clusterAssignments: { ds_a: { r2: 1, r1: 1 } },
      readSortOrder: { ds_a: ['r1', 'r2'] },
    });

    expect(tsv.split('\n').slice(0, 3)).toEqual([
      'read_id\tdataset\tcluster\tviewer_order',
      'r1\tds_a\t1\t1',
      'r2\tds_a\t1\t2',
    ]);
  });

  it('optionally prefixes reproducibility provenance comments', () => {
    const tsv = formatClusterAssignmentsTsv({
      clusterAssignments: { ds_a: { r1: 1 } },
      provenance: {
        analysis_sample_seed: 'paper-v1',
        spanning_only: true,
        quality_filters: [{ layer: 'fire', qualityName: 'aq', minValue: 230 }],
      },
    });

    expect(tsv.split('\n').slice(0, 5)).toEqual([
      '# fiberbrowser_export: cluster_assignments',
      '# analysis_sample_seed: paper-v1',
      '# quality_filters: [{"layer":"fire","qualityName":"aq","minValue":230}]',
      '# spanning_only: true',
      'read_id\tdataset\tcluster\tviewer_order',
    ]);
  });
});
