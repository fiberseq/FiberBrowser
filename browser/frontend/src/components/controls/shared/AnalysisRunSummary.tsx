import type { ReactNode } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { ChevronRight } from '../../ui/Icons';

export type AnalysisSummaryTarget =
  | 'annotation-filter'
  | 'analysis-filter'
  | 'cluster-detail'
  | 'footprint-cooccurrence'
  | 'peak-detection'
  | 'quality'
  | 'reproducibility'
  | 'transcription-filters';

function formatCap(count: number | null | undefined): string {
  if (count == null) return 'Full analysis set';
  if (count >= 1000) return `Analysis cap ${Math.round(count / 100) / 10}k`;
  return `Analysis cap ${count}`;
}

export function openSummaryTarget(target: AnalysisSummaryTarget, source: string) {
  const store = useBrowserStore.getState();
  if (typeof window !== 'undefined') {
    if (target === 'cluster-detail') {
      window.sessionStorage.setItem('fiberbrowser_cluster_detail_tab', 'overview');
    } else if (target === 'footprint-cooccurrence') {
      window.sessionStorage.setItem('fiberbrowser_footprint_analysis_tab', 'co-occ');
    } else if (target === 'quality') {
      window.sessionStorage.setItem('fiberbrowser_colormap_tab', 'quality');
    } else if (target === 'transcription-filters') {
      window.sessionStorage.setItem('fiberbrowser_transcription_state_tab', 'filters');
    } else if (target === 'annotation-filter') {
      window.sessionStorage.setItem('fiberbrowser_annotation_tab', 'filter');
    } else if (target === 'analysis-filter') {
      window.sessionStorage.setItem('fiberbrowser_analysis_rules_tab', 'filter');
    } else if (target === 'peak-detection') {
      window.sessionStorage.setItem('fiberbrowser_analysis_rules_tab', 'peaks');
    }
  }

  if (target === 'analysis-filter') {
    store.openAnalysisPanel('cluster-features');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-analysis-rules-tab', {
        detail: { tab: 'filter', source },
      }));
    }
    return;
  }

  if (target === 'annotation-filter') {
    store.openAnalysisPanel('annotations');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-annotation-tab', {
        detail: { tab: 'filter', source },
      }));
    }
    return;
  }

  if (target === 'cluster-detail') {
    store.openAnalysisPanel('cluster-detail');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-cluster-detail-tab', {
        detail: { tab: 'overview', source },
      }));
    }
    return;
  }

  if (target === 'footprint-cooccurrence') {
    store.openAnalysisPanel('footprint-analysis');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-footprint-analysis-tab', {
        detail: { tab: 'co-occ', source },
      }));
    }
    return;
  }

  if (target === 'peak-detection') {
    store.openAnalysisPanel('cluster-features');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-analysis-rules-tab', {
        detail: { tab: 'peaks', source },
      }));
    }
    return;
  }

  if (target === 'quality') {
    store.openAnalysisPanel('colormap');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-colormap-tab', {
        detail: { tab: 'quality', source },
      }));
    }
    return;
  }

  if (target === 'reproducibility') {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
        detail: {
          sectionId: 'analysis',
          subsectionId: 'analysis.reproducibility',
          source,
        },
      }));
    }
    return;
  }

  if (target === 'transcription-filters') {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('fiberbrowser_transcription_state_tab', 'filters');
    }
    store.openAnalysisPanel('transcription-state');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-transcription-state-tab', {
        detail: { tab: 'filters', source },
      }));
    }
  }
}

interface ChipProps {
  children: ReactNode;
  tone?: 'neutral' | 'info' | 'warning' | 'success';
  title?: string;
  onClick?: () => void;
}

