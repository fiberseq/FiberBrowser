/** Download sizes and the size warning (services/http_download.py): no cap, but a download over the warning
 *  size (Settings → App → Download warning size; default 4 GB) asks first. Sizes are decimal (1 GB = 10^9
 *  bytes), as the server states the threshold. */
export interface LargeDownloadInfo {
  url?: string | null;
  bytes: number;
  threshold: number;
}

export function formatDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function largeDownloadQuestion(name: string, info: LargeDownloadInfo): string {
  let host = '';
  try { host = info.url ? ` from ${new URL(info.url).host}` : ''; } catch { host = ''; }
  return `${name} is ${formatDownloadSize(info.bytes)} to download${host}, over the `
    + `${formatDownloadSize(info.threshold)} download warning size (Settings → App). Download it?`;
}

/** Ask before a download over the warning size (true: go ahead). */
export function confirmLargeDownload(name: string, info: LargeDownloadInfo): boolean {
  return typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? window.confirm(largeDownloadQuestion(name, info))
    : false;
}
