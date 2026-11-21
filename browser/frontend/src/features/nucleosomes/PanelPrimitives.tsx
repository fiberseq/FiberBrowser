import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Portalled so help and menus remain readable at the edges of a narrow analysis panel. */
function Popover({ label, trigger, children, menu = false }: { label: string; trigger: string; children: ReactNode; menu?: boolean }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setAt(null); button.current?.focus(); };
  useEffect(() => {
    if (!at) return;
    if (menu) body.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    else body.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const outside = (e: PointerEvent) => { if (!body.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setAt(null); };
    const scroll = () => setAt(null);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', scroll);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', scroll); };
  }, [at]);
  return <>
    <button ref={button} type="button" aria-label={label} aria-expanded={Boolean(at)} aria-controls={at ? id : undefined}
      aria-haspopup={menu ? 'menu' : 'dialog'} className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-ink-muted hover:bg-gray-100 hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald-500 dark:hover:bg-white/10"
      onClick={() => { const r = button.current!.getBoundingClientRect(); setAt(at ? null : { left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: r.bottom + 4 }); }}>{trigger}</button>
    {at && createPortal(<div ref={body} id={id} tabIndex={-1} role={menu ? 'menu' : 'dialog'} aria-label={label}
      className="fixed z-[1000] w-80 max-w-[calc(100vw-16px)] overflow-auto rounded-fb border border-line bg-surface p-3 text-xs leading-relaxed text-ink shadow-xl dark:border-white/10 dark:bg-surface-dark"
      style={{ left: at.left, top: Math.min(at.top, window.innerHeight * 0.6), maxHeight: '38vh' }}
      onClick={e => { if (menu && (e.target as HTMLElement).closest('[role=menuitem]')) close(); }}>
      {children}
      {!menu && <button type="button" className="mt-2 block text-ink-secondary underline" onClick={close}>Close</button>}
    </div>, document.body)}
  </>;
}

export function Info({ label, children }: { label: string; children: ReactNode }) {
  return <Popover label={`About ${label}`} trigger="ⓘ">{children}</Popover>;
}

export function MetricTitle({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mb-1 flex items-center gap-1 font-medium text-ink-secondary">{title}<Info label={title}>{children}</Info></div>;
}

