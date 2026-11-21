/** Plugin charts in Plots: histogram, profile, heatmap and V-plot JSON (unchanged, no new fields) map to supplied
 *  cards with their values exactly; donut, table, image and scatter stay in the plugin panel. */
import { describe, expect, it } from 'vitest';
import { pluginChartToSupplied } from './PythonPluginPanel';

const ctx = { plugin: 'demo', chrom: 'chrT', start: 1000, end: 2000 };

describe('plugin chart_type → Plots', () => {
  it('histogram: one series per bar label over the groups, the group labels as ticks', () => {
    const s = pluginChartToSupplied({ chart_type: 'histogram', y_label: 'reads', groups: [
      { label: 'a', bars: [{ label: 'X', value: 1, color: '#f00' }, { label: 'Y', value: 2, color: '#0f0' }] },
      { label: 'b', bars: [{ label: 'X', value: 3, color: '#f00' }] }, { label: 'c', bars: [{ label: 'Y', value: 4.5, color: '#0f0' }] }] }, ctx)!;
    expect(s.series).toEqual([{ id: 'X', title: 'X', color: '#f00', values: [1, 3, null] }, { id: 'Y', title: 'Y', color: '#0f0', values: [2, null, 4.5] }]);
    expect(s.spec.xTicks).toEqual(['a', 'b', 'c']);
  });
  it('profile: series across the view', () => {
    const s = pluginChartToSupplied({ chart_type: 'profile', series: [{ data: [0.1, 0.2, 0.3, 0.4], color: '#00f', label: 'sig' }] }, ctx)!;
    expect(s.spec).toMatchObject({ x0: 1000, dx: 250 });
    expect(s.series[0].values).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
  it('heatmap and V-plot: matrices with their row labels, the V-plot colour slot', () => {
    const h = pluginChartToSupplied({ chart_type: 'heatmap', matrix: [[0, 0.5], [1, 0.25]], row_labels: ['r1', 'r2'], col_labels: ['c1', 'c2'] }, ctx)!;
    expect(h.matrices).toEqual([{ id: 'plugin', title: 'demo heatmap', rows: [{ label: 'r1', values: [0, 0.5] }, { label: 'r2', values: [1, 0.25] }] }]);
    const v = pluginChartToSupplied({ chart_type: 'vplot', matrix: [[0.2], [0.4]], size_min: 20, size_bin: 5, pos_bin: 7 }, ctx)!;
    expect(v.matrices![0].rows.map(r => r.label)).toEqual(['20', '25']);
    expect(v.spec.matrix).toMatchObject({ kind: 'vplot', dx: 7 });
  });
  it('the rest stay in the panel', () => {
    for (const chart_type of ['donut', 'table', 'image', 'scatter', 'multi', 'unknown']) expect(pluginChartToSupplied({ chart_type }, ctx)).toBeNull();
  });
});
