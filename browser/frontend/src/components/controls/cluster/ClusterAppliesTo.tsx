/**
 * "Panels" beside Cluster (usability audit Top 3, SV-1): which panels the next Cluster run clusters, which it leaves
 * out and why, and a picker to target panels (the same targets a click on a panel's name sets; Sort and Filter use
 * them too). The plan is utils/clusterTargets.ts clusterRunPlan, the plan the run itself follows, so what this says
 * is what the run does.
 *
 * Round 2:
 * - N7: the toolbar shows a short chip; the long form wrapped the toolbar at 1440 px.
 * - N15: before a run the rows say what the run *will* do ("Will cluster" / "Left out: …"); the mode is a radio
 *   ("All compatible panels" / "Selected panels"); targets drive Sort and Filter too (Browser.tsx handleSort /
 *   handleFilter use the same getTargetDatasetIds), and the picker says so.
 * - N2: keyboard: ↑/↓ move between its rows, Space picks or ticks, Tab stays inside it, Escape closes it and puts
 *   focus back on the chip.
 *
 * Round 3 (R8): the chip names what it chooses ("Panels: all", "Panels: Carriers · 1 left out"); the picker is
 * "Panels for Cluster, Sort and Filter"; in "All compatible panels" the rows are status only (no boxes to tick that
 * the mode ignores); a row is the panel's name as its header leads with it, the rest on a second line; focus opens on
 * the checked radio.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { clusterRunPlan, type ClusterTargetPlan, type ClusterTargetRow } from '../../../utils/clusterTargets';
import { useSplitPanelStore } from '../../../stores/splitPanelStore';
import { CheckboxRow } from '../shared/CheckboxRow';

/** The plan for the current state (recomputed when what it depends on changes). */
export function useClusterTargetPlan(): ClusterTargetPlan {
  const deps = useBrowserStore(useShallow(s => [
    s.panels, s.datasets, s.selectedDatasets, s.selectedPeaks, s.peaksByRule, s.peakRules, s.peakModes, s.clusterPeakMode,
    s.clusterFeatureRules, s.selectedFeatures, s.filteredReadIds, s.chrom, s.start, s.end, s.currentGenome, s.selectedGenes,
    s.clusterMethod, s.clusterAssignments, s.selectedClusters, s.clusterFocus,
  ]));
  // (A split panel's reads, classified after it opens, change which panels have reads to cluster.)
  const splitReads = useSplitPanelStore(s => s.reads);
  return useMemo(() => clusterRunPlan(useBrowserStore.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps, splitReads]);
}

/** The picker's rows, in order (the mode radios, then the panels' boxes): what ↑/↓ move between. */
const ROW_SELECTOR = 'input[data-applies-row], li[data-testid="cluster-applies-row"] input';
/** Where focus goes when the picker opens: the checked mode radio (else the first row). */
function firstRow(menu: HTMLElement | null): HTMLInputElement | undefined {
  const checked = menu?.querySelector<HTMLInputElement>('input[data-applies-row="mode"]:checked');
  return checked ?? menu?.querySelector<HTMLInputElement>(ROW_SELECTOR) ?? undefined;
}
/** Everything Tab can reach inside the picker. */
const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A row's name as the panel's header leads with it ("Carriers"), and the rest of its title on a second line. */
function rowName(r: ClusterTargetRow) {
  return (
    <span className="block min-w-0">
      <span className="block break-words font-medium" data-testid="cluster-applies-name">{r.short}</span>
      {r.detail && <span className="block break-words text-[11px] leading-snug text-ink-muted" data-testid="cluster-applies-detail">{r.detail}</span>}
    </span>
  );
}

function rowStatus(r: ClusterTargetRow) {
  return r.inRun
    ? <span className="text-emerald-700 dark:text-emerald-300" data-testid="cluster-applies-status">Will cluster</span>
    : r.reason
      ? <span className="text-amber-800 dark:text-amber-200" data-testid="cluster-applies-reason">Left out: {r.reason}</span>
      : <span data-testid="cluster-applies-status">Not selected</span>;
}

