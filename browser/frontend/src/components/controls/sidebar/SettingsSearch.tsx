import { useRef } from 'react';
import { Search, X } from '../../ui/Icons';
import { setSettingsSearchQuery, useSettingsSearchStore } from '../../../utils/settingsSearchStore';
import { openCommandPalette } from '../../../utils/commandPaletteStore';
import { revealSetting } from '../../../utils/revealSetting';
import { settingPath } from '../../../utils/settingsCatalog';
import { useSettingsFilter } from './settingsFilter';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/**
 * The search field at the top of the settings sidebar: typing filters the
 * sections and settings live. Matches that live elsewhere (the toolbar, the
 * top bar) or are not on show now are listed under it, each with Show.
 */
export function SettingsSearchField() {
  const query = useSettingsSearchStore(s => s.query);
  const filter = useSettingsFilter();
  const inputRef = useRef<HTMLInputElement>(null);
  const elsewhere = filter.matches.filter(s => s.location.kind !== 'sidebar' || s.hiddenReason?.());
  const inSidebar = filter.matches.filter(s => s.location.kind === 'sidebar' && !s.hiddenReason?.());
  const nothing = filter.active && filter.matches.length === 0 && filter.sections.size === 0;

  return (
    <div className="px-2.5 pb-2 pt-1.5" data-testid="settings-search">
      <div className="relative flex items-center">
        <Search size={13} className="pointer-events-none absolute left-2 text-ink-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={e => setSettingsSearchQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              setSettingsSearchQuery('');
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const best = filter.matches[0];
              if (best) void revealSetting(best);
              else if (query.trim()) openCommandPalette(query);
            }
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-describedby="settings-search-summary"
          className="h-7 w-full rounded-fb border border-line bg-white pl-7 pr-7 text-[12px] text-ink placeholder:text-ink-muted focus:border-brand-500 focus:outline-none focus:shadow-focus dark:border-white/15 dark:bg-white/5 dark:text-gray-100 [&::-webkit-search-cancel-button]:hidden"
          data-testid="settings-search-input"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setSettingsSearchQuery(''); inputRef.current?.focus(); }}
            className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/10 dark:hover:text-gray-200"
            aria-label="Clear the settings search"
          >
            <X size={11} />
          </button>
        )}
      </div>

      <div id="settings-search-summary" role="status" aria-live="polite" className="text-[11px] text-ink-muted">
        {filter.active && !nothing && (
          <div className="pt-1" data-testid="settings-search-count">
            {inSidebar.length === 1 ? '1 setting' : `${inSidebar.length} settings`} below
            {elsewhere.length > 0 && `, ${elsewhere.length} elsewhere`}
          </div>
        )}
        {nothing && (
          <div className="pt-1.5" data-testid="settings-search-empty">
            No settings match “{query.trim()}”.{' '}
            <button
              type="button"
              onClick={() => openCommandPalette(query)}
              className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
              data-testid="settings-search-try-palette"
            >
              Try the command palette ({isMac ? '\u2318K' : 'Ctrl+K'})
            </button>
          </div>
        )}
      </div>

      {elsewhere.length > 0 && (
        <ul className="mt-1 space-y-0.5" aria-label="Matching settings elsewhere" data-testid="settings-search-elsewhere">
          {elsewhere.slice(0, 8).map(setting => (
            <li key={setting.id} className="flex items-center gap-1.5 rounded-fb px-1.5 py-1 text-[11.5px] hover:bg-gray-100/70 dark:hover:bg-white/5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-gray-800 dark:text-gray-200">{setting.label}</span>
                <span className="block truncate text-[11px] text-ink-muted">{setting.hiddenReason?.() ?? settingPath(setting)}</span>
              </span>
              <button
                type="button"
                onClick={() => void revealSetting(setting)}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-600/10 dark:text-brand-300 dark:hover:bg-brand-400/15"
              >
                Show
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
