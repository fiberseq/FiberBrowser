import { useEffect } from 'react';
import { KEYBOARD_SHORTCUTS, SHORTCUT_CATEGORIES } from '../../utils/shortcuts';
import { Search, X } from '../ui/Icons';
import { openCommandPalette } from '../../utils/commandPaletteStore';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  // Close on Escape, or on ? (it toggles this dialog)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      // ⌘K / Ctrl+K from here: on to the command palette.
      else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        openCommandPalette();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        data-testid="keyboard-shortcuts-dialog"
        className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-white/10">
          <h2 id="keyboard-shortcuts-title" className="text-sm font-semibold text-gray-700 dark:text-gray-200">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="fb-icon-btn h-6 w-6"
            aria-label="Close keyboard shortcuts"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-4">
          {SHORTCUT_CATEGORIES.map(category => {
            const items = KEYBOARD_SHORTCUTS.filter(s => s.category === category);
            if (items.length === 0) return null;
            return (
              <div key={category}>
                <div className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 mb-2">
                  {category}
                </div>
                <div className="space-y-1.5">
                  {items.map(shortcut => (
                    <div key={shortcut.key} className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-gray-600 dark:text-gray-400">{shortcut.description}</span>
                      <kbd className="flex-shrink-0 px-2 py-0.5 bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/15 rounded text-[11px] font-mono text-gray-600 dark:text-gray-300">
                        {shortcut.key}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-t border-gray-200 dark:border-white/10 text-[11px] text-gray-400 dark:text-gray-500">
          <span className="flex-1">
            Press <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/15 rounded text-[11px] font-mono">?</kbd> to toggle this dialog
          </span>
          {/* Everything here and more (every action, panel and setting) is searchable in the palette. */}
          <button
            type="button"
            onClick={() => { onClose(); openCommandPalette(); }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-brand-700 hover:bg-brand-600/10 dark:text-brand-300 dark:hover:bg-brand-400/15"
            data-testid="shortcuts-open-palette"
          >
            <Search size={12} aria-hidden="true" />
            Search commands and settings ({isMac ? '\u2318K' : 'Ctrl+K'})
          </button>
        </div>
      </div>
    </div>
  );
}
