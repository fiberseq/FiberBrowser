import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisRunSummary } from './AnalysisRunSummary';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('AnalysisRunSummary (M22)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialDetails = useBrowserStore.getState().showAnalysisDetails;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState({ showAnalysisDetails: initialDetails });
  });

  const render = (node: JSX.Element) => act(() => root.render(node));

  it('shows no "Run details" before a run, even with analysis details on', () => {
    useBrowserStore.setState({ showAnalysisDetails: true });
    render(<AnalysisRunSummary seed="42" inputs={['chr19', '1 dataset']} outputs={[]} />);
    expect(container.textContent ?? '').not.toContain('Run details');
  });

  it('shows "Run details" once the panel has produced something', () => {
    useBrowserStore.setState({ showAnalysisDetails: true });
    render(<AnalysisRunSummary seed="42" inputs={['chr19']} outputs={['10 clusters']} />);
    expect(container.textContent).toContain('Run details');
  });

  it('keeps the quality filters out of the always-visible chips', () => {
    useBrowserStore.setState({ showAnalysisDetails: false });
    render(<AnalysisRunSummary qualityFilterCount={1} inputs={['chr19']} outputs={['10 clusters']} />);
    expect(container.textContent ?? '').not.toMatch(/quality filter/i);
    // With details on (and after a run) it is listed there, in plain words.
    useBrowserStore.setState({ showAnalysisDetails: true });
    render(<AnalysisRunSummary qualityFilterCount={1} inputs={['chr19']} outputs={['10 clusters']} />);
    expect(container.textContent).toContain('1 quality filter applied');
    // Filters drop calls, not reads: the tooltip must not say reads are removed.
    const chip = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('quality filter'));
    expect(chip?.title).toMatch(/reads themselves stay/);
  });

  it('still shows chips that change what the panel shows', () => {
    useBrowserStore.setState({ showAnalysisDetails: false });
    render(<AnalysisRunSummary filterActive filterLabel="Cluster focus" outputs={[]} />);
    expect(container.textContent).toContain('Cluster focus');
  });
});
