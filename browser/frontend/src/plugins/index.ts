export {
  registerAnalysisPanel,
  getAnalysisPanel,
  getAllAnalysisPanels,
  isAnalysisPanel,
  normalizeAnalysisPanelContentTypes,
  getAnalysisPanelLabel,
  findOpenAnalysisPanel,
  getGroupedAnalysisPanels,
  GROUP_LABELS,
  registerPanelAlias,
} from './registry';
export type { GroupedPlugins } from './registry';
export { useAnalysisContext } from './useAnalysisContext';
export type { AnalysisPanelPlugin, AnalysisPanelProps, AnalysisPanelGroup } from './types';
export type { AnalysisContext } from './useAnalysisContext';

// Side-effect: registers built-in panels
import './builtinPanels';
