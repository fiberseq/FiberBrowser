import type { ReactNode } from 'react';

export function PrimerStatusChip({
  tone,
  children,
  title,
}: {
  tone: 'success' | 'warning' | 'neutral' | 'info';
  children: ReactNode;
  title?: string;
}) {
  const classes = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
    warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
    neutral: 'border-gray-200 bg-gray-50 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400',
    info: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300',
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${classes}`}>
      {children}
    </span>
  );
}