function Chip({ children, tone = 'neutral', title, onClick }: ChipProps) {
  const cls = {
    neutral: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300',
    info: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300',
    warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
  }[tone];
  const className = `inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${cls} ${
    onClick ? 'cursor-pointer hover:ring-1 hover:ring-current/30 focus:outline-none focus:ring-1 focus:ring-current/40' : ''
  }`;
  if (onClick) {
    return (
      <button type="button" title={title} className={className} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <span
      title={title}
      className={className}
    >
      {children}
    </span>
  );
}

interface AnalysisRunSummaryProps {
  seed?: string | null;
  analysisCap?: number | null;
  showAnalysisCap?: boolean;
  filterActive?: boolean;
  filterLabel?: string;
  filterSource?: AnalysisSummaryTarget | null;
  filterSourceLabel?: string;
  qualityFilterCount?: number;
  peaksLocked?: boolean;
  inputs?: string[];
  outputs?: string[];
  extra?: ReactNode;
  className?: string;
}

export function AnalysisRunSummary({
  seed,
  analysisCap,
  showAnalysisCap = false,
  filterActive = false,
  filterLabel = 'Filtered',
  filterSource = null,
  filterSourceLabel,
  qualityFilterCount = 0,
  peaksLocked = false,
  inputs = [],
  outputs = [],
  extra,
  className = '',
}: AnalysisRunSummaryProps) {
  // Seeds, inputs, outputs and the quality filters in effect are receipts:
  // shown only with analysis details on (More menu) and only after a run.
  // Chips that change what this panel shows (a focus, a filter) always stay.
  const showDetails = useBrowserStore(s => s.showAnalysisDetails);
  // Chips that change what the panel shows stay visible; routine provenance
  // (inputs, outputs, seed, full analysis set) sits behind "Run details".
  const chips: ReactNode[] = [];
  const details: ReactNode[] = [];
  for (const [index, input] of inputs.entries()) {
    if (!input) continue;
    details.push(
      <Chip key={`input-${index}`} tone="neutral" title="Analysis input">
        In: {input}
      </Chip>
    );
  }
  if (showAnalysisCap) {
    (analysisCap == null ? details : chips).push(
      <Chip
        key="cap"
        tone={analysisCap == null ? 'neutral' : 'warning'}
        title="Source: Settings > Analysis & Reproducibility > Reproducibility. Click to inspect analysis downsampling."
        onClick={() => openSummaryTarget('reproducibility', 'analysis-summary-analysis-cap')}
      >
        {formatCap(analysisCap)}
      </Chip>
    );
  }
  if (seed) {
    details.push(
      <Chip
        key="seed"
        tone="info"
        title="Source: Settings > Analysis & Reproducibility > Reproducibility. Click to inspect the shared seed."
        onClick={() => openSummaryTarget('reproducibility', 'analysis-summary-seed')}
      >
        Seed: {seed}
      </Chip>
    );
  }
  if (filterActive) {
    const sourceLabel = filterSourceLabel ?? 'active analysis filter';
    chips.push(
      <Chip
        key="filter"
        tone="success"
        title={filterSource
          ? `Source: ${sourceLabel}. Click to inspect the filter source.`
          : `Source: ${sourceLabel}.`}
        onClick={filterSource ? () => openSummaryTarget(filterSource, 'analysis-summary-filter') : undefined}
      >
        {filterLabel}
      </Chip>
    );
  }
  if (qualityFilterCount > 0) {
    // Quality filters apply to every read the app loads (the toolbar's
    // Quality group says so once), so they are a receipt here, not a chip on
    // every panel.
    details.push(
      <Chip
        key="quality"
        tone="neutral"
        title="Calls (e.g. accessible patches) that fail a quality filter are left out of every view and analysis; the reads themselves stay. Click to see or change the filters (Labeling > Quality)."
        onClick={() => openSummaryTarget('quality', 'analysis-summary-quality-filter')}
      >
        {qualityFilterCount} quality filter{qualityFilterCount !== 1 ? 's' : ''} applied
      </Chip>
    );
  }
  if (peaksLocked) {
    chips.push(
      <Chip
        key="peaks"
        tone="warning"
        title="Source: Peak Detection. Click to inspect locked peak and peak export controls."
        onClick={() => openSummaryTarget('peak-detection', 'analysis-summary-locked-peaks')}
      >
        Peaks locked
      </Chip>
    );
  }
  for (const [index, output] of outputs.entries()) {
    if (!output) continue;
    details.push(
      <Chip key={`output-${index}`} tone="info" title="Analysis output">
        Out: {output}
      </Chip>
    );
  }

  // "Run details" describe a run: nothing to show until the panel has
  // produced something (an output), however many inputs it lists.
  const hasRun = outputs.some(output => !!output);
  if (!showDetails || !hasRun) details.length = 0;
  if (chips.length === 0 && details.length === 0 && !extra) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-1 text-[11px] ${className}`}
      aria-label="Analysis inputs, outputs, and provenance"
    >
      {chips}
      {extra}
      {details.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[11px] text-ink-secondary hover:text-gray-600 dark:hover:text-gray-300">
            Run details <ChevronRight size={10} strokeWidth={2.5} aria-hidden="true" className="inline-block align-[-1px] transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1 flex flex-wrap gap-1">{details}</div>
        </details>
      )}
    </div>
  );
}
