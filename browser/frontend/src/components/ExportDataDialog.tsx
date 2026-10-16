import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ExportDataList } from './ExportDataList';
import { FileDown, X } from './ui/Icons';

/**
 * Export data… (the toolbar's file button beside Export figure, File > Export
 * Data…, ⌘⇧E): every data export in one place, grouped by what it is about.
 */
const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function ExportDataDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // A modal: focus moves into it when it opens (its first control), Tab and
  // Shift+Tab stay inside it, and focus goes back where it was on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector('[data-testid="export-data-dialog-body"]')?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
    return () => {
      if (before && before.isConnected && (!document.activeElement || document.activeElement === document.body || dialog?.contains(document.activeElement))) {
        before.focus();
      }
    };
  }, []);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest('[hidden]'));
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const at = document.activeElement;
    if (event.shiftKey ? (at === first || !dialogRef.current.contains(at)) : (at === last || !dialogRef.current.contains(at))) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  // Escape closes it, unless a field or a menu opened on top of it takes it first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const overlays = document.querySelectorAll('[aria-modal="true"], [role="menu"], [role="listbox"]');
      if ([...overlays].some(el => !el.closest('[data-export-data-modal]'))) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-export-data-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-data-dialog-title"
        data-testid="export-data-dialog"
        tabIndex={-1}
        onKeyDown={trapTab}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-apple-lg border border-line/60 bg-white/95 shadow-modal backdrop-blur-xl dark:border-white/10 dark:bg-dark-surface/95 dark:shadow-modal-dark"
      >
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-3 dark:border-white/10">
          <h2 id="export-data-dialog-title" className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-100">
            <span className="flex h-7 w-7 items-center justify-center rounded-fb bg-brand-50 text-brand-700 ring-1 ring-brand-100 dark:bg-brand-400/15 dark:text-brand-300 dark:ring-brand-400/20" aria-hidden="true"><FileDown size={15} /></span>
            Export data
          </h2>
          <button onClick={onClose} className="fb-icon-btn" aria-label="Close export data dialog" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="export-data-dialog-body">
          <ExportDataList onOpenPanel={onClose} />
        </div>
      </div>
    </div>
  );
}
