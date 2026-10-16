import type { QcPayload } from '../../../api/pipeline';
import {
  STATE_TIPS, bandText, percent, phasogram, qcMetrics, rateCdf, ratioText, sizeDistribution, stateCdf, stateRates,
  verdictBasisText, verdictItems, verdictTone, type StateRate, type StateRates,
} from '../../../utils/qcView';
import { QcChart } from './QcChart';

const SAMPLE = '#2563eb';
const REFERENCE = '#9ca3af';
const PASS_BAND = 'rgba(16, 185, 129, 0.16)';
const WARN_BAND = 'rgba(245, 158, 11, 0.12)';
const IN_MSP = '#2563eb';
const IN_MSP_REF = '#93c5fd';
const OUTSIDE_MSP = '#d97706';
const OUTSIDE_MSP_REF = '#fcd34d';

const TONE_CLASS: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-600/50',
  warn: 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/40 dark:text-amber-100 dark:border-amber-600/50',
  error: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-200 dark:border-red-600/50',
  muted: 'bg-gray-100 text-gray-600 border-gray-300 dark:bg-white/5 dark:text-gray-300 dark:border-white/10',
};

function plotLabel(name: string, url: string): string {
  const kind = /pdf/i.test(name) ? 'PDF' : /png|plot/i.test(name) ? 'PNG' : /html|report/i.test(name) ? '' : '';
  if (kind) return `QC figure (${kind})`;
  if (/report/i.test(name)) return /\.pdf$/i.test(url) ? 'QC figure (PDF)' : 'QC report';
  return name.replace(/_/g, ' ');
}

