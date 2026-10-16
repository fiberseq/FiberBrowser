import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { beginProgressiveAnalysis, cancelProgressiveAnalysis, displayedScope, useAnalysisProgress, needsDisplayPreview } from './progressiveAnalysis';
const baseline = useBrowserStore.getState();
beforeEach(() => useBrowserStore.setState({ ...baseline, chrom: 'chr1', start: 100, end: 200,
  panels: [{ id: 'p', datasetId: 'ds', stateKey: 'ds', contentType: 'dataset' } as any],
  activeClusterTreeNodeId: null, clusterAssignments: {}, readSortOrder: {}, clusterOrder: {},
  clusterFocus: {}, filteredReadIds: {}, selectedClusters: {}, jupyterReadOrder: {} }));
afterEach(() => { cancelProgressiveAnalysis(); useBrowserStore.setState(baseline); });

describe('progressive analysis ownership', () => {
  it('intersects displayed IDs with the full scope, including empty scopes', () => {
    expect(displayedScope(['a', 'a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(displayedScope(['a'], [])).toEqual([]);
    expect(displayedScope(undefined)).toEqual([]);
  });
  it('leaves unready panels intact and avoids duplicate fits of an explicit complete scope', () => {
    expect(needsDisplayPreview([{ shown: ['a'] }, { shown: [] }])).toBe(false);
    expect(needsDisplayPreview([{ shown: ['a'], full: ['a', 'a'] }])).toBe(false);
    expect(needsDisplayPreview([{ shown: ['a'], full: ['a', 'b'] }])).toBe(true);
    expect(needsDisplayPreview([{ shown: ['a'] }])).toBe(true);
  });
  it('keeps a preview through display refetches and permits its own full replacement', () => {
    const run = beginProgressiveAnalysis('cluster', ['ds']);
    expect(run.commit(() => useBrowserStore.setState({ clusterAssignments: { ds: { a: 0 } }, activeClusterTreeNodeId: 'child' }))).toBe(true);
    run.refine();
    useBrowserStore.setState({ activeReadIds: { ds: ['a', 'b'] } });
    expect(run.current()).toBe(true);
    expect(run.commit(() => useBrowserStore.setState({ clusterAssignments: { ds: { a: 1, b: 0 } } }))).toBe(true);
    run.complete(); run.dispose();
    expect(useAnalysisProgress.getState().progress).toBeNull();
  });
  it.each(['pan', 'branch', 'filter', 'order', 'restore', 'child', 'selection'])(
    'aborts after %s and cannot publish a stale full result', change => {
      const run = beginProgressiveAnalysis('cluster', ['ds']); run.refine();
      const changes = {
        pan: { start: 101 }, branch: { activeClusterTreeNodeId: 'other' },
        filter: { filteredReadIds: { ds: new Set(['a']) } }, order: { readSortOrder: { ds: ['a'] } },
        restore: { _lastRestoreTime: Date.now() + 1 }, child: { clusterTreeNodes: {} },
        selection: { selectedClusters: { ds: new Set([1]) } },
      };
      useBrowserStore.setState(changes[change as keyof typeof changes]);
      expect(run.signal.aborted).toBe(true);
      expect(run.commit(() => { throw Error('stale commit'); })).toBe(false);
      run.dispose();
    });
  it('ignores identical notebook-order polling but cancels a new notebook order', () => {
    useBrowserStore.setState({ jupyterReadOrder: { ds: [] } });
    const run = beginProgressiveAnalysis('sort', ['ds']); run.refine();
    useBrowserStore.getState().setJupyterReadOrder({});
    expect(run.current()).toBe(true);
    useBrowserStore.getState().setJupyterReadOrder({ ds: ['b', 'a'] });
    expect(run.signal.aborted).toBe(true);
  });
  it('a newer sort cancels clustering and old cleanup cannot clear the new owner', () => {
    const old = beginProgressiveAnalysis('cluster', ['ds']); old.refine();
    const next = beginProgressiveAnalysis('sort', ['ds']);
    expect(old.signal.aborted).toBe(true);
    old.dispose(); old.complete();
    expect(next.current()).toBe(true);
    next.dispose();
  });
});

describe('why a run stopped (3.0.0 audit MED-1)', () => {
  it('says the locus changed when a panel it ran for moved', () => {
    const run = beginProgressiveAnalysis('cluster', ['ds']);
    useBrowserStore.setState({ start: 150 });
    expect(run.signal.aborted).toBe(true);
    expect(useAnalysisProgress.getState().progress?.text).toMatch(/^Stopped: the locus changed before it finished, so nothing was applied\. Cluster again here\.$/);
    run.dispose();
  });
  it('says so for a sort refinement too, and names the other changes', () => {
    const sort = beginProgressiveAnalysis('sort', ['ds']); sort.refine();
    useBrowserStore.setState({ panels: [{ id: 'p', datasetId: 'ds', stateKey: 'ds', contentType: 'dataset',
      viewportOverride: { chrom: 'chr1', start: 500, end: 900 } } as any] });
    expect(useAnalysisProgress.getState().progress?.text).toMatch(/locus changed, so the result shown is the preview\. Sort again here\./);
    sort.dispose();
    const other = beginProgressiveAnalysis('cluster', ['ds']);
    useBrowserStore.setState({ clusterK: 7 } as any);
    expect(other.signal.aborted).toBe(true);
    expect(useAnalysisProgress.getState().progress?.text).toBe('Stopped: the clusters, filters, read order or settings changed before it finished, so nothing was applied. Cluster again.');
    other.dispose();
  });
  it('a sort over two panels stops when one of them moves, and says the locus changed', () => {
    useBrowserStore.setState({ navigationMode: 'perPanel', panels: [
      { id: 'p', datasetId: 'ds', stateKey: 'ds', contentType: 'dataset', viewportOverride: { chrom: 'chr1', start: 100, end: 200 } } as any,
      { id: 'q', datasetId: 'ds', stateKey: 'ds:copy', contentType: 'dataset', viewportOverride: { chrom: 'chr1', start: 100, end: 200 } } as any] });
    const run = beginProgressiveAnalysis('sort', ['ds', 'ds:copy']);
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === 'q' ? { ...p, viewportOverride: { chrom: 'chr1', start: 5000, end: 5100 } } : p) }));
    expect(run.signal.aborted).toBe(true);
    expect(useAnalysisProgress.getState().progress?.text).toContain('the locus changed');
    run.dispose();
  });
  it('a filter change stops a sort and says why', () => {
    const run = beginProgressiveAnalysis('sort', ['ds']);
    useBrowserStore.setState({ filteredReadIds: { ds: new Set(['a']) } });
    expect(run.signal.aborted).toBe(true);
    expect(useAnalysisProgress.getState().progress?.text).toBe(
      'Stopped: the clusters, filters, read order or settings changed before it finished, so nothing was applied. Sort again.');
    run.dispose();
  });
});
