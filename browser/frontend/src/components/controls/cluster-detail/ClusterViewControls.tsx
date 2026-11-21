/**
 * Cluster view controls: which channels the cluster metaprofiles show, and what the read map is coloured by and
 * built from. Display only: switching a channel or a colour never re-clusters or reloads reads (a channel whose
 * layer is not on the reads yet joins the next read request; the map's features refetch the map alone).
 */
import { channelColor, mapColorOptions, type MapColorOption, type MapLegend, type ProfileChannel } from '../../../utils/clusterViewChannels';
import { AnalysisStatus } from '../shared';
import type { RegularityStatus } from './useClusterRegularity';

const chip = (active: boolean) => `inline-flex items-center gap-1 rounded-fb border px-1.5 py-[1px] text-[11px] transition-colors focus-visible:outline-none focus-visible:shadow-focus ${
  active
    ? 'border-cyan-600 bg-cyan-50 text-cyan-900 dark:border-cyan-400 dark:bg-cyan-950/40 dark:text-cyan-100'
    : 'border-gray-200 text-gray-600 hover:border-gray-400 dark:border-white/10 dark:text-gray-300'
}`;

/** Toggle one channel: from the default view a click starts a selection with it; the last one off is the default. */
export function toggleProfileChannel(current: readonly string[] | null, key: string): string[] | null {
  const list = current ? [...current] : [];
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1); else list.push(key);
  return list.length ? list : null;
}

export function ProfileChannelPicker({ options, value, onChange, regularity, missing }: {
  options: ProfileChannel[];
  /** null: the default (what the default metaprofile shows). */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  regularity?: { status: RegularityStatus; message: string } | null;
  /** Chosen channels without a profile yet (their layer is loading, or the reads carry none). */
  missing?: string[];
}) {
  const chosen = new Set(value ?? []);
  return (
    <div className="space-y-1" data-testid="cluster-profile-channels">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Metaprofile channels">
        <span className="mr-0.5 text-[11px] text-gray-500 dark:text-gray-400" title="What each cluster's average profile shows. Several at once are drawn as stacked profiles.">Profile</span>
        <button type="button" className={chip(value === null)} aria-pressed={value === null} data-testid="cluster-profile-channel-default"
          onClick={() => onChange(null)} title="Follows the default metaprofile: the layers it shows (by default, the read layers switched on in Tracks)">
          Default
        </button>
        {options.map(o => (
          <button key={o.key} type="button" className={chip(chosen.has(o.key))} aria-pressed={chosen.has(o.key)}
            data-testid={`cluster-profile-channel-${o.key}`} title={o.title}
            onClick={() => onChange(toggleProfileChannel(value, o.key))}>
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: o.color ?? channelColor(o.key) }} />
            {o.label}
          </button>
        ))}
      </div>
      {regularity && (regularity.status === 'loading' || regularity.status === 'analysing') && (
        <AnalysisStatus kind="loading" compact>{regularity.message}</AnalysisStatus>
      )}
      {regularity?.status === 'error' && <AnalysisStatus kind="error" compact>{regularity.message}</AnalysisStatus>}
      {regularity?.status === 'needs-analyse' && <div className="text-[11px] text-ink-secondary" data-testid="cluster-channel-needs-analyse">{regularity.message}</div>}
      {missing && missing.length > 0 && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="cluster-profile-missing">
          No profile yet for {missing.join(', ')}{regularity?.status === 'ready' ? ' (no regularity tiles for these molecules)' : ' (loading its layer)'}.
        </div>
      )}
    </div>
  );
}

function Legend({ legend }: { legend: MapLegend }) {
  if (legend.kind === 'none') return null;
  if (legend.kind === 'ramp') {
    const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300" data-testid="projection-color-legend">
        <span>{legend.label}</span>
        {legend.max > legend.min || legend.min !== 0 ? (
          <>
            <span>{fmt(legend.min)}</span>
            <span className="inline-block h-2 w-20 rounded-sm" style={{ background: `linear-gradient(90deg, ${legend.stops.join(',')})` }} />
            <span>{fmt(legend.max)}</span>
          </>
        ) : <span className="text-gray-400">no values</span>}
        {legend.missing > 0 && <span className="text-gray-400">· {legend.missing} without a value (grey)</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300" data-testid="projection-color-legend">
      <span>{legend.label}</span>
      {legend.items.map(item => (
        <span key={item.key} className="inline-flex items-center gap-0.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: item.color }} />{item.label}
          <span className="text-gray-400">{item.count}</span>
        </span>
      ))}
      {legend.missing > 0 && <span className="text-gray-400">· {legend.missing} {legend.label === 'Geometry carried' ? 'without patches' : 'not covering'} (grey)</span>}
    </span>
  );
}

export function MapColorControls({ fracLayers, colorBy, onColorBy, position, onPosition, featureOptions, featureMode,
  onFeatureMode, legend, note }: {
  fracLayers: string[];
  colorBy: string;
  onColorBy: (id: string) => void;
  position: number;
  onPosition: (pos: number | null) => void;
  featureOptions: Array<{ id: string; label: string }>;
  featureMode: string | null;
  onFeatureMode: (mode: string | null) => void;
  legend: MapLegend;
  note?: string | null;
}) {
  const options = mapColorOptions(fracLayers);
  // A stored colour this view has no reads for (a layer share of another dataset) stays selectable.
  if (!options.some(o => o.id === colorBy)) options.push({ id: colorBy, label: colorBy, group: 'Layer share' });
  const groups = [...new Set(options.map(o => o.group))] as MapColorOption['group'][];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid="projection-color-controls">
      <label className="inline-flex items-center gap-1" title="What each dot's colour shows. Cluster is the usual map; the others summarise each molecule from the reads the panel holds.">
        <span className="text-gray-500 dark:text-gray-400">Colour by</span>
        <select value={colorBy} onChange={e => onColorBy(e.target.value)} className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]"
          data-testid="projection-color-by">
          {groups.map(g => (
            <optgroup key={g} label={g}>
              {options.filter(o => o.group === g).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {colorBy === 'state' && (
        <label className="inline-flex items-center gap-1" title="The reference position (1-based) whose layer colours each read">
          <span className="text-gray-500 dark:text-gray-400">at</span>
          <input type="number" value={position + 1} step={10} className="input-tool min-h-0 w-28 py-0.5 text-[11px]" data-testid="projection-color-pos"
            onChange={e => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v > 0) onPosition(v - 1); }} />
          <button type="button" className="text-gray-500 underline" onClick={() => onPosition(null)}>middle</button>
        </label>
      )}
      <label className="inline-flex items-center gap-1" title="What the map is built from: the clustering's own features (default), or the same peaks read through another layer or mode. Changing it recomputes the map only.">
        <span className="text-gray-500 dark:text-gray-400">Built from</span>
        <select value={featureMode ?? ''} onChange={e => onFeatureMode(e.target.value || null)} className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]"
          data-testid="projection-features">
          <option value="">Clustered features</option>
          {featureOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <Legend legend={legend} />
      {note && <span className="text-amber-700 dark:text-amber-300" data-testid="projection-color-note">{note}</span>}
    </div>
  );
}