export function ClusterAppliesTo() {
  const plan = useClusterTargetPlan();
  const [open, setOpen] = useState(false);
  // "Selected panels" chosen with none ticked yet: the store has no targets then, so the choice lives here until a
  // panel is ticked (and is forgotten when the picker closes with none ticked).
  const [pickSelected, setPickSelected] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const toggleTarget = useBrowserStore(s => s.toggleDatasetSelection);
  const clearTargets = useBrowserStore(s => s.clearDatasetSelection);
  const mode: 'all' | 'selected' = plan.explicit || pickSelected ? 'selected' : 'all';

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => { if (!open) setPickSelected(false); }, [open]);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 368)) });
  }, [open]);
  // Focus goes into the picker when it opens: the checked mode radio.
  useEffect(() => {
    if (!open || !pos) return;
    firstRow(menuRef.current)?.focus();
  }, [open, pos]);
  // Unticking the last panel goes back to All mode, whose rows have no boxes: the focused box is gone, so focus goes
  // to the checked radio rather than to the page (Codex review: the picker lost the keyboard).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu || menu.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    firstRow(menu)?.focus();
  }, [open, mode]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Escape with focus outside the picker (on the chip): close it too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || menuRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    if (e.key === 'Escape') {
      // Handled here: the app's global Escape (clear the selection) must not run as well.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const rows = Array.from(menu.querySelectorAll<HTMLInputElement>(ROW_SELECTOR)).filter(r => !r.disabled);
      if (!rows.length) return;
      // Also on the radios: ↑/↓ move between rows (Space picks), rather than changing the mode as they go.
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLInputElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1
        : at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next].focus();
      return;
    }
    if (e.key === 'Tab') {
      // Tab stays in the picker (a dialog), moved here rather than left to the browser: from the last stop to the
      // first and back. A radio group is one stop (its checked radio), also when ↑/↓ left focus on its other radio.
      const isRadio = (el: Element | null): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio';
      const checkedOf = (el: HTMLInputElement) => menu.querySelector<HTMLInputElement>(`input[type="radio"][name="${el.name}"]:checked`);
      const items = Array.from(menu.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => el.tabIndex >= 0 && !(isRadio(el) && !el.checked && checkedOf(el)));
      if (!items.length) return;
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const stop = isRadio(active) && !active.checked ? (checkedOf(active) ?? active) : active;
      const at = stop ? items.indexOf(stop) : -1;
      const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }
  };

  if (plan.rows.length === 0) return null;
  const excluded = plan.rows.filter(r => r.reason).length;
  const tone = plan.refusal ? 'border-red-300 text-red-800 dark:border-red-800 dark:text-red-200'
    : excluded ? 'border-amber-300 text-amber-900 dark:border-amber-800 dark:text-amber-100'
      : 'border-line text-ink dark:border-white/15 dark:text-gray-100';
  const radio = (value: 'all' | 'selected', label: string, description: string, testId: string) => (
    <label className="flex min-h-[24px] cursor-pointer items-start gap-2 rounded-fb px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-white/5" data-testid={testId}>
      <input type="radio" name="cluster-applies-mode" className="mt-[3px] h-4 w-4 shrink-0" data-applies-row="mode"
        data-testid={`${testId}-input`} checked={mode === value}
        onChange={() => {
          if (value === 'all') { setPickSelected(false); clearTargets(); } else setPickSelected(true);
        }} />
      <span className="min-w-0 flex-1 leading-[20px]">
        <span className="block">{label}</span>
        <span className="block text-[11px] leading-snug text-ink-secondary">{description}</span>
      </span>
    </label>
  );
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="cluster-applies-to"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${plan.chip}. ${plan.summary}. Choose the panels for Cluster, Sort and Filter`}
        title={`${plan.summary}${plan.refusal ? `\n${plan.refusal}` : ''}\nClick to choose the panels Cluster, Sort and Filter act on.`}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => {
          // ↓ on the chip while the picker is open: into the picker.
          if (open && e.key === 'ArrowDown') {
            e.preventDefault();
            firstRow(menuRef.current)?.focus();
          }
        }}
        className={`inline-flex h-6 max-w-[12.5rem] min-w-0 items-center gap-1 rounded-fb border bg-white px-1.5 text-[11.5px] hover:bg-gray-50 dark:bg-white/5 dark:hover:bg-white/10 ${tone}`}
      >
        <span className="truncate" data-testid="cluster-applies-to-short">{plan.chip}</span>
        <span aria-hidden="true" className="opacity-60">▾</span>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="dialog" aria-modal="false" aria-labelledby="cluster-applies-to-title" data-testid="cluster-applies-to-menu"
          onKeyDown={onMenuKeyDown}
          className="fb-menu fixed z-[200] w-[360px] max-w-[calc(100vw-16px)] p-2 text-[12px]" style={{ top: pos.top, left: pos.left }}>
          <div className="mb-1 font-semibold" id="cluster-applies-to-title">Panels for Cluster, Sort and Filter</div>
          <p className="mb-0.5 text-[11.5px] font-medium" data-testid="cluster-applies-to-summary">{plan.headline}</p>
          {plan.notes.map(note => (
            <p key={note} className="mb-0.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200" data-testid="cluster-applies-to-note">{note}</p>
          ))}
          <p className="mb-1.5 mt-1 text-[11px] leading-snug text-ink-secondary" data-testid="cluster-applies-to-scope">
            Sort and Filter act on the same panels. Clicking a panel’s name targets it too.
          </p>
          <div role="radiogroup" aria-label="Which panels">
            {radio('all', 'All compatible panels', 'Every panel the run can cluster', 'cluster-applies-all')}
            {radio('selected', 'Selected panels', plan.explicit ? 'Only the ticked panels'
              : 'None ticked yet: until you tick one, Cluster takes all compatible panels', 'cluster-applies-selected')}
          </div>
          <div className="my-1 border-t border-line dark:border-white/10" />
          <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto" aria-label="Panels">
            {plan.rows.map(r => (
              <li key={r.panelId} data-testid="cluster-applies-row" data-panel-id={r.panelId} data-in-run={r.inRun ? 'true' : 'false'}>
                {mode === 'all' ? (
                  // All compatible panels: what the run does with each, nothing to tick (the mode decides).
                  <div className="flex min-h-[24px] items-start gap-2 px-1 py-0.5" title={r.label}>
                    <span aria-hidden="true" className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${r.inRun ? 'bg-emerald-600' : r.reason ? 'bg-amber-500' : 'bg-gray-400'}`} />
                    <span className="min-w-0 flex-1 leading-[20px]">
                      {rowName(r)}
                      <span className="block text-[11px] leading-snug text-ink-secondary">{rowStatus(r)}</span>
                    </span>
                  </div>
                ) : (
                  <CheckboxRow checked={r.targeted} title={r.label}
                    onChange={() => {
                      toggleTarget(r.panelId);
                      // Nothing ticked after this (linked panels toggle together) is "All compatible panels" again: what
                      // the run then does, said by the radio.
                      setPickSelected(useBrowserStore.getState().selectedDatasets.size > 0);
                    }}
                    label={rowName(r)}
                    description={rowStatus(r)} />
                )}
              </li>
            ))}
          </ul>
          {plan.refusal && (
            <p role="alert" className="mt-1.5 rounded-fb border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200" data-testid="cluster-applies-refusal">
              {plan.refusal}
            </p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
