import type { PrimerState } from '../../../types';
import { AnalysisButton, AnalysisStatus } from '../shared';

/**
 * Why the design button can't run yet, in plain words (shown next to the
 * button and as its tooltip), or null when it can. M13: a disabled button
 * always says what to do first.
 */
export function designDisabledReason({ mode, designing, peakCount, hasFastaReady, hasBlastDb, hasSplitView, targetTooLarge }: {
  mode: PrimerState['mode'];
  designing: boolean;
  peakCount: number;
  hasFastaReady: boolean;
  hasBlastDb: boolean;
  hasSplitView: boolean;
  targetTooLarge: boolean;
}): string | null {
  if (designing) return null;
  if (mode === 'dafc') {
    if (!hasSplitView) return 'Open a split view of two loci first.';
  } else if (peakCount === 0) {
    return 'Select one or more peaks on the peak track first.';
  }
  if (!hasFastaReady && !hasBlastDb) return 'Load a reference FASTA, then build or choose a BLAST database (above).';
  if (!hasFastaReady) return 'Load a reference FASTA first.';
  if (!hasBlastDb) return 'Build or choose a BLAST database first (above).';
  if (mode === 'standard' && targetTooLarge) return 'The target is larger than the longest product allowed (see the warning above).';
  return null;
}

const DETAIL_LABELS: Record<string, string> = {
  pass_number: 'Pass',
  forward_primers: 'Forward',
  reverse_primers: 'Reverse',
  window_bp: 'Window',
  primer_length: 'Length',
  completed_lengths: 'Lengths',
  total_lengths: 'Total lengths',
  valid_pairs: 'Valid pairs',
  candidate_pairs: 'Candidate pairs',
  unique_primers: 'Unique primers',
  cached: 'Cached',
  blasted: 'BLASTed',
  locus_x_pairs: 'Locus X pairs',
  locus_y_pairs: 'Locus Y pairs',
  locus: 'Locus',
  strand: 'Strand',
  viewpoint_bp: 'Viewpoint',
};

function detailLabel(key: string): string {
  return DETAIL_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function detailValue(key: string, value: unknown): string {
  if (typeof value === 'number') {
    const suffix = key.endsWith('_bp') ? ' bp' : '';
    return `${value.toLocaleString()}${suffix}`;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value == null) return '';
  return String(value);
}

export function DesignRunControls({
  mode,
  designing,
  canDesign,
  peakCount,
  hasFastaReady,
  hasBlastDb,
  hasSplitView,
  targetTooLarge,
  progressMessage,
  progressPercent,
  progressDetails,
  error,
  blastWarning,
  onDesignPrimers,
  onDesign4c,
  onDesignDafc,
  onAbort,
  onClearError,
  onClearBlastWarning,
}: {
  mode: PrimerState['mode'];
  designing: boolean;
  canDesign: boolean;
  peakCount: number;
  hasFastaReady: boolean;
  hasBlastDb: boolean;
  hasSplitView: boolean;
  targetTooLarge: boolean;
  progressMessage: string;
  progressPercent: number;
  progressDetails?: Record<string, unknown>;
  error: string | null;
  blastWarning: string | null;
  onDesignPrimers: () => void;
  onDesign4c: () => void;
  onDesignDafc: () => void;
  onAbort: () => void;
  onClearError: () => void;
  onClearBlastWarning: () => void;
}) {
  const disabledReason = designDisabledReason({ mode, designing, peakCount, hasFastaReady, hasBlastDb, hasSplitView, targetTooLarge });
  const pct = Math.max(0, Math.min(100, Math.round(progressPercent || 0)));
  const detailEntries = Object.entries(progressDetails ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '');

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {mode === 'standard' ? (
          <AnalysisButton
            onClick={onDesignPrimers}
            disabled={!canDesign || designing}
            title={disabledReason ?? undefined}
            theme="rose"
            variant="primary"
            size="sm"
            className="px-3"
            data-copilot-anchor="primer-design-button"
          >
            Design Primers
          </AnalysisButton>
        ) : mode === '4c' ? (
          <AnalysisButton
            onClick={onDesign4c}
            disabled={peakCount === 0 || !hasFastaReady || !hasBlastDb || designing}
            title={disabledReason ?? undefined}
            theme="violet"
            variant="primary"
            size="sm"
            className="px-3"
          >
            Design 4C Primers
          </AnalysisButton>
        ) : hasSplitView ? (
          <AnalysisButton
            onClick={onDesignDafc}
            disabled={!hasFastaReady || !hasBlastDb || designing}
            title={disabledReason ?? undefined}
            theme="cyan"
            variant="primary"
            size="sm"
            className="px-3"
          >
            Design 3C Primers
          </AnalysisButton>
        ) : null}
        {disabledReason && !(mode === 'standard' && targetTooLarge) && (
          <span className="min-w-0 text-[11px] text-ink-muted dark:text-gray-400" data-testid="primer-design-disabled-reason">
            {disabledReason}
          </span>
        )}
      </div>

      {designing && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-rose-500 h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(4, pct)}%`, opacity: 0.85 }}
              />
            </div>
            <span className="text-gray-500 whitespace-nowrap text-[11px]">
              {progressMessage || 'Designing...'} {pct > 0 ? `(${pct}%)` : ''}
            </span>
            <AnalysisButton
              onClick={onAbort}
              variant="dangerOutline"
              className="whitespace-nowrap"
            >
              Abort
            </AnalysisButton>
          </div>
          {detailEntries.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {detailEntries.map(([key, value]) => (
                <span
                  key={key}
                  className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-[11px]"
                >
                  {detailLabel(key)}: {detailValue(key, value)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <AnalysisStatus kind="error" compact>
          <span className="flex items-center gap-2">
            <span className="flex-1">{error}</span>
            <AnalysisButton onClick={onClearError} variant="dangerOutline" className="px-1 py-0 leading-none" aria-label="Dismiss primer design error">
              x
            </AnalysisButton>
          </span>
        </AnalysisStatus>
      )}

      {blastWarning && !error && (
        <AnalysisStatus kind="warning" compact>
          <span className="flex items-center gap-2">
            <span className="flex-1">{blastWarning}</span>
            <AnalysisButton onClick={onClearBlastWarning} theme="amber" variant="outline" className="px-1 py-0 leading-none" aria-label="Dismiss BLAST warning">
              x
            </AnalysisButton>
          </span>
        </AnalysisStatus>
      )}
    </>
  );
}
