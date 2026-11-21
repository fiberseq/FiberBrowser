/**
 * The nucleosome panel's small charts: inline SVG, drawn in currentColor or the observation's colour so they read in
 * light and dark mode.
 */
import { useRef, type ReactNode } from 'react';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';

/** A chart with the save control every panel's charts have (PNG / SVG / PDF, and its data as TSV): hover shows it. */
export function ChartBox({ children, filename, dataTsv, className = '', testId }: {
  children: ReactNode; filename: string; dataTsv?: string | (() => string); className?: string; testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  return <div ref={box} className={`group relative ${className}`} data-testid={testId}>
    {children}
    <ChartSaveButton getSvg={() => box.current?.querySelector('svg') ?? null} filename={filename} dataTsv={dataTsv} />
  </div>;
}

export function fmt(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}
