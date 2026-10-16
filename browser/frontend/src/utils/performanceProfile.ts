import { useSyncExternalStore } from 'react';

export type BrowserPerformanceTier = 'low' | 'standard' | 'high';
export type PerformanceMode = 'auto' | BrowserPerformanceTier;
export const PERFORMANCE_MODE_LABELS: Record<PerformanceMode, string> = {
  auto: 'Auto', low: 'Low memory', standard: 'Standard', high: 'High performance',
};

/** Explain the population used by a capped analysis, with its denominator. */
export function performanceSamplingNote(results: Record<string, {
  performance_sampling?: { used: number; total: number };
  preparation_sampling?: import('../types').ClusterPreparationSample;
}>): string {
  const prepared = Object.values(results).flatMap(result => result.preparation_sampling ? [result.preparation_sampling] : []);
  let preparationNote = '';
  if (prepared.length) {
    const sum = (key: 'selected_names' | 'prepared_reads' | 'used' | 'total_alignments') =>
      prepared.reduce((n, sample) => n + sample[key], 0).toLocaleString();
    preparationNote = `Sampled clustering: selected ${sum('selected_names')} read names, prepared ${sum('prepared_reads')} fibers and clustered ${sum('used')} after filters. The regions contain ${sum('total_alignments')} alignments before filters. Choose All reads beside Cluster for a full-cohort run.`;
  }
  const samples = Object.values(results).flatMap(result => result.performance_sampling ? [result.performance_sampling] : []);
  if (!samples.length) return preparationNote;
  const used = samples.reduce((n, sample) => n + sample.used, 0);
  const total = samples.reduce((n, sample) => n + sample.total, 0);
  return (preparationNote ? preparationNote + ' ' : '') + `Low memory used ${used.toLocaleString()} of ${total.toLocaleString()} reads in the requested regions (total before read and peak filters). Choose Standard or High performance for full working sets.`;
}

export interface BrowserHardwareHints {
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  userAgent?: string | null;
}

export interface BrowserPerformanceProfile {
  tier: BrowserPerformanceTier;
  interactiveCanvasScale: number;
  defaultAllReadsDisplayCap: number;
  defaultBackgroundReadCap: number;
  defaultMaxRegionForReads: number;
  useGpuPanTransforms: boolean;
  useContentVisibility: boolean;
  maxPromotedCanvases: number;
  activeOrthogonalTrackSoftCap: number;
  reasons: string[];
}

function finitePositive(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function isSafariUserAgent(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? '';
  return /Safari/i.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android)/i.test(ua);
}

function isAutomatedDomUserAgent(userAgent: string | null | undefined): boolean {
  return /(jsdom|happy-dom)/i.test(userAgent ?? '');
}

export function collectBrowserHardwareHints(): BrowserHardwareHints {
  if (typeof navigator === 'undefined') {
    return {};
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    hardwareConcurrency: finitePositive(nav.hardwareConcurrency),
    deviceMemory: finitePositive(nav.deviceMemory),
    userAgent: nav.userAgent,
  };
}

