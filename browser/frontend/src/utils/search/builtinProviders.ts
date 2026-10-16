/**
 * The app's search providers, registered once: coordinates and genes, saved
 * regions, read names. Import this module where suggestions are shown (the
 * locus boxes, the command palette).
 */
import { registerSearchProvider } from './providers';
import { geneProvider, locusProvider } from './locusProviders';
import { regionSearchProvider } from './regionProvider';
import { readNameProvider } from './readProvider';

export const BUILTIN_SEARCH_PROVIDERS = [locusProvider, geneProvider, regionSearchProvider, readNameProvider] as const;

let registered = false;

/** Register the built-in providers (once; the module does it on import). */
export function registerBuiltinSearchProviders(): void {
  if (registered) return;
  registered = true;
  for (const provider of BUILTIN_SEARCH_PROVIDERS) registerSearchProvider(provider);
}

registerBuiltinSearchProviders();