export function VerdictChip({ label, status, score, title, muted = false }: {
  label: string; status: string | null; score?: number | null; title?: string; muted?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[verdictTone(status)]} ${muted ? 'opacity-60 border-dashed' : ''}`}
      data-testid={`qc-verdict-${label.toLowerCase()}`}
      data-in-verdict={muted ? 'false' : 'true'}
      title={title}
    >
      {label}: {status ?? '—'}
      {score !== null && score !== undefined && Number.isFinite(score) && <span className="opacity-70">{Math.round(score)}/100</span>}
      {muted && <span className="opacity-70">(not in verdict)</span>}
    </span>
  );
}

/**
 * A rate on a short bar with its FAIL / WARN / PASS zones (efficiency is graded from
 * below, background from above) and the reference median as a gray tick.
 */
export function RateGauge({ rate, testId }: { rate: StateRate; testId?: string }) {
  const { value, pass, warn, referenceMedian: ref } = rate;
  if (value === null || pass === null || warn === null) return null;
  const points = [value, pass, warn, ...(ref === null ? [] : [ref])];
  const lo0 = Math.min(...points);
  const hi0 = Math.max(...points);
  const pad = Math.max((hi0 - lo0) * 0.35, 0.01);
  const lo = Math.max(0, lo0 - pad);
  const hi = Math.min(1, hi0 + pad);
  const W = 140;
  const H = 12;
  const x = (v: number) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * W;
  const zones = rate.direction === 'high'
    ? [{ from: lo, to: warn, fill: 'rgba(239, 68, 68, 0.25)' }, { from: warn, to: pass, fill: 'rgba(245, 158, 11, 0.3)' }, { from: pass, to: hi, fill: 'rgba(16, 185, 129, 0.3)' }]
    : [{ from: lo, to: pass, fill: 'rgba(16, 185, 129, 0.3)' }, { from: pass, to: warn, fill: 'rgba(245, 158, 11, 0.3)' }, { from: warn, to: hi, fill: 'rgba(239, 68, 68, 0.25)' }];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 text-gray-800 dark:text-gray-100" data-testid={testId}
      role="img" aria-label={`${percent(value)} against PASS/WARN bounds`}>
      {zones.map(z => <rect key={z.fill} x={x(z.from)} y={3} width={Math.max(0, x(z.to) - x(z.from))} height={H - 6} fill={z.fill} />)}
      {ref !== null && <line x1={x(ref)} x2={x(ref)} y1={1} y2={H - 1} stroke="#9ca3af" strokeWidth={1.5}><title>Reference median {percent(ref)}</title></line>}
      <circle cx={x(value)} cy={H / 2} r={3.5} fill="currentColor"><title>This sample {percent(value)}</title></circle>
    </svg>
  );
}

function StateRow({ testId, label, title, value, detail, rate, status }: {
  testId: string; label: string; title: string; value: string; detail?: string | null; rate?: StateRate; status?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0" data-testid={testId} title={title}>
      <span className="w-[10.5rem] shrink-0 text-[11.5px] text-gray-600 dark:text-gray-300">{label}</span>
      <span className="w-[3.75rem] shrink-0 text-[13px] font-semibold tabular-nums text-gray-800 dark:text-gray-100">{value}</span>
      {rate && <RateGauge rate={rate} testId={`${testId}-gauge`} />}
      {status && <span className={`rounded px-1.5 py-px text-[10.5px] font-semibold border ${TONE_CLASS[verdictTone(status)]}`} data-testid={`${testId}-status`}>{status}</span>}
      {detail && <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">{detail}</span>}
    </div>
  );
}

/** In-MSP rate (efficiency), outside-MSP rate (background), MSP share, their ratio and where the states came from. */
export function StateRatesPanel({ rates, signalLabel }: { rates: StateRates; signalLabel: string }) {
  const { efficiency: eff, background: bg } = rates;
  const ref = (v: number | null, f: (x: number | null) => string = x => percent(x)) => (v === null ? null : `reference ${f(v)}`);
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  const msp = rates.minMspBp ? ` (MSPs ≥ ${rates.minMspBp} bp)` : '';
  return (
    <div className="space-y-1 rounded border border-gray-200 dark:border-white/10 px-2 py-1.5" data-testid="qc-state-rates">
      <div className="text-[11px] font-medium text-gray-600 dark:text-gray-300">Rates by chromatin state{msp}</div>
      {rates.available ? (
        <>
          <StateRow testId="qc-state-efficiency" label="Efficiency (in-MSP rate)" title={STATE_TIPS.efficiency}
            value={percent(eff.value)} rate={eff} status={eff.status}
            detail={join(ref(eff.referenceMedian), bandText(eff))} />
          <StateRow testId="qc-state-background" label="Background (outside MSPs)" title={STATE_TIPS.background}
            value={percent(bg.value)} rate={bg} status={bg.status}
            detail={join(ref(bg.referenceMedian), bandText(bg))} />
          <StateRow testId="qc-state-msp-share" label="MSP share of reads" title={STATE_TIPS.mspShare}
            value={percent(rates.mspShare, 0)}
            detail={join(rates.mspShareMedian === null ? null : `median read ${percent(rates.mspShareMedian, 0)}`,
              ref(rates.referenceMspShareMedian, x => `${percent(x, 0)} (median read)`))} />
          <StateRow testId="qc-state-ratio" label="In-MSP ÷ outside" title={STATE_TIPS.ratio}
            value={ratioText(rates.ratio)} detail={ref(rates.referenceRatio, ratioText)} />
          <StateRow testId="qc-state-overall-rate" label="All states together" title={STATE_TIPS.overallRate}
            value={percent(rates.overallRate)}
            detail={join(ref(rates.referenceOverallRate), `overall ${signalLabel} on the same sites; depends on how open the sample is`)} />
        </>
      ) : null}
      <div className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="qc-state-source" title={STATE_TIPS.source}>{rates.sourceText}</div>
      {rates.notes.map(note => (
        <div key={note} className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="qc-state-note">{note}</div>
      ))}
    </div>
  );
}

/** fiberhmm-qc, presented: verdicts, headline numbers and the curves against the bundled reference. */
export function QcReport({ payload }: { payload: QcPayload }) {
  if (!payload.available || !payload.qc) {
    return <div className="text-[12px] text-gray-500 dark:text-gray-400">No QC report for this run (fiberhmm-qc did not run).</div>;
  }
  const qc = payload.qc;
  const curves = payload.curves;
  const cdf = rateCdf(curves);
  const phase = phasogram(curves);
  const nuc = sizeDistribution(curves?.footprint_sizes?.nucleosome, 1000);
  const tf = sizeDistribution(curves?.footprint_sizes?.tf, 150);
  const reference = qc.assay?.reference_label as string | undefined;
  const label = (qc.signal?.label as string | undefined) || 'signal';
  const png = payload.plots.plot ?? payload.plots.overview_png;
  const states = stateRates(qc);
  const stateCurves = stateCdf(curves);
  const basis = verdictBasisText(qc);
  const stateAware = qc.overall?.verdict_basis === 'state-aware';

  return (
    <div className="space-y-3" data-testid="qc-report">
      <div className="flex flex-wrap items-center gap-1.5">
        {verdictItems(qc).map(v => <VerdictChip key={v.key} label={v.label} status={v.status} score={v.score} title={v.title} muted={!v.inVerdict} />)}
      </div>
      {basis && <div className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="qc-verdict-basis">{basis}</div>}
      {states && <StateRatesPanel rates={states} signalLabel={label} />}
      {reference && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          Compared with the bundled reference: {reference}.{' '}
          {stateAware
            ? `Efficiency passes at or above the reference's 25th percentile (WARN down to the 5th); background at or below its 75th (WARN up to the 95th); the overall ${label} rate is PASS in the reference's middle half, WARN in its 5–95% range.`
            : "PASS is the reference's middle half; WARN its 5–95% range."}
        </div>
      )}
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
        {qcMetrics(qc).map(m => (
          <div key={m.label} title={m.title} className="min-w-0">
            <dt className="text-[11px] text-ink-secondary truncate">{m.label}</dt>
            <dd className="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate">{m.value}</dd>
          </div>
        ))}
      </dl>
      {curves ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {stateCurves && (
            <QcChart
              testId="qc-state-cdf"
              title="Per-read rate inside vs outside MSPs (CDF)"
              xLabel="Per-read rate (%)"
              yLabel="Fraction of reads"
              yDomain={[0, 1]}
              xDomain={[0, stateCurves.xMax]}
              series={[
                ...(stateCurves.referenceOutside.length ? [{ points: stateCurves.referenceOutside, color: OUTSIDE_MSP_REF, label: 'Reference outside (5–95%)', dashed: true }] : []),
                ...(stateCurves.referenceMsp.length ? [{ points: stateCurves.referenceMsp, color: IN_MSP_REF, label: 'Reference in-MSP (5–95%)', dashed: true }] : []),
                ...(stateCurves.outside.length ? [{ points: stateCurves.outside, color: OUTSIDE_MSP, label: 'Outside MSPs (background)', width: 2 }] : []),
                ...(stateCurves.msp.length ? [{ points: stateCurves.msp, color: IN_MSP, label: 'In MSPs (efficiency)', width: 2 }] : []),
              ]}
            />
          )}
          {cdf && (
            <QcChart
              testId="qc-rate-cdf"
              title={states ? `Per-read ${label}, all states (CDF)` : `Per-read ${label} (CDF)`}
              xLabel={`Per-read ${label} (%)`}
              yLabel="Fraction of reads"
              yDomain={[0, 1]}
              series={[
                ...(cdf.reference.length ? [{ points: cdf.reference, color: REFERENCE, label: 'Reference', dashed: true }] : []),
                { points: cdf.sample, color: SAMPLE, label: 'This sample', width: 2 },
              ]}
              bands={[
                ...(cdf.warnBand ? [{ from: cdf.warnBand[0], to: cdf.warnBand[1], color: WARN_BAND, label: 'WARN range' }] : []),
                ...(cdf.passBand ? [{ from: cdf.passBand[0], to: cdf.passBand[1], color: PASS_BAND, label: 'PASS range' }] : []),
              ]}
            />
          )}
          {phase && (
            <QcChart
              testId="qc-phasogram"
              title="Nucleosome periodicity (phasogram)"
              xLabel="Distance between marks (bp)"
              yLabel="Pairs / local baseline"
              xDomain={[60, 800]}
              series={[
                ...(phase.reference.length ? [{ points: phase.reference, color: REFERENCE, label: 'Reference', dashed: true }] : []),
                { points: phase.sample, color: SAMPLE, label: 'This sample', width: 1.8 },
              ]}
              markers={phase.nrl ? [{ x: phase.nrl, color: '#dc2626', label: `NRL ${phase.nrl} bp` }] : []}
            />
          )}
          {nuc && nuc.sample.length > 0 && (
            <QcChart
              testId="qc-nucleosome-sizes"
              title={`Nucleosome footprint sizes (n = ${nuc.n.toLocaleString('en-US')})`}
              xLabel="Footprint length (bp)"
              yLabel="Fraction"
              xDomain={[0, 1000]}
              series={[
                ...(nuc.reference.length ? [{ points: nuc.reference, color: REFERENCE, label: 'Reference', dashed: true }] : []),
                { points: nuc.sample, color: SAMPLE, label: 'This sample' },
              ]}
            />
          )}
          {tf && tf.sample.length > 0 && tf.n > 0 && (
            <QcChart
              testId="qc-tf-sizes"
              title={`TF footprint sizes (n = ${tf.n.toLocaleString('en-US')})`}
              xLabel="Footprint length (bp)"
              yLabel="Fraction"
              xDomain={[0, 150]}
              series={[
                ...(tf.reference.length ? [{ points: tf.reference, color: REFERENCE, label: 'Reference', dashed: true }] : []),
                { points: tf.sample, color: SAMPLE, label: 'This sample' },
              ]}
            />
          )}
        </div>
      ) : png ? (
        <img src={png} alt="fiberhmm-qc figure" className="w-full rounded border border-gray-200 dark:border-white/10" />
      ) : (
        <div className="text-[11px] text-gray-500">This FiberHMM's QC wrote no curves file; update FiberHMM for the charts.</div>
      )}
      {Object.keys(payload.plots).length > 0 && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {Object.entries(payload.plots).map(([name, url]) => (
            <a key={name} href={url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline" data-testid={`qc-file-${name}`}>
              {plotLabel(name, url)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
