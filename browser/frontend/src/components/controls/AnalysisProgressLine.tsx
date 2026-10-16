import { cancelProgressiveAnalysis, useAnalysisProgress } from '../../utils/progressiveAnalysis';
export function AnalysisProgressLine() {
  const progress = useAnalysisProgress(s => s.progress);
  if (!progress) return null;
  return <div role="status" data-testid="analysis-progress" className="flex items-center gap-2 px-3 text-xs text-gray-500">
    <span>{progress.kind === 'cluster' ? 'Cluster' : 'Sort'}: {progress.text}</span>
    {progress.refining && <button type="button" onClick={cancelProgressiveAnalysis} className="underline">Stop refinement</button>}
    {!progress.refining && <button type="button" onClick={() => useAnalysisProgress.setState({ progress: null })} className="underline">Dismiss</button>}
  </div>;
}
