// Window colours are independent of the read-cluster palette.
const windowColors = ['#6366f1', '#c026d3', '#0284c7', '#b45309', '#64748b', '#be123c'];
export interface WindowIdentity { label: string; color: string }
/** Keep a window's identity when the template changes or another window is dropped. */
export function windowIdentity(index: number): WindowIdentity {
  return { label: `W${index + 1}`, color: windowColors[index % windowColors.length] };
}
/** A short window label with its independent colour swatch. */
export function WindowBadge({ identity }: { identity: WindowIdentity }) {
  return <span className="inline-flex items-center gap-1 whitespace-nowrap"><span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: identity.color }} />{identity.label}</span>;
}
export const formatNumber = (value: number) => value.toLocaleString('en-US');
export const formatInterval = (w: { chrom: string; start: number; end: number }) => `${w.chrom}:${formatNumber(w.start)}–${formatNumber(w.end)}`;
