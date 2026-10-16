import { useMemo, useState } from 'react';
import { detectHaplotypePairs } from '../../../utils/haplotypePairs';
import { Info, X } from '../../ui/Icons';
import { AnalysisButton } from '../shared';

export const HAPLOTYPE_HINT_KEY = 'fiberbrowser_hint_haplotype_pairs_v1';

function dismissed(): boolean {
  try { return window.localStorage.getItem(HAPLOTYPE_HINT_KEY) === '1'; } catch { return false; }
}

/**
 * Shown once, when the loaded reference has haplotype pairs (chr1_hap1 and
 * chr1_hap2, chr1_MATERNAL and chr1_PATERNAL, ...): points at Compare
 * haplotypes, which is also in every dataset panel's ⋯ menu.
 */
export function HaplotypePairHint({ chromNames, onOpen }: { chromNames: string[]; onOpen: () => void }) {
  const pairs = useMemo(() => detectHaplotypePairs(chromNames), [chromNames]);
  const [hidden, setHidden] = useState(dismissed);
  if (hidden || pairs.length === 0) return null;
  const dismiss = () => {
    setHidden(true);
    try { window.localStorage.setItem(HAPLOTYPE_HINT_KEY, '1'); } catch { /* private window */ }
  };
  const first = pairs[0];
  return (
    <div
      className="flex items-start gap-2 rounded-fb border border-teal-200 bg-teal-50 px-2.5 py-2 text-[11px] text-teal-900 dark:border-teal-800/60 dark:bg-teal-900/20 dark:text-teal-100"
      data-testid="haplotype-pair-hint"
      role="note"
    >
      <Info size={12} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          This reference has {pairs.length === 1 ? 'a haplotype pair' : `${pairs.length} haplotype pairs`} ({first.chrom1} / {first.chrom2}).
          {' '}Compare haplotypes shows a locus on both side by side; it is also in each dataset panel's ⋯ menu.
        </div>
        <AnalysisButton size="sm" variant="soft" theme="teal" onClick={() => { dismiss(); onOpen(); }}>
          Compare haplotypes
        </AnalysisButton>
      </div>
      <button type="button" onClick={dismiss} className="shrink-0 rounded p-0.5 hover:bg-teal-100 dark:hover:bg-white/10" title="Don't show again" aria-label="Dismiss">
        <X size={12} />
      </button>
    </div>
  );
}
