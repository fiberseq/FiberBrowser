import type { ReactNode } from 'react';

export type AnalysisStatusKind = 'empty' | 'loading' | 'error' | 'warning' | 'info' | 'success';

interface AnalysisStatusProps {
  kind?: AnalysisStatusKind;
  title?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  center?: boolean;
  className?: string;
  /** An icon shown above a centred empty state (e.g. the panel's domain icon). */
  icon?: ReactNode;
}

const STATUS_CLASSES: Record<AnalysisStatusKind, string> = {
  empty: 'border-gray-200 bg-gray-50/80 text-gray-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-400',
  loading: 'border-blue-200 bg-blue-50/80 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300',
  error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  info: 'border-slate-200 bg-slate-50/80 text-slate-600 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-300',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
};

export function AnalysisStatus({
  kind = 'info',
  title,
  children,
  compact = false,
  center = false,
  className = '',
  icon,
}: AnalysisStatusProps) {
  const role = kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : undefined;

  return (
    <div
      role={role}
      className={[
        'rounded-fb border',
        STATUS_CLASSES[kind],
        compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-2 text-xs',
        center ? 'text-center' : '',
        kind === 'loading' ? 'animate-pulse' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {icon && center && (
        <div className="mb-2 flex justify-center" aria-hidden="true">
          <span className="fb-empty-icon">{icon}</span>
        </div>
      )}
      {title && <div className="font-medium">{title}</div>}
      {children && (
        <div className={title ? 'mt-0.5 opacity-90' : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}
