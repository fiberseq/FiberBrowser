import { loadDafc } from '../api/dafc';
import { useBrowserStore } from '../stores/browserStore';
import { useDafcStore } from '../stores/dafcStore';
import { messageFromError } from './fileLoadErrors';

const VIEW_PAD_BP = 50000;
const FALLBACK_VIEW_BP = 500000;
const TARGET_BINS = 800;

const bareChrom = (name: string) => name.replace(/^chr/i, '');

/** Finest resolution that keeps the view at or under ~TARGET_BINS bins. */
export function pickContactResolution(resolutions: number[], viewSize: number): number {
  const sorted = [...resolutions].sort((a, b) => a - b);
  const ideal = viewSize / TARGET_BINS;
  return sorted.find(res => res >= ideal) ?? sorted[sorted.length - 1] ?? 10000;
}

export function contactMapErrorMessage(message: string): string {
  return /cooler not installed/i.test(message)
    ? 'Contact maps need the optional cooler package. Install it with: pip install cooler h5py'
    : message;
}

/**
 * Load a .cool/.mcool file, frame the contact view on the current browser
 * region, and open the Contacts panel. Shared by every file-loading entry
 * point so they behave identically.
 */
export async function loadContactMapFile(path: string): Promise<{ success: boolean; error?: string }> {
  let result: Awaited<ReturnType<typeof loadDafc>>;
  try {
    result = await loadDafc(path);
  } catch (error) {
    return { success: false, error: contactMapErrorMessage(messageFromError(error, 'Failed to load contact map')) };
  }
  if (!result.success) {
    return { success: false, error: contactMapErrorMessage(result.error || 'Failed to load contact map') };
  }

  const dafcStore = useDafcStore.getState();
  dafcStore.setDafcLoaded(true);
  dafcStore.bumpDafcLoadGeneration();
  dafcStore.setDafcResolutions(result.resolutions);
  if (result.chroms?.length) {
    const { chrom, start, end } = useBrowserStore.getState();
    // Contact files and the browser often disagree on the "chr" prefix.
    const chromInfo = result.chroms.find(c => c.name === chrom)
      ?? result.chroms.find(c => bareChrom(c.name) === bareChrom(chrom));
    if (chromInfo && end > start) {
      const viewStart = Math.max(0, start - VIEW_PAD_BP);
      const viewEnd = Math.min(chromInfo.size, end + VIEW_PAD_BP);
      dafcStore.setDafcViewport(chromInfo.name, viewStart, viewEnd);
      dafcStore.setDafcResolution(pickContactResolution(result.resolutions, viewEnd - viewStart));
    } else {
      const first = result.chroms[0];
      const viewEnd = Math.min(first.size, FALLBACK_VIEW_BP);
      dafcStore.setDafcViewport(first.name, 0, viewEnd);
      dafcStore.setDafcResolution(pickContactResolution(result.resolutions, viewEnd));
    }
  }
  useBrowserStore.getState().openAnalysisPanel('contact-map');
  return { success: true };
}
