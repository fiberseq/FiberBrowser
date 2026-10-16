import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from '../ui/Icons';
import { HelpIcon } from '../ui/Tooltip';
import { useSettingsFilter } from './sidebar/settingsFilter';

interface Props {
  id: string;
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  helpText?: string;
  persist?: boolean;  // Persist collapsed state to localStorage
}

function getPersistedState(id: string, defaultOpen: boolean): boolean {
  try {
    const stored = localStorage.getItem(`fiberhmm_sidebar_${id}_collapsed`);
    if (stored !== null) return stored !== '1';
  } catch {}
  return defaultOpen;
}

function setPersistedState(id: string, isOpen: boolean): void {
  try {
    localStorage.setItem(`fiberhmm_sidebar_${id}_collapsed`, isOpen ? '0' : '1');
  } catch {}
}

export function SidebarSubSection({ id, label, children, defaultOpen = false, helpText, persist = false }: Props) {
  const [isOpen, setIsOpen] = useState(() =>
    persist ? getPersistedState(id, defaultOpen) : defaultOpen
  );
  const contentId = `sidebar-subsection-${id}-content`;
  const headerId = `sidebar-subsection-${id}-header`;

  const handleToggle = useCallback(() => {
    setIsOpen(prev => {
      const next = !prev;
      if (persist) setPersistedState(id, next);
      return next;
    });
  }, [id, persist]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ subsectionId?: string }>).detail;
      if (detail?.subsectionId !== id) return;
      setIsOpen(true);
      if (persist) setPersistedState(id, true);
      window.requestAnimationFrame(() => {
        document.getElementById(headerId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
    window.addEventListener('fiberbrowser:open-sidebar-subsection', handler);
    return () => window.removeEventListener('fiberbrowser:open-sidebar-subsection', handler);
  }, [headerId, id, persist]);

  // The settings search shows only the subsections with matches, open (without changing what is remembered).
  const filter = useSettingsFilter();
  if (filter.active && !filter.subsections.has(id)) return null;
  const shown = filter.active || isOpen;

  return (
    <div className="mx-2 mt-1.5 rounded-fb-lg border border-line/70 bg-white/70 dark:border-white/10 dark:bg-white/[0.02]">
      <button
        id={headerId}
        data-tour={`sidebar-${id}`}
        onClick={filter.active ? undefined : handleToggle}
        className="w-full flex flex-nowrap items-center gap-1.5 rounded-fb-lg px-2.5 py-1.5 text-left hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors"
        style={{ minHeight: 32 }}
        aria-expanded={shown}
        aria-controls={contentId}
      >
        <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-gray-800 dark:text-gray-200">{label}</span>
        {helpText && <HelpIcon text={helpText} position="left" className="ml-0" />}
        <span
          className="text-gray-400 dark:text-gray-500 transition-transform"
          style={{ transform: shown ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          aria-hidden="true"
        >
          <ChevronDown size={10} />
        </span>
      </button>
      {shown && (
        <div id={contentId} className="space-y-2 border-t border-line/60 px-2.5 pb-2.5 pt-2 text-[12px] dark:border-white/10" role="group" aria-labelledby={headerId}>
          {children}
        </div>
      )}
    </div>
  );
}
