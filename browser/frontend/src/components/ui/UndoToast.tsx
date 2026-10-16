/**
 * The undo message of a scope (stores/undoToastStore.ts): "Removed S1 · Class 025 · Undo", polite, dismissable. Its
 * time waits while the pointer is on it or focus is in it (usability round 2, N24).
 */
import { useUndoToastStore } from '../../stores/undoToastStore';

export function UndoToast({ scope, className = '' }: { scope: string; className?: string }) {
  const toast = useUndoToastStore(s => (s.toast?.scope === scope ? s.toast : null));
  const { dismiss, pause, resume } = useUndoToastStore.getState();
  return (
    <div role="status" aria-live="polite" className={className}>
      {toast && (
        <div data-testid="undo-toast" className="flex items-center gap-2 rounded-fb border border-gray-300 bg-gray-900 px-2.5 py-1.5 text-[12px] text-white shadow-lg dark:border-white/15 dark:bg-gray-100 dark:text-gray-900"
          onMouseEnter={() => pause(toast.id)}
          onMouseLeave={e => { if (!e.currentTarget.contains(document.activeElement)) resume(toast.id); }}
          onFocus={() => pause(toast.id)}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(':hover')) resume(toast.id); }}>
          <span className="min-w-0 flex-1 truncate">{toast.text}</span>
          <button type="button" data-testid="undo-toast-undo" onClick={() => { toast.undo(); dismiss(toast.id); }}
            className="rounded px-1.5 py-0.5 font-semibold text-emerald-300 hover:bg-white/10 dark:text-emerald-700 dark:hover:bg-black/5">Undo</button>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)} className="rounded px-1 opacity-70 hover:opacity-100">×</button>
        </div>
      )}
    </div>
  );
}
