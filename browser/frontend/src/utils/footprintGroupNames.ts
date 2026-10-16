/** Name a saved size range: "≥90 bp @ fp1" or "35–80 bp @ fp1". */
export function sizeRangeName(min: number, max: number | null, suffix?: string | null): string {
  const range = max == null ? `≥${min} bp` : `${min}–${max} bp`;
  return suffix ? `${range} @ ${suffix}` : range;
}

/** The "@ fp1"-style suffix of an automatic name, if any. */
export function autoNameSuffix(name: string): string | null {
  const at = name.lastIndexOf(' @ ');
  return at >= 0 ? name.slice(at + 3) : null;
}
