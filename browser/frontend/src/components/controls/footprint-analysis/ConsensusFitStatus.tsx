import type { ConsensusFitSummary } from '../../../api/consensusWorkflow';

export function ConsensusFitStatus({fit}:{fit?:ConsensusFitSummary}) {
  if(!fit||fit.selected_converged===null)return <span className="text-gray-500"> · optimizer status unreported</span>;
  if(fit.selected_converged)return <span title={fit.optimizer_message}> · CR fit converged ({fit.iterations??'?'} iterations)</span>;
  return <span role="alert" className="block text-amber-700 dark:text-amber-300">
    CR is numerically provisional: the selected whole-region fit did not converge.
    {fit.optimizer_message&&` ${fit.optimizer_message}.`}
    {' Review the optimizer or increase the whole-region fit budget before interpreting quantities; calls are retained for inspection.'}
  </span>;
}
