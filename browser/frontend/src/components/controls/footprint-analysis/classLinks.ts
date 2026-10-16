/**
 * Links a plugin pack adds to the Footprints panel's classes (a class row of a Find classes run, a saved class): small
 * buttons that open the pack's own panel at what the class sits in. Providers are
 * hooks, called in registration order (packs register before the app renders).
 */
export interface ClassLink {
  key: string;
  label: string;
  title: string;
  testId: string;
  /** Its colours (a pack's panel's). */
  className: string;
  onClick: () => void;
}

export interface ClassSpan {
  chrom: string | null | undefined; start: number; end: number;
  /** The class's own id (family) and its Find classes run, so the linked panel can point at the same class. */
  classId?: string | null; jobId?: string | null;
}

export interface ClassLinkProvider {
  /** Links of a class row of the run shown (its region's chromosome and the class's span). */
  useRowLinks?: () => (span: ClassSpan) => ClassLink[];
  /** Links of a saved class (its reference chromosome and span). */
  useSavedLinks?: () => (span: ClassSpan) => ClassLink[];
}

const providers: ClassLinkProvider[] = [];

export function registerClassLinks(provider: ClassLinkProvider): void {
  providers.push(provider);
}

const none = () => [] as ClassLink[];

/** Every provider's row links (a hook). */
export function useClassRowLinks(): (span: ClassSpan) => ClassLink[] {
  const all = providers.map(p => (p.useRowLinks ?? (() => none))());
  return span => all.flatMap(links => links(span));
}

/** Every provider's saved-class links (a hook). */
export function useSavedClassLinks(): (span: ClassSpan) => ClassLink[] {
  const all = providers.map(p => (p.useSavedLinks ?? (() => none))());
  return span => all.flatMap(links => links(span));
}
