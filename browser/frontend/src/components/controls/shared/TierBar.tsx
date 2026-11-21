/**
 * A share as a thin bar with up to three cumulative tiers on one track: the solid part, a lighter part up to `edge`
 * and a faint part up to `loose` (all shares 0..1). The Footprints class list's prevalence bar (exact / + one edge /
 * + other footprints) and the nucleosome panel's geometry carriers (full / + partly through a folded child) use it.
 */
export function TierBar({ value, edge, loose, color, solidColor, faded = false, title, testId = 'tier-bar', className = 'h-1.5' }: {
  value: number | null | undefined;
  edge?: number | null;
  loose?: number | null;
  color: string;
  /** The solid part's colour when it differs (an unsupported channel's grey). */
  solidColor?: string;
  /** Drawn paler (unsupported, or folded into another class). */
  faded?: boolean;
  title?: string;
  testId?: string;
  className?: string;
}) {
  const w = (v: number | null | undefined) => `${Math.min(100, 100 * Math.max(0, v ?? 0))}%`;
  return (
    <span className={`relative block w-full rounded-sm bg-gray-100 dark:bg-gray-800 ${className}`} title={title} data-testid={testId}>
      {loose != null && <span className="absolute left-0 top-0 block h-full rounded-sm" style={{ width: w(loose), backgroundColor: color, opacity: .2 }} />}
      {edge != null && <span className="absolute left-0 top-0 block h-full rounded-sm" style={{ width: w(edge), backgroundColor: color, opacity: .45 }} />}
      {value != null && <span className="absolute left-0 top-0 block h-full rounded-sm"
        style={{ width: w(value), backgroundColor: solidColor ?? color, opacity: faded ? .5 : .95 }} />}
    </span>
  );
}
