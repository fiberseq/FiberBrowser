/**
 * What the internal plugin packs of this build registered (plugins/packs.ts loads them; ARCHITECTURE.md).
 *
 * No imports on purpose: the core registries call `declareContribution` while a pack registers, so a session can say
 * which of its parts a pack wrote, and a build without that pack can leave those parts out (api/session.ts).
 */

export interface FiberBrowserPack {
  /** Its id ("lab"): the server pack's too (browser/<folder>/fiberbrowser-pack.json). */
  name: string;
  /** Shown in About, and in the note a build without it gives when a session needs it. */
  label: string;
  /** The build flavour it makes ("lab"); a build without packs is "public". */
  flavor: string;
  register: () => void;
}

/** What a pack contributed (recorded while it registered). */
export interface PackDeclaration {
  name: string;
  label: string;
  /** Analysis panel types (and their old names). */
  panels: string[];
  /** Per-panel track (row) types. */
  tracks: string[];
  /** Feature kinds (the selection store). */
  features: string[];
  /** Fields it keeps on PanelConfig. */
  panelFields: string[];
  /** Panel fields that make a panel the pack's own (a dataset panel of a dataset it built): a build without the pack
   *  leaves such a panel out whole, not just the field. */
  panelOwners: string[];
  /** Browser-store keys its store extensions save with sessions. */
  stateKeys: string[];
}

export type ContributionKind = keyof Omit<PackDeclaration, 'name' | 'label'>;

const packs: FiberBrowserPack[] = [];
const declarations = new Map<string, PackDeclaration>();
let current: PackDeclaration | null = null;
/** What core registered (outside any pack's register()): a session part a missing pack wrote that this build also has
 * (a feature that graduated from the pack to core) is restored, not left out. */
const core: Record<ContributionKind, Set<string>> = {
  panels: new Set(), tracks: new Set(), features: new Set(), panelFields: new Set(), panelOwners: new Set(), stateKeys: new Set(),
};

/** Register one pack (plugins/packs.ts calls this for each pack of the build). */
export function registerPack(pack: FiberBrowserPack): boolean {
  if (declarations.has(pack.name)) return true;
  const decl: PackDeclaration = { name: pack.name, label: pack.label, panels: [], tracks: [], features: [], panelFields: [], panelOwners: [], stateKeys: [] };
  declarations.set(pack.name, decl);
  current = decl;
  try {
    pack.register();
    packs.push(pack);
    return true;
  } catch (error) {
    console.error(`[packs] ${pack.name} failed to register`, error);
    declarations.delete(pack.name);
    return false;
  } finally {
    current = null;
  }
}

/** The packs this build registered. */
export function loadedPacks(): FiberBrowserPack[] {
  return packs.slice();
}

/** "lab" in a build with the lab pack, else "public". */
export function buildFlavor(): string {
  return packs[0]?.flavor ?? 'public';
}

/** What each registered pack contributed. */
export function packDeclarations(): PackDeclaration[] {
  return [...declarations.values()];
}

/**
 * Note a contribution of the pack registering now (outside a pack's register(): core's own). The core registries call
 * this; a pack (or a core module) calls it itself for the fields it keeps on PanelConfig.
 */
export function declareContribution(kind: ContributionKind, id: string): void {
  if (!current) core[kind].add(id);
  else if (!current[kind].includes(id)) current[kind].push(id);
}

/** Whether this build has a contribution: core's, or a registered pack's. */
export function hasContribution(kind: ContributionKind, id: string): boolean {
  if (core[kind].has(id)) return true;
  for (const decl of declarations.values()) if (decl[kind].includes(id)) return true;
  return false;
}

/** The pack registering now (null outside register()). */
export function registeringPack(): string | null {
  return current?.name ?? null;
}
