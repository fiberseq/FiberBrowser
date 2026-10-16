import { SIGNAL_LABELS, type SignalEvidence } from '../../../utils/signalFilters';

/** Display recorded model evidence without inferring a score from the view. */
export function SignalDetails({ signal }: { signal?: SignalEvidence }) {
  if (!signal) return <div data-testid="signal-details">Signal annotation unavailable</div>;
  const value = (n: number | null | undefined) => n == null ? 'Not assessed' : String(n);
  return <div className="space-y-0.5 text-[11px] break-words" data-testid="signal-details">
    <div>{SIGNAL_LABELS[signal.status]}</div>
    {signal.reason && <div>Reason: {signal.reason.replace(/_/g, ' ')}</div>}
    <div>Eligible opportunities: {value(signal.opportunities)}</div>
    <div>Model evidence (p_signal): {value(signal.p_signal)}</div>
    <div>Background tail (p): {value(signal.background_p)}</div>
    <div>Assay: {[signal.assay, signal.enzyme, signal.platform].filter(Boolean).join(' · ') || 'Unavailable'}</div>
    {signal.quality_policy && <div>Quality policy: {signal.quality_policy}</div>}
    {signal.opportunity_definition && <div>Opportunities: {signal.opportunity_definition}</div>}
    {signal.model_id && <div>Model: {signal.model_id}</div>}
    {signal.method && <div>Method: {signal.method}</div>}
    {signal.calibration_status && <div>Calibration: {signal.calibration_status}</div>}
    <div>Structure: {signal.structure.status.replace(/_/g, ' ')}</div>
    <div>Structure score: {value(signal.structure.score)} · p: {value(signal.structure.p_value)}</div>
    {signal.structure.reason && <div>Structure reason: {signal.structure.reason.replace(/_/g, ' ')}</div>}
    {signal.structure.method && <div>Structure method: {signal.structure.method}</div>}
  </div>;
}
