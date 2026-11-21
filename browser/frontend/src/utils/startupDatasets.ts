/**
 * Whether the startup dataset list (fetched at mount) may replace the store's datasets once it arrives.
 * A session restore or dataset add that won the startup race holds datasets of its own and must not be overwritten;
 * a metadata refresh that only re-mapped the still-empty list (e.g. the hub refreshing layers) does not count.
 */
export function startupDatasetsApply<T>(atStartup: readonly T[], now: readonly T[]): boolean {
  return now === atStartup || now.length === 0;
}
