import type { ReactNode } from 'react';
import { ChevronRight, Info } from './Icons';

/**
 * Longer method notes behind one small "How this works" line, so a panel opens
 * with a single short sentence instead of paragraphs of help text.
 */
export function HowItWorks({ children, summary = 'How this works', className = '', testId }: {
  children: ReactNode;
  summary?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <details className={`group text-[11px] ${className}`} data-testid={testId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        <Info size={11} aria-hidden="true" />
        {summary}
        <ChevronRight size={10} strokeWidth={2.5} aria-hidden="true" className="transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-1 space-y-1 rounded-fb border border-line/70 bg-surface-sunken px-2 py-1.5 leading-4 text-gray-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-300">
        {children}
      </div>
    </details>
  );
}
