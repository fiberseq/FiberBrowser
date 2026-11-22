/**
 * The Plots workspace (PLOTS_PANEL_PLAN.md, the owner-approved mock "1 · Main" and "2 · Plot builder"): a full-window
 * view over the reads, one toggle (P) away. Header: the shared locus with back/forward, pan and zoom; a mini read
 * strip; then the builder (Type × Source × Where × Group by, Compare, Display), the plot with its Follow/Pin toggle
 * and the locus it was computed for, and the saved plots. Everything moves the same shared locus as the browser,
 * whose reads, scroll, filters and clusters stay as they were underneath.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCoaccStore, type CoaccTrackMode } from '../../stores/coaccStore';
import { PrereqButton } from './prereqActions';
import { useHubWorkspaceEnabled } from './hubWorkspaceFlag';
import { LayerSelector } from '../../components/controls/shared';
import { useBrowserStore } from '../../stores/browserStore';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useAnalysisSettingsKey } from '../../hooks/useAnalysisSettingsKey';
import { getLayerColor } from '../../utils/layerColors';
import { useLayerColorVersion } from '../layerColours/state';
import {
  ALL_FOOTPRINTS, colorSlotOf, DEFAULT_FOOTPRINT_SIZE_COLORMAPS, FOOTPRINT_SIZE_NORMALIZATION_LABELS, FOOTPRINT_SIZE_NORMALIZATIONS,
  footprintSizeLayerOptions, isEnrichment, normalizeFootprintSizeSettings,
  type FootprintSizeNormalization, type FootprintSizeSettings,
} from '../../utils/footprintSizeSettings';
import { FOOTPRINT_SIZE_COLORMAP_LABELS, FOOTPRINT_SIZE_COLORMAPS, type FootprintSizeColormap } from '../../utils/footprintSizeColormaps';
import { COLOR_MAX_ENRICH, CommitNumber, POS_BINS, SIZE_BINS, SIZE_PRESETS } from './sizeControls';
import { AnalysisSelect } from '../../components/controls/shared';
import { getCanonicalLayerEntries } from '../../utils/layerColors';
import { useFollowedTarget } from './follow';
import { SizePlot } from './SizePlot';
import { MetaprofilePlot, type MetaprofileResult } from './MetaprofilePlot';
import { HeatmapPlot, type HeatmapResult } from './HeatmapPlot';
import { isReadGroupBy, useReadGroups } from './readGroups';
import { BedPlot, type BedResult } from './BedPlot';
import { DifferentialPlot, type DifferentialResult } from './DifferentialPlot';
import { SuppliedPlot } from './SuppliedPlot';
import { QuantPlot } from '../windowQuant/QuantPlot';
import { PANEL_PLOTS, latestSuppliedCard, openPanelPlot, openPanelPlotCard } from './panelPlots';
import { normalizeSummary } from './summary';
import { compareGroupBlocker, knownGroupCount, summaryBlocker, typeHasCompare, typeHasSummary, useGroupCount } from './compareState';
import { BedSizePlot } from './BedSizePlot';
import { RandomReadsPlot } from './RandomReadsPlot';
import { CoaccPlot, type CoaccResult } from './CoaccPlot';
import { normalizeBedSettings, type BedSettings, type RegionSet } from './bedRegions';
import { fetchJson } from '../../api/sharedFetch';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import { MAX_STORED_DIFF_ROWS, packProfile } from './gallery';
import { atLocus, liftedLeftOutNotice, locusOf, targetKey, usePlotTargets } from './usePlotTargets';
import {
  compareAvailable, groupAvailable, whereAvailable, whereBlockedReason, normalizeSampling, bandLabel, COACC_NORMALIZATIONS, normalizeCoaccSettings, type CoaccSettings, DIFF_FEATURES, normalizeDiffSettings, type DiffSettings, isLineType, normalizeHistogramSettings, HISTOGRAM_NORMALIZATIONS, HISTOGRAM_WEIGHTINGS, HISTOGRAM_INCLUSIONS, type HistogramSettings, normalizeHeatmapSettings, type HeatmapSettings, describePlot, followsView, formatLocus, isProfileType, isSizeType, normalizeProfileSettings, PROFILE_NORMALIZATIONS, type ProfileSettings, MARK_SOURCES, MAX_FOLLOW_DELAY_MS, PLOT_COMPARE, PLOT_GROUP_BY, PLOT_TYPES,
  PLOT_WHERE, newPlot, plotDisplayName, plotTypeInfo, withType, type PlotLocus, type PlotSpec, COACC_SIGNAL_LABELS, HEATMAP_SORTS } from './plotModel';
import { normalizeFollowDelay } from './plotsState';
import { isMultiSourceType, plotSources, sourceLabel, sourceMixBlocker, toggleSource, withSources } from './plotModel';
import { useFamilyOptions, type FamilyOption } from './useFamilySources';
import type { FamilyKind } from '../hub/familySources';
import { sourceColor } from './multiSource';
import { keptEntries, replaceEntry, updateEntry, useGalleryStore, workingEntries, workingFor, workingIsKept } from './gallery';
import { closePlotCard, keepPlotEntry, openEntry, recordResult, undoClosePlot, useGallerySeed } from './galleryActions';
import { GalleryCard, GalleryView } from './GalleryView';
import type { SizePlotResult } from './SizePlot';
import { setPlotsTab, useWorkspaceStore } from './workspace';
import { WorkspaceBand } from './WorkspaceShell';

const PILL = 'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors';
const PILL_ON = 'bg-amber-50 font-semibold text-amber-900 ring-1 ring-inset ring-amber-700 dark:bg-amber-900/30 dark:text-amber-100 dark:ring-amber-500';
const PILL_OFF = 'bg-white text-gray-700 ring-1 ring-inset ring-gray-200 hover:bg-gray-50 dark:bg-transparent dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/5';
const PILL_DISABLED = 'cursor-not-allowed bg-gray-50 text-gray-400 ring-1 ring-inset ring-gray-100 dark:bg-white/5 dark:text-gray-500 dark:ring-white/5';
const ICON_BTN = 'inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-[11px] text-gray-600 ring-1 ring-inset ring-gray-200 hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/5';

const soon = (phase?: number) => `Coming soon${phase ? ` (Plots phase ${phase})` : ''}`;

function Section({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="space-y-1" data-testid={testId}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</h3>
        {hint && <span className="text-[10px] text-gray-400">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </section>
  );
}

function Pill({ on, disabled, title, onClick, testId, children, value }: {
  on: boolean; disabled?: boolean; title: string; onClick: () => void; testId: string; children: React.ReactNode; value: string;
}) {
  return (
    <button type="button" aria-pressed={on} aria-disabled={disabled || undefined} disabled={disabled} title={title}
      data-testid={testId} data-value={value} onClick={disabled ? undefined : onClick}
      className={`${PILL} ${disabled ? PILL_DISABLED : on ? PILL_ON : PILL_OFF}`}>
      {children}
    </button>
  );
}

/** The size types' own settings (the builder's Display section). */
function SizeDisplay({ settings, onChange, comparing }: { settings: FootprintSizeSettings; onChange: (patch: Partial<FootprintSizeSettings>) => void; comparing: boolean }) {
  const enrichment = isEnrichment(settings.normalization);
  // The colour slot in use: comparative (Compare on; RdBu_r by default) or the view's (magma / viridis by default).
  const colorMode = colorSlotOf(settings, comparing);
  const colormap = settings.colormaps[colorMode];
  const presetValue = `${settings.sizeMin}-${settings.sizeMax}`;
  const presets = SIZE_PRESETS.some(o => o.value === presetValue) ? SIZE_PRESETS : [...SIZE_PRESETS, { value: presetValue, label: `Custom (${presetValue})` }];
  const num = (v: string) => Number(v);
  return (
    <div className="flex flex-col gap-1.5" data-testid="plots-display">
      <Field label="Normalise" title={FOOTPRINT_SIZE_NORMALIZATIONS.map(n => `${FOOTPRINT_SIZE_NORMALIZATION_LABELS[n].label}: ${FOOTPRINT_SIZE_NORMALIZATION_LABELS[n].help}`).join('\n')}>
        <select aria-label="Normalise" className={FIELD_SELECT} value={settings.normalization} onChange={e => onChange({ normalization: e.target.value as FootprintSizeNormalization })}>
          {FOOTPRINT_SIZE_NORMALIZATIONS.map(n => <option key={n} value={n}>{FOOTPRINT_SIZE_NORMALIZATION_LABELS[n].label}</option>)}
        </select>
      </Field>
      <Field label="Footprint as" title="Full footprint: each footprint adds to every position it covers. Midpoint: counted once, at its centre.">
        <select aria-label="Footprint as" className={FIELD_SELECT} value={settings.mode} onChange={e => onChange({ mode: e.target.value as 'span' | 'midpoint' })}>
          <option value="span">Full footprint</option><option value="midpoint">Midpoint</option>
        </select>
      </Field>
      <Field label="Smooth size σ" unit="bp" title={`A Gaussian down the size axis on the counts before normalising, bp (σ = ${(settings.sigmaSizeBp / settings.sizeBin).toFixed(1)} bins). 0 = off.`}>
        <CommitNumber value={settings.sigmaSizeBp} min={0} ariaLabel="Gaussian sigma, size, bp" testId="plots-sigma-size" onCommit={v => onChange({ sigmaSizeBp: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Smooth pos σ" unit="bp" title={`A Gaussian along positions on the counts before normalising, bp (σ = ${(settings.sigmaPosBp / settings.posBin).toFixed(1)} bins). 0 = off.`}>
        <CommitNumber value={settings.sigmaPosBp} min={0} ariaLabel="Gaussian sigma, pos, bp" testId="plots-sigma-pos" onCommit={v => onChange({ sigmaPosBp: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Size bin" unit="bp">
        <select aria-label="Size bin" className={`${FIELD_SELECT} max-w-[5rem]`} value={settings.sizeBin} onChange={e => onChange({ sizeBin: num(e.target.value) })}>
          {SIZE_BINS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Position bin" unit="bp">
        <select aria-label="Pos bin" className={`${FIELD_SELECT} max-w-[5rem]`} value={settings.posBin} onChange={e => onChange({ posBin: num(e.target.value) })}>
          {POS_BINS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Sizes">
        <select aria-label="Sizes" className={FIELD_SELECT} value={presetValue} onChange={e => { const [lo, hi] = e.target.value.split('-').map(Number); onChange({ sizeMin: lo, sizeMax: hi }); }}>
          {presets.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Size range, bp" title="Any range of footprint sizes in bp, smallest to largest (the presets above set both).">
        <span className="flex min-w-0 items-center gap-0.5">
          <CommitNumber value={settings.sizeMin} min={0} ariaLabel="Smallest footprint size, bp" testId="plots-size-min"
            onCommit={v => onChange({ sizeMin: Math.min(v, Math.max(0, settings.sizeMax - settings.sizeBin)) })} className={FIELD_NUMBER_NARROW} />
          <span className="text-[11px] text-gray-500">–</span>
          <CommitNumber value={settings.sizeMax} min={1} ariaLabel="Largest footprint size, bp" testId="plots-size-max"
            onCommit={v => onChange({ sizeMax: Math.max(v, settings.sizeMin + settings.sizeBin) })} className={FIELD_NUMBER_NARROW} />
        </span>
      </Field>
      <Field label="Min footprints" title="Size rows (or positions) drawn from fewer footprints are left blank (hatched).">
        <CommitNumber value={settings.minFootprints} min={0} ariaLabel="Min footprints" testId="plots-min-footprints" onCommit={v => onChange({ minFootprints: v })} className={FIELD_NUMBER} />
      </Field>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={settings.log} onChange={e => onChange({ log: e.target.checked })} className="h-3 w-3 accent-amber-700" data-testid="plots-log" />
        {enrichment ? 'log2 colour (centred on 0)' : 'Log colour'}
      </label>
      <Field label={colorMode === 'comparative' ? 'Colours (compare)' : colorMode === 'vplot' ? 'Colours (V-plot)' : 'Colours'}
        title="Comparisons (log2 ratios) default to RdBu_r centred on 0; single Size enrichment plots to magma; V-plots to viridis. Each keeps its own pick.">
        <select aria-label="Colormap" className={FIELD_SELECT} value={colormap.name} onChange={e => onChange({ colormaps: { ...settings.colormaps, [colorMode]: { ...colormap, name: e.target.value as FootprintSizeColormap } } })}>
          {FOOTPRINT_SIZE_COLORMAPS.map(c => <option key={c} value={c}>{FOOTPRINT_SIZE_COLORMAP_LABELS[c]}{c === DEFAULT_FOOTPRINT_SIZE_COLORMAPS[colorMode].name ? ' ·' : ''}</option>)}
        </select>
      </Field>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={colormap.reverse} onChange={e => onChange({ colormaps: { ...settings.colormaps, [colorMode]: { ...colormap, reverse: e.target.checked } } })}
          className="h-3 w-3 accent-amber-700" /> Reverse colormap
      </label>
      <Field label="Colour range">
        <select aria-label="Colour range" className={FIELD_SELECT} value={settings.scale} onChange={e => onChange({ scale: e.target.value as FootprintSizeSettings['scale'] })}>
          <option value="shared">Shared</option><option value="per_panel">Per panel</option>
        </select>
      </Field>
      {enrichment && (
        <Field label="Limit" title="The fold change at either end of the colour scale (Auto: the 95th percentile, kept between 1.25x and 4x).">
          <select aria-label="Limit" className={`${FIELD_SELECT} max-w-[6rem]`} value={settings.colorMax ?? 0} onChange={e => onChange({ colorMax: num(e.target.value) || null })}>
            {COLOR_MAX_ENRICH.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}

/** One builder setting: a short label (its tooltip says the rest) over or beside its control, the unit outside the
 *  input; fits the builder's width at every default window size (tests/e2e/plots-fit). */
export function Field({ label, title, unit, children, testId }: { label: string; title?: string; unit?: string; children: React.ReactNode; testId?: string }) {
  return (
    <label className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-1.5 text-[11px] text-gray-600 dark:text-gray-300" title={title} data-testid={testId}>
      <span className="leading-tight">{label}</span>
      <span className="flex min-w-0 items-center gap-1">{children}{unit && <span className="shrink-0 text-gray-500">{unit}</span>}</span>
    </label>
  );
}
const FIELD_SELECT = 'input-tool min-h-0 w-full min-w-0 py-0.5 text-[11px]';
const FIELD_NUMBER = 'input-tool w-[4.5rem] min-w-0 min-h-0 py-0.5 text-[11px]';
/** Two numbers on one row (a range) in the builder's width. */
const FIELD_NUMBER_NARROW = 'input-tool w-[3.75rem] shrink-0 min-h-0 py-0.5 text-[11px]';

/** A view metaprofile's x-axis: genome coordinates, or the distance from an anchor (a gene's TSS or end, the view
 *  centre, a position; a meta-locus: its site), as the browser's metaprofiles offer (windowQuant/axisFrame). */
function PlotAxisControl({ plot, onChange }: { plot: PlotSpec; onChange: (axis: import('../windowQuant/axisFrame').AxisFrame | null) => void }) {
  const genes = useBrowserStore(s => s.genes);
  const chrom = plot.pinned?.chrom ?? useBrowserStore.getState().chrom;
  const a = plot.axis;
  const inView = genes.filter(g => g.chrom === chrom).slice(0, 200);
  return (
    <div className="flex flex-col gap-1.5" data-testid="plots-axis">
      <Field label="x-axis" title="Genome coordinates, or the distance from an anchor (upstream negative on either strand)">
        <select aria-label="x-axis" data-testid="plots-axis-mode" className={FIELD_SELECT} value={a?.mode === 'relative' ? a.anchor : 'genome'}
          onChange={e => onChange(e.target.value === 'genome' ? null : { mode: 'relative', anchor: e.target.value as 'tss', gene: a?.gene ?? null, position: a?.position ?? null })}>
          <option value="genome">genome coordinates</option><option value="tss">from gene start (TSS)</option><option value="gene-end">from gene end</option>
          <option value="centre">from the view centre</option><option value="position">from a position</option>
        </select>
      </Field>
      {a?.mode === 'relative' && (a.anchor === 'tss' || a.anchor === 'gene-end') && (
        <Field label="Gene">
          <select aria-label="Anchor gene" data-testid="plots-axis-gene" className={FIELD_SELECT} value={a.gene ?? ''} onChange={e => onChange({ ...a, gene: e.target.value || null })}>
            <option value="">nearest in view</option>{inView.map(g => <option key={g.id} value={g.id}>{g.name || g.id} ({g.strand})</option>)}
          </select>
        </Field>
      )}
      {a?.mode === 'relative' && a.anchor === 'position' && (
        <Field label="Position"><CommitNumber value={a.position ?? 0} min={0} ariaLabel="Anchor position" testId="plots-axis-position" onCommit={v => onChange({ ...a, position: v })} className={FIELD_NUMBER} /></Field>
      )}
    </div>
  );
}

/** The metaprofile's settings (the builder's Display section). */
function ProfileDisplay({ settings, onChange, multiSource = false }: { settings: ProfileSettings; onChange: (patch: Partial<ProfileSettings>) => void; multiSource?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="plots-profile-display">
      {multiSource && (<>
        <Field label="Sources as" testId="plots-profile-multi-layout" title="Several sources: one panel per group with every source overlaid (Auto, Panels), or one chart with every line (groups told apart by dash)">
          <select aria-label="Sources as" className={FIELD_SELECT} value={settings.multiLayout} onChange={e => onChange({ multiLayout: e.target.value as ProfileSettings['multiLayout'] })}>
            <option value="auto">Auto</option><option value="panels">Panel per group</option><option value="overlay">One chart</option>
          </select>
        </Field>
        {settings.multiLayout !== 'overlay' && (
          <Field label="Panel y" testId="plots-profile-multi-y" title="One y range across the panels (compare heights between groups), or each panel its own">
            <select aria-label="Panel y" className={FIELD_SELECT} value={settings.multiYScale} onChange={e => onChange({ multiYScale: e.target.value as ProfileSettings['multiYScale'] })}>
              <option value="shared">Shared</option><option value="own">Each its own</option>
            </select>
          </Field>
        )}
      </>)}
      <Field label="Signal" title={PROFILE_NORMALIZATIONS.map(n => `${n.label}: ${n.help}`).join('\n')}>
        <select aria-label="Signal" className={FIELD_SELECT} value={settings.normalization} onChange={e => onChange({ normalization: e.target.value as ProfileSettings['normalization'] })}>
          {PROFILE_NORMALIZATIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
        </select>
      </Field>
      <Field label="Smoothing σ" unit="bp" title="A Gaussian along positions, on the signal and the coverage before dividing (bp, 0 = off).">
        <CommitNumber value={settings.sigmaBp} min={0} ariaLabel="Profile Gaussian sigma, bp" testId="plots-profile-sigma" onCommit={v => onChange({ sigmaBp: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Bin" unit="bp">
        <select aria-label="Bin" className={`${FIELD_SELECT} max-w-[5rem]`} value={settings.binBp} onChange={e => onChange({ binBp: Number(e.target.value) })}>
          {[1, 5, 10, 20, 50, 100].map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Min reads" title="Positions covered by fewer reads are left blank.">
        <CommitNumber value={settings.minCoverage} min={0} ariaLabel="Profile minimum coverage" testId="plots-profile-min" onCommit={v => onChange({ minCoverage: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Reads / dataset" title="Reads sampled per dataset (the server's display sample, seeded so a plot reproduces).">
        <CommitNumber value={settings.readCap} min={50} ariaLabel="Reads per dataset" testId="plots-profile-cap" onCommit={v => onChange({ readCap: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Size band" title="Only the source's footprints of one size band, or one line per band (bands from the edges below)">
        <select aria-label="Size band" data-testid="plots-profile-band" className={FIELD_SELECT}
          value={settings.band === 'off' || settings.band === 'each' ? settings.band : String(settings.band)}
          onChange={e => onChange({ band: e.target.value === 'off' || e.target.value === 'each' ? e.target.value : Number(e.target.value) })}>
          <option value="off">All sizes</option>
          <option value="each">One line per band</option>
          {[...settings.bandEdges.map((_, i) => i), settings.bandEdges.length].map(i => <option key={i} value={String(i)}>{bandLabel(settings.bandEdges, i)}</option>)}
        </select>
      </Field>
      <Field label="Band edges" unit="bp" title="The bands' inner edges (bp): 90, 200 gives < 90, 90–200, ≥ 200">
        <input type="text" defaultValue={settings.bandEdges.join(', ')} aria-label="Band edges" data-testid="plots-profile-band-edges" className="input-tool min-h-0 w-full min-w-0 py-0.5 text-[11px]"
          onBlur={e => onChange({ bandEdges: e.target.value.split(/[ ,;]+/).map(Number).filter(v => Number.isFinite(v) && v > 0) })}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </Field>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" title="Split each group by the read's state at the anchor (the view's or each feature's centre): a nucleosome-sized footprint, a TF-sized one, or open">
        <input type="checkbox" checked={settings.conditionOn} data-testid="plots-profile-condition" onChange={e => onChange({ conditionOn: e.target.checked })} /> Split by state at the anchor
      </label>
      {settings.conditionOn && (
        <div className="flex flex-col gap-1.5 pl-5" data-testid="plots-profile-condition-settings">
          <Field label="Anchor ±" unit="bp" title="The window around the anchor the state is read in">
            <CommitNumber value={settings.conditionBp} min={0} ariaLabel="Anchor window, bp" testId="plots-profile-condition-bp" onCommit={v => onChange({ conditionBp: v })} className={FIELD_NUMBER} />
          </Field>
          <Field label="Nucleosome ≥" unit="bp" title="Footprints this long or longer count as a nucleosome; shorter ones as TF-sized">
            <CommitNumber value={settings.conditionNucBp} min={1} ariaLabel="Nucleosome size, bp" testId="plots-profile-condition-nuc" onCommit={v => onChange({ conditionNucBp: v })} className={FIELD_NUMBER} />
          </Field>
        </div>
      )}
    </div>
  );
}

/** Where = BED region sets: add BEDs by path (no dialog), tick the sets to plot, and the anchors / subsampling /
 * occlusion parameters (each with a default). */
function RegionSetsSection({ plot, onChange }: { plot: PlotSpec; onChange: (patch: Partial<BedSettings>) => void }) {
  const sets = useBrowserStore(s => s.plotsWorkspace.regionSets);
  const setWs = useBrowserStore(s => s.setPlotsWorkspace);
  const [path, setPath] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const b = plot.bed;
  const add = async () => {
    const p = path.trim();
    if (!p) return;
    setNote('Reading…');
    try {
      const r = await fetchJson<{ name: string; path: string; regions: RegionSet['regions']; columns?: RegionSet['columns']; total: number; skipped: number; capped: boolean }>('/api/plots/bed_regions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
      });
      const id = `bed-${Date.now().toString(36)}-${sets.length}`;
      const set: RegionSet = { id, name: r.name, path: r.path, color: getClusterColor(sets.length), regions: r.regions, total: r.total,
        ...(r.columns && r.columns.length === r.regions.length && r.columns.some(c => c.some(v => v != null)) ? { columns: r.columns } : {}) };
      setWs(ws => ({ ...ws, regionSets: [...ws.regionSets, set].slice(-20) }));
      onChange({ setIds: [...b.setIds, id] });
      setPath('');
      setNote(`${r.name}: ${r.total.toLocaleString()} regions${r.skipped ? ` (${r.skipped} lines skipped)` : ''}${r.capped ? ` (first ${r.regions.length.toLocaleString()} kept)` : ''}`);
    } catch (e) {
      setNote(`Could not read ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const num = (label: string, key: keyof BedSettings, min: number, title: string, suffix = '') => (
    <Field label={label} title={title} unit={suffix || undefined}>
      <CommitNumber value={b[key] as number} min={min} ariaLabel={label} testId={`plots-bed-${String(key)}`} onCommit={v => onChange({ [key]: v } as Partial<BedSettings>)} className={FIELD_NUMBER} />
    </Field>
  );
  return (
    <div className="flex flex-col gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="plots-bed-section">
      <div className="flex gap-1">
        <input type="text" value={path} onChange={e => setPath(e.target.value)} placeholder="/path/to/regions.bed" aria-label="BED file path" data-testid="plots-bed-path"
          onKeyDown={e => { if (e.key === 'Enter') void add(); }} className="input-tool min-h-0 flex-1 py-0.5 text-[11px]" />
        <button type="button" className={ICON_BTN} data-testid="plots-bed-add" onClick={() => void add()} title="Read the BED file on the server (gzip allowed); each file is a group.">Add BED</button>
      </div>
      {note && <div className="text-[10px] text-gray-500" data-testid="plots-bed-note">{note}</div>}
      {sets.map(set => (
        <label key={set.id} className="flex items-center gap-1" data-testid="plots-bed-set" title={set.path}>
          <input type="checkbox" checked={b.setIds.includes(set.id)} className="h-3 w-3 accent-amber-700"
            onChange={e => onChange({ setIds: e.target.checked ? [...b.setIds, set.id] : b.setIds.filter(x => x !== set.id) })} />
          <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: set.color }} />
          <span className="truncate">{set.name}</span>
          <span className="text-gray-400">{set.total.toLocaleString()}</span>
          <button type="button" className="ml-auto text-gray-400 hover:text-red-600" aria-label={`Remove ${set.name}`}
            onClick={() => { setWs(ws => ({ ...ws, regionSets: ws.regionSets.filter(x => x.id !== set.id) })); onChange({ setIds: b.setIds.filter(x => x !== set.id) }); }}>✕</button>
        </label>
      ))}
      <Field label="Anchor" title="Strand-aware: start is the 5′ end (the TSS of a gene) and end the 3′ end; minus-strand regions are flipped so downstream is to the right.">
        <select aria-label="Anchor" className={FIELD_SELECT} value={b.anchor} onChange={e => onChange({ anchor: e.target.value as BedSettings['anchor'] })}>
          <option value="centre">Centre</option><option value="start">Start (TSS)</option><option value="end">End</option>
        </select>
      </Field>
      <Field label="Window">
        <select aria-label="Window" className={FIELD_SELECT} value={b.mode} onChange={e => onChange({ mode: e.target.value as BedSettings['mode'] })}>
          <option value="point">Anchor ± flank</option><option value="scale">Scale regions</option>
        </select>
      </Field>
      {b.mode === 'point' ? num('Flank', 'flankBp', 10, 'bp either side of the anchor', 'bp') : <>{num('Body bins', 'bodyBins', 2, 'Bins each region body is stretched to')}{num('Flanks', 'scaleFlankBp', 0, 'bp either side of the region', 'bp')}</>}
      <Field label="Regions" title="Random N per set with a seed (reproducible), the same number per set (down to the smallest), or all (up to the cap).">
        <select aria-label="Regions" className={FIELD_SELECT} value={b.subsample} onChange={e => onChange({ subsample: e.target.value as BedSettings['subsample'] })}>
          <option value="random">Random N (seeded)</option><option value="equal">Equal N per set</option><option value="all">All</option>
        </select>
      </Field>
      {b.subsample === 'random' && num('N per set', 'n', 1, 'Regions per set')}
      {b.subsample !== 'all' && num('Seed', 'seed', 0, 'The sampling seed: the same seed gives the same regions')}
      {num('Cap', 'maxRegions', 1, 'Regions read at most per set')}
      {num('Reads / region', 'readsPerRegion', 1, 'Reads read per region and dataset (a seeded sample)')}
      <label className="inline-flex items-center gap-1" title="Downsample each region's reads to the dataset with the fewest there (seeded).">
        <input type="checkbox" checked={b.depthMatch} onChange={e => onChange({ depthMatch: e.target.checked })} className="h-3 w-3 accent-amber-700" data-testid="plots-bed-depth" /> Depth matching across datasets
      </label>
      <div className="mt-1 font-medium">Not occluded by a nucleosome</div>
      <Field label="Per read" testId="plots-bed-occlusion-read" title="Drop reads with a nucleosome over the centre, or over more than X% of centre ± N">
        <select aria-label="Per read" className={FIELD_SELECT} value={b.occlusionRead} onChange={e => onChange({ occlusionRead: e.target.value as BedSettings['occlusionRead'] })}>
          <option value="off">Off</option><option value="centre">Nucleosome over centre</option><option value="fraction">&gt; X% of centre ± N</option>
        </select>
      </Field>
      {b.occlusionRead === 'fraction' && <>{num('X', 'readPct', 0, 'Percent of centre ± N covered by a nucleosome', '%')}{num('N', 'readWindowBp', 1, 'bp either side of the centre', 'bp')}</>}
      <label className="inline-flex items-center gap-1" title="Keep regions whose centre is covered by a nucleosome in at most X% of their reads.">
        <input type="checkbox" checked={b.occlusionRegion} onChange={e => onChange({ occlusionRegion: e.target.checked })} className="h-3 w-3 accent-amber-700" data-testid="plots-bed-region-filter" /> Per region: drop by centre coverage
      </label>
      {b.occlusionRegion && num('Covered ≤', 'regionPct', 0, 'Keep regions whose centre is covered by a nucleosome in at most this percent of reads', '%')}
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" checked={b.showExcluded} onChange={e => onChange({ showExcluded: e.target.checked })} className="h-3 w-3 accent-amber-700" data-testid="plots-bed-show-excluded" /> Show excluded reads as their own group
      </label>
    </div>
  );
}

/** The size histogram's settings. */
function HistogramDisplay({ settings, readCap, onChange, onReadCap }: { settings: HistogramSettings; readCap: number; onChange: (patch: Partial<HistogramSettings>) => void; onReadCap: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="plots-histogram-display">
      <Field label="Value" title={HISTOGRAM_NORMALIZATIONS.map(n => `${n.label}: ${n.help}`).join('\n')}>
        <select aria-label="Value" className={FIELD_SELECT} value={settings.normalization} onChange={e => onChange({ normalization: e.target.value as HistogramSettings['normalization'] })}>
          {HISTOGRAM_NORMALIZATIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
        </select>
      </Field>
      <Field label="Weight" title={HISTOGRAM_WEIGHTINGS.map(n => `${n.label}: ${n.help}`).join('\n')}>
        <select aria-label="Weight" data-testid="plots-hist-weighting" value={settings.weighting} onChange={e => onChange({ weighting: e.target.value as HistogramSettings['weighting'] })} className={FIELD_SELECT}>
          {HISTOGRAM_WEIGHTINGS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
        </select>
      </Field>
      <Field label="Include" title={HISTOGRAM_INCLUSIONS.map(n => `${n.label}: ${n.help}`).join('\n')}>
        <select aria-label="Include" data-testid="plots-hist-inclusion" value={settings.inclusion} onChange={e => onChange({ inclusion: e.target.value as HistogramSettings['inclusion'] })} className={FIELD_SELECT}>
          {HISTOGRAM_INCLUSIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
        </select>
      </Field>
      <Field label="Bin" unit="bp">
        <select aria-label="Bin" className={`${FIELD_SELECT} max-w-[5rem]`} value={settings.binBp} onChange={e => onChange({ binBp: Number(e.target.value) })}>
          {[1, 2, 5, 10, 20, 50].map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Sizes from" unit="bp">
        <CommitNumber value={settings.sizeMin} min={0} ariaLabel="Smallest size" testId="plots-hist-min" onCommit={v => onChange({ sizeMin: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Sizes to" unit="bp">
        <CommitNumber value={settings.sizeMax} min={1} ariaLabel="Largest size" testId="plots-hist-max" onCommit={v => onChange({ sizeMax: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Smoothing σ" unit="bp" title="A Gaussian along sizes (bp, 0 = off).">
        <CommitNumber value={settings.sigmaBp} min={0} ariaLabel="Histogram Gaussian sigma, bp" testId="plots-hist-sigma" onCommit={v => onChange({ sigmaBp: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Reads / dataset" title="Reads sampled per dataset (seeded).">
        <CommitNumber value={readCap} min={50} ariaLabel="Reads per dataset" testId="plots-hist-cap" onCommit={onReadCap} className={FIELD_NUMBER} />
      </Field>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" title="Size axis on a log scale">
        <input type="checkbox" checked={settings.logX} data-testid="plots-hist-logx" onChange={e => onChange({ logX: e.target.checked })} /> Log size axis
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" title="Size-class guide lines (bp), e.g. TF < 90 / nucleosome ≥ 90">
        <input type="checkbox" checked={settings.guidesOn} data-testid="plots-hist-guides" onChange={e => onChange({ guidesOn: e.target.checked })} /> Guide lines
      </label>
      {settings.guidesOn && (
        <Field label="Guides at" unit="bp" title="Sizes of the guide lines, comma separated">
          <input type="text" defaultValue={settings.guides.join(', ')} aria-label="Guide sizes" data-testid="plots-hist-guide-sizes" className="input-tool min-h-0 w-full min-w-0 py-0.5 text-[11px]"
            onBlur={e => onChange({ guides: e.target.value.split(/[ ,;]+/).map(Number).filter(v => Number.isFinite(v) && v > 0) })}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </Field>
      )}
    </div>
  );
}

/** A number that may be blank (null: open). */
function OptionalNumber({ value, ariaLabel, testId, onCommit }: { value: number | null; ariaLabel: string; testId: string; onCommit: (v: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const t = draft.trim();
    const v = t === '' ? null : Number(t);
    if (v === null || Number.isFinite(v)) onCommit(v == null ? null : Math.round(v));
    setDraft(null);
  };
  return <input type="text" inputMode="numeric" aria-label={ariaLabel} data-testid={testId} value={draft ?? (value == null ? '' : String(value))} placeholder="all"
    onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    className="input-tool w-16 min-w-0 min-h-0 py-0.5 text-[11px]" />;
}

/** Heatmap rows: sorting, the row cap, and (features) the window and feature cap. */
function HeatmapDisplay({ settings, features, onChange, windowsOnly = false }: { settings: HeatmapSettings; features: boolean; onChange: (patch: Partial<HeatmapSettings>) => void; windowsOnly?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={windowsOnly ? 'plots-feature-windows' : 'plots-heatmap-display'}>
      {!windowsOnly && <>
      <Field label="Sort rows" title={HEATMAP_SORTS.map(x => `${x.label}: ${x.help}`).join('\n')}>
        <select aria-label="Sort rows" className={FIELD_SELECT} value={settings.sort} onChange={e => onChange({ sort: e.target.value as HeatmapSettings['sort'] })}>
          {HEATMAP_SORTS.map(x => <option key={x.value} value={x.value}>{features && x.value === 'bed' ? 'Position' : x.label}</option>)}
        </select>
      </Field>
      {settings.sort === 'mean' && (
        <Field label="Mean over" unit="bp" testId="plots-heatmap-sort-window" title="The window the mean is taken over, in the x axis' bp (blank: the whole window).">
          <OptionalNumber value={settings.sortFrom} ariaLabel="Sort window from, bp" testId="plots-heatmap-sort-from" onCommit={v => onChange({ sortFrom: v })} />
          <span>–</span>
          <OptionalNumber value={settings.sortTo} ariaLabel="Sort window to, bp" testId="plots-heatmap-sort-to" onCommit={v => onChange({ sortTo: v })} />
        </Field>
      )}
      {settings.sort === 'cluster' && (
        <Field label="Clusters (k)" title="Clusters of the rows (k-means, seeded with the plot's seed: Reads › New seed changes it).">
          <CommitNumber value={settings.k} min={2} ariaLabel="Clusters (k)" testId="plots-heatmap-k" onCommit={v => onChange({ k: Math.min(12, v) })} className={FIELD_NUMBER} />
        </Field>
      )}
      {settings.sort === 'score' && (
        <Field label="BED column" title="The BED column to sort by (1-based; 5 is the score).">
          <CommitNumber value={settings.scoreColumn} min={5} ariaLabel="BED column" testId="plots-heatmap-column" onCommit={v => onChange({ scoreColumn: Math.min(30, v) })} className={FIELD_NUMBER} />
        </Field>
      )}
      <Field label="Rows drawn" title="Rows drawn; more are thinned evenly, keeping the order.">
        <CommitNumber value={settings.maxRows} min={10} ariaLabel="Heatmap rows drawn" testId="plots-heatmap-rows" onCommit={v => onChange({ maxRows: v })} className={FIELD_NUMBER} />
      </Field>
      </>}
      {features && (
        <>
          <Field label="Window" unit="bp" title="The window around each feature's centre (bp).">
            <CommitNumber value={settings.windowBp} min={20} ariaLabel="Feature window, bp" testId="plots-heatmap-window" onCommit={v => onChange({ windowBp: v })} className={FIELD_NUMBER} />
          </Field>
          <Field label="Max features" title="Selected features read at most (by position).">
            <CommitNumber value={settings.maxFeatures} min={1} ariaLabel="Max features" testId="plots-heatmap-max-features" onCommit={v => onChange({ maxFeatures: v })} className={FIELD_NUMBER} />
          </Field>
        </>
      )}
    </div>
  );
}

/** The track under the reads draws on the plot's settings (one set of co-accessibility settings). */
function syncCoaccTrack(c: CoaccSettings): void {
  const st = useCoaccStore.getState();
  st.setCoaccNormalization(c.normalization as never);
  if (!c.signalType.startsWith('size:')) st.setCoaccSignalType(c.signalType as never);
  st.setCoaccLayer(c.layer);
  st.setCoaccBinSize(c.binBp);
  st.setCoaccMinCoverage(c.minCoverage);
  st.setCoaccScaling(c.scaling as never);
}

/** Co-accessibility's settings (the panel's), and the colormap of the slot in use (signed: RdBu; else magma). */
function CoaccDisplay({ plot, onChange, onColormap }: { plot: PlotSpec; onChange: (patch: Partial<CoaccSettings>) => void;
  onColormap: (slot: 'comparative' | 'enrichment', name: FootprintSizeColormap) => void }) {
  const c = plot.coacc;
  const trackMode = useCoaccStore(st => st.coaccTrackMode);
  const signed = plot.compare === 'diff' || !!COACC_NORMALIZATIONS.find(n => n.value === c.normalization)?.signed;
  const slot = signed ? 'comparative' as const : 'enrichment' as const;
  return (
    <div className="flex flex-col gap-1.5" data-testid="plots-coacc-settings">
      <div className="flex flex-wrap gap-1" data-tour="coacc-normalization">
        {COACC_NORMALIZATIONS.map(n => <Pill key={n.value} value={n.value} on={c.normalization === n.value} testId={`plots-coacc-norm-${n.value}`} title={n.help} onClick={() => onChange({ normalization: n.value })}>{n.label}</Pill>)}
      </div>
      <Field label="Signal"><select aria-label="Signal" data-testid="plots-coacc-signal" value={c.signalType} onChange={e => onChange({ signalType: e.target.value })} className={FIELD_SELECT}>
          {Object.entries(COACC_SIGNAL_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          {c.signalType.startsWith('size:') && <option value={c.signalType}>{c.signalType}</option>}
        </select>
      </Field>
      <Field label="Bin" unit="bp" title="Bin width in bp (0: automatic, about 150 bins)"><CommitNumber value={c.binBp} min={0} ariaLabel="Bin width" testId="plots-coacc-bin" onCommit={v => onChange({ binBp: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Min reads" title="Cells with fewer reads covering both positions are blank"><CommitNumber value={c.minCoverage} min={1} ariaLabel="Minimum reads" testId="plots-coacc-min" onCommit={v => onChange({ minCoverage: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="Layer" testId="plots-coacc-layer">
        <LayerSelector value={c.layer} onChange={layer => onChange({ layer })} allLabel="Default" variant="dropdown" />
      </Field>
      <Field label="Scaling" title="Colour scaling: log and square root draw negative values (correlation) at the low end."><select aria-label="Scaling" data-testid="plots-coacc-scaling" value={c.scaling} onChange={e => onChange({ scaling: e.target.value as CoaccSettings['scaling'] })} className={FIELD_SELECT}>
          <option value="linear">Linear</option><option value="log">Log</option><option value="sqrt">Sqrt</option>
        </select>
      </Field>
      <Field label="Track" title="A co-accessibility track under the reads, on these settings (the panel's Track display)."><select aria-label="Track under the reads" data-testid="plots-coacc-track" value={trackMode ?? ''} onChange={e => useCoaccStore.getState().setCoaccTrackMode((e.target.value || null) as CoaccTrackMode)} className={FIELD_SELECT}>
          <option value="">None</option><option value="heatmap">Heatmap strip</option><option value="arc">Arcs</option><option value="virtual4c">Virtual 4C</option>
        </select>
      </Field>
      <Field label="Colormap" title="Signed values (correlation, A − B) default to RdBu centred on 0; the others to magma."><select aria-label="Colormap" data-testid="plots-coacc-colormap" value={plot.size.colormaps[slot].name} onChange={e => onColormap(slot, e.target.value as FootprintSizeColormap)} className={FIELD_SELECT}>
          {FOOTPRINT_SIZE_COLORMAPS.map(m => <option key={m} value={m}>{FOOTPRINT_SIZE_COLORMAP_LABELS[m] ?? m}</option>)}
        </select>
      </Field>
    </div>
  );
}

/** Differential features' own settings: the test, strata, minimum reads, thresholds and the feature cap. */
function DiffDisplay({ settings, onChange }: { settings: DiffSettings; onChange: (patch: Partial<DiffSettings>) => void }) {
  const check = 'flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300';
  return (
    <div className="flex flex-col gap-1.5" data-testid="plots-diff-settings">
      <Field label="Test" title="Unstratified test per feature (with strata on, the CMH test is used)">
        <select aria-label="Test" data-testid="plots-diff-test" value={settings.test} onChange={e => onChange({ test: e.target.value as DiffSettings['test'] })} className={FIELD_SELECT}>
          <option value="fisher">Fisher&apos;s exact</option>
          <option value="chi2">χ² (Yates)</option>
        </select>
      </Field>
      <label className={check} title="Compare A and B at matched marking density: CMH over equal-count bins of the reads' m6A per kb">
        <input type="checkbox" data-testid="plots-diff-density" checked={settings.densityMatch} onChange={e => onChange({ densityMatch: e.target.checked })} /> Density match
      </label>
      {settings.densityMatch && (
        <Field label="Density bins">
          <CommitNumber value={settings.densityBins} min={2} ariaLabel="Density bins" testId="plots-diff-density-bins" onCommit={v => onChange({ densityBins: v })} className={FIELD_NUMBER} />
        </Field>
      )}
      <label className={check} title="CMH across replicates: A's i-th dataset with B's i-th (by dataset), or each dataset (clusters, read groups)">
        <input type="checkbox" data-testid="plots-diff-replicates" checked={settings.replicateAware} onChange={e => onChange({ replicateAware: e.target.checked })} /> Replicate-aware (CMH)
      </label>
      <Field label="Min reads / side" title="Evaluated reads needed on each side to test a feature">
        <CommitNumber value={settings.minReads} min={1} ariaLabel="Minimum reads per side" testId="plots-diff-min-reads" onCommit={v => onChange({ minReads: v })} className={FIELD_NUMBER} />
      </Field>
      <Field label="q ≤" title="Called when q is at most this (the volcano's horizontal line)">
        <input type="number" step="0.01" min="0" max="1" aria-label="q threshold" data-testid="plots-diff-q" defaultValue={settings.qMax}
          onBlur={e => onChange({ qMax: Number(e.target.value) })} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} className={FIELD_NUMBER} />
      </Field>
      <Field label="|Δ| ≥" title="Called when the difference in share is at least this">
        <input type="number" step="0.05" min="0" max="1" aria-label="Delta threshold" data-testid="plots-diff-delta" defaultValue={settings.deltaMin}
          onBlur={e => onChange({ deltaMin: Number(e.target.value) })} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} className={FIELD_NUMBER} />
      </Field>
      <Field label="Max features" title="Features tested at most (by position)">
        <CommitNumber value={settings.maxFeatures} min={1} ariaLabel="Features at most" testId="plots-diff-max" onCommit={v => onChange({ maxFeatures: v })} className={FIELD_NUMBER} />
      </Field>
    </div>
  );
}

/** One family kind's chips (several sources): the families in view, a step button when there are none, collapsed
 *  past `collapseAt` (a parameter: Find classes can give dozens). */
function FamilyChips({ plot, kind, options, selected, blocked, onToggle, collapseAt = 6 }: {
  plot: PlotSpec; kind: FamilyKind; options: FamilyOption[]; selected: string[]; blocked: string | null; onToggle: (id: string, label: string) => void; collapseAt?: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? options : options.slice(0, collapseAt);
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`plots-source-family-${kind.source}`} data-count={options.length}>
      <span className="basis-full text-[10px] font-medium text-gray-500 dark:text-gray-400">{kind.label}</span>
      {blocked ? (
        <Pill value={kind.source} on={false} disabled testId={`plots-source-family-blocked-${kind.source}`} title={blocked} onClick={() => undefined}>{kind.label}</Pill>
      ) : !options.length ? (<>
        <Pill value={kind.source} on={false} disabled testId={`plots-source-family-empty-${kind.source}`} title={kind.empty.reason} onClick={() => undefined}>{kind.label}</Pill>
        {kind.empty.prereq && <PrereqButton kind={kind.empty.prereq} done={options.length > 0} testId={`plots-source-family-step-${kind.source}`} />}
      </>) : shown.map(o => (
        <Pill key={o.id} value={o.id} on={selected.includes(o.id)} testId={`plots-source-family-chip`} title={`${kind.label}: ${o.label} (${o.hit.chrom}:${(o.hit.start + 1).toLocaleString('en-US')}–${o.hit.end.toLocaleString('en-US')}): the share of the reads scored on it that are members, over its span`}
          onClick={() => onToggle(o.id, o.label)}>
          <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: sourceColor(o.id) }} />{o.label}
        </Pill>
      ))}
      {!blocked && options.length > collapseAt && (
        <button type="button" className="text-[10px] text-amber-800 underline dark:text-amber-300" data-testid={`plots-source-family-more-${kind.source}`} onClick={() => setAll(a => !a)}>
          {all ? 'fewer' : `+${options.length - collapseAt} more`}
        </button>
      )}
    </div>
  );
}

/** The Source chips: several for the multi-source types (one line per source per group), one otherwise. Layers (the
 *  Layers toolbar's, custom MA-tag groups included), then the feature families in view (metaprofile, Current view). */
function SourceSection({ plot, layerOptions }: { plot: PlotSpec; layerOptions: Array<{ value: string; label: string; title: string; color: string; disabled: boolean }> }) {
  const update = useBrowserStore(s => s.updateCurrentPlot);
  const vChrom = useBrowserStore(s => s.chrom), vStart = useBrowserStore(s => s.start), vEnd = useBrowserStore(s => s.end);
  const multi = isMultiSourceType(plot.type);
  const selected = plotSources(plot);
  const view = plot.pinned ?? (vChrom ? { chrom: vChrom, start: vStart, end: vEnd } : null);
  const families = useFamilyOptions(multi ? view : null);
  const famBlocked = plot.where === 'bed' ? 'A family is one locus: BED region sets pool regions across the genome. Use Current view.'
    : plot.where === 'features' ? 'A family is one locus: selected features pool windows across the genome. Use Current view.' : null;
  const toggle = (id: string, label?: string) => update(p => withSources(p, toggleSource(p.type, plotSources(p), id), label ? { [id]: label } : {}));
  return (
    <Section title="Source" hint={multi ? `pick several · ${selected.length} selected` : 'as in the Layers toolbar'} testId="plots-source">
      {layerOptions.map(o => {
        const mix = multi ? sourceMixBlocker(selected, o.value) : null;
        return (
          <Pill key={o.value} value={o.value} on={selected.includes(o.value)} disabled={o.disabled} testId={`plots-source-${o.value}`}
            title={mix ? `${o.title}\n${mix}` : multi ? `${o.title}\nClick to add or remove (one line per source per group).` : o.title}
            onClick={() => toggle(o.value)}>
            {o.value === ALL_FOOTPRINTS
              ? <span aria-hidden="true" className="inline-flex"><span className="h-2 w-1 rounded-l-sm" style={{ backgroundColor: getLayerColor('nuc') }} /><span className="h-2 w-1 rounded-r-sm" style={{ backgroundColor: getLayerColor('tf') }} /></span>
              : <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: o.color }} />}
            {o.label}
          </Pill>
        );
      })}
      {multi && families.map(({ kind, options }) => (
        <FamilyChips key={kind.source} plot={plot} kind={kind} options={options} selected={selected} blocked={famBlocked} onToggle={toggle} />
      ))}
      {/* Selected families not in this view stay listed (so they can be cleared), marked. */}
      {multi && selected.filter(id => id.startsWith('fam:') && !families.some(f => f.options.some(o => o.id === id))).map(id => (
        <Pill key={id} value={id} on testId="plots-source-family-gone" title="Not in this view: not drawn here. Click to remove it." onClick={() => toggle(id)}>
          {sourceLabel(id, plot.sourceLabels)} <span className="text-[9px]">(not in view)</span>
        </Pill>
      ))}
    </Section>
  );
}

export function Builder({ plot, clustersLocus }: { plot: PlotSpec; clustersLocus: PlotLocus | null }) {
  const update = useBrowserStore(s => s.updateCurrentPlot);
  const datasets = useBrowserStore(s => s.datasets);
  // The source chips show the layers' colours (Labels → Layer colours).
  const layerColorVersion = useLayerColorVersion();
  const hasClusters = clustersLocus != null;
  const hubAllowed = useHubWorkspaceEnabled();
  // More options opens by itself when something in it is not the default.
  const changed = plot.where !== 'view';
  // Compare: a primary choice next to Group by; with fewer than two groups (as drawn) its A − B / log2 pills say why.
  const nGroups = useGroupCount(g => knownGroupCount(g, plot));
  const groupBlocker = compareGroupBlocker(nGroups, plot.groupBy, plot.where);
  const sumBlocker = summaryBlocker(plot, nGroups);
  const [more, setMore] = useState(changed);
  useEffect(() => { if (changed) setMore(true); }, [changed]);
  const sources = useMemo(() => {
    const opts = footprintSizeLayerOptions(datasets, plot.source);
    // Several sources: the selected ones stay listed even when no dataset has them.
    for (const src of plotSources(plot)) if (!src.startsWith('fam:') && !opts.some(o => o.value === src) && !MARK_SOURCES.has(src)) opts.push(...footprintSizeLayerOptions(datasets, src).filter(o => o.value === src));
    // Mark layers (m6A): a profile of marks per read per bp; no footprint sizes for the size types.
    const profile = isProfileType(plot.type);
    const marks = getCanonicalLayerEntries(datasets).filter(e => MARK_SOURCES.has(e.key))
      .map(e => ({ value: profile ? 'm6a' : e.key, label: e.label, title: profile ? `${e.label}: marks per read per bp` : `${e.label}: single bases, no footprint sizes`, color: e.color ?? getLayerColor(e.key), disabled: !profile }));
    return [...opts.map(o => ({ ...o, disabled: false })), ...marks];
  }, [datasets, plot.source, plot.sources, plot.type, layerColorVersion]);
  const hidden = PLOT_WHERE.find(w => w.value === plot.where)?.label ?? '';
  if (plot.supplied?.quant) {
    const q = plot.supplied.quant;
    return (
      <div className="flex flex-col gap-2 text-[11px] text-gray-700 dark:text-gray-200" data-testid="plots-builder">
        <p data-testid="plots-quant-builder"><b>Quantify window</b> from {plot.supplied.origin}: {q.bounds.chrom}:{q.bounds.from.toLocaleString('en-US')}–{q.bounds.to.toLocaleString('en-US')} ({q.bounds.kind}), across {q.spec.comparison}, {q.spec.value === 'enrichment' ? `enrichment (${q.spec.form}, baseline ${q.spec.baseline})` : 'raw values'}{q.spec.compare !== 'off' ? `, ${q.spec.compare} vs reference` : ''}; {q.spec.resamples.toLocaleString('en-US')} bootstrap resamples, seed {q.spec.bootSeed ?? q.spec.seed}.</p>
        <p className="text-gray-500 dark:text-gray-400">The numbers are kept as computed; re-run Quantify in its panel to recompute.</p>
      </div>
    );
  }
  if (plot.supplied) {
    const sup = plot.supplied;
    return (
      <div className="flex flex-col gap-3" data-testid="plots-builder">
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" data-testid="plots-supplied-note">
          <b>From {sup.origin}.</b> Plots draws the values that panel computed; re-run it there to recompute. Compare and smoothing work here.
        </div>
        {sup.measures && <p className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="plots-supplied-builder-measures"><b>Measures:</b> {sup.measures}</p>}
        {sup.matrix && (() => {
          const slot = sup.matrix.signed ? 'comparative' : sup.matrix.kind === 'vplot' ? 'vplot' : 'enrichment';
          return (
            <label className="flex items-center gap-1.5 text-[11px] text-gray-700 dark:text-gray-200" title="Signed values default to RdBu centred on 0, V-plots to viridis, other heatmaps to magma; pick another here.">Colormap
              <select aria-label="Colormap" data-testid="plots-supplied-colormap" value={plot.size.colormaps[slot].name} className="input-tool min-h-0 py-0.5 text-[11px]"
                onChange={e => update(p => ({ ...p, size: normalizeFootprintSizeSettings({ ...p.size, colormaps: { ...p.size.colormaps, [slot]: { ...p.size.colormaps[slot], name: e.target.value as FootprintSizeColormap } } }) }))}>
                {FOOTPRINT_SIZE_COLORMAPS.map(c => <option key={c} value={c}>{FOOTPRINT_SIZE_COLORMAP_LABELS[c] ?? c}</option>)}
              </select>
            </label>
          );
        })()}
        {!sup.matrix && <Section title="Compare" testId="plots-compare">
          {PLOT_COMPARE.filter(c => c.value === 'off' || c.value === 'diff' || c.value === 'log2ratio').map(c => {
            const blocked = c.value !== 'off' && nGroups != null && nGroups < 2;
            return (
              <Pill key={c.value} value={c.value} on={plot.compare === c.value} disabled={blocked} testId={`plots-compare-${c.value}`}
                title={blocked ? 'Compare needs two series: this card has one.' : c.help} onClick={() => update({ compare: c.value })}>{c.label}</Pill>
            );
          })}
        </Section>}
        <label className="flex items-center gap-1.5 text-[11px] text-gray-700 dark:text-gray-200" title="Gaussian smoothing along x, in x units (0 = the values as supplied)">Smoothing σ
          <CommitNumber value={plot.profile.sigmaBp} min={0} ariaLabel="Smoothing sigma" testId="plots-supplied-sigma"
            onCommit={v => update(p => ({ ...p, profile: { ...p.profile, sigmaBp: v } }))} className="input-tool w-14 min-h-0 py-0.5 text-[11px]" />
        </label>
        <button type="button" className="self-start rounded border border-gray-200 px-2 py-0.5 text-[11px] hover:bg-gray-50 dark:border-gray-700" data-testid="plots-supplied-new"
          onClick={() => update(p => ({ ...newPlot({ type: 'metaprofile' }), id: p.id }))}>Start a new plot here</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="plots-builder">
      <Section title="Type" testId="plots-type">
        {/* Differential features waits for the Feature hub: hidden with the experimental flag off (an open one stays, read-only). */}
        {PLOT_TYPES.filter(t => t.type !== 'differential' || hubAllowed || plot.type === 'differential').map(t => (
          <Pill key={t.type} value={t.type} on={plot.type === t.type} disabled={!t.available} testId={`plots-type-${t.type}`}
            title={t.available ? t.help : `${t.label}: ${soon(t.phase)}. ${t.help}`} onClick={() => update(p => withType(p, t.type))}>
            {t.label}{!t.available && <span className="text-[9px] uppercase">soon</span>}
          </Pill>
        ))}
      </Section>
      {plot.type === 'differential' ? (
        <Section title="Features" hint="per read: open, member or carrying" testId="plots-diff-features">
          {DIFF_FEATURES.filter(f => f.value !== 'hub-selection' || hubAllowed || plot.diff.features === 'hub-selection').map(f => (
            <Pill key={f.value} value={f.value} on={plot.diff.features === f.value} testId={`plots-diff-features-${f.value}`} title={f.help}
              onClick={() => update(p => ({ ...p, diff: normalizeDiffSettings({ ...p.diff, features: f.value }) }))}>{f.label}</Pill>
          ))}
        </Section>
      ) : plot.type === 'co-accessibility' ? null : (
      <SourceSection plot={plot} layerOptions={sources} />
      )}
      <Section title="Group by" testId="plots-group">
        {PLOT_GROUP_BY.map(g => {
          const noClusters = g.value === 'cluster' && !hasClusters;
          const ok = groupAvailable(g, plot.type);
          const disabled = !ok || noClusters;
          const why = !ok
            ? (g.value === 'none' ? `${g.label}: ${soon(g.phase)}. Size plots are per dataset: pooling datasets needs counts summed before normalising.` : `${g.label}: ${soon(g.phase)}. ${g.help}`)
            : noClusters ? 'Needs a clustering of these reads: Cluster reads (below) runs it.' : g.value === 'cluster'
              ? 'One plot per cluster. Pins the plot to the clustered locus: a clustering belongs to the reads there.' : g.help;
          return (
            <Pill key={g.value} value={g.value} on={plot.groupBy === g.value} disabled={disabled} testId={`plots-group-${g.value}`} title={why}
              onClick={() => update(g.value === 'cluster' && clustersLocus ? { groupBy: 'cluster', pinned: clustersLocus } : { groupBy: g.value })}>
              {g.label}{!ok && <span className="text-[9px] uppercase">soon</span>}
            </Pill>
          );
        })}
      </Section>
      {typeHasCompare(plot.type) && (
        <Section title="Compare" hint={groupBlocker ? 'needs two groups' : undefined} testId="plots-compare">
          {PLOT_COMPARE.map(c => {
            const ok = compareAvailable(c, plot.type);
            const blocked = c.value !== 'off' && !!groupBlocker;
            return (
              <Pill key={c.value} value={c.value} on={plot.compare === c.value} disabled={!ok || blocked} testId={`plots-compare-${c.value}`}
                title={!ok ? `${c.label}: not for this plot type. ${c.help}` : blocked ? groupBlocker! : c.help} onClick={() => update({ compare: c.value })}>
                {c.label}
              </Pill>
            );
          })}
        </Section>
      )}
      <Section title="Reads" hint={`seed ${plot.sampling.seed}`} testId="plots-sampling">
        {(['all', 'random'] as const).map(m => (
          <Pill key={m} value={m} on={plot.sampling.mode === m || (m === 'random' && plot.where === 'random')} disabled={plot.where === 'random' && m === 'all'} testId={`plots-sampling-${m}`}
            title={m === 'all' ? 'Every read in scope' : 'A random N reads per dataset, by a stable seeded rule (the same seed gives the same reads)'}
            onClick={() => update(p => ({ ...p, sampling: normalizeSampling({ ...p.sampling, mode: m }) }))}>{m === 'all' ? 'All reads' : 'Random N reads'}</Pill>
        ))}
        {(plot.sampling.mode === 'random' || plot.where === 'random') && (
          <label className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300" title="Random reads per dataset">N
            <CommitNumber value={plot.sampling.n} min={1} ariaLabel="Random reads per dataset" testId="plots-sampling-n" onCommit={v => update(p => ({ ...p, sampling: normalizeSampling({ ...p.sampling, n: v }) }))} className="input-tool w-20 min-h-0 py-0.5 text-[11px]" />
          </label>
        )}
        <label className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300" title="The seed of every random step of this plot (regions, reads, depth matching). Stored with the plot, its Gallery cards and sessions.">Seed
          <CommitNumber value={plot.sampling.seed} min={0} ariaLabel="Seed" testId="plots-sampling-seed" onCommit={v => update(p => ({ ...p, sampling: normalizeSampling({ ...p.sampling, seed: v }) }))} className="input-tool w-16 min-h-0 py-0.5 text-[11px]" />
        </label>
        <button type="button" className={ICON_BTN} data-testid="plots-sampling-new-seed" title="A new seed: a different random sample (the old one stays in its Gallery cards)"
          onClick={() => update(p => ({ ...p, sampling: normalizeSampling({ ...p.sampling, seed: (p.sampling.seed + 1) % 2147483647 }) }))}>New seed</button>
      </Section>
      {typeHasSummary(plot) && (
        <section className="space-y-1" data-testid="plots-summary-settings" data-blocked={sumBlocker ? 'true' : undefined}>
          <label className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${sumBlocker ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500 dark:text-gray-400'}`}
            title={sumBlocker ?? (plot.compare !== 'off'
              ? 'Each comparison reduced to one number (A − B or log2 ratio of the two sides\' summaries), with the seeded bootstrap interval'
              : 'Each group reduced to one number, as bars or a line across the groups in panel order (datasets in panel order: a time course), with 95% intervals')}>
            <input type="checkbox" checked={plot.summary.on && !sumBlocker} disabled={!!sumBlocker} data-testid="plots-summary-on" onChange={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, on: e.target.checked }) }))} />
            {plot.compare !== 'off' && !groupBlocker ? 'Summary of the comparison' : 'Summary across groups'}
          </label>
          {sumBlocker && <p className="text-[10px] leading-snug text-gray-500 dark:text-gray-400" data-testid="plots-summary-blocked">{sumBlocker}</p>}
          {plot.summary.on && !sumBlocker && (
            <div className="flex flex-col gap-1.5">
              <Field label="Chart">
                <select aria-label="Summary chart" data-testid="plots-summary-chart-kind" value={plot.summary.chart} className={FIELD_SELECT}
                  onChange={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, chart: e.target.value }) }))}>
                  <option value="bar">Bars</option><option value="line">Line</option>
                </select>
              </Field>
              {plot.type !== 'size-histogram' && (
                <Field label="Window" title={plot.where === 'view' ? 'Window in genomic coordinates (empty: the whole view)' : 'Window in bp from the anchor (empty: the whole axis)'}>
                  <input type="text" defaultValue={plot.summary.from ?? ''} aria-label="Summary window from" data-testid="plots-summary-from" placeholder="all" className="input-tool min-h-0 w-full min-w-0 py-0.5 text-[11px]"
                    onBlur={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, from: e.target.value.trim() === '' ? null : Number(e.target.value.replace(/,/g, '')) }) }))} />
                  <span>–</span>
                  <input type="text" defaultValue={plot.summary.to ?? ''} aria-label="Summary window to" data-testid="plots-summary-to" placeholder="all" className="input-tool min-h-0 w-full min-w-0 py-0.5 text-[11px]"
                    onBlur={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, to: e.target.value.trim() === '' ? null : Number(e.target.value.replace(/,/g, '')) }) }))} />
                </Field>
              )}
              {plot.type === 'metaprofile' && (
                <Field label="Value" title="Curve: the mean of the drawn curve over the window (smoothing and blank bins as drawn), so each bar equals the curve beside it. Pooled: Σ signal / Σ coverage over the window, as 3.1.0 summarised.">
                  <select aria-label="Summary value" data-testid="plots-summary-statistic" value={plot.summary.statistic} className={FIELD_SELECT}
                    onChange={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, statistic: e.target.value }) }))}>
                    <option value="curve">curve mean</option><option value="pooled">pooled (Σ signal / Σ coverage)</option>
                  </select>
                </Field>
              )}
              {plot.type !== 'metaprofile' && (<>
                <Field label="Band from" unit="bp" title="Size band (bp)">
                  <CommitNumber value={plot.summary.sizeFrom} min={0} ariaLabel="Summary sizes from" testId="plots-summary-size-from" onCommit={v => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, sizeFrom: v }) }))} className={FIELD_NUMBER} />
                </Field>
                <Field label="Band to" unit="bp" title="Size band (bp)">
                  <CommitNumber value={plot.summary.sizeTo} min={1} ariaLabel="Summary sizes to" testId="plots-summary-size-to" onCommit={v => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, sizeTo: v }) }))} className={FIELD_NUMBER} />
                </Field>
              </>)}
              <Field label="Interval" title="Auto: a seeded bootstrap for means, the exact Wilson interval for a band share of counts.">
                <select aria-label="Summary interval" data-testid="plots-summary-ci" value={plot.summary.ci} className={FIELD_SELECT}
                  onChange={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, ci: e.target.value }) }))}>
                  <option value="auto">Auto</option><option value="bootstrap">Bootstrap 95%</option><option value="wilson">Wilson 95%</option><option value="none">No interval</option>
                </select>
              </Field>
              {plot.summary.ci !== 'none' && plot.summary.ci !== 'wilson' && (
                <div className="flex flex-col gap-1.5" data-testid="plots-summary-bootstrap">
                  <Field label="Resamples" title="Poisson bootstrap resamples (50 to 10,000)">
                    <CommitNumber value={plot.summary.resamples} min={50} ariaLabel="Bootstrap resamples" testId="plots-summary-resamples" onCommit={v => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, resamples: v }) }))} className={FIELD_NUMBER} />
                  </Field>
                  <Field label="Boot seed" title="The bootstrap's seed (blank: the plot's seed)">
                    <OptionalNumber value={plot.summary.bootSeed} ariaLabel="Bootstrap seed" testId="plots-summary-boot-seed" onCommit={v => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, bootSeed: v }) }))} />
                  </Field>
                  {plot.where === 'bed' && (
                    <Field label="Resample" title="BED: regions are the independent units (default); reads within a region are not independent.">
                      <select aria-label="Bootstrap units" data-testid="plots-summary-unit" value={plot.summary.unit} className={FIELD_SELECT}
                        onChange={e => update(p => ({ ...p, summary: normalizeSummary({ ...p.summary, unit: e.target.value }) }))}>
                        <option value="regions">Regions</option><option value="reads">Reads</option>
                      </select>
                    </Field>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {plot.groupBy === 'cluster' && plot.pinned && (
        <p className="-mt-1 text-[10px] text-gray-500" data-testid="plots-cluster-pin-note">Pinned to the clustered locus {formatLocus(plot.pinned)}: clusters belong to the reads there.</p>
      )}
      {!hasClusters && plot.groupBy !== 'cluster' && (
        <div className="-mt-1 flex flex-wrap items-center gap-1 text-[10px] text-gray-500">Cluster needs a clustering of these reads. <PrereqButton kind="cluster" /></div>
      )}
      <div className="border-t border-line/70 pt-2 dark:border-white/10">
        <button type="button" aria-expanded={more} data-testid="plots-more-options" data-plot-type={plot.type} onClick={() => setMore(m => !m)}
          className="flex w-full items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100">
          <span aria-hidden="true">{more ? '▾' : '▸'}</span> More options
          {!more && <span className="ml-1 truncate font-normal normal-case tracking-normal text-gray-400">{hidden}</span>}
        </button>
      </div>
      {more && (
        <div className="flex flex-col gap-3" data-testid="plots-more">
          <Section title="Where" testId="plots-where">
            {PLOT_WHERE.map(w => {
              const ok = whereAvailable(w, plot.type);
              const why = whereBlockedReason(w, plot.type);
              return (
                <Pill key={w.value} value={w.value} on={plot.where === w.value} disabled={!ok} testId={`plots-where-${w.value}`}
                  title={ok ? w.help : why ?? `${w.label}: ${soon(w.phase)}. ${w.help}`} onClick={() => update({ where: w.value })}>
                  {w.label}{!ok && !why && <span className="text-[9px] uppercase">soon</span>}
                </Pill>
              );
            })}
          </Section>
          {plot.type === 'co-accessibility' && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Co-accessibility</h3>
              <CoaccDisplay plot={plot} onChange={patch => update(p => { const coacc = normalizeCoaccSettings({ ...p.coacc, ...patch }); syncCoaccTrack(coacc); return { ...p, coacc }; })}
                onColormap={(slot, name) => update(p => ({ ...p, size: normalizeFootprintSizeSettings({ ...p.size, colormaps: { ...p.size.colormaps, [slot]: { ...p.size.colormaps[slot], name } } }) }))} />
            </section>
          )}
          {plot.type === 'differential' && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Differential test</h3>
              <DiffDisplay settings={plot.diff} onChange={patch => update(p => ({ ...p, diff: normalizeDiffSettings({ ...p.diff, ...patch }) }))} />
            </section>
          )}
          {plot.type === 'size-histogram' && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Display</h3>
              <HistogramDisplay settings={plot.hist} readCap={plot.profile.readCap}
                onReadCap={v => update(p => ({ ...p, profile: normalizeProfileSettings({ ...p.profile, readCap: v }) }))}
                onChange={patch => update(p => ({ ...p, hist: normalizeHistogramSettings({ ...p.hist, ...patch }) }))} />
            </section>
          )}
          {plot.where === 'bed' && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">BED region sets</h3>
              <RegionSetsSection plot={plot} onChange={patch => update(p => ({ ...p, bed: normalizeBedSettings({ ...p.bed, ...patch }) }))} />
            </section>
          )}
          {(plot.type === 'metaprofile' || plot.type === 'size-histogram') && plot.where === 'features' && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Feature windows</h3>
              <HeatmapDisplay settings={plot.heatmap} features windowsOnly onChange={patch => update(p => ({ ...p, heatmap: normalizeHeatmapSettings({ ...p.heatmap, ...patch }) }))} />
            </section>
          )}
          {plot.type === 'heatmap' && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Rows</h3>
              <HeatmapDisplay settings={plot.heatmap} features={plot.where === 'features'} onChange={patch => update(p => ({ ...p, heatmap: normalizeHeatmapSettings({ ...p.heatmap, ...patch }) }))} />
            </section>
          )}
          {isProfileType(plot.type) && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Display</h3>
              <ProfileDisplay settings={plot.profile} multiSource={plotSources(plot).length > 1} onChange={patch => update(p => ({ ...p, profile: normalizeProfileSettings({ ...p.profile, ...patch }) }))} />
              {plot.type === 'metaprofile' && plot.where === 'view' && <PlotAxisControl plot={plot} onChange={axis => update(p => { const { axis: _a, ...rest } = p; return axis ? { ...rest, axis } : rest; })} />}
            </section>
          )}
          {isSizeType(plot.type) && (
            <section className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Display</h3>
              <SizeDisplay settings={plot.size} comparing={plot.compare === 'log2ratio' || plot.compare === 'diff'} onChange={patch => update(p => ({ ...p, size: normalizeFootprintSizeSettings({ ...p.size, ...patch }) }))} />
              {plot.compare === 'log2ratio' && isEnrichment(plot.size.normalization) && (
                <Field label="Ratio of" title="Size shares: each side's footprints as shares of its own total (the default). Enrichment (A vs B only): the two plots as normalised (per size row, per position or obs / expected, with Min footprints), then their ratio. Each vs rest and each vs all sum counts, so they compare size shares.">
                  <select aria-label="Ratio of" data-testid="plots-size-compare-on" className={FIELD_SELECT} value={plot.sizeCompareOn ?? 'shares'}
                    onChange={e => update(p => { const { sizeCompareOn: _drop, ...rest } = p; return e.target.value === 'enrichment' ? { ...rest, sizeCompareOn: 'enrichment' } : rest; })}>
                    <option value="shares">size shares</option><option value="enrichment">enrichment (A vs B)</option>
                  </select>
                </Field>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Plots that live in panels (a panel's run computes them): open the panel, or the newest supplied card. */
function FromPanels() {
  const [open, setOpen] = useState(false);
  useGalleryStore(g => g.entries.length);
  return (
    <section className="mt-4 flex flex-col gap-1.5 border-t border-line/70 pt-3 dark:border-white/10" data-testid="plots-from-panels">
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} data-testid="plots-from-panels-toggle"
        className="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-800 dark:text-gray-400">
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> From panels <span className="font-normal normal-case text-gray-400">({PANEL_PLOTS.length})</span>
      </button>
      {open && <p className="text-[10px] text-gray-400">Plots a panel's run computes; they stay in their panels. Open the panel, or the newest card it sent to Plots.</p>}
      {open && PANEL_PLOTS.map(p => {
        const card = latestSuppliedCard(p);
        return (
          <div key={p.id} className="rounded border border-line/70 p-1.5 text-[11px] dark:border-white/10" data-testid="plots-from-panel" data-plot={p.id}>
            <div className="font-medium text-gray-800 dark:text-gray-100">{p.label}</div>
            <div className="text-[10px] text-gray-500">{p.panelLabel} · {p.description}</div>
            <div className="mt-1 flex gap-1">
              <button type="button" className={ICON_BTN} data-testid="plots-from-panel-open" onClick={() => openPanelPlot(p)} title={`Open the ${p.panelLabel} panel`}>Open in panel</button>
              {p.origin && (
                <button type="button" className={ICON_BTN} data-testid="plots-from-panel-card" disabled={!card} onClick={() => openPanelPlotCard(p)}
                  title={card ? 'Open the newest card this panel sent to Plots' : 'No card yet: open the panel and use its Open in Plots'}>Open as supplied card</button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Beside the plot: the open plot's working card ("Current"), then the newest kept cards (the full grid is the Gallery tab). */
function RecentPlots({ onShowAll }: { onShowAll: () => void }) {
  const working = useGalleryStore(useShallow(g => workingEntries(g)));
  const kept = useGalleryStore(useShallow(g => keptEntries(g)));
  const recent = kept.slice(-6).reverse();
  return (
    <div className="flex flex-col gap-2" data-testid="plots-recent">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Current</h3>
      <div className="flex flex-col gap-2" data-testid="plots-current">
        {working.length === 0 && <p className="text-[11px] text-gray-500" data-testid="plots-current-empty">The plot appears here when drawn.</p>}
        {working.map(e => <GalleryCard key={e.id} e={e} compact />)}
      </div>
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Gallery</h3>
        <button type="button" className="ml-auto text-[11px] text-amber-800 underline dark:text-amber-300" data-testid="plots-show-gallery" onClick={onShowAll}>
          All {kept.length}
        </button>
      </div>
      <p className="text-[10px] text-gray-400">The plot updates its Current card as you change it or pan; Keep saves it to the Gallery. Open goes back to where a card was made.</p>
      {recent.length === 0 && <p className="text-[11px] text-gray-500" data-testid="plots-recent-empty">Plots you keep appear here.</p>}
      {recent.map(e => <GalleryCard key={e.id} e={e} compact />)}
    </div>
  );
}

export function PlotsWorkspace() {
  const plot = useBrowserStore(s => s.plotsWorkspace.current);
  const openedFrom = useBrowserStore(s => s.plotsWorkspace.openedFrom);
  const delayMs = useBrowserStore(s => s.plotsWorkspace.followDelayMs);
  const setWs = useBrowserStore(s => s.setPlotsWorkspace);
  const update = useBrowserStore(s => s.updateCurrentPlot);
  const sampleSeed = useBrowserStore(s => s.analysisSampleSeed);
  const datasets = useBrowserStore(s => s.datasets);
  const settingsKey = useAnalysisSettingsKey();
  const targets = usePlotTargets(plot.panel ?? null);
  const seed = useGallerySeed(s => s.seed);
  const tab = useWorkspaceStore(st => st.plotsTab);
  const setTab = setPlotsTab;
  const [toast, setToastState] = useState<{ text: string; undo?: () => void } | null>(null);
  const setToast = useCallback((text: string | null, undo?: () => void) => setToastState(text ? { text, ...(undo ? { undo } : {}) } : null), []);
  // The plot's working card (updated in place by every result; in the Gallery only when kept).
  const latestEntry = useGalleryStore(g => workingFor(g, plot.id));
  const galleryCount = useGalleryStore(g => keptEntries(g).length);
  const seedFor = useGallerySeed(s => s.seedFor);
  // Stored results draw the plot they were opened for until something changes.
  const seeded = !!openedFrom || seedFor === plot.id;
  const clusteredEntry = useGalleryStore(g => [...g.entries].reverse().find(e => e.plot.groupBy === 'cluster') ?? null);
  const byCluster = plot.groupBy === 'cluster';
  const live = byCluster && targets.clusters ? targets.clusters : targets.allReads;
  const pinnedTarget = useMemo(() => (plot.pinned ? atLocus(live, plot.pinned) : null), [live, plot.pinned]);
  const { target, pending } = useFollowedTarget(live, pinnedTarget, targetKey, delayMs);
  const [width, ref] = useContainerWidth(700);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const name = plot.name;
  const following = followsView(plot);
  const clustersLocus = targets.clusters ? locusOf(targets.clusters) : null;
  // Group by read groups / selected classes: the groups (null otherwise).
  const groupsState = useReadGroups(plot.groupBy);
  const readGroups = isReadGroupBy(plot.groupBy) ? groupsState.groups : null;
  const groupProps = { readGroups, groupsSig: groupsState.signature, groupsBlocker: groupsState.blocker };

  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToastState(null), toast.undo ? 8000 : 3500); return () => window.clearTimeout(t); }, [toast]);
  // An edit after an Open recomputes: the stored result no longer applies.
  useEffect(() => {
    if (seed && !seeded) useGallerySeed.getState().set(null);
  }, [seed, seeded]);
  // A plot replaced in the builder (Open, Re-run, a new plot) is closed: its working card goes, with an undo.
  const prevPlotId = useRef(plot.id);
  useEffect(() => {
    const prev = prevPlotId.current;
    prevPlotId.current = plot.id;
    if (prev === plot.id) return;
    const closed = closePlotCard(prev);
    if (closed && !workingIsKept(closed)) setToast(`Closed ${closed.name || plotDisplayName(closed.plot)} (not kept)`, () => { undoClosePlot(); setToastState(null); });
  }, [plot.id, setToast]);

  const moveTo = useCallback((pos: number) => {
    const s = useBrowserStore.getState();
    if (s.navigationMode === 'perPanel') return;
    const w = Math.max(3, s.end - s.start);
    const start = Math.max(0, Math.round(pos - w / 2));
    s.setViewport(target.chrom, start, start + w);
  }, [target.chrom]);

  const onResult = useCallback((r: SizePlotResult) => {
    const ds = [...new Set((byCluster && targets.clusters ? targets.clusters : targets.allReads).panels.map(p => p.datasetLabel ?? p.label))];
    recordResult({
      plot: r.plot, computedFor: r.entry.locus, requestKey: r.entry.key, byPanel: r.entry.byPanel, items: r.items, thumb: r.thumb,
      datasets: ds.length ? ds : datasets.map(d => d.label ?? d.id), parentId: useBrowserStore.getState().plotsWorkspace.openedFrom, name: r.plot.name,
    }, { following: followsView(r.plot) });
  }, [byCluster, targets, datasets]);

  const profileSeed = useGallerySeed(s => s.profileSeed);
  const onProfileResult = useCallback((r: MetaprofileResult) => {
    const ds = [...new Set((byCluster && targets.clusters ? targets.clusters : targets.allReads).panels.map(p => p.datasetLabel ?? p.label))];
    recordResult({
      plot: r.plot, computedFor: r.entry.locus, requestKey: r.entry.key, byPanel: {}, items: r.entry.groups.map(g => ({ id: g.id, title: g.title, color: g.color })),
      thumb: r.thumb, datasets: ds, parentId: useBrowserStore.getState().plotsWorkspace.openedFrom, name: r.plot.name,
      profile: packProfile(r.entry.binBp, r.entry.groups),
    }, { following: followsView(r.plot) });
  }, [byCluster, targets]);

  const heatmapSeed = useGallerySeed(s => s.heatmapSeed);
  const onHeatmapResult = useCallback((r: HeatmapResult) => {
    const ds = [...new Set((byCluster && targets.clusters ? targets.clusters : targets.allReads).panels.map(p => p.datasetLabel ?? p.label))];
    recordResult({
      plot: r.plot, computedFor: r.entry.locus, requestKey: r.entry.key, byPanel: {}, items: r.entry.groups,
      thumb: r.thumb, datasets: ds, parentId: useBrowserStore.getState().plotsWorkspace.openedFrom, name: r.plot.name, heatmap: r.packed,
    }, { following: followsView(r.plot) });
  }, [byCluster, targets]);

  const regionSets = useBrowserStore(s => s.plotsWorkspace.regionSets);
  const bedSeed = useGallerySeed(s => s.bedSeed);
  const onBedResult = useCallback((r: BedResult) => {
    const sets = regionSets.filter(x => r.plot.bed.setIds.includes(x.id)).map(x => x.name);
    recordResult({
      plot: r.plot, computedFor: r.entry.profile.locus, requestKey: r.entry.stableKey, byPanel: {}, items: r.entry.profile.groups.map(g => ({ id: g.id, title: g.title, color: g.color })),
      thumb: r.thumb, datasets: sets, parentId: useBrowserStore.getState().plotsWorkspace.openedFrom, name: r.plot.name, profile: r.profile, heatmap: r.heatmap,
      note: r.entry.countsText,
    }, { following: false });
  }, [regionSets]);

  const coaccSeed = useGallerySeed(s => s.coaccSeed);
  const onCoaccResult = useCallback((r: CoaccResult) => {
    recordResult({
      plot: r.plot, computedFor: r.entry.locus, requestKey: r.entry.key, byPanel: {}, items: r.entry.blocks.map(b => ({ id: b.id, title: b.title, color: b.color })),
      thumb: '', datasets: r.entry.blocks.map(b => b.title), parentId: useBrowserStore.getState().plotsWorkspace.openedFrom, name: r.plot.name,
      ...(r.supplied ? { supplied: r.supplied } : {}), note: r.supplied ? undefined : 'Too large to keep its cells: Open recomputes it.',
    }, { following: followsView(r.plot) });
  }, []);
  const diffSeed = useGallerySeed(s => s.diffSeed);
  const suppliedSeed = useGallerySeed(s => s.suppliedSeed);
  const onDiffResult = useCallback((r: DifferentialResult) => {
    const ds = [...new Set([...r.entry.groups.A.datasets, ...r.entry.groups.B.datasets])];
    recordResult({
      plot: r.plot, computedFor: r.entry.locus, requestKey: r.entry.key, byPanel: {}, items: [{ id: 'A', title: r.entry.groups.A.label }, { id: 'B', title: r.entry.groups.B.label }],
      thumb: r.thumb, datasets: ds.map(id => datasets.find(d => d.id === id)?.label ?? id), parentId: useBrowserStore.getState().plotsWorkspace.openedFrom, name: r.plot.name,
      diff: { rows: r.entry.rows.slice(0, MAX_STORED_DIFF_ROWS), groups: r.entry.groups, test: r.entry.test, density: r.entry.density },
      note: `${r.entry.rows.filter(x => x.testable).length} of ${r.entry.rows.length} features tested · A = ${r.entry.groups.A.label} · B = ${r.entry.groups.B.label}`,
    }, { following: followsView(r.plot) });
  }, [datasets]);
  // Going to a feature: a following plot pins where it is first (it would recompute for the new view otherwise).
  const goToFeature = useCallback((chrom: string, start: number, end: number) => {
    const st = useBrowserStore.getState();
    if (st.navigationMode === 'perPanel') return;
    if (followsView(plot)) update({ pinned: locusOf(live) });
    const w = Math.max(st.end - st.start, Math.ceil((end - start) * 3), 1_000);
    const s0 = Math.max(0, Math.round((start + end) / 2 - w / 2));
    st.setViewport(chrom, s0, s0 + w);
  }, [plot, update, live]);

  const isKept = workingIsKept(latestEntry);
  const parentKept = useGalleryStore(g => (openedFrom ? g.entries.some(e => e.id === openedFrom && e.status === 'kept') : false));
  const keep = () => {
    if (!latestEntry || isKept) return;
    const kept = keepPlotEntry(latestEntry.id, name.trim() || undefined);
    if (kept) setToast(kept.parentId ? `Kept in the Gallery as a new version: ${kept.name || plotDisplayName(kept.plot)}` : `Kept in the Gallery: ${kept.name || plotDisplayName(kept.plot)}`);
  };
  const replaceOriginal = () => {
    if (!latestEntry || !openedFrom) return;
    useGalleryStore.setState(g => replaceEntry(g, openedFrom, latestEntry.id), true);
    setToast('Replaced the original plot in the Gallery with this version.');
  };
  const isVersion = !!(openedFrom && parentKept && latestEntry && latestEntry.parentId === openedFrom && !isKept);

  return (
    <div className="absolute inset-0 z-[40] flex flex-col bg-surface-sunken text-gray-800 dark:bg-dark-bg dark:text-gray-100"
      data-testid="plots-workspace" aria-label="Plots workspace">
      <WorkspaceBand tone="plots" title="Plots" prefix="plots"
        right={(
          <label className="inline-flex items-center gap-1 text-[10px] text-gray-500" title="Follow plots recompute this long after the view stops moving.">
            Follow delay
            <CommitNumber value={delayMs} min={0} ariaLabel="Follow delay, ms" testId="plots-follow-delay"
              onCommit={v => setWs(ws => ({ ...ws, followDelayMs: normalizeFollowDelay(Math.min(MAX_FOLLOW_DELAY_MS, v)) }))} className="input-tool w-16 min-h-0 py-0.5 text-[11px]" />
            ms
          </label>
        )}
        row={(
          <div className="inline-flex rounded-md bg-white/70 p-0.5 ring-1 ring-inset ring-amber-200/80 dark:bg-white/10 dark:ring-white/10" role="tablist" aria-label="Plots view">
            <button type="button" role="tab" aria-selected={tab === 'plot'} data-testid="plots-tab-plot" onClick={() => setTab('plot')}
              className={`rounded px-2.5 py-0.5 text-[12px] ${tab === 'plot' ? 'bg-white font-semibold shadow-sm dark:bg-gray-800' : 'text-gray-600 dark:text-gray-300'}`}>Plot</button>
            <button type="button" role="tab" aria-selected={tab === 'gallery'} data-testid="plots-tab-gallery" onClick={() => setTab('gallery')}
              className={`rounded px-2.5 py-0.5 text-[12px] ${tab === 'gallery' ? 'bg-white font-semibold shadow-sm dark:bg-gray-800' : 'text-gray-600 dark:text-gray-300'}`}>Gallery ({galleryCount})</button>
          </div>
        )} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,260px)_minmax(0,1fr)_minmax(200px,240px)] gap-0">
        <aside data-testid="plots-builder-pane" className="min-h-0 overflow-y-auto border-r border-line/70 p-3 dark:border-white/10">
          <Builder plot={plot} clustersLocus={clustersLocus} />
        </aside>
        <main className="min-h-0 overflow-y-auto p-3">
          <div ref={ref}>
          {tab === 'gallery' ? <GalleryView width={Math.max(400, width)} /> : (
          <div className="rounded-xl bg-white p-3 shadow-[0_0_0_1px_#dfe3eb] dark:bg-white/5 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)]" data-testid="plots-card"
            data-plot-id={plot.id} data-follow={following ? 'follow' : 'pin'}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {/* The plot's name: click to rename (auto-named until changed); it names its Gallery card and its exports. */}
              {nameDraft != null ? (
                <input type="text" autoFocus value={nameDraft} placeholder={describePlot(plot)} aria-label="Plot name" data-testid="plots-name"
                  onChange={e => setNameDraft(e.target.value)}
                  onBlur={() => {
                    const next = nameDraft.trim();
                    update({ name: next });
                    if (latestEntry) useGalleryStore.setState(g => updateEntry(g, latestEntry.id, { name: next }), true);
                    setNameDraft(null);
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.stopPropagation(); setNameDraft(null); } }}
                  className="input-tool w-96 min-h-0 py-0.5 text-[13px] font-semibold" />
              ) : (
                <button type="button" data-testid="plots-title" onClick={() => setNameDraft(plot.name || plotDisplayName(plot))}
                  title={plot.name ? 'Click to rename' : 'Auto-named from the settings: click to rename'}
                  className="group inline-flex max-w-[36rem] items-center gap-1 truncate rounded px-1 text-left text-[13px] font-semibold text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-white/10">
                  <span className="truncate" data-testid="plots-title-text">{plotDisplayName(plot)}</span>
                  <span className="text-[10px] font-normal text-gray-400 group-hover:text-gray-600" aria-hidden="true">✎</span>
                </button>
              )}
              <button type="button" data-testid="plots-keep" disabled={!latestEntry} onClick={keep} aria-pressed={isKept}
                title={isKept ? 'Kept: this plot as it is now is in the Gallery (change it and Keep again for another card)' : 'Save this plot to the Gallery'}
                className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold ring-1 ring-inset disabled:opacity-40 ${isKept
                  ? 'bg-amber-100 text-amber-900 ring-amber-600 dark:bg-amber-900/40 dark:text-amber-100' : 'bg-amber-600 text-white ring-amber-700 hover:bg-amber-700'}`}>
                {isKept ? '★ Kept' : '☆ Keep'}
              </button>
              {isVersion && (
                <button type="button" className={ICON_BTN} data-testid="plots-replace" onClick={replaceOriginal}
                  title="This plot is a new version of the one you opened (both are in the Gallery). Replace the original with it.">Replace original</button>
              )}
              <span className="text-[10px] text-gray-400" data-testid="plots-kept-note">
                {!latestEntry ? 'Not drawn yet' : isKept ? 'Kept in the Gallery' : 'Not in the Gallery until you Keep it'}
              </span>
              <div className="ml-auto inline-flex rounded-md bg-gray-100 p-0.5 dark:bg-white/10" role="group" aria-label="Follow or pin" data-testid="plots-follow-pin">
                <button type="button" aria-pressed={following} data-testid="plots-follow" disabled={plot.where !== 'view'}
                  title={byCluster ? 'Follow: recompute for the browser\'s view (a clustering is cleared when you move away).' : 'Follow: recompute for the browser\'s view after it stops moving.'}
                  onClick={() => { update({ pinned: null }); if (latestEntry) useGalleryStore.setState(g => updateEntry(g, latestEntry.id, { plot: { ...latestEntry.plot, pinned: null } }), true); }}
                  className={`rounded px-2 py-0.5 text-[11px] ${following ? 'bg-white font-semibold shadow-sm dark:bg-gray-800' : 'text-gray-600 dark:text-gray-300'}`}>Follow</button>
                <button type="button" aria-pressed={!following} data-testid="plots-pin"
                  title="Pin: keep this locus while the browser moves on."
                  onClick={() => {
                    const pin = locusOf(live);
                    update({ pinned: pin });
                    // The plot on screen is its working card: it is now pinned there (no new card).
                    if (latestEntry && !pending) useGalleryStore.setState(g => updateEntry(g, latestEntry.id, { plot: { ...latestEntry.plot, pinned: pin } }), true);
                  }}
                  className={`rounded px-2 py-0.5 text-[11px] ${!following ? 'bg-white font-semibold shadow-sm dark:bg-gray-800' : 'text-gray-600 dark:text-gray-300'}`}>Pin</button>
              </div>
            </div>
            {plot.name && <div className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="plots-description">{describePlot(plot)}</div>}
            <div className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
              {plotTypeInfo(plot.type).help} {following ? 'Follows the browser: recomputes ' + delayMs + ' ms after you stop moving.' : plot.where === 'features' ? 'Pinned to the selected features (moving the view leaves it).' : plot.where === 'bed' ? 'Pinned to its BED region sets (moving the view leaves it).' : `Pinned to ${formatLocus(plot.pinned)}.`}
            </div>
            {!plot.supplied && (targets.liftedLeftOut?.length ?? 0) > 0 && (
              <div className="mb-2 text-[11px] text-amber-700 dark:text-amber-300" role="status" data-testid="plots-lifted-left-out">
                {liftedLeftOutNotice(targets.liftedLeftOut)}
              </div>
            )}
            {plot.where === 'random' && plot.type === 'size-histogram' && !plot.supplied ? (
              <RandomReadsPlot plot={plot} target={target} width={Math.max(320, width - 24)} settingsKey={settingsKey} seed={seeded ? profileSeed : null} onResult={onProfileResult} />
            ) : plot.supplied?.quant ? (
              <QuantPlot plot={plot} data={seeded ? suppliedSeed : null} width={Math.max(320, width - 24)} />
            ) : plot.supplied ? (
              <SuppliedPlot plot={plot} data={seeded ? suppliedSeed : null} width={Math.max(320, width - 24)} onCompare={patch => update(patch)} />
            ) : plot.where === 'bed' && isSizeType(plot.type) ? (
              <BedSizePlot plot={plot} sets={regionSets} target={target} width={Math.max(360, width - 24)} sampleSeed={sampleSeed ?? 'fiberbrowser-analysis'}
                settingsKey={settingsKey} seed={seeded ? seed : null} onResult={onResult} onCompare={patch => update(patch)} />
            ) : plot.where === 'bed' && (plot.type === 'metaprofile' || plot.type === 'heatmap' || plot.type === 'size-histogram') ? (
              <BedPlot plot={plot} sets={regionSets} target={target} width={Math.max(360, width - 24)} sampleSeed={sampleSeed ?? 'fiberbrowser-analysis'}
                settingsKey={settingsKey} onResult={onBedResult} onCompare={patch => update(patch)} seed={seeded ? bedSeed : null} />
            ) : plot.type === 'co-accessibility' ? (
              <CoaccPlot plot={plot} target={target} pending={pending} width={Math.max(360, width - 24)} sampleSeed={sampleSeed} settingsKey={settingsKey}
                seed={seeded ? coaccSeed : null} onResult={onCoaccResult} onCompare={patch => update(patch)} wanted={pinnedTarget ?? live} />
            ) : plot.type === 'differential' ? (
              <DifferentialPlot plot={plot} target={target} clusters={byCluster && targets.clusters ? target as typeof targets.clusters : null} pending={pending}
                width={Math.max(500, width - 24)} settingsKey={settingsKey} wanted={pinnedTarget ?? live} seed={seeded ? diffSeed : null} onResult={onDiffResult}
                onChange={patch => update(p => ({ ...p, ...(patch.compareAB !== undefined ? { compareAB: patch.compareAB } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
                  ...(patch.diff ? { diff: normalizeDiffSettings({ ...p.diff, ...patch.diff }) } : {}) }))}
                onLocus={goToFeature} readGroups={readGroups} groupsSig={groupProps.groupsSig} groupsBlocker={groupProps.groupsBlocker} />
            ) : isSizeType(plot.type) ? (
              <SizePlot plot={plot} target={target} clusters={byCluster && targets.clusters ? target as typeof targets.clusters : null} pending={pending}
                width={Math.max(260, width - 24)} sampleSeed={sampleSeed} settingsKey={settingsKey} onPosition={moveTo}
                onCompare={patch => update(patch)} wanted={pinnedTarget ?? live} seed={seeded ? seed : null} onResult={onResult}
                onOpenClustered={clusteredEntry ? () => openEntry(clusteredEntry.id) : null} {...groupProps} />
            ) : plot.type === 'heatmap' ? (
              <HeatmapPlot plot={plot} target={target} clusters={byCluster && targets.clusters ? target as typeof targets.clusters : null} pending={pending}
                width={Math.max(360, width - 24)} sampleSeed={sampleSeed ?? 'fiberbrowser-analysis'} settingsKey={settingsKey}
                onPosition={(chrom, pos) => { const st = useBrowserStore.getState(); if (st.navigationMode === 'perPanel') return; const w = Math.max(3, st.end - st.start); const s0 = Math.max(0, Math.round(pos - w / 2)); st.setViewport(chrom, s0, s0 + w); }}
                onCompare={patch => update(patch)} onWhere={w => update({ where: w })} wanted={pinnedTarget ?? live} seed={seeded ? heatmapSeed : null} onResult={onHeatmapResult} {...groupProps} />
            ) : isLineType(plot.type) ? (
              <MetaprofilePlot plot={plot} target={target} clusters={byCluster && targets.clusters ? target as typeof targets.clusters : null} pending={pending}
                width={Math.max(320, width - 24)} sampleSeed={sampleSeed ?? 'fiberbrowser-analysis'} settingsKey={settingsKey} onPosition={moveTo}
                onCompare={patch => update(patch)} wanted={pinnedTarget ?? live} seed={seeded ? profileSeed : null} onResult={onProfileResult}
                onOpenClustered={clusteredEntry ? () => openEntry(clusteredEntry.id) : null} {...groupProps} />
            ) : (
              <p className="text-[12px] text-gray-500">This type is coming soon.</p>
            )}
          </div>
          )}
          </div>
        </main>
        <aside data-testid="plots-side-pane" className="min-h-0 overflow-y-auto border-l border-line/70 p-3 dark:border-white/10">
          <RecentPlots onShowAll={() => setTab('gallery')} />
          <FromPanels />
        </aside>
      </div>
      {toast && (
        <div role="status" data-testid="plots-toast"
          className={`${toast.undo ? '' : 'pointer-events-none '}absolute bottom-4 left-1/2 z-[60] inline-flex -translate-x-1/2 items-center gap-2 rounded-md bg-gray-900/90 px-3 py-1.5 text-[12px] text-white shadow-lg`}>
          <span>{toast.text}</span>
          {toast.undo && <button type="button" data-testid="plots-toast-undo" onClick={toast.undo} className="rounded px-1.5 py-0.5 font-semibold text-amber-300 hover:bg-white/10">Undo</button>}
        </div>
      )}
    </div>
  );
}
