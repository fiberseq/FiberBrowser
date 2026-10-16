/**
 * While Settings › Show preview features is off, a Preview panel has no tile
 * in the rail, so the user doesn't know it exists. In its place at the end of the launchers, one dashed tile says so
 * ("Variants is a Preview feature · Turn on"); Not now, or turning previews on, removes it for good (this computer).
 * A tile in the rail's own list, not a note over the reads: it never covers a panel.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAllAnalysisPanels, getAnalysisPanelLabel } from '../../plugins/registry';
import { getPreviewFeature, setPreviewsEnabled, usePreviewsEnabled } from '../../utils/previewFeatures';
import { PanelIcon } from '../ui/panelIcons';
import { isPublicServerPage } from '../../utils/publicServerFlag';

export const PREVIEW_HINT_KEY = 'fiberbrowser_preview_hint_seen';

function hintSeen(): boolean {
  try { return localStorage.getItem(PREVIEW_HINT_KEY) === '1'; } catch { return true; }
}

/** The first Preview panel the rail leaves out now (null: none). */
export function hiddenPreviewPanel(): { contentType: string; label: string; feature: string } | null {
  const plugin = getAllAnalysisPanels().find(p => p.preview && !(isPublicServerPage() && p.hostOnly));
  return plugin ? { contentType: plugin.contentType, label: getAnalysisPanelLabel(plugin.contentType, true), feature: plugin.preview! } : null;
}

export function PreviewRailHint() {
  const previews = usePreviewsEnabled();
  const [seen, setSeen] = useState(hintSeen);
  const [open, setOpen] = useState(false);
  const tileRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const panel = previews || seen ? null : hiddenPreviewPanel();

  const finish = () => {
    try { localStorage.setItem(PREVIEW_HINT_KEY, '1'); } catch { /* per-viewer */ }
    setSeen(true);
    setOpen(false);
  };
  useLayoutEffect(() => { if (open && tileRef.current) setRect(tileRef.current.getBoundingClientRect()); }, [open]);
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      tileRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !tileRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [open]);

  if (!panel) return null;
  const text = `${panel.label} is a Preview feature`;
  const summary = getPreviewFeature(panel.feature)?.summary;
  return (
    <div className="flex w-full flex-col items-center">
      <div className="my-1 h-px w-4 bg-line dark:bg-white/10" aria-hidden="true" />
      <button ref={tileRef} type="button" data-testid="preview-rail-hint" data-preview={panel.feature}
        aria-label={`${text}: turn on`} aria-haspopup="dialog" aria-expanded={open}
        title={`${text} · Click to turn on`}
        onClick={() => setOpen(v => !v)}
        className="fb-rail-tile">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] border border-dashed border-amber-500/80 text-amber-700 opacity-80 hover:opacity-100 dark:border-amber-400/70 dark:text-amber-200">
          <PanelIcon contentType={panel.contentType} size={14} />
        </span>
        <span className="fb-rail-tile-preview" aria-hidden="true">P</span>
      </button>
      {open && rect && createPortal(
        <div ref={popRef} role="dialog" aria-label={text} data-testid="preview-rail-hint-popover"
          className="fixed z-[70] w-[240px] rounded-fb-lg border border-line bg-white px-3 py-2 text-[12px] text-ink shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:text-gray-100 dark:shadow-dropdown-dark"
          style={{ top: Math.max(8, Math.min(window.innerHeight - 160, rect.top - 6)), right: Math.max(8, window.innerWidth - rect.left + 10) }}>
          <div className="font-semibold">{text}</div>
          {summary && <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary dark:text-gray-300">{summary}</div>}
          <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary dark:text-gray-300">Off now: Settings › Show preview features.</div>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button type="button" data-testid="preview-rail-hint-dismiss" onClick={finish}
              className="rounded-fb px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10">Not now</button>
            <button type="button" data-testid="preview-rail-hint-turn-on" onClick={() => { setPreviewsEnabled(true); finish(); }}
              className="rounded-fb bg-blue-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-blue-700">Turn on</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
