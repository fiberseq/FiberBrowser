/**
 * Accessibility (preview): the panel's shared controls, one strip above both tabs (NFRs, NFR pairs): the list's
 * All / Starred filter, the q every list and test is held to, and the settings (finding variants, motif scoring and
 * site evidence).
 */
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAccessibilityStore } from '../accessibilityStore';
import { DisclosureChevron } from '../../../components/ui/Disclosure';

export const Q_STEPS = [0.001, 0.01, 0.05, 0.1, 0.2];

export function NfrFilterStrip({ settings, extra }: { settings: React.ReactNode; /** The list's All / Starred filter (on the NFRs tab). */ extra?: React.ReactNode }) {
  const { qMax, setFilter } = useAccessibilityStore(useShallow(s => ({ qMax: s.qMax, setFilter: s.setFilter })));
  const [open, setOpen] = useState(false);
  const qi = Math.max(0, Q_STEPS.findIndex(q => q >= qMax - 1e-12));
  return (
    <div className="rounded-md border border-gray-200 text-[11px] dark:border-gray-700" data-testid="nfr-filter-strip">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
        {extra}
        <label className="flex items-center gap-1.5" title="Significance for the arcs, pairs and tests of this panel (Benjamini–Hochberg q)">
          q ≤
          <input type="range" min={0} max={Q_STEPS.length - 1} step={1} value={qi} aria-label="q threshold" data-testid="nfr-q"
            onChange={e => setFilter({ qMax: Q_STEPS[Number(e.target.value)] })} className="w-20 accent-fuchsia-600" />
          <span className="w-9 tabular-nums">{qMax}</span>
        </label>
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} data-testid="nfr-settings-toggle"
          className="ml-auto flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
          <DisclosureChevron open={open} /> Settings
        </button>
      </div>
      {open && <div className="space-y-1.5 border-t border-gray-100 p-2 dark:border-white/5" data-testid="nfr-settings">{settings}</div>}
    </div>
  );
}
