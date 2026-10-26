/**
 * "Pop out paths…" (DESIGN_GRAPH_PRIMARY §4.1, a subset): a checklist of the paths in view a host can pop out — its
 * folded members and, for a pooled host, the haplotypes with no panel yet. Confirm pops out exactly the checked ones
 * in one undo step (popOut), as the host's pop-out kind says (popOutKind.ts).
 */
import { useState } from 'react';
import { create } from 'zustand';
import type { PanelConfig } from '../../types';
import { popOutPaths } from './popOutKind';

interface PickerState { hostId: string | null; open: (hostId: string) => void; close: () => void }

/** Which host's checklist is open (one at a time; not saved). */
export const usePopOutPicker = create<PickerState>(set => ({
  hostId: null,
  open: hostId => set({ hostId }),
  close: () => set({ hostId: null }),
}));

export const pickKey = { member: (id: string) => `m:${id}`, missing: (binding: string) => `b:${binding}` };

/** Pure: the checked entries as popOut's arguments (members in band order, then the new haplotypes). */
export function pickedPopOut(folded: readonly PanelConfig[], missing: readonly { binding: string; hap: string }[], checked: ReadonlySet<string>):
  { ids: string[]; missing: { binding: string; hap: string }[] } {
  return { ids: folded.filter(p => checked.has(pickKey.member(p.id))).map(p => p.id),
    missing: missing.filter(m => checked.has(pickKey.missing(m.binding))) };
}

export function PopOutPicker({ hostId, folded, missing, labelOf }: { hostId: string; folded: PanelConfig[];
  missing: { binding: string; hap: string }[]; labelOf: (p: PanelConfig) => string }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const close = usePopOutPicker(s => s.close);
  const toggle = (key: string) => setChecked(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const rows = [
    ...folded.map(p => ({ key: pickKey.member(p.id), label: labelOf(p), attrs: { 'data-member': p.id } })),
    ...missing.map(m => ({ key: pickKey.missing(m.binding), label: `${m.hap} (a new panel)`, attrs: { 'data-binding': m.binding } })),
  ];
  const confirm = () => {
    const pick = pickedPopOut(folded, missing, checked);
    close();
    if (pick.ids.length || pick.missing.length) popOutPaths(hostId, pick.ids, pick.missing);
  };
  return (
    <div data-testid="graph-pop-out-picker" data-host={hostId} role="group" aria-label="Pop out paths"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[11px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200">
      <span className="font-medium">Pop out paths:</span>
      {rows.map(r => (
        <label key={r.key} className="inline-flex cursor-pointer items-center gap-1">
          <input type="checkbox" data-testid="graph-pop-out-pick" {...r.attrs} checked={checked.has(r.key)} onChange={() => toggle(r.key)} />
          {r.label}
        </label>
      ))}
      <span className="ml-auto inline-flex gap-2">
        <button type="button" className="underline disabled:opacity-40" data-testid="graph-pop-out-confirm" disabled={!checked.size}
          onClick={confirm}>Pop out {checked.size || ''}</button>
        <button type="button" className="underline" data-testid="graph-pop-out-cancel" onClick={close}>Cancel</button>
      </span>
    </div>
  );
}
