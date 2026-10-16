import { useCallback, useEffect, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({ content, children, position = 'top', delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; transform: string; maxWidth: number } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const gap = 8;
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const maxWidth = Math.min(352, Math.max(160, viewportWidth - gap * 2));
    const horizontalCenter = (x: number) =>
      Math.max(gap + maxWidth / 2, Math.min(viewportWidth - gap - maxWidth / 2, x));
    const verticalCenter = (y: number) =>
      Math.max(gap + 12, Math.min(viewportHeight - gap - 12, y));

    const positions = {
      top: {
        left: horizontalCenter(rect.left + rect.width / 2),
        top: rect.top - gap,
        transform: 'translate(-50%, -100%)',
        maxWidth,
      },
      bottom: {
        left: horizontalCenter(rect.left + rect.width / 2),
        top: rect.bottom + gap,
        transform: 'translate(-50%, 0)',
        maxWidth,
      },
      left: {
        left: rect.left - gap,
        top: verticalCenter(rect.top + rect.height / 2),
        transform: 'translate(-100%, -50%)',
        maxWidth,
      },
      right: {
        left: rect.right + gap,
        top: verticalCenter(rect.top + rect.height / 2),
        transform: 'translate(0, -50%)',
        maxWidth,
      },
    };
    setCoords(positions[position]);
  }, [position]);

  const showTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      updatePosition();
      setVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setVisible(false);
  };

  useEffect(() => {
    if (!visible) return;

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, visible]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {visible && coords && createPortal(
        <span
          role="tooltip"
          className="fixed z-[10000] block px-2.5 py-1.5 text-[11px] leading-snug text-left text-slate-50 bg-brand-950/95 ring-1 ring-white/10 dark:bg-dark-elevated rounded-fb shadow-dropdown whitespace-normal break-words pointer-events-none"
          style={{
            left: coords.left,
            top: coords.top,
            transform: coords.transform,
            maxWidth: coords.maxWidth,
            overflowWrap: 'break-word',
          }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}

// Small help icon with tooltip
interface HelpIconProps {
  text: string;
  position?: TooltipProps['position'];
  className?: string;
}

export function HelpIcon({ text, position = 'top', className = '' }: HelpIconProps) {
  return (
    <Tooltip content={text} position={position}>
      <span
        className={`inline-flex items-center justify-center w-3.5 h-3.5 text-[11px] font-semibold text-gray-400 dark:text-gray-500 border border-gray-300 dark:border-gray-600 rounded-full cursor-help ml-1 flex-shrink-0 transition-colors hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-300 ${className}`}
        aria-label="Help"
      >
        ?
      </span>
    </Tooltip>
  );
}
