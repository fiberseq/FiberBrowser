/**
 * A checkbox whose whole row is its label (usability audit Top 6): clicking the words toggles it, and the row is at
 * least 24 px tall so it is an easy target. Optional secondary description under the label.
 */
import type { ReactNode } from 'react';

export interface CheckboxRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Tooltip for the whole row. */
  title?: string;
  testId?: string;
  className?: string;
  /** Indeterminate state (some of a group). */
  indeterminate?: boolean;
}

export function CheckboxRow({ checked, onChange, label, description, disabled, title, testId, className = '', indeterminate }: CheckboxRowProps) {
  return (
    <label
      title={title}
      data-testid={testId}
      className={`checkbox-row flex min-h-[24px] items-start gap-2 rounded-fb px-1 py-0.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5'} ${className}`}
    >
      <input
        type="checkbox"
        className="mt-[3px] h-4 w-4 shrink-0 cursor-[inherit]"
        checked={checked}
        disabled={disabled}
        ref={el => { if (el) el.indeterminate = Boolean(indeterminate); }}
        onChange={e => onChange(e.target.checked)}
        data-testid={testId ? `${testId}-input` : undefined}
      />
      <span className="min-w-0 flex-1 leading-[20px]">
        <span className="block">{label}</span>
        {description && <span className="block text-[11px] leading-snug text-ink-secondary">{description}</span>}
      </span>
    </label>
  );
}