export function inferBrowserPerformanceProfile(
  hints: BrowserHardwareHints = collectBrowserHardwareHints(),
): BrowserPerformanceProfile {
  const cores = finitePositive(hints.hardwareConcurrency);
  const memory = finitePositive(hints.deviceMemory);
  const safari = isSafariUserAgent(hints.userAgent);
  const automatedDom = isAutomatedDomUserAgent(hints.userAgent);
  const reasons: string[] = [];

  if (automatedDom) {
    return {
      tier: 'standard',
      interactiveCanvasScale: 2,
      defaultAllReadsDisplayCap: 2_000,
      defaultBackgroundReadCap: 1_000,
      defaultMaxRegionForReads: 100_000,
      useGpuPanTransforms: true,
      useContentVisibility: true,
      maxPromotedCanvases: 64,
      activeOrthogonalTrackSoftCap: 64,
      reasons: ['automated-dom'],
    };
  }

  const cpuConstrained = cores != null && cores <= 4;
  const tinyMemoryCpu = memory != null && memory <= 4 && (cores == null || cores <= 6);

  if (cpuConstrained) reasons.push(`cpu<=4 (${cores})`);
  if (tinyMemoryCpu) reasons.push(`memory<=4GB (${memory})`);
  if (tinyMemoryCpu && !cpuConstrained) {
    reasons.push(`thin-client (${cores ?? 'unknown'} cores, ${memory}GB)`);
  }
  if (safari && (cores == null || cores <= 8)) {
    reasons.push(`safari-low-power (${cores ?? 'unknown'} cores)`);
  }

  const tier: BrowserPerformanceTier = reasons.length > 0
    ? 'low'
    : (cores != null && cores >= 12 && !safari ? 'high' : 'standard');

  if (tier === 'low') {
    return {
      tier,
      interactiveCanvasScale: 1,
      defaultAllReadsDisplayCap: 1_000,
      defaultBackgroundReadCap: 500,
      defaultMaxRegionForReads: 50_000,
      useGpuPanTransforms: false,
      useContentVisibility: false,
      maxPromotedCanvases: 12,
      activeOrthogonalTrackSoftCap: 24,
      reasons,
    };
  }

  if (tier === 'high') {
    return {
      tier,
      interactiveCanvasScale: 2,
      defaultAllReadsDisplayCap: 2_000,
      defaultBackgroundReadCap: 1_000,
      defaultMaxRegionForReads: 100_000,
      useGpuPanTransforms: true,
      useContentVisibility: true,
      maxPromotedCanvases: 96,
      activeOrthogonalTrackSoftCap: 128,
      reasons: cores != null ? [`cpu>=12 (${cores})`] : [],
    };
  }

  return {
    tier,
    interactiveCanvasScale: 2,
    defaultAllReadsDisplayCap: 2_000,
    defaultBackgroundReadCap: 1_000,
    defaultMaxRegionForReads: 100_000,
    useGpuPanTransforms: true,
    useContentVisibility: !safari,
    maxPromotedCanvases: 64,
    activeOrthogonalTrackSoftCap: 64,
    reasons: safari ? ['safari-content-visibility-off'] : [],
  };
}

let cachedProfile: BrowserPerformanceProfile | null = null;
let runtimeMode: PerformanceMode = 'auto';
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useBrowserPerformanceProfile(): BrowserPerformanceProfile {
  return useSyncExternalStore(subscribe, getBrowserPerformanceProfile, getBrowserPerformanceProfile);
}

/** Apply the server's effective machine mode to every browser consumer. */
export function applyBrowserPerformanceMode(mode: PerformanceMode, tier: BrowserPerformanceTier): BrowserPerformanceProfile {
  runtimeMode = mode;
  const profile = inferBrowserPerformanceProfile({ hardwareConcurrency: tier === 'low' ? 4 : tier === 'high' ? 16 : 8 });
  cachedProfile = { ...profile, reasons: [mode === 'auto' ? 'automatic machine settings' : 'Settings'],
    useContentVisibility: profile.useContentVisibility && !isSafariUserAgent(collectBrowserHardwareHints().userAgent) };
  listeners.forEach(listener => listener());
  return cachedProfile;
}

export function performanceModeTitle(): string {
  const label = PERFORMANCE_MODE_LABELS[getBrowserPerformanceProfile().tier];
  return `Performance mode: ${runtimeMode === 'auto' ? `Auto (${label})` : label}.`;
}

export function getBrowserPerformanceProfile(): BrowserPerformanceProfile {
  if (!cachedProfile) cachedProfile = inferBrowserPerformanceProfile();
  return cachedProfile;
}

export function resetBrowserPerformanceProfileForTests(): void {
  cachedProfile = null;
  runtimeMode = 'auto';
}

export function shouldUseGpuPanTransforms(): boolean {
  return getBrowserPerformanceProfile().useGpuPanTransforms;
}

export function shouldUseContentVisibility(): boolean {
  return getBrowserPerformanceProfile().useContentVisibility;
}
