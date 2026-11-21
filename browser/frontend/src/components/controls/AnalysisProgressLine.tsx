import { cancelProgressiveAnalysis, useAnalysisProgress } from '../../utils/progressiveAnalysis';

/** The clustering / sorting progress (the toolbar's line, also under Plots' Cluster reads), with Stop refinement. */
export function AnalysisProgressStatus({ className = 'flex items-center gap-2 px-3 text-xs text-gray-500', testId = 'analysis-progress', dismiss = true }: { className?: string; testId?: string; dismiss?: boolean }) {
  const progress = useAnalysisProgress(s => s.progress);
  if (!progress) return null;
  return <div role="status" data-testid={testId} className={className}>
    <span>{progress.kind === 'cluster' ? 'Cluster' : 'Sort'}: {progress.text}</span>
    {progress.refining && <button type="button" onClick={cancelProgressiveAnalysis} className="underline">Stop refinement</button>}
    {!progress.refining && dismiss && <button type="button" onClick={() => useAnalysisProgress.setState({ progress: null })} className="underline">Dismiss</button>}
  </div>;
}

export function AnalysisProgressLine() {
  return <AnalysisProgressStatus />;
}
