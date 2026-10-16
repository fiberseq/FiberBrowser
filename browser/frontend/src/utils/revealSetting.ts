/**
 * Show a setting where it lives and highlight it for a moment: the settings
 * sidebar opened at its section and subsection (and any "Advanced" fold
 * around it), the read toolbar's group opened, or the control in the window
 * chrome. Used by the command palette and the settings search.
 */
import { useBrowserStore } from '../stores/browserStore';
import { setToolbarGroupOpenState } from '../components/controls/ToolbarGroups';
import type { SettingDef } from './settingsCatalog';
import { setSettingsSearchQuery, useSettingsSearchStore } from './settingsSearchStore';
import { computeSettingsFilter } from '../components/controls/sidebar/settingsFilter';

export const SETTING_FLASH_CLASS = 'fb-setting-flash';
const FLASH_MS = 1800;
const WAIT_MS = 2000;

/** Highlight an element briefly (the class's outline fades out; see index.css). */
export function flashElement(el: Element): void {
  el.classList.remove(SETTING_FLASH_CLASS);
  // Restart the animation when flashed twice in a row.
  void (el as HTMLElement).offsetWidth;
  el.classList.add(SETTING_FLASH_CLASS);
  window.setTimeout(() => el.classList.remove(SETTING_FLASH_CLASS), FLASH_MS);
}

/**
 * Really on show: not inside a closed fold's hidden part, not display:none (a
 * folded toolbar group's hover card). Without layout (jsdom) the attributes decide.
 */
function isOnShow(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  // A setting inside a closed <details> is shown by opening it: count it.
  const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check !== 'function') return true;
  if (check.call(el)) return true;
  const details = el.closest('details');
  return Boolean(details && !details.open && (details.checkVisibility?.() ?? true));
}

/** The first element matching `selector` once it is on show (polled: sections mount after a render). */
function waitFor(selector: string, root: () => ParentNode | null, timeoutMs = WAIT_MS): Promise<HTMLElement | null> {
  const started = Date.now();
  return new Promise(resolve => {
    const look = () => {
      // The page has gone (a closed window; a test environment torn down while a reveal was still polling).
      if (typeof document === 'undefined') { resolve(null); return; }
      const scope = root();
      const found = scope ? Array.from(scope.querySelectorAll<HTMLElement>(selector)).find(isOnShow) : null;
      if (found) { resolve(found); return; }
      if (Date.now() - started >= timeoutMs) { resolve(null); return; }
      window.setTimeout(look, 40);
    };
    look();
  });
}

/** The control last shown (marked until the next one, for tests and assistive checks). */
const REVEALED_ATTR = 'data-setting-revealed';

function show(el: HTMLElement, focus: boolean): void {
  document.querySelectorAll(`[${REVEALED_ATTR}]`).forEach(other => other.removeAttribute(REVEALED_ATTR));
  el.setAttribute(REVEALED_ATTR, '');
  // A setting inside a closed fold ("Exact limits", "Advanced: older files and caching").
  for (let details = el.closest('details'); details; details = details.parentElement?.closest('details') ?? null) {
    details.open = true;
  }
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  flashElement(el);
  if (focus) {
    const control = el.matches('input, select, textarea, button')
      ? el
      : el.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    control?.focus({ preventScroll: true });
  }
}

const sidebarRoot = () => document.querySelector('[data-testid="settings-sidebar"]');
const escapeId = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"'));

/** Show and highlight a setting. Resolves true when its control was found. */
export async function revealSetting(setting: SettingDef, { focus = true }: { focus?: boolean } = {}): Promise<boolean> {
  const where = setting.location;
  if (where.kind === 'sidebar') {
    // The sidebar's search field may be filtering it out.
    const { query } = useSettingsSearchStore.getState();
    if (query && !computeSettingsFilter(query).shownIds.has(setting.id)) setSettingsSearchQuery('');
    const s = useBrowserStore.getState();
    s.setSidebarOpen(true);
    // Opens the section and the subsection (components/controls/Sidebar).
    window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: where.section, subsectionId: where.subsection },
    }));
    const el = await waitFor(`[data-setting-id="${escapeId(setting.id)}"]`, sidebarRoot);
    if (el) { show(el, focus); return true; }
    if (typeof document === 'undefined') return false;   // the page went while it looked
    // Not on show now (e.g. needs a BAM): point at its subsection or section instead.
    const header = document.getElementById(where.subsection ? `sidebar-subsection-${where.subsection}-header` : `sidebar-section-${where.section}-header`);
    if (header) { header.scrollIntoView?.({ block: 'center' }); flashElement(header); }
    return false;
  }
  if (where.kind === 'toolbar') {
    setToolbarGroupOpenState(where.group, true);
    const el = await waitFor(where.selector, () => document.querySelector('[data-testid="operations-toolbar"]'), 800);
    if (el) { show(el, focus); return true; }
    // The group is in the More menu (narrow window) or the control is off now: point at the group or More.
    const fallback = document.querySelector<HTMLElement>(`[data-testid="toolbar-group-${where.group}"]`)
      ?? document.querySelector<HTMLElement>('[data-testid="toolbar-groups-more"]');
    if (fallback) flashElement(fallback);
    return false;
  }
  if (where.selector) {
    const el = await waitFor(where.selector, () => document, 500);
    if (el) { show(el, false); return true; }
  }
  return false;
}
