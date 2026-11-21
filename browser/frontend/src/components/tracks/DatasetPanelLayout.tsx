import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** The header never scrolls. Measure the remaining flex space for canvas-based track bodies. */
export function DatasetPanelLayout({ panelId, style, attrs, header, initialBodyHeight, children, onMouseEnter, onMouseLeave }: {
  panelId: string;
  style: CSSProperties;
  /** Extra attributes on the panel's root (full view in place: inert / aria-hidden on the hidden panels). */
  attrs?: Record<string, unknown>;
  header: ReactNode;
  initialBodyHeight: number;
  children: (height: number) => ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setMeasured(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div data-panel-id={panelId} {...attrs} className="flex min-h-0 flex-col bg-white"
      style={{ ...style, boxSizing: 'border-box', overflow: 'hidden', minHeight: 0 }}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div data-panel-header style={{ flexShrink: 0 }}>{header}</div>
      <div ref={body} data-panel-body style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0, overflow: 'hidden' }}>
        {children(Math.max(0, measured ?? initialBodyHeight))}
      </div>
    </div>
  );
}
