type TabStorage = Pick<Storage, 'getItem' | 'removeItem'>;

function isAllowedTab<T extends string>(allowedTabs: readonly T[] | ReadonlySet<T>, tab: string): tab is T {
  return Array.isArray(allowedTabs)
    ? (allowedTabs as readonly string[]).includes(tab)
    : (allowedTabs as ReadonlySet<string>).has(tab);
}

export function normalizeRequestedTab<T extends string>(
  tab: string | null | undefined,
  allowedTabs: readonly T[] | ReadonlySet<T>,
  fallback: T,
  aliases: Readonly<Record<string, T>> = {},
): T {
  if (!tab) return fallback;
  const alias = aliases[tab];
  if (alias) return alias;
  return isAllowedTab(allowedTabs, tab) ? tab : fallback;
}

export function consumeRequestedTab<T extends string>(
  storageKey: string,
  allowedTabs: readonly T[] | ReadonlySet<T>,
  fallback: T,
  options: {
    aliases?: Readonly<Record<string, T>>;
    storage?: TabStorage;
  } = {},
): T {
  if (typeof window === 'undefined' && !options.storage) return fallback;
  const storage = options.storage ?? window.sessionStorage;
  const requested = storage.getItem(storageKey);
  if (requested !== null) {
    storage.removeItem(storageKey);
  }
  return normalizeRequestedTab(requested, allowedTabs, fallback, options.aliases);
}
