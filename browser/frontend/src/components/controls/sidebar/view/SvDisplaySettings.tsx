import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { defineSettings, inSidebar, settingAnchor, settingGroupAnchor, storeToggle, type SettingDef } from '../../../../utils/settingsCatalog';
import { SV_MIN_LEN_HIGHEST, SV_MIN_LEN_LOWEST } from '../../../tracks/read-track/svDrawing';

const hasBam = () => useBrowserStore.getState().datasets.some(dataset => dataset.data_type === 'bam');
const shownWithBam = () => (hasBam() ? null : 'shown with a BAM loaded');

export const SV_SETTINGS = defineSettings({
  enabled: {
    id: 'view.sv-display',
    label: 'SV display',
    keywords: ['structural variants', 'sv', 'deletion', 'insertion', 'indel', 'large indels', 'split reads',
      'clips', 'soft clip', 'breakpoints', 'alleles', 'summary track', 'sv track', 'sv clusters', 'arcs', 'junction'],
    location: inSidebar('view.advanced'),
    toggle: storeToggle('svDisplayEnabled', 'setSvDisplayEnabled'),
    hiddenReason: shownWithBam,
  },
  minLen: {
    id: 'view.sv-min-size',
    label: 'Min SV size (bp)',
    keywords: ['structural variants', 'sv threshold', 'minimum deletion', 'minimum insertion', 'indel size', 'min_sv_len'],
    location: inSidebar('view.advanced'),
    hiddenReason: () => shownWithBam() ?? (useBrowserStore.getState().svDisplayEnabled ? null : 'shown when SV display is on'),
  },
  minSupport: {
    id: 'view.sv-min-support',
    label: 'Min SV supporting reads',
    keywords: ['structural variants', 'sv support', 'weak calls', 'single read', 'minimum carriers'],
    location: inSidebar('view.advanced'),
    hiddenReason: () => shownWithBam() ?? (useBrowserStore.getState().svDisplayEnabled ? null : 'shown when SV display is on'),
  },
}) satisfies Record<string, SettingDef>;
// The "SV summary track" switch is retired (fb-n11-tracks): the SV track is a row of each dataset panel,
// resized, removed and restored like the others (the panel's Tracks button); a saved collapse opens it small.

/**
 * Size-aware indels (fb-n9-sv): deletions and insertions of at least the min
 * size break the read body / get a sized flag, with the SV summary band
 * above each panel's reads. The CIGAR toggles below stay for small indels.
 */
export function SvDisplaySettings() {
  const { datasets, enabled, setEnabled, minLen, setMinLen, minSupport, setMinSupport } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    enabled: s.svDisplayEnabled, setEnabled: s.setSvDisplayEnabled,
    minLen: s.svMinLen, setMinLen: s.setSvMinLen,
    minSupport: s.svMinSupport, setMinSupport: s.setSvMinSupport,
  })));
  const [local, setLocal] = useState(String(minLen));
  const [support, setSupport] = useState(String(minSupport));
  useEffect(() => setLocal(String(minLen)), [minLen]);
  useEffect(() => setSupport(String(minSupport)), [minSupport]);
  if (!datasets.some(dataset => dataset.data_type === 'bam')) return null;
  const commit = () => {
    const parsed = parseInt(local, 10);
    setMinLen(Number.isFinite(parsed) ? parsed : minLen);
    setLocal(String(useBrowserStore.getState().svMinLen));
  };
  const commitSupport = () => {
    const parsed = parseInt(support, 10);
    setMinSupport(Number.isFinite(parsed) ? parsed : minSupport);
    setSupport(String(useBrowserStore.getState().svMinSupport));
  };
  return (
    <div className="pt-1" {...settingGroupAnchor(SV_SETTINGS.enabled, SV_SETTINGS.minLen, SV_SETTINGS.minSupport)} data-testid="sv-display-settings">
      <div className="text-[11px] text-ink-secondary font-medium mb-0.5">Structural variants</div>
      <label
        className="flex items-center gap-1.5 text-[13px] cursor-pointer"
        title="Deletions break the read (nothing is drawn in the deleted span) with a size label; insertions get a flag with their size; long clips an end marker. Calls spanning a deletion are split at it in every view."
        {...settingAnchor(SV_SETTINGS.enabled)}
      >
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
          className="rounded border-gray-300 dark:border-white/20" data-testid="sv-display-toggle" />
        <span>{SV_SETTINGS.enabled.label}</span>
      </label>
      {enabled && (
        <>
          <div className="flex items-center gap-1 py-0.5 ml-4" {...settingAnchor(SV_SETTINGS.minLen)}>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">Min size:</span>
            <input
              type="number"
              value={local}
              min={SV_MIN_LEN_LOWEST}
              max={SV_MIN_LEN_HIGHEST}
              step={10}
              onChange={e => setLocal(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') commit(); }}
              className="w-16 text-xs border rounded px-1 py-0.5 dark:bg-dark-surface dark:border-white/20 dark:text-gray-200"
              aria-label="Min SV size (bp)"
              data-testid="sv-min-size"
              title={`Deletions, insertions and clips at least this long (bp) are drawn as SVs and clustered in the SV track (${SV_MIN_LEN_LOWEST}–${SV_MIN_LEN_HIGHEST.toLocaleString()}).`}
            />
            <span className="text-[11px] text-gray-500 dark:text-gray-400">bp</span>
          </div>
          <label className="flex items-center gap-1 py-0.5 ml-4 text-[11px] text-gray-500 dark:text-gray-400" {...settingAnchor(SV_SETTINGS.minSupport)}>
            Min supporting reads:
            <input type="number" min={1} max={1_000_000} step={1} value={support}
              onChange={e => setSupport(e.target.value)} onBlur={commitSupport}
              onKeyDown={e => { if (e.key === 'Enter') commitSupport(); }}
              className="w-16 text-xs border rounded px-1 py-0.5 dark:bg-dark-surface dark:border-white/20 dark:text-gray-200"
              aria-label="Min SV supporting reads" data-testid="sv-min-support"
              title="Show SV summary calls and clip piles supported by at least this many reads in the loaded cohort. Set to 1 to inspect single-read evidence." />
          </label>
          <div className="ml-4 text-[11px] leading-snug text-gray-500 dark:text-gray-400" data-testid="sv-track-hint">
            The SV track is a row above the reads in each panel: drag its edge to resize it; remove or restore it from the panel's Tracks button.
          </div>
        </>
      )}
    </div>
  );
}
