import type { CompactRead } from './types';
import { liveLiftBodySpans } from './liveLiftCanvas';

/** View-relative body extent. Lifted calls can omit uncalled terminal bases;
 * tooltips, outlines and read actions must follow the body drawn on this genome. */
export function readBodyExtent(read: CompactRead): { lo: number; hi: number } | null {
  const spans = read.live_lift ? liveLiftBodySpans(read.live_lift) : read.intervals;
  if (!spans.length) return null;
  return { lo: Math.min(...spans.map(s => s[0])), hi: Math.max(...spans.map(s => s[1])) };
}
