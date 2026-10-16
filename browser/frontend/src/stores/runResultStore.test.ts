import { afterEach, expect, it } from 'vitest';
import { useBrowserStore } from './browserStore';
import { useRunResultStore } from './runResultStore';

const initial = useBrowserStore.getState();
afterEach(() => {
  useBrowserStore.setState(initial, true);
  useRunResultStore.setState({ results: {}, runs: {} });
});

it.each(['chrom', 'start', 'end'] as const)('clears refusals when %s changes, preserving successful results and notes', key => {
  const store = useRunResultStore.getState();
  store.setRunResult('cluster', { tone: 'error', text: 'No panel to cluster' });
  store.setRunResult('sort', { tone: 'done', text: 'Sorted', panelIds: ['p1'] });
  store.setRunResult('filter', { tone: 'note', text: 'One panel left out' });
  useBrowserStore.setState({ [key]: key === 'chrom' ? 'another-chrom' : initial[key] + 1 });
  const { results } = useRunResultStore.getState();
  expect(results.cluster).toBeUndefined();
  expect(results.sort?.tone).toBe('done');
  expect(results.filter?.tone).toBe('note');
});

it('keeps a refusal on unrelated browser updates', () => {
  useRunResultStore.getState().setRunResult('cluster', { tone: 'error', text: 'No panel to cluster' });
  useBrowserStore.setState({ panels: [] });
  expect(useRunResultStore.getState().results.cluster?.tone).toBe('error');
});
