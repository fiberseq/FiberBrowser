/**
 * The footprint size plots' option lists and the commit-on-blur number box, shared by the Plots builder's size and
 * display settings (they lived with the Clusters panel's Footprint sizes tab, retired in 3.1.1: Plots draws them).
 */
import { useEffect, useState } from 'react';

export const SIZE_BINS = [1, 2, 5, 10, 20, 50];
export const POS_BINS = [1, 2, 5, 10, 20, 50, 100];
export const SIZE_PRESETS = [
  { value: '10-300', label: 'All (10-300)' },
  { value: '10-120', label: 'Small FP (10-120)' },
  { value: '35-80', label: 'TF-size (35-80)' },
  { value: '80-240', label: 'Nuc (80-240)' },
  { value: '10-600', label: 'Wide (10-600)' },
];
export const COLOR_MAX_ENRICH = [{ value: 0, label: 'Auto' }, ...[1.5, 2, 3, 4, 8].map(v => ({ value: v, label: `${v}x` }))];

/** A number box that commits on blur or Enter (typing "250" does not snap at "2"). */
export function CommitNumber({ value, onCommit, min, ariaLabel, className, testId }: {
  value: number; onCommit: (v: number) => void; min: number; ariaLabel: string; className: string; testId?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => { const v = Number(text); if (Number.isFinite(v) && v >= min && v !== value) onCommit(v); else setText(String(value)); };
  return (
    <input type="number" value={text} min={min} aria-label={ariaLabel} data-testid={testId} className={className}
      onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
  );
}
